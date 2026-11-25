/**
 * sidepanel.js — 侧边栏逻辑
 *
 * 步骤 1：后端探活 + 当前标签页检测
 * 步骤 2：岗位采集（驱动 content script）+ 达标岗位展示 + 加入外呼
 */

const $ = (id) => document.getElementById(id);
const state = { apiBase: 'http://127.0.0.1:8000', activeTabId: null, isBoss: false };

// ---------------- 基础通信 ----------------
function bg(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: '空响应' });
      }
    });
  });
}

async function loadBase() {
  const r = await bg('GET_API_BASE');
  if (r && r.apiBase) state.apiBase = r.apiBase;
}

/** 统一后端请求封装。 */
async function apiFetch(path, opts = {}) {
  const resp = await fetch(state.apiBase + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try {
    data = await resp.json();
  } catch {
    /** 非 JSON 响应 */
  }
  if (!resp.ok) {
    throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
  }
  return data;
}

function setDot(s) { $('conn-dot').className = 'dot ' + s; }
function setStatus(text, cls = '') { const el = $('status-text'); el.textContent = text; el.className = 'v ' + cls; }
function setCaptureStatus(text, cls = '') { const el = $('capture-status'); el.textContent = text; el.className = 'status-line ' + cls; }

// ---------------- 探活 ----------------
async function refreshHealth() {
  setDot('busy');
  setStatus('检测中…', 'warn');
  $('err-text').classList.add('hidden');
  $('btn-refresh').disabled = true;

  const res = await bg('HEALTH_CHECK');
  $('api-base').textContent = res.base || state.apiBase;
  if (res.base) state.apiBase = res.base;

  if (!res.ok) {
    setDot('off');
    setStatus('未连接', 'bad');
    ['model', 'llm', 'circuit', 'db', 'latency'].forEach((k) => ($(k).textContent = '—'));
    const err = $('err-text');
    err.textContent = '连接失败：' + (res.error || '未知错误') + '（请确认后端已启动）';
    err.classList.remove('hidden');
    $('btn-refresh').disabled = false;
    return;
  }

  const d = res.data || {};
  setDot('on');
  setStatus('已连接', 'ok');
  $('model').textContent = d.model || '—';

  const llmEl = $('llm');
  llmEl.textContent = d.llm_configured ? '已配置' : '未配置';
  llmEl.className = 'v ' + (d.llm_configured ? 'ok' : 'bad');

  const cb = $('circuit');
  cb.textContent = d.circuit_broken ? '已熔断' : '正常';
  cb.className = 'v ' + (d.circuit_broken ? 'bad' : 'ok');

  const dbEl = $('db');
  dbEl.textContent = d.db || '—';
  dbEl.title = d.db || '';

  $('latency').textContent = res.latencyMs + ' ms';
  $('btn-refresh').disabled = false;
}

// ---------------- 当前标签页 ----------------
async function refreshActiveTab() {
  $('tab-host').textContent = '—';
  $('tab-kind').textContent = '—';
  $('cs-status').textContent = '—';
  $('cs-status').className = 'v';
  state.activeTabId = null;
  state.isBoss = false;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    tabs = [];
  }
  const tab = tabs && tabs[0];
  if (!tab || !tab.url) {
    $('tab-host').textContent = '无可用标签页';
    updateCaptureAvailability();
    return;
  }

  let host = '—';
  try { host = new URL(tab.url).host; } catch { /** 非 http 页面 */ }
  $('tab-host').textContent = host;

  const isBoss = /(^|\.)zhipin\.com$/i.test(host);
  if (!isBoss) {
    $('tab-kind').textContent = '非 BOSS 页面';
    $('cs-status').textContent = '未注入（不适用）';
    updateCaptureAvailability();
    return;
  }

  state.activeTabId = tab.id;
  state.isBoss = true;

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (resp && resp.ok) {
      $('cs-status').textContent = '已注入';
      $('cs-status').className = 'v ok';
      $('tab-kind').textContent = resp.pageKind || '未知';
    } else {
      $('cs-status').textContent = '无响应';
      $('cs-status').className = 'v warn';
    }
  } catch {
    $('cs-status').textContent = '未注入';
    $('cs-status').className = 'v bad';
  }
  updateCaptureAvailability();
}

function updateCaptureAvailability() {
  const btn = $('btn-capture');
  btn.disabled = !state.isBoss;
  $('btn-dump').disabled = !state.isBoss;
  if (!state.isBoss) setCaptureStatus('请先打开 BOSS 直聘搜索/推荐列表页');
}

/** 诊断：取当前页首条岗位卡片 HTML，复制到剪贴板（失败则输出到控制台）。 */
async function dumpFirstCard() {
  if (!state.isBoss || state.activeTabId == null) {
    setCaptureStatus('请先打开 BOSS 直聘列表页', 'bad');
    return;
  }
  setCaptureStatus('正在读取首条卡片…', 'warn');
  try {
    const resp = await chrome.tabs.sendMessage(state.activeTabId, { type: 'DUMP_FIRST_CARD' });
    if (!resp || !resp.ok || !resp.html) {
      setCaptureStatus('未找到岗位卡片', 'bad');
      return;
    }
    try {
      await navigator.clipboard.writeText(resp.html);
      setCaptureStatus('首条卡片 HTML 已复制到剪贴板，可直接粘贴给我', 'ok');
    } catch {
      console.log('[BOSS Agent] FIRST CARD HTML:\n' + resp.html);
      setCaptureStatus('已输出到控制台（F12 → Console 复制），可直接粘贴给我', 'ok');
    }
  } catch (err) {
    setCaptureStatus('读取失败：' + ((err && err.message) || err), 'bad');
  }
}

// ---------------- 岗位采集 ----------------
async function captureJobs() {
  if (!state.isBoss || state.activeTabId == null) {
    setCaptureStatus('请先打开 BOSS 直聘列表页', 'bad');
    return;
  }
  const deep = $('chk-deep').checked;
  const btn = $('btn-capture');
  btn.disabled = true;
  setCaptureStatus(deep ? '采集中（含深抓 JD，请稍候）…' : '采集中…', 'warn');

  try {
    const resp = await chrome.tabs.sendMessage(state.activeTabId, {
      type: 'CAPTURE_JOBS',
      deep,
    });
    if (!resp || !resp.ok) {
      setCaptureStatus('采集失败：' + ((resp && resp.error) || '无响应'), 'bad');
      return;
    }
    if (!resp.count) {
      setCaptureStatus('未识别到岗位卡片，请确认当前为搜索/推荐列表页', 'warn');
      return;
    }

    setCaptureStatus(`已识别 ${resp.count} 条，正在提交后端评分…`, 'warn');
    const out = await apiFetch('/api/jobs/ingest', {
      method: 'POST',
      body: JSON.stringify({ jobs: resp.jobs }),
    });

    // 汇总淘汰原因，便于快速定位提取问题
    const reasons = {};
    (out.results || []).forEach((r) => {
      if (r.filter_pass) return;
      (r.filter_reason || '未知').split(' · ').forEach((tok) => {
        reasons[tok] = (reasons[tok] || 0) + 1;
      });
    });
    const topReasons = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k}×${v}`)
      .join(' · ');

    const cls = out.passed_filter > 0 ? 'ok' : 'warn';
    setCaptureStatus(
      `采集 ${out.received} · 通过 ${out.passed_filter} · 淘汰 ${out.dropped} · 已评分 ${out.scored}` +
        (topReasons ? `\n淘汰原因：${topReasons}` : ''),
      cls
    );
    await refreshJobs();
  } catch (err) {
    setCaptureStatus('采集出错：' + ((err && err.message) || err), 'bad');
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 达标岗位列表 ----------------
function scoreBadgeClass(score) {
  if (score == null) return 'none';
  if (score >= 80) return '';
  if (score >= 60) return 'mid';
  return 'low';
}

function renderJob(job) {
  const item = document.createElement('div');
  item.className = 'job-item';

  const top = document.createElement('div');
  top.className = 'job-top';

  const title = document.createElement('a');
  title.className = 'job-title';
  title.textContent = job.title || '(无标题)';
  title.href = job.url || '#';
  title.target = '_blank';
  title.title = job.title || '';
  top.appendChild(title);

  const badge = document.createElement('span');
  badge.className = 'score-badge ' + scoreBadgeClass(job.match_score);
  badge.textContent = job.match_score == null ? '未评分' : job.match_score + ' 分';
  top.appendChild(badge);
  item.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'job-meta';
  meta.textContent = [job.company, job.salary, job.city, job.experience, job.education]
    .filter(Boolean)
    .join(' · ');
  item.appendChild(meta);

  if (job.match_reason) {
    const reason = document.createElement('p');
    reason.className = 'job-reason';
    reason.textContent = job.match_reason;
    item.appendChild(reason);
  }

  const actions = document.createElement('div');
  actions.className = 'job-actions';

  if (job.company_whitelisted) {
    const st = document.createElement('span');
    st.className = 'badge-status';
    st.textContent = '白名单 · 不主动外呼';
    st.title = '该公司我联系过或 HR 主动找过我，不再主动发消息';
    actions.appendChild(st);
  } else if (job.status === 'pending_outreach') {
    const st = document.createElement('span');
    st.className = 'badge-status';
    st.textContent = '已入队待发送';
    actions.appendChild(st);
  } else {
    const btn = document.createElement('button');
    btn.textContent = '加入外呼';
    btn.addEventListener('click', () => enqueueJob(job.id, btn, item));
    actions.appendChild(btn);
  }
  item.appendChild(actions);

  return item;
}

async function refreshJobs() {
  const list = $('job-list');
  const min = parseInt($('input-minscore').value || '0', 10) || 0;
  const status = $('sel-status') ? $('sel-status').value : '';
  const sort = ($('sel-sort') && $('sel-sort').value) || 'score';

  const params = new URLSearchParams({ sort });
  if (status) params.set('status', status);
  else params.set('min_score', String(min));

  list.innerHTML = '<p class="hint">加载中…</p>';
  try {
    const out = await apiFetch('/api/jobs?' + params.toString());
    list.innerHTML = '';
    if (!out.jobs || !out.jobs.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = status
        ? '该状态下暂无岗位。'
        : `暂无匹配分 ≥ ${min} 的岗位。`;
      list.appendChild(p);
      return;
    }
    out.jobs.forEach((job) => list.appendChild(renderJob(job)));
  } catch (err) {
    list.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'hint bad';
    p.textContent = '加载失败：' + ((err && err.message) || err);
    list.appendChild(p);
  }
}

async function enqueueJob(jobId, btn, item) {
  btn.disabled = true;
  btn.textContent = '提交中…';
  const msg = document.createElement('p');
  msg.className = 'job-msg';
  try {
    const out = await apiFetch('/api/queue/enqueue', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId }),
    });
    btn.textContent = '已入队';
    msg.classList.add('ok');
    msg.textContent = '已加入外呼队列（queue #' + out.queue_id + '）';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '加入外呼';
    msg.classList.add('bad');
    msg.textContent = (err && err.message) || String(err);
  }
  item.appendChild(msg);
}

// ---------------- 发送控制 ----------------
function setSendStatus(text, cls = '') {
  const el = $('send-status');
  el.textContent = text;
  el.className = 'status-line ' + cls;
}

/** 拉取今日统计 + 下一条队列项，刷新发送控制面板。 */
async function refreshSendPanel() {
  await refreshSendState();
  try {
    const [stats, next] = await Promise.all([
      apiFetch('/api/stats/today'),
      apiFetch('/api/queue/next'),
    ]);

    const used = stats.first_outreach_today;
    const limit = stats.first_outreach_limit;
    const qEl = $('quota-text');
    qEl.textContent = `${used} / ${limit}`;
    qEl.className = 'v ' + (limit - used > 0 ? 'ok' : 'bad');

    $('reply-count').textContent = String(stats.reply_today);

    const nEl = $('next-item');
    if (next.item) {
      const label = next.item.company_name
        ? `${next.item.company_name} · ${next.item.job_title || next.item.send_type}`
        : next.item.job_title || next.item.send_type;
      nEl.textContent = label;
      nEl.title = label;
      nEl.className = 'v ellipsis';
    } else {
      nEl.textContent = next.reason || '队列为空';
      nEl.title = next.reason || '';
      nEl.className = 'v ellipsis warn';
    }

    const wait = next.wait_seconds || 0;
    const wEl = $('wait-text');
    wEl.textContent = wait > 0 ? `${wait}s 后可发` : '可立即发送';
    wEl.className = 'v ' + (wait > 0 ? 'warn' : 'ok');

    const cbEl = $('circuit2');
    cbEl.textContent = next.circuit_broken ? '已熔断' : '正常';
    cbEl.className = 'v ' + (next.circuit_broken ? 'bad' : 'ok');

    const ivEl = $('interview-text');
    const pending = stats.interview_pending || 0;
    ivEl.textContent = pending > 0 ? `${pending} 家待人工跟进` : '无';
    ivEl.className = 'v ' + (pending > 0 ? 'warn' : 'ok');
  } catch (err) {
    setSendStatus('读取发送状态失败：' + ((err && err.message) || err), 'bad');
  }
}

/** 从 background 读取轮询开关与发送日志。 */
async function refreshSendState() {
  const st = await bg('GET_SEND_STATE');
  const polling = !!(st && st.polling);
  const badge = $('poll-badge');
  badge.textContent = polling ? '轮询：开' : '轮询：关';
  badge.className = 'badge-status ' + (polling ? 'on' : '');
  const btn = $('btn-poll-toggle');
  btn.textContent = polling ? '停止轮询' : '开始轮询';
  btn.className = polling ? '' : 'primary';
  const ar = $('chk-autoreply');
  if (ar) ar.checked = !!(st && st.autoReply);
  renderSendLog((st && st.sendLog) || []);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderSendLog(log) {
  const box = $('send-log');
  box.innerHTML = '';
  if (!log.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '暂无发送记录。';
    box.appendChild(p);
    return;
  }
  log.slice(0, 8).forEach((e) => {
    const row = document.createElement('div');
    row.className = 'log-row';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = fmtTime(e.ts);
    row.appendChild(time);

    const body = document.createElement('span');
    body.className = 'log-body';
    let text;
    if (e.stage === 'poll-start') {
      text = '轮询已启动';
      body.className += ' ok';
    } else if (e.stage === 'sweep') {
      text = `巡查未回复消息 → ${e.text || ''}`;
      body.className += ' ok';
    } else if (e.stage === 'circuit') {
      text = '熔断：' + (e.error || '');
      body.className += ' bad';
    } else if (e.stage === 'inbound-detected') {
      text = `HR 消息（${e.company || '未知公司'}）：${e.text || ''}（未开启自动应答）`;
      body.className += ' warn';
    } else if (e.stage === 'inbound') {
      const label = { manual_interview: '转人工（面试）', request_resume: '要求简历', reply: '自动应答', close: '结束会话', decline: '岗位不符·礼貌回绝' }[e.action] || e.action || '';
      text = `HR 回复（${e.company || ''}）：${e.text || ''} → ${label}`;
      body.className += e.action === 'manual_interview' ? ' warn' : ' ok';
    } else if (e.stage === 'resume') {
      text = (e.ok ? '已发送简历 ' : '发送简历失败 ') + (e.company || '') + (e.ok ? '' : '（' + (e.error || '') + '）');
      body.className += e.ok ? ' ok' : ' bad';
    } else if (e.stage === 'reply-send') {
      text = (e.ok ? '已回复 ' : '回复失败 ') + (e.company || '') + `：${e.text || ''}` + (e.ok ? '' : '（' + (e.error || '') + '）');
      body.className += e.ok ? ' ok' : ' bad';
    } else {
      const who = [e.company, e.title].filter(Boolean).join(' · ') || `queue #${e.queueId}`;
      text = (e.ok ? '已发送 ' : '发送失败 ') + who + (e.ok ? '' : '（' + (e.error || '未知') + '）');
      body.className += e.ok ? ' ok' : ' bad';
    }
    body.textContent = text;
    row.appendChild(body);
    box.appendChild(row);
  });
}

async function togglePolling() {
  const st = await bg('GET_SEND_STATE');
  const polling = !!(st && st.polling);
  $('btn-poll-toggle').disabled = true;
  const res = await bg(polling ? 'STOP_POLLING' : 'START_POLLING');
  $('btn-poll-toggle').disabled = false;
  if (!res || !res.ok) {
    setSendStatus('切换轮询失败：' + ((res && res.error) || '无响应'), 'bad');
    return;
  }
  setSendStatus(res.polling ? '轮询已开启，每 30 秒检查一次队列。' : '轮询已停止。', res.polling ? 'ok' : '');
  await refreshSendPanel();
}

async function sendNow() {
  $('btn-send-now').disabled = true;
  setSendStatus('正在发送下一条…', 'warn');
  const res = await bg('SEND_NOW');
  $('btn-send-now').disabled = false;

  if (!res) {
    setSendStatus('发送失败：无响应', 'bad');
  } else if (res.stage === 'idle' || res.stage === 'skip-inflight') {
    setSendStatus('未发送：' + (res.reason || '队列为空或该条正在发送中'), 'warn');
  } else if (res.stage === 'circuit') {
    setSendStatus('熔断中：' + (res.reason || ''), 'bad');
  } else if (res.ok) {
    const it = res.item || {};
    setSendStatus(`已发送：${it.company_name || ''} ${it.job_title || ''}`.trim(), 'ok');
  } else {
    setSendStatus('发送失败：' + (res.error || '未知错误'), 'bad');
  }
  await refreshSendPanel();
}

async function resetCircuit() {
  $('btn-reset-circuit').disabled = true;
  try {
    await apiFetch('/api/circuit/reset', { method: 'POST' });
    setSendStatus('熔断已重置。', 'ok');
    await refreshSendPanel();
    await refreshHealth();
  } catch (err) {
    setSendStatus('重置失败：' + ((err && err.message) || err), 'bad');
  } finally {
    $('btn-reset-circuit').disabled = false;
  }
}

/** 诊断：找一个已打开的 BOSS 聊天页，探测能否识别公司/HR 消息/简历按钮。 */
async function probeChatPage() {
  const btn = $('btn-probe-chat');
  btn.disabled = true;
  setSendStatus('正在检测聊天页…', 'warn');
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.zhipin.com/*' });
    const chats = tabs.filter((t) => /\/web\/geek\/chat/.test(t.url || ''));
    if (!chats.length) {
      setSendStatus('未找到已打开的 BOSS 聊天页（请先打开消息页）', 'warn');
      return;
    }
    const resp = await chrome.tabs.sendMessage(chats[0].id, { type: 'PROBE_CHAT' });
    if (!resp || !resp.ok) {
      setSendStatus('聊天页无响应，请刷新该页面后重试', 'bad');
      return;
    }
    setSendStatus(
      `聊天页：${resp.url}\n页面标题：${resp.title || '（空）'}` +
        `\n识别公司：${resp.company || '（未识别到，需校准选择器）'}` +
        `\n会话岗位：${resp.jobTitle || '（未识别到）'}` +
        `\n已识别 HR 消息：${resp.inboundCount} 条` +
        `\n最后发言：${resp.lastSpeakerIsHr ? 'HR（未回复）' : '我/无'}` +
        `\n会话列表：${resp.conversationCount || 0} 项` +
        (resp.conversationSamples && resp.conversationSamples.length
          ? `\n列表样本：${resp.conversationSamples.join(' | ')}`
          : '') +
        `\n发送简历按钮：${resp.hasResume ? '有' : '无'} · 输入框：${resp.hasInput ? '有' : '无'}` +
        `\n登录/验证：${resp.block || '正常'}` +
        `\n会话内容样本：${resp.listSample || '（空）'}`,
      resp.company ? 'ok' : 'warn'
    );
  } catch (err) {
    setSendStatus('诊断失败：' + ((err && err.message) || err), 'bad');
  } finally {
    btn.disabled = false;
  }
}

/** 导出 BOSS 聊天页 HTML（复制到剪贴板），用于校准选择器。 */
async function dumpChatHtml() {
  const btn = $('btn-dump-chat');
  btn.disabled = true;
  setSendStatus('正在导出聊天页 HTML…', 'warn');
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.zhipin.com/*' });
    const chats = tabs.filter((t) => /\/web\/geek\/chat/.test(t.url || ''));
    if (!chats.length) {
      setSendStatus('未找到已打开的 BOSS 聊天页（请先打开消息页再导出）', 'warn');
      return;
    }
    const resp = await chrome.tabs.sendMessage(chats[0].id, { type: 'DUMP_CHAT_HTML' });
    if (!resp || !resp.ok) {
      setSendStatus('导出失败：聊天页无响应，请刷新该页面后重试', 'bad');
      return;
    }
    const payload =
      `# 聊天页诊断\nurl: ${resp.url}\nisChatPage: ${resp.isChatPage}\n` +
      `识别公司: ${resp.company || '（空）'}\n会话列表项: ${resp.conversationCount}\n\n` +
      `## 左侧列表候选\n` +
      ((resp.leftCandidates || [])
        .map((c) => `${c.sel} x${c.count}\n${c.sample}`)
        .join('\n---\n') || '（无候选命中）') +
      `\n\n## DOM 骨架\n${(resp.skeleton || []).join('\n')}\n\n## 右栏 HTML\n${resp.html || ''}`;
    try {
      await navigator.clipboard.writeText(payload);
      setSendStatus(`诊断已复制到剪贴板（${payload.length} 字符），粘贴给我即可`, 'ok');
    } catch {
      console.log('[BOSS Agent] CHAT DUMP:\n' + payload);
      setSendStatus('已输出到控制台（F12 → Console 复制），粘贴给我即可', 'ok');
    }
  } catch (err) {
    setSendStatus('导出失败：' + ((err && err.message) || err), 'bad');
  } finally {
    btn.disabled = false;
  }
}

/** 清除面试人工提醒。 */
async function clearInterview() {
  await bg('CLEAR_INTERVIEW');
  setSendStatus('已清除面试提醒。', 'ok');
  await refreshSendState();
}

/** 诊断：对发送用的工作标签页做一次 PROBE_CHAT，不消耗发送次数。 */
async function probeSendPage() {
  const btn = $('btn-probe-page');
  btn.disabled = true;
  setSendStatus('正在检测发送页…', 'warn');
  try {
    const st = await bg('GET_SEND_STATE');
    const tabId = st && st.workerTabId;
    if (tabId == null) {
      setSendStatus('尚无发送页标签页（先点一次「发送下一条」再诊断）', 'warn');
      return;
    }
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'PROBE_CHAT' });
    if (!resp || !resp.ok) {
      setSendStatus('诊断失败：发送页无响应（可能不是 BOSS 页面）', 'bad');
      return;
    }
    setSendStatus(
      `发送页：${resp.url}\n登录/验证：${resp.block || '正常'}` +
        `\n聊天输入框：${resp.hasInput ? '有' : '无'} · 立即沟通按钮：${resp.hasStartChat ? '有' : '无'}`,
      resp.block ? 'bad' : 'ok'
    );
  } catch (err) {
    setSendStatus('诊断失败：' + ((err && err.message) || err), 'bad');
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 记录与报表 ----------------
function miniItem(name, tags, href) {
  const row = document.createElement('div');
  row.className = 'mini-item';

  const nm = document.createElement('span');
  nm.className = 'name';
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.textContent = name;
    a.title = name;
    nm.appendChild(a);
  } else {
    nm.textContent = name;
    nm.title = name;
  }
  row.appendChild(nm);

  const tg = document.createElement('span');
  tg.className = 'tags';
  (tags || []).forEach((t) => {
    const s = document.createElement('span');
    s.className = 'badge-status ' + (t.cls || '');
    s.textContent = t.text;
    tg.appendChild(s);
  });
  row.appendChild(tg);
  return row;
}

function renderMiniList(boxId, rows, emptyText) {
  const box = $(boxId);
  box.innerHTML = '';
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = emptyText;
    box.appendChild(p);
    return;
  }
  rows.forEach((r) => box.appendChild(r));
}

async function loadReport() {
  const btn = $('btn-reload-report');
  btn.disabled = true;
  try {
    const [stats, comp, inter] = await Promise.all([
      apiFetch('/api/stats/today'),
      apiFetch('/api/companies?kind=contacted'),
      apiFetch('/api/interviews'),
    ]);

    $('rep-outreach').textContent = `${stats.first_outreach_today} / ${stats.first_outreach_limit} 次`;
    $('rep-reply').textContent = stats.reply_today + ' 次';
    const sum = comp.summary || {};
    $('rep-outbound').textContent = (sum.outbound || 0) + ' 家';
    $('rep-contacted').textContent = (sum.contacted || 0) + ' 家';
    $('rep-inbound').textContent = (sum.inbound || 0) + ' 家';
    $('rep-interview').textContent = (stats.interview_pending || 0) + ' 家';

    const companyRows = (comp.companies || []).map((c) => {
      const tags = [];
      if (c.is_outbound_contacted) tags.push({ text: '我发起', cls: 'on' });
      if (c.is_inbound_contacted) tags.push({ text: 'HR来聊', cls: '' });
      if (c.resume_sent) tags.push({ text: '已发简历', cls: '' });
      const t = c.last_contact_at ? String(c.last_contact_at).slice(5, 16) : '';
      if (t) tags.push({ text: t, cls: '' });
      return miniItem(c.name, tags);
    });
    renderMiniList('company-list', companyRows, '暂无已沟通过公司。');

    const interRows = (inter.interviews || []).map((it) =>
      miniItem(
        it.company,
        [
          it.job_title ? { text: it.job_title, cls: '' } : null,
          { text: String(it.updated_at || '').slice(5, 16), cls: '' },
        ].filter(Boolean),
        it.job_url || ''
      )
    );
    renderMiniList('interview-list', interRows, '暂无面试邀约。');
  } catch (err) {
    const msg = '加载失败：' + ((err && err.message) || err);
    renderMiniList('company-list', [], msg);
    renderMiniList('interview-list', [], '—');
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 设置 ----------------
const SETTING_FIELDS = [
  ['set-limit', 'daily_first_outreach_limit'],
  ['set-minscore', 'auto_outreach_min_score'],
  ['set-int-min', 'send_interval_min'],
  ['set-int-max', 'send_interval_max'],
  ['set-sal-min', 'salary_min'],
  ['set-sal-max', 'salary_max'],
];

function setSettingsStatus(text, cls = '') {
  const el = $('settings-status');
  el.textContent = text;
  el.className = 'status-line ' + cls;
}

async function loadSettings() {
  const btn = $('btn-reload-settings');
  btn.disabled = true;
  try {
    const out = await apiFetch('/api/settings');
    const map = {};
    (out.settings || []).forEach((r) => { map[r.key] = r.value; });
    SETTING_FIELDS.forEach(([id, key]) => { $(id).value = map[key] != null ? map[key] : ''; });
    $('set-cities').value = map.cities || '';
    setSettingsStatus('已读取当前设置。', 'ok');
  } catch (err) {
    setSettingsStatus('读取失败：' + ((err && err.message) || err), 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings() {
  const btn = $('btn-save-settings');
  btn.disabled = true;
  try {
    const items = SETTING_FIELDS
      .map(([id, key]) => ({ key, value: String($(id).value || '').trim() }))
      .filter((it) => it.value !== '');
    const cities = $('set-cities').value.trim();
    if (cities) items.push({ key: 'cities', value: cities });
    const out = await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(items),
    });
    setSettingsStatus(`已保存 ${out.updated} 项设置，即时生效。`, 'ok');
    await refreshSendPanel();
  } catch (err) {
    setSettingsStatus('保存失败：' + ((err && err.message) || err), 'bad');
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 打开 BOSS ----------------
async function openBoss() {
  const existing = await chrome.tabs.query({ url: 'https://*.zhipin.com/*' });
  if (existing && existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://www.zhipin.com/' });
  }
}

// ---------------- 事件绑定与初始化 ----------------
$('btn-refresh').addEventListener('click', refreshAll);
$('btn-open').addEventListener('click', openBoss);
$('btn-capture').addEventListener('click', captureJobs);
$('btn-dump').addEventListener('click', dumpFirstCard);
$('btn-reload-jobs').addEventListener('click', refreshJobs);
$('input-minscore').addEventListener('change', refreshJobs);
$('sel-status').addEventListener('change', refreshJobs);
$('sel-sort').addEventListener('change', refreshJobs);
$('btn-reload-report').addEventListener('click', loadReport);
$('btn-reload-settings').addEventListener('click', loadSettings);
$('btn-save-settings').addEventListener('click', saveSettings);
$('btn-poll-toggle').addEventListener('click', togglePolling);
$('btn-send-now').addEventListener('click', sendNow);
$('btn-reset-circuit').addEventListener('click', resetCircuit);
$('btn-probe-page').addEventListener('click', probeSendPage);
$('btn-probe-chat').addEventListener('click', probeChatPage);
$('btn-dump-chat').addEventListener('click', dumpChatHtml);
$('btn-clear-interview').addEventListener('click', clearInterview);
$('chk-autoreply').addEventListener('change', async (e) => {
  const res = await bg('SET_AUTO_REPLY', { enabled: e.target.checked });
  setSendStatus(
    res && res.autoReply
      ? '已开启自动应答：将监听 HR 回复，仅围绕岗位内容应答，离题即终止；命中面试转人工。'
      : '已关闭自动应答：只记录 HR 消息，不自动回复。',
    'ok'
  );
});

// background 推送的发送事件 → 实时刷新日志
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'SEND_EVENT') refreshSendState();
});

chrome.tabs.onActivated.addListener(() => { refreshActiveTab(); });
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete') refreshActiveTab();
});

async function refreshAll() {
  await loadBase();
  await Promise.all([refreshHealth(), refreshActiveTab()]);
  await refreshJobs();
  await Promise.all([refreshSendPanel(), loadReport(), loadSettings()]);
}

refreshAll();
// 轮询/限速随时间变化，定时刷新面板（仅界面刷新，不触发发送）
setInterval(() => { if (state.apiBase) refreshSendPanel(); }, 10000);