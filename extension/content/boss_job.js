/**
 * content/boss_job.js — BOSS 直聘页面 content script
 *
 * 步骤 1：页面类型识别 + PING 响应
 * 步骤 2：岗位卡片提取（CAPTURE_JOBS）
 *   - 从列表页（搜索/推荐）解析岗位卡片
 *   - 解码 BOSS 薪资字体混淆（PUA 码位 → 数字）
 *   - 可选「深抓 JD」：同源 fetch 详情页补齐 JD / 城市 / 薪资 / 经验学历
 *
 * 说明：content script 只负责 DOM 提取，不直接调用后端；
 * 提取结果返回给侧边栏，由侧边栏统一 POST /api/jobs/ingest。
 */
(() => {
  'use strict';

  // ---------------- 页面类型 ----------------
  function detectPageKind() {
    const p = location.pathname || '';
    if (p.startsWith('/job_detail/')) return '岗位详情';
    if (p.startsWith('/web/geek/chat') || p.includes('/chat')) return '聊天页';
    if (p.startsWith('/web/geek/job') || p.startsWith('/jobs')) {
      return location.search.includes('query=') ? '搜索列表' : '推荐列表';
    }
    if (p.startsWith('/web/geek/recommend')) return '推荐列表';
    return '其他';
  }

  const pageKind = detectPageKind();

  // ---------------- 工具 ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 按候选选择器取第一个非空文本。 */
  function pickText(root, selectors) {
    for (const sel of selectors) {
      let el = null;
      try {
        el = root.querySelector(sel);
      } catch {
        continue; // 非法选择器忽略
      }
      if (el) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t) return t.replace(/\s+/g, ' ');
      }
    }
    return '';
  }

  /**
   * 解码 BOSS 薪资字体混淆。
   * BOSS 用自定义字体把数字渲染为 Unicode 私有区码位 U+E031..U+E03A，
   * 对应 '0'..'9'（码位 - 0xE031 = 数字）。
   */
  function decodeDigits(text) {
    if (!text) return text;
    let out = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp >= 0xe031 && cp <= 0xe03a) {
        out += String.fromCharCode(0x30 + (cp - 0xe031));
      } else {
        out += ch;
      }
    }
    return out;
  }

  const EDU_WORDS = ['本科', '大专', '硕士', '博士', '中专', '高中', '学历不限', '初中'];

  /** 从一组标签中拆分出 经验 / 学历。 */
  function splitTags(tags) {
    let experience = '';
    let education = '';
    for (const raw of tags) {
      const t = (raw || '').trim();
      if (!t) continue;
      if (EDU_WORDS.some((w) => t.includes(w))) {
        if (!education) education = t;
      } else if (/经验|应届|实习|年|周/.test(t)) {
        if (!experience) experience = t;
      } else if (!experience) {
        experience = t; // 兜底：第一个非学历标签视为经验
      }
    }
    return { experience, education };
  }

  // 常见城市（用于兜底识别；是否最终通过由后端硬过滤决定）
  const CITY_LIST = [
    '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州',
    '郑州', '长沙', '重庆', '天津', '合肥', '济南', '青岛', '厦门', '福州', '宁波',
    '无锡', '佛山', '东莞', '珠海', '中山', '大连', '沈阳', '哈尔滨', '昆明', '南昌',
    '贵阳', '南宁', '石家庄', '太原', '兰州', '乌鲁木齐', '海口', '三亚', '常州', '温州',
  ];

  /** 从一段文本中识别城市名。 */
  function cityFromText(text) {
    if (!text) return '';
    for (const c of CITY_LIST) {
      if (text.includes(c)) return c;
    }
    return '';
  }

  /** 从锚点向上寻找最近的岗位卡片容器。 */
  function findCard(anchor) {
    const pref = anchor.closest(
      '.job-card-wrapper, .job-card-box, .job-card-body, .job-card, li.job-card-wrapper'
    );
    if (pref) return pref;
    let node = anchor;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      if (node.querySelector('.company-name, a[href*="/gongsi/"], .salary')) return node;
    }
    return anchor.parentElement || anchor;
  }

  function jobIdFromUrl(url) {
    const m = url.match(/job_detail\/([^./?]+)\.html/);
    return m ? m[1] : '';
  }

  const AREA_SELECTORS = [
    '.job-area',
    '.job-area-wrapper',
    '.area',
    '.job-city',
    '.job-location',
    '[class*="job-area"]',
    '[class*="area"]',
  ];

  // ---------------- 列表页卡片提取 ----------------
  function extractCards() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/job_detail/"]'));
    const seen = new Set();
    const jobs = [];
    // 兜底：若用户按城市筛选，页面标题通常含城市名
    const pageCity = cityFromText(document.title || '');

    for (const a of anchors) {
      const url = a.href || '';
      const id = jobIdFromUrl(url);
      const key = id || url;
      if (!key || seen.has(key)) continue;

      const card = findCard(a);
      const title =
        pickText(card, ['.job-name', '.job-title', '.name']) ||
        (a.innerText || '').trim();
      if (!title) continue;

      const company = pickText(card, [
        '.company-name',
        'a[href*="/gongsi/"]',
        '.company-info .name',
        '.company-text .name',
      ]);
      if (!company) continue; // 无公司名，跳过脏卡片

      seen.add(key);

      const salary = decodeDigits(
        pickText(card, ['.salary', '.job-salary', '.job-limit .salary', '[class*="salary"]'])
      );

      // 城市：优先区域元素，其次标题括号，最后标题文本
      let areaFull = pickText(card, AREA_SELECTORS);
      let city = areaFull ? areaFull.split(/[·\s]/)[0] : '';
      if (!city) {
        const paren = (title.match(/[（(]([^（）()]{2,10})[）)]/g) || []).join(' ');
        city = cityFromText(paren) || cityFromText(title) || pageCity;
        if (city) areaFull = areaFull || city;
      }

      const tagEls = card.querySelectorAll(
        '.tag-list li, .job-card-footer .tag-list li, ul.tag-list > li'
      );
      const tags = Array.from(tagEls).map((li) => (li.innerText || '').trim());
      const { experience, education } = splitTags(tags);

      // 列表页通常不含完整 JD，仅尽力取描述片段
      const jdLite = pickText(card, [
        '.job-card-footer .info-desc',
        '.job-desc',
        '.info-desc',
        '.job-card-body .desc',
      ]);

      jobs.push({
        id,
        title,
        company,
        salary,
        city,
        area: areaFull,
        experience,
        education,
        jd: jdLite,
        url,
        auto_score: true,
      });
    }
    return jobs;
  }

  // ---------------- 深度补充（同源 fetch 详情页） ----------------
  /** 解析详情页 HTML，抽取 JD / 城市 / 薪资 / 经验学历。 */
  function parseDetail(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const jd = pickText(doc, [
      '.job-detail-section .job-sec-text',
      '.job-sec .text',
      '.job-sec-text',
      '.detail-content .job-sec-text',
      '.job-detail-section .text',
    ]);
    const location = pickText(doc, [
      '.text-city',
      '.job-location',
      '[class*="job-location"]',
      '[class*="location"]',
      '[class*="city"]',
    ]);
    const salary = decodeDigits(
      pickText(doc, ['.salary', '.job-salary', '[class*="salary"]'])
    );
    const limitEl = doc.querySelector('.job-detail-section .job-limit, .job-limit');
    const limitText = limitEl ? (limitEl.innerText || '').trim() : '';
    return { jd, location, salary, limitText };
  }

  /** 并发度受限地为每条岗位补抓详情页信息。 */
  async function enrichJd(jobs, concurrency = 3) {
    let cursor = 0;
    async function worker() {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        if (!job.url) continue;
        try {
          const resp = await fetch(job.url, { credentials: 'include' });
          if (!resp.ok) continue;
          const html = await resp.text();
          const { jd, location, salary, limitText } = parseDetail(html);

          if (jd && jd.length > (job.jd || '').length) job.jd = jd;
          if (salary && (!job.salary || job.salary.length < salary.length)) job.salary = salary;

          // 城市：详情页位置元素 → JD 文本中的城市
          if (!job.city) {
            const c =
              cityFromText(location) ||
              (location ? location.split(/[·\s-]/)[0] : '') ||
              cityFromText(jd);
            if (c) {
              job.city = c;
              if (!job.area) job.area = location || c;
            }
          }

          // 经验 / 学历
          if ((!job.experience || !job.education) && limitText) {
            const tags = limitText.split(/\s+|\n/).filter(Boolean);
            const { experience, education } = splitTags(tags);
            if (!job.experience && experience) job.experience = experience;
            if (!job.education && education) job.education = education;
          }
        } catch (err) {
          console.debug('[BOSS Agent] 深抓详情页失败：', job.url, err);
        }
        await sleep(250); // 轻微限速，避免触发风控
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  }

  // ---------------- 消息入口 ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;

    if (msg.type === 'PING') {
      sendResponse({ ok: true, pageKind, url: location.href, ts: Date.now() });
      return false;
    }

    if (msg.type === 'CAPTURE_JOBS') {
      (async () => {
        try {
          const jobs = extractCards();
          if (msg.deep && jobs.length) {
            await enrichJd(jobs);
          }
          sendResponse({ ok: true, pageKind, count: jobs.length, jobs });
        } catch (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
      })();
      return true; // 异步响应
    }

    // 诊断用：返回页面首个岗位卡片的原始 HTML，便于校准选择器
    if (msg.type === 'DUMP_FIRST_CARD') {
      try {
        const a = document.querySelector('a[href*="/job_detail/"]');
        const card = a ? findCard(a) : null;
        sendResponse({
          ok: !!card,
          html: card ? card.outerHTML.slice(0, 20000) : '',
          url: a ? a.href : '',
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return false;
    }

    return false;
  });

  console.debug('[BOSS Agent] content script 已注入，页面类型：', pageKind, location.href);
})();