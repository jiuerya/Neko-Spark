# Neko_Spark

把安卓手机相册（图片 / 视频）备份到电脑，并以"手机相册一样的方式"浏览；之后可原样导出 / 迁移回手机（文件名、拍摄时间、目录结构都不变）。

- **电脑端**：Electron 应用，同时充当本地服务 Hub（HTTPS `8787`/`8788`/`8789` 三选一 + UDP 发现 `8788`）
- **安卓端**：Kotlin App，走自定义的 [协议 v1](docs/protocol-v1.md)
- **去重**：内容寻址存储（`blobs/<sha前2位>/<sha>`），跨设备全局去重

仓库里是**两棵互相独立的树**，改哪一端只需要装哪一端的环境：

| 目录 | 内容 | 说明文档 |
|---|---|---|
| [`desktop/`](desktop/) | 电脑端（Electron + TypeScript + React），同时是本地 Hub | [README](desktop/README.md) · [**架构**](desktop/ARCHITECTURE.md) |
| [`android/`](android/) | 安卓端（Kotlin + Gradle） | [README](android/README.md) · [**架构**](android/ARCHITECTURE.md) |
| [`docs/`](docs/) | 两端之间的接口契约 | [协议 v1](docs/protocol-v1.md) |

想参与开发请看 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 下载

到 [Releases](https://github.com/jiuerya/Neko-Spark/releases) 页下载：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `Neko_Spark-x.y.z-win-setup-x64.exe` | **电脑版** —— 安装程序，默认装到 D 盘，带快捷方式 |
| Windows | `Neko_Spark-x.y.z-win-portable-x64.exe` | **电脑便携版** —— 单文件绿色版，双击即用，免安装 |
| Android | `Neko_Spark-x.y.z.apk` | **手机版** —— 直接安装（**debug 签名**，仅自用 / 测试） |

也可以从源码自行构建 —— 见下面「常用命令」与「安卓端」。

## 当前进度

- [x] **M1** 项目骨架 / 本地服务 Hub / SQLite / 存储目录
- [x] **M2** 导入管线：扫描文件夹 → SHA-256 → 内容去重入库 → 缩略图
- [x] **M3** Hub 协议 v1：清单比对 / 分块上传 / 断点续传 / 提交入库
- [x] **M4** 相册界面：时间线 / 相册 / 查看器（缩放、视频播放、收藏、文件信息）
- [x] **M5** 设置页 + 打包 exe（默认装 D 盘、数据放程序旁，不占 C 盘）
- [x] **M6** 导出文件夹树（逐字节一致 + 保留时间）+ 模拟手机端联调
- [x] **M7** 多设备区分浏览 / **可逆合并**（主/副设备，随时分离）
- [x] **M8** 安卓端基础版：相册扫描 / 协议 v1 备份 / 蓝白风格 UI
- [x] **M9** 手机已删除标记 / 设备身份认领 / 两端进度条 / 局域网搜索电脑 / UI 打磨
- [x] **M10** 安卓端后台传输（前台服务 + 静默进度通知）+ **从电脑恢复回手机相册**（合并同名文件夹 / 新建文件夹）
- [ ] **M11** 安卓端自动备份（WorkManager 定时 / WiFi 条件触发）、大库分页与搜索

## 环境要求

- 电脑端：Node.js >= 22（数据库用 Node 内置 `node:sqlite`，图片处理用 sharp 预编译包）
- 安卓端：JDK 17 + Gradle 8.9 + Android SDK（`platforms;android-34` / `build-tools;34.0.0`）

## 常用命令（电脑端）

> **命令都在 `desktop/` 里跑。** Windows PowerShell 默认禁止运行 `npm.ps1`，请统一使用 `npm.cmd`。

```powershell
cd desktop
npm.cmd install        # 安装依赖（首次）
npm.cmd run dev        # 开发模式启动（热更新）
npm.cmd run typecheck  # 类型检查
npm.cmd run build      # 构建产物到 desktop/out/
npm.cmd test           # 一键回归：类型检查 + 构建 + 167 项端到端测试
npm.cmd run dist:nsis  # 打包安装版到 desktop/release/
npm.cmd run dist       # 打包安装版 + 便携版
```

测试说明：`npm.cmd test` 会启动真实应用（窗口短暂弹出），自动完成
"生成测试图片 → 导入 → 模拟手机协议备份 → 检查界面/查看器/收藏 → 可逆合并 →
已删除标记 → 导出还原 → 回收站 → 老库升级 → HEIC/BMP 兜底解码" 全链路。

## CI 与自动发布

- PR 指向 `main` 或 `master` 时自动执行：桌面端类型检查、构建与端到端测试，Android 编译，依赖审计、依赖变更审查和敏感信息扫描。
- `main` / `master` 的每次提交都会在门禁通过后自动构建 Windows 安装版、便携版和 Android APK，并创建 GitHub Release。
- PR 合入主分支后会产生主分支提交，因此会自动走同一套门禁和发布流程。版本标签使用东八区发布时间，格式为 `vYYYY.MM.DD-HHmmss`。

也可以直接验证打包产物：

```powershell
$env:GM_SMOKE_APP="release\win-unpacked\Neko_Spark.exe"; node scripts\smoke.mjs
```

## 界面风格

蓝白色二次元风（浅蓝渐变 + 白色卡片 + 圆角 + 柔和阴影）+ **猫羽雫贴图**。

**贴图与背景图的来源：**

1. **内置素材**（原创 SVG + logo，随包分发）：`desktop/src/renderer/src/assets/stickers/`，
   脚本 `desktop/scripts/make-stickers.mjs` 可重新生成。**构建必需**，删了 `npm run build` 会直接失败。
2. **角色素材**（随源码分发）：放在**数据目录**里，界面启动时自动读取使用：
   - `stickers/` —— 贴图（png/jpg/webp/gif，侧栏固定第 1 张，其余轮换到各空状态/设置页）
   - `background-1..4.webp` —— 4 张高清背景图，一一对应 全部/收藏/视频/相册（1500×900，角色锚定右下、左侧渐隐）
   - `nekoha-originals/` —— 原始立绘（生成上面二者的输入源）

   > ⚠️ 这些是对第三方角色的**二次创作素材**，**不适用本仓库的代码许可证**，
   > 仅供个人学习交流、**禁止商用**。详见 [`NOTICE.md`](NOTICE.md)。
   > 想让界面换成你自己的图：把图片丢进数据目录的 `stickers/` 即可，无需改代码。

处理图片素材（自动抠白底 + 裁剪 + 压缩）：

```powershell
cd desktop
node scripts\prepare-stickers.mjs <源目录> ..\GalleryMirrorData\stickers
```

重新生成全套图标（桌面 `.ico` + 安卓 mipmap）：`node scripts\make-icon.mjs`。
自动截图检查界面：`node scripts\screenshot.mjs`（输出到 `.screenshots/`）。
生成示例照片：`node scripts\make-sample-photos.mjs <目标文件夹> [随机种子] [起始日]`。

## 电脑端界面功能

1. **导入本地文件夹**：左侧「设备」→「导入文件夹」，或「全部」页空状态的按钮。
   文件夹结构会原样保留（例如 `Camera/IMG_0001.jpg` → 相册 `Camera`）。导入时可选择
   导入到「新建设备」或「已有设备（主/副）」。
2. **浏览**：
   - 左侧"设备备份"可**分开看每台手机**（或选"全部设备（合并）"一起看）
   - 「全部」按拍摄时间倒序、按天分组；滚动时**滚动条左侧浮出当前日期**
   - 「相册」列出所有相册（和手机里的文件夹一致，合并视图下会标注所属设备）
   - 「收藏」「视频」为筛选视图；每个视图有**不同的高清半透明背景图**
3. **查看器**：点任意缩略图打开；
   - **滚轮缩放**（以鼠标指向的位置为中心）、放大后拖动、双击切换缩放、方向键切换、`i` 切换信息面板
   - 退出：`Esc` / 退格 / **点画面外的空白处** / **鼠标下侧键** / `Alt+←`；**上侧键**沿历史撤回上一步
   - 视频可直接播放（支持拖动进度，服务端支持 Range），**视频不参与"点空白退出"**（避免误触）
   - 信息面板显示分辨率 / 宽高比 / 像素数 / 平均码率 / 帧率等详细数据
4. **导出**：「设备」页 →「导出全部」或「导出此设备」，按手机目录树写回，
   文件名、目录、修改时间全部保留。导出全部时会按设备名分目录。
5. **设备合并（可逆）**：副设备挂到主设备下，**不移动文件、照片保留原始设备标签**，
   随时可以「分离」；主设备视图会自动包含副设备。
6. **手机已删除标记**：手机上删了照片，电脑**保留副本**并在缩略图右上角标「已删除」，
   设置页可控制是否显示。
7. **手机备份**：Hub 强制使用 HTTPS，首次启动会自动生成并保存自签名证书；手机端首次连接时填写设置页显示的证书 SHA-256 指纹。
   同一 WiFi/模拟器连接还需要填写「局域网访问密钥」；USB 用 `adb forward tcp:8787 tcp:8787`，回环连接可留空密钥。证书指纹可随局域网发现响应返回，访问密钥不会通过广播、日志或 HTTP 接口泄露。
8. **回收站**：`Delete` 直接删除（不弹确认）→ 进回收站保留 **30 天** → 可「恢复」或「彻底删除」；
   侧栏有角标，格子右上角显示「剩 N 天」。**只影响电脑库，绝不碰手机上的文件**。
9. **多选与拖出**：网格里可**框选**（Ctrl+单击加选 / Shift+单击范围选）；选中后可直接
   **拖到资源管理器**（复制，不改动仓库本身）；`Ctrl+Z` 反悔上一次删除。
10. **浏览体验**：**Ctrl + 滚轮**调整缩略图大小；按 **Tab** 切换「按日期分组 ⇄ 紧凑模式」，
    紧凑模式下日期靠滚动条旁的浮标显示。

### 模拟手机端（测试协议用）

```powershell
node desktop\tools\mock-phone\index.mjs <文件夹> --url https://127.0.0.1:8787 --device 我的手机
```

## 安卓端

代码在 `android/`（Kotlin，最小依赖：OkHttp + 协程）。功能：

- 扫描系统相册（MediaStore 图片 + 视频，与手机相册数量一致，按相册列出数量）
- SHA-256 指纹（带缓存，重复备份不重算）
- 协议 v1 备份：清单比对 → 分块上传（断点续传）→ 入库，服务端自动去重
- **进度条**：按字节驱动（指纹阶段 + 上传阶段），显示百分比/文件名/序号
- **搜索电脑**：UDP 广播发现局域网内所有 Hub，弹窗选择（模拟器自动补 10.0.2.2）
- **备份前选择设备身份**：新建设备 / 认领电脑端已有设备（避免重复建号）
- 蓝白 UI 与电脑端统一；启动即显示猫羽雫头像（构建时把数据目录贴图同步进 APK）

**环境要求**

| 组件 | 说明 |
|---|---|
| JDK | 17 |
| Gradle | 8.9 |
| Android SDK | `cmdline-tools` / `platform-tools` / `platforms;android-34` / `build-tools;34.0.0`（模拟器另需 `emulator` + 系统镜像） |
| 编译 SDK | 34 |

SDK 路径写在 `android/local.properties`（该文件**不进版本库**，需各自本地生成）：

```properties
sdk.dir=D\:\\Android\\Sdk
```

**常用命令**

```powershell
# 直接构建
cd android
gradle assembleDebugAppDebug --offline --console=plain --no-daemon
# 产物：android\app\build\outputs\apk\debugApp\debug\app-debugApp-debug.apk

# 或走辅助脚本（构建 + 安装到设备 + 可选自动跑一次备份）
powershell -ExecutionPolicy Bypass -File android\scripts\android-test.ps1
powershell -ExecutionPolicy Bypass -File android\scripts\android-test.ps1 -NoRun     # 只构建安装

# 启动模拟器（需先配好 AVD）
powershell -ExecutionPolicy Bypass -File android\scripts\android-emulator.ps1

# 指定电脑端地址（真机用局域网 IP；模拟器用 10.0.2.2；USB 用 127.0.0.1:8787 + adb reverse）
powershell -ExecutionPolicy Bypass -File android\scripts\android-test.ps1 -Hub https://192.168.x.x:8787
```

> ⚠️ **外网受限的环境必须加 `--offline`**：Gradle/JVM 不走系统代理，不加会卡死在配置阶段。
> 详见 [`android/ARCHITECTURE.md`](android/ARCHITECTURE.md) §8。

**SDK 包下载工具**（走腾讯云镜像 + 多线程）

```powershell
node android\scripts\android-sdk-fetch.mjs --list "system-images;android-34"   # 搜索包
node android\scripts\android-sdk-fetch.mjs <SDK目录> "emulators;latest"   # 下载安装
```

## 打包与安装（不占 C 盘）

`cd desktop && npm.cmd run dist` 产出：

| 文件 | 说明 |
|---|---|
| `desktop/release/Neko_Spark-0.1.0-安装版.exe` | 安装程序（默认 D 盘，可选目录，带快捷方式） |
| `desktop/release/Neko_Spark-0.1.0-便携版.exe` | 单文件绿色版，双击即用 |

- 安装默认路径 `D:\GalleryMirror`（检测到 D 盘存在时），可在安装界面更改。
- 已实测：安装默认落到 D 盘；卸载/升级程序时**备份数据不受影响**。

## 数据仓库目录

| 场景 | 位置 |
|---|---|
| 打包后（默认） | **程序目录的同级**：装到 `D:\GalleryMirror` → 数据在 `D:\GalleryMirrorData` |
| 同级目录不可写时 | 退回安装目录内，再不可写才退回系统用户目录 |
| 开发模式 | `desktop/.data`（相对启动时的 cwd） |
| 手动指定 | 设置页"更改位置"，或环境变量 `GALLERY_MIRROR_DATA` |
| 位置记忆 | 程序目录下的 `data-location.json`，并同步保存用户级位置指针，换安装目录也能继续使用原仓库 |

> 数据放在安装目录外面：NSIS 升级/卸载时会清空安装目录，放里面会被一起删除。

```
GalleryMirrorData/
├─ manifest.db        # SQLite：设备 / 相册 / 媒体 / 内容去重表
├─ blobs/             # 原始文件（按 SHA-256 内容寻址，天然去重）
├─ thumbs/            # 缩略图缓存（webp，384px）
├─ stickers/          # 角色贴图（随源码分发，见 NOTICE.md）
├─ background-1..4.webp  # 空状态高清背景（每页不同）
├─ nekoha-originals/  # 原始立绘（贴图 / 背景的生成源）
├─ tmp/               # 上传分片等临时文件
├─ mirror/            # 预留：自动镜像目录树
└─ runtime/           # Chromium 缓存、崩溃转储（不写 C 盘）
```

## 关于 C 盘占用

**安装后的软件完全不写 C 盘**：程序装在所选盘，数据与运行时缓存全部在程序旁的 `GalleryMirrorData` 内（已实测）。

开发构建缓存可重定向：

| 缓存 | 默认位置 | 迁移方式 |
|---|---|---|
| npm 缓存 | `C:\Users\<用户>\AppData\Local\npm-cache` | `npm config set cache D:\path` |
| Electron 二进制 | `C:\Users\<用户>\AppData\Local\electron\Cache` | 设 `ELECTRON_MIRROR` 镜像 / `ELECTRON_CACHE` |
| electron-builder | `C:\Users\<用户>\AppData\Local\electron-builder\Cache` | 设 `ELECTRON_BUILDER_CACHE`（打包时已指向项目 `.cache/`） |

## 已知限制

- **视频首帧缩略图**依赖 **Chromium 的解码能力**：H.265/HEVC 之类解不了的编码抽不出首帧，
  这些视频会停在播放占位（不会反复重试）。
- **导入的视频**支持 MP4（含分片 MP4）；**不支持 Matroska（`.mkv` / `.webm`）**。
- **大库**：界面一次性加载媒体元数据（四千余项实测流畅；**万级以上需要分页，尚未实现**）。
- **安卓端**：需手动点备份，无自动定时备份（见 M11）。

## 目录结构

```
Neko-Spark/
│
├─ desktop/                      # ── 电脑端（Electron + TypeScript + React）──
│  ├─ ARCHITECTURE.md            #    架构说明（详细内容看这里）
│  ├─ src/
│  │  ├─ main/                   #    主进程
│  │  │  ├─ index.ts             #      窗口、IPC、启动 Hub
│  │  │  ├─ drag.ts              #      拖出到资源管理器（硬链接中转）
│  │  │  └─ hub/                 #      HTTPS 服务 + 数据层
│  │  │     ├─ index.ts          #        协议 v1 + 媒体/缩略图/背景/贴图 + UDP 发现
│  │  │     ├─ db.ts             #        node:sqlite 封装、建表与迁移
│  │  │     ├─ config.ts         #        数据目录解析、运行时缓存重定向
│  │  │     ├─ storage.ts        #        目录布局与内容寻址路径
│  │  │     ├─ importer.ts       #        文件夹导入：扫描 → 哈希 → 去重入库
│  │  │     ├─ exporter.ts       #        按目录树导出 + 还原时间
│  │  │     ├─ thumbs.ts         #        缩略图编排与批量补齐
│  │  │     ├─ thumb-pool.ts     #        utilityProcess 子进程池
│  │  │     ├─ thumb-worker.ts   #        ⚠️ 自我包含，不 import 本地模块
│  │  │     ├─ media.ts          #        类型识别、EXIF/尺寸读取
│  │  │     ├─ videoinfo.ts      #        纯字节解析 MP4（不解码）
│  │  │     └─ trash.ts          #        回收站到期清理
│  │  ├─ preload/                #    安全桥（contextBridge）
│  │  ├─ renderer/               #    React 界面（views / components / hooks / utils）
│  │  └─ shared/                 #    前后端共享类型
│  ├─ build/                     #    安装器脚本 installer.nsh + 图标
│  ├─ tools/mock-phone/          #    模拟安卓端（测试协议用）
│  ├─ scripts/                   #    smoke.mjs(167项测试) / 探针 / 截图 / 素材工具
│  └─ package.json  electron-builder.yml  tsconfig*.json
│
├─ android/                      # ── 安卓端（Kotlin + Gradle）──
│  ├─ ARCHITECTURE.md            #    架构说明（详细内容看这里）
│  ├─ app/src/main/java/com/gallerymirror/app/
│  │  ├─ MainActivity.kt         #    界面（程序化构建）+ 交互/弹窗/权限
│  │  ├─ MediaScanner.kt         #    MediaStore 扫描
│  │  ├─ HubClient.kt            #    协议 v1 客户端
│  │  ├─ BackupRunner.kt         #    备份流程编排（SHA-256 缓存）
│  │  ├─ RestoreRunner.kt        #    恢复流程（合并 / 新建文件夹）
│  │  ├─ SyncService.kt          #    前台服务：后台传输 + 静默通知
│  │  ├─ Retry.kt                #    断线自动重连（指数退避）
│  │  ├─ HubDiscovery.kt         #    UDP 局域网搜索电脑
│  │  └─ Stickers.kt             #    读取打包进 APK 的贴图
│  ├─ app/build.gradle.kts       #    含 Sync 任务：把数据目录贴图同步进 APK
│  ├─ scripts/                   #    构建 / 安装 / 模拟器 / SDK 下载
│  └─ settings.gradle.kts
│
├─ docs/protocol-v1.md           # ── 共享：两端之间的接口契约 ──
├─ GalleryMirrorData/            # ── 共享：角色素材（贴图/背景/立绘），相册数据不入库 ──
│
├─ README.md  LICENSE  NOTICE.md  CONTRIBUTING.md
└─ app/                          # 安装版程序 + 同级数据目录（本地产物，不入库）
```

## 许可

- **代码**：适用根目录 [`LICENSE`](LICENSE) —— **PolyForm Noncommercial License 1.0.0**。
  简单说：**禁止任何商业用途**，但允许你任意修改、再分发（限非商业）。
- **角色素材**（贴图 / 背景 / 原始立绘 / 图标）：著作权归原作者，**不适用上述代码许可证**，
  随仓库分发仅供个人学习交流、**禁止商用**。详见 [`NOTICE.md`](NOTICE.md)。
- 若你是相关素材的权利人并认为这里的分发侵犯了你的权益，请开 Issue，**我们会立即移除**。
