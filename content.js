(() => {
  const bridgeKey = '__xUnfollowBridge';
  if (globalThis[bridgeKey]?.isAlive()) return;
  globalThis[bridgeKey] = {
    isAlive() {
      try {
        return Boolean(chrome.runtime.getManifest().version);
      } catch (_) {
        return false;
      }
    },
  };
  const TASK_KEY = 'x-unfollow-task';
  const OWNER_KEY = 'x-unfollow-owner';
  const RESULT_KEY = 'x-unfollow-last-result';
  const SETTINGS_KEY = 'x-unfollow-settings';
  const PROTECTED_KEY = 'x-unfollow-protected';
  const HISTORY_KEY = 'x-unfollow-history';
  const FOLLOW_LEDGER_KEY = 'x-unfollow-follow-ledger';

  const runtime = {
    phase: 'idle',
    status: '未运行',
    progress: null,
    stopRequested: false,
    pauseRequested: false,
    mode: 'limited',
    nextRunAt: null,
    scanSnapshot: null,
  };

  let limitedTimer = null;
  let taskCache = null;
  let taskHydrated = false;
  let taskWriteQueue = Promise.resolve();

  function pageOwnerId() {
    let id = sessionStorage.getItem(OWNER_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(OWNER_KEY, id);
    }
    return id;
  }

  function localDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatLocalTime(timestamp) {
    const d = new Date(timestamp);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  function todayKey() {
    return `x-unfollow-done-${localDate()}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitter(baseMs, extraMs = 0) {
    return Math.round(baseMs + Math.random() * extraMs);
  }

  function checkStop() {
    if (runtime.stopRequested) {
      const error = new Error('USER_STOPPED');
      error.code = 'USER_STOPPED';
      throw error;
    }
    if (runtime.pauseRequested) {
      const error = new Error('TASK_PAUSED');
      error.code = 'TASK_PAUSED';
      throw error;
    }
  }

  async function recordHistory(summary, details = {}) {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
    history.push({ at: Date.now(), summary, ...details });
    await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(-100) });
  }

  function cancelLimitedTimer() {
    if (limitedTimer) {
      clearTimeout(limitedTimer);
      limitedTimer = null;
    }
    chrome.runtime.sendMessage({ type: 'CANCEL_WAKEUP' }).catch(() => {});
  }

  function setStatus(status) {
    runtime.status = status;
    notifyPopup({ type: 'STATUS_CHANGED', status: getStatusSnapshot() });
  }

  function notifyPopup(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (_) {
      // Popup may be closed; task keeps running in this tab.
    }
  }

  function getStatusSnapshot() {
    return {
      phase: runtime.phase,
      status: runtime.status,
      progress: runtime.progress,
      ownHandle: getOwnHandle(),
      mode: runtime.mode,
      nextRunAt: runtime.nextRunAt,
    };
  }

  function readTask() {
    return taskCache;
  }

  async function hydrateTask() {
    if (taskHydrated) return taskCache;
    taskHydrated = true;
    const stored = await chrome.storage.local.get(TASK_KEY);
    taskCache = stored[TASK_KEY] || null;
    if (taskCache) sessionStorage.setItem(TASK_KEY, JSON.stringify(taskCache));
    else sessionStorage.removeItem(TASK_KEY);
    return taskCache;
  }

  function writeTask(task) {
    taskCache = task;
    taskHydrated = true;
    sessionStorage.setItem(TASK_KEY, JSON.stringify(task));
    taskWriteQueue = taskWriteQueue.then(() => chrome.storage.local.set({ [TASK_KEY]: task })).catch(() => {});
  }

  function clearTask() {
    taskCache = null;
    taskHydrated = true;
    sessionStorage.removeItem(TASK_KEY);
    taskWriteQueue = taskWriteQueue.then(() => chrome.storage.local.remove(TASK_KEY)).catch(() => {});
  }

  function normalizeHandle(value) {
    return String(value || '')
      .trim()
      .replace(/^@/, '')
      .split('?')[0]
      .toLowerCase();
  }

  function currentPath() {
    return new URL(location.href).pathname;
  }

  function getOwnHandle() {
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (switcher) {
      const handles = new Set();
      for (const node of [switcher, ...switcher.querySelectorAll('span, [dir], [aria-label]')]) {
        for (const value of [node.textContent, node.getAttribute('aria-label')]) {
          const text = String(value || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
          const match = text.match(/^@([a-z0-9_]{1,15})$/i);
          if (match) handles.add(normalizeHandle(match[1]));
        }
      }
      if (handles.size === 1) return [...handles][0];
      if (handles.size > 1) return '';
    }
    const profileLink =
      document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') ||
      document.querySelector('nav a[aria-label="Profile"]') ||
      document.querySelector('nav a[aria-label="个人资料"]');
    if (profileLink) {
      const match = profileLink
        .getAttribute('href')
        .match(/^\/([a-z0-9_]{1,15})\/?$/i);
      if (match) return normalizeHandle(match[1]);
    }

    return '';
  }

  function assertAccount(handle) {
    const own = getOwnHandle();
    if (!own) throw new Error('侧栏登录账号尚未识别，请等待 X 加载完成后重试。');
    if (!handle || own !== handle) throw new Error(`当前登录 @${own}，任务账号 @${handle || '未知'}，已停止以避免操作错误账号。`);
  }

  async function waitForAccount() {
    for (let i = 0; i < 30; i += 1) {
      checkStop();
      const handle = getOwnHandle();
      if (handle) return handle;
      await sleep(500);
    }
    assertAccount('');
  }

  function exactCount(handle, suffix) {
    const paths = suffix === 'followers' ? ['followers', 'verified_followers'] : [suffix];
    const links = Array.from(document.querySelectorAll('main a[href]')).filter((link) => {
      const path = new URL(link.href, location.origin).pathname.replace(/\/$/, '').toLowerCase();
      return paths.some((part) => path === `/${handle}/${part}`);
    });
    const label = suffix === 'following' ? '正在关注' : '粉丝';
    if (!links.length) throw new Error(`尚未找到“${label}”人数链接，请确认自己的个人主页已加载。`);
    const candidates = [];
    for (const link of links) {
      for (const node of [link, ...link.querySelectorAll('[title], [aria-label]')]) {
        candidates.push(node.getAttribute('title'), node.getAttribute('aria-label'));
      }
      candidates.push(link.textContent);
    }
    for (const candidate of candidates) {
      const text = String(candidate || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
      // Abbreviations cannot establish an exact list size.
      if (/\d[\d.,\s]*[kmb万亿千]/i.test(text) || /\d\.\d/.test(text)) continue;
      const numbers = text.match(/\d(?:[\d,，\u00a0\u202f ]*\d)?/g);
      if (numbers?.length !== 1) continue;
      const count = Number(numbers[0].replace(/[,，\s]/g, ''));
      if (Number.isSafeInteger(count) && count >= 0) return count;
    }
    throw new Error(`“${label}”人数只有缩写或格式无法识别，不能确认完整名单。请提供个人主页人数区域截图。`);
  }

  async function waitForProfileCounts(handle) {
    let lastError;
    for (let i = 0; i < 30; i += 1) {
      checkStop();
      try {
        return { following: exactCount(handle, 'following'), followers: exactCount(handle, 'followers') };
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw lastError;
  }

  function isReservedPath(handle) {
    return new Set([
      'home',
      'explore',
      'notifications',
      'messages',
      'bookmarks',
      'settings',
      'search',
      'i',
      'intent',
      'compose',
      'tos',
      'privacy',
      'jobs',
      'about',
    ]).has(handle);
  }

  function linkHandle(link) {
    const url = new URL(link.href, location.origin);
    const match = url.pathname.match(/^\/([^/?#]+)\/?$/);
    if (!match) return '';
    const handle = normalizeHandle(match[1]);
    return isReservedPath(handle) ? '' : handle;
  }

  function userCells() {
    return Array.from(document.querySelectorAll('main [data-testid="UserCell"]'));
  }

  function extractHandles(target = new Map(), includeRelationship = false) {
    for (const cell of userCells()) {
      const handle = handleFromCell(cell);
      if (!handle) continue;
      if (includeRelationship) {
        const followsYou = Boolean(cell.querySelector('[data-testid="userFollowIndicator"]'));
        target.set(handle, Boolean(target.get(handle)) || followsYou);
      } else {
        target.set(handle, true);
      }
    }
    return target;
  }

  function handleFromCell(cell) {
    const links = Array.from(
      cell.querySelectorAll('a[href^="/"][role="link"], a[href^="/"][tabindex="-1"]'),
    );
    for (const link of links) {
      const handle = linkHandle(link);
      if (handle) return handle;
    }
    return '';
  }

  function cellFollowsYou(cell) {
    if (cell.querySelector('[data-testid="userFollowIndicator"]')) return true;
    return /\bfollows you\b|关注了你/i.test(cell.textContent || '');
  }

  async function waitForUserList(timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      checkStop();
      if (userCells().length) return true;
      await sleep(500);
    }
    throw new Error('未能在页面中找到用户列表，请确认账号已登录且页面已加载。');
  }

  function navigateAway(path) {
    if (currentPath() !== path) {
      location.assign(`https://x.com${path}`);
      return true;
    }
    return false;
  }

  async function collectUserSet(maxScrolls = 80, expected, includeRelationship = false) {
    if (expected === 0) return [];
    await waitForUserList();
    const users = new Map();
    const effectiveMaxScrolls = Math.min(3000, Math.max(maxScrolls, Math.ceil(expected / 3) + 50));
    let lastSize = 0;
    let lastGrowthAt = Date.now();
    let stalled = false;

    function listScroller() {
      let node = userCells()[0]?.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        if (node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
        node = node.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }

    listScroller().scrollTo({ top: 0, behavior: 'instant' });
    await sleep(1000);
    checkStop();

    extractHandles(users, includeRelationship);

    for (let i = 0; i < effectiveMaxScrolls; i += 1) {
      checkStop();
      extractHandles(users, includeRelationship);
      if (users.size >= expected) break;
      const scroller = listScroller();
      const distance = Math.max(200, Math.round(scroller.clientHeight * 0.7));
      scroller.scrollBy({ top: distance, behavior: 'instant' });
      await sleep(jitter(1200, 600));
      checkStop();
      extractHandles(users, includeRelationship);

      if (users.size !== lastSize) {
        lastGrowthAt = Date.now();
        lastSize = users.size;
      }
      const waiting = Date.now() - lastGrowthAt > 5000;
      const nonFollowerCount = includeRelationship
        ? Array.from(users.values()).filter((followsYou) => !followsYou).length
        : null;
      runtime.progress = {
        scanned: users.size,
        expected,
        nonFollowers: nonFollowerCount,
        scroll: i + 1,
        maxScrolls: effectiveMaxScrolls,
      };
      if (includeRelationship) {
        runtime.scanSnapshot = {
          scanned: users.size,
          expected,
          nonFollowers: Array.from(users.entries())
            .filter(([, followsYou]) => !followsYou)
            .map(([handle]) => handle),
        };
      }
      setStatus(
        `正在扫描正在关注：${users.size}/${expected} 人` +
          `${nonFollowerCount === null ? '' : `，发现未回关 ${nonFollowerCount} 人`}` +
          `（滚动 ${i + 1}/${effectiveMaxScrolls} 次）${waiting ? '，等待列表加载...' : ''}`,
      );
      if (waiting) {
        // Nudge the actual scroll container to retrigger the list loader.
        scroller.scrollBy({ top: -Math.min(200, distance), behavior: 'instant' });
        await sleep(500);
        checkStop();
        extractHandles(users, includeRelationship);
        scroller.scrollBy({ top: distance, behavior: 'instant' });
        await sleep(2000);
        checkStop();
        extractHandles(users, includeRelationship);
      }
      if (Date.now() - lastGrowthAt >= 60000 && users.size === lastSize) {
        stalled = true;
        break;
      }
    }

    extractHandles(users, includeRelationship);
    return {
      users,
      complete: users.size === expected,
      stopReason: users.size === expected ? null : stalled ? '页面连续一分钟未加载新用户' : '达到滚动次数上限',
    };
  }

  async function startScan(config) {
    runtime.stopRequested = false;
    runtime.phase = 'scan';
    runtime.nextRunAt = null;
    cancelLimitedTimer();
    const ownHandle = await waitForAccount();
    const handle = normalizeHandle(config.handle || ownHandle);
    assertAccount(handle);
    if (!handle) throw new Error('没有识别到你的 X 用户名。');

    const task = {
      type: 'scan',
      ownerId: pageOwnerId(),
      active: true,
      phase: 'profile',
      handle,
      maxScrolls: Number(config.maxScrolls || 80),
      backgroundRun: config.backgroundRun !== false,
    };
    writeTask(task);
    await continueScan(task);
  }

  async function continueScan(task) {
    try {
      await waitForAccount();
      assertAccount(task.handle);
      if (task.phase === 'profile') {
        if (navigateAway(`/${task.handle}`)) return;
        setStatus('正在读取个人主页的关注人数...');
        task.expectedFollowing = exactCount(task.handle, 'following');
        task.phase = 'following';
        writeTask(task);
      }
      if (task.phase === 'following') {
        const path = `/${task.handle}/following`;
        if (navigateAway(path)) return;
        setStatus('正在扫描你关注的人...');
        const snapshot = await collectUserSet(task.maxScrolls, task.expectedFollowing, true);
        checkStop();
        assertAccount(task.handle);
        const stored = await chrome.storage.local.get(RESULT_KEY);
        const previous = stored[RESULT_KEY];
        const protection = await chrome.storage.local.get(PROTECTED_KEY);
        const protectedSet = new Set((protection[PROTECTED_KEY] || []).map(normalizeHandle));
        const nonFollowerSet = new Set(
          previous?.handle === task.handle &&
          previous?.algorithm === 'following-indicator-v1' &&
          Array.isArray(previous.nonFollowers)
            ? previous.nonFollowers
            : [],
        );
        for (const [handle, followsYou] of snapshot.users) {
          if (followsYou) nonFollowerSet.delete(handle);
          else if (!protectedSet.has(handle)) nonFollowerSet.add(handle);
        }
        for (const handle of protectedSet) nonFollowerSet.delete(handle);
        const nonFollowers = Array.from(nonFollowerSet);

        const result = {
          verified: true,
          algorithm: 'following-indicator-v1',
          handle: task.handle,
          scannedAt: Date.now(),
          followingCount: task.expectedFollowing,
          scannedFollowingCount: snapshot.users.size,
          scanComplete: snapshot.complete,
          stopReason: snapshot.stopReason,
          nonFollowers,
        };
        await chrome.storage.local.set({ [RESULT_KEY]: result });
        clearTask();
        runtime.phase = 'idle';
        runtime.progress = {
          following: snapshot.users.size,
          expectedFollowing: task.expectedFollowing,
          nonFollowers: nonFollowers.length,
        };
        setStatus(
          snapshot.complete
            ? `完整扫描完成，未回关 ${nonFollowers.length} 人`
            : `分段扫描完成：本轮读取 ${snapshot.users.size}/${task.expectedFollowing} 人，保存未回关候选 ${nonFollowers.length} 人`,
        );
        recordHistory(`扫描 ${snapshot.users.size}/${task.expectedFollowing} 人，发现未回关 ${nonFollowers.length} 人`, { type: 'scan' });
        notifyPopup({ type: 'SCAN_COMPLETE', result });
        return;
      }

      throw new Error('未知的扫描阶段。');
    } catch (error) {
      if (error.code === 'USER_STOPPED') {
        clearTask();
        runtime.phase = 'idle';
        setStatus('已停止');
        notifyPopup({ type: 'STOPPED' });
        return;
      }
      if (error.code === 'TASK_PAUSED') {
        runtime.phase = 'paused';
        setStatus('已暂停，进度已保存');
        return;
      }
      clearTask();
      runtime.phase = 'idle';
      setStatus(`扫描失败：${error.message}`);
      notifyPopup({ type: 'ERROR', message: error.message });
    }
  }

  function findFollowingButton(cell) {
    const buttons = Array.from(cell.querySelectorAll('button'));
    return buttons.find((button) => {
      const text = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`;
      return /\bfollowing\b|正在关注|已关注/i.test(text);
    });
  }

  function findUnfollowMenu() {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    return items.find((item) => /unfollow|取消关注/i.test(item.textContent || ''));
  }

  async function tryUnfollow(cell, handle) {
    const task = readTask();
    assertAccount(task?.handle);
    const ledger = await chrome.storage.local.get(FOLLOW_LEDGER_KEY);
    const followedAt = Number(ledger[FOLLOW_LEDGER_KEY]?.[`${task?.handle}:${handle}`] || 0);
    const graceMs = Number(task?.graceDays || 0) * 24 * 60 * 60 * 1000;
    if (followedAt && graceMs > 0 && Date.now() - followedAt < graceMs) return false;
    if (cellFollowsYou(cell)) return false;
    const button = findFollowingButton(cell);
    if (!button) return false;

    button.scrollIntoView({ block: 'center' });
    await sleep(jitter(350, 350));
    checkStop();
    if (!cell.isConnected || handleFromCell(cell) !== handle) throw new Error('用户列表已变化，请重新扫描。');
    button.click();
    await sleep(jitter(500, 400));

    const menu = findUnfollowMenu();
    if (menu) {
      checkStop();
      assertAccount(task?.handle);
      menu.click();
      await sleep(jitter(500, 400));
    } else {
      const confirmButton = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (confirmButton) {
        checkStop();
        assertAccount(task?.handle);
        confirmButton.click();
        await sleep(jitter(500, 400));
      }
    }

    // X 有时会在列表里直接切换状态，没有菜单或确认框。
    await sleep(jitter(700, 500));
    const finalConfirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (finalConfirm) {
      checkStop();
      assertAccount(task?.handle);
      finalConfirm.click();
    }
    for (let i = 0; i < 12; i += 1) {
      await sleep(500);
      checkStop();
      const current = userCells().find((item) => handleFromCell(item) === handle);
      if (current?.querySelector('[data-testid$="-follow"]')) return true;
    }
    throw new Error(`无法确认 @${handle} 是否取关成功，已停止，请手动检查。`);
  }

  async function startUnfollow(config) {
    runtime.stopRequested = false;
    runtime.phase = 'unfollow';
    runtime.mode = config.mode === 'unlimited' ? 'unlimited' : 'limited';
    runtime.nextRunAt = null;
    cancelLimitedTimer();
    await waitForAccount();

    const stored = await chrome.storage.local.get(RESULT_KEY);
    const result = stored[RESULT_KEY];
    if (!result?.verified) {
      throw new Error('没有完整扫描后保存的名单，请先扫描一次。');
    }
    if (!result || !Array.isArray(result.nonFollowers) || result.nonFollowers.length === 0) {
      throw new Error('还没有可用的未回关名单，请先扫描。');
    }

    const handle = normalizeHandle(config.handle || result.handle || getOwnHandle());
    assertAccount(handle);
    if (result.handle !== handle) throw new Error('扫描名单与当前账号不一致，请重新扫描。');
    if (!handle) throw new Error('没有识别到你的 X 用户名。');

    const hourlyLimit =
      runtime.mode === 'limited'
        ? Math.max(1, Math.min(50, Number(config.hourlyLimit || 10)))
        : Number.POSITIVE_INFINITY;

    const protection = await chrome.storage.local.get(PROTECTED_KEY);
    const protectedSet = new Set((protection[PROTECTED_KEY] || []).map(normalizeHandle));
    const targets = result.nonFollowers.map(normalizeHandle).filter((item) => !protectedSet.has(item));
    if (!targets.length) throw new Error('待处理名单为空；账号可能都已加入保留名单。');

    const task = {
      type: 'unfollow',
      ownerId: pageOwnerId(),
      active: true,
      phase: 'run',
      mode: runtime.mode,
      handle,
      targets,
      hourlyLimit,
      dailyLimit: Math.max(1, Math.min(500, Number(config.dailyLimit || 40))),
      graceDays: Math.max(0, Math.min(30, Number(config.graceDays || 3))),
      baseDelay: Math.max(1, Number(config.baseDelay || 30)),
      extraDelay: Math.max(0, Number(config.extraDelay || 15)),
      maxScrolls: Number(config.maxScrolls || 120),
      backgroundRun: config.backgroundRun !== false,
      done: [],
      skipped: [],
      nextRunAt: null,
    };
    writeTask(task);
    await continueUnfollow(task);
  }

  async function startStreamClean(config) {
    runtime.stopRequested = false;
    runtime.phase = 'unfollow';
    runtime.mode = config.mode === 'unlimited' ? 'unlimited' : 'limited';
    runtime.nextRunAt = null;
    cancelLimitedTimer();
    const ownHandle = await waitForAccount();
    const handle = normalizeHandle(config.handle || ownHandle);
    assertAccount(handle);

    const task = {
      type: 'stream',
      ownerId: pageOwnerId(),
      active: true,
      phase: 'run',
      mode: runtime.mode,
      handle,
      hourlyLimit: Math.max(1, Math.min(50, Number(config.hourlyLimit || 10))),
      dailyLimit: Math.max(1, Math.min(500, Number(config.dailyLimit || 40))),
      graceDays: Math.max(0, Math.min(30, Number(config.graceDays || 3))),
      baseDelay: Math.max(1, Number(config.baseDelay || 30)),
      extraDelay: Math.max(0, Number(config.extraDelay || 15)),
      maxScrolls: Number(config.maxScrolls || 120),
      backgroundRun: config.backgroundRun !== false,
      checked: [],
      done: [],
      nextRunAt: null,
    };
    writeTask(task);
    await continueStreamClean(task);
  }

  function scheduleLimited(task, delayMs) {
    const when = task.nextRunAt || Date.now() + Math.max(1000, delayMs);
    if (!task.backgroundRun) {
      if (limitedTimer) clearTimeout(limitedTimer);
      limitedTimer = setTimeout(() => {
        limitedTimer = null;
        if (task.type === 'stream') continueStreamClean(task);
        else continueUnfollow(task);
      }, Math.max(1000, when - Date.now()));
      return;
    }
    chrome.runtime.sendMessage({ type: 'SCHEDULE_WAKEUP', when }).catch((error) => {
      runtime.phase = 'idle';
      setStatus(`后台定时失败：${error.message}`);
    });
  }

  async function claimQuota(task) {
    if (task.mode !== 'limited') return { allowed: true };
    const now = Date.now();
    const quotaKey = `x-unfollow-attempts-${task.handle}`;
    const quota = await chrome.storage.local.get(quotaKey);
    const dayAttempts = (quota[quotaKey] || []).filter((time) => time > now - 24 * 60 * 60 * 1000);
    const hourAttempts = dayAttempts.filter((time) => time > now - 60 * 60 * 1000);
    const hourlyLimit = Number(task.hourlyLimit || 10);
    const dailyLimit = Number(task.dailyLimit || 40);
    if (hourAttempts.length >= hourlyLimit) {
      return { allowed: false, nextAt: hourAttempts[hourAttempts.length - hourlyLimit] + 60 * 60 * 1000, reason: '小时额度' };
    }
    if (dayAttempts.length >= dailyLimit) {
      return { allowed: false, nextAt: dayAttempts[dayAttempts.length - dailyLimit] + 24 * 60 * 60 * 1000, reason: '24 小时额度' };
    }
    await chrome.storage.local.set({ [quotaKey]: [...dayAttempts, now] });
    return { allowed: true };
  }

  async function runUnfollowPass(task, batchLimit) {
    return navigator.locks.request('x-unfollow-execution', { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('另一个 X 标签页正在执行取关，请先停止那个任务。');
      return runUnfollowPassLocked(task, batchLimit);
    });
  }

  async function runUnfollowPassLocked(task, batchLimit) {
    const path = `/${task.handle}/following`;
    if (navigateAway(path)) return null;

    await waitForUserList();
    const targetSet = new Set(task.targets.map(normalizeHandle));
    const doneSet = new Set((task.done || []).map(normalizeHandle));
    const skippedSet = new Set((task.skipped || []).map(normalizeHandle));
    const batchStart = doneSet.size;

    for (let round = 0; round < task.maxScrolls; round += 1) {
      checkStop();
      const cells = userCells();

      for (const cell of cells) {
        checkStop();
        if (doneSet.size - batchStart >= batchLimit) break;
        if (doneSet.size >= task.targets.length) break;

        const handle = handleFromCell(cell);
        if (!handle || !targetSet.has(handle) || doneSet.has(handle) || skippedSet.has(handle)) continue;

        assertAccount(task.handle);
        checkStop();
        const quota = await claimQuota(task);
        if (!quota.allowed) {
          task.quotaNextAt = quota.nextAt;
          task.quotaReason = quota.reason;
          return { doneSet, skippedSet };
        }
        checkStop();

        const ok = await tryUnfollow(cell, handle);
        if (ok) {
          doneSet.add(handle);
          task.done = Array.from(doneSet);
          const key = todayKey();
          const stored = await chrome.storage.local.get(key);
          await chrome.storage.local.set({ [key]: Number(stored[key] || 0) + 1 });

          const storedResult = await chrome.storage.local.get(RESULT_KEY);
          const lastResult = storedResult[RESULT_KEY];
          if (lastResult?.handle === task.handle && Array.isArray(lastResult.nonFollowers)) {
            await chrome.storage.local.set({
              [RESULT_KEY]: {
                ...lastResult,
                nonFollowers: lastResult.nonFollowers.filter((item) => normalizeHandle(item) !== handle),
              },
            });
          }

          runtime.progress = {
            done: doneSet.size,
            total: task.targets.length,
            remaining: task.targets.length - doneSet.size,
            handle,
          };
          setStatus(`已取关 ${doneSet.size}/${task.targets.length}：@${handle}`);
          writeTask(task);
          await sleep(jitter(task.baseDelay * 1000, task.extraDelay * 1000));
        } else {
          skippedSet.add(handle);
          task.skipped = Array.from(skippedSet);
          writeTask(task);
          await sleep(jitter(1500, 800));
        }
      }

      if (doneSet.size - batchStart >= batchLimit) break;
      if (doneSet.size + skippedSet.size >= task.targets.length) break;

      window.scrollBy(0, Math.round(window.innerHeight * (0.65 + Math.random() * 0.35)));
      await sleep(jitter(1000, 900));
    }

    return { doneSet, skippedSet };
  }

  function finishUnfollow(task) {
    const finalDone = (task.done || []).length;
    clearTask();
    runtime.phase = 'idle';
    runtime.nextRunAt = null;
    const remaining = task.targets.length - finalDone;
    runtime.progress = { done: finalDone, total: task.targets.length, remaining };
    setStatus(`本次结束，确认取关 ${finalDone} 人，未处理 ${remaining} 人`);
    notifyPopup({ type: 'UNFOLLOW_COMPLETE', done: finalDone, total: task.targets.length });
    recordHistory(`名单任务结束：确认取关 ${finalDone} 人，未处理 ${remaining} 人`, { type: 'unfollow' });
  }

  async function continueUnfollow(task) {
    try {
      checkStop();
      await waitForAccount();
      assertAccount(task.handle);
      runtime.phase = 'unfollow';
      runtime.nextRunAt = null;
      task.quotaNextAt = null;
      const batchLimit = task.mode === 'unlimited' ? Number.POSITIVE_INFINITY : task.hourlyLimit;
      let pass = await runUnfollowPass(task, batchLimit);

      if (!pass) return;
      if (task.mode === 'unlimited') {
        let extraRounds = 0;
        while (pass.doneSet.size + pass.skippedSet.size < task.targets.length && extraRounds < 5) {
          const before = pass.doneSet.size + pass.skippedSet.size;
          pass = await runUnfollowPass(task, batchLimit);
          if (!pass) return;
          const after = pass.doneSet.size + pass.skippedSet.size;
          if (after === before) break;
          extraRounds += 1;
        }
        finishUnfollow(task);
        return;
      }

      if (pass.doneSet.size + pass.skippedSet.size >= task.targets.length) {
        finishUnfollow(task);
        return;
      }

      task.nextRunAt = task.quotaNextAt || Date.now() + 60 * 60 * 1000;
      task.phase = 'waiting';
      writeTask(task);
      runtime.phase = 'waiting';
      runtime.nextRunAt = task.nextRunAt;
      setStatus(`${task.quotaReason || '本轮额度'}已用完，下一次将在 ${formatLocalTime(task.nextRunAt)} 自动开始`);
      notifyPopup({ type: 'WAITING_NEXT_BATCH', nextRunAt: task.nextRunAt });
      scheduleLimited(task, task.nextRunAt - Date.now());
    } catch (error) {
      if (error.code === 'USER_STOPPED') {
        clearTask();
        runtime.phase = 'idle';
        runtime.nextRunAt = null;
        setStatus('已停止');
        notifyPopup({ type: 'STOPPED' });
        return;
      }
      if (error.code === 'TASK_PAUSED') {
        runtime.phase = 'paused';
        setStatus('已暂停，进度已保存');
        return;
      }
      clearTask();
      runtime.phase = 'idle';
      runtime.nextRunAt = null;
      setStatus(`取关失败：${error.message}`);
      notifyPopup({ type: 'ERROR', message: error.message });
    }
  }

  async function runStreamPass(task) {
    return navigator.locks.request('x-unfollow-execution', { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('另一个 X 标签页正在执行任务。');
      const path = `/${task.handle}/following`;
      if (navigateAway(path)) return { navigated: true };
      await waitForUserList();

      const checked = new Set((task.checked || []).map(normalizeHandle));
      const done = new Set((task.done || []).map(normalizeHandle));
      const protection = await chrome.storage.local.get(PROTECTED_KEY);
      const protectedSet = new Set((protection[PROTECTED_KEY] || []).map(normalizeHandle));
      let lastProgressAt = Date.now();
      let seenThisPass = 0;

      for (let round = 0; round < Math.min(3000, task.maxScrolls); round += 1) {
        checkStop();
        let changed = false;
        for (const cell of userCells()) {
          checkStop();
          const handle = handleFromCell(cell);
          if (!handle || checked.has(handle) || done.has(handle)) continue;
          if (protectedSet.has(handle)) {
            checked.add(handle);
            continue;
          }
          changed = true;
          seenThisPass += 1;

          if (cellFollowsYou(cell)) {
            checked.add(handle);
          } else {
            const quota = await claimQuota(task);
            if (!quota.allowed) {
              task.checked = Array.from(checked);
              task.done = Array.from(done);
              task.quotaNextAt = quota.nextAt;
              task.quotaReason = quota.reason;
              writeTask(task);
              return { waiting: true, checked, done, seenThisPass };
            }
            checkStop();
            const ok = await tryUnfollow(cell, handle);
            if (ok) {
              done.add(handle);
              const dayKey = todayKey();
              const day = await chrome.storage.local.get(dayKey);
              await chrome.storage.local.set({ [dayKey]: Number(day[dayKey] || 0) + 1 });
              const saved = await chrome.storage.local.get(RESULT_KEY);
              if (saved[RESULT_KEY]?.handle === task.handle) {
                await chrome.storage.local.set({
                  [RESULT_KEY]: {
                    ...saved[RESULT_KEY],
                    nonFollowers: (saved[RESULT_KEY].nonFollowers || []).filter((item) => normalizeHandle(item) !== handle),
                  },
                });
              }
              runtime.progress = { done: done.size, checked: checked.size + done.size, handle };
              setStatus(`边扫边清理：已检查 ${checked.size + done.size} 人，确认取关 ${done.size} 人，刚处理 @${handle}`);
              await sleep(jitter(task.baseDelay * 1000, task.extraDelay * 1000));
            } else {
              checked.add(handle);
            }
          }

          task.checked = Array.from(checked);
          task.done = Array.from(done);
          writeTask(task);
        }

        if (changed) lastProgressAt = Date.now();
        setStatus(`边扫边清理：已检查 ${checked.size + done.size} 人，确认取关 ${done.size} 人（滚动 ${round + 1}/${task.maxScrolls} 次）`);
        const scroller = document.scrollingElement || document.documentElement;
        scroller.scrollBy({ top: Math.max(300, Math.round(innerHeight * 0.75)), behavior: 'instant' });
        await sleep(jitter(1200, 600));
        if (Date.now() - lastProgressAt >= 60000) break;
      }

      task.checked = Array.from(checked);
      task.done = Array.from(done);
      writeTask(task);
      return { waiting: false, checked, done, seenThisPass };
    });
  }

  async function continueStreamClean(task) {
    try {
      checkStop();
      await waitForAccount();
      assertAccount(task.handle);
      runtime.phase = 'unfollow';
      runtime.mode = task.mode;
      runtime.nextRunAt = null;
      task.quotaNextAt = null;
      const pass = await runStreamPass(task);
      if (pass.navigated) return;

      if (pass.waiting) {
        task.nextRunAt = task.quotaNextAt || Date.now() + 3600000;
        task.phase = 'waiting';
        writeTask(task);
        runtime.phase = 'waiting';
        runtime.nextRunAt = task.nextRunAt;
        setStatus(`${task.quotaReason || '本轮额度'}已用完，${formatLocalTime(task.nextRunAt)} 继续边扫边清理`);
        scheduleLimited(task, task.nextRunAt - Date.now());
        return;
      }

      clearTask();
      runtime.phase = 'idle';
      runtime.progress = { done: pass.done.size, checked: pass.checked.size + pass.done.size };
      setStatus(`本轮边扫完成：检查 ${pass.checked.size + pass.done.size} 人，确认取关 ${pass.done.size} 人`);
      recordHistory(`边扫结束：检查 ${pass.checked.size + pass.done.size} 人，确认取关 ${pass.done.size} 人`, { type: 'stream' });
      notifyPopup({ type: 'UNFOLLOW_COMPLETE', done: pass.done.size });
    } catch (error) {
      if (error.code === 'USER_STOPPED') {
        clearTask();
        runtime.phase = 'idle';
        setStatus('已停止');
        notifyPopup({ type: 'STOPPED' });
        return;
      }
      if (error.code === 'TASK_PAUSED') {
        runtime.phase = 'paused';
        setStatus('已暂停，进度已保存');
        return;
      }
      runtime.phase = 'idle';
      setStatus(`边扫边清理失败：${error.message}`);
      notifyPopup({ type: 'ERROR', message: error.message });
    }
  }

  async function getFullStatus() {
    const key = todayKey();
    const stored = await chrome.storage.local.get([RESULT_KEY, key]);
    return {
      ...getStatusSnapshot(),
      todayDone: Number(stored[key] || 0),
      lastResult: stored[RESULT_KEY] || null,
      url: location.href,
    };
  }

  async function persistStoppedScan() {
    const snapshot = runtime.scanSnapshot;
    const task = readTask();
    if (!snapshot || task?.type !== 'scan' || !task.handle) return;
    const stored = await chrome.storage.local.get([RESULT_KEY, PROTECTED_KEY]);
    const previous = stored[RESULT_KEY];
    const protectedSet = new Set((stored[PROTECTED_KEY] || []).map(normalizeHandle));
    const merged = new Set(
      previous?.handle === task.handle && previous?.algorithm === 'following-indicator-v1'
        ? previous.nonFollowers || []
        : [],
    );
    for (const handle of snapshot.nonFollowers) {
      if (!protectedSet.has(handle)) merged.add(handle);
    }
    await chrome.storage.local.set({
      [RESULT_KEY]: {
        verified: true,
        algorithm: 'following-indicator-v1',
        handle: task.handle,
        scannedAt: Date.now(),
        followingCount: snapshot.expected,
        scannedFollowingCount: snapshot.scanned,
        scanComplete: false,
        stopReason: '用户停止',
        nonFollowers: Array.from(merged),
      },
    });
    runtime.progress = { scanned: snapshot.scanned, expected: snapshot.expected, nonFollowers: merged.size };
  }

  async function stopNow() {
    const wasWaiting = runtime.phase === 'waiting' || runtime.phase === 'idle';
    runtime.stopRequested = true;
    cancelLimitedTimer();
    await persistStoppedScan();
    clearTask();
    runtime.phase = wasWaiting ? 'idle' : 'stopping';
    runtime.nextRunAt = null;
    const progress = runtime.progress;
    setStatus(
      progress?.scanned
        ? `已停止并保存：扫描 ${progress.scanned}/${progress.expected} 人，发现未回关 ${progress.nonFollowers} 人`
        : '已停止',
    );
  }

  async function pauseNow() {
    runtime.pauseRequested = true;
    cancelLimitedTimer();
    await persistStoppedScan();
    const task = await hydrateTask();
    if (task?.active) {
      task.paused = true;
      writeTask(task);
    }
    runtime.phase = 'paused';
    setStatus('已暂停，进度已保存');
  }

  async function resumeNow() {
    const task = await hydrateTask();
    if (!task?.active || !task.paused) throw new Error('没有可继续的暂停任务。');
    task.paused = false;
    writeTask(task);
    runtime.pauseRequested = false;
    runtime.stopRequested = false;
    runtime.phase = task.type === 'scan' ? 'scan' : 'unfollow';
    setStatus('正在继续任务...');
    if (task.type === 'scan') continueScan(task);
    else if (task.type === 'stream') continueStreamClean(task);
    else continueUnfollow(task);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_STATUS') {
      getFullStatus().then(sendResponse);
      return true;
    }

    if (message?.type === 'START_SCAN' || message?.type === 'START_UNFOLLOW' || message?.type === 'START_STREAM_CLEAN') {
      if (runtime.phase !== 'idle') {
        sendResponse({ ok: false, error: '已有任务运行，请先停止。' });
        return false;
      }
      sendResponse({ ok: true });
      const start = message.type === 'START_SCAN' ? startScan : message.type === 'START_STREAM_CLEAN' ? startStreamClean : startUnfollow;
      const config = { ...(message.config || {}) };
      for (const [key, fallback, min, max] of [
        ['hourlyLimit', 10, 1, 50], ['dailyLimit', 40, 1, 500], ['maxScrolls', 120, 20, 3000],
        ['baseDelay', 30, 3, 300], ['extraDelay', 15, 0, 300], ['graceDays', 3, 0, 30],
      ]) {
        const value = Number(config[key]);
        config[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
      }
      start(config).catch((error) => {
        clearTask();
        runtime.phase = 'idle';
        setStatus(`启动失败：${error.message}`);
      });
      return false;
    }

    if (message?.type === 'STOP') {
      stopNow().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (message?.type === 'PAUSE') {
      pauseNow().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (message?.type === 'RESUME') {
      resumeNow().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === 'CONTINUE_TASK') {
      hydrateTask().then((task) => {
        if (!task?.active || !['unfollow', 'stream'].includes(task.type) || task.mode !== 'limited') {
          sendResponse({ ok: false, error: '没有等待中的限量任务。' });
          return;
        }
        if (task.ownerId && task.ownerId !== pageOwnerId()) {
          sendResponse({ ok: false, error: '任务正在另一个 X 标签页运行。' });
          return;
        }
        if (task.nextRunAt && task.nextRunAt > Date.now() + 1000) {
          scheduleLimited(task, task.nextRunAt - Date.now());
          sendResponse({ ok: true, waiting: true });
          return;
        }
        if (runtime.phase === 'unfollow') {
          sendResponse({ ok: true, running: true });
          return;
        }
        sendResponse({ ok: true });
        if (task.type === 'stream') continueStreamClean(task);
        else continueUnfollow(task);
      });
      return true;
    }

    return false;
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const label = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`.trim();
    if (!/^(follow|关注)(\s|$)/i.test(label) || /following|正在关注|取消关注/i.test(label)) return;
    const ownHandle = getOwnHandle();
    if (!ownHandle) return;
    const cell = button.closest('[data-testid="UserCell"]');
    let handle = cell ? handleFromCell(cell) : '';
    if (!handle) {
      const match = currentPath().match(/^\/([a-z0-9_]{1,15})\/?$/i);
      if (match) handle = normalizeHandle(match[1]);
    }
    if (!handle || handle === ownHandle) return;
    chrome.storage.local.get(FOLLOW_LEDGER_KEY).then((stored) => {
      const ledger = { ...(stored[FOLLOW_LEDGER_KEY] || {}) };
      ledger[`${ownHandle}:${handle}`] = Date.now();
      return chrome.storage.local.set({ [FOLLOW_LEDGER_KEY]: ledger });
    }).catch(() => {});
  }, true);

  (async function boot() {
    const task = await hydrateTask();
    if (!task?.active) {
      runtime.phase = 'idle';
      return;
    }
    if (task.paused) {
      runtime.phase = 'paused';
      runtime.status = '已暂停，点击继续恢复任务';
      return;
    }
    if (task.ownerId && task.ownerId !== pageOwnerId()) {
      runtime.phase = 'idle';
      runtime.status = '任务正在另一个 X 标签页运行';
      return;
    }

    runtime.phase = task.type === 'scan' ? 'scan' : 'unfollow';
    runtime.mode = task.mode || 'limited';
    setStatus(task.type === 'scan' ? '正在恢复扫描...' : '正在恢复取关...');

    if (task.type === 'scan') {
      await continueScan(task);
    } else if (task.type === 'stream') {
      if (task.mode === 'limited' && task.nextRunAt && task.nextRunAt > Date.now()) {
        runtime.phase = 'waiting';
        runtime.nextRunAt = task.nextRunAt;
        setStatus(`等待下一轮，将在 ${formatLocalTime(task.nextRunAt)} 自动继续`);
        scheduleLimited(task, task.nextRunAt - Date.now());
        return;
      }
      await continueStreamClean(task);
    } else if (task.type === 'unfollow') {
      if (task.mode === 'limited' && task.nextRunAt && task.nextRunAt > Date.now()) {
        runtime.phase = 'waiting';
        runtime.nextRunAt = task.nextRunAt;
        setStatus(`等待下一轮，将在 ${formatLocalTime(task.nextRunAt)} 自动继续`);
        scheduleLimited(task, task.nextRunAt - Date.now());
        return;
      }
      await continueUnfollow(task);
    }
  })();
})();
