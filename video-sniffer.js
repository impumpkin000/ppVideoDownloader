globalThis.VideoSniffer = (() => {
  const VIDEO_EXTENSIONS = /\.(?:mp4|m4v|webm|mov|ogv)(?:\/?[?#]|\/?$)/i;
  const HLS_EXTENSION = /\.m3u8(?:[?#]|$)/i;
  const QUALITY_MARKER = /(?:[._-])(\d{3,4})p?(?=[._-]|$)/i;
  const MIN_VIDEO_SIZE = 100 * 1024;
  const PLAY_URL_KEY = '__ppVideoDownloaderPlayUrl';
  const observedHlsUrls = globalThis.__ppVideoDownloaderHlsUrls || new Set();
  globalThis.__ppVideoDownloaderHlsUrls = observedHlsUrls;
  observePlayUrlRequests();

  if (typeof PerformanceObserver !== 'undefined' &&
      !globalThis.__ppVideoDownloaderHlsObserver) {
    const hlsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (HLS_EXTENSION.test(entry.name) && !observedHlsUrls.has(entry.name)) {
          observedHlsUrls.add(entry.name);
          if (observedHlsUrls.size > 256) {
            observedHlsUrls.delete(observedHlsUrls.values().next().value);
          }
        }
      }
    });
    hlsObserver.observe({ type: 'resource', buffered: true });
    globalThis.__ppVideoDownloaderHlsObserver = hlsObserver;
  }

  async function collectVideos(attempt = 0) {
    const bilibiliPlayback = getBilibiliPlayback();
    if (bilibiliPlayback) {
      if (!bilibiliPlayback.data && attempt < 20) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return collectVideos(attempt + 1);
      }
      if (!bilibiliPlayback.data) {
        return [];
      }
      const dashSources = [];
      collectDashSourcesFromData(bilibiliPlayback.data, dashSources);
      return createDashVideos(dashSources, getPageThumbnail()).map((video, index) => ({
        ...video,
        name: video.name?.trim() || `视频 ${index + 1}`
      }));
    }

    const candidates = new Map();
    const hlsSources = new Map();
    const dashSources = [];
    const decorativeUrls = new Set();
    const pageThumbnail = getPageThumbnail();
    const elements = [...document.querySelectorAll('video')];

    for (const url of observedHlsUrls) {
      addHlsSource(hlsSources, url);
    }

    for (const [elementIndex, video] of elements.entries()) {
      const sources = [video.currentSrc, video.getAttribute('src')];
      sources.push(...[...video.querySelectorAll('source')].map((source) => source.src));
      if (isDecorativeVideo(video)) {
        sources.filter(Boolean).forEach((url) => decorativeUrls.add(url));
        continue;
      }
      for (const url of sources) {
        if (HLS_EXTENSION.test(url || '')) {
          addHlsSource(hlsSources, url, { video, standalone: true });
        } else {
          addCandidate(candidates, url, video, elementIndex);
        }
      }
    }

    for (const script of document.scripts) {
      const sourcePattern = /\b(video_(?:url|alt_url\d*))\s*:\s*(['"])(https?:\/\/.*?)\2/g;
      for (const match of script.textContent.matchAll(sourcePattern)) {
        addCandidate(candidates, match[3], null, null);
      }
      collectHlsSourcesFromText(script.textContent, hlsSources);
      const playInfo = parsePlayInfo(script.textContent);
      if (playInfo) {
        collectDashSourcesFromData(playInfo, dashSources);
      }
    }
    collectDashSourcesFromData(globalThis.__playinfo__, dashSources);
    collectPlayerMediaDefinitions(hlsSources);

    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (!attribute.value.includes('.m3u8')) {
          continue;
        }
        collectHlsSourcesFromText(attribute.value, hlsSources, { standalone: true });
        try {
          collectHlsSourcesFromData(JSON.parse(attribute.value), hlsSources);
        } catch {
          continue;
        }
      }
    }

    for (const entry of performance.getEntriesByType('resource')) {
      if (HLS_EXTENSION.test(entry.name)) {
        addHlsSource(hlsSources, entry.name);
        continue;
      }
      if (decorativeUrls.has(entry.name)) {
        continue;
      }
      if (VIDEO_EXTENSIONS.test(entry.name) || entry.initiatorType === 'video') {
        const size = entry.encodedBodySize || entry.decodedBodySize || entry.transferSize;
        addCandidate(candidates, entry.name, null, null, size);
      }
    }

    const groupedCandidates = [...candidates.values()].filter((candidate) =>
      candidate.size === null || candidate.size >= MIN_VIDEO_SIZE);
    const parents = groupedCandidates.map((_, index) => index);
    const findRoot = (index) => {
      if (parents[index] !== index) {
        parents[index] = findRoot(parents[index]);
      }
      return parents[index];
    };
    const mergeGroups = (left, right) => {
      const leftRoot = findRoot(left);
      const rightRoot = findRoot(right);
      if (leftRoot !== rightRoot) {
        parents[rightRoot] = leftRoot;
      }
    };
    const normalizedGroups = new Map();
    const qualityVariantGroups = new Map();
    const playerGroups = new Map();
    groupedCandidates.forEach((candidate, index) => {
      const normalizedUrl = normalizeVideoUrl(candidate.url);
      if (normalizedGroups.has(normalizedUrl)) {
        mergeGroups(index, normalizedGroups.get(normalizedUrl));
      } else {
        normalizedGroups.set(normalizedUrl, index);
      }
      const qualityVariantGroup = getQualityVariantGroup(candidate.url);
      if (qualityVariantGroup) {
        if (qualityVariantGroups.has(qualityVariantGroup)) {
          mergeGroups(index, qualityVariantGroups.get(qualityVariantGroup));
        } else {
          qualityVariantGroups.set(qualityVariantGroup, index);
        }
      }
      if (candidate.elementIndex !== null) {
        if (playerGroups.has(candidate.elementIndex)) {
          mergeGroups(index, playerGroups.get(candidate.elementIndex));
        } else {
          playerGroups.set(candidate.elementIndex, index);
        }
      }
    });

    const groups = new Map();
    groupedCandidates.forEach((candidate, index) => {
      const root = findRoot(index);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root).push(candidate);
    });

    const videos = [...groups.values()].map((variants, index) => {
      const first = variants[0];
      const video = variants.find((variant) => variant.video)?.video;
      const name = video?.getAttribute('aria-label') ||
        video?.getAttribute('title') || '';
      const uniqueVariants = [];
      const variantsBySource = new Map();
      for (const variant of variants) {
        const resolution = getResolutionFromUrl(variant.url) || variant.resolution || '未知画质';
        const sourceKey = getVariantIdentityKey(variant);
        const existing = variantsBySource.get(sourceKey);
        if (existing) {
          if (existing.size === null && variant.size !== null) {
            existing.size = variant.size;
            existing.sizeEstimated = variant.sizeEstimated === true;
          }
          continue;
        }
        const uniqueVariant = {
          resolution,
          bandwidth: variant.bandwidth,
          size: variant.size,
          sizeEstimated: variant.sizeEstimated === true,
          files: [{ filename: getFileName(variant.url), url: variant.url }]
        };
        uniqueVariants.push(uniqueVariant);
        if (resolution !== '未知画质') {
          variantsBySource.set(sourceKey, uniqueVariant);
        }
      }
      return {
        id: `video-${index + 1}`,
        name: name.trim(),
        thumbnail: video?.poster || '',
        duration: Number.isFinite(video?.duration) ? video.duration : null,
        variants: uniqueVariants.sort(compareVariantsByQuality),
        resolution: getResolutionFromUrl(first.url) || first.resolution || '未知画质',
        files: first.files
      };
    });

    const detectedVideos = videos.map((video, index) => ({
      ...video,
      id: `video-${index + 1}`
    }));
    const allVideos = [
      ...detectedVideos,
      ...createDashVideos(dashSources, pageThumbnail),
      ...await collectHlsVideos([...hlsSources.values()])
    ];
    return allVideos.map((video, index) => ({
      ...video,
      name: video.name?.trim() || `视频 ${index + 1}`
    }));
  }

  async function collectAllVideos() {
    const state = globalThis.__INITIAL_STATE__;
    const episodes = state?.videoData?.pages;
    if (!/(^|\.)bilibili\.com$/i.test(location.hostname) ||
        !Array.isArray(episodes) || !episodes.length || !state.aid || !state.bvid) {
      return {
        allEpisodes: false,
        videos: await collectVideos(),
        failedEpisodes: [],
        totalEpisodes: 0
      };
    }

    const pageThumbnail = getPageThumbnail();
    const results = await mapWithConcurrency(episodes, 4, async (episode) => {
      const name = String(episode.part || `P${episode.page || ''}`);
      const cid = String(episode.cid || '');
      if (!cid) {
        return { videos: [], failure: { name, error: 'cid 不存在' } };
      }

      try {
        const url = new URL('/x/player/playurl', 'https://api.bilibili.com');
        url.search = new URLSearchParams({
          avid: String(state.aid),
          bvid: String(state.bvid),
          cid,
          qn: '0',
          fnver: '0',
          fnval: '4048',
          fourk: '1'
        }).toString();
        const response = await fetch(url.href, { credentials: 'include' });
        const payload = await response.json();
        if (!response.ok || payload.code !== 0) {
          throw new Error(payload.message || `HTTP ${response.status}`);
        }

        const sources = [];
        collectDashSourcesFromData(payload.data, sources);
        const videos = createDashVideos(sources, pageThumbnail).map((video, index) => ({
          ...video,
          id: `bilibili-${cid}-${index + 1}`,
          episodeName: name,
          name: `${name} - ${video.name || '视频'}`
        }));
        return videos.length
          ? { videos }
          : { videos: [], failure: { name, error: '未返回可用的视频流' } };
      } catch (error) {
        return {
          videos: [],
          failure: { name, error: error?.message || '请求失败' }
        };
      }
    });

    return {
      allEpisodes: true,
      videos: results.flatMap((result) => result.videos),
      failedEpisodes: results.flatMap((result) => result.failure ? [result.failure] : []),
      totalEpisodes: episodes.length
    };
  }

  async function mapWithConcurrency(items, concurrency, callback) {
    const results = Array(items.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await callback(items[index]);
      }
    }));
    return results;
  }

  function observePlayUrlRequests() {
    if (!/(^|\.)bilibili\.com$/i.test(location.hostname) ||
        globalThis.__ppVideoDownloaderPlayUrlObserverInstalled) {
      return;
    }
    globalThis.__ppVideoDownloaderPlayUrlObserverInstalled = true;

    const isPlayUrl = (rawUrl) => {
      try {
        return new URL(rawUrl, document.baseURI).pathname.endsWith('/playurl');
      } catch {
        return false;
      }
    };
    const savePlayUrl = (rawUrl, response) => {
      if (!isPlayUrl(rawUrl)) {
        return;
      }
      try {
        const cid = new URL(rawUrl, document.baseURI).searchParams.get('cid');
        if (cid && response?.code === 0 && response.data?.dash?.video?.length) {
          globalThis[PLAY_URL_KEY] = { cid, data: response.data };
        }
      } catch {
        return;
      }
    };

    if (typeof globalThis.fetch === 'function') {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = function (...args) {
        const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        return originalFetch.apply(this, args).then((response) => {
          if (isPlayUrl(requestUrl)) {
            void response.clone().json()
              .then((data) => savePlayUrl(requestUrl, data))
              .catch(() => {});
          }
          return response;
        });
      };
    }

    if (typeof globalThis.XMLHttpRequest === 'function') {
      const requestUrls = new WeakMap();
      const { open, send } = globalThis.XMLHttpRequest.prototype;
      globalThis.XMLHttpRequest.prototype.open = function (method, url, ...args) {
        requestUrls.set(this, String(url));
        return open.call(this, method, url, ...args);
      };
      globalThis.XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
          const requestUrl = requestUrls.get(this);
          if (!isPlayUrl(requestUrl)) {
            return;
          }
          try {
            const response = this.responseType === 'json'
              ? this.response
              : JSON.parse(this.responseText);
            savePlayUrl(requestUrl, response);
          } catch {
            return;
          }
        }, { once: true });
        return send.apply(this, args);
      };
    }
  }

  function getBilibiliPlayback() {
    if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) {
      return null;
    }
    const state = globalThis.__INITIAL_STATE__;
    const pageNumber = Number(new URL(location.href).searchParams.get('p')) || 1;
    const pageCid = state?.videoData?.pages?.find((page) =>
      Number(page.page) === pageNumber
    )?.cid;
    const cid = String(pageCid || state?.cid || '');
    if (!cid) {
      return null;
    }

    const observed = globalThis[PLAY_URL_KEY];
    if (observed?.cid === cid) {
      return { cid, data: observed.data };
    }

    const initialData = globalThis.__playinfo__?.data;
    const sources = [];
    if (initialData) {
      collectDashSourcesFromData(initialData, sources);
    }
    const hasCurrentCid = sources.some((source) => source.variants.some((variant) =>
      variant.files.some((file) => {
        try {
          return new URL(file.url).pathname.split('/').includes(cid);
        } catch {
          return false;
        }
      })
    ));
    return { cid, data: hasCurrentCid ? initialData : null };
  }

  function getPageThumbnail() {
    const rawThumbnail = document.querySelector('meta[property="og:image"]')?.content ||
      document.querySelector('meta[name="twitter:image"]')?.content || '';
    if (!rawThumbnail) {
      return '';
    }
    try {
      const thumbnail = new URL(rawThumbnail, document.baseURI);
      return ['http:', 'https:'].includes(thumbnail.protocol) ? thumbnail.href : '';
    } catch {
      return '';
    }
  }

  function parsePlayInfo(text) {
    const assignment = /(?:window\.)?__playinfo__\s*=\s*/.exec(text);
    if (!assignment) {
      return null;
    }
    const start = assignment.index + assignment[0].length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function collectDashSourcesFromData(value, sources) {
    if (Array.isArray(value)) {
      value.forEach((item) => collectDashSourcesFromData(item, sources));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    if (value.dash && Array.isArray(value.dash.video)) {
      const audio = [...(value.dash.audio || [])]
        .sort((left, right) => (right.bandwidth || 0) - (left.bandwidth || 0))[0];
      const audioUrls = getDashTrackUrls(audio);
      const audioUrl = audioUrls[0] || '';
      const duration = Number(value.timelength) > 0 ? Number(value.timelength) / 1000 : null;
      const audioBandwidth = Number(audio.bandwidth) || 0;
      const variants = value.dash.video.flatMap((track) => {
        const videoUrls = getDashTrackUrls(track);
        const url = videoUrls[0];
        if (!url || !audioUrl) {
          return [];
        }
        const height = Number(track.height) || 0;
        const videoBandwidth = Number(track.bandwidth) || 0;
        const resolution = height >= 2160 ? '4K' : height ? `${height}p` : '未知画质';
        return [{
          resolution,
          bandwidth: videoBandwidth,
          size: duration && videoBandwidth
            ? (videoBandwidth + audioBandwidth) * duration / 8
            : null,
          sizeEstimated: Boolean(duration && videoBandwidth),
          streamType: 'dash',
          duration,
          files: [{
            filename: `video-${resolution}.mp4`,
            url,
            audioUrl,
            backupUrls: videoUrls.slice(1),
            audioBackupUrls: audioUrls.slice(1),
            referrer: `${document.location.origin}${document.location.pathname}`
          }]
        }];
      });
      if (variants.length) {
        sources.push({
          name: document.title?.trim() || '',
          duration: Number(value.timelength) > 0 ? Number(value.timelength) / 1000 : null,
          variants: variants.sort((left, right) => resolutionValue(right.resolution) - resolutionValue(left.resolution))
        });
      }
    }
    Object.values(value).forEach((item) => collectDashSourcesFromData(item, sources));
  }

  function getDashTrackUrls(track) {
    if (!track || typeof track !== 'object') {
      return [];
    }
    const backups = track.backupUrl || track.backup_url || [];
    return [...new Set([
      track.baseUrl || track.base_url,
      ...(Array.isArray(backups) ? backups : [])
    ].filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url)))];
  }

  function createDashVideos(sources, pageThumbnail) {
    const groups = new Map();
    for (const source of sources) {
      const key = `${source.name.trim().toLocaleLowerCase()}|${source.duration ?? ''}`;
      if (!groups.has(key)) {
        groups.set(key, { ...source, variantsBySource: new Map() });
      }
      const group = groups.get(key);
      for (const variant of source.variants) {
        const sourceKey = getVariantIdentityKey(variant);
        const existing = group.variantsBySource.get(sourceKey);
        if (!existing || variant.bandwidth > existing.bandwidth) {
          group.variantsBySource.set(sourceKey, variant);
        }
      }
    }

    return [...groups.values()].map((group, index) => {
      const variants = [...group.variantsBySource.values()].sort(compareVariantsByQuality);
      return {
        id: `dash-video-${index + 1}`,
        name: group.name,
        thumbnail: group.thumbnail || pageThumbnail,
        duration: group.duration,
        variants,
        resolution: variants[0].resolution,
        files: variants[0].files
      };
    });
  }

  async function collectHlsVideos(sources) {
    const manifests = await Promise.all(sources.map(async (source) => {
      try {
        const response = await fetch(source.url);
        if (!response.ok) {
          return null;
        }
        return { source, playlist: await response.text() };
      } catch {
        return null;
      }
    }));
    const records = manifests.filter(Boolean);
    const referencedPlaylists = new Set();
    const completionCache = new Map();
    const getCompletedPlaylist = (url) => {
      if (!completionCache.has(url)) {
        completionCache.set(url, fetch(url).then(async (response) => {
          if (!response.ok) {
            return null;
          }
          const playlist = await response.text();
          return /#EXT-X-ENDLIST\b/i.test(playlist) ? playlist : null;
        }).catch(() => null));
      }
      return completionCache.get(url);
    };
    const videos = [];
    const videosByPlayerId = new Map();

    for (const record of records) {
      const variants = parseHlsVariants(record.playlist, record.source.url);
      if (!variants.length) {
        continue;
      }
      for (const variant of variants) {
        referencedPlaylists.add(variant.files[0].url);
        if (variant.files[0].audioUrl) {
          referencedPlaylists.add(variant.files[0].audioUrl);
        }
      }
      const completedVariants = (await Promise.all(variants.map(async (variant) => {
        const file = variant.files[0];
        const videoPlaylist = await getCompletedPlaylist(file.url);
        const audioPlaylist = !file.audioUrl || await getCompletedPlaylist(file.audioUrl);
        if (!videoPlaylist || !audioPlaylist) {
          return null;
        }
        variant.duration = getPlaylistDuration(videoPlaylist);
        variant.size = estimateHlsSize(variant.bandwidth, variant.duration);
        variant.sizeEstimated = Number.isFinite(variant.size);
        return variant;
      }))).filter(Boolean);
      if (completedVariants.length) {
        if (record.source.resolution) {
          completedVariants.forEach((variant) => {
            variant.resolution = record.source.resolution;
          });
        }
        const video = createHlsVideo(record.source, completedVariants, videos.length);
        const playerVideo = record.source.videoId && videosByPlayerId.get(record.source.videoId);
        if (!playerVideo) {
          videos.push(video);
          if (record.source.videoId) {
            videosByPlayerId.set(record.source.videoId, video);
          }
          continue;
        }
        const variantsBySource = new Map(playerVideo.variants.map((variant) => [
          getVariantIdentityKey(variant),
          variant
        ]));
        for (const variant of video.variants) {
          const sourceKey = getVariantIdentityKey(variant);
          const existing = variantsBySource.get(sourceKey);
          if (!existing || (variant.bandwidth || 0) > (existing.bandwidth || 0)) {
            variantsBySource.set(sourceKey, variant);
          }
        }
        playerVideo.variants = [...variantsBySource.values()].sort(compareVariantsByQuality);
        playerVideo.resolution = playerVideo.variants[0].resolution;
        playerVideo.files = playerVideo.variants[0].files;
        playerVideo.duration ??= video.duration;
      }
    }

    for (const record of records) {
      if (!record.source.standalone || referencedPlaylists.has(record.source.url)) {
        continue;
      }
      if (!/#EXT-X-ENDLIST\b/i.test(record.playlist)) {
        continue;
      }
      const variant = parseHlsMediaVariant(record.playlist, record.source);
      if (variant) {
        variant.duration = getPlaylistDuration(record.playlist);
        videos.push(createHlsVideo(record.source, [variant], videos.length));
      }
    }
    return videos;
  }

  function parseHlsVariants(playlist, manifestUrl) {
    const lines = playlist.split(/\r?\n/);
    const audioLine = lines.find((line) => /^#EXT-X-MEDIA:/i.test(line) && /(?:^|[:,])TYPE=AUDIO(?:,|$)/i.test(line));
    const audioPath = audioLine?.match(/\bURI="([^"]+)"/i)?.[1];
    const audioUrl = audioPath ? new URL(audioPath, manifestUrl).href : '';
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      const stream = lines[index].match(/#EXT-X-STREAM-INF:[^\r\n]*RESOLUTION=(\d+)x(\d+)/i);
      if (!stream) {
        continue;
      }
      const playlistPath = lines.slice(index + 1).find((line) => line && !line.startsWith('#'));
      if (!playlistPath) {
        continue;
      }
      const url = new URL(playlistPath, manifestUrl).href;
      const height = Number(stream[2]);
      variants.push({
        resolution: `${height}p`,
        bandwidth: Number(lines[index].match(/\bBANDWIDTH=(\d+)/i)?.[1]) || null,
        size: null,
        streamType: 'hls',
        files: [{ filename: `video-${height}p.mp4`, url, audioUrl }]
      });
    }
    return variants.sort((left, right) => resolutionValue(right.resolution) - resolutionValue(left.resolution));
  }

  function parseHlsMediaVariant(playlist, source) {
    if (!playlist.includes('#EXT-X-MAP:')) {
      return null;
    }
    const video = source.video;
    const resolution = video?.videoHeight
      ? `${video.videoHeight}p`
      : getResolutionFromUrl(source.url) || '未知画质';
    return {
      resolution,
      size: null,
      streamType: 'hls',
      files: [{ filename: `video-${resolution}.mp4`, url: source.url, audioUrl: '' }]
    };
  }

  function createHlsVideo(source, variants, index) {
    const video = source.video;
    const name = source.name || video?.getAttribute('aria-label') ||
      video?.getAttribute('title') || '';
    if (source.referrer) {
      variants.forEach((variant) => {
        variant.files.forEach((file) => { file.referrer ||= source.referrer; });
      });
    }
    return {
      id: `hls-video-${index + 1}`,
      name: name.trim(),
      thumbnail: source.thumbnail || video?.poster || '',
      duration: variants[0].duration ?? source.duration ??
        (Number.isFinite(video?.duration) ? video.duration : null),
      variants,
      resolution: variants[0].resolution,
      files: variants[0].files
    };
  }

  function getPlaylistDuration(playlist) {
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/gi)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    return durations.length ? durations.reduce((total, duration) => total + duration, 0) : null;
  }

  function estimateHlsSize(bandwidth, duration) {
    return Number.isFinite(bandwidth) && Number.isFinite(duration)
      ? bandwidth * duration / 8
      : null;
  }

  function addHlsSource(sources, rawUrl, metadata = {}) {
    if (!rawUrl) {
      return;
    }
    let url;
    try {
      url = new URL(String(rawUrl).replace(/\\\//g, '/'), document.baseURI);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !HLS_EXTENSION.test(url.href)) {
      return;
    }
    const source = sources.get(url.href) || {
      url: url.href,
      video: null,
      videoId: '',
      name: '',
      thumbnail: '',
      duration: null,
      resolution: '',
      referrer: '',
      standalone: false
    };
    source.video ||= metadata.video || null;
    source.videoId ||= metadata.videoId || '';
    source.name ||= metadata.name || '';
    source.thumbnail ||= metadata.thumbnail || '';
    source.duration ||= metadata.duration || null;
    source.resolution ||= metadata.resolution || '';
    source.referrer ||= metadata.referrer ||
      `${document.location?.origin || ''}${document.location?.pathname || ''}`;
    source.standalone ||= Boolean(metadata.standalone);
    sources.set(url.href, source);
  }

  function collectHlsSourcesFromText(text, sources, metadata = {}) {
    const normalized = String(text).replace(/\\\//g, '/');
    const urlPattern = /https?:\/\/[^\s"'<>\\})\]]+?\.m3u8(?:\?[^\s"'<>\\})\]]*)?/gi;
    for (const match of normalized.matchAll(urlPattern)) {
      addHlsSource(sources, match[0], metadata);
    }
  }

  function collectHlsSourcesFromData(value, sources, metadata = {}) {
    if (Array.isArray(value)) {
      value.forEach((item) => collectHlsSourcesFromData(item, sources, metadata));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const inherited = {
      name: value.title || value.name || metadata.name || '',
      thumbnail: value.poster || value.thumbnail || metadata.thumbnail || '',
      standalone: true
    };
    for (const item of Object.values(value)) {
      if (typeof item === 'string' && HLS_EXTENSION.test(item)) {
        addHlsSource(sources, item, inherited);
      } else {
        collectHlsSourcesFromData(item, sources, inherited);
      }
    }
  }

  function isDecorativeVideo(video) {
    return video.autoplay && video.loop && video.muted &&
      !video.getAttribute('aria-label') && !video.getAttribute('title');
  }

  function collectPlayerMediaDefinitions(sources) {
    for (const key of Object.keys(globalThis)) {
      const videoId = /^flashvars_(\d+)$/.exec(key)?.[1];
      const player = globalThis[key];
      if (!videoId || !Array.isArray(player?.mediaDefinitions)) {
        continue;
      }
      for (const definition of player.mediaDefinitions) {
        if (definition.format !== 'hls' || !definition.videoUrl) {
          continue;
        }
        const quality = Number(definition.quality) || Number(definition.height);
        addHlsSource(sources, definition.videoUrl, {
          videoId,
          name: player.video_title || '',
          thumbnail: player.image_url || '',
          duration: Number(player.video_duration) || null,
          resolution: quality >= 2160 ? '4K' : quality ? `${quality}p` : ''
        });
      }
    }
  }

  function addCandidate(candidates, rawUrl, video, elementIndex, size = null) {
    if (!rawUrl) {
      return;
    }
    let url;
    try {
      url = new URL(rawUrl, document.baseURI);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !VIDEO_EXTENSIONS.test(url.href)) {
      return;
    }
    if (!candidates.has(url.href)) {
      const resolution = getResolutionFromUrl(url.href) || (video?.videoHeight
        ? `${video.videoWidth}x${video.videoHeight}`
        : '');
      candidates.set(url.href, {
        url: url.href,
        video,
        elementIndex,
        resolution,
        size: size || null,
        sizeEstimated: false,
        files: [{ filename: getFileName(url.href), url: url.href }]
      });
    } else if (size) {
      candidates.get(url.href).size = size;
    }
  }

  function normalizeVideoUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '').replace(QUALITY_MARKER, '')
      .replace(/\.(mp4|m4v|webm|mov|ogv)$/i, '');
    return url.href;
  }

  function getQualityVariantGroup(rawUrl) {
    const url = new URL(rawUrl);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const fileName = pathSegments.pop() || '';
    const extension = /\.(?:mp4|m4v|webm|mov|ogv)$/i.exec(fileName)?.[0];
    if (!extension) {
      return '';
    }

    const stem = fileName.slice(0, -extension.length);
    const quality = /[._-]\d{3,4}p?$/i.exec(stem);
    const parentId = pathSegments.at(-1);
    if (!quality || !parentId) {
      return '';
    }

    const videoId = stem.slice(0, quality.index);
    return videoId && videoId.toLowerCase() === parentId.toLowerCase()
      ? `${url.origin}/${parentId.toLowerCase()}/${videoId.toLowerCase()}`
      : '';
  }

  function getResolutionFromUrl(url) {
    const match = url.match(/(?:[._-])(\d{3,4})p?(?=\.(?:mp4|m4v|webm|mov|ogv)(?:\/?[?#]|\/?$))/i);
    if (!match) {
      return '';
    }
    return Number(match[1]) >= 2160 ? '4K' : `${match[1]}p`;
  }

  function resolutionValue(resolution) {
    if (/^4k$/i.test(resolution)) {
      return 2160;
    }
    const dimensions = resolution.match(/(\d{2,4})x(\d{2,4})/i);
    if (dimensions) {
      return Number(dimensions[1]) * Number(dimensions[2]);
    }
    return Number(resolution.match(/\d{3,4}/)?.[0]) || 0;
  }

  function getVariantIdentityKey(variant) {
    const fileUrl = variant.files?.[0]?.url;
    const source = fileUrl || `${variant.streamType || ''}|${variant.resolution || ''}`;
    const bandwidth = Number.isFinite(variant.bandwidth) && variant.bandwidth > 0
      ? variant.bandwidth
      : null;
    return JSON.stringify([source, bandwidth]);
  }

  function compareVariantsByQuality(left, right) {
    return resolutionValue(right.resolution) - resolutionValue(left.resolution) ||
      (right.bandwidth || 0) - (left.bandwidth || 0);
  }

  function getFileName(url) {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return decodeURIComponent(path.split('/').pop() || 'video.mp4');
  }

  return { collectVideos, collectAllVideos };
})();
