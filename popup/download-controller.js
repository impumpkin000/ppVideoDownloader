import { t } from './i18n.js';

export class DownloadController {
  #downloadButtons = new Map();
  #downloadControls = new WeakMap();
  #latestTasks = new Map();
  #tabId;
  #pageUrl = '';
  #taskRefreshTimer;
  #restoringTasks = false;

  setPage(tabId, pageUrl) {
    this.#tabId = tabId;
    this.#pageUrl = pageUrl;
    this.#updateDownloadNotice();
  }

  hasActiveDownload() {
    return [...this.#latestTasks.values()].some((task) =>
      task.tabId === this.#tabId &&
      ['processing', 'retrying', 'downloading', 'cancelling'].includes(task.status)
    );
  }

  beginRender() {
    this.#downloadButtons.clear();
  }

  registerButton(button, video, variant, quality, variants, updateMetadata) {
    this.#downloadControls.set(button, { quality, variants, video, updateMetadata });
    this.#setButtonVariant(button, video, variant);
    const task = this.#latestTasks.get(button.dataset.taskKey);
    if (task) {
      this.#updateButton(button, task);
    }
  }

  async handleDownloadClick(button, video, variants, quality) {
    const activeTaskId = button.dataset.activeTaskId;
    if (activeTaskId) {
      button.querySelector('span').textContent = t('canceling');
      button.title = t('cancellingDownload');
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'download:cancel',
          taskId: activeTaskId
        });
        if (!response?.ok) {
          button.title = response?.error || t('cannotCancelDownload');
        }
      } catch {
        button.title = t('cannotConnectCancel');
      }
      return;
    }

    const selected = variants[Number(quality.value)] || variants[0];
    button.disabled = true;
    quality.disabled = true;
    button.querySelector('span').textContent = t('starting');
    button.title = '';
    let taskId = '';
    try {
      if (['hls', 'dash'].includes(selected.streamType)) {
        button.querySelector('span').textContent = t('authorizing');
        const origins = getMediaPermissionOrigins(selected);
        const granted = await chrome.permissions.request({ origins });
        if (!granted) {
          throw new Error(t('allowCdnAccess'));
        }
      }
      taskId = crypto.randomUUID();
      const taskKey = this.#getDownloadTaskKey(video, selected);
      const response = await chrome.runtime.sendMessage({
        type: 'download:start',
        taskId,
        taskKey,
        tabId: this.#tabId,
        pageUrl: this.#pageUrl,
        video: { ...selected, name: video.name }
      });
      if (!response?.ok) {
        throw new Error(response?.error || t('cannotStartDownload'));
      }
      this.rememberTask(response.task);
    } catch (error) {
      button.querySelector('span').textContent = t('failed');
      button.title = error.message || t('failed');
    } finally {
      button.disabled = false;
      const task = this.#latestTasks.get(button.dataset.taskKey);
      if (task) {
        this.#updateButton(button, task);
      } else {
        quality.disabled = false;
        if ([t('authorizing'), t('starting')].includes(button.querySelector('span').textContent)) {
          button.querySelector('span').textContent = t('download');
        }
      }
    }
  }

  rememberTask(task) {
    if (!task?.key) {
      return;
    }
    const button = this.#downloadButtons.get(task.key) || this.#findLegacyTaskButton(task);
    const current = this.#latestTasks.get(task.key);
    if (!current || (task.updatedAt || task.createdAt || 0) >=
        (current.updatedAt || current.createdAt || 0)) {
      this.#latestTasks.set(task.key, task);
    }
    this.#updateDownloadNotice();
    if (button) {
      this.#updateButton(button, this.#latestTasks.get(task.key));
    }
    if ([...this.#latestTasks.values()].some(hasActiveChromeDownload)) {
      this.#taskRefreshTimer ??= setInterval(() => { void this.restoreTasks(); }, 1000);
    } else if (this.#taskRefreshTimer) {
      clearInterval(this.#taskRefreshTimer);
      this.#taskRefreshTimer = undefined;
    }
  }

  async restoreTasks() {
    if (this.#restoringTasks) {
      return;
    }
    this.#restoringTasks = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'download:list' });
      if (!response?.ok) {
        return;
      }
      for (const task of response.tasks) {
        this.rememberTask(task);
      }
    } catch {
      return;
    } finally {
      this.#restoringTasks = false;
    }
  }

  #setButtonVariant(button, video, variant) {
    const taskKey = this.#getDownloadTaskKey(video, variant);
    const previousTaskKey = button.dataset.taskKey;
    if (previousTaskKey && previousTaskKey !== taskKey &&
        this.#downloadButtons.get(previousTaskKey) === button) {
      this.#downloadButtons.delete(previousTaskKey);
    }
    button.dataset.taskKey = taskKey;
    button.dataset.tabId = String(this.#tabId);
    button.dataset.videoName = video.name;
    button.dataset.requiresTranscoding = String(['hls', 'dash'].includes(variant.streamType));
    this.#downloadButtons.set(taskKey, button);
  }

  #getDownloadTaskKey(video, variant) {
    return JSON.stringify([
      this.#tabId,
      this.#getPageIdentity(),
      video.id || '',
      video.name || '',
      variant.streamType || 'file',
      variant.resolution || '',
      Number.isFinite(variant.bandwidth) ? variant.bandwidth : null,
      variant.files?.[0]?.url || ''
    ]);
  }

  #getPageIdentity() {
    try {
      const url = new URL(this.#pageUrl);
      url.hash = '';
      return url.href;
    } catch {
      return this.#pageUrl;
    }
  }

  #updateDownloadNotice() {
    const notice = document.querySelector('#download-notice');
    if (!notice) {
      return;
    }
    const isDownloading = this.hasActiveDownload();
    notice.textContent = isDownloading ? t('downloadingDoNotLeave') : '';
  }

  #findLegacyTaskButton(task) {
    if (!Number.isInteger(task.tabId) || task.tabId !== this.#tabId ||
        !['processing', 'retrying', 'downloading', 'cancelling'].includes(task.status)) {
      return undefined;
    }
    const requiresTranscoding = task.requiresTranscoding ?? task.isHls ?? false;
    const matches = [...this.#downloadButtons.values()].filter((button) =>
      button.dataset.tabId === String(task.tabId) &&
      button.dataset.videoName === (task.name || '') &&
      [...(this.#downloadControls.get(button)?.variants || [])].some((variant) =>
        variant.resolution === (task.resolution || '') &&
        ['hls', 'dash'].includes(variant.streamType) === requiresTranscoding)
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  #updateButton(button, task) {
    const label = button.querySelector('span');
    const isActive = ['processing', 'retrying', 'downloading', 'cancelling'].includes(task.status);
    const controls = this.#downloadControls.get(button);
    button.disabled = false;
    if (controls) {
      controls.quality.disabled = isActive;
    }
    if (isActive) {
      button.dataset.activeTaskId = task.id;
      const activeVariantIndex = controls?.variants.findIndex((variant) =>
        this.#getDownloadTaskKey(controls.video, variant) === task.key
      ) ?? -1;
      const fallbackVariantIndex = activeVariantIndex < 0
        ? controls?.variants.findIndex((variant) =>
            variant.resolution === (task.resolution || '') &&
            ['hls', 'dash'].includes(variant.streamType) ===
              (task.requiresTranscoding ?? task.isHls ?? false)
          ) ?? -1
        : activeVariantIndex;
      if (controls && fallbackVariantIndex >= 0) {
        controls.quality.value = String(fallbackVariantIndex);
        controls.updateMetadata(controls.variants[fallbackVariantIndex]);
        this.#setButtonVariant(button, controls.video, controls.variants[fallbackVariantIndex]);
      }
      if (task.status === 'cancelling') {
        label.textContent = t('canceling');
        button.title = t('cancellingDownload');
        return;
      }
      const phaseLabels = {
        queued: t('queued'),
        starting: t('starting'),
        fetching: t('processing'),
        muxing: t('processing'),
        submitting: t('submittingDownload'),
        downloading: t('downloading'),
        retrying: t('retrying')
      };
      const percentage = Number.isFinite(task.progress)
        ? ` ${Math.round(task.progress * 100)}%`
        : '';
      label.textContent = t('cancelWithProgress', percentage);
      button.title = t('clickToCancel', [phaseLabels[task.phase] || t('processing'), percentage]);
      return;
    }

    delete button.dataset.activeTaskId;
    if (task.status === 'complete') {
      button.title = t('completed');
      label.textContent = t('completed');
      return;
    }
    button.title = task.status === 'failed' ? task.error || t('failed') : '';
    label.textContent = task.status === 'failed' ? t('failed') : t('download');
  }
}

function getMediaPermissionOrigins(variant) {
  const urls = (variant.files || []).flatMap((file) => [
    file.url,
    file.audioUrl,
    ...(file.backupUrls || []),
    ...(file.audioBackupUrls || [])
  ]).filter(Boolean);
  const origins = new Set();
  for (const rawUrl of urls) {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(t('invalidPlaylistUrl'));
    }
    origins.add(`${url.origin}/*`);
  }
  if (!origins.size) {
    throw new Error(t('unavailablePlaylistUrl'));
  }
  return [...origins];
}

function hasActiveChromeDownload(task) {
  return task?.downloadId !== undefined && ['downloading', 'cancelling'].includes(task.status);
}
