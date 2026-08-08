# 博学谷视频播放器

基于 Electron 的[博学谷](https://tsp.boxuegu.com/#/Index)视频播放客户端。

这两天在看`博学谷`的视频，但每次播放视频都跳到独立的浏览器页面播放，且无法自动播放、无法自动锁定倍速播放。博学谷本身也有客户端，但只面向已经付费的会员用户，于是使用[hermes](https://github.com/NousResearch/hermes-agent)分析并构建一个自定义播放工具，方便自己观看视频。

## ✨ 功能特性

- 📚 **自动加载播放列表** — 读取全部课程模块/章节/视频，树形展示
- 🎬 **右侧窗口播放** — 点击左侧视频即可在右侧播放区观看
- 📏 **左侧可折叠** — 一键隐藏左侧列表，全屏观看
- 💾 **一键缓存全部** — 批量下载所有视频到本地，播放时自动优先使用缓存
- ⚡ **倍速播放** — 支持 0.5x ~ 3x 倍速
- 💬 **字幕提取与显示** — 从缓存视频提取字幕（ffmpeg + whisper 自动安装），字幕开关控制显示
- 🤖 **大模型解读** — 基于视频字幕进行结构化总结，方便学习复习
  - 支持 OpenAI 格式 API（url / model / key 可配置）
  - 自动生成：核心主题、学习目标、详细知识点、关键代码、注意事项、总结

## 🚀 快速开始

### 方式一：开发模式运行

```bash
cd F:\Space\PRO\test\heima-class-video
npm install          # 安装依赖（首次）
npm start            # 或双击 start.bat
```

### 方式二：打包成 exe

```bash
npm run build        # 生成 NSIS 安装包
# 或
npm run build-portable  # 生成免安装版
```

## ⚙️ 首次使用配置

1. **设置 Cookie** — 打开应用 → 点击「⚙️ 设置」→ 粘贴 Cookie
   - Cookie 从浏览器登录 tsp.boxuegu.com 后复制（至少需要包含 `SESSION=...`）
   - 默认已预填测试账号的 Cookie，但可能过期，请替换为自己的

2. **配置大模型**（可选，用于 AI 解读）— 在设置中填写：
   - API Base URL（如 `https://api.openai.com/v1`）
   - API Key
   - Model（如 `gpt-4o-mini`）

3. **字幕工具**（可选，用于字幕提取）— ffmpeg 随程序自动安装，whisper 在设置页一键自动下载（约 75MB）

## 📖 使用说明

| 操作 | 说明 |
|------|------|
| 点击左侧视频 | 开始播放 |
| ☰ 按钮 | 折叠/展开左侧列表 |
| 倍速下拉框 | 切换播放速度 |
| 空格键 | 播放/暂停 |
| ← → 方向键 | 快退/快进 5 秒 |
| ↑ ↓ 方向键 | 音量增减 |
| 💬 字幕按钮 | 开关字幕显示 |
| 📝 提取字幕 | 从当前缓存视频提取字幕 |
| 🤖 AI解读 | 打开 AI 面板，生成结构化总结 |
| ⬇ 缓存全部 | 批量下载所有视频 |
| 📁 缓存管理 | 查看/删除已缓存视频 |

## 🏗 技术架构

```
main.js          — Electron 主进程（窗口管理、IPC、API代理、视频缓存、whisper调用）
preload.js       — 安全的 contextBridge 预加载脚本
index.html       — UI 布局（深色主题）
renderer.js      — 渲染进程逻辑（播放器、列表、字幕、AI、缓存管理）
```

### 视频播放原理

1. 调用 `GET /api/common/getPlayAuth?videoId=xxx` 获取阿里云 VOD playauth（base64 编码）
2. 解码出 STS 临时凭证（AccessKeyId / AccessKeySecret / SecurityToken / AuthInfo）
3. 用 Aliyun Signature V1 签名调用 `GetPlayInfo` API 获取实际 MP4 地址
4. 使用 HTML5 `<video>` 标签播放，支持倍速、字幕等

### 视频缓存

- 通过解析出的 MP4 直链直接下载（支持断点续传）
- 缓存到 `%APPDATA%/boxuegu-video-player/video-cache/<videoId>/` 目录
- 播放时自动检测缓存，有缓存则通过 `local-video://` 自定义协议本地播放

### 字幕提取

1. ffmpeg 提取 16kHz 单声道 WAV 音频
2. whisper.cpp（tiny 模型）进行中文语音识别
3. 生成 SRT 字幕文件，渲染为字幕浮层

## 📁 项目结构

```
heima-class-video/
├── main.js              # 主进程
├── preload.js           # 预加载脚本
├── index.html           # UI 页面
├── renderer.js          # 渲染逻辑
├── package.json         # 项目配置
├── start.bat            # Windows 启动脚本
├── bin/                 # whisper 工具（自动下载）
│   ├── whisper.dll.exe  # whisper.cpp 可执行文件
│   ├── ggml-tiny.bin    # whisper tiny 模型
│   └── *.dll            # 依赖的 DLL
└── node_modules/        # 依赖（含 ffmpeg-static）
```
