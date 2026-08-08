// ===== Global State =====
let config = {};
let videoList = [];      // raw API data
let flatVideos = [];     // flattened for search
let currentVideo = null; // { videoId, videoName, id, moduleId, nodeId, duration, percent, ... }
let isVideoCached = {};  // videoId -> true/path
let subtitleData = null; // { cues: [{start, end, text}], vtt: string }
let subtitleVisible = false;
let currentVideoElement = null;

// ===== DOM Refs =====
const sidebar = document.getElementById('sidebar');
const sidebarTree = document.getElementById('sidebar-tree');
const videoPlayer = document.getElementById('video-player');
const videoControls = document.getElementById('video-controls');
const placeholder = document.getElementById('placeholder');
const nowPlaying = document.getElementById('now-playing');
const subtitleOverlay = document.getElementById('subtitle-overlay');
const seekBar = document.getElementById('seek-bar');
const seekFill = document.getElementById('seek-fill');
const timeDisplay = document.getElementById('time-display');
const speedSelect = document.getElementById('speed-select');
const aiPanel = document.getElementById('ai-panel');
const aiContent = document.getElementById('ai-content');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const toast = document.getElementById('toast');

// ===== Utility =====
function fmtTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function showToast(msg, type = '') {
  toast.textContent = msg;
  toast.className = 'toast visible ' + type;
  setTimeout(() => toast.classList.remove('visible'), 3000);
}

function showLoading(text = '处理中...') {
  loadingText.textContent = text;
  loadingOverlay.classList.add('visible');
}
function hideLoading() { loadingOverlay.classList.remove('visible'); }

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 180);
}

// ===== Init =====
async function init() {
  config = await window.api.getConfig();
  await loadVideoList();
  await refreshCacheStatus();

  // Fetch studentId from server (needed for play progress recording)
  try {
    const userResp = await window.api.queryUser();
    if (userResp.success && userResp.result) {
      config.studentId = userResp.result.id || userResp.result.studentId || '';
      window.api.saveConfig({ studentId: config.studentId });
    }
  } catch (e) { /* silent */ }

  // Set up video element events
  setupVideoEvents();

  // Restore playback speed
  const savedSpeed = config.playbackSpeed || 1;
  // Populate speed-select with 0.1 increments
  const sel = document.getElementById('speed-select');
  for (let s = 0.1; s <= 5.0; s = Math.round((s + 0.1) * 10) / 10) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = s.toFixed(1) + 'x';
    sel.appendChild(opt);
  }
  sel.value = String(savedSpeed);
  const display = document.getElementById('speed-display');
  if (display) display.textContent = savedSpeed.toFixed(1) + 'x';

  // Restore last video position (ONLY for cached playback — online URLs don't support seek)
  const savedVideoId = config.lastVideoId;
  const savedPosition = config.lastPosition || 0;
  if (savedVideoId && savedPosition > 0) {
    const lastVideo = flatVideos.find(v => v.videoId === savedVideoId);
    if (lastVideo) {
      const module = videoList.find(m => m.moduleId === lastVideo.moduleId);
      const node = module?.nodeList?.find(n => n.nodeId === lastVideo.nodeId);
      if (module && node) {
        showToast('恢复上次播放: ' + lastVideo.videoName, '');

        // Suppress timeupdate saves until seek completes (or determines it can't)
        window._pendingSeek = savedPosition;

        // Play the video
        const playMode = await playVideo(lastVideo, module, node);

        if (playMode === 'cache') {
          // Cached playback supports seek — poll until duration available then seek
          let seekAttempts = 0;
          const seekPoll = setInterval(() => {
            seekAttempts++;
            if (videoPlayer.duration && savedPosition < videoPlayer.duration - 2) {
              videoPlayer.currentTime = savedPosition;
              setTimeout(() => {
                if (Math.abs(videoPlayer.currentTime - savedPosition) < 5) {
                  clearInterval(seekPoll);
                  window._pendingSeek = null;
                }
              }, 200);
            }
            if (seekAttempts > 20) {
              clearInterval(seekPoll);
              window._pendingSeek = null;
            }
          }, 500);
        } else {
          // Online playback — no seek (remote URL doesn't support it)
          window._pendingSeek = null;
        }
      }
    }
  }

  // Cache progress listener
  window.api.onCacheProgress((data) => {
    const el = document.querySelector(`[data-video-id="${data.key}"] .ci-progress`);
    if (el) el.textContent = data.progress + '%';
    // Update badge in tree
    const item = document.querySelector(`.video-item[data-vid="${data.key}"]`);
    if (item) {
      let badge = item.querySelector('.vbadge.caching');
      if (!badge && data.progress < 100) {
        badge = document.createElement('span');
        badge.className = 'vbadge caching';
        item.appendChild(badge);
      }
      if (badge) badge.textContent = data.progress + '%';
    }
  });
}

// ===== Load Video List =====
async function loadVideoList() {
  sidebarTree.innerHTML = '<div style="padding: 20px; text-align: center; color: #555;">加载中...</div>';
  try {
    const resp = await window.api.getVideoList();
    if (!resp.success) {
      sidebarTree.innerHTML = `<div style="padding:20px;color:#c0392b;">加载失败: ${resp.result || '请检查Cookie设置'}<br><br>请到设置中配置Cookie。</div>`;
      return;
    }
    videoList = resp.result || [];
    flatVideos = [];
    renderTree();
  } catch (e) {
    sidebarTree.innerHTML = `<div style="padding:20px;color:#c0392b;">加载失败: ${e.message}</div>`;
  }
}

function renderTree(filter = '') {
  sidebarTree.innerHTML = '';
  let totalVideos = 0;

  videoList.forEach((module, mIdx) => {
    if (!module.nodeList) return;
    // Filter check
    let hasMatch = false;
    if (filter) {
      module.nodeList.forEach(node => {
        (node.videoList || []).forEach(v => {
          if (v.videoName.toLowerCase().includes(filter.toLowerCase()) ||
              node.nodeName.toLowerCase().includes(filter.toLowerCase()) ||
              module.moduleName.toLowerCase().includes(filter.toLowerCase())) {
            hasMatch = true;
          }
        });
      });
      if (!hasMatch) return;
    }

    const moduleEl = document.createElement('div');
    moduleEl.className = 'module-item';

    const moduleHeader = document.createElement('div');
    moduleHeader.className = 'module-header';
    let moduleVideoCount = 0;
    module.nodeList.forEach(n => moduleVideoCount += (n.videoList || []).length);
    moduleHeader.innerHTML = `
      <span class="arrow">▶</span>
      <span class="module-name">${module.moduleName}</span>
      <span class="module-count">${moduleVideoCount}集</span>
    `;

    const nodeContainer = document.createElement('div');
    nodeContainer.className = 'node-children expanded';

    moduleHeader.addEventListener('click', () => {
      const expanded = nodeContainer.classList.toggle('expanded');
      moduleHeader.querySelector('.arrow').classList.toggle('expanded', expanded);
    });

    // Default: expanded
    moduleHeader.querySelector('.arrow').classList.add('expanded');

    moduleEl.appendChild(moduleHeader);

    (module.nodeList || []).forEach((node, nIdx) => {
      const nodeMatch = !filter ||
        node.nodeName.toLowerCase().includes(filter.toLowerCase()) ||
        (node.videoList || []).some(v => v.videoName.toLowerCase().includes(filter.toLowerCase()));
      if (filter && !nodeMatch) return;

      const nodeEl = document.createElement('div');
      nodeEl.className = 'node-item';

      const nodeHeader = document.createElement('div');
      nodeHeader.className = 'node-header';
      nodeHeader.innerHTML = `
        <span class="arrow">▶</span>
        <span>${node.nodeName}</span>
      `;

      const videoListEl = document.createElement('div');
      videoListEl.className = 'video-list expanded';

      nodeHeader.addEventListener('click', () => {
        const expanded = videoListEl.classList.toggle('expanded');
        nodeHeader.querySelector('.arrow').classList.toggle('expanded', expanded);
      });

      // Default: expanded
      nodeHeader.querySelector('.arrow').classList.add('expanded');

      (node.videoList || []).forEach((video) => {
        const vMatch = !filter ||
          video.videoName.toLowerCase().includes(filter.toLowerCase()) ||
          node.nodeName.toLowerCase().includes(filter.toLowerCase());
        if (filter && !vMatch) return;

        totalVideos++;
        flatVideos.push({ ...video, moduleId: module.moduleId, nodeId: node.nodeId, moduleName: module.moduleName, nodeName: node.nodeName });

        const vEl = document.createElement('div');
        vEl.className = 'video-item';
        vEl.dataset.vid = video.videoId;
        if (video.playState === 1) vEl.classList.add('played');
        vEl.innerHTML = `
          <span class="vname">${video.videoName}</span>
          <span class="vduration">${fmtTime(video.videoDuration)}</span>
        `;
        vEl.addEventListener('click', () => playVideo(video, module, node));
        videoListEl.appendChild(vEl);
      });

      nodeEl.appendChild(nodeHeader);
      nodeEl.appendChild(videoListEl);
      nodeContainer.appendChild(nodeEl);
    });

    moduleEl.appendChild(nodeContainer);
    sidebarTree.appendChild(moduleEl);
  });

  // When searching, ensure all filtered results are expanded (visible)
  if (filter) {
    document.querySelectorAll('.module-header .arrow').forEach(a => a.classList.add('expanded'));
    document.querySelectorAll('.node-children').forEach(c => c.classList.add('expanded'));
    document.querySelectorAll('.node-header .arrow').forEach(a => a.classList.add('expanded'));
    document.querySelectorAll('.video-list').forEach(c => c.classList.add('expanded'));
  }
}

// ===== Play mode: cache-first vs online (for study progress tracking) =====
let preferCache = true;  // true = play from cache when available; false = always online

// ===== Play Video =====
// Returns 'cache' | 'online' | null indicating how the video was played
async function playVideo(video, module, node) {
  // Record progress for the previous video before switching
  if (currentVideo && videoPlayer.duration && videoPlayer.currentTime > 0) {
    recordProgress(currentVideo, videoPlayer.currentTime);
  }

  currentVideo = { ...video, moduleId: module.moduleId, nodeId: node.nodeId, moduleName: module.moduleName, nodeName: node.nodeName };

  // Save this as the last played video (position will be updated by timeupdate)
  window.api.saveConfig({ lastVideoId: video.videoId });

  // Update active state in tree
  document.querySelectorAll('.video-item.active').forEach(el => el.classList.remove('active'));
  const itemEl = document.querySelector(`.video-item[data-vid="${video.videoId}"]`);
  if (itemEl) itemEl.classList.add('active');

  nowPlaying.textContent = `${video.videoName}`;
  videoControls.style.display = 'flex';
  placeholder.style.display = 'none';
  videoPlayer.style.display = 'block';

  // Reset subtitle
  subtitleData = null;
  subtitleOverlay.classList.remove('visible');
  document.getElementById('btn-subtitle').classList.remove('active');
  subtitleVisible = false;

  if (preferCache) {
    // Cache-first: play from local if available
    const cacheCheck = await window.api.checkCache(video.videoId);
    if (cacheCheck.cached) {
      playLocalFile(cacheCheck.path, video);
      // Auto-load subtitle if available
      if (cacheCheck.subtitle) {
        await loadSubtitleFromFile(cacheCheck.subtitle);
      }
      return 'cache';
    }
  }

  // Online playback (also used as fallback when cache not available)
  await playOnline(video);
  return 'online';
}

async function playLocalFile(filePath, video) {
  // Use local-video:// protocol with base64url-encoded path to avoid URL parsing issues
  // Handle UTF-8 (Chinese chars in path) by encoding to bytes first
  const bytes = new TextEncoder().encode(filePath);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  videoPlayer.src = 'local-video://load/' + encoded;
  videoPlayer.load();
  videoPlayer.play().catch(() => {});
}

async function playOnline(video) {
  // Show a subtle loading hint on the video area, not a full-screen overlay
  nowPlaying.textContent = (video.videoName || '') + '  ⏳ 加载中...';
  try {
    const resolveResp = await window.api.resolveVideoUrl(video.videoId);

    if (resolveResp.error) {
      console.warn('URL resolution failed:', resolveResp.error);
      showToast('视频地址解析失败，请检查Cookie', 'error');
    }

    if (resolveResp.url) {
      nowPlaying.textContent = video.videoName || '';
      videoPlayer.src = resolveResp.url.url || resolveResp.url;
      videoPlayer.load();
      videoPlayer.play().catch(e => {
        showToast('播放失败: ' + e.message, 'error');
      });
    } else {
      nowPlaying.textContent = video.videoName || '';
      showToast('无法获取视频地址，请检查Cookie', 'error');
    }
  } catch (e) {
    nowPlaying.textContent = video.videoName || '';
    showToast('播放错误: ' + e.message, 'error');
  }
}

// ===== Video Events =====
function setupVideoEvents() {
  const btnPlay = document.getElementById('btn-play');

  videoPlayer.addEventListener('loadedmetadata', () => {
    timeDisplay.textContent = `00:00 / ${fmtTime(videoPlayer.duration)}`;
    // Re-apply playback rate after src change (browser resets to 1.0)
    videoPlayer.playbackRate = parseFloat(speedSelect.value) || 1;
  });

  // Also apply rate on canplay as some browsers reset again
  videoPlayer.addEventListener('canplay', () => {
    const target = parseFloat(speedSelect.value) || 1;
    if (Math.abs(videoPlayer.playbackRate - target) > 0.01) {
      videoPlayer.playbackRate = target;
    }
  });

  // Throttled progress save
  let lastSaveTime = 0;
  videoPlayer.addEventListener('timeupdate', () => {
    if (videoPlayer.duration) {
      const pct = (videoPlayer.currentTime / videoPlayer.duration) * 100;
      seekFill.style.width = pct + '%';
      timeDisplay.textContent = `${fmtTime(videoPlayer.currentTime)} / ${fmtTime(videoPlayer.duration)}`;
    }
    // Update subtitle
    if (subtitleVisible && subtitleData) {
      updateSubtitle(videoPlayer.currentTime);
    }
    // Save progress every 5 seconds
    const now = Date.now();
    if (currentVideo && now - lastSaveTime > 5000) {
      lastSaveTime = now;
      window.api.saveConfig({ lastVideoId: currentVideo.videoId, lastPosition: videoPlayer.currentTime });
    }
  });

  videoPlayer.addEventListener('play', () => {
    btnPlay.textContent = '⏸';
    // If this play was triggered by auto-advance, don't clear userPaused
    if (!isAutoAdvancing) userPaused = false;
  });
  videoPlayer.addEventListener('pause', () => {
    btnPlay.textContent = '▶';
    // The browser fires 'pause' before 'ended' when a video finishes naturally.
    // We can't distinguish that from a user pause at this point, so we use a
    // flag that 'ended' will check. Only set userPaused if we're NOT auto-advancing
    // and the video isn't actually at the end.
    if (!isAutoAdvancing && videoPlayer.currentTime < videoPlayer.duration - 1) {
      userPaused = true;
    }
  });
  videoPlayer.addEventListener('ended', () => {
    btnPlay.textContent = '▶';
    // Natural end — this is NOT a user pause
    userPaused = false;
    // Record progress
    if (currentVideo) {
      recordProgress(currentVideo, videoPlayer.duration);
    }
    // Auto-play next video if enabled and user hasn't manually paused
    if (autoPlayEnabled && !userPaused) {
      const next = findNextVideo();
      if (next) {
        isAutoAdvancing = true;
        showToast('自动播放下一个: ' + next.videoName, '');
        // Find module/node for the next video to call playVideo
        const module = videoList.find(m => m.moduleId === next.moduleId);
        const node = module?.nodeList?.find(n => n.nodeId === next.nodeId);
        if (module && node) {
          playVideo(next, module, node).then(() => {
            isAutoAdvancing = false;
          });
        } else {
          isAutoAdvancing = false;
        }
      } else {
        showToast('已是最后一个视频', '');
      }
    }
  });

  btnPlay.addEventListener('click', () => {
    if (videoPlayer.paused) {
      userPaused = false;
      videoPlayer.play();
    } else {
      userPaused = true;
      videoPlayer.pause();
    }
  });

  // Auto-play toggle
  document.getElementById('btn-autoplay').addEventListener('click', () => {
    autoPlayEnabled = !autoPlayEnabled;
    const btn = document.getElementById('btn-autoplay');
    btn.classList.toggle('active', autoPlayEnabled);
    btn.textContent = autoPlayEnabled ? '🔁 连播' : '⏹ 连播';
    showToast(autoPlayEnabled ? '自动连播已开启' : '自动连播已关闭', '');
  });

  // Play mode toggle: cache-first vs online
  document.getElementById('btn-play-mode').addEventListener('click', () => {
    preferCache = !preferCache;
    const btn = document.getElementById('btn-play-mode');
    btn.classList.toggle('active', preferCache);
    if (preferCache) {
      btn.textContent = '💾 缓存优先';
      showToast('已切换为缓存优先（本地播放，速度快）', '');
    } else {
      btn.textContent = '🌐 线上优先';
      showToast('已切换为线上优先（服务器记录学习进度）', '');
      // If currently playing a cached file, switch to online
      if (currentVideo && videoPlayer.src.startsWith('local-video://')) {
        playOnline(currentVideo);
      }
    }
  });

  // Seek
  seekBar.addEventListener('click', (e) => {
    if (!videoPlayer.duration) return;
    const rect = seekBar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    videoPlayer.currentTime = pct * videoPlayer.duration;
  });

  // Speed control: +/- buttons with 0.1 granularity, range 0.1–5.0
  const MIN_SPEED = 0.1, MAX_SPEED = 5.0, SPEED_STEP = 0.1;

  function getCurrentSpeed() {
    return parseFloat(speedSelect.value) || 1;
  }
  function setSpeed(rate) {
    rate = Math.round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, rate)) * 10) / 10; // clamp + round to 0.1
    speedSelect.value = String(rate);
    videoPlayer.playbackRate = rate;
    const display = document.getElementById('speed-display');
    if (display) display.textContent = rate.toFixed(1) + 'x';
    // Persist to config
    window.api.saveConfig({ playbackSpeed: rate });
  }

  document.getElementById('speed-up').addEventListener('click', () => setSpeed(getCurrentSpeed() + SPEED_STEP));
  document.getElementById('speed-down').addEventListener('click', () => setSpeed(getCurrentSpeed() - SPEED_STEP));

  // Volume
  document.getElementById('btn-volume').addEventListener('click', () => {
    videoPlayer.muted = !videoPlayer.muted;
    document.getElementById('btn-volume').textContent = videoPlayer.muted ? '🔇' : '🔊';
  });
}

function recordProgress(video, endTime) {
  try {
    window.api.recordPlay({
      moduleId: video.moduleId,
      nodeId: video.nodeId,
      videoId: video.id,           // database record ID (e.g. "79599"), NOT the aliyun videoId
      studentId: config.studentId || '',  // studentId is required by the server
      startTime: Math.floor(video.percent || 0),
      endTime: Math.floor(endTime),
      isFast: 0,
      isBack: 0,
      isSpeed: 0
    });
  } catch (e) { /* silent */ }
}

// ===== Subtitle =====
function updateSubtitle(currentTime) {
  if (!subtitleData || !subtitleData.cues) return;
  const cue = subtitleData.cues.find(c => currentTime >= c.start && currentTime <= c.end);
  if (cue) {
    subtitleOverlay.textContent = cue.text;
    subtitleOverlay.classList.add('visible');
  } else {
    subtitleOverlay.classList.remove('visible');
  }
}

function parseVTT(content) {
  const cues = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    // Look for timestamp line
    const match = line.match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (match) {
      const start = parseInt(match[1])*3600 + parseInt(match[2])*60 + parseInt(match[3]) + parseInt(match[4])/1000;
      const end = parseInt(match[5])*3600 + parseInt(match[6])*60 + parseInt(match[7]) + parseInt(match[8])/1000;
      let text = '';
      i++;
      while (i < lines.length && lines[i].trim()) {
        text += (text ? '\n' : '') + lines[i].trim();
        i++;
      }
      // Strip HTML tags
      text = text.replace(/<[^>]+>/g, '');
      cues.push({ start, end, text });
    }
    i++;
  }
  return cues;
}

function parseSRT(content) {
  return parseVTT(content); // same parser works for both
}

// Load subtitle from a file path (used by playVideo auto-load and manual toggle)
async function loadSubtitleFromFile(subtitlePath) {
  try {
    const content = await window.api.readFile(subtitlePath);
    if (content) {
      const cues = content.includes('WEBVTT') ? parseVTT(content) : parseSRT(content);
      if (cues.length > 0) {
        subtitleData = { cues, content };
        document.getElementById('btn-subtitle').classList.add('active');
        showToast('已加载字幕 (' + cues.length + ' 条)', 'success');
        return true;
      }
    }
  } catch (e) { /* no subtitle */ }
  return false;
}

async function loadCachedSubtitle(videoId) {
  // Use cache:check which now returns subtitle path directly
  const cacheCheck = await window.api.checkCache(videoId);
  if (cacheCheck.cached && cacheCheck.subtitle) {
    return await loadSubtitleFromFile(cacheCheck.subtitle);
  }
  return false;
}

// ===== Subtitle toggle =====
document.getElementById('btn-subtitle').addEventListener('click', async () => {
  if (!subtitleData) {
    // Try to load cached subtitle
    if (currentVideo) {
      showToast('正在查找字幕...');
      await loadCachedSubtitle(currentVideo.videoId);
      if (!subtitleData) {
        showToast('无可用字幕，请先提取字幕', 'error');
        return;
      }
    }
    return;
  }
  subtitleVisible = !subtitleVisible;
  document.getElementById('btn-subtitle').classList.toggle('active', subtitleVisible);
  if (!subtitleVisible) subtitleOverlay.classList.remove('visible');
});

// ===== Auto-play next video =====
let autoPlayEnabled = true;       // auto-advance when video ends naturally
let userPaused = false;           // true when user manually paused (not auto-next)
let isAutoAdvancing = false;      // true while we're in the middle of auto-advancing

// Find the next video in flatVideos after currentVideo (same chapter order)
function findNextVideo() {
  if (!currentVideo || flatVideos.length === 0) return null;
  const idx = flatVideos.findIndex(v => v.videoId === currentVideo.videoId);
  if (idx === -1 || idx >= flatVideos.length - 1) return null;
  return flatVideos[idx + 1];
}

// ===== Subtitle extraction (background, non-blocking) =====
document.getElementById('btn-extract-sub').addEventListener('click', async () => {
  if (!currentVideo) { showToast('请先选择视频', 'error'); return; }
  const cacheCheck = await window.api.checkCache(currentVideo.videoId);
  if (!cacheCheck.cached) {
    showToast('请先缓存视频再提取字幕', 'error');
    return;
  }

  // Show progress badge on the button instead of blocking loading overlay
  const btn = document.getElementById('btn-extract-sub');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 提取中...';
  showToast('字幕提取已在后台启动，不影响播放');

  // Listen for progress
  const removeProgress = window.api.onSubtitleProgress((data) => {
    if (data.videoId === currentVideo.videoId && data.message) {
      btn.textContent = '⏳ ' + data.message.substring(0, 20);
    }
  });

  try {
    const result = await window.api.extractSubtitle(currentVideo.videoId);
    if (result.success) {
      const cues = result.content.includes('WEBVTT') ? parseVTT(result.content) : parseSRT(result.content);
      subtitleData = { cues, content: result.content };
      subtitleVisible = true;
      document.getElementById('btn-subtitle').classList.add('active');
      showToast(`字幕提取成功 (${cues.length}条)`, 'success');
    } else {
      showToast('字幕提取失败: ' + (result.error || result.message || ''), 'error');
    }
  } catch (e) {
    showToast('字幕提取错误: ' + e.message, 'error');
  }
  removeProgress();
  btn.disabled = false;
  btn.textContent = originalText;
});

// ===== Cache Current Video =====
document.getElementById('btn-cache-current').addEventListener('click', async () => {
  if (!currentVideo) { showToast('请先选择视频', 'error'); return; }
  await cacheVideo(currentVideo);
});

async function cacheVideo(video) {
  const cacheCheck = await window.api.checkCache(video.videoId);
  if (cacheCheck.cached) {
    showToast('该视频已缓存');
    return true;
  }

  showToast('正在下载: ' + video.videoName);
  try {
    const resolveResp = await window.api.resolveVideoUrl(video.videoId);
    if (resolveResp.error || !resolveResp.url) {
      showToast('无法获取视频地址: ' + (resolveResp.error || '未知错误'), 'error');
      return false;
    }

    const videoUrl = resolveResp.url.url || resolveResp.url;

    const dlResult = await window.api.downloadVideo({
      videoId: video.videoId,
      videoName: video.videoName,
      moduleName: video.moduleName,
      nodeName: video.nodeName,
      url: videoUrl
    });

    if (dlResult.success) {
      showToast('缓存成功: ' + video.videoName, 'success');
      isVideoCached[video.videoId] = true;
      await refreshCacheStatus();
      return true;
    } else {
      showToast('缓存失败: ' + dlResult.error, 'error');
      return false;
    }
  } catch (e) {
    showToast('缓存错误: ' + e.message, 'error');
    return false;
  }
}

// ===== Cache All (background, non-blocking) =====
let cacheAllRunning = false;
let cacheAllInterval = null;

document.getElementById('btn-cache-all').addEventListener('click', async () => {
  if (flatVideos.length === 0) { showToast('请先加载视频列表', 'error'); return; }
  if (cacheAllRunning) { showToast('缓存任务正在进行中', ''); return; }

  const unwatched = flatVideos.filter(v => !isVideoCached[v.videoId]);
  if (unwatched.length === 0) { showToast('所有视频已缓存', 'success'); return; }

  if (!confirm(`确定要在后台缓存 ${unwatched.length} 个视频吗？\n（共 ${flatVideos.length} 个，已缓存 ${flatVideos.length - unwatched.length} 个）\n\n缓存期间可继续播放视频，不影响操作。`)) return;

  // Start background cache loop — does NOT block playback
  cacheAllRunning = true;
  const btn = document.getElementById('btn-cache-all');
  btn.disabled = true;

  let success = 0, failed = 0;
  for (let i = 0; i < unwatched.length; i++) {
    const v = unwatched[i];
    btn.textContent = `⏳ 缓存 ${i + 1}/${unwatched.length}`;
    const ok = await cacheVideoSilent(v);
    if (ok) {
      success++;
      // Refresh cache badges without blocking
      refreshCacheStatus();
    } else {
      failed++;
    }
  }

  cacheAllRunning = false;
  btn.disabled = false;
  btn.textContent = '⬇ 缓存全部';
  showToast(`缓存完成: 成功${success} 失败${failed}`, success > 0 ? 'success' : 'error');
  await refreshCacheStatus();
});

async function cacheVideoSilent(video) {
  try {
    const resolveResp = await window.api.resolveVideoUrl(video.videoId);
    if (resolveResp.error || !resolveResp.url) return false;
    const videoUrl = resolveResp.url.url || resolveResp.url;
    const dlResult = await window.api.downloadVideo({
      videoId: video.videoId, videoName: video.videoName,
      moduleName: video.moduleName, nodeName: video.nodeName,
      url: videoUrl
    });
    if (dlResult.success) { isVideoCached[video.videoId] = true; return true; }
    return false;
  } catch { return false; }
}

// ===== Batch subtitle extraction (background) =====
let subtitleBatchInterval = null;

document.getElementById('btn-subtitle-all').addEventListener('click', async () => {
  const result = await window.api.extractAllSubtitles();
  if (result.alreadyRunning) {
    showToast('批量提取正在进行中', '');
    return;
  }
  if (result.message && result.message.includes('都已有字幕')) {
    showToast(result.message, 'success');
    return;
  }
  showToast(result.message || '批量提取已启动', 'success');
  startSubtitleBatchPolling();
});

function startSubtitleBatchPolling() {
  if (subtitleBatchInterval) clearInterval(subtitleBatchInterval);
  const btn = document.getElementById('btn-subtitle-all');

  subtitleBatchInterval = setInterval(async () => {
    const status = await window.api.getSubtitleBatchStatus();

    if (status.status === 'running') {
      btn.disabled = true;
      btn.textContent = `⏳ 字幕 ${status.current}/${status.total} (${status.progress}%)`;
    } else if (status.status === 'done') {
      clearInterval(subtitleBatchInterval);
      subtitleBatchInterval = null;
      btn.disabled = false;
      btn.textContent = '💬 提取全部字幕';

      const success = status.results.filter(r => r.success).length;
      const failed = status.results.filter(r => !r.success).length;
      if (failed === 0) {
        showToast(`字幕提取完成！成功 ${success} 个`, 'success');
      } else {
        showToast(`字幕提取完成: 成功${success} 失败${failed}`, success > failed ? 'success' : 'error');
      }
      await refreshCacheStatus();
    } else {
      btn.disabled = false;
      btn.textContent = '💬 提取全部字幕';
    }
  }, 1000);
}

// ===== Refresh cache status badges =====
async function refreshCacheStatus() {
  try {
    const cached = await window.api.listCache();
    isVideoCached = {};
    cached.forEach(c => { isVideoCached[c.videoId] = c.file; });
    // Update tree badges
    document.querySelectorAll('.video-item').forEach(el => {
      const vid = el.dataset.vid;
      const existing = el.querySelector('.vbadge.cached');
      if (isVideoCached[vid]) {
        if (!existing) {
          const badge = document.createElement('span');
          badge.className = 'vbadge cached';
          badge.textContent = '已缓存';
          el.appendChild(badge);
        }
      } else {
        if (existing) existing.remove();
      }
    });
  } catch (e) { /* silent */ }
}

// ===== Sidebar toggle =====
document.getElementById('toggle-sidebar').addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

// ===== Search =====
document.getElementById('search-input').addEventListener('input', (e) => {
  renderTree(e.target.value.trim());
});

// ===== Refresh button =====
document.getElementById('btn-refresh').addEventListener('click', async () => {
  await loadVideoList();
  await refreshCacheStatus();
  showToast('已刷新', 'success');
});

// ===== Cache Manager =====
document.getElementById('btn-cache-manager').addEventListener('click', async () => {
  await renderCacheList();
  document.getElementById('cache-dialog').classList.add('visible');
});

async function renderCacheList() {
  const body = document.getElementById('cache-list-body');
  body.innerHTML = '加载中...';
  try {
    const cached = await window.api.listCache();
    if (cached.length === 0) {
      body.innerHTML = '<div style="text-align:center;color:#555;padding:20px;">暂无缓存视频</div>';
      return;
    }
    body.innerHTML = '';
    cached.forEach(item => {
      const sizeMB = (item.size / 1024 / 1024).toFixed(1);
      const el = document.createElement('div');
      el.className = 'cache-item';
      const displayName = item.module && item.node
        ? `${item.module} / ${item.node} / ${item.name}`
        : (item.name || item.videoId);
      el.innerHTML = `
        <span class="ci-name" title="${displayName}">${displayName}</span>
        <span class="ci-size">${sizeMB} MB</span>
        ${item.hasSubtitle ? '<span style="color:#6abf6a;">字幕✓</span>' : ''}
        <button class="ci-delete" data-vid="${item.videoId}">删除</button>
      `;
      el.querySelector('.ci-delete').addEventListener('click', async () => {
        await window.api.deleteCache(item.videoId);
        await renderCacheList();
        await refreshCacheStatus();
        showToast('已删除', 'success');
      });
      body.appendChild(el);
    });
  } catch (e) {
    body.innerHTML = '<div style="color:#c0392b;">' + e.message + '</div>';
  }
}

// ===== Settings =====
document.getElementById('btn-settings').addEventListener('click', async () => {
  document.getElementById('cfg-cookies').value = (config.cookies || '') + (config.session ? '; SESSION=' + config.session : '');
  document.getElementById('cfg-llm-url').value = config.llmBaseUrl || '';
  document.getElementById('cfg-llm-key').value = config.llmApiKey || '';
  document.getElementById('cfg-llm-model').value = config.llmModel || '';

  // Show current cache dir
  const currentCacheDir = await window.api.getCacheDir();
  document.getElementById('cfg-cache-dir').value = currentCacheDir;

  // Bind choose cache dir button
  const chooseBtn = document.getElementById('btn-choose-cache-dir');
  // Clone to remove old listeners
  const newChooseBtn = chooseBtn.cloneNode(true);
  chooseBtn.parentNode.replaceChild(newChooseBtn, chooseBtn);
  newChooseBtn.addEventListener('click', async () => {
    const dir = await window.api.chooseDirectory('选择缓存目录');
    if (dir) {
      const result = await window.api.setCacheDir(dir);
      if (result.success) {
        document.getElementById('cfg-cache-dir').value = dir;
        config.cacheDir = dir;
        showToast('缓存目录已更新，后续缓存将保存到新目录', 'success');
        await renderBinStatus(); // whisper path also changes
      } else {
        showToast('设置失败: ' + result.error, 'error');
      }
    }
  });

  // Bind open cache dir button
  const openBtn = document.getElementById('btn-open-cache-dir');
  const newOpenBtn = openBtn.cloneNode(true);
  openBtn.parentNode.replaceChild(newOpenBtn, openBtn);
  newOpenBtn.addEventListener('click', () => window.api.openCacheFolder());

  // Check bins
  await renderBinStatus();

  // Fetch user info to verify login
  fetchAndShowUserInfo();

  document.getElementById('settings-dialog').classList.add('visible');
});

// Global whisper download listener (persists across settings dialog open/close)
let whisperProgressInterval = null;

async function renderBinStatus() {
  const bins = await window.api.checkBins();
  const dlStatus = await window.api.getDownloadStatus();
  let html = `
    ffmpeg: ${bins.ffmpeg ? '✅ 已安装' + (bins.ffmpegAuto ? '（自动）' : '') : '❌ 未安装'}<br>
    GPU加速: ${bins.gpuAvailable ? '🚀 已启用 (faster-whisper CUDA)' : '⚠️ 未启用 (使用CPU)'}<br>
    whisper: ${bins.whisper ? '✅ 已安装' : '❌ 未安装'}<br>
    whisper 模型: ${bins.model ? '✅ 已安装' : '❌ 未安装'}<br>
  `;

  // If everything is installed, show success
  if (bins.whisper && bins.model) {
    html += `<div style="margin-top:6px;color:#5a8a5a;font-size:11px;">🎉 所有工具已就绪，可以提取字幕</div>`;
    document.getElementById('bin-status').innerHTML = html;
    return;
  }

  // Show download progress bar (always present when not fully installed)
  const isDownloading = dlStatus.status === 'downloading';
  const isDone = dlStatus.status === 'done';
  const isError = dlStatus.status === 'error';

  html += `
    <div style="margin-top:10px;padding:10px;background:#0d0d1a;border-radius:6px;">
      <div id="whisper-dl-progress" style="${(isDownloading || isDone || isError) ? 'display:block;' : 'display:none;'}margin-bottom:8px;">
        <div style="background:#0f3460;border-radius:3px;height:18px;overflow:hidden;">
          <div id="whisper-dl-bar" style="background:${isError ? '#c0392b' : (isDone ? '#2d6a2d' : '#e94560')};height:100%;width:${dlStatus.progress || 0}%;transition:width 0.3s;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;">${dlStatus.progress || 0}%</div>
        </div>
        <div id="whisper-dl-msg" style="font-size:11px;color:${isError ? '#c0392b' : (isDone ? '#6abf6a' : '#8090b0')};margin-top:4px;">${dlStatus.message || ''}</div>
      </div>
      <button id="btn-dl-whisper" style="background:${isDownloading ? '#0f3460' : '#e94560'};color:${isDownloading ? '#8090b0' : '#fff'};border:none;padding:6px 16px;border-radius:4px;cursor:${isDownloading ? 'not-allowed' : 'pointer'};font-size:12px;width:100%;" ${isDownloading ? 'disabled' : ''}>
        ${isDownloading ? '⏳ 后台下载中...（可关闭设置，不影响）' : (isError ? '🔄 重新下载安装 whisper（约75MB）' : '⬇ 一键下载安装 whisper（约75MB）')}
      </button>
    </div>
  `;

  html += `<span style="color:#555;font-size:10px;display:block;margin-top:6px;">ffmpeg 随程序自动安装；whisper 自动使用系统代理后台下载，可关闭设置窗口</span>`;
  document.getElementById('bin-status').innerHTML = html;

  // Bind download button
  const dlBtn = document.getElementById('btn-dl-whisper');
  if (dlBtn && !isDownloading) {
    dlBtn.addEventListener('click', async () => {
      // Start background download (non-blocking)
      await window.api.downloadWhisper();
      // Immediately re-render to show progress
      startWhisperProgressPolling();
    });
  }

  // If already downloading, start polling for progress updates
  if (isDownloading) {
    startWhisperProgressPolling();
  }
}

// Poll whisper download status (works even when reopening settings)
function startWhisperProgressPolling() {
  if (whisperProgressInterval) clearInterval(whisperProgressInterval);

  whisperProgressInterval = setInterval(async () => {
    const status = await window.api.getDownloadStatus();

    // Update UI elements if they exist (settings might be closed)
    const bar = document.getElementById('whisper-dl-bar');
    const msg = document.getElementById('whisper-dl-msg');
    const progressDiv = document.getElementById('whisper-dl-progress');
    const btn = document.getElementById('btn-dl-whisper');

    if (bar) {
      bar.style.width = (status.progress || 0) + '%';
      bar.textContent = (status.progress || 0) + '%';
      bar.style.background = status.status === 'error' ? '#c0392b' : (status.status === 'done' ? '#2d6a2d' : '#e94560');
    }
    if (msg) {
      msg.textContent = status.message || '';
      msg.style.color = status.status === 'error' ? '#c0392b' : (status.status === 'done' ? '#6abf6a' : '#8090b0');
    }
    if (progressDiv) progressDiv.style.display = 'block';

    // Stop polling when done or error
    if (status.status === 'done' || status.status === 'error') {
      clearInterval(whisperProgressInterval);
      whisperProgressInterval = null;
      if (status.status === 'done') {
        showToast('whisper 安装成功！', 'success');
        // Re-render to show installed status
        renderBinStatus();
      } else {
        showToast('whisper 下载失败: ' + status.error, 'error');
        renderBinStatus();
      }
    }
  }, 1000);
}

// ===== Fetch and display user info =====
async function fetchAndShowUserInfo() {
  const box = document.getElementById('user-info-display');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = '<span style="color:#8090b0;">⏳ 正在验证登录状态...</span>';
  try {
    const resp = await window.api.queryUser();
    if (resp.success && resp.result) {
      const u = resp.result;
      config.studentId = u.id || u.studentId || '';
      window.api.saveConfig({ studentId: config.studentId });
      const name = u.studentName || u.name || u.nickName || u.account || '未知';
      const id = u.id || u.studentId || '未知';
      const cls = u.className || u.clazzName || u.clazz || '';
      box.innerHTML = '<span style="color:#6abf6a;">✅ 登录有效</span>' +
        '<br><span style="color:#a0a0c0;">姓名: ' + name + '</span>' +
        '<br><span style="color:#a0a0c0;">学生ID: ' + id + '</span>' +
        (cls ? '<br><span style="color:#a0a0c0;">班级: ' + cls + '</span>' : '') +
        '<br><span style="color:#5a8a5a;font-size:11px;">学习进度记录功能正常</span>';
    } else {
      config.studentId = '';
      box.innerHTML = '<span style="color:#c0392b;">❌ 登录已过期或无效</span>' +
        '<br><span style="color:#c0392b;font-size:11px;">请重新登录 tsp.boxuegu.com 复制最新 Cookie</span>';
    }
  } catch (e) {
    box.innerHTML = '<span style="color:#c0392b;">❌ 无法获取用户信息: ' + e.message + '</span>';
  }
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const cookiesVal = document.getElementById('cfg-cookies').value.trim();
  // Parse cookies - extract SESSION
  let session = '';
  let cookies = cookiesVal;
  const sessionMatch = cookiesVal.match(/SESSION=([^;]+)/);
  if (sessionMatch) session = sessionMatch[1];

  await window.api.saveConfig({
    cookies: cookies,
    session: session,
    llmBaseUrl: document.getElementById('cfg-llm-url').value.trim(),
    llmApiKey: document.getElementById('cfg-llm-key').value.trim(),
    llmModel: document.getElementById('cfg-llm-model').value.trim()
  });
  config = await window.api.getConfig();
  // Verify login and show user info
  await fetchAndShowUserInfo();
  showToast('设置已保存', 'success');
  // Reload video list
  await loadVideoList();
});

// ===== AI Analysis =====
document.getElementById('btn-ai-analyze').addEventListener('click', () => {
  aiPanel.classList.add('visible');
});

document.getElementById('btn-close-ai').addEventListener('click', () => {
  aiPanel.classList.remove('visible');
});

document.getElementById('btn-run-ai').addEventListener('click', async () => {
  if (!currentVideo) { showToast('请先选择视频', 'error'); return; }

  // Get subtitle content
  let subtitleText = '';
  if (subtitleData && subtitleData.content) {
    subtitleText = subtitleData.content;
  } else {
    // Try to load cached subtitle
    await loadCachedSubtitle(currentVideo.videoId);
    if (subtitleData && subtitleData.content) {
      subtitleText = subtitleData.content;
    } else {
      // Try to extract
      showToast('无字幕，后台提取中...', '');
      const cacheCheck = await window.api.checkCache(currentVideo.videoId);
      if (!cacheCheck.cached) {
        aiContent.innerHTML = '<div class="ai-placeholder">⚠️ 需要先缓存视频并提取字幕才能进行AI解读</div>';
        return;
      }
      aiContent.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在后台提取字幕...</p></div>';
      const result = await window.api.extractSubtitle(currentVideo.videoId);
      if (result.success) {
        subtitleText = result.content;
        const cues = subtitleText.includes('WEBVTT') ? parseVTT(subtitleText) : parseSRT(subtitleText);
        subtitleData = { cues, content: subtitleText };
      } else {
        aiContent.innerHTML = '<div class="ai-placeholder">⚠️ 字幕提取失败: ' + (result.error || result.message || '') + '</div>';
        return;
      }
    }
  }

  // Extract plain text from subtitle
  const plainText = (subtitleData.cues || []).map(c => c.text).join('\n');
  if (!plainText.trim()) {
    aiContent.innerHTML = '<div class="ai-placeholder">⚠️ 字幕内容为空</div>';
    return;
  }

  // Call LLM
  aiContent.innerHTML = '<div class="loading"><div class="spinner"></div><p>AI正在分析中...</p></div>';
  document.getElementById('btn-run-ai').disabled = true;

  try {
    const result = await callLLM(plainText, currentVideo.videoName);
    aiContent.innerHTML = result;
  } catch (e) {
    aiContent.innerHTML = `<div class="ai-placeholder" style="color:#c0392b;">❌ AI分析失败: ${e.message}<br><br>请检查设置中的大模型配置。</div>`;
  }
  document.getElementById('btn-run-ai').disabled = false;
});

async function callLLM(subtitleText, videoName) {
  const url = config.llmBaseUrl.replace(/\/$/, '') + '/chat/completions';
  const prompt = `你是一位专业的编程教育导师。以下是视频《${videoName}》的字幕内容。请对内容进行结构化总结，方便学生学习和复习。

请按以下格式输出：

## 📌 核心主题
（一句话概括本视频讲什么）

## 🎯 学习目标
（学完本视频后应该掌握的知识点，用列表形式）

## 📖 详细知识点
（按逻辑顺序列出所有重要知识点，每个知识点包含简要说明）

## 💻 关键代码/命令（如有）
（提取视频中提到的代码片段或命令）

## ⚠️ 注意事项/易错点
（容易出错或需要特别注意的地方）

## 📝 总结
（本节内容的要点回顾）

字幕内容：
${subtitleText.substring(0, 12000)}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.llmApiKey
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  let content = data.choices?.[0]?.message?.content || '无返回内容';

  // Simple markdown to HTML
  content = content
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h4>$1</h4>')
    .replace(/^# (.+)$/gm, '<h4>$1</h4>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre style="background:#0d0d1a;padding:8px;border-radius:4px;overflow-x:auto;font-size:12px;margin:8px 0;">$2</pre>')
    .replace(/`([^`]+)`/g, '<code style="background:#0d0d1a;padding:2px 4px;border-radius:2px;">$1</code>')
    .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return '<div>' + content + '</div>';
}

// ===== Keyboard shortcuts =====
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!videoPlayer.src) return;

  switch(e.key) {
    case ' ':
      e.preventDefault();
      if (videoPlayer.paused) { userPaused = false; videoPlayer.play(); }
      else { userPaused = true; videoPlayer.pause(); }
      break;
    case 'ArrowLeft':
      videoPlayer.currentTime -= 5;
      break;
    case 'ArrowRight':
      videoPlayer.currentTime += 5;
      break;
    case 'ArrowUp':
      e.preventDefault();
      videoPlayer.volume = Math.min(1, videoPlayer.volume + 0.1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      videoPlayer.volume = Math.max(0, videoPlayer.volume - 0.1);
      break;
    case '[':
    case ',':
      e.preventDefault();
      { const cur = parseFloat(speedSelect.value) || 1; const ns = Math.round(Math.max(0.1, cur - 0.1) * 10) / 10;
        speedSelect.value = String(ns); videoPlayer.playbackRate = ns;
        document.getElementById('speed-display').textContent = ns.toFixed(1) + 'x';
        window.api.saveConfig({ playbackSpeed: ns }); showToast('倍速: ' + ns.toFixed(1) + 'x', ''); }
      break;
    case ']':
    case '.':
      e.preventDefault();
      { const cur = parseFloat(speedSelect.value) || 1; const ns = Math.round(Math.min(5.0, cur + 0.1) * 10) / 10;
        speedSelect.value = String(ns); videoPlayer.playbackRate = ns;
        document.getElementById('speed-display').textContent = ns.toFixed(1) + 'x';
        window.api.saveConfig({ playbackSpeed: ns }); showToast('倍速: ' + ns.toFixed(1) + 'x', ''); }
      break;
  }
});

// ===== Start =====
init();
