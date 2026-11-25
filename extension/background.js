/**
 * background.js — MV3 Service Worker
 *
 * 步骤 1：后端探活 + 侧边栏唤起 + 消息路由
 * 步骤 3：受控自动发送
 *   - chrome.alarms 周期轮询 /api/queue/next
 *   - 命中队列项 → 打开目标岗位页 → 驱动 boss_chat.js 发送 → 回传 ACK
 *   - 感知熔断 / 限速（wait_seconds）/ 每日配额
 *
 * 步骤 4：HR 回复处理
 *   - 收到内容脚本上报的 HR 新消息 → /api/reply/inbound 取决策
 *   - 决策执行：自动应答 / 自动发简历 / 面试转人工提醒
 *   - 开关：storage.autoReply（默认关，关闭时只记录不动作）
 *
 * 计数口径由后端保证：仅 first_outreach 计入每日 8 条；
 * 回复（reply）与简历发送（resume_sent）不计数。
 */

const DEFAULT_API_BASE = 'http://127.0.0.1:8000';
const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
const POLL_ALARM = 'boss-poll';
const POLL_PERIOD_MIN = 0.5; // 30s（与后端 30–60s 发送间隔匹配）
const INFLIGHT_TTL_MS = 2 * 60 * 1000; // 同一队列项 2 分钟内不重复发送

// ---------------- 基础 ----------------
async function getApiBase() {
  try {
    const { apiBase } = await chrome.storage.local.get('apiBase');
    return (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  } catch {
    return DEFAULT_API_BASE;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 忽略 query/hash 的 URL 比较：避免消息页带 ?ka=... 时被判定不同而反复重载。 */
function sameUrl(a, b) {
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

/** Chrome 消息通道类错误（页面被导航、进入 bfcache、内容脚本未就绪）。 */
function isChannelError(e) {
  return /Receiving end does not exist|message channel is closed|back\/forward cache|Could not establish connection|port closed|message port closed/i.test(
    String(e || '')
  );
}

const isChatUrl = (u) => /zhipin\.com\/web\/geek\/chat/.test(u || '');

/** 统一后端请求。 */
async function api(path, opts = {}) {
  const base = await getApiBase();
  const resp = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try {
    data = await resp.json();
  } catch {
    /* 非 JSON */
  }
  if (!resp.ok) throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
  return data;
}

async function healthCheck() {
  const base = await getApiBase();
  const started = Date.now();
  try {
    const resp = await fetch(`${base}/api/health`, { method: 'GET', cache: 'no-store' });
    const latencyMs = Date.now() - started;
    if (!resp.ok) return { ok: false, base, latencyMs, error: `HTTP ${resp.status}` };
    return { ok: true, base, latencyMs, data: await resp.json() };
  } catch (err) {
    return { ok: false, base, latencyMs: Date.now() - started, error: (err && err.message) || String(err) };
  }
}

// ---------------- 发送日志（供侧边栏展示） ----------------
async function pushLog(entry) {
  const { sendLog = [] } = await chrome.storage.local.get('sendLog');
  sendLog.unshift({ ts: Date.now(), ...entry });
  await chrome.storage.local.set({ sendLog: sendLog.slice(0, 20) });
  // 通知已打开的侧边栏
  chrome.runtime.sendMessage({ type: 'SEND_EVENT', entry }).catch(() => {});
}

// ---------------- 标签页编排 ----------------
async function ensureWorkerTab(url, { active = false } = {}) {
  const { workerTabId } = await chrome.storage.local.get('workerTabId');
  if (workerTabId != null) {
    const tab = await chrome.tabs.get(workerTabId).catch(() => null);
    if (tab && tab.id != null) {
      if (!sameUrl(tab.url, url)) await chrome.tabs.update(workerTabId, { url, active });
      else if (active) await chrome.tabs.update(workerTabId, { active: true });
      if (active && tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      return workerTabId;
    }
  }
  const tab = await chrome.tabs.create({ url, active });
  await chrome.storage.local.set({ workerTabId: tab.id });
  return tab.id;
}

/** 丢弃当前工作标签页（页面异常时下次重开，避免复用坏页面）。 */
async function dropWorkerTab() {
  await chrome.storage.local.remove('workerTabId');
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const onUpd = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const finish = (val) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') finish(true);
    }).catch(() => {});
  });
}

function sendToTab(tabId, msg, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: '内容脚本响应超时' });
      }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false, error: '空响应' });
    });
  });
}

/** 定位一个可用的消息页标签页：优先已打开的消息页，其次新建/复用工作标签页。 */
async function resolveChatTab() {
  const tabs = await chrome.tabs
    .query({ url: ['https://www.zhipin.com/*', 'https://*.zhipin.com/*'] })
    .catch(() => []);
  const chat = (tabs || []).find((t) => t.id != null && isChatUrl(t.url));
  if (chat) return chat.id;
  return ensureWorkerTab(CHAT_URL, { active: false });
}

/**
 * 向消息页发送指令。若首次失败且属于通道错误（页面被导航/进入 bfcache），
 * 重新定位消息页、等待加载完成后重试一次。
 */
async function sendToChatTab(msg, timeoutMs = 60000) {
  let tabId = await resolveChatTab();
  let r = await sendToTab(tabId, msg, timeoutMs);
  if (r && r.ok) return r;
  if (r && isChannelError(r.error)) {
    await sleep(800);
    tabId = await resolveChatTab();
    await waitForTabComplete(tabId, 15000).catch(() => {});
    await sleep(800);
    r = await sendToTab(tabId, msg, timeoutMs);
  }
  return r;
}

function detailUrl(jobId) {
  return `https://www.zhipin.com/job_detail/${jobId}.html`;
}

// ---------------- 发送 ----------------
async function runSend(item, { active = false } = {}) {
  const isReply = item.send_type !== 'first_outreach';
  // 回复类必须落在消息页：job_id 可能为空，不能去拼岗位详情 URL
  const url = isReply ? CHAT_URL : (item.job_url || detailUrl(item.job_id));
  const tabId = await ensureWorkerTab(url, { active });
  await waitForTabComplete(tabId, 30000);
  await sleep(1200);

  if (!isReply) {
    const start = await sendToTab(tabId, { type: 'START_CHAT' }, 30000);
    if (!start || !start.ok) return { ok: false, error: (start && start.error) || '无法发起沟通' };
    if (start.clicked) {
      // 点击后可能发生页面跳转 / 抽屉展开
      await sleep(2500);
      await waitForTabComplete(tabId, 15000);
      await sleep(1200);
    }
    return await sendToTab(tabId, { type: 'SEND_TEXT', content: item.content }, 60000);
  }

  // 回复类：在消息页定位会话后发送（失败会自动重定位消息页并重试一次）
  return await sendToChatTab({ type: 'SEND_REPLY', content: item.content, company: item.company_name });
}

/** 取队列项并发送 + ACK。返回本次结果，供手动/定时调用。 */
async function tickOnce({ manual = false } = {}) {
  let res;
  try {
    // 主循环只取首轮外呼；回复类统一由 drainReplyQueue 处理，避免抢占同一标签页导致互相打断
    res = await api('/api/queue/next?type=first_outreach');
  } catch (err) {
    return { ok: false, stage: 'fetch', error: (err && err.message) || String(err) };
  }

  if (res.circuit_broken) {
    await stopPolling();
    await pushLog({ ok: false, error: '熔断中：' + (res.reason || ''), stage: 'circuit' });
    return { ok: false, stage: 'circuit', reason: res.reason };
  }
  if (!res.item) {
    await patrolChatWhenIdle();
    return { ok: true, stage: 'idle', reason: res.reason, waitSeconds: res.wait_seconds, quotaLeft: res.quota_left };
  }

  // 防重复：同一队列项短时间内不重发
  const { inFlight } = await chrome.storage.local.get('inFlight');
  if (inFlight && inFlight.id === res.item.id && Date.now() - inFlight.ts < INFLIGHT_TTL_MS && !manual) {
    return { ok: true, stage: 'skip-inflight' };
  }
  await chrome.storage.local.set({ inFlight: { id: res.item.id, ts: Date.now() } });

  const item = res.item;
  let outcome;
  try {
    outcome = await runSend(item, { active: manual });
  } catch (err) {
    outcome = { ok: false, error: (err && err.message) || String(err) };
  }

  const ok = !!(outcome && outcome.ok);
  const error = (outcome && outcome.error) || '';

  // 登录/验证码类页面异常：丢弃工作标签页，下次重开干净页面
  if (!ok && /登录|验证码/.test(error)) await dropWorkerTab();

  let ack = {};
  try {
    ack = await api(`/api/queue/${item.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({ ok, error: ok ? null : error }),
    });
  } catch (err) {
    ack = { ack_error: (err && err.message) || String(err) };
  }

  await chrome.storage.local.set({ inFlight: null });
  await pushLog({
    ok,
    queueId: item.id,
    company: item.company_name,
    title: item.job_title,
    type: item.send_type,
    error: ok ? '' : error,
    circuit: ack.circuit_broken,
  });

  return { ok, stage: 'sent-attempt', item, error, circuitBroken: ack.circuit_broken };
}

// ---------------- HR 回复处理 ----------------
async function replyEnabled() {
  const { autoReply } = await chrome.storage.local.get('autoReply');
  return !!autoReply;
}

/** 处理 content script 上报的 HR 新消息。 */
async function handleInbound(msg, tabId) {
  const company = String(msg.company || '').trim();
  const content = String(msg.content || '').trim();
  const jobTitle = String(msg.jobTitle || '').trim();
  if (!company || !content) return { ok: false, error: '缺少 company/content' };

  // 未开启自动应答：只在日志里提示，不做任何后端动作（便于校准选择器）
  if (!(await replyEnabled())) {
    await pushLog({ ok: true, stage: 'inbound-detected', company, text: content.slice(0, 40), error: '' });
    return { ok: true, detected: true, autoReply: false };
  }

  const key = company + '|' + content;
  const { seenInbound = [] } = await chrome.storage.local.get('seenInbound');
  if (seenInbound.includes(key)) return { ok: true, skipped: true };
  await chrome.storage.local.set({ seenInbound: [key, ...seenInbound].slice(0, 200) });

  let out;
  try {
    out = await api('/api/reply/inbound', {
      method: 'POST',
      body: JSON.stringify({ company, content, job_title: jobTitle || null }),
    });
  } catch (err) {
    const e = (err && err.message) || String(err);
    await pushLog({ ok: false, stage: 'inbound', company, error: e });
    return { ok: false, error: e };
  }

  const d = out.decision || {};
  await pushLog({
    ok: true, stage: 'inbound', company,
    text: content.slice(0, 40), action: d.action,
    error: d.action === 'manual_interview' ? '需人工介入'
      : (d.action === 'decline' ? '岗位不符，已礼貌回绝' : ''),
  });

  // 1) 面试相关 → 只提醒，绝不自动回复
  if (d.action === 'manual_interview') {
    await chrome.storage.local.set({ pendingInterview: { company, ts: Date.now() } });
    return { ok: true, action: d.action };
  }

  // 2) 要简历 → 自动发送简历
  if (d.action === 'request_resume') {
    const r = await sendToChatTab({ type: 'SEND_RESUME', company });
    if (r && r.ok) {
      try { await api('/api/resume/sent', { method: 'POST', body: JSON.stringify({ company }) }); } catch { /* 忽略 */ }
      await pushLog({ ok: true, stage: 'resume', company, error: '' });
    } else {
      await pushLog({ ok: false, stage: 'resume', company, error: (r && r.error) || '发送简历失败' });
    }
  }

  // 3) 应答 / 简历附言 / 礼貌回绝 → 把后端生成好的回复发出去
  if (d.action === 'reply' || d.action === 'request_resume' || d.action === 'decline') {
    await drainReplyQueue();
  }

  // 4) 会话结束（含「已回绝过不再应答」）→ 不发消息，标记该会话无需应答，避免巡查停在此处
  if (d.action === 'close') {
    await markNoReply(company);
  }
  return { ok: true, action: d.action };
}

/** 标记某公司会话无需再应答：持久化并通知内容脚本，巡查时跳过。 */
async function markNoReply(company) {
  try {
    const { noReplyCompanies = [] } = await chrome.storage.local.get('noReplyCompanies');
    if (!noReplyCompanies.includes(company)) {
      await chrome.storage.local.set({
        noReplyCompanies: [company, ...noReplyCompanies].slice(0, 300),
      });
    }
  } catch { /* 忽略 */ }
  try { await sendToChatTab({ type: 'MARK_NO_REPLY', company }); } catch { /* 忽略 */ }
}

/** 逐条发出后端已生成好的回复（不计入每日 8 条，也不占首轮限速）。 */
async function drainReplyQueue() {
  for (let i = 0; i < 3; i++) {
    let res;
    try { res = await api('/api/queue/next?type=reply'); } catch { return; }
    if (!res.item) return;
    const item = res.item;
    const r = await sendToChatTab({ type: 'SEND_REPLY', content: item.content, company: item.company_name });
    const ok = !!(r && r.ok);
    try {
      await api(`/api/queue/${item.id}/ack`, {
        method: 'POST',
        body: JSON.stringify({ ok, error: ok ? null : ((r && r.error) || '') }),
      });
    } catch { /* 忽略 */ }
    await pushLog({
      ok, stage: 'reply-send', company: item.company_name,
      text: (item.content || '').slice(0, 40), error: ok ? '' : ((r && r.error) || ''),
    });
    if (!ok) return;
    await sleep(1500);
  }
}

// ---------------- 轮询控制 ----------------
/** 队列空闲时把工作标签页停在消息页，让 boss_chat.js 能监听到 HR 主动来聊。 */
async function patrolChatWhenIdle() {
  if (!(await replyEnabled())) return;
  try {
    const { workerTabId } = await chrome.storage.local.get('workerTabId');
    if (workerTabId != null) {
      const tab = await chrome.tabs.get(workerTabId).catch(() => null);
      if (tab && /\/web\/geek\/chat/.test(tab.url || '')) return; // 已在消息页，无需重复导航
    }
    await ensureWorkerTab(CHAT_URL, { active: false });
  } catch {
    /* 忽略 */
  }
}

async function isPolling() {
  const { polling } = await chrome.storage.local.get('polling');
  return !!polling;
}

async function startPolling() {
  // 新一轮轮询：清空跨会话去重，避免上一轮测试过的消息被永久跳过
  await chrome.storage.local.set({ polling: true, seenInbound: [] });
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
  await pushLog({ ok: true, stage: 'poll-start', error: '' });
  tickOnce().catch(() => {}); // 立即触发一次
}

async function stopPolling() {
  await chrome.storage.local.set({ polling: false });
  await chrome.alarms.clear(POLL_ALARM);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  if (!(await isPolling())) return;
  const { sendingNow } = await chrome.storage.local.get('sendingNow');
  if (sendingNow) return; // 上一次仍在进行
  await chrome.storage.local.set({ sendingNow: true });
  try {
    await tickOnce();
  } finally {
    await chrome.storage.local.set({ sendingNow: false });
  }
});

// ---------------- 生命周期 ----------------
chrome.runtime.onInstalled.addListener(async () => {
  const { apiBase } = await chrome.storage.local.get('apiBase');
  if (!apiBase) await chrome.storage.local.set({ apiBase: DEFAULT_API_BASE });
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[BOSS Agent] setPanelBehavior 失败:', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (await isPolling()) {
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
  }
});

// ---------------- 消息路由 ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'HEALTH_CHECK':
        sendResponse(await healthCheck());
        break;
      case 'GET_API_BASE':
        sendResponse({ ok: true, apiBase: await getApiBase() });
        break;
      case 'SET_API_BASE': {
        const next = String(msg.apiBase || '').replace(/\/+$/, '');
        if (!/^https?:\/\//.test(next)) {
          sendResponse({ ok: false, error: '地址需以 http:// 或 https:// 开头' });
          break;
        }
        await chrome.storage.local.set({ apiBase: next });
        sendResponse({ ok: true, apiBase: next });
        break;
      }
      case 'START_POLLING':
        await startPolling();
        sendResponse({ ok: true, polling: true });
        break;
      case 'STOP_POLLING':
        await stopPolling();
        sendResponse({ ok: true, polling: false });
        break;
      case 'GET_SEND_STATE': {
        const st = await chrome.storage.local.get(['polling', 'sendLog', 'inFlight', 'workerTabId', 'autoReply', 'pendingInterview']);
        sendResponse({
          ok: true,
          polling: !!st.polling,
          sendLog: st.sendLog || [],
          inFlight: st.inFlight || null,
          workerTabId: st.workerTabId != null ? st.workerTabId : null,
          autoReply: !!st.autoReply,
          pendingInterview: st.pendingInterview || null,
        });
        break;
      }
      case 'SET_AUTO_REPLY': {
        await chrome.storage.local.set({ autoReply: !!msg.enabled });
        sendResponse({ ok: true, autoReply: !!msg.enabled });
        break;
      }
      case 'CLEAR_INTERVIEW': {
        await chrome.storage.local.remove('pendingInterview');
        sendResponse({ ok: true });
        break;
      }
      case 'INBOUND_DETECTED':
        sendResponse(await handleInbound(msg, sender.tab ? sender.tab.id : null));
        break;
      case 'SWEEP_STEP':
        await pushLog({ ok: true, stage: 'sweep', text: String(msg.text || '').slice(0, 40), error: '' });
        sendResponse({ ok: true });
        break;
      case 'SEND_NOW': {
        const { sendingNow } = await chrome.storage.local.get('sendingNow');
        if (sendingNow) {
          sendResponse({ ok: false, error: '已有发送任务进行中' });
          break;
        }
        await chrome.storage.local.set({ sendingNow: true });
        try {
          sendResponse(await tickOnce({ manual: true }));
        } finally {
          await chrome.storage.local.set({ sendingNow: false });
        }
        break;
      }
      case 'PING':
        sendResponse({ ok: true, ts: Date.now() });
        break;
      default:
        sendResponse({ ok: false, error: '未知消息类型: ' + (msg && msg.type) });
    }
  })();
  return true;
});