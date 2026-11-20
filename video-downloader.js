globalThis.VideoDownloader = (() => {
  const FFMPEG_DIRECTORY = 'vendor/ffmpeg';
  const FETCH_TIMEOUT_MS = 20000;
  const FETCH_RETRIES = 2;
  const HTTP_GONE_RETRIES = 3;
  const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
  const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
  const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
  const MAX_SEGMENTS = 100000;
  const MAX_MEMORY_SEGMENTS = 6000;
  const PROCESSING_PROGRESS_MAX = 0.99;
  const TRACK_PROGRESS_MAX = PROCESSING_PROGRESS_MAX / 2;
  const DASH_VIDEO_DOWNLOAD_PROGRESS_MAX = 0.8;
  const DASH_AUDIO_DOWNLOAD_PROGRESS_MAX = 0.1;
  const DASH_MUX_PROGRESS_START = 0.9;
  const DASH_MUX_PROGRESS_SPAN = 0.08;
  let ffmpegPromise;
  let ffmpegInstance;
  let ffmpegQueue = Promise.resolve();

  async function createDownloadUrl(video, options = {}) {
    return video.streamType === 'dash'
      ? createDashDownloadUrl(video, options)
      : createHlsDownloadUrl(video, options);
  }

  async function getOpfsAvailableBytes() {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      const available = quota - usage;
      if (!Number.isFinite(available)) {
        throw new Error('浏览器未返回有效的存储空间估算');
      }
      return available;
    } catch (error) {
      throw new Error(`无法检测 OPFS 可用空间：${error.message || '存储空间估算失败'}`);
    }
  }

  async function createDashDownloadUrl(video, {
    signal,
    onProgress = () => {},
    onTracksFetched = () => {}
  } = {}) {
    const file = video.files[0];
    const directory = await navigator.storage.getDirectory();
    const availableBytes = await getOpfsAvailableBytes();
    const estimatedSize = Number.isFinite(video.size) ? video.size : 0;
    if (availableBytes <= 0) {
      throw new Error('OPFS 没有可用空间，请检查浏览器存储空间');
    }
    if (estimatedSize > 0 && estimatedSize * 2 > availableBytes) {
      throw new Error(`OPFS 空间不足：DASH 需要暂存音视频轨并生成合并文件，预计至少需要 ${formatBytes(estimatedSize * 2)}，当前可用 ${formatBytes(availableBytes)}`);
    }

    const prefix = crypto.randomUUID();
    const videoName = `${prefix}-video-track.mp4`;
    const audioName = `${prefix}-audio-track.mp4`;
    const outputName = `${prefix}-merged.mp4`;
    let output;
    let videoInput;
    let audioInput;
    let videoConversion;
    let audioConversion;
    let removeAbortListener = () => {};
    try {
      assertNotAborted(signal);
      const videoFile = await downloadDashTrackToOpfs(
        file.url,
        file.backupUrls || [],
        directory,
        videoName,
        file.referrer,
        signal,
        estimatedSize,
        0,
        (progress) => onProgress({
          phase: 'fetching',
          progress: progress * DASH_VIDEO_DOWNLOAD_PROGRESS_MAX
        }),
        '读取 DASH 视频轨失败'
      );
      assertNotAborted(signal);
      const outputReserve = Math.max(estimatedSize, videoFile.size);
      const audioFile = await downloadDashTrackToOpfs(
        file.audioUrl,
        file.audioBackupUrls || [],
        directory,
        audioName,
        file.referrer,
        signal,
        outputReserve,
        videoFile.size,
        (progress) => onProgress({
          phase: 'fetching',
          progress: DASH_VIDEO_DOWNLOAD_PROGRESS_MAX + progress * DASH_AUDIO_DOWNLOAD_PROGRESS_MAX
        }),
        '读取 DASH 音轨失败'
      );
      assertNotAborted(signal);
      await onTracksFetched();

      const availableForOutput = await getOpfsAvailableBytes();
      const inputBytes = videoFile.size + audioFile.size;
      if (inputBytes > availableForOutput) {
        throw new Error(`OPFS 空间不足：合并前还需要约 ${formatBytes(inputBytes)}，当前可用 ${formatBytes(availableForOutput)}`);
      }

      const media = await loadMediabunny();
      videoInput = new media.Input({
        formats: media.ALL_FORMATS,
        source: new media.BlobSource(videoFile)
      });
      audioInput = new media.Input({
        formats: media.ALL_FORMATS,
        source: new media.BlobSource(audioFile)
      });
      const outputHandle = await directory.getFileHandle(outputName, { create: true });
      const outputWritable = await outputHandle.createWritable();
      const outputTarget = new media.StreamTarget(outputWritable, { chunked: true });
      let maxOutputEnd = 0;
      outputTarget.on('write', ({ end }) => {
        maxOutputEnd = Math.max(maxOutputEnd, end);
        const outputProgress = Math.min(1, maxOutputEnd / Math.max(1, inputBytes));
        onProgress({
          phase: 'muxing',
          progress: DASH_MUX_PROGRESS_START + outputProgress * DASH_MUX_PROGRESS_SPAN
        });
      });
      output = new media.Output({
        format: new media.Mp4OutputFormat({ fastStart: false }),
        target: outputTarget
      });

      videoConversion = await media.Conversion.init({
        input: videoInput,
        output,
        composable: true,
        copy: { mode: 'forced' },
        audio: { discard: true },
        showWarnings: false
      });
      audioConversion = await media.Conversion.init({
        input: audioInput,
        output,
        composable: true,
        copy: { mode: 'forced' },
        video: { discard: true },
        showWarnings: false
      });
      const discardedTracks = [
        ...videoConversion.discardedTracks,
        ...audioConversion.discardedTracks
      ].filter(({ reason }) => reason !== 'discarded_by_user');
      if (!videoConversion.isValid || !audioConversion.isValid || discardedTracks.length) {
        const reasons = discardedTracks.map(({ reason }) => reason);
        throw new Error(`DASH 音视频编码无法无损封装为 MP4${reasons.length ? `（${reasons.join('、')}）` : ''}`);
      }

      const abortConversion = () => {
        void Promise.all([
          videoConversion.cancel(),
          audioConversion.cancel(),
          output.cancel()
        ]).catch((error) => console.warn('[当前页视频下载器] 无法立即停止 DASH 封装', error));
      };
      signal?.addEventListener('abort', abortConversion, { once: true });
      removeAbortListener = () => signal?.removeEventListener('abort', abortConversion);

      await output.start();
      onProgress({ phase: 'muxing', progress: DASH_MUX_PROGRESS_START });
      const videoMuxPromise = videoConversion.execute().then(() => {
        onProgress({ phase: 'muxing', progress: 0.99 });
      });
      await Promise.all([videoMuxPromise, audioConversion.execute()]);
      assertNotAborted(signal);
      await output.finalize();
      const mergedFile = await outputHandle.getFile();
      if (!mergedFile.size) {
        throw new Error('DASH 封装结果为空');
      }
      onProgress({ phase: 'muxing', progress: PROCESSING_PROGRESS_MAX });
      return {
        url: URL.createObjectURL(new Blob([mergedFile], { type: 'video/mp4' })),
        extension: 'mp4',
        opfsFileName: outputName
      };
    } catch (error) {
      removeAbortListener();
      await Promise.all([
        videoConversion?.cancel().catch(() => {}),
        audioConversion?.cancel().catch(() => {})
      ]);
      if (output && output.state !== 'finalized' && output.state !== 'canceled') {
        await output.cancel().catch(() => {});
      }
      await directory.removeEntry(outputName).catch(() => {});
      if (error.name === 'QuotaExceededError') {
        throw new Error('OPFS 空间不足，无法合并 DASH 音视频轨');
      }
      throw error;
    } finally {
      removeAbortListener();
      videoInput?.dispose();
      audioInput?.dispose();
      await Promise.all([
        directory.removeEntry(videoName).catch(() => {}),
        directory.removeEntry(audioName).catch(() => {})
      ]);
    }
  }

  async function downloadDashTrackToOpfs(
    url,
    backupUrls,
    directory,
    fileName,
    referrer,
    signal,
    outputReserve,
    previousTrackBytes,
    onProgress,
    errorLabel
  ) {
    const failures = [];
    for (const [index, candidateUrl] of [url, ...backupUrls].entries()) {
      const readTrackResponse = (credentials) => fetchWithRetry(
        candidateUrl,
        signal,
        async (response, request) => {
          const expected = Number(response.headers.get('content-length'));
          const available = await getOpfsAvailableBytes();
          const outputBytesNeeded = Math.max(outputReserve, previousTrackBytes + expected);
          if (expected > 0 && expected + outputBytesNeeded > available) {
            throw new Error(`OPFS 空间不足：DASH 轨道与合并结果至少需要 ${formatBytes(expected + outputBytesNeeded)}，当前可用 ${formatBytes(available)}`);
          }
          const handle = await directory.getFileHandle(fileName, { create: true });
          const writer = await handle.createWritable();
          let reader;
          let loaded = 0;
          try {
            reader = response.body?.getReader();
            if (!reader) {
              throw new Error('无法流式读取 DASH 媒体响应');
            }
            while (true) {
              const { done, value } = await readWithTimeout(reader, request, FETCH_TIMEOUT_MS);
              if (done) {
                break;
              }
              loaded += value.byteLength;
              await writer.write(value);
              onProgress(expected > 0 ? Math.min(1, loaded / expected) : 0);
              if (loaded % (64 * 1024 * 1024) < value.byteLength &&
                  await getOpfsAvailableBytes() < Math.max(outputReserve, previousTrackBytes + loaded)) {
                throw new Error('OPFS 空间不足，已停止下载以保留合并空间');
              }
            }
            if (!loaded) {
              throw new Error('DASH 媒体轨为空');
            }
            await writer.close();
            onProgress(1);
            return await handle.getFile();
          } catch (error) {
            await reader?.cancel().catch(() => {});
            await writer.abort().catch(() => {});
            await directory.removeEntry(fileName).catch(() => {});
            if (error.name === 'QuotaExceededError') {
              throw new Error('OPFS 空间不足，已停止下载');
            }
            throw error;
          } finally {
            reader?.releaseLock();
          }
        },
        errorLabel,
        referrer,
        index === 0 ? FETCH_RETRIES : 0,
        credentials,
        true
      );

      try {
        try {
          return await readTrackResponse('omit');
        } catch (error) {
          if (!/HTTP 403\b/.test(error.message || '')) {
            throw error;
          }
          return await readTrackResponse('include');
        }
      } catch (error) {
        if (!/HTTP (?:403|404)\b|：(?:网络错误(?:（[^）]*）)?|请求超时)(?:；|$)/.test(error.message || '')) {
          throw error;
        }
        failures.push(error.message);
      }
    }
    if (failures.length && failures.every((message) => /HTTP 403\b/.test(message))) {
      throw new Error(`${errorLabel}：CDN 拒绝访问（HTTP 403）。请刷新视频页面并重新扫描；如果仍失败，媒体链接可能已过期或源站不允许下载。`);
    }
    if (failures.length > 1) {
      const hostFailures = failures.map((message) => message.match(/CDN：([^；]+)/)?.[1] || '未知 CDN');
      throw new Error(`${errorLabel}：所有 CDN 镜像均失败（${hostFailures.join('、')}）；${failures.at(-1)}`);
    }
    throw new Error(failures[0] || `${errorLabel}：没有可用的 CDN 地址`);
  }

  function readWithTimeout(reader, request, timeoutMs) {
    let timeout;
    return Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          request.abort();
          reject(new Error('DASH 媒体轨读取超时'));
        }, timeoutMs);
      })
    ]).finally(() => clearTimeout(timeout));
  }

  function loadMediabunny() {
    if (!globalThis.Mediabunny) {
      throw new Error('DASH 封装器尚未初始化，请重新加载扩展后重试');
    }
    return Promise.resolve(globalThis.Mediabunny);
  }

  async function createHlsDownloadUrl(video, { signal, onProgress = () => {} } = {}) {
    const file = video.files[0];
    if (!file.audioUrl) {
      return createHlsOpfsDownloadUrl(video, { signal, onProgress });
    }

    const output = await serializeFfmpeg(async () => {
      assertNotAborted(signal);
      const totalBytes = { value: 0 };
      const prefix = crypto.randomUUID();
      let videoPath = '';
      let audioPath = '';
      const outputPath = `${prefix}-output.mp4`;
      let ffmpeg;
      try {
        const videoTrack = await readHlsTrack(file.url, {
          signal,
          totalBytes,
          onProgress: (progress) => onProgress({
            ...progress,
            progress: progress.progress * (file.audioUrl ? TRACK_PROGRESS_MAX : PROCESSING_PROGRESS_MAX)
          })
        });
        assertNotAborted(signal);
        ffmpeg = await loadFfmpeg();
        videoPath = `${prefix}-video.${videoTrack.extension}`;
        await ffmpeg.writeFile(videoPath, videoTrack.data);
        videoTrack.data = null;

        let audioTrack = null;
        if (file.audioUrl) {
          audioTrack = await readHlsTrack(file.audioUrl, {
            signal,
            totalBytes,
            onProgress: (progress) => onProgress({
              ...progress,
              progress: TRACK_PROGRESS_MAX + progress.progress * TRACK_PROGRESS_MAX
            })
          });
          assertNotAborted(signal);
          audioPath = `${prefix}-audio.${audioTrack.extension}`;
          await ffmpeg.writeFile(audioPath, audioTrack.data);
          audioTrack.data = null;
        }
        assertNotAborted(signal);
        onProgress({ phase: 'muxing', progress: PROCESSING_PROGRESS_MAX });
        const args = ['-i', videoPath];
        if (audioTrack) {
          args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0');
        } else {
          args.push('-map', '0:v:0', '-map', '0:a?');
        }
        args.push(
          '-c', 'copy',
          '-movflags', '+faststart',
          outputPath
        );
        const exitCode = await ffmpeg.exec(args, 15 * 60 * 1000);
        if (exitCode !== 0) {
          throw new Error('FFmpeg 无法封装该视频');
        }
        const data = await ffmpeg.readFile(outputPath);
        return new Blob([data], { type: 'video/mp4' });
      } finally {
        if (ffmpeg) {
          for (const path of [videoPath, audioPath, outputPath].filter(Boolean)) {
            try {
              await ffmpeg.deleteFile(path);
            } catch {
              continue;
            }
          }
        }
      }
    });
    return { url: URL.createObjectURL(output), extension: 'mp4' };
  }

  async function createHlsOpfsDownloadUrl(video, { signal, onProgress }) {
    const file = video.files[0];
    const directory = await navigator.storage.getDirectory();
    const availableBytes = await getOpfsAvailableBytes();
    if (availableBytes <= 0) {
      throw new Error('OPFS 没有可用空间，请检查浏览器存储空间');
    }
    if (Number.isFinite(video.size) && video.size > availableBytes) {
      throw new Error(`OPFS 空间不足：预计需要 ${formatBytes(video.size)}，当前可用 ${formatBytes(availableBytes)}`);
    }

    const playlist = await fetchText(file.url, signal);
    const { urls, isFmp4 } = parseHlsPlaylist(playlist, file.url);
    const prefix = crypto.randomUUID();
    const outputName = `${prefix}-merged.${isFmp4 ? 'mp4' : 'ts'}`;
    const outputHandle = await directory.getFileHandle(outputName, { create: true });
    const outputWriter = await outputHandle.createWritable();
    const segmentProgress = new Array(urls.length).fill(0);
    let progressSum = 0;
    let totalBytes = 0;
    try {
      for (let offset = 0; offset < urls.length; offset += 2) {
        assertNotAborted(signal);
        const batch = urls.slice(offset, offset + 2);
        const stagedNames = batch.map((_, index) => `${prefix}-segment-${offset + index}`);
        const results = await Promise.allSettled(batch.map((url, index) =>
          fetchSegmentToOpfs(url, directory, stagedNames[index], signal, (loaded, expected) => {
            const segmentIndex = offset + index;
            const progress = expected > 0 ? Math.min(1, loaded / expected) : 0;
            progressSum += progress - segmentProgress[segmentIndex];
            segmentProgress[segmentIndex] = progress;
            onProgress({
              phase: 'fetching',
              progress: Math.min(PROCESSING_PROGRESS_MAX, progressSum / urls.length * PROCESSING_PROGRESS_MAX),
              current: segmentIndex + 1,
              total: urls.length
            });
          })
        ));
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) {
          throw failed.reason;
        }

        for (let index = 0; index < batch.length; index += 1) {
          assertNotAborted(signal);
          const handle = await directory.getFileHandle(stagedNames[index]);
          const stagedFile = await handle.getFile();
          if (stagedFile.size > await getOpfsAvailableBytes()) {
            throw new Error('OPFS 空间不足，无法合并视频分片');
          }
          await outputWriter.write(stagedFile);
          totalBytes += stagedFile.size;
          await directory.removeEntry(stagedNames[index]);
          progressSum += 1 - segmentProgress[offset + index];
          segmentProgress[offset + index] = 1;
          onProgress({
            phase: 'fetching',
            progress: Math.min(PROCESSING_PROGRESS_MAX, progressSum / urls.length * PROCESSING_PROGRESS_MAX),
            current: offset + index + 1,
            total: urls.length
          });
        }
      }

      if (!totalBytes) {
        throw new Error('HLS 分片为空');
      }
      await outputWriter.close();
      const output = await outputHandle.getFile();
      return {
        url: URL.createObjectURL(new Blob([output], {
          type: isFmp4 ? 'video/mp4' : 'video/mp2t'
        })),
        extension: isFmp4 ? 'mp4' : 'ts',
        opfsFileName: outputName
      };
    } catch (error) {
      await outputWriter.abort().catch(() => {});
      await directory.removeEntry(outputName).catch(() => {});
      if (error.name === 'QuotaExceededError') {
        throw new Error('OPFS 空间不足，无法保存或合并视频分片');
      }
      throw error;
    } finally {
      await Promise.all(urls.map((_, index) =>
        directory.removeEntry(`${prefix}-segment-${index}`).catch(() => {})
      ));
    }
  }

  async function fetchSegmentToOpfs(url, directory, fileName, signal, onProgress) {
    return fetchWithRetry(url, signal, async (response) => {
      const expected = Number(response.headers.get('content-length'));
      if (expected > 0) {
        const available = await getOpfsAvailableBytes();
        if (!Number.isFinite(available) || expected > available) {
          throw new Error('OPFS 空间不足，已停止下载');
        }
      }

      let writer;
      let loaded = 0;
      try {
        const handle = await directory.getFileHandle(fileName, { create: true });
        writer = await handle.createWritable();
        const reader = response.body?.getReader();
        if (!reader) {
          const data = await response.blob();
          loaded = data.size;
          await writer.write(data);
          onProgress(loaded, expected);
        } else {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              loaded += value.byteLength;
              await writer.write(value);
              onProgress(loaded, expected);
            }
          } finally {
            reader.releaseLock();
          }
        }
        if (!loaded) {
          throw new Error('HLS 分片为空');
        }
        await writer.close();
        return loaded;
      } catch (error) {
        await writer?.abort().catch(() => {});
        await directory.removeEntry(fileName).catch(() => {});
        if (error.name === 'QuotaExceededError') {
          throw new Error('OPFS 空间不足，已停止下载');
        }
        throw error;
      }
    }, '读取 HLS 分片失败');
  }

  function parseHlsPlaylist(playlist, playlistUrl, maxSegments = MAX_SEGMENTS) {
    if (!playlist.startsWith('#EXTM3U')) {
      throw new Error('HLS 清单格式无效');
    }
    const lines = playlist.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.some((line) => /^#EXT-X-KEY:/i.test(line) && !/METHOD=NONE/i.test(line))) {
      throw new Error('此 HLS 流使用了暂不支持的加密方式');
    }
    if (lines.some((line) => /^#EXT-X-STREAM-INF:/i.test(line))) {
      throw new Error('HLS 主清单未正确解析，请重新扫描后再试');
    }
    if (!lines.some((line) => /^#EXT-X-ENDLIST\b/i.test(line))) {
      throw new Error('该 HLS 清单尚未结束，暂不支持下载直播流');
    }
    if (lines.some((line) => /^#EXT-X-BYTERANGE:/i.test(line)) ||
        lines.some((line) => /^#EXT-X-MAP:/i.test(line) && /\bBYTERANGE=/i.test(line))) {
      throw new Error('此 HLS 流使用了暂不支持的字节范围');
    }
    const mapLine = lines.find((line) => /^#EXT-X-MAP:/i.test(line));
    const initPath = mapLine?.match(/URI="([^"]+)"/i)?.[1];
    const segmentUrls = lines
      .filter((line) => !line.startsWith('#'))
      .map((line) => new URL(line, playlistUrl).href);
    if (!segmentUrls.length) {
      throw new Error('HLS 分片清单格式不受支持');
    }
    if (segmentUrls.length > maxSegments) {
      throw new Error(`HLS 分片过多（最多 ${maxSegments} 个）`);
    }
    const isFmp4 = Boolean(initPath);
    if (!isFmp4 && !segmentUrls.every((url) => /\.ts(?:[?#]|$)/i.test(url))) {
      throw new Error('此 HLS 分片格式暂不支持');
    }
    const urls = [
      ...(initPath ? [new URL(initPath, playlistUrl).href] : []),
      ...segmentUrls
    ];
    if (urls.some((url) => !/^https?:/i.test(url))) {
      throw new Error('HLS 清单包含无效分片地址');
    }
    return { urls, isFmp4 };
  }

  async function readHlsTrack(playlistUrl, { signal, onProgress, totalBytes }) {
    const playlist = await fetchText(playlistUrl, signal);
    const { urls, isFmp4 } = parseHlsPlaylist(playlist, playlistUrl, MAX_MEMORY_SEGMENTS);
    const chunks = [];
    const segmentProgress = new Array(urls.length).fill(0);
    for (let offset = 0; offset < urls.length; offset += 2) {
      assertNotAborted(signal);
      const batch = await Promise.all(urls.slice(offset, offset + 2).map(async (url, index) => {
        const segmentIndex = offset + index;
        return fetchBytes(url, signal, totalBytes, (loaded, expected) => {
          segmentProgress[segmentIndex] = expected > 0 ? Math.min(1, loaded / expected) : 0;
          onProgress({
            phase: 'fetching',
            progress: Math.min(1, segmentProgress.reduce((sum, value) => sum + value, 0) /
              urls.length),
            current: segmentIndex + 1,
            total: urls.length
          });
        });
      }));
      chunks.push(...batch);
      batch.forEach((_, index) => { segmentProgress[offset + index] = 1; });
      onProgress({
        phase: 'fetching',
        progress: Math.min(1, segmentProgress.reduce((sum, value) => sum + value, 0) /
          urls.length),
        current: Math.min(offset + batch.length, urls.length),
        total: urls.length
      });
    }
    const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (totalLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('HLS 音视频总量超过 256 MiB，已停止以避免内存不足');
    }
    const track = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      track.set(chunk, offset);
      offset += chunk.length;
    }
    chunks.length = 0;
    return { data: track, extension: isFmp4 ? 'mp4' : 'ts' };
  }

  async function fetchText(url, signal) {
    return fetchWithRetry(url, signal, async (response) => {
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_PLAYLIST_BYTES) {
        throw new Error('HLS 清单过大');
      }
      return readBoundedText(response);
    }, '读取 HLS 清单失败');
  }

  async function readBoundedText(response) {
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (text.length > MAX_PLAYLIST_BYTES) {
        throw new Error('HLS 清单过大');
      }
      return text.replace(/^\uFEFF/, '');
    }

    const chunks = [];
    let totalLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalLength += value.byteLength;
        if (totalLength > MAX_PLAYLIST_BYTES) {
          await reader.cancel();
          throw new Error('HLS 清单过大');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  }

  async function fetchBytes(url, signal, totalBytes, onProgress = () => {}) {
    return fetchWithRetry(url, signal, async (response) => {
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_SEGMENT_BYTES || totalBytes.value + length > MAX_DOWNLOAD_BYTES) {
        throw new Error('HLS 分片超出内存保护上限');
      }
      const reader = response.body?.getReader();
      if (!reader) {
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength > MAX_SEGMENT_BYTES ||
            totalBytes.value + data.byteLength > MAX_DOWNLOAD_BYTES) {
          throw new Error('HLS 分片超出内存保护上限');
        }
        if (!data.byteLength) {
          throw new Error('HLS 分片为空');
        }
        totalBytes.value += data.byteLength;
        onProgress(data.byteLength, data.byteLength);
        return data;
      }

      const chunks = [];
      let segmentBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          segmentBytes += value.byteLength;
          onProgress(segmentBytes, length);
          if (segmentBytes > MAX_SEGMENT_BYTES ||
              totalBytes.value + segmentBytes > MAX_DOWNLOAD_BYTES) {
            await reader.cancel();
            throw new Error('HLS 分片超出内存保护上限');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (!segmentBytes) {
        throw new Error('HLS 分片为空');
      }
      const data = new Uint8Array(segmentBytes);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      totalBytes.value += segmentBytes;
      return data;
    }, '读取 HLS 分片失败');
  }

  async function fetchWithRetry(
    url,
    signal,
    readResponse,
    errorLabel,
    referrer = '',
    maxRetries = FETCH_RETRIES,
    credentials = 'include',
    streaming = false
  ) {
    for (let attempt = 0; attempt <= Math.max(maxRetries, HTTP_GONE_RETRIES); attempt += 1) {
      assertNotAborted(signal);
      const controller = new AbortController();
      const abortRequest = () => controller.abort();
      signal?.addEventListener('abort', abortRequest, { once: true });
      let timedOut = false;
      let timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          cache: 'default',
          credentials,
          redirect: 'follow',
          ...(referrer ? { referrer, referrerPolicy: 'unsafe-url' } : {}),
          signal: controller.signal
        });
        if (streaming) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 410 ||
            response.status === 429 || response.status >= 500;
          const retryLimit = response.status === 410
            ? maxRetries === 0 ? 0 : HTTP_GONE_RETRIES
            : maxRetries;
          if (retryable && attempt < retryLimit) {
            await response.body?.cancel();
          } else {
            const responseText = await readHttpErrorText(response);
            const requestHost = new URL(response.url || url).host;
            const statusText = response.statusText ? ` ${response.statusText}` : '';
            const details = responseText ? `；服务器响应：${responseText}` : '';
            throw new Error(`${errorLabel}：HTTP ${response.status}${statusText}；CDN：${requestHost}${details}`);
          }
        } else {
          return await readResponse(response, {
            signal: controller.signal,
            abort: () => controller.abort()
          });
        }
      } catch (error) {
        if (signal?.aborted) {
          throw new DOMException('下载已取消', 'AbortError');
        }
        if (error.message?.startsWith(errorLabel) ||
            error.message?.startsWith('OPFS ') ||
            error.message?.startsWith('无法检测 OPFS') ||
            error.message?.startsWith('无法流式读取') ||
            error.message?.includes('超出内存保护上限') ||
            error.message?.includes('清单过大')) {
          throw error;
        }
        if (attempt === maxRetries) {
          const errorDetails = error.message?.replace(/https?:\/\/\S+/gi, '[URL]');
          const failure = timedOut
            ? '请求超时'
            : `网络错误${errorDetails ? `（${error.name || 'Error'}：${errorDetails}）` : ''}`;
          throw new Error(`${errorLabel}：${failure}；CDN：${new URL(url).host}`);
        }
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        signal?.removeEventListener('abort', abortRequest);
      }
      await delay(300 * (attempt + 1), signal);
    }
    throw new Error(errorLabel);
  }

  async function readHttpErrorText(response) {
    const reader = response.body?.getReader();
    if (!reader) {
      return (await response.text()).slice(0, 1000).replace(/https?:\/\/\S+/gi, '[URL]');
    }

    const chunks = [];
    let length = 0;
    try {
      while (length < 1000) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value.subarray(0, 1000 - length);
        chunks.push(chunk);
        length += chunk.byteLength;
        if (chunk.byteLength < value.byteLength) {
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes).replace(/\s+/g, ' ')
      .replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 1000);
  }

  function formatBytes(bytes) {
    const gibibytes = bytes / 1024 ** 3;
    return `${gibibytes.toFixed(2)} GiB`;
  }

  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        reject(new DOMException('下载已取消', 'AbortError'));
      };
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function assertNotAborted(signal) {
    if (signal?.aborted) {
      throw new DOMException('下载已取消', 'AbortError');
    }
  }

  async function loadFfmpeg() {
    if (!ffmpegPromise) {
      ffmpegPromise = (async () => {
        const ffmpeg = new FFmpegWASM.FFmpeg();
        await ffmpeg.load({
          coreURL: chrome.runtime.getURL(`${FFMPEG_DIRECTORY}/ffmpeg-core.js`),
          wasmURL: chrome.runtime.getURL(`${FFMPEG_DIRECTORY}/ffmpeg-core.wasm`)
        });
        ffmpegInstance = ffmpeg;
        return ffmpeg;
      })().catch((error) => {
        ffmpegPromise = null;
        throw error;
      });
    }
    return ffmpegPromise;
  }

  function serializeFfmpeg(task) {
    const result = ffmpegQueue.then(task, task);
    ffmpegQueue = result.catch(() => {});
    return result;
  }

  async function cancelCurrent() {
    const currentPromise = ffmpegPromise;
    ffmpegPromise = null;
    if (!currentPromise) {
      return;
    }
    if (ffmpegInstance) {
      const ffmpeg = ffmpegInstance;
      ffmpegInstance = null;
      ffmpeg.terminate();
      return;
    }
    try {
      const ffmpeg = await currentPromise;
      if (ffmpegInstance === ffmpeg) {
        ffmpegInstance = null;
      }
      ffmpeg.terminate();
    } catch {
      return;
    }
  }

  return { createDownloadUrl, createHlsDownloadUrl, cancelCurrent, dispose: cancelCurrent };
})();