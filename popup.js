import { DownloadController } from './popup/download-controller.js';
import { scanVideos } from './popup/video-scanner.js';
import { renderEmpty, renderVideos } from './popup/video-list.js';
import { setDocumentLanguage, t } from './popup/i18n.js';

setDocumentLanguage();
document.title = t('appTitle');
document.querySelector('#app-title').textContent = t('appTitle');

const isEmbedded = new URLSearchParams(location.search).has('embedded');
if (isEmbedded) {
  document.documentElement.classList.add('embedded');
  window.addEventListener('blur', () => {
    window.parent.postMessage({ type: 'pp-video-downloader:blur' }, '*');
  });
  document.addEventListener('wheel', (event) => {
    const scrollableList = event.target instanceof Element
      ? event.target.closest('.video-list')
      : null;
    if (!scrollableList || event.deltaX !== 0) {
      event.preventDefault();
      return;
    }

    const maxScrollTop = scrollableList.scrollHeight - scrollableList.clientHeight;
    const canScroll = event.deltaY < 0
      ? scrollableList.scrollTop > 0
      : event.deltaY > 0 && scrollableList.scrollTop < maxScrollTop;
    if (!canScroll) {
      event.preventDefault();
    }
  }, { capture: true, passive: false });
}

const scanButton = document.querySelector('#scan-button');
const closePanelButton = document.querySelector('#close-panel-button');
const statusRow = document.querySelector('.status-row');
const statusText = document.querySelector('#status-text');
const videoCount = document.querySelector('#video-count');
const videoList = document.querySelector('#video-list');
const downloadController = new DownloadController();
scanButton.title = t('rescan');
scanButton.setAttribute('aria-label', t('rescan'));
closePanelButton.textContent = 'X';
closePanelButton.title = t('closeFloatingPanel');
closePanelButton.setAttribute('aria-label', t('closeFloatingPanel'));
videoList.setAttribute('aria-label', t('videoListLabel'));

if (isEmbedded) {
  closePanelButton.addEventListener('click', () => {
    window.parent.postMessage({ type: 'pp-video-downloader:close' }, '*');
  });
}

const reportEmbeddedDownloadState = () => {
  if (isEmbedded) {
    window.parent.postMessage({
      type: 'pp-video-downloader:download-state',
      active: downloadController.hasActiveDownload()
    }, '*');
  }
};

void downloadController.restoreTasks().then(reportEmbeddedDownloadState);

chrome.runtime.onMessage.addListener((message) => {
  if (message.target === 'popup' && message.type === 'task:update') {
    downloadController.rememberTask(message.task);
    reportEmbeddedDownloadState();
  }
});

scanButton.addEventListener('click', () => scanCurrentTab(true));
void scanCurrentTab();

async function scanCurrentTab(forceRefresh = false) {
  scanButton.disabled = true;
  statusRow.className = 'status-row';
  statusRow.title = '';
  statusText.textContent = t('scanning');
  videoCount.textContent = '';
  videoList.replaceChildren();

  try {
    const requestedTabId = Number(new URLSearchParams(location.search).get('tabId'));
    const tab = Number.isInteger(requestedTabId) && requestedTabId > 0
      ? await chrome.tabs.get(requestedTabId).catch(() => undefined)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !/^https?:/.test(tab.url || '')) {
      throw new Error(t('pageUnsupported'));
    }

    downloadController.setPage(tab.id, tab.url);
    reportEmbeddedDownloadState();
    const { videos, cached, failedEpisodes = [], totalEpisodes = 0 } =
      await scanVideos(tab, forceRefresh);
    downloadController.beginRender();
    renderVideos(
      videoList,
      videos,
      (...args) => downloadController.registerButton(...args),
      (...args) => downloadController.handleDownloadClick(...args)
    );
    statusRow.classList.add('ready');
    statusText.textContent = failedEpisodes.length
      ? t('partialEpisodeScan', [
          String(totalEpisodes - failedEpisodes.length),
          String(totalEpisodes),
          String(failedEpisodes.length)
        ])
      : videos.length
        ? cached ? t('cachedResults') : t('scanComplete')
        : t('noDirectVideos');
    if (failedEpisodes.length) {
      statusRow.title = failedEpisodes
        .map(({ name, error }) => `${name}: ${error}`)
        .join('\n');
    }
    videoCount.textContent = videos.length ? t('videoCount', String(videos.length)) : '';
  } catch (error) {
    statusRow.classList.add('error');
    statusText.textContent = error.message || t('scanFailed');
    renderEmpty(videoList, t('cannotReadPage'), t('openRegularPage'));
  } finally {
    scanButton.disabled = false;
  }
}
