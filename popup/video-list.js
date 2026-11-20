import { t } from './i18n.js';

export function renderVideos(videoList, videos, registerDownloadButton, handleDownloadClick) {
  if (!videos.length) {
    renderEmpty(videoList, t('noVideosYet'), t('playThenRescan'));
    return;
  }

  videoList.replaceChildren(...videos.map((video, index) => {
    const name = video.name?.trim() || '';
    return createVideoCard(
      {
        ...video,
        name: !name || /^(视频|Video|動画) \d+$/.test(name)
          ? t('videoName', String(index + 1))
          : name
      },
      registerDownloadButton,
      handleDownloadClick
    );
  }));
}

export function renderEmpty(videoList, title, description) {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const mark = document.createElement('span');
  mark.className = 'empty-mark';
  mark.textContent = '▶';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const detail = document.createElement('p');
  detail.textContent = description;
  empty.append(mark, heading, detail);
  videoList.replaceChildren(empty);
}

function createVideoCard(video, registerDownloadButton, handleDownloadClick) {
  const card = document.createElement('article');
  card.className = 'video-card';
  const variants = video.variants?.length ? video.variants : [video];

  const preview = document.createElement('div');
  preview.className = 'preview';
  preview.setAttribute('aria-label', t('videoPreview'));
  const fallback = createFallback();
  preview.append(fallback);
  const hasThumbnail = /^https?:\/\//i.test(video.thumbnail || '');
  if (hasThumbnail) {
    const thumbnail = document.createElement('img');
    thumbnail.className = 'preview-frame';
    thumbnail.alt = '';
    thumbnail.addEventListener('load', () => {
      if (preview.contains(fallback)) {
        preview.replaceChildren(thumbnail);
      }
    }, { once: true });
    thumbnail.addEventListener('error', () => {
      preview.dataset.thumbnailUnavailable = 'true';
      loadFirstFrame(preview, selectLowestResolutionVariant(variants));
    }, { once: true });
    thumbnail.src = video.thumbnail.replace(/^http:/i, 'https:');
  } else {
    loadFirstFrame(preview, selectLowestResolutionVariant(variants));
  }

  const info = document.createElement('div');
  info.className = 'video-info';
  const name = document.createElement('h2');
  name.className = 'video-name';
  name.textContent = video.name;
  name.title = name.textContent;
  if (video.episodeName) {
    const episodeName = document.createElement('span');
    episodeName.className = 'episode-name';
    episodeName.textContent = video.episodeName;
    episodeName.title = episodeName.textContent;
    info.append(episodeName);
  }
  const meta = document.createElement('div');
  meta.className = 'video-meta';
  const duration = document.createElement('span');
  duration.textContent = formatDuration(video.duration);
  const size = document.createElement('span');
  const resolution = document.createElement('span');
  const updateMetadata = (variant) => {
    duration.textContent = formatDuration(variant.duration ?? video.duration);
    const formattedSize = formatFileSize(variant.size);
    size.textContent = variant.sizeEstimated && formattedSize !== t('unknownSize')
      ? t('estimatedSize', formattedSize)
      : formattedSize;
    resolution.textContent = formatVariantQuality(variant);
  };
  updateMetadata(video.variants?.[0] || video);
  meta.append(duration, size, resolution);

  const controls = document.createElement('div');
  controls.className = 'video-controls';
  const quality = document.createElement('select');
  quality.className = 'quality-select';
  quality.setAttribute('aria-label', t('selectQuality'));
  variants.forEach((variant, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = formatVariantQuality(variant);
    quality.append(option);
  });
  quality.hidden = variants.length < 2;
  quality.addEventListener('change', () => {
    const variant = variants[Number(quality.value)] || variants[0];
    updateMetadata(variant);
    registerDownloadButton(download, video, variant, quality, variants, updateMetadata);
  });

  const download = document.createElement('button');
  download.className = 'download-button';
  download.type = 'button';
  download.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v3h14v-3"/></svg>';
  const downloadLabel = document.createElement('span');
  downloadLabel.textContent = t('download');
  download.append(downloadLabel);
  download.addEventListener('click', () =>
    handleDownloadClick(download, video, variants, quality)
  );
  registerDownloadButton(
    download,
    video,
    variants[Number(quality.value)] || variants[0],
    quality,
    variants,
    updateMetadata
  );

  controls.append(quality, download);
  info.append(name, meta, controls);
  card.append(preview, info);
  return card;
}

function createFallback() {
  const fallback = document.createElement('span');
  fallback.className = 'preview-fallback';
  fallback.textContent = '▶';
  return fallback;
}

function selectLowestResolutionVariant(variants) {
  return variants.reduce((lowest, candidate) => {
    const candidateScore = getResolutionScore(candidate.resolution);
    const lowestScore = getResolutionScore(lowest.resolution);
    if (!candidateScore) {
      return lowest;
    }
    return !lowestScore || candidateScore < lowestScore ? candidate : lowest;
  }, variants[0]);
}

function getResolutionScore(resolution = '') {
  const dimensions = resolution.match(/(\d{2,4})x(\d{2,4})/i);
  if (dimensions) {
    return Number(dimensions[1]) * Number(dimensions[2]);
  }
  const height = /^4k$/i.test(resolution)
    ? 2160
    : Number(resolution.match(/(\d{3,4})p?/i)?.[1]) || 0;
  return height ? Math.round(height * height * 16 / 9) : 0;
}

function formatVariantQuality(variant) {
  const resolution = variant.resolution || t('unknownResolution');
  if (!Number.isFinite(variant.bandwidth) || variant.bandwidth <= 0) {
    return resolution;
  }

  const bitrate = variant.bandwidth >= 1_000_000
    ? `${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(variant.bandwidth / 1_000)} kbps`;
  const displayedBitrate = variant.bandwidthEstimated
    ? t('estimatedBitrate', bitrate)
    : bitrate;
  return t('qualityWithBitrate', [resolution, displayedBitrate]);
}

function loadFirstFrame(preview, variant) {
  const file = variant?.files?.find((item) => /^https?:/.test(item.url || ''));
  if (!file) {
    return;
  }

  const frame = document.createElement('video');
  frame.className = 'preview-frame';
  frame.preload = 'auto';
  frame.muted = true;
  frame.playsInline = true;
  frame.setAttribute('aria-hidden', 'true');
  let seekRequested = false;
  let previewShown = false;
  const showFrame = () => {
    if (previewShown || frame.readyState < 2) {
      return;
    }
    previewShown = true;
    frame.pause();
    preview.replaceChildren(frame);
  };
  frame.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(frame.duration) || frame.duration <= 0) {
      return;
    }
    const previewTime = Math.min(2, Math.max(0.5, frame.duration * 0.1), frame.duration - 0.05);
    if (previewTime <= frame.currentTime) {
      return;
    }
    seekRequested = true;
    frame.addEventListener('seeked', showFrame, { once: true });
    try {
      frame.currentTime = previewTime;
      setTimeout(showFrame, 5000);
    } catch {
      seekRequested = false;
      showFrame();
    }
  }, { once: true });
  frame.addEventListener('loadeddata', () => {
    if (!seekRequested) {
      showFrame();
    }
  });
  frame.addEventListener('error', () => {
    preview.dataset.previewUnavailable = 'true';
  }, { once: true });
  frame.src = file.url;
  frame.load();
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return t('unknownDuration');
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return t('unknownSize');
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex ? 1 : 0)} ${units[unitIndex]}`;
}
