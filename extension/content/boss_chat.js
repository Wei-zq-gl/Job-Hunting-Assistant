/**
 * content/boss_chat.js — BOSS 直聘「沟通/发送」能力
 *
 * 步骤 3：受控自动发送
 *   - START_CHAT        ：在岗位详情页点击「立即沟通」（若已在会话中则直接返回）
 *   - SEND_TEXT         ：在聊天输入框写入内容并发送，发送后校验，识别验证码/登录/次数上限
 *   - SEND_REPLY        ：在消息页按公司名定位会话后发送（回复场景）
 *   - PROBE_CHAT        ：上报当前页是否具备发送条件
 *
 * 步骤 4：聊天回复监听
 *   - 在消息页监听 HR 新消息，上报给 background（INBOUND_DETECTED）
 *   - SEND_RESUME       ：自动点击「发送简历」
 *   - DUMP_CHAT_HTML    ：导出会话 DOM，用于校准选择器
 *
 * 只负责页面操作，不直接调用后端；结果由 background 统一回传 ACK。
 */
(() => {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function q(sel, root = document) {
    try { return root.querySelector(sel); } catch { return null; }
  }
  function qa(sel, root = document) {
    try { return Array.from(root.querySelectorAll(sel)); } catch { return []; }
  }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function textOf(el) {
    return ((el && (el.innerText || el.textContent)) || '').trim().replace(/\s+/g, ' ');
  }
  function firstVisible(sels) {
    for (const s of sels) {
      const el = q(s);
      if (visible(el)) return el;
    }
    return null;
  }

  // ---------------- 异常识别 ----------------
  function detectBlock() {
    const href = location.href || '';
    // 真·跳转到登录页
    if (/login\.zhipin\.com|\/web\/user\/|\/login[/?]|\/login$/.test(href)) {
      return '登录失效，需要重新登录（跳转到登录页 ' + href.slice(0, 80) + '）';
    }
    // 登录框必须「可见」才算，避免隐藏弹窗误判
    if (firstVisible(['.sign-wrap', '.login-register', '[class*="login-dialog"]', '.login-box'])) {
      return '登录失效，需要重新登录（页面弹出登录框 ' + href.slice(0, 80) + '）';
    }
    if (firstVisible(['.geetest_panel', '.nc-container', '[class*="captcha"]', 'iframe[src*="captcha"]'])) {
      return '检测到验证码/安全验证';
    }
    const body = document.body ? document.body.innerText : '';
    if (/(安全验证|拖动下方滑块|请完成验证)/.test(body)) return '检测到验证码/安全验证';
    return '';
  }

  /** 识别「打招呼/沟通次数已达上限」。 */
  function detectLimit() {
    const body = document.body ? document.body.innerText : '';
    const m = body.match(/(今日|当天)?[^\n]{0,12}(沟通|打招呼|主动)[^\n]{0,12}(上限|已用完|已达|次数不足)/);
    if (m) return m[0].slice(0, 40);
    if (/打招呼个数已达上限|沟通次数已用完|已达今日上限/.test(body)) return '打招呼次数已达上限';
    return '';
  }

  // ---------------- 元素定位 ----------------
  function findStartChatBtn() {
    const sels = [
      '.btn-startchat',
      '.op-btn-chat',
      '.job-detail-op .btn-startchat',
      '[ka*="job-detail-chat"]',
      '.btn-startchat-wrap .btn',
      '.job-op .btn-primary',
    ];
    const bySel = firstVisible(sels);
    if (bySel) return bySel;

    // 按文本兜底
    for (const el of qa('a, button, span, div')) {
      const t = textOf(el);
      if (!t || t.length > 8) continue;
      if (/^(立即沟通|继续沟通|沟通)$/.test(t) && visible(el)) return el;
    }
    return null;
  }

  function findInput() {
    const sels = [
      '#chat-input',
      '.chat-input',
      '.chat-editor',
      '.edit-area [contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea[class*="chat"]',
      'textarea[class*="input"]',
      '.input-area textarea',
    ];
    for (const s of sels) {
      for (const el of qa(s)) {
        if (visible(el)) return el;
      }
    }
    return null;
  }

  function findSendBtn() {
    const sels = [
      '.send-message',
      '.btn-send',
      '.chat-op .btn',
      '[class*="send-btn"]',
      'button[class*="send"]',
    ];
    const btn = firstVisible(sels);
    if (btn) return btn;
    for (const el of qa('a, button, span, div')) {
      const t = textOf(el);
      if (t === '发送' && visible(el)) return el;
    }
    return null;
  }

  function inputText(input) {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
    return input.innerText || '';
  }

  // ---------------- 发送 ----------------
  /** 在输入框写入文本。 */
  function writeText(input, text) {
    input.focus();
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // contenteditable
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
      if (!inputText(input).includes(text.slice(0, 6))) {
        input.innerHTML = '';
        input.textContent = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    } catch {
      input.textContent = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }

  /** 校验：消息出现在会话中且输入框已清空。 */
  function verifySent(input, text) {
    const probe = text.slice(0, 10);
    const body = document.body ? document.body.innerText : '';
    const appeared = body.includes(probe);
    const cleared = !inputText(input).includes(probe);
    return appeared && cleared;
  }

  async function sendText(content) {
    const block = detectBlock();
    if (block) return { ok: false, error: block };

    let input = findInput();
    for (let i = 0; i < 20 && !input; i++) {
      await sleep(400);
      input = findInput();
    }
    if (!input) return { ok: false, error: '未找到聊天输入框' };

    writeText(input, content);
    await sleep(350);

    const btn = findSendBtn();
    if (btn) {
      btn.click();
    } else {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
      );
      input.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
      );
    }

    for (let i = 0; i < 15; i++) {
      await sleep(400);
      if (verifySent(input, content)) return { ok: true };
      const lim = detectLimit();
      if (lim) return { ok: false, error: '次数上限：' + lim };
      const blk = detectBlock();
      if (blk) return { ok: false, error: blk };
    }
    return { ok: false, error: '发送后未检测到消息出现（页面结构可能已变化）' };
  }

  /** 点击「立即沟通」；若输入框已存在则视为已进入会话。 */
  async function startChat() {
    const block = detectBlock();
    if (block) return { ok: false, error: block };
    if (findInput()) return { ok: true, alreadyOpen: true };

    const btn = findStartChatBtn();
    if (!btn) return { ok: false, error: '未找到「立即沟通」按钮' };
    btn.click();
    return { ok: true, clicked: true };
  }

  /** 在消息页按公司名定位会话并打开。 */
  async function openConversation(company) {
    if (!company) return false;
    const items = qa('.user-list li, .chat-user-list li, [class*="user-item"], .geek-list li');
    for (const it of items) {
      if (textOf(it).includes(company)) {
        realClick(clickTargetOf(it)); // 点内部 .friend-content，直接点 li 不切换会话
        await sleep(600);
        return true;
      }
    }
    return false;
  }

  // ---------------- 简历发送 ----------------
  function findResumeBtn() {
    const sels = ['.btn-send-resume', '.resume-btn', '[class*="send-resume"]', '[ka*="resume"]'];
    const bySel = firstVisible(sels);
    if (bySel) return bySel;
    for (const el of qa('a, button, span, div')) {
      const t = textOf(el);
      if (!t || t.length > 12) continue;
      if (/^(发送简历|发简历|发送附件简历|发送我的简历)$/.test(t) && visible(el)) return el;
    }
    return null;
  }

  async function sendResume(company) {
    const block = detectBlock();
    if (block) return { ok: false, error: block };

    let btn = findResumeBtn();
    if (!btn && company) {
      await openConversation(company);
      await sleep(600);
      btn = findResumeBtn();
    }
    for (let i = 0; i < 8 && !btn; i++) {
      await sleep(400);
      btn = findResumeBtn();
    }
    if (!btn) return { ok: false, error: '未找到「发送简历」按钮' };

    btn.click();
    await sleep(500);
    // 可能的二次确认弹窗
    const confirm = firstVisible([
      '.dialog-footer .btn-primary', '.modal-footer .btn-primary',
      '.confirm-btn', '.dialog-v2-footer .btn-primary',
    ]);
    if (confirm && /确认|发送|确定/.test(textOf(confirm))) {
      confirm.click();
      await sleep(500);
    }
    return { ok: true };
  }

  // ---------------- HR 新消息监听 ----------------
  function isChatPage() {
    return /\/web\/geek\/chat/.test(location.pathname || '');
  }

  /**
   * 当前会话对应的公司名。
   * BOSS 会话头部 .base-info 内依次为：
   *   .name-content > .name-text（HR 名） → span（公司名，无 class） → .base-title（职位）
   */
  function getChatCompany() {
    const baseInfo = q('.top-info-content .base-info, .user-info .base-info, .base-info');
    if (baseInfo) {
      const title = textOf(q('.base-title', baseInfo));
      // 紧跟 HR 名之后的兄弟 span 即公司名
      const sib = textOf(q('.name-content + span', baseInfo));
      if (sib && sib !== title) return sib.replace(/\s+/g, '');
      // 无 class 的 span
      const bare = textOf(q('span:not([class])', baseInfo));
      if (bare && bare !== title) return bare.replace(/\s+/g, '');
      // 排除姓名与职位后的首个 span
      const name = textOf(q('.name-text', baseInfo));
      for (const sp of qa('span', baseInfo)) {
        const s = textOf(sp);
        if (s && s !== name && s !== title) return s.replace(/\s+/g, '');
      }
    }
    // 其他结构兜底
    for (const sel of ['.chat-header .company-name', '.message-header .company-name', '.company-name']) {
      for (const el of qa(sel)) {
        if (visible(el)) {
          const t = textOf(el);
          if (t) return t.replace(/\s+/g, '');
        }
      }
    }
    return '';
  }

  /**
   * 会话消息列表容器。
   * 注意：不能用选择器列表（querySelector 按文档顺序取首命中，外层 .chat-conversation
   * 会先于内层 ul.im-list 命中），必须按优先级逐个尝试。
   */
  function messageList() {
    for (const sel of ['.im-list', '.chat-record .chat-message', '.chat-conversation']) {
      const el = q(sel);
      if (el) return el;
    }
    return document.body;
  }

  /**
   * 会话中的「对方（HR）」消息。
   * 真实结构：ul.im-list > li.message-item，自己发的带 item-myself，正文在 .text-content。
   * 判定：排除自己发的，其余含文本气泡的视为 HR 消息（系统提示无 .text-content，天然被过滤）。
   */
  function getInboundItems() {
    const list = messageList();
    let items = qa('li.message-item, .message-item', list);
    if (!items.length) items = qa('li[class*="friend"]', list);
    const out = [];
    for (const it of items) {
      if (/myself/i.test(String(it.className || ''))) continue;
      const bubble = q('.text-content', it);
      if (!bubble) continue;
      const t = textOf(bubble);
      if (t) out.push(t);
    }
    return out;
  }

  /** 会话最后一条有内容的消息是否来自 HR（true = 我尚未回复，需要应答）。 */
  function lastSpeakerIsHr() {
    const list = messageList();
    let items = qa('li.message-item, .message-item', list);
    if (!items.length) items = qa('li[class*="friend"]', list);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const bubble = q('.text-content', it);
      if (!bubble || !textOf(bubble)) continue; // 跳过系统提示
      return !/myself/i.test(String(it.className || ''));
    }
    return false;
  }

  /** 当前会话对应的岗位名称（聊天页右栏顶部），用于回复前判定岗位方向。 */
  function getChatJobTitle() {
    return textOf(q('.chat-position-content .position-name, .position-content .position-name'));
  }

  /** 会话列表项（左侧列表，用于未回复消息巡查）。 */
  function conversationItems() {
    const items = qa('.user-list li, .chat-user-list li, [class*="user-item"], .geek-list li');
    return items.filter((it) => visible(it) && textOf(it).length > 0);
  }

  /** BOSS 的点击监听挂在会话项内部的 .friend-content 上，直接点 li 不会切换会话。 */
  function clickTargetOf(item) {
    return q('.friend-content', item) || q('.friend-content-warp', item) || item;
  }

  /** 派发真实的鼠标事件序列，兼容 Vue 的 click 监听。 */
  function realClick(node) {
    if (!node) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      node.dispatchEvent(new MouseEvent('mousedown', opts));
      node.dispatchEvent(new MouseEvent('mouseup', opts));
      node.dispatchEvent(new MouseEvent('click', opts));
    } catch {
      try { node.click(); } catch { /* 忽略 */ }
    }
  }

  /** 带未读角标的会话（左列表 notice-badge），即最可能有未回复消息的会话。 */
  function unreadItems() {
    return conversationItems().filter((it) => q('.notice-badge', it));
  }

  /** DOM 结构骨架（tag.class 缩进树），用于校准左侧会话列表选择器。 */
  function domSkeleton(limit) {
    const out = [];
    const max = limit || 160;
    const walk = (node, depth) => {
      if (out.length >= max || depth > 9) return;
      const kids = (node && node.children) || [];
      for (let i = 0; i < kids.length; i++) {
        if (out.length >= max) return;
        const c = kids[i];
        const cls = String(c.className || '').trim().replace(/\s+/g, '.');
        out.push('  '.repeat(depth) + c.tagName.toLowerCase() + (cls ? '.' + cls : ''));
        walk(c, depth + 1);
      }
    };
    walk(document.body || document.documentElement, 0);
    return out;
  }

  const seenInbound = new Set();
  // 已终止会话（已回绝 / LLM 判定结束）：不再应答，巡查时跳过，避免一直停在该会话上
  const noReply = new Set();
  async function loadNoReply() {
    try {
      const { noReplyCompanies = [] } = await chrome.storage.local.get('noReplyCompanies');
      noReplyCompanies.forEach((c) => noReply.add(c));
    } catch { /* 忽略 */ }
  }
  let monitorCompany = '';
  let monitorReady = false;
  let scanTimer = null;

  function scanInbound() {
    if (!isChatPage()) return;
    const company = getChatCompany();
    if (company && noReply.has(company)) return; // 已终止会话不重复上报
    const texts = getInboundItems();

    // 首次进入 / 切换会话：记录基线，避免重放历史消息
    if (!monitorReady || company !== monitorCompany) {
      texts.forEach((t) => seenInbound.add(t));
      monitorCompany = company;
      monitorReady = true;
      // HR 主动发起、且我尚未回复的会话：补报最新一条，触发自动应答
      if (company && texts.length && lastSpeakerIsHr()) {
        chrome.runtime
          .sendMessage({
            type: 'INBOUND_DETECTED',
            company,
            content: texts[texts.length - 1],
            jobTitle: getChatJobTitle(),
          })
          .catch(() => {});
      }
      return;
    }
    if (!company) return;

    for (const t of texts) {
      if (seenInbound.has(t)) continue;
      seenInbound.add(t);
      chrome.runtime
        .sendMessage({
          type: 'INBOUND_DETECTED',
          company,
          content: t,
          jobTitle: getChatJobTitle(),
        })
        .catch(() => {});
    }
    if (seenInbound.size > 600) {
      seenInbound.clear();
      texts.forEach((t) => seenInbound.add(t));
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scanInbound(); }, 600);
  }

  // 未回复消息巡查：当前会话无待回复时，轮转打开下一个会话，
  // 使「我未主动沟通过、主动来找我」的未回复消息也能被识别并应答。
  let sweepIdx = -1;
  let sweepTimer = null;
  let sweepLast = '';

  async function sweepTick() {
    if (!isChatPage()) return;
    let flags = {};
    try {
      flags = await chrome.storage.local.get(['autoReply', 'polling']);
    } catch {
      return;
    }
    if (!flags.autoReply || !flags.polling) return;
    // 当前会话还有未回复的 HR 消息 → 留在原地等待应答；已终止会话除外
    if (lastSpeakerIsHr() && !noReply.has(getChatCompany())) return;

    // 优先打开带未读角标的会话；没有未读时轮转全部会话兜底
    let candidates = unreadItems().filter((it) => textOf(it).slice(0, 60) !== sweepLast);
    if (!candidates.length) {
      const items = conversationItems();
      if (items.length < 2) return;
      sweepIdx = (sweepIdx + 1) % items.length;
      candidates = [items[sweepIdx]];
    }
    const item = candidates[0];
    if (!item) return;
    sweepLast = textOf(item).slice(0, 60);
    try {
      chrome.runtime.sendMessage({ type: 'SWEEP_STEP', text: sweepLast.slice(0, 40) }).catch(() => {});
    } catch { /* 忽略 */ }
    realClick(clickTargetOf(item));
  }

  function startMonitor() {
    if (!isChatPage()) return;
    scanInbound();
    try {
      const target = messageList();
      new MutationObserver(scheduleScan).observe(target, {
        childList: true, subtree: true, characterData: true,
      });
    } catch { /* 监听失败则仅靠轮询 */ }
    setInterval(scanInbound, 5000);
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(() => { sweepTick().catch(() => {}); }, 10000);
  }

  loadNoReply().then(() => startMonitor());

  // ---------------- 消息入口 ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;

    if (msg.type === 'PROBE_CHAT') {
      const list = messageList();
      const convs = conversationItems();
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        isChatPage: isChatPage(),
        company: getChatCompany(),
        jobTitle: textOf(q('.chat-position-content .position-name, .position-content .position-name')),
        inboundCount: getInboundItems().length,
        lastSpeakerIsHr: lastSpeakerIsHr(),
        conversationCount: convs.length,
        conversationSamples: convs.slice(0, 5).map((it) => textOf(it).slice(0, 24)),
        listSample: textOf(list).slice(0, 120),
        hasInput: !!findInput(),
        hasStartChat: !!findStartChatBtn(),
        hasResume: !!findResumeBtn(),
        block: detectBlock(),
      });
      return false;
    }

    if (msg.type === 'DUMP_CHAT_HTML') {
      const list = messageList();
      // 左侧会话列表候选容器：用于定位真实选择器
      const candSels = [
        '.user-list', '.chat-user-list', '.conversation-list', '.chat-list', '.geek-list',
        '[class*="user-list"]', '[class*="conversation-list"]', '[class*="chat-list"]',
        '[class*="geek-list"]', '[class*="session"]', '[class*="friend"]',
      ];
      const leftCandidates = [];
      for (const s of candSels) {
        const els = qa(s);
        if (els.length) {
          leftCandidates.push({ sel: s, count: els.length, sample: els[0].outerHTML.slice(0, 1000) });
        }
      }
      sendResponse({
        ok: true,
        url: location.href,
        company: getChatCompany(),
        isChatPage: isChatPage(),
        conversationCount: conversationItems().length,
        leftCandidates,
        skeleton: domSkeleton(160),
        html: (list ? list.outerHTML : '').slice(0, 8000),
      });
      return false;
    }

    if (msg.type === 'MARK_NO_REPLY') {
      if (msg.company) noReply.add(msg.company);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'SEND_RESUME') {
      (async () => {
        try { sendResponse(await sendResume(msg.company || '')); }
        catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      })();
      return true;
    }

    if (msg.type === 'START_CHAT') {
      (async () => {
        try { sendResponse(await startChat()); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
      })();
      return true;
    }

    if (msg.type === 'SEND_TEXT') {
      (async () => {
        try { sendResponse(await sendText(msg.content || '')); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
      })();
      return true;
    }

    if (msg.type === 'SEND_REPLY') {
      (async () => {
        try {
          if (!findInput() && msg.company) await openConversation(msg.company);
          sendResponse(await sendText(msg.content || ''));
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
      })();
      return true;
    }

    return false;
  });
})();