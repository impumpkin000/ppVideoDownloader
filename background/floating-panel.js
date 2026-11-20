chrome.action.onClicked.addListener((tab) => {
  if (!Number.isInteger(tab.id) || !/^https?:/i.test(tab.url || '')) {
    console.warn('[当前页视频下载器] 当前页面不支持浮动面板');
    return;
  }

  const panelUrl = new URL(chrome.runtime.getURL('popup.html'));
  panelUrl.searchParams.set('tabId', String(tab.id));
  panelUrl.searchParams.set('embedded', '1');
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: toggleFloatingPanel,
    args: [panelUrl.href, chrome.i18n.getMessage('appTitle')]
  }).catch((error) => {
    console.error('[当前页视频下载器] 无法打开浮动面板', error);
  });
});

async function removeFloatingPanel(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const panel = document.getElementById('pp-video-downloader-floating-panel');
      panel?.__ppVideoDownloaderCleanup?.();
      panel?.remove();
    }
  });
}

function toggleFloatingPanel(panelUrl, title) {
  const panelId = 'pp-video-downloader-floating-panel';
  const existingPanel = document.getElementById(panelId);
  if (existingPanel) {
    existingPanel.__ppVideoDownloaderRestoreOnFocus = false;
    existingPanel.hidden = existingPanel.__ppVideoDownloaderDownloadInProgress
      ? false
      : !existingPanel.hidden;
    return;
  }

  const host = document.createElement('div');
  host.id = panelId;
  host.__ppVideoDownloaderDownloadInProgress = false;
  host.__ppVideoDownloaderRestoreOnFocus = false;
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      position: fixed !important;
      z-index: 2147483647 !important;
      top: 0 !important;
      right: 0 !important;
      display: block !important;
      width: min(390px, 100vw) !important;
      height: min(624px, 100vh) !important;
      min-height: min(260px, 100vh) !important;
      color: #172321;
      font: 13px "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    :host([hidden]) {
      display: none !important;
    }
    .panel {
      display: flex;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      flex-direction: column;
      overflow: hidden;
      background: #f7f8f3;
      border: 1px solid #d5ded8;
      border-radius: 0;
      box-shadow: 0 2px 8px rgb(0 0 0 / 18%);
    }
    iframe {
      display: block;
      width: 100%;
      min-height: 0;
      flex: 1;
      border: 0;
      background: #f7f8f3;
    }
  `;

  const panel = document.createElement('section');
  panel.className = 'panel';
  const frame = document.createElement('iframe');
  frame.title = title;
  frame.src = panelUrl;
  panel.append(frame);
  shadow.append(style, panel);
  document.documentElement.append(host);

  const hidePanel = (force = false, restoreOnFocus = false) => {
    if (host.__ppVideoDownloaderDownloadInProgress && !force) {
      return;
    }
    if (host.hidden) {
      return;
    }
    host.hidden = true;
    host.__ppVideoDownloaderRestoreOnFocus = restoreOnFocus;
  };
  const restorePanelOnFocus = () => {
    if (host.__ppVideoDownloaderRestoreOnFocus &&
        !host.__ppVideoDownloaderDownloadInProgress &&
        document.visibilityState !== 'hidden') {
      host.__ppVideoDownloaderRestoreOnFocus = false;
      host.hidden = false;
    }
  };
  const hidePanelIfOutside = (event) => {
    if (!host.contains(event.target)) {
      host.__ppVideoDownloaderRestoreOnFocus = false;
      hidePanel();
    }
  };
  const hidePanelOnEscape = (event) => {
    if (event.key === 'Escape') {
      host.__ppVideoDownloaderRestoreOnFocus = false;
      hidePanel(true);
    }
  };
  const hidePanelWhenHidden = () => {
    if (document.visibilityState === 'hidden') {
      hidePanel(false, true);
    } else {
      restorePanelOnFocus();
    }
  };
  const hidePanelOnFrameBlur = (event) => {
    if (event.source === frame.contentWindow &&
        event.origin === new URL(frame.src).origin &&
        event.data?.type === 'pp-video-downloader:blur') {
      hidePanel(false, true);
    }
  };
  const hidePanelOnFrameClose = (event) => {
    if (event.source === frame.contentWindow &&
        event.origin === new URL(frame.src).origin &&
        event.data?.type === 'pp-video-downloader:close') {
      host.__ppVideoDownloaderRestoreOnFocus = false;
      hidePanel(true);
    }
  };
  const updateDownloadState = (event) => {
    if (event.source === frame.contentWindow &&
        event.origin === new URL(frame.src).origin &&
        event.data?.type === 'pp-video-downloader:download-state' &&
        typeof event.data.active === 'boolean') {
      host.__ppVideoDownloaderDownloadInProgress = event.data.active;
      if (!event.data.active) {
        restorePanelOnFocus();
      }
    }
  };
  document.addEventListener('pointerdown', hidePanelIfOutside, true);
  document.addEventListener('focusin', hidePanelIfOutside, true);
  document.addEventListener('keydown', hidePanelOnEscape, true);
  document.addEventListener('visibilitychange', hidePanelWhenHidden);
  window.addEventListener('focus', restorePanelOnFocus);
  window.addEventListener('message', hidePanelOnFrameBlur);
  window.addEventListener('message', hidePanelOnFrameClose);
  window.addEventListener('message', updateDownloadState);
  host.__ppVideoDownloaderCleanup = () => {
    document.removeEventListener('pointerdown', hidePanelIfOutside, true);
    document.removeEventListener('focusin', hidePanelIfOutside, true);
    document.removeEventListener('keydown', hidePanelOnEscape, true);
    document.removeEventListener('visibilitychange', hidePanelWhenHidden);
    window.removeEventListener('focus', restorePanelOnFocus);
    window.removeEventListener('message', hidePanelOnFrameBlur);
    window.removeEventListener('message', hidePanelOnFrameClose);
    window.removeEventListener('message', updateDownloadState);
  };
}

globalThis.FloatingPanel = { removeFromTab: removeFloatingPanel };
