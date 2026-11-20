const SCAN_CACHE_PREFIX = 'videoScanCache:v9:';

export async function scanVideos(tab, forceRefresh = false) {
  const cacheKey = `${SCAN_CACHE_PREFIX}${tab.id}`;
  const cachePageUrl = getCachePageUrl(tab.url);
  if (!forceRefresh) {
    const cachedScan = await loadCachedVideos(cacheKey, cachePageUrl);
    if (cachedScan) {
      return { ...cachedScan, cached: true };
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: 'MAIN',
    files: ['video-sniffer.js']
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: 'MAIN',
    func: () => globalThis.VideoSniffer.collectAllVideos()
  });
  const allEpisodesResult = results.find(({ frameId, result }) =>
    frameId === 0 && result?.allEpisodes
  )?.result;
  const videos = allEpisodesResult
    ? allEpisodesResult.videos
    : results.flatMap(({ result }) => result?.videos || []);
  const failedEpisodes = allEpisodesResult?.failedEpisodes || [];
  const totalEpisodes = allEpisodesResult?.totalEpisodes || 0;
  await resolveVideoDurations(videos);
  resolveVideoBitrates(videos);
  resolveVideoSizes(videos);
  const scan = { videos, failedEpisodes, totalEpisodes };
  await saveCachedVideos(cacheKey, cachePageUrl, scan);
  return { ...scan, cached: false };
}

function getCachePageUrl(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (/(^|\.)bilibili\.com$/i.test(url.hostname)) {
      url.searchParams.delete('p');
    }
    return url.href;
  } catch {
    return pageUrl;
  }
}

async function loadCachedVideos(cacheKey, pageUrl) {
  try {
    const stored = await chrome.storage.session.get(cacheKey);
    const cache = stored[cacheKey];
    return cache?.pageUrl === pageUrl && Array.isArray(cache.videos)
      ? {
          videos: cache.videos,
          failedEpisodes: Array.isArray(cache.failedEpisodes) ? cache.failedEpisodes : [],
          totalEpisodes: Number(cache.totalEpisodes) || 0
        }
      : null;
  } catch {
    return null;
  }
}

async function saveCachedVideos(cacheKey, pageUrl, scan) {
  try {
    await chrome.storage.session.set({ [cacheKey]: { pageUrl, ...scan } });
  } catch {
    return;
  }
}

function resolveVideoBitrates(videos) {
  for (const video of videos) {
    const variants = video.variants?.length ? video.variants : [video];
    for (const variant of variants) {
      if (Number.isFinite(variant.bandwidth) && variant.bandwidth > 0) {
        continue;
      }
      const duration = variant.duration ?? video.duration;
      if (!variant.sizeEstimated && Number.isFinite(variant.size) && variant.size > 0 &&
          Number.isFinite(duration) && duration > 0) {
        variant.bandwidth = variant.size * 8 / duration;
        variant.bandwidthEstimated = true;
      }
    }
  }
}

function resolveVideoSizes(videos) {
  for (const video of videos) {
    const variants = video.variants?.length ? video.variants : [video];
    for (const variant of variants) {
      if (Number.isFinite(variant.size) && variant.size > 0) {
        continue;
      }
      const duration = variant.duration ?? video.duration;
      const bitrate = estimateBitrate(variant.resolution || video.resolution);
      if (Number.isFinite(duration) && duration > 0 && bitrate) {
        variant.size = bitrate * duration / 8;
        variant.sizeEstimated = true;
      }
    }
  }
}

function estimateBitrate(resolution = '') {
  const dimensions = resolution.match(/(\d{2,4})x(\d{2,4})/i);
  const height = dimensions
    ? Number(dimensions[2])
    : /^4k$/i.test(resolution)
      ? 2160
      : Number(resolution.match(/(\d{3,4})p?/i)?.[1]) || 0;
  if (!height) {
    return null;
  }
  if (height <= 360) return 500_000;
  if (height <= 480) return 900_000;
  if (height <= 720) return 2_000_000;
  if (height <= 1080) return 4_500_000;
  if (height <= 1440) return 8_000_000;
  return 16_000_000;
}

async function resolveVideoDurations(videos) {
  await Promise.all(videos.map(async (video) => {
    const variants = video.variants?.length ? video.variants : [video];
    const knownDuration = variants.find((variant) => Number.isFinite(variant.duration))?.duration;
    if (Number.isFinite(video.duration) || Number.isFinite(knownDuration)) {
      video.duration ??= knownDuration;
      return;
    }
    const file = variants.find((variant) => !['hls', 'dash'].includes(variant.streamType))?.files?.[0];
    if (!file?.url) {
      return;
    }
    const duration = await readRemoteVideoDuration(file.url);
    if (Number.isFinite(duration)) {
      video.duration = duration;
      variants.forEach((variant) => { variant.duration ??= duration; });
    }
  }));
}

function readRemoteVideoDuration(url) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    const finish = () => {
      clearTimeout(timeout);
      const duration = Number.isFinite(probe.duration) ? probe.duration : null;
      probe.removeAttribute('src');
      probe.load();
      resolve(duration);
    };
    const timeout = setTimeout(finish, 8000);
    probe.preload = 'metadata';
    probe.muted = true;
    probe.addEventListener('loadedmetadata', finish, { once: true });
    probe.addEventListener('error', finish, { once: true });
    probe.src = url;
    probe.load();
  });
}
