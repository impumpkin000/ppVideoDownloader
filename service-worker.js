importScripts('background/floating-panel.js');

const TASKS_KEY = 'downloadTasks';
const OFFSCREEN_PATH = 'offscreen.html';
const TASK_HISTORY_LIMIT = 100;
const MEDIA_REFERRER_RULE_ID = 1;

let taskWriteQueue = Promise.resolve();
let creatingOffscreen;
const progressCache = new Map();
const tabCleanupPromises = new Map();
const invalidatedTaskIds = new Set();
const tabCloseGuardState = new Map();

chrome.runtime.onInstalled.addListener(() => {
  void reconcileTabCloseGuards().catch((error) => {
    console.error('[当前页视频下载器] 无法恢复页面离开保护', error);
  });
  void restoreDownloadRetries().catch((error) => {
    console.error('[当前页视频下载器] 无法恢复下载重试', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void reconcileTabCloseGuards().catch((error) => {
    console.error('[当前页视频下载器] 无法恢复页面离开保护', error);
  });
  void restoreDownloadRetries().catch((error) => {
    console.error('[当前页视频下载器] 无法恢复下载重试', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'service-worker') {
    handleOffscreenMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || '后台处理失败' }));
    return true;
  }

  if (message.type === 'download:start') {
    startDownload(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || '无法开始下载' }));
    return true;
  }

  if (message.type === 'download:cancel') {
    cancelDownload(message.taskId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || '无法取消下载' }));
    return true;
  }

  if (message.type === 'download:list') {
    refreshDownloadTasks()
      .then((tasks) => sendResponse({ ok: true, tasks }))
      .catch((error) => sendResponse({ ok: false, error: error.message || '无法读取下载状态' }));
    return true;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  void syncDownloadState(delta.id);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('download-retry:')) {
    void retryInterruptedDownload(alarm.name.slice('download-retry:'.length)).catch((error) => {
      console.error('[当前页视频下载器] 无法重试下载', error);
    });
  }
});

chrome.webNavigation.onCommitted.addListener(handleTopLevelNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(handleTopLevelNavigation);

function handleTopLevelNavigation(details) {
  if (details.frameId === 0) {
    void FloatingPanel.removeFromTab(details.tabId).catch((error) => {
      console.warn('[当前页视频下载器] 无法关闭旧页面浮窗', error);
    });
    void cancelTasksForTab(details.tabId, '标签页已跳转').catch((error) => {
      console.error('[当前页视频下载器] 无法处理标签页跳转', error);
    });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void cancelTasksForTab(tabId, '标签页已关闭').catch((error) => {
    console.error('[当前页视频下载器] 无法处理标签页关闭', error);
  });
});

async function reconcileTabCloseGuards() {
  const tasks = await loadTasks();
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id)).map(async (tab) => {
    await syncTabCloseGuard(tab.id, tasks);
  }));
}

async function cancelTasksForTab(tabId, reason) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  const previous = tabCleanupPromises.get(tabId) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => cancelAndClearTasksForTab(tabId, reason));
  tabCleanupPromises.set(tabId, operation);
  try {
    await operation;
  } finally {
    if (tabCleanupPromises.get(tabId) === operation) {
      tabCleanupPromises.delete(tabId);
    }
  }
}

async function cancelAndClearTasksForTab(tabId, reason) {
  const tasks = await loadTasks();
  const activeTasks = Object.values(tasks).filter((task) =>
    task.tabId === tabId && isActiveTaskStatus(task.status)
  );
  await Promise.all(activeTasks.map(async (task) => {
    try {
      const response = await cancelDownload(task.id);
      if (!response?.ok) {
        console.warn(`[当前页视频下载器] ${reason}后取消下载失败`, {
          taskId: task.id,
          error: response.error || '未知错误'
        });
      }
    } catch (error) {
      console.error(`[当前页视频下载器] ${reason}后取消下载失败`, {
        taskId: task.id,
        error: error.message || '未知错误'
      });
    }
  }));

  const cleanup = taskWriteQueue.then(async () => {
    const latestTasks = await loadTasks();
    const removedTaskIds = [];
    const activeTaskIds = new Set(activeTasks.map((task) => task.id));
    for (const [taskId, task] of Object.entries(latestTasks)) {
      if (task.tabId !== tabId || isActiveTaskStatus(task.status)) {
        continue;
      }
      if (activeTaskIds.has(taskId)) {
        invalidatedTaskIds.add(taskId);
      }
      delete latestTasks[taskId];
      removedTaskIds.push(taskId);
    }
    if (removedTaskIds.length) {
      await chrome.storage.local.set({ [TASKS_KEY]: latestTasks });
      removedTaskIds.forEach((taskId) => progressCache.delete(taskId));
    }
    await syncTabCloseGuard(tabId, latestTasks);
    const remainingTasks = Object.values(latestTasks).filter((task) =>
      task.tabId === tabId && isActiveTaskStatus(task.status)
    );
    if (remainingTasks.length) {
      console.warn(`[当前页视频下载器] ${reason}后仍有任务未能取消`, {
        tabId,
        taskIds: remainingTasks.map((task) => task.id)
      });
    }
  });
  taskWriteQueue = cleanup.catch(() => {});
  await cleanup;
}

async function startDownload(message) {
  const { taskId, taskKey, tabId, pageUrl, video } = message;
  const file = video?.files?.[0];
  if (!Number.isInteger(tabId)) {
    throw new Error('当前标签页不可用');
  }
  if (typeof pageUrl !== 'string' || !/^https?:/i.test(pageUrl)) {
    throw new Error('当前页面地址不可用');
  }
  if (!taskId || !taskKey || !file?.url || !/^https?:/i.test(file.url)) {
    throw new Error('视频地址不可用');
  }
  const task = {
    id: taskId,
    key: taskKey,
    name: video.name || '网页视频',
    resolution: video.resolution || '',
    tabId,
    pageUrl,
    isHls: video.streamType === 'hls',
    requiresTranscoding: video.streamType === 'hls' || video.streamType === 'dash',
    status: 'processing',
    phase: video.streamType === 'hls' || video.streamType === 'dash' ? 'queued' : 'starting',
    progress: 0,
    cancelRequested: false,
    createdAt: Date.now()
  };
  if (!await isTaskPageCurrent(task)) {
    throw new Error('页面已跳转，请重新扫描后再下载');
  }

  await saveTask(taskId, task);
  if (!await getTask(taskId)) {
    throw new Error('下载任务已取消');
  }

  if (task.requiresTranscoding) {
    try {
      await ensureOffscreenDocument();
      if (!await isTaskPageCurrent(task)) {
        await cancelDownload(taskId);
        throw new Error('页面已跳转，下载任务已取消');
      }
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'hls:start',
        taskId,
        video
      });
      if (!response?.ok) {
        throw new Error(response?.error || '无法启动 HLS 处理');
      }
      if (!await isTaskPageCurrent(task)) {
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls:cancel', taskId });
        await cancelDownload(taskId);
        throw new Error('页面已跳转，下载任务已取消');
      }
    } catch (error) {
      await saveTask(taskId, {
        status: 'failed',
        phase: 'failed',
        error: error.message || '无法启动 HLS 处理'
      });
      throw error;
    }
    return { ok: true, task };
  }

  await startChromeDownload(taskId, file.url, file.filename || file.url, false);
  return { ok: true, task: await getTask(taskId) };
}

async function handleOffscreenMessage(message, sender) {
  if (message.type === 'hls:referrer:configure') {
    return configureMediaReferrer(message, sender);
  }

  if (message.type === 'hls:referrer:clear') {
    return clearMediaReferrer(message, sender);
  }

  if (message.type === 'hls:progress') {
    const task = await getTask(message.taskId);
    if (!task || task.cancelRequested || isTerminal(task.status)) {
      return { ok: true };
    }
    await saveTask(message.taskId, {
      status: message.phase === 'retrying' ? 'retrying' : 'processing',
      phase: message.phase,
      progress: message.progress,
      current: message.current,
      total: message.total
    }, { monotonicProgress: true });
    return { ok: true };
  }

  if (message.type === 'hls:ready') {
    const task = await getTask(message.taskId);
    if (!task || task.cancelRequested) {
      return { ok: false, error: '下载已取消' };
    }
    await startChromeDownload(
      message.taskId,
      message.url,
      `${task.name}-${task.resolution}`,
      true,
      message.extension
    );
    return { ok: true };
  }

  if (message.type === 'hls:failed') {
    const task = await getTask(message.taskId);
    if (!task) {
      return { ok: true };
    }
    const status = message.cancelled || task.cancelRequested ? 'cancelled' : 'failed';
    await saveTask(message.taskId, {
      status,
      phase: status,
      error: status === 'failed' ? message.error || 'HLS 处理失败' : ''
    });
    return { ok: true };
  }

  if (message.type === 'hls:blob-revoked') {
    if (await getTask(message.taskId)) {
      await saveTask(message.taskId, { hlsBlobPending: false });
    }
    return { ok: true };
  }

  return { ok: false, error: '未知的后台消息' };
}

async function configureMediaReferrer(message, sender) {
  if (sender.url !== chrome.runtime.getURL(OFFSCREEN_PATH)) {
    throw new Error('无权配置视频请求 Referer');
  }
  const file = message.video?.files?.[0];
  if (!message.taskId || !['hls', 'dash'].includes(message.video?.streamType) || !file?.referrer) {
    throw new Error('媒体请求缺少有效 Referer');
  }
  const referrer = new URL(file.referrer);
  if (!['http:', 'https:'].includes(referrer.protocol)) {
    throw new Error('DASH Referer 地址无效');
  }
  const urls = [
    file.url,
    file.audioUrl,
    ...(file.backupUrls || []),
    ...(file.audioBackupUrls || [])
  ];
  const requestDomains = [...new Set(urls.flatMap((url) => {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) ? [parsed.hostname] : [];
    } catch {
      return [];
    }
  }))];
  if (!requestDomains.length) {
    throw new Error('DASH CDN 地址不可用');
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [MEDIA_REFERRER_RULE_ID],
    addRules: [{
      id: MEDIA_REFERRER_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: referrer.href },
          { header: 'accept-encoding', operation: 'set', value: 'identity' }
        ]
      },
      condition: { requestDomains, resourceTypes: ['xmlhttprequest'] }
    }]
  });
  return { ok: true };
}

async function clearMediaReferrer(message, sender) {
  if (sender.url !== chrome.runtime.getURL(OFFSCREEN_PATH)) {
    throw new Error('无权清理视频请求 Referer');
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [MEDIA_REFERRER_RULE_ID]
  });
  return { ok: true };
}

async function startChromeDownload(taskId, url, sourceName, isHls, outputExtension = '') {
  const task = await getTask(taskId);
  if (!task || task.cancelRequested) {
    throw new Error('下载已取消');
  }
  if (!await isTaskPageCurrent(task)) {
    await cancelDownload(taskId);
    throw new Error('页面已跳转，下载任务已取消');
  }
  const extension = isHls
    ? `.${['mp4', 'ts'].includes(outputExtension) ? outputExtension : 'mp4'}`
    : getExtension(sourceName);
  const filename = [
    safeFilePart(task.name || '网页视频'),
    safeFilePart(task.resolution || 'original')
  ].join('-');
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url,
      filename: `ppVideoDownloader/${filename}${extension}`,
      conflictAction: 'uniquify',
      saveAs: false
    });
  } catch (error) {
    if (isHls) {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'hls:revoke',
        taskId
      }).catch(() => {});
    }
    if (!isHls) {
      await saveTask(taskId, {
        status: 'failed',
        phase: 'failed',
        error: error.message || 'Chrome 拒绝了下载'
      });
    }
    throw error;
  }

  if (!await isTaskPageCurrent(task)) {
    try {
      await chrome.downloads.cancel(downloadId);
    } catch (error) {
      console.warn('[当前页视频下载器] 页面跳转后取消下载失败', {
        taskId,
        error: error.message || '未知错误'
      });
    }
    await syncDownloadState(downloadId);
    const latestTask = await getTask(taskId);
    if (latestTask && !isTerminal(latestTask.status)) {
      await saveTask(taskId, { status: 'cancelled', phase: 'cancelled', error: '' });
    }
    throw new Error('页面已跳转，下载任务已取消');
  }

  await saveTask(taskId, {
    downloadId,
    status: 'downloading',
    phase: 'downloading',
    progress: isHls ? 0.99 : 0,
    hlsBlobPending: isHls
  });
  const latestTask = await getTask(taskId);
  if (!latestTask || latestTask.cancelRequested) {
    try {
      await chrome.downloads.cancel(downloadId);
    } catch (error) {
      await syncDownloadState(downloadId);
      console.warn('[当前页视频下载器] 下载任务已失效但 Chrome 拒绝取消', {
        taskId,
        error: error.message || '未知错误'
      });
    }
  }
  await syncDownloadState(downloadId);
}

async function cancelDownload(taskId) {
  const task = await getTask(taskId);
  if (!task || isTerminal(task.status)) {
    return { ok: true, task };
  }
  await chrome.alarms.clear(getDownloadRetryAlarmName(taskId));
  const requiresTranscoding = task.requiresTranscoding ?? task.isHls;
  await saveTask(taskId, { cancelRequested: true, status: 'cancelling', phase: 'cancelling' });
  if (task.downloadId !== undefined) {
    try {
      await chrome.downloads.cancel(task.downloadId);
    } catch (error) {
      await syncDownloadState(task.downloadId);
      const latestTask = await getTask(taskId);
      if (!isTerminal(latestTask?.status)) {
        await saveTask(taskId, {
          cancelRequested: false,
          status: 'downloading',
          phase: 'downloading'
        });
        return { ok: false, error: error.message || 'Chrome 拒绝了取消请求' };
      }
    }
    await syncDownloadState(task.downloadId);
    await eraseCancelledDownload(task.downloadId);
  } else if (requiresTranscoding) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'hls:cancel',
        taskId
      });
      if (!response?.ok) {
        throw new Error(response?.error || '无法通知后台处理器取消下载');
      }
    } catch (error) {
      await saveTask(taskId, {
        cancelRequested: false,
        status: task.status,
        phase: task.phase,
        progress: task.progress
      });
      return { ok: false, error: error.message || '无法通知后台处理器取消下载' };
    }
  }
  if (task.downloadId === undefined) {
    await saveTask(taskId, { status: 'cancelled', phase: 'cancelled', error: '' });
  }
  return { ok: true };
}

async function eraseCancelledDownload(downloadId) {
  try {
    const [download] = await chrome.downloads.search({ id: downloadId });
    if (download?.state === 'interrupted' && download.error === 'USER_CANCELED') {
      await chrome.downloads.erase({ id: downloadId });
    }
  } catch {
    return;
  }
}

async function updateFromDownload(delta) {
  const tasks = await loadTasks();
  const task = Object.values(tasks).find((candidate) => candidate.downloadId === delta.id);
  if (!task) {
    return;
  }
  const requiresTranscoding = task.requiresTranscoding ?? task.isHls;

  let patch;
  let terminal = false;
  if (delta.state?.current === 'complete') {
    await chrome.alarms.clear(getDownloadRetryAlarmName(task.id));
    patch = { status: 'complete', phase: 'complete', progress: 1, error: '' };
    terminal = true;
  } else if (delta.state?.current === 'interrupted' || delta.error?.current) {
    const cancelled = task.cancelRequested || /USER_CANCELED/i.test(delta.error?.current || '');
    const error = delta.error?.current || '下载中断';
    if (!cancelled && isRetryableDownloadError(error)) {
      await saveTask(task.id, {
        status: 'retrying',
        phase: 'retrying',
        error,
        retryCount: (task.retryCount || 0) + 1
      });
      await scheduleDownloadRetry(task.id, task.retryCount || 0);
      return;
    }
    await chrome.alarms.clear(getDownloadRetryAlarmName(task.id));
    patch = {
      status: cancelled ? 'cancelled' : 'failed',
      phase: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? '' : error
    };
    terminal = true;
  } else if (delta.state?.current === 'in_progress' || delta.bytesReceived?.current !== undefined) {
    await chrome.alarms.clear(getDownloadRetryAlarmName(task.id));
    const received = delta.bytesReceived?.current;
    const total = delta.totalBytes?.current;
    const actualProgress = Number.isFinite(total) && total > 0 && Number.isFinite(received)
      ? Math.min(1, received / total)
      : null;
    const progress = requiresTranscoding
      ? 0.99
      : actualProgress === null ? null : Math.min(0.99, actualProgress);
    if (shouldReportProgress(task.id, progress)) {
      patch = {
        status: task.cancelRequested ? 'cancelling' : 'downloading',
        phase: 'downloading',
        progress,
        error: ''
      };
    }
  }

  if (!patch) {
    return;
  }
  await saveTask(task.id, {
    ...patch,
    hlsBlobPending: terminal && !requiresTranscoding ? false : task.hlsBlobPending
  });
  if (terminal && requiresTranscoding) {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'hls:revoke',
      taskId: task.id
    }).catch(() => {});
  }
}

function isRetryableDownloadError(error) {
  return /^(?:NETWORK_FAILED|NETWORK_TIMEOUT|NETWORK_DISCONNECTED|NETWORK_SERVER_DOWN|SERVER_FAILED|SERVER_UNREACHABLE|FILE_NO_SPACE|FILE_TRANSIENT_ERROR)$/i
    .test(error);
}

function getDownloadRetryAlarmName(taskId) {
  return `download-retry:${taskId}`;
}

async function scheduleDownloadRetry(taskId, retryCount) {
  const delayInMinutes = Math.min(5, 2 ** Math.min(retryCount, 3));
  await chrome.alarms.create(getDownloadRetryAlarmName(taskId), { delayInMinutes });
}

async function restoreDownloadRetries() {
  const tasks = await loadTasks();
  for (const task of Object.values(tasks)) {
    if (isRetryingTask(task) &&
        task.downloadId !== undefined && !task.cancelRequested) {
      await scheduleDownloadRetry(task.id, task.retryCount || 0);
    }
  }
}

async function retryInterruptedDownload(taskId) {
  const task = await getTask(taskId);
  if (!task || !isRetryingTask(task) ||
      task.downloadId === undefined || task.cancelRequested) {
    return;
  }
  try {
    await chrome.downloads.resume(task.downloadId);
    await syncDownloadState(task.downloadId);
  } catch (error) {
    await syncDownloadState(task.downloadId);
    const latestTask = await getTask(taskId);
    if (latestTask && isRetryingTask(latestTask) &&
        !latestTask.cancelRequested) {
      await scheduleDownloadRetry(taskId, latestTask.retryCount || 0);
      console.warn('[当前页视频下载器] 下载恢复失败，将继续重试', {
        taskId,
        error: error.message || '未知错误'
      });
    }
  }
}

async function syncDownloadState(downloadId) {
  try {
    const [download] = await chrome.downloads.search({ id: downloadId });
    if (!download) {
      return;
    }
    const delta = { id: downloadId };
    if (download.state) {
      delta.state = { current: download.state };
    }
    if (download.error) {
      delta.error = { current: download.error };
    }
    if (Number.isFinite(download.bytesReceived)) {
      delta.bytesReceived = { current: download.bytesReceived };
    }
    if (Number.isFinite(download.totalBytes)) {
      delta.totalBytes = { current: download.totalBytes };
    }
    await updateFromDownload(delta);
  } catch {
    return;
  }
}

async function refreshDownloadTasks() {
  const tasks = await loadTasks();
  const activeDownloads = Object.values(tasks).filter((task) =>
    task.downloadId !== undefined && ['downloading', 'cancelling'].includes(task.status)
  );
  await Promise.all(activeDownloads.map((task) => syncDownloadState(task.downloadId)));
  const refreshedTasks = await loadTasks();
  return Object.values(refreshedTasks);
}

async function ensureOffscreenDocument() {
  if (!creatingOffscreen) {
    creatingOffscreen = (async () => {
      if (await hasOffscreenDocument()) {
        return;
      }
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['BLOBS', 'WORKERS'],
          justification: '在浮动面板关闭后继续读取 HLS 分片并封装视频'
        });
      } catch (error) {
        if (!await hasOffscreenDocument()) {
          throw error;
        }
      }
    })().finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

async function hasOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url]
    });
    return contexts.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === url);
}

async function saveTask(taskId, patch, { monotonicProgress = false } = {}) {
  const operation = taskWriteQueue.then(async () => {
    if (invalidatedTaskIds.has(taskId)) {
      return null;
    }
    const tasks = await loadTasks();
    const existing = tasks[taskId] || { id: taskId, createdAt: Date.now() };
    const isRetryRecovery = existing.status === 'failed' && patch.status === 'retrying';
    let effectivePatch = isTerminal(existing.status) && !isTerminal(patch.status) &&
      !isRetryRecovery
      ? {
          ...patch,
          status: existing.status,
          phase: existing.phase,
          progress: existing.progress,
          error: existing.error
        }
      : patch;
    const startsNewAttempt = existing.phase === 'retrying' && effectivePatch.phase === 'fetching';
    if (monotonicProgress && !startsNewAttempt &&
        Number.isFinite(existing.progress) && Number.isFinite(effectivePatch.progress) &&
        effectivePatch.progress < existing.progress) {
      effectivePatch = { ...effectivePatch, progress: existing.progress };
    }
    tasks[taskId] = { ...existing, ...effectivePatch, updatedAt: Date.now() };
    const updated = tasks[taskId];
    pruneTasks(tasks);
    await chrome.storage.local.set({ [TASKS_KEY]: tasks });
    await notifyPopup(updated);
    if (isActiveTaskStatus(existing.status) !== isActiveTaskStatus(updated.status) ||
        existing.tabId !== updated.tabId) {
      const affectedTabIds = new Set([existing.tabId, updated.tabId]
        .filter((tabId) => Number.isInteger(tabId)));
      await Promise.all([...affectedTabIds].map((tabId) => syncTabCloseGuard(tabId, tasks)));
    }
    return updated;
  });
  taskWriteQueue = operation.catch(() => {});
  return operation;
}

async function syncTabCloseGuard(tabId, tasks) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  const shouldProtect = Object.values(tasks).some((task) =>
    task.tabId === tabId && isActiveTaskStatus(task.status)
  );
  if (tabCloseGuardState.get(tabId) === shouldProtect) {
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (protect) => {
        const key = '__ppVideoDownloaderBeforeUnload';
        const existing = window[key];
        if (protect && !existing) {
          const handler = (event) => {
            event.preventDefault();
            event.returnValue = '';
          };
          Object.defineProperty(window, key, { value: handler, configurable: true });
          window.addEventListener('beforeunload', handler);
        } else if (!protect && existing) {
          window.removeEventListener('beforeunload', existing);
          delete window[key];
        }
      },
      args: [shouldProtect]
    });
    tabCloseGuardState.set(tabId, shouldProtect);
  } catch (error) {
    tabCloseGuardState.delete(tabId);
    console.warn('[当前页视频下载器] 无法更新页面离开保护', {
      tabId,
      shouldProtect,
      error: error.message || '未知错误'
    });
  }
}

async function isTaskPageCurrent(task) {
  if (!Number.isInteger(task.tabId) || !task.pageUrl) {
    return true;
  }
  try {
    const tab = await chrome.tabs.get(task.tabId);
    return tab.url === task.pageUrl;
  } catch (error) {
    console.warn('[当前页视频下载器] 无法确认下载任务所属标签页', {
      tabId: task.tabId,
      error: error.message || '未知错误'
    });
    return false;
  }
}

function isActiveTaskStatus(status) {
  return ['processing', 'retrying', 'downloading', 'cancelling'].includes(status);
}

function isRetryingTask(task) {
  return task.status === 'retrying' ||
    (task.status === 'processing' && task.phase === 'retrying');
}

async function getTask(taskId) {
  const tasks = await loadTasks();
  return tasks[taskId] || null;
}

async function loadTasks() {
  const result = await chrome.storage.local.get(TASKS_KEY);
  return result[TASKS_KEY] || {};
}

function pruneTasks(tasks) {
  const entries = Object.values(tasks).sort((left, right) => right.updatedAt - left.updatedAt);
  const completed = entries.filter((task) => isTerminal(task.status));
  for (const task of completed.slice(TASK_HISTORY_LIMIT)) {
    delete tasks[task.id];
  }
}

function notifyPopup(task) {
  return chrome.runtime.sendMessage({ target: 'popup', type: 'task:update', task }).catch(() => {});
}

function shouldReportProgress(taskId, progress) {
  const now = Date.now();
  const previous = progressCache.get(taskId);
  if (previous && now - previous.time < 1000 &&
      (progress === null || previous.progress === null || progress - previous.progress < 0.02)) {
    return false;
  }
  progressCache.set(taskId, { time: now, progress });
  return true;
}

function isTerminal(status) {
  return ['complete', 'failed', 'cancelled'].includes(status);
}

function safeFilePart(value) {
  return String(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80);
}

function getExtension(value) {
  const path = String(value).split(/[?#]/, 1)[0];
  return path.match(/\.(?:mp4|m4v|webm|mov|ogv)$/i)?.[0] || '.mp4';
}