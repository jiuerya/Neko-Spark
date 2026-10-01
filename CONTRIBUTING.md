# 参与开发

感谢你有兴趣贡献！这个仓库里放着**两个独立的软件**，它们各有一套构建系统，
**你只需要动其中一棵树**，不必同时把两端都装好。

---

## 仓库布局

```
Neko-Spark/
├─ desktop/          ← 电脑端（Electron + TypeScript + React）
│  ├─ ARCHITECTURE.md   电脑端架构说明（先读这个）
│  ├─ src/ build/ scripts/ tools/
│  └─ package.json ...
├─ android/          ← 安卓端（Kotlin + Gradle）
│  ├─ ARCHITECTURE.md   安卓端架构说明（先读这个）
│  ├─ app/ scripts/
│  └─ build.gradle.kts ...
├─ docs/protocol-v1.md   ← 两端之间的接口契约（共享）
├─ GalleryMirrorData/    ← 角色素材（共享，版权见 NOTICE.md）
├─ README.md  LICENSE  NOTICE.md
└─ CONTRIBUTING.md       ← 本文件
```

| 目录 | 是什么 | 谁需要它 |
|---|---|---|
| `desktop/` | 电脑端全部源码与配置 | 只改电脑端的人 |
| `android/` | 安卓端全部源码与配置 | 只改安卓端的人 |
| `docs/` | 协议文档 | **两端都要看**（改协议时尤其） |
| `GalleryMirrorData/` | 贴图与背景图，两端共用 | 改界面的人 |

---

## 改电脑端

**环境**：Node.js ≥ 22。不需要 Android SDK。

```bash
cd desktop
npm install          # 首次
npm run dev          # 开发模式（热更新）
npm run typecheck    # 类型检查
npm test             # 类型检查 + 构建 + focused API contract test
npm run test:smoke   # 完整端到端回归（会短暂弹出应用窗口，按需手动运行）
npm run dist:nsis    # 打 Windows 安装版到 desktop/release/
```

Windows 上 PowerShell 默认禁止运行 `npm.ps1`，请用 `npm.cmd`。

### 电脑端启动诊断

桌面端启动后会在当前相册仓库的 `runtime/logs/startup.log` 写入脱敏诊断日志，记录数据目录选择来源、仓库是否存在、Hub 启动结果和未处理异常。日志不记录 Hub 令牌、私钥、证书内容、请求正文或完整本机路径；提交 Issue 前请先检查并删除任何不应公开的本机信息。旧安装包不包含这项日志功能，需要更新到包含该改动的版本后再复现。

**提交前请保证 `npm test` 全绿。** 默认测试运行类型检查、生产构建和 focused API contract，
不会启动完整相册 smoke。需要验证界面/交互时，再按需运行 `npm run test:smoke`。

新增 API 或协议功能时请一并补 focused contract test；界面/媒体回归场景再写入 `desktop/scripts/smoke.mjs`。
注意里面有几条**写测试的坑**（虚拟滚动只渲染视口内元素、界面刷新是限流的、
必须等「内容对不对」而不是「格子数够不够」），照现有段落的写法来。

## 改安卓端

**环境**：JDK 17、Gradle 8.9、Android SDK（`platforms;android-34` / `build-tools;34.0.0`）。
不需要 Node.js。

先在 `android/local.properties` 里写好 SDK 路径（该文件不进版本库）：

```properties
sdk.dir=D\:\\Android\\Sdk
```

```bash
cd android
gradle assembleDebugAppDebug --offline --console=plain --no-daemon
# 产物：app/build/outputs/apk/debugApp/debug/app-debugApp-debug.apk
```

仓库里的辅助脚本：

```powershell
powershell -ExecutionPolicy Bypass -File android\scripts\android-test.ps1          # 构建 + 安装 + 自动备份一次
powershell -ExecutionPolicy Bypass -File android\scripts\android-test.ps1 -NoRun   # 只构建安装
powershell -ExecutionPolicy Bypass -File android\scripts\android-emulator.ps1      # 起模拟器
```

> ⚠️ 外网受限的环境必须加 `--offline`，否则 Gradle 会卡死在配置阶段。
> 详见 [`android/ARCHITECTURE.md`](android/ARCHITECTURE.md) §8。

## 改协议

`docs/protocol-v1.md` 是两端的**契约**。改它意味着两端都要动：

1. 先改文档，说明新增/变更的接口与字段
2. 改电脑端服务端实现（`desktop/src/main/hub/index.ts`）
3. 改安卓端客户端（`android/app/src/main/java/com/gallerymirror/app/HubClient.kt`）
4. **保持向后兼容** —— 旧版 App 连新版电脑端、新版 App 连旧版电脑端都不应该崩

---

## 提 PR

1. Fork 本仓库，从默认分支切一个描述性的分支名
2. 只改你需要的那部分，避免顺手做无关的重构（review 会容易很多）
3. **只跑你改动那一端的构建/测试** —— 改电脑端跑 `cd desktop && npm test`；
   改安卓端跑 `gradle assembleDebugAppDebug`
4. 如果改了协议，两端都要改，并在 PR 描述里说明兼容性
5. PR 描述里写清楚**改了什么、为什么、怎么验证的**

提交 PR 到 `main` 或 `master` 会自动触发 GitHub Actions 门禁：桌面端类型检查、构建与端到端测试，Android 编译，依赖审计、依赖变更审查和敏感信息扫描。所有检查通过后才应合入主分支；主分支每次提交（包括 PR 合入产生的提交）会自动构建并发布 GitHub Release。

### 代码风格

- **注释用中文**，风格是「解释**为什么**这么做」，不是复述代码在做什么
- 遇到"这里改错会出事"的地方，用 `⚠️` 标注并写清后果
- 不要自作主张给界面加动画/过渡效果 —— 本项目的"流畅"指的是**操作跟手、不卡顿**，
  不是视觉转场（详见 `desktop/ARCHITECTURE.md` §4.6 的性能取向）
- 性能问题**先测量再动手**。`desktop/scripts/` 下有现成的探针（`_perf*.mjs`、`_probe-*.mjs`），
  别凭直觉猜瓶颈

---

## 许可证

- **代码**：PolyForm Noncommercial License 1.0.0 —— **禁止商业用途**，允许任意修改与再分发（限非商业）。
  提交 PR 即表示你同意以同一许可证发布你的贡献。
- **角色素材**：著作权归原作者，不适用代码许可证，**禁止商用**。详见 [`NOTICE.md`](NOTICE.md)。
  请不要往仓库里提交来路不明的第三方图片。

## 报告问题

提 Issue 时请说明：哪一端（电脑端 / 安卓端）、操作系统与版本、复现步骤、期望结果与实际结果。
电脑端的设置页里有版本号、端口、数据目录位置，截图通常会很有帮助。
