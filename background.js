const ALARM_PREFIX = 'x-unfollow-wakeup:';

function alarmName(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

async function wakeTab(tabId) {
  try {
    await chrome.tabs.get(tabId);
  } catch (_) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'CONTINUE_TASK' });
    return;
  } catch (_) {
    // A reloaded extension may not yet have a receiver in an existing X tab.
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_) {
    // The tab may be closed, logged out, or navigating. Its saved page task remains intact.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return false;

  if (message?.type === 'SCHEDULE_WAKEUP') {
    const when = Math.max(Date.now() + 1000, Number(message.when) || Date.now() + 60000);
    chrome.alarms.create(alarmName(tabId), { when });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'CANCEL_WAKEUP') {
    chrome.alarms.clear(alarmName(tabId)).then((wasScheduled) => sendResponse({ ok: true, wasScheduled }));
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
  if (Number.isInteger(tabId)) wakeTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.alarms.clear(alarmName(tabId));
});
