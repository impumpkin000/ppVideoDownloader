const jobs = new Map();
const blobUrls = new Map();
const opfsFiles = new Map();
const PROGRESS_REPORT_INTERVAL_MS = 500;
let jobQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') {
    return;
  }

  if (message.type === 'hls:start') {
    enqueueHlsTask(message);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'hls:cancel') {
    cancelHlsTask(message.taskId);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'hls:revoke') {
    void revokeTaskUrl(message.taskId);
    sendResponse({ ok: true });
  }
});

function enqueueHlsTask(message) {
  const job = {
    taskId: message.taskId,
    video: message.video,
    controller: new AbortController(),
    phase: 'queued'
  };
  jobs.set(job.taskId, job);
  jobQueue = jobQueue.then(() => runHlsTask(job), () => runHlsTask(job));
}

async function runHlsTask(job) {
  try {
    let retryCount = 0;
    while (true) {
      try {
        await runHlsAttempt(job);
        return;
      } catch (error) {
        const cancelled = job.controller.signal.aborted || error.name === 'AbortError';
        if (cancelled) {
          await VideoDownloader.cancelCurrent();
        }
        if (cancelled || !isRetryableHlsError(error)) {
          await revokeTaskUrl(job.taskId);
          await chrome.runtime.sendMessage({
            target: 'service-worker',
            type: 'hls:failed',
            taskId: job.taskId,
            cancelled,
            error: error.message || 'HLS 处理失败'
          }).catch(() => {});
          return;
        }

        await revokeTaskUrl(job.taskId);
        job.phase = 'retrying';
        await report(job, { status: 'processing', phase: 'retrying' });
        const delayMs = Math.min(30000, 1000 * (2 ** Math.min(retryCount, 5)));
        retryCount += 1;
        await waitForRetry(delayMs, job.controller.signal);
      }
    }
  } finally {
    jobs.delete(job.taskId);
    if (!jobs.size) {
      await VideoDownloader.dispose();
    }
  }
}

async function runHlsAttempt(job) {
  let referrerRuleInstalled = false;
  let lastProgressReportAt = 0;
  let lastProgressPhase = '';
  const progressReporter = createProgressReporter(job);
  try {
    assertNotCancelled(job);
    job.phase = 'fetching';
    await report(job, { status: 'processing', phase: 'fetching', progress: 0 });
    if (job.video.streamType === 'dash' || job.video.streamType === 'hls') {
      const response = await chrome.runtime.sendMessage({
        target: 'service-worker',
        type: 'hls:referrer:configure',
        taskId: job.taskId,
        video: job.video
      });
      if (!response?.ok) {
        throw new Error(response?.error || '无法设置媒体 Referer');
      }
      referrerRuleInstalled = true;
    }
    const result = await VideoDownloader.createDownloadUrl(job.video, {
      signal: job.controller.signal,
      onTracksFetched: async () => {
        referrerRuleInstalled = !(await clearMediaReferrerRule(job));
      },
      onProgress: (progress) => {
        job.phase = progress.phase;
        const now = Date.now();
        if (progress.phase !== lastProgressPhase ||
            now - lastProgressReportAt >= PROGRESS_REPORT_INTERVAL_MS) {
          lastProgressPhase = progress.phase;
          lastProgressReportAt = now;
          console.info(`[当前页视频下载器][${job.taskId}] 下载进度`, {
            stage: getProgressStage(job.video, progress),
            phase: progress.phase,
            percent: Number.isFinite(progress.progress)
              ? Math.round(progress.progress * 100)
              : null,
            current: progress.current,
            total: progress.total
          });
          progressReporter.enqueue(progress);
        }
      }
    });
    const download = typeof result === 'string'
      ? { url: result, extension: 'mp4' }
      : result;
    const { url, extension, opfsFileName } = download;
    blobUrls.set(job.taskId, url);
    if (opfsFileName) {
      opfsFiles.set(job.taskId, opfsFileName);
    }
    assertNotCancelled(job);
    job.phase = 'submitting';
    await progressReporter.enqueue({
      status: 'processing',
      phase: 'submitting',
      progress: 0.99
    });
    const response = await chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'hls:ready',
      taskId: job.taskId,
      url,
      extension
    });
    if (!response?.ok) {
      throw new Error(response?.error || '无法提交 Chrome 下载');
    }
  } finally {
    await progressReporter.flush();
    if (referrerRuleInstalled) {
      await clearMediaReferrerRule(job);
    }
  }
}

function isRetryableHlsError(error) {
  return /网络错误|请求超时|HTTP (?:408|429|5\d\d)\b|空间不足|QuotaExceededError/i
    .test(error.message || '');
}

function waitForRetry(delayMs, signal) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      resolve();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}

async function clearMediaReferrerRule(job) {
  const response = await chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'hls:referrer:clear',
    taskId: job.taskId
  }).catch(() => null);
  if (!response?.ok) {
    console.warn('[当前页视频下载器] 无法清理 DASH Referer 规则', response?.error || '后台不可用');
  }
  return response?.ok === true;
}

function cancelHlsTask(taskId) {
  const job = jobs.get(taskId);
  if (!job) {
    revokeTaskUrl(taskId);
    return;
  }
  job.controller.abort();
  if (job.phase === 'muxing') {
    void VideoDownloader.cancelCurrent();
  }
}

async function revokeTaskUrl(taskId) {
  const url = blobUrls.get(taskId);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrls.delete(taskId);
  }
  const fileName = opfsFiles.get(taskId);
  if (fileName) {
    opfsFiles.delete(taskId);
    try {
      const directory = await navigator.storage.getDirectory();
      await directory.removeEntry(fileName).catch((error) => {
        if (error.name !== 'NotFoundError') {
          throw error;
        }
      });
    } catch (error) {
      console.warn('[当前页视频下载器] 无法清理 OPFS 临时文件', error);
    }
  }
  void chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'hls:blob-revoked',
    taskId
  }).catch(() => {});
}

function report(job, progress) {
  return chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'hls:progress',
    taskId: job.taskId,
    ...progress
  }).catch(() => {});
}

function createProgressReporter(job) {
  let pendingProgress;
  let sending = false;
  let sendPromise = Promise.resolve();

  function enqueue(progress) {
    pendingProgress = progress;
    if (!sending) {
      sending = true;
      sendPromise = sendPendingProgress();
    }
    return sendPromise;
  }

  async function sendPendingProgress() {
    while (pendingProgress) {
      const progress = pendingProgress;
      pendingProgress = undefined;
      await report(job, progress);
    }
    sending = false;
  }

  return {
    enqueue,
    flush: () => sendPromise
  };
}

function assertNotCancelled(job) {
  if (job.controller.signal.aborted) {
    throw new DOMException('下载已取消', 'AbortError');
  }
}

function getProgressStage(video, progress) {
  if (video.streamType === 'dash' && progress.phase === 'fetching') {
    return progress.progress < 0.8 ? '下载视频轨' : '下载音频轨';
  }
  if (progress.phase === 'fetching') {
    return progress.current && progress.total ? '读取视频分片' : '下载媒体数据';
  }
  if (progress.phase === 'muxing') {
    return '合并视频和音轨';
  }
  return progress.phase;
}