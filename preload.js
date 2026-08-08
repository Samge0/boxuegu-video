const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // API
  getVideoList: () => ipcRenderer.invoke('api:getVideoList'),
  getPlayAuth: (videoId) => ipcRenderer.invoke('api:getPlayAuth', videoId),
  resolveVideoUrl: (videoId) => ipcRenderer.invoke('api:resolveVideoUrl', videoId),
  recordPlay: (data) => ipcRenderer.invoke('api:recordPlay', data),
  queryUser: () => ipcRenderer.invoke('api:queryUser'),

  // Cache
  checkCache: (videoId) => ipcRenderer.invoke('cache:check', videoId),
  downloadVideo: (data) => ipcRenderer.invoke('cache:download', data),
  getCachedPath: (videoId) => ipcRenderer.invoke('cache:getPath', videoId),
  listCache: () => ipcRenderer.invoke('cache:list'),
  deleteCache: (videoId) => ipcRenderer.invoke('cache:delete', videoId),
  openCacheFolder: () => ipcRenderer.invoke('cache:openFolder'),
  getCacheDir: () => ipcRenderer.invoke('cache:getDir'),
  setCacheDir: (newDir) => ipcRenderer.invoke('cache:setDir', newDir),
  chooseDirectory: (title) => ipcRenderer.invoke('dialog:openDirectory', title),
  extractSubtitle: (videoId) => ipcRenderer.invoke('cache:extractSubtitle', videoId),
  extractAllSubtitles: () => ipcRenderer.invoke('subtitle:extractAll'),
  getSubtitleBatchStatus: () => ipcRenderer.invoke('subtitle:getBatchStatus'),

  // Binaries
  checkBins: () => ipcRenderer.invoke('bin:check'),
  downloadWhisper: () => ipcRenderer.invoke('bin:downloadWhisper'),
  getDownloadStatus: () => ipcRenderer.invoke('bin:getDownloadStatus'),
  openFileDialog: (title, filters) => ipcRenderer.invoke('dialog:openFile', title, filters),

  // File
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),

  // Events
  onCacheProgress: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('cache-progress', handler);
    return () => ipcRenderer.removeListener('cache-progress', handler);
  },
  onSubtitleProgress: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('subtitle-progress', handler);
    return () => ipcRenderer.removeListener('subtitle-progress', handler);
  },
  onWhisperDownloadProgress: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('whisper-download-progress', handler);
    return () => ipcRenderer.removeListener('whisper-download-progress', handler);
  },
  onSubtitleProgress: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('subtitle-progress', handler);
    return () => ipcRenderer.removeListener('subtitle-progress', handler);
  },
  onSubtitleBatchProgress: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('subtitle-batch-progress', handler);
    return () => ipcRenderer.removeListener('subtitle-batch-progress', handler);
  }
});
