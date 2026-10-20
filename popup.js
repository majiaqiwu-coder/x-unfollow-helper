const DEFAULTS = {
  mode: 'limited',
  hourlyLimit: 10,
  dailyLimit: 40,
  graceDays: 3,
  maxScrolls: 120,
  baseDelay: 30,
  extraDelay: 15,
  backgroundRun: true,
  workflow: 'stream',
};

const RESULT_KEY = 'x-unfollow-last-result';
const SETTINGS_KEY = 'x-unfollow-settings';
const PROTECTED_KEY = 'x-unfollow-protected';
const HISTORY_KEY = 'x-unfollow-history';

const els = {
  openX: document.getElementById('openX'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  todayDone: document.getElementById('todayDone'),
  nonFollowerCount: document.getElementById('nonFollowerCount'),
  nextRun: document.getElementById('nextRun'),
  scanTime: document.getElementById('scanTime'),
  handle: document.getElementById('handle'),
  limitedMode: document.getElementById('limitedMode'),
  unlimitedMode: document.getElementById('unlimitedMode'),
  previewWorkflow: document.getElementById('previewWorkflow'),
  streamWorkflow: document.getElementById('streamWorkflow'),
  hourlyLimit: document.getElementById('hourlyLimit'),
  dailyLimit: document.getElementById('dailyLimit'),
  graceDays: document.getElementById('graceDays'),
  maxScrolls: document.getElementById('maxScrolls'),
  baseDelay: document.getElementById('baseDelay'),
  extraDelay: document.getElementById('extraDelay'),
  backgroundRun: document.getElementById('backgroundRun'),
  backgroundHint: document.getElementById('backgroundHint'),
  riskPanel: document.getElementById('riskPanel'),
  riskConfirm: document.getElementById('riskConfirm'),
  scanButton: document.getElementById('scanButton'),
  unfollowButton: document.getElementById('unfollowButton'),
  stopButton: document.getElementById('stopButton'),
  pauseButton: document.getElementById('pauseButton'),
  resultPanel: document.getElementById('resultPanel'),
  resultCount: document.getElementById('resultCount'),
  resultList: document.getElementById('resultList'),
  pendingTab: document.getElementById('pendingTab'),
  protectedTab: document.getElementById('protectedTab'),
  resultSearch: document.getElementById('resultSearch'),
  previousPage: document.getElementById('previousPage'),
  nextPage: document.getElementById('nextPage'),
  pageInfo: document.getElementById('pageInfo'),
  footerNote: document.getElementById('footerNote'),
  recommendedDefaults: document.getElementById('recommendedDefaults'),
  historyList: document.getElementById('historyList'),
  exportDiagnostics: document.getElementById('exportDiagnostics'),
};

let busy = false;
let mode = 'limited';
let workflow = 'preview';
let hasSavedResult = false;
let resultHandles = [];
let protectedHandles = [];
let resultView = 'pending';
let resultPage = 1;
const PAGE_SIZE = 20;
let lastStatus = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(500);
  }
  throw new Error('X 页面尚未加载完成，请等待页面加载后重试。');
}

function formatTime(timestamp) {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function findOrCreateXTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://x.com/*', 'https://twitter.com/*'],
  });
  if (tabs.length) return tabs.find((tab) => tab.active) || tabs[0];
  return chrome.tabs.create({ url: 'https://x.com/home', active: true });
}

async function findRunningXTab() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    try {
      const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      if (status && ['scan', 'unfollow', 'waiting', 'paused', 'stopping'].includes(status.phase)) return tab;
    } catch (_) {
      // Try the next X tab.
    }
  }
  return tabs.find((tab) => tab.active) || tabs[0] || null;
}

async function sendWithRetry(tabId, message) {
  if (message.type !== 'GET_STATUS') return chrome.tabs.sendMessage(tabId, message);
  let lastError = null;
  for (let i = 0; i < 10; i += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response) return response;
    } catch (error) {
      lastError = error;
    }
    await sleep(600);
  }
  throw lastError || new Error('无法连接到 X 页面。');
}

const connections = new Map();

async function connectToX(tabId) {
  if (connections.has(tabId)) return connections.get(tabId);
  const connection = (async () => {
    await waitForTabComplete(tabId);
    try {
      const status = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
      if (status) return status;
    } catch (error) {
      if (!/Receiving end does not exist|Could not establish connection/i.test(error.message || '')) {
        throw error;
      }
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      return await sendWithRetry(tabId, { type: 'GET_STATUS' });
    } catch (_) {
      throw new Error('无法连接 X 页面。请允许扩展访问 x.com，刷新 X 后重试。');
    }
  })();
  connections.set(tabId, connection);
  try {
    return await connection;
  } finally {
    connections.delete(tabId);
  }
}

async function ensureXTabAndSend(message) {
  const tab = await findOrCreateXTab();
  if (!message.config?.backgroundRun) await chrome.tabs.update(tab.id, { active: true });
  await connectToX(tab.id);
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (_) {
    throw new Error('发送时页面连接中断，启动结果未确认。请重新打开插件查看状态，勿连续点击。');
  }
}

function setBusy(next) {
  busy = next;
  els.scanButton.disabled = next;
  els.unfollowButton.disabled = next || (mode === 'unlimited' && !els.riskConfirm.checked);
  els.stopButton.disabled = !next;
}

function setMode(next) {
  mode = next;
  els.limitedMode.classList.toggle('active', next === 'limited');
  els.unlimitedMode.classList.toggle('active', next === 'unlimited');
  els.limitedMode.setAttribute('aria-checked', String(next === 'limited'));
  els.unlimitedMode.setAttribute('aria-checked', String(next === 'unlimited'));
  els.riskPanel.hidden = next !== 'unlimited';
  updateActionLabels();
  els.hourlyLimit.disabled = next === 'unlimited';
  els.dailyLimit.disabled = next === 'unlimited';
  setBusy(busy);
}

function setWorkflow(next) {
  workflow = next === 'stream' ? 'stream' : 'preview';
  els.previewWorkflow.classList.toggle('active', workflow === 'preview');
  els.streamWorkflow.classList.toggle('active', workflow === 'stream');
  els.previewWorkflow.setAttribute('aria-checked', String(workflow === 'preview'));
  els.streamWorkflow.setAttribute('aria-checked', String(workflow === 'stream'));
  els.unfollowButton.hidden = workflow === 'stream';
  updateActionLabels();
  renderResultList();
}

function updateActionLabels() {
  if (workflow === 'stream') {
    els.scanButton.textContent = mode === 'unlimited' ? '开始连续边扫边清理' : '开始限量边扫边清理';
    els.scanButton.title = '读取关注列表时实时复核并处理未回关账号';
    els.footerNote.textContent = '边扫模式会保存已检查账号；发现未回关后按所选速度处理，点击停止可随时结束。';
  } else {
    els.scanButton.textContent = hasSavedResult ? '更新名单' : '扫描未回关';
    els.scanButton.title = hasSavedResult ? '重新扫描并更新本机名单' : '';
    els.unfollowButton.textContent = mode === 'unlimited' ? '开始一次性取关' : '开始限量取关';
    els.footerNote.textContent = '名单保存在本机，可直接继续使用；需要获取最新关系时点“更新名单”。';
  }
}

function setDot(state) {
  els.statusDot.className = `status-dot ${state || ''}`.trim();
}

function renderStatus(status) {
  if (!status) return;
  lastStatus = status;
  const taskActive = ['scan', 'unfollow', 'waiting', 'stopping', 'paused'].includes(status.phase);
  setBusy(taskActive);
  els.pauseButton.disabled = !taskActive || status.phase === 'stopping';
  els.pauseButton.textContent = status.phase === 'paused' ? '继续' : '暂停';
  els.stopButton.disabled = !taskActive;

  els.statusText.textContent = status.status || '未运行';
  els.todayDone.textContent = String(status.todayDone ?? 0);
  els.nextRun.textContent = status.nextRunAt ? formatTime(status.nextRunAt) : '-';

  if (status.lastResult) {
    hasSavedResult = true;
    els.nonFollowerCount.textContent = String(status.lastResult.nonFollowers?.length ?? 0);
    els.scanTime.textContent = formatTime(status.lastResult.scannedAt);
    resultHandles = status.lastResult.nonFollowers || [];
    renderResultList();
  } else {
    hasSavedResult = false;
    els.nonFollowerCount.textContent = '0';
    els.scanTime.textContent = '-';
    resultHandles = [];
    renderResultList();
  }
  updateActionLabels();

  if (!els.handle.value && status.ownHandle) {
    els.handle.value = status.ownHandle;
  }

  if (status.phase === 'scan' || status.phase === 'unfollow') {
    setDot('running');
  } else if (status.phase === 'waiting') {
    setDot('running');
    setBusy(true);
  } else if (status.phase === 'paused') {
    setDot('');
  } else if (status.phase === 'idle' && status.status?.includes('完成')) {
    setDot('done');
  } else if (status.status?.includes('失败')) {
    setDot('error');
  } else {
    setDot('');
  }
}

function renderResultList() {
  els.resultPanel.hidden = workflow === 'stream' || (resultHandles.length === 0 && protectedHandles.length === 0);
  const source = resultView === 'protected' ? protectedHandles : resultHandles;
  const query = els.resultSearch.value.trim().replace(/^@/, '').toLowerCase();
  const filtered = query ? source.filter((handle) => handle.toLowerCase().includes(query)) : source;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  resultPage = Math.min(resultPage, pageCount);
  const shown = filtered.slice((resultPage - 1) * PAGE_SIZE, resultPage * PAGE_SIZE);

  els.pendingTab.classList.toggle('active', resultView === 'pending');
  els.protectedTab.classList.toggle('active', resultView === 'protected');
  els.pendingTab.textContent = `待处理 ${resultHandles.length}`;
  els.protectedTab.textContent = `已保留 ${protectedHandles.length}`;
  els.resultCount.textContent = `${filtered.length} 人`;
  els.pageInfo.textContent = `${resultPage} / ${pageCount}`;
  els.previousPage.disabled = resultPage <= 1;
  els.nextPage.disabled = resultPage >= pageCount;

  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-result';
    empty.textContent = query ? '没有匹配的用户名' : '暂无账号';
    els.resultList.replaceChildren(empty);
    return;
  }

  els.resultList.replaceChildren(...shown.map((handle) => {
    const row = document.createElement('div');
    row.className = 'result-row';
    const link = document.createElement('a');
    link.href = `https://x.com/${encodeURIComponent(handle)}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `@${handle}`;
    const action = document.createElement('button');
    action.type = 'button';
    action.dataset.handle = handle;
    action.textContent = resultView === 'protected' ? '移回待处理' : '保留';
    row.append(link, action);
    return row;
  }));
}

async function refreshStatus() {
  const protection = await chrome.storage.local.get([PROTECTED_KEY, HISTORY_KEY]);
  protectedHandles = Array.isArray(protection[PROTECTED_KEY]) ? protection[PROTECTED_KEY] : [];
  renderHistory(protection[HISTORY_KEY] || []);
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://x.com/*', 'https://twitter.com/*'],
    });
    if (!tabs.length) {
      const stored = await chrome.storage.local.get(RESULT_KEY);
      renderStatus({ lastResult: stored[RESULT_KEY] || null, todayDone: 0 });
      return;
    }
    const activeTab = tabs.find((tab) => tab.active) || tabs[0];
    const status = await connectToX(activeTab.id);
    renderStatus(status);
  } catch (error) {
    const stored = await chrome.storage.local.get(RESULT_KEY);
    renderStatus({ status: `连接失败：${error.message}`, lastResult: stored[RESULT_KEY] || null, todayDone: 0 });
  }
}

function currentSettings() {
  return {
    handle: els.handle.value.trim(),
    mode,
    hourlyLimit: Number(els.hourlyLimit.value),
    dailyLimit: Number(els.dailyLimit.value),
    graceDays: Number(els.graceDays.value),
    maxScrolls: Number(els.maxScrolls.value),
    baseDelay: Number(els.baseDelay.value),
    extraDelay: Number(els.extraDelay.value),
    backgroundRun: els.backgroundRun.checked,
    workflow,
  };
}

async function persistSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings() });
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) };
  mode = settings.mode === 'unlimited' ? 'unlimited' : 'limited';
  workflow = settings.workflow === 'stream' ? 'stream' : 'preview';
  els.hourlyLimit.value = settings.hourlyLimit;
  els.dailyLimit.value = settings.dailyLimit;
  els.graceDays.value = settings.graceDays;
  els.maxScrolls.value = settings.maxScrolls;
  els.baseDelay.value = settings.baseDelay;
  els.extraDelay.value = settings.extraDelay;
  els.backgroundRun.checked = settings.backgroundRun !== false;
  updateBackgroundHint();
  setWorkflow(workflow);
  setMode(mode);
}

function updateBackgroundHint() {
  els.backgroundHint.textContent = els.backgroundRun.checked
    ? '切换到其他标签页后继续，并由 Chrome 唤醒下一轮'
    : '启动时切到 X；关闭弹窗后继续，但需保持 X 页面活跃';
}

async function runCommand(message) {
  if (busy) return;
  if ((message.type === 'START_UNFOLLOW' || message.type === 'START_STREAM_CLEAN') && mode === 'unlimited' && !els.riskConfirm.checked) {
    els.statusText.textContent = '请先勾选不限制模式的风险确认。';
    setDot('error');
    return;
  }

  setBusy(true);
  els.statusText.textContent = message.type === 'START_SCAN' ? '正在准备扫描...' : '正在准备处理...';
  setDot('running');

  try {
    const response = await ensureXTabAndSend(message);
    if (!response?.ok) {
      throw new Error(response?.error || '操作未启动。');
    }
  } catch (error) {
    setBusy(false);
    setDot('error');
    els.statusText.textContent = `操作失败：${error.message}`;
  }
}

els.openX.addEventListener('click', async () => {
  const tab = await findOrCreateXTab();
  await chrome.tabs.update(tab.id, { active: true });
  window.close();
});

els.limitedMode.addEventListener('click', () => {
  setMode('limited');
  persistSettings();
});

els.unlimitedMode.addEventListener('click', () => {
  setMode('unlimited');
  persistSettings();
});

els.previewWorkflow.addEventListener('click', () => { setWorkflow('preview'); persistSettings(); });
els.streamWorkflow.addEventListener('click', () => { setWorkflow('stream'); persistSettings(); });

els.riskConfirm.addEventListener('change', () => setBusy(busy));

els.scanButton.addEventListener('click', () => {
  persistSettings();
  runCommand({ type: workflow === 'stream' ? 'START_STREAM_CLEAN' : 'START_SCAN', config: currentSettings() });
});

els.unfollowButton.addEventListener('click', () => {
  persistSettings();
  runCommand({ type: 'START_UNFOLLOW', config: currentSettings() });
});

els.pauseButton.addEventListener('click', async () => {
  try {
    const tab = await findRunningXTab();
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { type: lastStatus?.phase === 'paused' ? 'RESUME' : 'PAUSE' });
    await refreshStatus();
  } catch (error) {
    els.statusText.textContent = `操作失败：${error.message}`;
  }
});

els.stopButton.addEventListener('click', async () => {
  try {
    const tab = await findRunningXTab();
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'STOP' });
  } catch (_) {
    els.statusText.textContent = '未能确认停止，请关闭执行任务的 X 标签页。';
    return;
  }
  await refreshStatus();
});

['hourlyLimit', 'dailyLimit', 'graceDays', 'maxScrolls', 'baseDelay', 'extraDelay', 'handle'].forEach((key) => {
  els[key].addEventListener('change', persistSettings);
});

els.recommendedDefaults.addEventListener('click', () => {
  setMode('limited');
  els.hourlyLimit.value = 10;
  els.dailyLimit.value = 40;
  els.graceDays.value = 3;
  els.baseDelay.value = 30;
  els.extraDelay.value = 15;
  persistSettings();
  els.statusText.textContent = '已应用推荐值：每小时 10 次、24 小时 40 次、间隔 30–45 秒';
  setDot('');
});

function renderHistory(items) {
  const shown = items.slice(-20).reverse();
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-result';
    empty.textContent = '暂无任务记录';
    els.historyList.replaceChildren(empty);
    return;
  }
  els.historyList.replaceChildren(...shown.map((item) => {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.textContent = `${formatTime(item.at)} · ${item.summary}`;
    return row;
  }));
}

els.exportDiagnostics.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, HISTORY_KEY]);
  const payload = {
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    status: lastStatus ? { phase: lastStatus.phase, status: lastStatus.status, progress: lastStatus.progress } : null,
    settings: stored[SETTINGS_KEY] || null,
    history: stored[HISTORY_KEY] || [],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `x-unfollow-diagnostics-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

els.backgroundRun.addEventListener('change', () => {
  updateBackgroundHint();
  persistSettings();
});

els.pendingTab.addEventListener('click', () => { resultView = 'pending'; resultPage = 1; renderResultList(); });
els.protectedTab.addEventListener('click', () => { resultView = 'protected'; resultPage = 1; renderResultList(); });
els.resultSearch.addEventListener('input', () => { resultPage = 1; renderResultList(); });
els.previousPage.addEventListener('click', () => { resultPage = Math.max(1, resultPage - 1); renderResultList(); });
els.nextPage.addEventListener('click', () => { resultPage += 1; renderResultList(); });

els.resultList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-handle]');
  if (!button) return;
  const handle = button.dataset.handle;
  const stored = await chrome.storage.local.get([RESULT_KEY, PROTECTED_KEY]);
  const result = stored[RESULT_KEY];
  const protectedSet = new Set(stored[PROTECTED_KEY] || []);

  if (resultView === 'pending') {
    protectedSet.add(handle);
    resultHandles = resultHandles.filter((item) => item !== handle);
    if (result?.nonFollowers) {
      await chrome.storage.local.set({
        [RESULT_KEY]: { ...result, nonFollowers: result.nonFollowers.filter((item) => item !== handle) },
      });
    }
  } else {
    protectedSet.delete(handle);
    if (result?.nonFollowers && !result.nonFollowers.includes(handle)) {
      resultHandles = [...resultHandles, handle];
      await chrome.storage.local.set({
        [RESULT_KEY]: { ...result, nonFollowers: [...result.nonFollowers, handle] },
      });
    }
  }

  protectedHandles = Array.from(protectedSet).sort();
  await chrome.storage.local.set({ [PROTECTED_KEY]: protectedHandles });
  resultPage = 1;
  renderResultList();
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.status) refreshStatus();
  if (message.type === 'SCAN_COMPLETE' || message.type === 'UNFOLLOW_COMPLETE') {
    setBusy(false);
    refreshStatus();
  }
  if (message.type === 'STOPPED' || message.type === 'ERROR') {
    setBusy(false);
    refreshStatus();
  }
  if (message.type === 'WAITING_NEXT_BATCH') {
    setBusy(true);
    refreshStatus();
  }
});

loadSettings().then(refreshStatus);
setInterval(refreshStatus, 3000);
