# 安卓端架构说明

安卓端是一个 Kotlin 应用，负责把手机相册**备份到电脑**，以及把电脑上的备份**恢复回手机**。
它与电脑端之间只通过 **HTTPS 协议 v1** 通信（不共享代码、不共享构建系统）。

所有 Android 连接都使用 HTTPS，并固定电脑端设置页显示的证书 SHA-256 指纹；电脑端首次启动时会在数据目录自动生成并持久化自签名证书。局域网/模拟器连接还要携带 `X-Gallery-Mirror-Token`，USB 回环可省略密钥。
访问密钥保存在 Android 应用私有配置中，不能写入日志、源码或测试附件。Android 客户端拒绝 HTTP、公网地址和缺少证书指纹的连接。

> 电脑端在 [`../desktop/`](../desktop/)；协议见 [`../docs/protocol-v1.md`](../docs/protocol-v1.md)；
> 构建与运行见 [`README.md`](README.md)。

---

## 1. 目录结构

```
android/
├─ app/
│  ├─ build.gradle.kts          构建配置（含贴图同步任务，见 §7）
│  └─ src/main/
│     ├─ AndroidManifest.xml
│     ├─ java/com/gallerymirror/app/
│     │  ├─ MainActivity.kt     界面（程序化构建，蓝白风格）+ 全部交互/弹窗/权限
│     │  ├─ MediaScanner.kt     MediaStore 扫描（图片 + 视频）
│     │  ├─ HubClient.kt        协议 v1 客户端（pair/health/manifest/upload/commit/devices/media/download）
│     │  ├─ BackupRunner.kt     备份流程编排（SHA-256 本地缓存）
│     │  ├─ RestoreRunner.kt    恢复流程（合并 / 新建文件夹两种模式）
│     │  ├─ SyncService.kt      前台服务：后台传输 + 静默进度通知
│     │  ├─ Retry.kt            断线自动重连（指数退避）
│     │  ├─ HubDiscovery.kt     mDNS 优先、UDP 兼容兜底的局域网搜索
│     │  ├─ QrScannerActivity.kt 二维码配对扫描
│     │  ├─ SyncProgressOverlay.kt 可选悬浮进度窗
│     │  └─ Stickers.kt         读取打包进 APK 的贴图
│     └─ res/                   图标、吉祥物、颜色、主题
├─ scripts/                     构建 / 安装 / 模拟器辅助脚本
├─ build.gradle.kts             插件版本
├─ settings.gradle.kts
└─ gradle.properties
```

## 2. 备份流程（手机 → 电脑）

```
MediaStore 扫描
  → SHA-256 指纹（带本地缓存，重复备份不重算）
  → POST /manifest 提交清单
  → 服务端比对后回「需要哪些」
  → 逐个文件 POST /blob（8MB 分块，Content-Range，支持断点续传）
  → POST /commit 收尾
```

服务端在 `PUT /blob` 落盘的那一刻就建记录并推送变更，所以**照片是边传边出现在电脑界面上的**，
中途断开也不会白传。已传完的靠清单比对跳过，传一半的靠服务端 `.part` + `Content-Range` 续传。

**断线自动重连**：`Retry.kt` 的 `withRetry`（2→4→8→16→30 秒退避，最多 60 次）包住了健康检查 /
清单 / 上传 / 入库，**一断就整轮作废**改成"等它接回来继续传"。4xx 是数据问题，不重试。

## 3. 恢复流程（电脑 → 手机）

两种模式：

- **合并同名文件夹** —— 按原 `relativePath` 写回
- **新建文件夹** —— 可自定义名字，默认 = 选中设备名，落在 `DCIM/<名字>/`

去重规则：同名同大小自动跳过；同名不同大小加 ` (1)` 序号，**不覆盖**；字节级一致（SHA-256 相同）。

写回相册的 API 分界：

| Android 版本 | 做法 |
|---|---|
| 10+（API 29+） | 走 `MediaStore` + `IS_PENDING` |
| 9 及以下 | 直接写文件 + `MediaScannerConnection.scanFile` |

非标准顶层目录会自动放进 `Pictures/`（视频放 `Movies/`），避免 `MediaStore` 拒绝。

## 4. 后台传输（SyncService）

传输任务由**前台服务**执行，Activity 只负责显示：

- **保后台**：前台服务 + `PARTIAL_WAKE_LOCK`（**缺一不可** —— 只有前台服务的话，
  息屏后 CPU 仍会被挂起，传输卡在半路）
- **进度通知**：全程静默 —— 渠道 `gm_sync` 为 `IMPORTANCE_LOW` 且
  `setSound(null)` / `enableVibration(false)` / `enableLights(false)`，通知再叠
  `setSilent(true)` + `setOnlyAlertOnce(true)`。刷新按「百分比变化立即刷，否则最多 1.2 秒一次」节流。
- **界面只订阅状态**：`SyncService.state`（`StateFlow`），Activity 重建后仍能接着显示进度。
  `BackupRunner` / `RestoreRunner` 逻辑与执行者解耦。
- **崩溃安全**：通知权限被拒绝**不影响传输**（只影响能不能看见通知）；前台服务用
  `START_NOT_STICKY`，被杀后不会静默重跑。

## 5. 局域网发现

`HubDiscovery.kt` 优先用 Android `NsdManager` 搜索 `_neko-spark._tcp`，读取电脑端地址、端口、版本和证书指纹；
发现失败时继续用 UDP 广播（端口 8788）兼容旧版电脑端。电脑端会在 8787、8788、8789 中选择可用端口，
选中电脑后输入设置页显示的一次性 6 位配对码，手机通过 HTTPS `/api/v1/pair` 换取访问密钥。
配对成功和手机回到前台时会再次按证书指纹搜索 mDNS，自动更新电脑地址和端口。设置页二维码也可由应用内扫描页直接识别，二维码不包含访问密钥。
模拟器会自动补 `10.0.2.2`（宿主机的别名）。

## 6. 权限

```
READ_MEDIA_IMAGES / READ_MEDIA_VIDEO      （Android 13+）
READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE  （旧版）
FOREGROUND_SERVICE
FOREGROUND_SERVICE_DATA_SYNC
POST_NOTIFICATIONS                         （运行时；拒绝了也能传，只是看不见通知）
WAKE_LOCK
CAMERA                                    （仅点击“扫一扫配对”时请求）
SYSTEM_ALERT_WINDOW                        （用户开启悬浮窗进度时请求）
```

悬浮窗是可选功能。允许后，前台同步服务会显示软件图标和蓝色圆环；圆环从 12 点方向开始按顺时针表示进度，
任务结束或服务退出时移除。没有权限、用户关闭开关或厂商 ROM 拒绝覆盖层时，后台同步和通知栏进度仍然照常工作。

## 7. 贴图是怎么进 APK 的

`app/build.gradle.kts` 里有一个 `Sync` 任务（挂在 `preBuild` 上），构建时把
`<仓库根>/GalleryMirrorData/stickers/` 里的图片拷进 `assets/stickers/`，随 APK 一起安装。
可用环境变量 `GM_STICKERS_DIR` 覆盖源目录。

> ⚠️ 该任务有 `if (source.exists())` 守卫 —— **源目录不存在时不会报错，只是贴图静默为空**，
> APK 里就没有 `assets/stickers/`，界面回退到内置吉祥物。
> 所以「贴图没打进 APK」这类问题的第一嫌疑就是源目录路径。

运行时读取顺序：`assets/stickers/` 里字典序第一张 → 内置 `R.drawable.mascot_hi` →
联网时也可从 Hub 拉取（`MainActivity.loadMascotFromHub`）。

## 8. 构建与运行

```powershell
# 启动模拟器（需先配好 AVD）
powershell -ExecutionPolicy Bypass -File scripts\android-emulator.ps1

# 构建 + 安装 + 自动跑一次备份
powershell -ExecutionPolicy Bypass -File scripts\android-test.ps1

# 只构建安装
powershell -ExecutionPolicy Bypass -File scripts\android-test.ps1 -NoRun

# 指定电脑端地址（模拟器用 10.0.2.2；真机用局域网 IP；USB 用 127.0.0.1 + adb reverse）
powershell -ExecutionPolicy Bypass -File scripts\android-test.ps1 -Hub https://192.168.x.x:8787
```

直接调 Gradle：

```bash
gradle -p android assembleDebugAppDebug --offline --console=plain --no-daemon
```

> ⚠️ **外网受限的环境必须加 `--offline`**：Gradle/JVM 不走系统代理，不加会卡死在配置阶段
> （守护进程日志停在 "The daemon has started executing the build"，CPU 完全不动）。
> 依赖都在本地缓存里，加了很快就能编完。
>
> ⚠️ 构建被中断会留下 "busy Daemon" 占锁，之后每次启动都卡在
> `Starting a Gradle Daemon, 1 busy Daemon could not be reused` —— 清掉即可（结束 java 进程）。
>
> ⚠️ 别用管道接 Gradle 输出（会缓冲，构建中什么都看不到），重定向到文件再读。

**依赖最小化**：只用 OkHttp + 协程，其余走 Android 平台自带能力。

## 9. 环境要求

| 组件 | 说明 |
|---|---|
| JDK | 17 |
| Gradle | 8.9 |
| Android SDK | `platform-tools` / `platforms;android-34` / `build-tools;34.0.0` |
| 编译 SDK | 34 |

SDK 路径写在 `local.properties`（`sdk.dir=...`），该文件**不进版本库**，需要各自本地生成。
