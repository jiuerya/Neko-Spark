# 电脑端架构说明

电脑端是一个 **Electron 应用**，同时充当整个系统的 **Hub**：对外提供 HTTPS 服务与协议 v1 接口，
对内管理内容寻址仓库、SQLite 元数据库与缩略图缓存；界面上是一个「像手机相册一样」的浏览器。

> 手机端在 [`../android/`](../android/)；协议见 [`../docs/protocol-v1.md`](../docs/protocol-v1.md)；
> 构建与运行见 [`README.md`](README.md)。

---

## 1. 运行形态

| 形态 | 程序目录 | 数据目录 |
|---|---|---|
| 开发模式 | 仓库内的 `desktop/` | `desktop/.data`（相对启动时的 cwd） |
| 安装版 | 安装目录（如 `D:\GalleryMirror`） | **程序目录的同级** `GalleryMirrorData` |
| 便携版 | 自解压到的临时目录（用 `PORTABLE_EXECUTABLE_DIR` 拿真实目录） | exe 所在文件夹内的 `GalleryMirrorData` |

数据目录的解析顺序（`src/main/hub/config.ts`）：

```
环境变量 GALLERY_MIRROR_DATA
  → 程序目录下的 data-location.json
  → 用户级 Neko_Spark/data-location.json（安装到另一个目录时继续沿用原仓库）
  → 默认：开发模式 = <cwd>/.data
          安装版 = <exe 目录的父目录>/GalleryMirrorData
          便携版 = <exe 目录>/GalleryMirrorData
  → 都不可写时退回系统用户目录
```

目录名 `GalleryMirrorData` 是**硬编码**的，不跟随产品名。放在程序目录**之外**是有意的：
NSIS 升级/卸载会清空安装目录，数据放里面会被一起删除。

## 2. 进程结构

```
主进程 (src/main/index.ts)
├─ 启动 Hub（HTTPS 8787/8788/8789 三选一 + mDNS `_neko-spark._tcp` + UDP 发现 8788 兜底）
├─ 创建窗口、注册 IPC、转发 data:changed
└─ thumb-pool（utilityProcess 子进程池）
      └─ thumb-worker.ts —— 唯一碰 sharp 的地方

preload (src/preload/index.ts) —— contextBridge 安全桥，渲染端只能看到白名单 API
renderer (src/renderer/src)    —— React 界面
```

**红线：主进程永远不解码视频。** 历史上曾因把视频原文件送进 libvips 解码（库里有 900MB+ 的 MP4）
导致原生崩溃、整个应用被带走。现在缩略图生成整体隔离在 `utilityProcess` 子进程池里
（`hub/thumb-pool.ts` + `hub/thumb-worker.ts`），sharp 崩溃只死子进程；同时
`/api/v1/thumb/:id` 对非图片直接 404。

> ⚠️ **`thumb-worker.ts` 必须自我包含，不能 import 任何本地模块。**
> 多入口打包时 rollup 会拆出共享 chunk，而 `utilityProcess` 加载那个 chunk 会 `ERR_MODULE_NOT_FOUND`。
> 代价是与 `thumbs.ts` 重复十几行 sharp 调用，这个重复是**必要的**。

## 3. 目录结构

```
src/
├─ main/
│  ├─ index.ts            窗口、IPC、启动 Hub
│  ├─ drag.ts             拖出到资源管理器（硬链接中转，见 §5）
│  └─ hub/
│     ├─ index.ts         HTTPS 服务：协议 v1 + 媒体/缩略图/背景/贴图 + UDP 发现
│     ├─ db.ts            node:sqlite 封装、建表与迁移
│     ├─ storage.ts       目录布局与内容寻址路径
│     ├─ config.ts        数据目录解析、运行时缓存重定向
│     ├─ importer.ts      文件夹导入：扫描 → 哈希 → 去重入库
│     ├─ exporter.ts      按目录树导出（还原时间戳）
│     ├─ media.ts         类型识别、EXIF/尺寸读取（含 BMP 文件头）
│     ├─ videoinfo.ts     纯字节解析 MP4 盒子拿时长/宽高（不解码）
│     ├─ thumbs.ts        缩略图编排与批量补齐
│     ├─ thumb-pool.ts    utilityProcess 子进程池（懒启动、空闲 30 秒关闭）
│     ├─ thumb-worker.ts  ⚠️ 自我包含，见 §2
│     └─ trash.ts         回收站到期清理
├─ preload/               安全桥
├─ renderer/src/          React（views / components / hooks / utils）
└─ shared/types.ts        前后端共享类型
```

## 4. 关键设计

### 4.1 内容寻址存储（CAS）

原始文件按 SHA-256 存放：`blobs/<sha前2位>/<sha>`，**跨设备、跨目录全局去重**。
一条 `blobs` 记录可能被多条 `media` 记录引用（同一张照片在两台手机上各备份过一次），
所以**删除必须先确认引用计数为 0**。

### 4.2 可逆设备合并

同一台手机重装 App 后会被识别成新设备。合并是把副设备挂到主设备下（`media.merged_into`），
**不移动任何文件、照片保留原始设备标签**，随时可分离。

### 4.3 两种"已删除"语义（不要混）

| 字段 | 含义 | 谁触发 | 文件还在吗 |
|---|---|---|---|
| `source_deleted` | 手机上删了，电脑保留备份 | 手机上报的清单里少了这一项 | 在，界面上打「已删除」角标 |
| `deleted` / `deleted_at` | 用户在电脑端主动删除 | `Delete` 键 | 在，进回收站，30 天倒计时 |

回收站里再删 = **彻底删除**：删记录 → 删 blobs → 删磁盘文件，不可恢复。
**桌面端的删除只影响电脑库，绝不碰手机上的文件。**

### 4.4 墓碑表（防止删掉的照片复活）

用户删掉一张照片后，手机下次备份又会把它传回来 —— 那很烦。`tombstones` 表按
`(设备, 相对路径, 文件名)` 记住"这条被用户删过"，清单比对 / `PUT /blob` / `commit` 都跳过。

只在两种**明确要它回来**的情况下清除：**回收站恢复**、**手动导入文件夹**。

### 4.5 缩略图

- 图片缩略图用 **JPEG(q90) 基线编码**，不用 WebP —— 实测 Chromium 解 JPEG 比解 WebP
  **快 3.22 倍**，而清晰度没有可感差异。滚动卡顿主要来自图片解码/光栅，这一步收益很大。
- **视频首帧仍是 WebP**，因为它由**渲染端**用隐藏的 `<video>` + canvas 抽帧后把字节交给主进程落盘
  —— 主进程绝不碰视频解码（见 §2）。Chromium 解不了的编码（如 H.265/HEVC）抽不出帧，
  会停在播放占位，且**不会反复重试**（防白烧 CPU）。
- 查看器里的大预览图仍用 WebP（只打开一次，不影响滚动流畅度）。

### 4.6 并发与性能

- **`UV_THREADPOOL_SIZE` 必须在 `src/main/index.ts` 最顶部、任何 import 之前设置。**
  libuv 线程池默认只有 4 个线程，会把 sharp 的并行度锁死在 4 —— 光调高 JS 层并发完全没用。
  池一旦创建再改就不生效。这里用 Windows 自带的 `NUMBER_OF_PROCESSORS` 算核数（不能依赖模块导入提升）。
- 缩略图生成用 `sharp.concurrency(1)` + 多张并行（libvips 官方推荐），而不是一张一张 await。
- 渲染端有刷新限流（`scheduleRefresh`，最多每 600ms 一次）、滑动预取（视口上下各约两屏）、
  上传期间的批量补图。

### 4.7 拖出到资源管理器

仓库里的原文件没有扩展名（内容寻址），直接拖出去会得到打不开的哈希文件名。所以先在
`tmp/drag/<时间戳>-<pid>/` 做一层**硬链接**并起上原始文件名 —— 同分区毫秒级、不占额外空间。
渲染端 `dragstart` **必须先 `preventDefault()`**（Electron 硬要求，不做会卡死渲染进程）。
跨卷/不支持硬链接时自动退化成复制（慢但不坏）。

## 5. 数据库表

见 `src/main/hub/db.ts`。`meta.schema_version` 当前为 `3`。

| 表 | 说明 |
|---|---|
| `devices` | 设备；`merged_into` 实现可逆合并 |
| `blobs` | 内容寻址、全局去重 |
| `media` | 媒体记录；`UNIQUE(device_id, relative_path, display_name)` |
| `tombstones` | 删过的文件"墓碑"，挡住备份复活 |
| `albums` | 相册（= 手机上的文件夹），`cover_media_id` 外键 |
| `meta` | 键值对：`schema_version` + 一次性重置标记 |

迁移在 `migrate()` 里用 `PRAGMA table_info` 查缺列再 `ALTER TABLE`。

> ⚠️ 新增索引**不能写进 `SCHEMA` 常量** —— `SCHEMA` 比 `migrate()` 先执行，
> 在缺列的老库上建索引会直接抛错、应用起不来。要放在 `migrate()` 里。

## 6. 测试

```bash
npm.cmd test          # 类型检查 + 构建 + 167 项端到端测试
npm.cmd run typecheck # 只做类型检查
npm.cmd run dev       # 开发模式
npm.cmd run dist:nsis # 打安装版到 release/
```

`scripts/smoke.mjs` 会启动**真实 Electron**（CDP 注入，端口 8799 + 临时数据目录），
覆盖：Hub 服务 / 磁盘数据库 / 界面基础 / 设置页 / 导入管线 / 协议 v1 / 相册界面与查看器 /
导出还原 / 可逆合并 / 已删除标记 / 手机准备阶段反馈 / 回收站 / **老库升级** / HEIC 与 BMP 兜底解码。

> **老库升级那一段不要删。** 主流程全程用的是"全新库"（走建表），`migrate()` 的 `ALTER TABLE`
> 路径只有那一段会走到 —— 它现造一个旧结构的库再用新版本打开。用户机器上就是老库，这条路断了应用直接起不来。

诊断探针在 `scripts/` 下（`_` 前缀，随时可重跑）：`_diag-trash.mjs`（查看器交互）、
`_probe-drag.mjs`（用 CDP 真实输入验证拖出）、`_probe-mp4fps.mjs`（帧率解析）、
`_probe-worker-decoders.mjs`（不开 Electron 直接驱动编译产物体检兜底解码器）、
`_perf-scroll.mjs`（滚动流畅度）、`_probe-real-input.mjs`（真实滚轮/侧键输入）。

## 7. UI 规范

- 配色：底 `#F2F8FF` → `#E7F3FF` 渐变；卡片白 + `#E8F2FD` 边框；
  主色 `#4A9FFF` / `#8FD0FF`；文字 `#2D426B` / 次要 `#7F94B6`；粉色点缀 `#FF9EC4`
- 圆角：卡片 16px、按钮/胶囊全圆、缩略图 12px
- 素材：内置 SVG 吉祥物在 `src/renderer/src/assets/stickers/`（`scripts/make-stickers.mjs` 可重新生成）；
  角色贴图/背景在仓库根的 `GalleryMirrorData/`，运行时读取，缺了会静默回退到内置图。
  **版权说明见 [`../NOTICE.md`](../NOTICE.md)。**
- 图标由 `scripts/make-icon.mjs` 一处生成（桌面 `.ico` + 安卓全套 mipmap）
