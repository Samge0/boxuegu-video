// ===== Global State =====
let config = {};
let videoList = [];      // raw API data
let flatVideos = [];     // flattened for search
let currentVideo = null; // { videoId, videoName, id, moduleId, nodeId, duration, percent, ... }
let isVideoCached = {};  // videoId -> true/path
let subtitleData = null; // { cues: [{start, end, text}], vtt: string }
let subtitleVisible = false;
let subtitleWanted = true; // user's global preference: auto-show subtitles when available
let currentVideoElement = null;

// ===== Theme toggle =====
const themeBtn = document.getElementById('btn-theme');
function applyThemeIcon() {
  const isDark = document.documentElement.classList.contains('dark');
  themeBtn.textContent = isDark ? '🌙' : '☀️';
}
themeBtn.addEventListener('click', () => {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  applyThemeIcon();
});
applyThemeIcon();

// GitHub link: open in system browser
document.getElementById('github-link').addEventListener('click', (e) => {
  e.preventDefault();
  const url = e.currentTarget.href;
  if (url) window.api.openExternal(url);
});

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

// Compare semantic versions: returns true if latest > current (e.g. "1.0.2" > "1.0.1")
function isNewerVersion(latest, current) {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

// ===== Init =====
async function init() {
  config = await window.api.getConfig();

  // Set app version in topbar + check for updates
  try {
    const ver = await window.api.getVersion();
    const verStr = 'v' + ver;
    document.getElementById('app-version').textContent = verStr;
    // Check for updates in the background (non-blocking)
    window.api.checkUpdate().then(result => {
      if (result.success && result.latest) {
        // Normalize: strip leading 'v' for comparison
        const latestClean = result.latest.replace(/^v/, '');
        const currentClean = ver.replace(/^v/, '');
        if (isNewerVersion(latestClean, currentClean)) {
          document.getElementById('update-badge').style.display = 'block';
          // Redirect github link to releases page
          document.getElementById('github-link').href = 'https://github.com/Samge0/boxuegu-video/releases';
          document.getElementById('github-link').title = `新版本可用: ${result.latest}（当前 ${verStr}）`;
        }
      }
    }).catch(() => {});
  } catch (e) { /* silent */ }

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

  // Restore last played video + resume position (seek now works with Range support)
  const savedVideoId = config.lastVideoId;
  const savedPosition = config.lastPosition || 0;
  if (savedVideoId) {
    const lastVideo = flatVideos.find(v => v.videoId === savedVideoId);
    if (lastVideo) {
      const module = videoList.find(m => m.moduleId === lastVideo.moduleId);
      const node = module?.nodeList?.find(n => n.nodeId === lastVideo.nodeId);
      if (module && node) {
        const resumeMsg = savedPosition > 5
          ? `恢复播放: ${lastVideo.videoName} (${fmtTime(savedPosition)})`
          : '恢复上次播放: ' + lastVideo.videoName;
        showToast(resumeMsg, '');
        const playMode = await playVideo(lastVideo, module, node);
        // Seek to saved position after metadata loads (only for cached — online may not support Range)
        if (savedPosition > 5 && playMode === 'cache') {
          const seekOnce = () => {
            if (videoPlayer.duration && savedPosition < videoPlayer.duration - 2) {
              videoPlayer.currentTime = savedPosition;
            }
            videoPlayer.removeEventListener('loadedmetadata', seekOnce);
          };
          videoPlayer.addEventListener('loadedmetadata', seekOnce);
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
  sidebarTree.innerHTML = '<div style="padding: 20px; text-align: center; color: #6e6e73;">加载中...</div>';
  try {
    const resp = await window.api.getVideoList();
    if (!resp.success) {
      sidebarTree.innerHTML = `<div style="padding:20px;color:#ff3b30;">加载失败: ${resp.result || '请检查Cookie设置'}<br><br>请到设置中配置Cookie。</div>`;
      return;
    }
    videoList = resp.result || [];
    flatVideos = [];
    renderTree();
  } catch (e) {
    sidebarTree.innerHTML = `<div style="padding:20px;color:#ff3b30;">加载失败: ${e.message}</div>`;
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
        // Preserve "active" state across re-renders (e.g. after refresh)
        if (currentVideo && currentVideo.videoId === video.videoId) {
          vEl.classList.add('active');
        }
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

// ===== Mark active video in sidebar tree (set active class + scroll into view) =====
function markActiveVideo(videoId) {
  // Clear previous active
  document.querySelectorAll('.video-item.active').forEach(el => el.classList.remove('active'));
  if (!videoId) return;
  const itemEl = document.querySelector(`.video-item[data-vid="${videoId}"]`);
  if (itemEl) {
    itemEl.classList.add('active');
    // Ensure all parent sections are expanded so the item is visible
    let parent = itemEl.parentElement;
    while (parent && parent !== sidebarTree) {
      if (parent.classList.contains('node-children') || parent.classList.contains('video-list')) {
        parent.classList.add('expanded');
        const siblingArrow = parent.previousElementSibling?.querySelector('.arrow');
        if (siblingArrow) siblingArrow.classList.add('expanded');
      }
      parent = parent.parentElement;
    }
    // Scroll the item into view within the sidebar
    requestAnimationFrame(() => {
      itemEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
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

  // Reset AI subtitle context when switching videos (history is loaded lazily by loadAIHistoryForCurrentVideo)
  aiSubtitleContext = '';
  // If AI panel is open, refresh it for the new video (loads history from disk)
  if (aiPanel.classList.contains('visible')) {
    loadAIHistoryForCurrentVideo();
  }

  // Remember this as the last played video (NOT position — always play from start)
  window.api.saveConfig({ lastVideoId: video.videoId });

  // Update active state in tree (+ scroll into view)
  markActiveVideo(video.videoId);

  nowPlaying.textContent = `${video.videoName}`;
  videoControls.style.display = 'flex';
  placeholder.style.display = 'none';
  videoPlayer.style.display = 'block';

  // Reset subtitle data (will be re-loaded if available), but keep user's preference
  subtitleData = null;
  subtitleVisible = false;
  subtitleOverlay.classList.remove('visible');
  document.getElementById('btn-subtitle').classList.remove('active');

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

  // Throttled progress save for resume-on-restart
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
    // Save playback position every 5 seconds (for resume on next launch)
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
        // Remember the just-finished video BEFORE playVideo switches currentVideo
        const finishedVideoId = currentVideo?.videoId;
        // Find module/node for the next video to call playVideo
        const module = videoList.find(m => m.moduleId === next.moduleId);
        const node = module?.nodeList?.find(n => n.nodeId === next.nodeId);
        if (module && node) {
          playVideo(next, module, node).then(() => {
            isAutoAdvancing = false;
            // Mark the just-finished video as played in-place (no list reload → no UI jitter)
            if (finishedVideoId) {
              const finishedEl = document.querySelector(`.video-item[data-vid="${finishedVideoId}"]`);
              if (finishedEl) finishedEl.classList.add('played');
            }
            // If subtitle drawer is open, refresh it for the new video
            if (document.getElementById('subtitle-viewer-dialog').classList.contains('visible')) {
              refreshSubtitleDrawer();
            }
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

  // Play mode toggle: cache-first vs online — seamless switch preserving seek position
  document.getElementById('btn-play-mode').addEventListener('click', async () => {
    preferCache = !preferCache;
    const btn = document.getElementById('btn-play-mode');
    btn.classList.toggle('active', preferCache);

    // If a video is playing, capture position and reload from the new source
    if (currentVideo && videoPlayer.src) {
      const savedTime = videoPlayer.currentTime || 0;
      const wasPlaying = !videoPlayer.paused;

      const seekAfterLoad = () => {
        const trySeek = () => {
          if (videoPlayer.duration && savedTime < videoPlayer.duration - 1) {
            videoPlayer.currentTime = savedTime;
          }
          if (wasPlaying) videoPlayer.play().catch(() => {});
          videoPlayer.removeEventListener('loadedmetadata', trySeek);
        };
        videoPlayer.addEventListener('loadedmetadata', trySeek);
      };

      if (preferCache) {
        btn.textContent = '💾 缓存优先';
        showToast('切换为缓存优先，正在加载...', '');
        // Switch from online to cache
        const cacheCheck = await window.api.checkCache(currentVideo.videoId);
        if (cacheCheck.cached) {
          playLocalFile(cacheCheck.path, currentVideo);
          seekAfterLoad();
          if (cacheCheck.subtitle) loadSubtitleFromFile(cacheCheck.subtitle);
        } else {
          showToast('该视频未缓存，继续线上播放', '');
          preferCache = false;
          btn.classList.remove('active');
          btn.textContent = '🌐 线上优先';
        }
      } else {
        btn.textContent = '🌐 线上优先';
        showToast('切换为线上优先，正在加载...', '');
        // Switch from cache to online
        await playOnline(currentVideo);
        seekAfterLoad();
      }
    } else {
      if (preferCache) {
        btn.textContent = '💾 缓存优先';
        showToast('已切换为缓存优先', '');
      } else {
        btn.textContent = '🌐 线上优先';
        showToast('已切换为线上优先', '');
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
        // Auto-show if user wants subtitles on (default true)
        if (subtitleWanted) {
          subtitleVisible = true;
        }
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
      // loadSubtitleFromFile already set subtitleVisible=true if subtitleWanted
      return;
    }
    return;
  }
  subtitleVisible = !subtitleVisible;
  // Remember user's preference so it persists across video switches
  subtitleWanted = subtitleVisible;
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
      // Respect user's global subtitle preference
      subtitleVisible = subtitleWanted;
      document.getElementById('btn-subtitle').classList.toggle('active', subtitleVisible);
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
  // Re-apply active state + scroll to currently playing video
  if (currentVideo) markActiveVideo(currentVideo.videoId);
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
      body.innerHTML = '<div style="text-align:center;color:#6e6e73;padding:20px;">暂无缓存视频</div>';
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
        ${item.hasSubtitle ? '<span style="color:#34c759;">字幕✓</span>' : ''}
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
    body.innerHTML = '<div style="color:#ff3b30;">' + e.message + '</div>';
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
    html += `<div style="margin-top:6px;color:#34c759;font-size:11px;">🎉 所有工具已就绪，可以提取字幕</div>`;
    document.getElementById('bin-status').innerHTML = html;
    return;
  }

  // Show download progress bar (always present when not fully installed)
  const isDownloading = dlStatus.status === 'downloading';
  const isDone = dlStatus.status === 'done';
  const isError = dlStatus.status === 'error';

  html += `
    <div style="margin-top:10px;padding:10px;background:#f5f5f7;border-radius:6px;">
      <div id="whisper-dl-progress" style="${(isDownloading || isDone || isError) ? 'display:block;' : 'display:none;'}margin-bottom:8px;">
        <div style="background:#f5f5f7;border-radius:3px;height:18px;overflow:hidden;">
          <div id="whisper-dl-bar" style="background:${isError ? '#ff3b30' : (isDone ? '#34c759' : '#0071e3')};height:100%;width:${dlStatus.progress || 0}%;transition:width 0.3s;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;">${dlStatus.progress || 0}%</div>
        </div>
        <div id="whisper-dl-msg" style="font-size:11px;color:${isError ? '#ff3b30' : (isDone ? '#34c759' : '#6e6e73')};margin-top:4px;">${dlStatus.message || ''}</div>
      </div>
      <button id="btn-dl-whisper" style="background:${isDownloading ? '#f5f5f7' : '#0071e3'};color:${isDownloading ? '#6e6e73' : '#fff'};border:none;padding:6px 16px;border-radius:4px;cursor:${isDownloading ? 'not-allowed' : 'pointer'};font-size:12px;width:100%;" ${isDownloading ? 'disabled' : ''}>
        ${isDownloading ? '⏳ 后台下载中...（可关闭设置，不影响）' : (isError ? '🔄 重新下载安装 whisper（约75MB）' : '⬇ 一键下载安装 whisper（约75MB）')}
      </button>
    </div>
  `;

  html += `<span style="color:#6e6e73;font-size:10px;display:block;margin-top:6px;">ffmpeg 随程序自动安装；whisper 自动使用系统代理后台下载，可关闭设置窗口</span>`;
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
      bar.style.background = status.status === 'error' ? '#ff3b30' : (status.status === 'done' ? '#34c759' : '#0071e3');
    }
    if (msg) {
      msg.textContent = status.message || '';
      msg.style.color = status.status === 'error' ? '#ff3b30' : (status.status === 'done' ? '#34c759' : '#6e6e73');
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
  box.innerHTML = '<span style="color:#6e6e73;">⏳ 正在验证登录状态...</span>';
  try {
    const resp = await window.api.queryUser();
    if (resp.success && resp.result) {
      const u = resp.result;
      config.studentId = u.id || u.studentId || '';
      window.api.saveConfig({ studentId: config.studentId });
      const name = u.studentName || u.name || u.nickName || u.account || '未知';
      const id = u.id || u.studentId || '未知';
      const cls = u.className || u.clazzName || u.clazz || '';
      box.innerHTML = '<span style="color:#34c759;">✅ 登录有效</span>' +
        '<br><span style="color:#6e6e73;">姓名: ' + name + '</span>' +
        '<br><span style="color:#6e6e73;">学生ID: ' + id + '</span>' +
        (cls ? '<br><span style="color:#6e6e73;">班级: ' + cls + '</span>' : '') +
        '<br><span style="color:#34c759;font-size:11px;">学习进度记录功能正常</span>';
    } else {
      config.studentId = '';
      box.innerHTML = '<span style="color:#ff3b30;">❌ 登录已过期或无效</span>' +
        '<br><span style="color:#ff3b30;font-size:11px;">请重新登录 tsp.boxuegu.com 复制最新 Cookie</span>';
    }
  } catch (e) {
    box.innerHTML = '<span style="color:#ff3b30;">❌ 无法获取用户信息: ' + e.message + '</span>';
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

// ===== AI Analysis (with per-video chat history) =====
let aiChatHistory = [];   // [{ role: 'user'|'assistant', content: '...' }]
let aiSubtitleContext = ''; // cached subtitle text for the current video (sent as system context)

document.getElementById('btn-ai-analyze').addEventListener('click', async () => {
  aiPanel.classList.add('visible');
  await loadAIHistoryForCurrentVideo();
});

document.getElementById('btn-close-ai').addEventListener('click', () => {
  aiPanel.classList.remove('visible');
});

// Clear history button
document.getElementById('btn-clear-ai').addEventListener('click', async () => {
  if (!currentVideo) return;
  if (aiChatHistory.length === 0) { showToast('暂无对话记录'); return; }
  if (!confirm('确定清空本视频的AI对话记录吗？')) return;
  aiChatHistory = [];
  await window.api.writeAIHistory(currentVideo.videoId, []);
  renderAIChat();
  showToast('已清空对话记录', 'success');
});

// View full subtitle text for current video
// Refresh subtitle drawer content for the current video (reusable — called on open + auto-advance)
async function refreshSubtitleDrawer() {
  if (!currentVideo) return;
  const hasSub = await ensureSubtitleContext();
  const list = document.getElementById('subtitle-viewer-list');
  if (!hasSub || !subtitleData || !subtitleData.cues) {
    list.innerHTML = '<div style="color:var(--ink-faint);text-align:center;padding:40px;">暂无字幕，请先缓存并提取字幕</div>';
    document.getElementById('subtitle-viewer-title').textContent = '📄 ' + currentVideo.videoName;
    return;
  }
  // Build clickable subtitle lines with timestamp links
  list.innerHTML = subtitleData.cues.map(cue => {
    const escaped = escapeHtml(cue.text).replace(/\n/g, '<br>');
    return `<div class="sub-line" data-time="${cue.start}">` +
      `<span class="sub-time">${fmtTime(cue.start)}</span>` +
      `<span class="sub-text">${escaped}</span>` +
      `</div>`;
  }).join('');
  // Bind click on each line → seek video (keep drawer open for multiple jumps)
  list.querySelectorAll('.sub-line').forEach(line => {
    line.addEventListener('click', () => {
      const t = parseFloat(line.dataset.time);
      if (!isNaN(t) && videoPlayer.duration && t < videoPlayer.duration) {
        videoPlayer.currentTime = t;
        if (videoPlayer.paused) videoPlayer.play().catch(() => {});
        showToast(`已跳转至 ${fmtTime(t)}`, '');
      }
    });
  });
  document.getElementById('subtitle-viewer-title').textContent = '📄 ' + currentVideo.videoName;
}

document.getElementById('btn-view-subtitle').addEventListener('click', async () => {
  if (!currentVideo) { showToast('请先选择视频', 'error'); return; }
  await refreshSubtitleDrawer();
  document.getElementById('subtitle-viewer-dialog').classList.add('visible');
});

// Close subtitle drawer: ✕ button, toggle button, or click on drawer background
document.getElementById('btn-close-subtitle-drawer').addEventListener('click', () => {
  document.getElementById('subtitle-viewer-dialog').classList.remove('visible');
});
document.getElementById('btn-toggle-subtitle-drawer').addEventListener('click', () => {
  document.getElementById('subtitle-viewer-dialog').classList.remove('visible');
});

// Copy subtitle text
document.getElementById('btn-copy-subtitle').addEventListener('click', () => {
  let text = '';
  if (subtitleData && subtitleData.cues) {
    text = subtitleData.cues.map(cue => `[${fmtTime(cue.start)}] ${cue.text}`).join('\n');
  }
  navigator.clipboard.writeText(text).then(() => {
    showToast('字幕已复制到剪贴板', 'success');
  }).catch(() => {
    showToast('复制失败', 'error');
  });
});

// Auto-resize textarea
const aiInput = document.getElementById('ai-input');
aiInput.addEventListener('input', () => {
  aiInput.style.height = 'auto';
  aiInput.style.height = Math.min(aiInput.scrollHeight, 100) + 'px';
});
// Enter to send (Shift+Enter for newline)
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('btn-run-ai').click();
  }
});

// Load chat history for the current video and render it
async function loadAIHistoryForCurrentVideo() {
  const hint = document.getElementById('ai-hint');
  if (!currentVideo) {
    aiChatHistory = [];
    aiSubtitleContext = '';
    aiContent.innerHTML = '<div class="ai-placeholder">请先选择一个视频，再开始AI对话</div>';
    hint.textContent = '选择视频后开始对话';
    return;
  }
  hint.textContent = `当前: ${currentVideo.videoName.substring(0, 30)}`;
  aiChatHistory = await window.api.readAIHistory(currentVideo.videoId);
  currentVideo._aiHistoryLoaded = currentVideo.videoId;
  // Pre-load subtitle context for this video
  await ensureSubtitleContext();
  renderAIChat();
}

// Ensure we have subtitle text cached as context for AI
async function ensureSubtitleContext() {
  if (aiSubtitleContext) return true;
  if (!currentVideo) return false;

  let text = '';
  if (subtitleData && subtitleData.content) {
    text = subtitleData.content;
  } else {
    await loadCachedSubtitle(currentVideo.videoId);
    if (subtitleData && subtitleData.content) {
      text = subtitleData.content;
    } else {
      // Try to extract
      const cacheCheck = await window.api.checkCache(currentVideo.videoId);
      if (!cacheCheck.cached) return false;
      const result = await window.api.extractSubtitle(currentVideo.videoId);
      if (result.success) {
        text = result.content;
        const cues = text.includes('WEBVTT') ? parseVTT(text) : parseSRT(text);
        subtitleData = { cues, content: text };
      } else {
        return false;
      }
    }
  }
  aiSubtitleContext = (subtitleData.cues || []).map(c => c.text).join('\n');
  return !!aiSubtitleContext.trim();
}

// Render the chat history into the AI panel
// ===== Suggested prompts: short label (shown as chip) + detailed prompt (filled into textarea) =====
const SUGGESTED_PROMPTS_INITIAL = [
  { label: '📋 结构化总结', prompt: '请对视频字幕内容进行结构化总结，包含：核心主题、学习目标、详细知识点（按逻辑顺序）、关键代码/命令（如有）、注意事项/易错点、总结回顾' },
  { label: '🎯 划重点', prompt: '请提取本视频中最关键的5个知识点，每个知识点用一句话精炼概括，并标注重要程度（⭐核心 / ⭐⭐重要 / ⭐⭐⭐必记）' },
  { label: '💡 大白话解释', prompt: '请用最通俗的大白话把本视频的核心概念讲一遍，就像跟完全不懂技术的朋友解释一样，多用生活中的类比，避免专业术语堆砌' },
  { label: '🧑‍💻 生成Demo', prompt: '请基于本视频讲的内容，写一个完整可运行的最小示例项目（Demo），包含完整代码、项目结构说明、运行步骤，代码要有详细中文注释' },
  { label: '❓ 课后练习', prompt: '请基于本视频内容出5道练习题（含选择/填空/简答），并附上参考答案和解析，帮我检验学习效果' },
  { label: '🔗 知识图谱', prompt: '请梳理本视频涉及的知识点之间的关联关系，画出一个文字版知识图谱/思维导图，标出前置依赖和延伸方向' },
  { label: '🐛 常见坑', prompt: '请总结本视频主题在实际开发中最容易踩的坑、常见报错及解决方案，结合字幕中的代码示例说明' },
  { label: '⏱️ 时间线', prompt: '请按视频时间顺序，列出每个时间段讲了什么内容，做成带时间戳的目录大纲，方便我快速定位复习' },
  { label: '📝 面试题', prompt: '请基于本视频内容，模拟面试官出3-5道相关面试题（由浅入深），并给出标准答案和加分回答要点' },
  { label: '🔄 对比异同', prompt: '请把本视频中提到的技术/概念/方案做横向对比（如不同方案的优缺点、适用场景、性能差异），用表格形式呈现' },
];

const SUGGESTED_PROMPTS_FOLLOWUP = [
  { label: '📖 再详细点', prompt: '请把刚才的回答再展开讲解一下，补充更多细节和代码示例' },
  { label: '🔍 举个例子', prompt: '请针对刚才讲的内容举一个完整的实战代码示例，并逐行注释说明' },
  { label: '⚖️ 对比异同', prompt: '请把刚才提到的关键技术点做个横向对比（优缺点/适用场景/性能差异），用表格形式呈现' },
  { label: '🧪 怎么验证', prompt: '请告诉我怎么动手验证/测试刚才学到的知识点，给出具体操作步骤' },
  { label: '🤔 我有个疑问', prompt: '请帮我分析：' },
  { label: '🚀 进阶方向', prompt: '如果我想在这个知识点上深入学习，请推荐进阶学习路线和优质资源' },
];

// Render suggested prompt chips above the input
function renderSuggestedPrompts() {
  const container = document.getElementById('ai-suggestions');
  if (!container) return;
  if (!currentVideo || !aiSubtitleContext) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  // After at least one round of conversation, use followup prompts
  const prompts = aiChatHistory.length > 0 ? SUGGESTED_PROMPTS_FOLLOWUP : SUGGESTED_PROMPTS_INITIAL;
  container.innerHTML = prompts.map((p, i) =>
    `<button class="suggestion-chip" data-idx="${i}">${p.label}</button>`
  ).join('');
  // Bind clicks — fill textarea, don't auto-send
  container.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const idx = parseInt(chip.dataset.idx);
      const prompt = prompts[idx].prompt;
      aiInput.value = prompt;
      aiInput.focus();
      aiInput.style.height = 'auto';
      aiInput.style.height = Math.min(aiInput.scrollHeight, 100) + 'px';
      // Move cursor to end
      aiInput.setSelectionRange(aiInput.value.length, aiInput.value.length);
    });
  });
}

function renderAIChat() {
  if (aiChatHistory.length === 0) {
    if (currentVideo && aiSubtitleContext) {
      aiContent.innerHTML = '<div class="ai-placeholder">💡 点击下方提示词快速提问，或在输入框输入问题后发送</div>';
    } else if (currentVideo) {
      aiContent.innerHTML = '<div class="ai-placeholder">⚠️ 需要先缓存视频并提取字幕才能进行AI对话</div>';
    } else {
      aiContent.innerHTML = '<div class="ai-placeholder">请先选择一个视频，再开始AI对话</div>';
    }
    renderSuggestedPrompts();
    return;
  }
  let html = `<div class="ai-history-info">💬 ${aiChatHistory.length} 条对话记录（已自动保存）</div>`;
  aiChatHistory.forEach(msg => {
    const isUser = msg.role === 'user';
    html += `<div class="chat-msg ${isUser ? 'user' : 'assistant'}">`;
    html += `<div class="msg-role">${isUser ? '🙋 我' : '🤖 AI'}</div>`;
    html += `<div class="msg-body">${isUser ? escapeHtml(msg.content) : markdownToHtml(msg.content)}</div>`;
    html += `</div>`;
  });
  aiContent.innerHTML = html;
  aiContent.scrollTop = aiContent.scrollHeight;
  renderSuggestedPrompts();
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Configure marked once
if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
}

function markdownToHtml(content) {
  // Step 1: Parse markdown → HTML via marked (supports headings, tables, lists, code, etc.)
  let html;
  if (typeof marked !== 'undefined') {
    html = marked.parse(content);
  } else {
    // Fallback: basic escape + <br>
    html = content
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }
  // Step 2: Render math formulas (KaTeX auto-render scans for $...$ and $$...$$)
  // We use a temp div so renderMathInElement can process the DOM
  const temp = document.createElement('div');
  temp.innerHTML = html;
  if (typeof renderMathInElement !== 'undefined') {
    try {
      renderMathInElement(temp, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true },
        ],
        throwOnError: false,
      });
    } catch (e) { /* KaTeX parse error — leave as-is */ }
  }
  return temp.innerHTML;
}

// Send button handler — supports both initial analysis and follow-up questions
document.getElementById('btn-run-ai').addEventListener('click', async () => {
  if (!currentVideo) { showToast('请先选择视频', 'error'); return; }

  // Ensure chat history is loaded from disk for the current video (in case it was stale)
  if (aiChatHistory.length > 0 && (!currentVideo._aiHistoryLoaded || currentVideo._aiHistoryLoaded !== currentVideo.videoId)) {
    aiChatHistory = await window.api.readAIHistory(currentVideo.videoId);
  }
  currentVideo._aiHistoryLoaded = currentVideo.videoId;

  const userInput = aiInput.value.trim();
  const sendBtn = document.getElementById('btn-run-ai');

  // Ensure subtitle context is available
  const hasSubtitle = await ensureSubtitleContext();
  if (!hasSubtitle) {
    aiContent.innerHTML = '<div class="ai-placeholder">⚠️ 需要先缓存视频并提取字幕才能进行AI对话</div>';
    showToast('请先缓存视频并提取字幕', 'error');
    return;
  }

  // Build the user message: if empty input and no history → default analysis prompt
  let userMessage;
  if (!userInput) {
    if (aiChatHistory.length === 0) {
      // First time: generate structured analysis
      userMessage = `请对以下视频字幕内容进行结构化总结，方便学习和复习。按以下格式输出：\n\n## 📌 核心主题\n## 🎯 学习目标\n## 📖 详细知识点\n## 💻 关键代码/命令（如有）\n## ⚠️ 注意事项/易错点\n## 📝 总结`;
    } else {
      showToast('请输入追问内容');
      return;
    }
  } else {
    userMessage = userInput;
  }

  // Add user message to history and render
  aiChatHistory.push({ role: 'user', content: userMessage });
  aiInput.value = '';
  aiInput.style.height = 'auto';
  renderAIChat();

  // Show loading indicator
  const loadingEl = document.createElement('div');
  loadingEl.className = 'chat-msg assistant';
  loadingEl.innerHTML = '<div class="msg-role">🤖 AI</div><div class="msg-body"><div class="loading"><div class="spinner"></div><p>正在思考中...</p></div></div>';
  aiContent.appendChild(loadingEl);
  const bodyEl = loadingEl.querySelector('.msg-body');
  aiContent.scrollTop = aiContent.scrollHeight;

  sendBtn.disabled = true;
  let fullReply = '';
  try {
    // Stream the response token by token
    await callLLMStream((delta) => {
      if (!fullReply) {
        // First token: replace loading spinner with content
        bodyEl.innerHTML = '';
      }
      fullReply += delta;
      bodyEl.innerHTML = markdownToHtml(fullReply);
      aiContent.scrollTop = aiContent.scrollHeight;
    });
    // Save to history
    aiChatHistory.push({ role: 'assistant', content: fullReply });
    await window.api.writeAIHistory(currentVideo.videoId, aiChatHistory);
    renderAIChat();
    renderSuggestedPrompts();
  } catch (e) {
    if (fullReply) {
      // Partial reply received before error — save what we got
      bodyEl.innerHTML += `<p style="color:#ff3b30;font-size:12px;margin-top:8px;">⚠️ 流中断: ${e.message}</p>`;
      aiChatHistory.push({ role: 'assistant', content: fullReply });
      await window.api.writeAIHistory(currentVideo.videoId, aiChatHistory);
    } else {
      bodyEl.innerHTML = `<span style="color:#ff3b30;">❌ AI回复失败: ${e.message}<br><br>请检查设置中的大模型配置。</span>`;
      // Remove the failed user message from history
      aiChatHistory.pop();
    }
  }
  sendBtn.disabled = false;
  aiContent.scrollTop = aiContent.scrollHeight;
});

// Call LLM with streaming (SSE), invoking onDelta for each text chunk
async function callLLMStream(onDelta) {
  const url = config.llmBaseUrl.replace(/\/$/, '') + '/chat/completions';

  // System message: tutor role + subtitle context
  const systemContent = `你是一位专业的编程教育导师。以下是视频《${currentVideo.videoName}》的字幕内容，请基于此内容回答问题或进行总结。\n\n字幕内容：\n${aiSubtitleContext.substring(0, 12000)}`;

  const messages = [
    { role: 'system', content: systemContent },
    ...aiChatHistory.map(m => ({ role: m.role, content: m.content }))
  ];

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.llmApiKey
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: messages,
      temperature: 0.3,
      max_tokens: 4096,
      stream: true
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch { /* skip malformed chunk */ }
    }
  }
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
