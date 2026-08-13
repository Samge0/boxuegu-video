# 博学谷视频播放器

> 🌐 **[在线预览宣传页](https://samge0.github.io/boxuegu-video/)** · 📦 **[下载安装包](https://github.com/Samge0/boxuegu-video/releases)** · ⭐ **[给个 Star](https://github.com/Samge0/boxuegu-video)**

基于 Electron 的[博学谷](https://tsp.boxuegu.com/#/Index)视频播放客户端。

这两天在看`博学谷`的视频，但每次播放视频都跳到独立的浏览器页面播放，且无法自动播放、无法自动锁定倍速播放。博学谷本身也有客户端，但只面向已经付费的会员用户，于是使用 [hermes](https://github.com/NousResearch/hermes-agent) 分析并构建一个自定义播放工具，方便自己观看视频。

## ✨ 功能特性

### 🎬 视频播放
- 📚 **自动加载播放列表** — 读取全部课程模块/章节/视频，树形展示
- 🎬 **右侧窗口播放** — 点击左侧视频即可在右侧播放区观看
- 📏 **左侧可折叠** — 一键隐藏左侧列表，全屏观看
- ⚡ **倍速播放** — 支持 0.1x ~ 5.0x 倍速，0.1 步进，自动记忆
- 🔁 **自动连播** — 播完自动切换下一个视频，已学习的视频自动标记
- 💾 **一键缓存全部** — 批量下载所有视频到本地，播放时自动优先使用缓存
- 🎯 **进度记忆** — 记住上次播放的视频和进度，重新打开自动恢复
- 🔀 **缓存/线上无缝切换** — 切换播放来源时自动保持播放进度

### 💬 字幕
- **字幕提取** — 从缓存视频提取字幕（ffmpeg + whisper 自动安装）
- **字幕浮层** — 字幕开关控制显示，样式低调不遮挡视频
- **字幕侧栏** — 右侧抽屉查看完整字幕列表，点击时间戳跳转视频对应位置
- **批量提取** — 一键提取所有缓存视频的字幕（GPU 加速）

### 🤖 AI 解读
- **流式输出** — AI 回复实时流式渲染，支持完整 Markdown / 表格 / 数学公式（KaTeX）
- **对话记忆** — 每个视频独立保存对话记录，支持多轮追问
- **快捷提问** — 10 个预设提示词（结构化总结、大白话解释、生成 Demo、面试题等），点击即填
- **追问推荐** — 每次回复后自动提供新的推荐提问
- 支持 OpenAI 格式 API（url / model / key 可配置）

### 🎨 界面
- **Apple 设计语言** — 参考 [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) Apple 设计规范
- **亮色 / 暗黑主题** — 一键切换，自动记忆偏好
- **毛玻璃顶栏** — `backdrop-filter` 毛玻璃效果 + pill 按钮设计
- **无菜单栏** — 隐藏传统菜单栏，简洁沉浸
- **版本检测** — 启动时自动检查 GitHub 最新版本，有更新时显示红点提醒

## 🚀 快速开始

### 方式一：开发模式运行

```bash
git clone https://github.com/Samge0/boxuegu-video.git
cd boxuegu-video
npm install
npm start
```

### 方式二：下载安装包

前往 [Releases](https://github.com/Samge0/boxuegu-video/releases) 下载对应平台的安装包。

### 方式三：自行打包

```bash
npm run build:win    # Windows NSIS 安装包
npm run build:mac    # macOS dmg
npm run build:linux  # Linux AppImage/deb
```

## ⚙️ 首次使用配置

1. **设置 Cookie** — 打开应用 → 点击「⚙️ 设置」→ 粘贴 Cookie
   - Cookie 从浏览器登录 [tsp.boxuegu.com](https://tsp.boxuegu.com/#/Index) 后复制（至少需要包含 `SESSION=...`）

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
| 倍速 ＋/－ 按钮 | 0.1 步进调节速度 |
| 空格键 | 播放/暂停 |
| ← → 方向键 | 快退/快进 5 秒 |
| ↑ ↓ 方向键 | 音量增减 |
| [ ] 或 , . 键 | 减速/加速 |
| 💬 字幕按钮 | 开关字幕显示 |
| 📝 提取字幕 | 从当前缓存视频提取字幕 |
| 🤖 AI解读 | 打开 AI 面板，多轮对话 + 快捷提问 |
| 📄 字幕侧栏 | 查看完整字幕，点击时间戳跳转 |
| ⬇ 缓存全部 | 批量下载所有视频 |
| 📁 缓存管理 | 查看/删除已缓存视频 |
| ☀️/🌙 按钮 | 切换亮色/暗黑主题 |

## 🏗 技术架构

```
main.js          — Electron 主进程（窗口管理、IPC、API代理、视频缓存、whisper调用、Range seek）
preload.js       — 安全的 contextBridge 预加载脚本
index.html       — UI 布局 + CSS（Apple 设计系统，亮/暗双主题）
renderer.js      — 渲染进程逻辑（播放器、列表、字幕、AI对话、缓存管理）
vendor/          — 本地第三方库（marked.js markdown渲染、KaTeX 公式渲染）
```

### 视频播放原理

1. 调用 `GET /api/common/getPlayAuth?videoId=xxx` 获取阿里云 VOD playauth（base64 编码）
2. 解码出 STS 临时凭证（AccessKeyId / AccessKeySecret / SecurityToken / AuthInfo）
3. 用 Aliyun Signature V1 签名调用 `GetPlayInfo` API 获取实际 MP4 地址
4. 使用 HTML5 `<video>` 标签播放，支持倍速、字幕、进度拖拽

### 本地缓存播放 + Range Seek

缓存视频通过 `local-video://` 自定义协议播放，完整实现了 HTTP Range 请求支持（206 Partial Content），使 `<video>` 元素可以自由拖拽进度条、记忆播放进度。

### 字幕提取

1. ffmpeg 提取 16kHz 单声道 WAV 音频
2. faster-whisper（GPU 加速）或 whisper.cpp（tiny 模型）进行中文语音识别
3. 生成 SRT/VTT 字幕文件，渲染为字幕浮层

## 📁 项目结构

```
boxuegu-video/
├── main.js              # 主进程
├── preload.js           # 预加载脚本
├── index.html           # UI 页面 + CSS
├── renderer.js          # 渲染逻辑
├── vendor/              # 本地库（marked.js, KaTeX）
├── docs/                # GitHub Pages 宣传落地页（index.html）
├── package.json         # 项目配置
├── LICENSE              # MIT 协议
└── build/               # 应用图标
```

## 相关截图
- 支持`暗黑模式/亮色模式`切换
<img width="1870" height="1038" alt="image" src="https://github.com/user-attachments/assets/3a350f78-84a4-4498-af4a-c09506b3d08e" />
<img width="1266" height="788" alt="image" src="https://github.com/user-attachments/assets/1f7490db-bad9-4865-b681-7c848152953d" />

- AI解读
<img width="1874" height="1038" alt="image" src="https://github.com/user-attachments/assets/d09335e4-84dc-4858-ba7f-a77d52b05864" />

- 点击字幕可跳转到指定播放进度
<img width="1869" height="1038" alt="image" src="https://github.com/user-attachments/assets/06486416-954e-492f-a7f5-8179f2e63c63" />

## 📄 License

[MIT](LICENSE) © Samge0
