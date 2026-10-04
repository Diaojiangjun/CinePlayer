# CinePlayer

跨平台桌面影视播放器 —— 基于 **Electron + Vue 3 + Vite + TypeScript** 构建。

> 本项目是一个**播放器本体**：负责本地视频播放、媒体库管理、播放历史与收藏，
> 并支持导入**用户自有的合法内容源**（M3U 播放列表 / 自有流媒体地址 /
> 用户自行填写的苹果CMS采集接口）。
> **不内置、不存储、不分发任何影视资源**；内容来源全部由用户自行配置。

---

## ✨ 功能

- **本地视频播放** —— 支持 mp4 / mkv / avi / mov / flv / webm / ts 等常见格式
- **流媒体播放** —— 通过 `hls.js` 支持 HLS(m3u8) 直播与点播流
- **媒体库** —— 导入文件或扫描目录，海报墙 / 列表双模式，关键词搜索
- **内容源** —— 导入 M3U 播放列表或添加自定义流，多源切换与频道筛选
- **IPTV 直播** —— M3U / 订阅地址 / 单流，频道分组、搜索，可选 XMLTV 节目单（「正在播出」）
- **影视点播** —— 对接用户自行填写的**苹果CMS（MacCMS V10）采集接口**，分类浏览、封面墙、详情与选集
- **内容缓存** —— 三层缓存（内存 / IndexedDB / 网络），重复浏览与重启后都不再重复请求；有效期可调
- **播放历史** —— 记录进度、断点续播（超过阈值自动记忆）
- **收藏夹** —— 收藏本地视频与流媒体，一键回看
- **跳过片头片尾** —— 设定片头/片尾分界点，一键跳过或自动跳过；配置按剧集持久化
- **同步追剧** —— 追剧列表记录看到第几集（「继续看 第N集」），一键同步站点最新集数并标出「有新集」
- **设置** —— 主题（深/浅）、默认音量与倍速、扫描目录、内容缓存、数据清理
- **多平台** —— Windows / macOS / Linux 一键打包

## ⌨️ 快捷键

| 按键 | 功能 | 按键 | 功能 |
| :--: | :-- | :--: | :-- |
| `Space` | 播放 / 暂停 | `M` | 静音 / 取消静音 |
| `←` / `→` | 快退 / 快进 5 秒 | `F` | 全屏 / 退出全屏 |
| `↑` / `↓` | 音量 + / - | `Alt + Space` | 聚焦 / 取消聚焦窗口（全局） |

## 🧱 技术栈

| 层 | 选型 |
| :-- | :-- |
| 运行时 | Electron 31 |
| 构建 | electron-vite 2 + Vite 5 |
| 渲染层 | Vue 3（Composition API + `<script setup>`） |
| 语言 | TypeScript 5 |
| 状态 | Pinia |
| 路由 | Vue Router 4（Hash 模式） |
| 存储 | Dexie 4（IndexedDB） |
| 播放 | 原生 `<video>` + hls.js |
| 打包 | electron-builder |

## 📁 目录结构

```
CinePlayer/
├── electron.vite.config.ts     # 三端构建配置
├── electron-builder.yml        # 打包配置
├── tsconfig*.json              # TS 工程引用
├── src/
│   ├── main/                   # 主进程
│   │   ├── index.ts            # 窗口 / 单实例 / 全局快捷键
│   │   └── ipc.ts              # IPC 处理器（窗口 / 对话框 / 文件系统）
│   ├── preload/                # 预加载：contextBridge 安全桥
│   │   ├── index.ts
│   │   └── index.d.ts          # window.api 类型声明
│   └── renderer/               # 渲染进程
│       ├── index.html
│       └── src/
│           ├── main.ts         # 应用入口
│           ├── App.vue         # 应用外壳
│           ├── components/     # 标题栏 / 侧边栏 / 播放内核
│           ├── views/          # 媒体库 / 播放 / 历史 / 收藏 / 内容源 / 设置
│           ├── stores/         # Pinia 状态
│           ├── db/             # Dexie 数据层
│           ├── router/         # 路由
│           ├── utils/          # 格式化 / M3U 解析 / 路径处理
│           └── styles/         # 主题与全局样式
└── package.json
```

## 🚀 开发

```bash
# 安装依赖（会自动拉取 ffmpeg / ffprobe 的平台包）
npm install

# 启动开发模式（热更新）
npm run dev

# 类型检查
npm run typecheck

# 构建（含类型检查；prebuild 会把 ffmpeg / ffprobe 复制到 resources/bin）
npm run build

# 打包三平台
npm run build:win
npm run build:mac
npm run build:linux
```

### 关于 ffmpeg / ffprobe

转封装、转码与媒体探测依赖 ffmpeg / ffprobe，二者由 npm 包
`@ffmpeg-installer/ffmpeg`、`@ffprobe-installer/ffprobe` 按平台提供，
**体积较大（约 140MB），不随仓库分发**：

| 场景 | 二进制的来源 |
| :-- | :-- |
| 开发模式 | 主进程直接从 `node_modules` 解析，无需额外操作 |
| 打包 | `npm run build` 的 `prebuild` 钩子复制到 `resources/bin`，再经 `extraResources` 进入安装包 |
| 自备 | 用环境变量 `CINEPLAYER_FFMPEG` / `CINEPLAYER_FFPROBE` 指向自己的二进制 |

## 🧪 验证

```bash
# 纯函数单测（解析器 / 主进程逻辑，无需图形环境）
npm run verify

# 端到端冒烟（本地播放 / IPTV 直播 / 内容缓存）
npm run smoke:local
npm run smoke:stream
npm run smoke:cache
```

## ⚠️ 免责声明

本软件仅作为播放器工具，不提供、不存储、不分发任何影视内容。
请仅用于播放你拥有合法权利的文件与内容源，并遵守当地法律法规。
