const { app, BrowserWindow, ipcMain, dialog, protocol: electronProtocol } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');

const BASE_URL = 'https://tsp.boxuegu.com';
const API_BASE = 'https://tsp.boxuegu.com/api';

// Register local-video as a privileged protocol before app ready
if (electronProtocol.registerSchemesAsPrivileged) {
  electronProtocol.registerSchemesAsPrivileged([
    { scheme: 'local-video', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
  ]);
}

let mainWindow;

// ---- Config & data paths ----
// 用固定应用名而非依赖 package.json name，避免 name 变化导致 userData 漂移丢数据
// Config → %APPDATA%\BoxueguVideoPlayer (Roaming, follows user)
// Cache  → %LOCALAPPDATA%\BoxueguVideoPlayer (Local, machine-specific, survives reinstalls)
const APP_DATA_DIR = path.join(app.getPath('appData'), 'BoxueguVideoPlayer');
// On Windows, use LocalAppData for cache; fallback to 'cache' path on other platforms
const localAppData = process.env.LOCALAPPDATA || app.getPath('home') || app.getPath('cache');
const APP_CACHE_DIR = path.join(localAppData, 'BoxueguVideoPlayer');
const configPath = path.join(APP_DATA_DIR, 'config.json');

if (!fs.existsSync(APP_DATA_DIR)) fs.mkdirSync(APP_DATA_DIR, { recursive: true });

// Default cache dir: system cache, not userData — survives app reinstalls
const DEFAULT_CACHE_DIR = path.join(APP_CACHE_DIR, 'videos');
const DEFAULT_WHISPER_DIR = path.join(APP_CACHE_DIR, 'whisper');

// Resolve cache/whisper dirs from config (user can customize)
function getCacheDir() {
  const cfg = loadConfig();
  return cfg.cacheDir || DEFAULT_CACHE_DIR;
}
function getWhisperDir() {
  const cfg = loadConfig();
  return cfg.whisperDir || DEFAULT_WHISPER_DIR;
}

function ensureDirs() {
  for (const d of [getCacheDir(), getWhisperDir()]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// Tool paths: ffmpeg from ffmpeg-static npm package (auto-provided), whisper in cache dir
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  if (!fs.existsSync(ffmpegPath)) ffmpegPath = null;
} catch { ffmpegPath = null; }
// Fallback to bin/ffmpeg.exe if user placed one manually
if (!ffmpegPath) {
  const binFfmpeg = path.join(app.getAppPath(), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(binFfmpeg)) ffmpegPath = binFfmpeg;
}

// Whisper files live in the cache dir (survives reinstalls, not in project dir)
function getWhisperPath() {
  return path.join(getWhisperDir(), process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper');
}
function getModelPath() {
  return path.join(getWhisperDir(), 'ggml-tiny.bin');
}

// Default config
function loadConfig() {
  let cfg = {
    session: 'OWNlMmViOWQtNWRkYS00NWMwLWIwZjItYzQ0NjI0ZDI0MDA4',
    cookies: 'p_h5_u=376B5831-6769-4307-9AAE-0B30E76276A3; selectedStreamLevel=OD',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: '',
    llmModel: 'gpt-4o-mini',
    studentId: '',
    cacheDir: DEFAULT_CACHE_DIR,
    whisperDir: DEFAULT_WHISPER_DIR,
    playbackSpeed: 1,
    lastVideoId: null,
    lastPosition: 0
  };
  try {
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      cfg = { ...cfg, ...saved };
    }
  } catch (e) { console.error('loadConfig error', e); }
  return cfg;
}

function saveConfig(cfg) {
  if (!fs.existsSync(APP_DATA_DIR)) fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

// Ensure dirs exist at startup (after config is loadable)
ensureDirs();

// Migrate old cache from userData to new system cache location (one-time)
(function migrateOldCache() {
  try {
    const oldUserData = app.getPath('userData');
    const oldCache = path.join(oldUserData, 'video-cache');
    const newCache = DEFAULT_CACHE_DIR;
    if (fs.existsSync(oldCache) && oldCache !== newCache) {
      if (!fs.existsSync(newCache)) fs.mkdirSync(newCache, { recursive: true });
      const entries = fs.readdirSync(oldCache);
      let migrated = 0;
      for (const entry of entries) {
        const src = path.join(oldCache, entry);
        const dst = path.join(newCache, entry);
        if (fs.existsSync(dst)) continue; // don't overwrite
        try {
          // Move entire directory
          fs.renameSync(src, dst);
          migrated++;
        } catch (e) {
          console.error('Failed to migrate', entry, e.message);
        }
      }
      if (migrated > 0) console.log(`Migrated ${migrated} cached videos to ${newCache}`);
      // Also migrate old whisper files from bin/ to whisper cache
      const oldBin = path.join(app.getAppPath(), 'bin');
      if (fs.existsSync(oldBin)) {
        for (const f of ['whisper-cli.exe', 'whisper.dll.exe', 'whisper.exe', 'main.exe', 'ggml-tiny.bin', 'ggml.dll', 'whisper.dll', 'SDL2.dll']) {
          const oldFile = path.join(oldBin, f);
          const newFile = path.join(DEFAULT_WHISPER_DIR, f);
          if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
            try { fs.renameSync(oldFile, newFile); } catch {}
          }
        }
        // Remove old bin dir if empty
        try { fs.rmdirSync(oldBin); } catch {}
      }
    }

    // Migrate old videoId/xxx.mp4 structure to new module/node/name.mp4 structure + index.json
    // Old format: cacheDir/<videoId>/xxx.mp4 (32-char hex dirs = old videoId dirs)
    // New format: cacheDir/<module>/<node>/<name>.mp4 + cacheDir/index.json
    const cd = getCacheDir();
    if (fs.existsSync(cd)) {
      const index = (function(){ try { return JSON.parse(fs.readFileSync(path.join(cd, 'index.json'), 'utf-8')); } catch { return {}; } })();
      let needSave = false;
      for (const entry of fs.readdirSync(cd)) {
        // Skip non-directories and our own index/structured dirs
        if (entry === 'index.json' || entry === 'whisper') continue;
        const entryPath = path.join(cd, entry);
        let stat;
        try { stat = fs.statSync(entryPath); } catch { continue; }
        if (!stat.isDirectory()) continue;
        // Check if this looks like a videoId directory (32-char hex hash)
        const isVideoIdDir = /^[a-f0-9]{30,40}$/i.test(entry);
        const files = fs.readdirSync(entryPath);
        const mp4 = files.find(f => f.endsWith('.mp4'));
        if (!mp4) continue;

        if (isVideoIdDir) {
          // Old structure — move to 未分类/未分类/
          const targetDir = path.join(cd, '未分类', '未分类');
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          const targetFile = path.join(targetDir, mp4);
          if (!fs.existsSync(targetFile)) {
            try {
              fs.renameSync(path.join(entryPath, mp4), targetFile);
              // Move subtitle too
              const baseName = mp4.replace(/\.mp4$/, '');
              for (const f of files) {
                if (f !== mp4 && f.startsWith(baseName) && (f.endsWith('.srt') || f.endsWith('.vtt'))) {
                  fs.renameSync(path.join(entryPath, f), path.join(targetDir, f));
                }
              }
              // Remove old dir
              try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch {}
              // Add to index
              index[entry] = { module: '未分类', node: '未分类', name: baseName, file: targetFile };
              needSave = true;
              console.log(`Migrated video ${entry} to structured path`);
            } catch (e) { console.error('Migration failed for', entry, e.message); }
          }
        }
        // If it's already a structured dir (module/node/name.mp4), rebuild index entry
        else {
          // Scan module/node for mp4s and add to index if not present
        }
      }
      if (needSave) {
        fs.writeFileSync(path.join(cd, 'index.json'), JSON.stringify(index, null, 2));
      }
    }

    // Fix deprecated whisper.dll.exe: if the old deprecation stub exists (tiny file), remove it
    // so the app detects whisper as "not installed" and user can re-download whisper-cli.exe
    const oldWhisperStub = path.join(DEFAULT_WHISPER_DIR, 'whisper.dll.exe');
    if (fs.existsSync(oldWhisperStub)) {
      try {
        const stubSize = fs.statSync(oldWhisperStub).size;
        if (stubSize < 50000) { // whisper.dll.exe stub is ~27KB, real CLI is ~468KB
          fs.unlinkSync(oldWhisperStub);
          console.log('Removed deprecated whisper.dll.exe stub, will re-download whisper-cli.exe');
        }
      } catch {}
    }
  } catch (e) { console.error('Migration error:', e); }
})();

// ---- HTTP helper ----
const zlib = require('zlib');

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig();
    const headers = {
      'Cookie': cfg.cookies + (cfg.session ? '; SESSION=' + cfg.session : ''),
      'Referer': BASE_URL + '/',
      'Origin': BASE_URL,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Encoding': 'gzip, deflate, br',
      ...extraHeaders
    };
    https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch {}
        const data = buf.toString('utf-8');
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body, contentType = 'application/x-www-form-urlencoded') {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig();
    const headers = {
      'Cookie': cfg.cookies + (cfg.session ? '; SESSION=' + cfg.session : ''),
      'Referer': BASE_URL + '/',
      'Origin': BASE_URL,
      'Content-Type': contentType,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Encoding': 'gzip, deflate, br'
    };
    const urlObj = new URL(url);
    const req = https.request(urlObj, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch {}
        const data = buf.toString('utf-8');
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- Video download (cache) ----
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 180);
}

function downloadVideo(url, filePath, videoKey, win) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    let downloaded = 0;
    let contentLength = 0;

    function doRequest(reqUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(reqUrl, {
        headers: { 'Referer': BASE_URL + '/', 'User-Agent': 'Mozilla/5.0' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doRequest(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        contentLength = parseInt(res.headers['content-length'] || '0');
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          file.write(chunk);
          if (contentLength > 0 && win && !win.isDestroyed()) {
            win.webContents.send('cache-progress', {
              key: videoKey,
              progress: Math.round(downloaded / contentLength * 100)
            });
          }
        });
        res.on('end', () => {
          file.end(() => resolve(filePath));
        });
        res.on('error', (e) => { file.close(); reject(e); });
      }).on('error', reject);
    }
    doRequest(url);
  });
}

// Resolve the actual playable MP4 URL from Aliplayer playauth.
// Aliplayer normally constructs the URL internally, but for caching we need to
// resolve it ourselves. We use Aliplayer's HTTP API endpoint.
async function resolveVideoUrl(videoId) {
  const cfg = loadConfig();
  // 1. Get playauth
  const authResp = await httpGet(`${API_BASE}/common/getPlayAuth?videoId=${encodeURIComponent(videoId)}`);
  if (!authResp.success) throw new Error('获取播放凭证失败');
  const playauth = authResp.result;

  // 2. Decode the playauth to get PlayDomain, etc.
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(playauth, 'base64').toString('utf-8'));
  } catch (e) {
    decoded = {};
  }

  // The decoded JSON contains STS credentials + AuthInfo for Aliyun VOD.
  // We call GetPlayInfo API to resolve the actual MP4 URL.

  const accessKeyId = decoded.AccessKeyId;
  const accessKeySecret = decoded.AccessKeySecret;
  const securityToken = decoded.SecurityToken;
  const region = decoded.Region || 'cn-shanghai';
  const authInfo = decoded.AuthInfo;
  const playDomain = decoded.PlayDomain || 'tsp-video.boxuegu.com';

  // Use Aliyun OpenAPI to call GetPlayInfo with STS
  const playInfoUrl = await getAliyunPlayInfo(videoId, accessKeyId, accessKeySecret, securityToken, region, authInfo, playDomain);
  return { url: playInfoUrl, playauth, decoded };
}

// Call Aliyun VOD GetPlayInfo using STS credentials
async function getAliyunPlayInfo(videoId, accessKeyId, accessKeySecret, securityToken, region, authInfo, playDomain) {
  const crypto = require('crypto');

  const params = {
    Format: 'JSON',
    Version: '2017-03-21',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomBytes(16).toString('hex'),
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    Action: 'GetPlayInfo',
    VideoId: videoId,
    AuthInfo: authInfo,
    PlayDomain: playDomain,
    SecurityToken: securityToken,
    StreamType: 'video'
  };

  // Sign the request (Aliyun signature v1)
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys.map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`
  ).join('&');

  const stringToSign = `GET&%2F&${encodeURIComponent(canonicalQuery)}`;
  const hmac = crypto.createHmac('sha1', accessKeySecret + '&');
  hmac.update(stringToSign);
  const signature = hmac.digest('base64');

  const finalUrl = `https://vod.${region}.aliyuncs.com/?${canonicalQuery}&Signature=${encodeURIComponent(signature)}`;

  return new Promise((resolve, reject) => {
    https.get(finalUrl, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch {}
        const data = buf.toString('utf-8');
        try {
          const result = JSON.parse(data);
          if (result.PlayInfoList && result.PlayInfoList.PlayInfo) {
            const playInfos = result.PlayInfoList.PlayInfo;
            // Prefer MP4, then highest quality
            const mp4 = playInfos.find(p => p.Format === 'mp4');
            const chosen = mp4 || playInfos[0];
            resolve({
              url: chosen.PlayURL,
              format: chosen.Format,
              definition: chosen.Definition,
              duration: chosen.Duration,
              allFormats: playInfos.map(p => ({ format: p.Format, definition: p.Definition, url: p.PlayURL }))
            });
          } else {
            reject(new Error('No PlayInfo: ' + data.substring(0, 300)));
          }
        } catch (e) {
          reject(new Error('Parse error: ' + data.substring(0, 300)));
        }
      });
    }).on('error', reject);
  });
}

// ---- ffmpeg / whisper for subtitle extraction ----
function hasFFmpeg() {
  return fs.existsSync(ffmpegPath);
}

async function extractSubtitle(filePath) {
  return new Promise((resolve, reject) => {
    if (!hasFFmpeg()) {
      return reject(new Error('ffmpeg not found. Please place ffmpeg.exe in bin/ folder.'));
    }
    // Extract audio, then we need whisper for transcription
    // Step 1: extract audio to wav (16kHz mono for whisper)
    const audioPath = filePath.replace(/\.[^.]+$/, '') + '_audio.wav';
    const args = ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audioPath];
    execFile(ffmpegPath, args, { timeout: 600000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffmpeg error: ' + stderr.substring(0, 500)));
      resolve(audioPath);
    });
  });
}

// ---- Helpers for whisper download ----
function tryRequire(name) { try { return require(name); } catch { return null; } }

// Auto-detect system proxy: env vars > Windows registry
function detectProxy() {
  // 1. Environment variables
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
                   process.env.HTTP_PROXY || process.env.http_proxy ||
                   process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) return envProxy;

  // 2. Try Windows registry (system proxy settings)
  try {
    const { execSync } = require('child_process');
    // First check if proxy is enabled
    const enableOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOutput);
    if (!enabled) return null;

    const regOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const match = regOutput.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (match) {
      let server = match[1].trim();
      // Handle format like "http=127.0.0.1:7890;https=127.0.0.1:7890"
      if (server.includes(';')) {
        const httpsPart = server.split(';').find(s => s.startsWith('https='));
        server = httpsPart ? httpsPart.replace('https=', '') : server.split(';')[0].replace(/^\w+=/, '');
      }
      if (!server.startsWith('http://') && !server.startsWith('https://')) {
        server = 'http://' + server;
      }
      return server;
    }
  } catch {}
  return null;
}

// Apply proxy to the session so Electron's net module routes through it
function applySessionProxy() {
  const { session } = require('electron');
  const proxy = detectProxy();
  if (proxy) {
    session.defaultSession.setProxy({
      proxyRules: proxy,
      proxyBypassRules: 'localhost,127.0.0.1'
    });
    console.log('系统代理已设置:', proxy);
    return proxy;
  }
  return null;
}

// Download using Electron's net module (uses session proxy automatically)
function downloadWithProxy(url, filePath, onProgress) {
  const { net } = require('electron');
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    let downloaded = 0, contentLength = 0;

    const request = net.request({ url: url, redirect: 'follow' });
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      contentLength = parseInt(response.headers['content-length'] || '0');
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        file.write(chunk);
        if (onProgress && contentLength > 0) onProgress(downloaded, contentLength);
      });
      response.on('end', () => file.end(() => resolve(filePath)));
    });

    request.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(filePath); } catch {}
      reject(err);
    });

    request.end();
  });
}

// Fetch JSON using Electron's net module (uses session proxy)
function fetchJsonWithProxy(url) {
  const { net } = require('electron');
  return new Promise((resolve, reject) => {
    const request = net.request({ url: url, redirect: 'follow' });
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    request.setHeader('Accept', 'application/json');

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', d => chunks.push(d));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

// Simple fetchJson fallback (for non-proxy contexts like boxuegu API)
function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'electron-app', 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchJson(res.headers.location, redirects + 1));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    let downloaded = 0, contentLength = 0;
    function doRequest(reqUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(reqUrl, { headers: { 'User-Agent': 'electron-app' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doRequest(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        contentLength = parseInt(res.headers['content-length'] || '0');
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          file.write(chunk);
          if (onProgress) onProgress(downloaded, contentLength);
        });
        res.on('end', () => file.end(() => resolve(filePath)));
        res.on('error', (e) => { file.close(); reject(e); });
      }).on('error', reject);
    }
    doRequest(url);
  });
}

// ---- Whisper download state (persists regardless of settings dialog open/close) ----
let whisperDownloadState = {
  status: 'idle',      // 'idle' | 'downloading' | 'done' | 'error'
  progress: 0,         // 0-100
  message: '',
  error: null,
  startTime: 0
};

function emitWhisperProgress() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('whisper-download-progress', { ...whisperDownloadState });
  }
}

// ---- Main window ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '博学谷视频播放器',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f5f5f7',
    // Apple-style: hide the native menu bar, keep window controls
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    show: false
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Safety fallback: force show after 5s in case ready-to-show doesn't fire
  setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); }, 5000);

  // Apply system proxy for whisper downloads (GitHub/HuggingFace)
  applySessionProxy();

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC Handlers ----

// Get config
ipcMain.handle('config:get', () => loadConfig());

// App version
ipcMain.handle('app:getVersion', () => app.getVersion());

// Open URL in system default browser
ipcMain.handle('app:openExternal', (e, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
});

// Check latest GitHub release tag
ipcMain.handle('app:checkUpdate', async () => {
  try {
    const resp = await fetchJsonWithProxy('https://api.github.com/repos/Samge0/boxuegu-video/releases/latest');
    if (resp && resp.tag_name) {
      return { latest: resp.tag_name, success: true };
    }
    return { success: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('config:save', (e, cfg) => {
  const current = loadConfig();
  const merged = { ...current, ...cfg };
  saveConfig(merged);
  return merged;
});

// Fetch video list
ipcMain.handle('api:getVideoList', async () => {
  return await httpGet(`${API_BASE}/courseModule/queryModuleNodeVideoList`);
});

// Get playauth
ipcMain.handle('api:getPlayAuth', async (e, videoId) => {
  return await httpGet(`${API_BASE}/common/getPlayAuth?videoId=${encodeURIComponent(videoId)}`);
});

// Resolve actual video URL for caching
ipcMain.handle('api:resolveVideoUrl', async (e, videoId) => {
  try {
    return await resolveVideoUrl(videoId);
  } catch (err) {
    return { error: err.message };
  }
});

// Record play progress
ipcMain.handle('api:recordPlay', async (e, data) => {
  const body = new URLSearchParams(data).toString();
  return await httpPost(`${API_BASE}/record/studentPlay`, body);
});

// Query current user info (to get studentId)
ipcMain.handle('api:queryUser', async () => {
  return await httpGet(`${API_BASE}/auth/queryCurrentUser`);
});

// ---- Cache index manager ----
// Maintains <cacheDir>/index.json: { videoId: { module, node, name, file, size, subtitle } }
function getIndexPath() { return path.join(getCacheDir(), 'index.json'); }

function loadCacheIndex() {
  try {
    const p = getIndexPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return {};
}

function saveCacheIndex(index) {
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getIndexPath(), JSON.stringify(index, null, 2));
  } catch (e) { console.error('saveCacheIndex', e); }
}

function updateCacheEntry(videoId, entry) {
  const index = loadCacheIndex();
  index[videoId] = { ...(index[videoId] || {}), ...entry };
  saveCacheIndex(index);
}

function removeCacheEntry(videoId) {
  const index = loadCacheIndex();
  delete index[videoId];
  saveCacheIndex(index);
}

// Build the structured path: cacheDir/模块名/章节名/视频名.mp4
function buildVideoPath(videoId, moduleName, nodeName, videoName) {
  const safeModule = sanitizeFilename(moduleName || '未分类');
  const safeNode = sanitizeFilename(nodeName || '未分类');
  const safeName = sanitizeFilename(videoName || videoId);
  return path.join(getCacheDir(), safeModule, safeNode, safeName + '.mp4');
}

// Cache: check if video is cached (via index)
ipcMain.handle('cache:check', (e, videoId) => {
  const index = loadCacheIndex();
  const entry = index[videoId];
  if (entry && entry.file && fs.existsSync(entry.file)) {
    // Also check for subtitle (from index or scan directory)
    let subtitlePath = entry.subtitle || null;
    if (subtitlePath && !fs.existsSync(subtitlePath)) subtitlePath = null;
    if (!subtitlePath) {
      // Fallback: scan directory
      try {
        const dir = path.dirname(entry.file);
        const baseName = path.basename(entry.file, '.mp4');
        const srt = fs.readdirSync(dir).find(f => f.startsWith(baseName) && (f.endsWith('.srt') || f.endsWith('.vtt')));
        if (srt) subtitlePath = path.join(dir, srt);
      } catch {}
    }
    return { cached: true, path: entry.file, subtitle: subtitlePath };
  }
  return { cached: false };
});

// Cache: download video into structured directory
ipcMain.handle('cache:download', async (e, { videoId, videoName, moduleName, nodeName, url }) => {
  try {
    const filePath = buildVideoPath(videoId, moduleName, nodeName, videoName);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // If already downloaded, skip
    if (fs.existsSync(filePath)) {
      updateCacheEntry(videoId, { module: moduleName, node: nodeName, name: videoName, file: filePath });
      return { success: true, path: filePath, skipped: true };
    }

    await downloadVideo(url, filePath, videoId, mainWindow);
    updateCacheEntry(videoId, {
      module: moduleName, node: nodeName, name: videoName,
      file: filePath,
      size: fs.statSync(filePath).size
    });
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get cached file path for playback (via index)
ipcMain.handle('cache:getPath', (e, videoId) => {
  const index = loadCacheIndex();
  const entry = index[videoId];
  if (entry && entry.file && fs.existsSync(entry.file)) return entry.file;
  return null;
});

// List all cached videos (from index)
ipcMain.handle('cache:list', () => {
  const index = loadCacheIndex();
  const result = [];
  for (const [videoId, entry] of Object.entries(index)) {
    if (entry.file && fs.existsSync(entry.file)) {
      const dir = path.dirname(entry.file);
      let hasSubtitle = false, subtitlePath = null;
      // Check index first, then scan directory
      if (entry.subtitle && fs.existsSync(entry.subtitle)) {
        subtitlePath = entry.subtitle;
        hasSubtitle = true;
      }
      if (!hasSubtitle) {
        try {
          const files = fs.readdirSync(dir);
          const baseName = path.basename(entry.file, '.mp4');
          const srt = files.find(f => f.startsWith(baseName) && (f.endsWith('.srt') || f.endsWith('.vtt')));
          if (srt) { hasSubtitle = true; subtitlePath = path.join(dir, srt); }
        } catch {}
      }
      result.push({
        videoId,
        name: entry.name || videoId,
        module: entry.module || '',
        node: entry.node || '',
        file: entry.file,
        size: fs.statSync(entry.file).size,
        hasSubtitle,
        subtitlePath
      });
    }
  }
  // Sort by module → node → name
  result.sort((a, b) => (a.module + '/' + a.node + '/' + a.name).localeCompare(b.module + '/' + b.node + '/' + b.name, 'zh'));
  return result;
});

// Delete cache entry (single video)
ipcMain.handle('cache:delete', (e, videoId) => {
  const index = loadCacheIndex();
  const entry = index[videoId];
  if (entry && entry.file && fs.existsSync(entry.file)) {
    const dir = path.dirname(entry.file);
    // Delete video + any sibling subtitle/audio files
    const baseName = path.basename(entry.file, '.mp4');
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(baseName)) fs.unlinkSync(path.join(dir, f));
      }
      // Remove empty parent dirs (node, then module) — only if empty
      removeEmptyDirs(dir, getCacheDir());
    } catch {}
  }
  removeCacheEntry(videoId);
  return true;
});

// Recursively remove empty directories up to (not including) stopDir
function removeEmptyDirs(dir, stopDir) {
  try {
    while (dir !== stopDir && dir.length > stopDir.length) {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    }
  } catch {}
}

// Open cache folder
ipcMain.handle('cache:openFolder', () => {
  require('electron').shell.openPath(getCacheDir());
});

// Get cache dir path
ipcMain.handle('cache:getDir', () => getCacheDir());

// ---- Subtitle extraction (GPU-accelerated via faster-whisper Python) ----

// Check if faster-whisper GPU venv is available
function getFasterWhisperPython() {
  const venvPython = path.join(app.getAppPath(), '.whisper-venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) return venvPython;
  return null;
}

// Batch subtitle extraction state
let subtitleBatchState = {
  status: 'idle',    // idle | running | done | error
  current: 0,
  total: 0,
  currentName: '',
  progress: 0,
  results: [],       // [{videoId, name, success, error}]
  startTime: 0
};

function emitSubtitleBatchProgress() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('subtitle-batch-progress', { ...subtitleBatchState });
  }
}

// Extract subtitle for a single video using faster-whisper (GPU) or whisper.cpp (CPU fallback)
// Runs ffmpeg → audio.wav → whisper → srt
async function extractSubtitleForVideo(videoId) {
  const index = loadCacheIndex();
  const entry = index[videoId];
  if (!entry || !entry.file || !fs.existsSync(entry.file)) throw new Error('视频未缓存');

  const videoPath = entry.file;
  const dir = path.dirname(videoPath);
  const baseName = path.basename(videoPath, '.mp4');

  // Return existing subtitle if present
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const existingSub = files.find(f => f.startsWith(baseName) && (f.endsWith('.srt') || f.endsWith('.vtt')));
  if (existingSub) {
    const subPath = path.join(dir, existingSub);
    // Ensure index records the subtitle path
    updateCacheEntry(videoId, { subtitle: subPath });
    return { success: true, path: subPath, content: fs.readFileSync(subPath, 'utf-8'), skipped: true };
  }

  if (!ffmpegPath) throw new Error('ffmpeg 不可用');

  // Step 1: extract audio
  const audioPath = path.join(dir, baseName + '_audio.wav');
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-y', '-i', videoPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audioPath],
      { timeout: 600000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('ffmpeg: ' + stderr.substring(0, 300)));
        resolve();
      });
  });

  // Step 2: transcribe
  const srtPath = path.join(dir, baseName + '.srt');
  const pythonExe = getFasterWhisperPython();
  const whisperBinPath = getWhisperPath();

  if (pythonExe) {
    // Use faster-whisper (GPU) — much faster
    const scriptPath = path.join(app.getAppPath(), 'scripts', 'extract_subtitle.py');
    await new Promise((resolve, reject) => {
      const child = execFile(pythonExe, [
        scriptPath, audioPath,
        '--model', 'tiny',
        '--device', 'auto',
        '--compute-type', 'auto',
        '--language', 'zh',
        '--output', srtPath
      ], { timeout: 600000, maxBuffer: 50 * 1024 * 1024,
           env: { ...process.env, WHISPER_CACHE_DIR: getWhisperDir() } });

      child.stderr.on('data', (data) => {
        // Parse progress JSON from stderr
        const lines = data.toString().split('\n');
        for (const line of lines) {
          try {
            const msg = JSON.parse(line.trim());
            if (msg.type === 'progress') {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('subtitle-progress', { videoId, progress: msg.progress, message: msg.message });
              }
            }
          } catch {}
        }
      });

      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error('faster-whisper 退出码: ' + code));
        resolve();
      });
    });
  } else if (fs.existsSync(whisperBinPath) && fs.existsSync(getModelPath())) {
    // Fallback: whisper.cpp CLI (CPU)
    await new Promise((resolve, reject) => {
      execFile(whisperBinPath, [
        '-m', getModelPath(), '-f', audioPath,
        '-l', 'zh', '-osrt', '-of', srtPath.replace(/\.srt$/, ''), '-t', '8'
      ], { timeout: 1800000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('whisper.cpp: ' + stderr.substring(0, 300)));
        resolve();
      });
    });
  } else {
    throw new Error('字幕工具未安装。请到设置中下载 whisper，或安装 faster-whisper');
  }

  // Clean up audio temp file
  try { fs.unlinkSync(audioPath); } catch {}

  if (!fs.existsSync(srtPath)) throw new Error('字幕文件未生成');
  // Save subtitle path to index
  updateCacheEntry(videoId, { subtitle: srtPath });
  return { success: true, path: srtPath, content: fs.readFileSync(srtPath, 'utf-8') };
}

// Extract subtitle for single video (still used by the subtitle button — returns result)
ipcMain.handle('cache:extractSubtitle', async (e, videoId) => {
  try {
    const result = await extractSubtitleForVideo(videoId);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get single video extraction progress
ipcMain.handle('subtitle:getProgress', () => {
  return { status: subtitleBatchState.status };
});

// Batch extract subtitles for ALL cached videos (background, non-blocking)
ipcMain.handle('subtitle:extractAll', async () => {
  if (subtitleBatchState.status === 'running') {
    return { success: true, alreadyRunning: true, message: '批量提取正在进行中' };
  }

  // Get all cached videos without subtitles
  const cached = [];
  const index = loadCacheIndex();
  for (const [videoId, entry] of Object.entries(index)) {
    if (!entry.file || !fs.existsSync(entry.file)) continue;
    const dir = path.dirname(entry.file);
    const baseName = path.basename(entry.file, '.mp4');
    try {
      const files = fs.readdirSync(dir);
      const hasSub = files.some(f => f.startsWith(baseName) && (f.endsWith('.srt') || f.endsWith('.vtt')));
      if (!hasSub) {
        cached.push({ videoId, name: entry.name || videoId, module: entry.module, node: entry.node });
      }
    } catch {}
  }

  if (cached.length === 0) {
    return { success: true, message: '所有缓存视频都已有字幕' };
  }

  // Start background batch
  subtitleBatchState = {
    status: 'running', current: 0, total: cached.length,
    currentName: '', progress: 0, results: [], startTime: Date.now()
  };
  emitSubtitleBatchProgress();

  // Run in background (don't await)
  (async () => {
    let success = 0, failed = 0;
    for (let i = 0; i < cached.length; i++) {
      const v = cached[i];
      subtitleBatchState.current = i + 1;
      subtitleBatchState.currentName = v.name;
      subtitleBatchState.progress = Math.round(i / cached.length * 100);
      emitSubtitleBatchProgress();

      try {
        await extractSubtitleForVideo(v.videoId);
        subtitleBatchState.results.push({ videoId: v.videoId, name: v.name, success: true });
        success++;
      } catch (err) {
        subtitleBatchState.results.push({ videoId: v.videoId, name: v.name, success: false, error: err.message });
        failed++;
      }
    }
    subtitleBatchState.status = 'done';
    subtitleBatchState.progress = 100;
    subtitleBatchState.currentName = '';
    emitSubtitleBatchProgress();
    console.log(`[subtitle-batch] Done: ${success} success, ${failed} failed`);
  })();

  return { success: true, total: cached.length, message: `开始提取 ${cached.length} 个视频的字幕` };
});

// Get batch extraction status
ipcMain.handle('subtitle:getBatchStatus', () => {
  return { ...subtitleBatchState };
});

// Check for ffmpeg/whisper binaries
ipcMain.handle('bin:check', () => {
  const whisperPath = getWhisperPath();
  const modelPath = getModelPath();
  return {
    ffmpeg: !!ffmpegPath && fs.existsSync(ffmpegPath),
    whisper: fs.existsSync(whisperPath),
    model: fs.existsSync(modelPath),
    whisperPath: whisperPath,
    modelPath: modelPath,
    whisperDir: getWhisperDir(),
    ffmpegAuto: !!ffmpegPath,
    gpuAvailable: !!getFasterWhisperPython()
  };
});

// Get whisper download status (for when settings dialog reopens)
ipcMain.handle('bin:getDownloadStatus', () => {
  return { ...whisperDownloadState };
});

// Background whisper download — runs independently of settings dialog
ipcMain.handle('bin:downloadWhisper', async () => {
  // If already downloading, just return current state
  if (whisperDownloadState.status === 'downloading') {
    return { success: true, alreadyRunning: true, message: '下载正在进行中' };
  }

  // Run in background — do NOT await, return immediately
  downloadWhisperBackground();
  return { success: true, message: '后台下载已启动' };
});

async function downloadWhisperBackground() {
  whisperDownloadState = { status: 'downloading', progress: 0, message: '准备下载...', error: null, startTime: Date.now() };
  emitWhisperProgress();

  try {
    const whisperDir = getWhisperDir();
    const whisperPath = getWhisperPath();
    const modelPath = getModelPath();
    if (!fs.existsSync(whisperDir)) fs.mkdirSync(whisperDir, { recursive: true });

    // Ensure proxy is applied
    applySessionProxy();

    // 1. Download whisper.cpp release info
    whisperDownloadState.message = '正在获取 whisper 版本信息...';
    whisperDownloadState.progress = 1;
    emitWhisperProgress();

    const releasesUrl = 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest';
    const releaseInfo = await fetchJsonWithProxy(releasesUrl);
    const assets = releaseInfo.assets || [];
    const winAsset = assets.find(a =>
      a.name.includes('win') && a.name.includes('x64') && a.name.endsWith('.zip') && !a.name.includes('cuda')
    ) || assets.find(a => a.name.includes('bin-x64') && a.name.endsWith('.zip'));

    if (!winAsset) throw new Error('未找到 Windows whisper 发布包');
    const downloadUrl = winAsset.browser_download_url;

    // 2. Download whisper binary
    whisperDownloadState.message = '下载 whisper 程序...';
    whisperDownloadState.progress = 2;
    emitWhisperProgress();

    const whisperZipPath = path.join(whisperDir, 'whisper.zip');
    await downloadWithProxy(downloadUrl, whisperZipPath, (downloaded, total) => {
      whisperDownloadState.progress = 2 + Math.round(downloaded / total * 48);
      if (Math.random() < 0.1) emitWhisperProgress(); // throttle updates
    });

    // 3. Extract
    whisperDownloadState.message = '解压 whisper...';
    whisperDownloadState.progress = 50;
    emitWhisperProgress();

    const extractDir = path.join(whisperDir, 'whisper-tmp');
    await new Promise((resolve, reject) => {
      const psCmd = `Expand-Archive -Path '${whisperZipPath}' -DestinationPath '${extractDir}' -Force`;
      execFile('powershell.exe', ['-Command', psCmd], { timeout: 120000 }, (err) => {
        if (err) return reject(new Error('解压失败: ' + err.message));
        resolve();
      });
    });
    try { fs.unlinkSync(whisperZipPath); } catch {}

    // 4. Find and copy executable + DLLs
    function findFile(dir, name) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) {
          const found = findFile(fullPath, name);
          if (found) return found;
        } else if (e.name === name) {
          return fullPath;
        }
      }
      return null;
    }

    // Find the actual CLI executable (v1.9.x uses whisper-cli.exe, older used main.exe)
    const exePath = findFile(extractDir, 'whisper-cli.exe') || findFile(extractDir, 'main.exe') || findFile(extractDir, 'whisper.exe');
    if (!exePath) throw new Error('解压后未找到 whisper 可执行文件');
    if (fs.existsSync(whisperPath)) fs.unlinkSync(whisperPath);
    fs.copyFileSync(exePath, whisperPath);

    // Copy ALL DLLs from the same directory as the exe (whisper needs ggml*.dll, whisper.dll, SDL2.dll, etc.)
    const exeDir = path.dirname(exePath);
    const dllFiles = fs.readdirSync(exeDir).filter(f => f.endsWith('.dll'));
    for (const dll of dllFiles) {
      try { fs.copyFileSync(path.join(exeDir, dll), path.join(whisperDir, dll)); } catch {}
    }
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}

    // 5. Download model
    whisperDownloadState.message = '下载 whisper 模型 (~75MB)...';
    whisperDownloadState.progress = 55;
    emitWhisperProgress();

    const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin';
    await downloadWithProxy(modelUrl, modelPath, (downloaded, total) => {
      whisperDownloadState.progress = 55 + Math.round(downloaded / total * 45);
      if (Math.random() < 0.1) emitWhisperProgress(); // throttle
    });

    // Done
    whisperDownloadState.status = 'done';
    whisperDownloadState.progress = 100;
    whisperDownloadState.message = '安装完成！';
    emitWhisperProgress();

  } catch (err) {
    whisperDownloadState.status = 'error';
    whisperDownloadState.error = err.message;
    whisperDownloadState.message = '下载失败: ' + err.message;
    emitWhisperProgress();
  }
}

// Set cache directory (user customization)
ipcMain.handle('cache:setDir', async (e, newDir) => {
  if (!newDir) return { success: false, error: '路径不能为空' };
  try {
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    const cfg = loadConfig();
    cfg.cacheDir = newDir;
    saveConfig(cfg);
    return { success: true, cacheDir: newDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Choose directory dialog
ipcMain.handle('dialog:openDirectory', async (e, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title || '选择文件夹',
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

// Open file dialog for choosing whisper/ffmpeg binary
ipcMain.handle('dialog:openFile', async (e, title, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title || '选择文件',
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

// Read file (for subtitle content)
ipcMain.handle('file:read', (e, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
});

// ===== AI Chat History (per-video, persisted as JSON) =====
function getAIHistoryDir() {
  const dir = path.join(APP_DATA_DIR, 'ai-history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getAIHistoryPath(videoId) {
  return path.join(getAIHistoryDir(), `${videoId}.json`);
}

// Read AI chat history for a video
ipcMain.handle('ai-history:read', (e, videoId) => {
  try {
    const p = getAIHistoryPath(videoId);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
});

// Write AI chat history for a video (full overwrite)
ipcMain.handle('ai-history:write', (e, videoId, messages) => {
  try {
    const p = getAIHistoryPath(videoId);
    fs.writeFileSync(p, JSON.stringify(messages, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('AI history write error:', err);
    return false;
  }
});

// Register local-video:// protocol handler for playing cached video files
// URL format: local-video://load/<base64-encoded-path>
// Must support HTTP Range requests so <video> can seek.
app.whenReady().then(() => {
  electronProtocol.handle('local-video', (request) => {
    try {
      // Extract base64 path after the host
      const urlObj = new URL(request.url);
      const encoded = urlObj.pathname.replace(/^\//, '');
      // Decode base64 → original file path
      const filePath = Buffer.from(encoded, 'base64url').toString('utf-8');

      // Read file stats for Content-Length + Range support
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const rangeHeader = request.headers.get('range');

      // Build headers that enable seeking
      const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache',
      };

      if (rangeHeader) {
        // Parse "bytes=start-end"
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
        headers['Content-Length'] = String(chunkSize);
        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(stream, { status: 206, headers });
      } else {
        // Full file (no range) — 200
        headers['Content-Length'] = String(fileSize);
        const stream = fs.createReadStream(filePath);
        return new Response(stream, { status: 200, headers });
      }
    } catch (err) {
      console.error('local-video protocol error:', err);
      return new Response('Error: ' + err.message, { status: 500 });
    }
  });
});
