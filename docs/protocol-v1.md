# GalleryMirror 备份协议 v1

手机端（Android）通过本协议把相册清单和原始文件同步到电脑端 Hub。WiFi 与 USB 使用同一套 HTTPS 协议：

- WiFi：手机直接访问电脑的局域网地址，如 `https://192.168.x.x:8787`
- USB：电脑执行 `adb forward tcp:8787 tcp:8787`，手机访问 `https://127.0.0.1:8787`

默认候选端口为 `8787`、`8788`、`8789`，被占用时电脑端按顺序切换，实际端口在软件界面显示。电脑端同时发布
mDNS 服务 `_neko-spark._tcp`，TXT 记录只包含名称、版本和 HTTPS 证书指纹；旧版客户端仍可使用 UDP `8788` 发现。

## 0. 安全与认证

Hub 强制使用 HTTPS。所有 Android 请求还必须使用桌面端设置页显示的证书指纹固定连接；非回环请求另外必须带访问密钥：

```http
X-Gallery-Mirror-Token: <局域网访问密钥>
```

桌面端本机回环请求（`127.0.0.1` / `::1`）可不带密钥；USB 回环转发可不带密钥但仍需证书指纹；WiFi、模拟器宿主机地址以及其他局域网地址必须带密钥和证书指纹。局域网发现 UDP 响应只携带地址、版本和证书指纹，不携带密钥。认证失败返回 `401`。

密钥只保存在电脑端数据目录的 `hub-token` 文件中。推荐通过 mDNS/二维码配对自动写入手机私有配置；USB 或旧版兼容流程才需要从设置页手动填写。不要把密钥写进源码、日志、Issue、PR 或上传附件。

### 首次配对（mDNS / 二维码）

电脑端每次启动 Hub 时生成一个 6 位、10 分钟有效的一次性配对码，并在本地设置页显示。手机可以通过
mDNS 服务 `_neko-spark._tcp` 找到电脑，也可以扫描设置页二维码。二维码只包含 HTTPS 地址、证书指纹和配对码，
不包含 Hub 访问密钥。手机向下面的接口提交配对码，服务端只在 HTTPS 证书指纹校验通过后返回访问密钥；成功后旧码立即失效。

```http
POST /api/v1/pair
Content-Type: application/json

{ "protocolVersion": 1, "code": "123456" }
```

新版手机也会附带设备身份：

```json
{
  "protocolVersion": 1,
  "code": "123456",
  "device": { "deviceId": "手机标识", "name": "我的手机" }
}
```

`device` 是兼容性可选字段。带设备身份的配对成功后，Hub 会先登记一条媒体数为 0 的设备记录，
设备页可以立即显示这台手机；首次提交 manifest/commit 后才更新最近同步时间和媒体内容。

成功响应：`{ "ok": true, "token": "...", "deviceRegistered": true }`；旧版请求未带设备身份时 `deviceRegistered` 为 `false`。
配对码错误返回 `401`，过期或已使用返回 `410`，连续错误次数过多返回 `429`。
配对码不通过 mDNS、普通 HTTP 接口或日志返回。

> 状态：本文档中标注 ✅ 的接口已在电脑端实现并通过端到端测试（`tools/mock-phone`）。

---

## 1. 数据来源（Android MediaStore 字段映射）

手机端扫描 `MediaStore.Images.Media` 与 `MediaStore.Video.Media`，按下表映射后上传：

| 协议字段 | Android 字段 | 说明 |
|---|---|---|
| `sha256` | 无（客户端计算） | 文件内容 SHA-256，小写十六进制 |
| `displayName` | `DISPLAY_NAME` | 文件名含扩展名 |
| `relativePath` | `RELATIVE_PATH`（API 29+）/ 由 `DATA` 推导 | 如 `DCIM/Camera/` |
| `bucketId` | `BUCKET_ID` | 相册 ID |
| `bucketName` | `BUCKET_DISPLAY_NAME` | 相册名，如 `Camera` |
| `mimeType` | `MIME_TYPE` | |
| `size` | `SIZE` | 字节 |
| `width` / `height` | `WIDTH` / `HEIGHT` | |
| `orientation` | `ORIENTATION`（API 29+） | EXIF 方向 1-8 |
| `dateTaken` | `DATE_TAKEN` | 毫秒时间戳 |
| `dateModified` | `DATE_MODIFIED` | 秒 → 毫秒 |
| `dateAdded` | `DATE_ADDED` | 秒 → 毫秒 |
| `isFavorite` | `IS_FAVORITE`（API 30+） | |
| `durationMs` | `DURATION` | 视频时长 |

> **保真原则**：传输原始字节，不转码、不压缩、不改名。EXIF、动态照片（Motion Photo）信息都在文件字节里，原样复制即可保留。

## 2. 接口

### 2.1 健康检查 ✅

```
GET /api/v1/health
```

```json
{
  "name": "相册镜像 GalleryMirror",
  "version": "0.1.0",
  "protocolVersion": 1,
  "uptimeMs": 8123,
  "time": "2026-09-12T10:00:00.000Z"
}
```

### 2.2 仓库信息 ✅

```
GET /api/v1/info
```

```json
{
  "counts": { "devices": 1, "albums": 42, "media": 15320, "blobs": 14987 }
}
```

### 2.3 上报「准备中」状态（可选，推荐）✅

```
POST /api/v1/sync/prepare
```

**为什么需要它**：手机在扫描相册、计算 SHA-256 指纹的阶段可能长达十几分钟，而这段时间**一个字节都还没上传**。手机若不打招呼，电脑端在这期间完全没有反馈，看起来和"没连上 / 卡死"一模一样。

调用时机：

1. 扫描出相册条目后**立刻调一次**（`hashed: 0`），让电脑端马上进入"准备中"；
2. 算指纹过程中**最多每 2 秒上报一次**进度（不要每算完一个文件就发一次）；
3. 算完后照常走 2.4 上报清单，电脑端会自动从"准备中"切换成上传进度。

请求体：

```json
{
  "protocolVersion": 1,
  "device": {
    "deviceId": "稳定唯一 ID",
    "name": "我的手机",
    "model": "Xiaomi 15",
    "androidVersion": "15"
  },
  "total": 4103,
  "totalBytes": 20866662400,
  "hashed": 320,
  "hashedBytes": 1610612736
}
```

| 字段 | 说明 |
|---|---|
| `total` / `totalBytes` | 本次要处理的文件总数 / 总字节数（首包带上，电脑端据此算百分比） |
| `hashed` / `hashedBytes` | 已算完指纹的数量（首包传 0） |

响应：`{ "ok": true }`

说明：

- **纯通知性质**：服务端只更新电脑端界面的进度，不写任何媒体数据。
- 老客户端可以不调用；不调用时电脑端行为与以前一致（收到清单后才显示进度）。
- 进度只允许前进：服务端按字段取 `max` 合并，乱序到达的旧包不会让百分比回退。
- 手机中途被杀/断网时，服务端 3 分钟后自动撤掉"准备中"提示，不会一直挂着。

### 2.4 上报清单并获取差异 ✅

```
POST /api/v1/manifest
```

请求体：

```json
{
  "protocolVersion": 1,
  "device": {
    "deviceId": "稳定唯一 ID",
    "name": "我的手机",
    "model": "Xiaomi 15",
    "androidVersion": "15"
  },
  "albums": [
    { "bucketId": "-1739773001", "bucketName": "Camera", "relativePath": "DCIM/Camera/", "count": 3021 }
  ],
  "items": [
    {
      "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "displayName": "IMG_20260901_101010.jpg",
      "relativePath": "DCIM/Camera/",
      "bucketId": "-1739773001",
      "bucketName": "Camera",
      "mimeType": "image/jpeg",
      "size": 2843111,
      "width": 4000,
      "height": 3000,
      "orientation": 1,
      "dateTaken": 1756712400000,
      "dateModified": 1756712402000,
      "dateAdded": 1756712500000,
      "isFavorite": false,
      "isMotionPhoto": false
    }
  ]
}
```

响应：

```json
{ "needed": ["9f86d081..."], "known": 15319, "total": 15320 }
```

`needed` 是服务端缺失的 `sha256` 列表，客户端只需上传这些文件（服务端按内容哈希全局去重）。

### 2.5 查询上传状态（断点续传）✅

```
GET /api/v1/upload-status?sha256=<hex>
```

```json
{ "exists": false, "received": 16777216, "size": 0 }
```

`exists=true` 表示服务端已有该文件（无需上传）；`received` 是已收到的字节数，客户端可从最近的 8MB 边界继续上传。

### 2.6 上传文件 ✅

```
PUT /api/v1/blob/{sha256}
Content-Range: bytes 0-8388607/2843111
Content-Type: application/octet-stream
<原始字节>
```

响应：

```json
{ "received": 8388608, "complete": false }
```

- 支持分块；`complete=true` 表示文件已收齐并通过 SHA-256 校验，服务端已落盘入库。
- 不带 `Content-Range` 时视作整文件一次性上传（`Content-Length` 自动作为总大小）。
- 校验不一致返回 `409 { "error": "hash_mismatch" }`，客户端应重传。
- 服务端已有该哈希时直接返回 `{ "received": 0, "complete": true, "existed": true }`。

### 2.7 提交入库 ✅

```
POST /api/v1/commit
```

```json
{
  "protocolVersion": 1,
  "device": { "deviceId": "...", "name": "我的手机" },
  "items": [ { "sha256": "...", "displayName": "...", "relativePath": "..." } ]
}
```

```json
{ "inserted": 15320, "skipped": 0, "total": 15320 }
```

服务端按 `(deviceId, relativePath, displayName)` 去重更新，并自动补齐缩略图。

### 2.8 浏览（电脑端界面使用，手机端也可复用）✅

```
GET /api/v1/devices
GET /api/v1/albums?deviceId=
GET /api/v1/media?deviceId=&bucketId=&kind=image|video&favorites=1
```

⚠️ **`/media` 不返回"被用户在电脑上删掉、正在回收站里"的条目**（`media.deleted = 1`）。
被手机端删除标记的条目（`sourceDeleted = true`，电脑保留备份）**照常返回** —— 恢复流程不受影响。
两者是不同概念：一个"电脑上删了"，一个"手机上删了"。

### 2.8.1 回收站（仅电脑端界面使用）✅

```
GET  /api/v1/trash                       # { media: [...], retentionDays: 30 }（顺手做一次到期清理）
POST /api/v1/media/trash   { "ids": [1,2] }   # 移入回收站（软删除，不删文件）
POST /api/v1/media/restore { "ids": [1,2] }   # 恢复，放回原来的相册位置
POST /api/v1/media/purge   { "ids": [1,2] }   # 彻底删除（记录 + 磁盘文件，不可恢复）
```

- 条目带 `deletedAt`（移入时间）与 `purgeAt`（到期时间 = 移入时间 + 保留天数），界面用后者算"剩 N 天"
- 到期由电脑端自动清理（启动时 / 每 6 小时 / 打开回收站时），不需要手机端参与
- 删除**只影响电脑端的库，绝不改动手机上的文件**
- 电脑端会记住"这条被删过"（墓碑），手机下次备份再上报同一个文件时**不会**被重新传回来（`needed` 里不含它）

### 2.9 媒体文件访问 ✅

```
GET /api/v1/thumb/{mediaId}   # webp 缩略图（按需生成）
GET /api/v1/file/{mediaId}    # 原始文件，支持 Range（视频拖动播放）
```

### 2.10 收藏 ✅

```
POST /api/v1/favorite
{ "id": 123, "favorite": true }
```

## 3. 恢复（回写手机）✅

电脑端已实现"导出为文件夹树"：按 `relativePath + displayName` 写回，并还原 `dateModified`。

安卓端已实现「从电脑恢复（迁移回手机）」，流程：

1. `GET /api/v1/devices` 选择来源设备（合并组会包含副设备）；
2. `GET /api/v1/media?deviceId=` 拉取该设备的媒体清单；
3. 用户选择恢复方式：

| 方式 | 行为 |
|---|---|
| 合并到同名文件夹 | 按 `media.relativePath` 写回手机同名相册（如 `DCIM/Camera/`）；手机上已有"同名同大小"的文件自动跳过；同名但大小不同时加 ` (n)` 序号，不覆盖 |
| 新建文件夹 | 全部文件放入 `DCIM/GalleryMirror恢复-<yyyyMMdd-HHmmss>/`，组内同名同大小去重，作为独立相册导入 |

4. 逐个 `GET /api/v1/file/{id}` 下载原始字节（不转码、不压缩、不改名）；
5. 写回系统相册：
   - Android 10+（API 29+）：`MediaStore` insert（`RELATIVE_PATH` + `IS_PENDING`）→ 清除 pending → 还原 `DATE_TAKEN`、收藏状态，系统相册自动收录；
   - Android 9 及以下：直接写入公共目录，再用 `MediaScannerConnection.scanFile()` 重建索引。

说明：`sourceDeleted`（手机上已删除、电脑保留）的条目也会被恢复；恢复日志会显示数量。
恢复为"复制"语义，不删除手机或电脑上的任何文件。

## 4. 版本与兼容

- `protocolVersion` 不匹配时，Hub 返回 `426 Upgrade Required` 并携带最低支持版本。
- 新增字段向后兼容，客户端可忽略未知字段。
