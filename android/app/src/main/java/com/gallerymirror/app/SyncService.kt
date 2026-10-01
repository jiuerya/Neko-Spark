package com.gallerymirror.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** 同步任务类型 */
enum class SyncKind { NONE, BACKUP, RESTORE }

/** 同步任务对外的状态快照：界面和通知栏都读它 */
data class SyncState(
    val running: Boolean = false,
    val kind: SyncKind = SyncKind.NONE,
    /** 0..100；-1 表示进度未知（比如正在扫描相册） */
    val percent: Int = -1,
    val title: String = "",
    val detail: String = "",
    val finished: Boolean = false,
    val ok: Boolean = true,
    val summary: String = ""
)

/**
 * 前台服务：让备份/恢复在手机后台继续跑（切走 App、息屏都不中断），
 * 并在通知栏静默显示进度。
 *
 * 设计要点：
 * - **BackupRunner / RestoreRunner 的逻辑一行没动**。只是把「谁来跑」从 Activity 的
 *   lifecycleScope 换成服务自己的 scope —— Activity 被销毁也不会把传输带走。
 * - 前台服务 + PARTIAL_WAKE_LOCK 一起用才能真正「保后台」：光有前台服务，
 *   息屏后 CPU 仍可能被挂起，传输会停在半路。
 * - 通知全程静默：低优先级渠道 + 关闭声音/震动/呼吸灯 + onlyAlertOnce。
 */
class SyncService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var progressOverlay: SyncProgressOverlay? = null
    private var lastNotifyAt = 0L
    private var lastNotifyPercent = -2

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_BACKUP -> {
                begin(SyncKind.BACKUP, "正在备份到电脑", "正在连接电脑端…")
                val hub = intent.getStringExtra(EXTRA_HUB).orEmpty()
                val token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
                val fingerprint = intent.getStringExtra(EXTRA_FINGERPRINT).orEmpty()
                job = scope.launch { runBackup(hub, token, fingerprint) }
            }

            ACTION_RESTORE -> {
                begin(SyncKind.RESTORE, "正在从电脑恢复", "正在连接电脑端…")
                val hub = intent.getStringExtra(EXTRA_HUB).orEmpty()
                val token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
                val fingerprint = intent.getStringExtra(EXTRA_FINGERPRINT).orEmpty()
                val deviceId = intent.getStringExtra(EXTRA_DEVICE).orEmpty()
                val folder = intent.getStringExtra(EXTRA_FOLDER).orEmpty()
                val mode =
                    if (intent.getBooleanExtra(EXTRA_NEW_FOLDER, false)) RestoreRunner.Mode.NEW_FOLDER
                    else RestoreRunner.Mode.MERGE
                job = scope.launch { runRestore(hub, token, fingerprint, deviceId, mode, folder) }
            }

            ACTION_STOP -> {
                job?.cancel()
                finish(true, "已取消")
            }

            else -> stopSelf()
        }
        // 不自动重启：意外被杀后静默重跑一次传输会让人莫名其妙
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        progressOverlay?.hide()
        progressOverlay = null
        releaseWakeLock()
        super.onDestroy()
    }

    // ---------------- 任务 ----------------

    private suspend fun runBackup(hub: String, token: String, fingerprint: String) {
        try {
            val result = BackupRunner(this).run(
                hub,
                token,
                fingerprint,
                onLog = { line -> push(detail = line) },
                onProgress = { current, total, label, bytesDone, bytesTotal ->
                    val percent =
                        when {
                            bytesTotal > 0 -> (bytesDone * 100 / bytesTotal).toInt()
                            total > 0 -> current * 100 / total
                            else -> -1
                        }
                    push(percent = percent.coerceIn(-1, 100), detail = "$label（$current / $total）")
                }
            )
            finish(true, "备份完成：共 ${result.total} 项，上传 ${result.uploaded} 个")
        } catch (e: Exception) {
            finish(false, "备份失败：${e.message}")
        }
    }

    private suspend fun runRestore(
        hub: String,
        token: String,
        fingerprint: String,
        deviceId: String,
        mode: RestoreRunner.Mode,
        folderName: String
    ) {
        try {
            val result = RestoreRunner(this).run(
                hub,
                token,
                fingerprint,
                deviceId,
                mode,
                folderName,
                onLog = { line -> push(detail = line) },
                onProgress = { current, total, label, bytesDone, bytesTotal ->
                    val percent =
                        when {
                            bytesTotal > 0 -> (bytesDone * 100 / bytesTotal).toInt()
                            total > 0 -> current * 100 / total
                            else -> -1
                        }
                    push(percent = percent.coerceIn(-1, 100), detail = "$label（$current / $total）")
                }
            )
            val tail = if (result.folder.isNotEmpty()) "，位置：${result.folder}/" else ""
            finish(
                true,
                "恢复完成：成功 ${result.restored}，跳过 ${result.skipped}，失败 ${result.failed}$tail"
            )
        } catch (e: Exception) {
            finish(false, "恢复失败：${e.message}")
        }
    }

    // ---------------- 状态 ----------------

    private fun begin(kind: SyncKind, title: String, detail: String) {
        _state.value = SyncState(running = true, kind = kind, percent = -1, title = title, detail = detail)
        acquireWakeLock()
        // 先把服务提升为前台服务，再创建覆盖层；部分 Android 版本会拒绝后台服务直接添加悬浮窗。
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(title, detail, -1),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            }
        )
        val overlayEnabled = getSharedPreferences("gallery_mirror", MODE_PRIVATE)
            .getBoolean("overlay_enabled", false)
        if (overlayEnabled) {
            progressOverlay = SyncProgressOverlay(this).also { it.show(-1) }
        }
        lastNotifyAt = 0L
        lastNotifyPercent = -2
    }

    /**
     * 更新状态。进度回调非常密集（几千个文件），所以通知做了节流：
     * 百分比变了立刻刷新，否则最多每 1.2 秒刷一次，别把通知栏刷爆。
     */
    private fun push(percent: Int = Int.MIN_VALUE, detail: String? = null) {
        val prev = _state.value
        val next =
            prev.copy(
                percent = if (percent != Int.MIN_VALUE) percent else prev.percent,
                detail = detail ?: prev.detail
            )
        _state.value = next
        progressOverlay?.update(next.percent)

        val now = System.currentTimeMillis()
        val percentChanged = next.percent != lastNotifyPercent
        if (percentChanged || now - lastNotifyAt >= 1200) {
            lastNotifyAt = now
            lastNotifyPercent = next.percent
            notifyUpdate(next)
        }
    }

    private fun finish(ok: Boolean, summary: String) {
        val kind = _state.value.kind
        _state.value =
            SyncState(running = false, kind = kind, finished = true, ok = ok, summary = summary)
        releaseWakeLock()
        progressOverlay?.hide()
        progressOverlay = null
        job = null
        // 留一条「已完成」通知，方便用户不在跟前时回来也能知道结果；点一下即消失
        val done =
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_sync)
                .setContentTitle(if (ok) "同步完成" else "同步中断")
                .setContentText(summary)
                .setContentIntent(openAppIntent())
                .setOngoing(false)
                .setAutoCancel(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .apply { if (ok) setProgress(100, 100, false) }
                .build()
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, done)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
        stopSelf()
    }

    private fun notifyUpdate(state: SyncState) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(state.title, state.detail, state.percent))
    }

    // ---------------- 通知 ----------------

    private fun openAppIntent(): PendingIntent =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    private fun buildNotification(title: String, detail: String, percent: Int): Notification {
        val builder =
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_sync)
                .setContentTitle(title)
                .setContentText(detail)
                .setContentIntent(openAppIntent())
                .setOngoing(true)
                .setOnlyAlertOnce(true) // 后续更新不再提醒
                .setSilent(true) // 不出声、不震动
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setShowWhen(false)
        if (percent in 0..100) {
            builder.setProgress(100, percent, false).setSubText("$percent%")
        } else {
            builder.setProgress(0, 0, true) // 不确定进度：转圈
        }
        return builder.build()
    }

    // ---------------- 保后台 ----------------

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        wakeLock =
            pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GalleryMirror:sync").apply {
                setReferenceCounted(false)
                // 带超时：万一逻辑出岔子，最多 6 小时后自动释放，不会永久耗电
                acquire(6 * 60 * 60 * 1000L)
            }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
            // 忽略
        }
        wakeLock = null
    }

    companion object {
        private const val CHANNEL_ID = "gm_sync"
        private const val NOTIFICATION_ID = 1001

        const val ACTION_BACKUP = "com.gallerymirror.app.action.BACKUP"
        const val ACTION_RESTORE = "com.gallerymirror.app.action.RESTORE"
        const val ACTION_STOP = "com.gallerymirror.app.action.STOP"
        const val EXTRA_HUB = "hub"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_FINGERPRINT = "fingerprint"
        const val EXTRA_DEVICE = "device"
        const val EXTRA_FOLDER = "folder"
        const val EXTRA_NEW_FOLDER = "newFolder"

        private val _state = MutableStateFlow(SyncState())

        /** 界面订阅它就能实时看到进度（Activity 重建后也能接着显示） */
        val state: StateFlow<SyncState> = _state.asStateFlow()

        /** 通知渠道：低优先级 + 关声音/震动/呼吸灯，全程静默 */
        fun ensureChannel(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            val channel =
                NotificationChannel(CHANNEL_ID, "备份/恢复进度", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "显示手机与电脑之间的传输进度（静默，不打扰）"
                    setSound(null, null)
                    enableVibration(false)
                    enableLights(false)
                    setShowBadge(false)
                }
            manager.createNotificationChannel(channel)
        }

        fun startBackup(context: Context, hub: String, token: String, fingerprint: String) {
            ensureChannel(context)
            start(
                context,
                Intent(context, SyncService::class.java)
                    .setAction(ACTION_BACKUP)
                    .putExtra(EXTRA_HUB, hub)
                    .putExtra(EXTRA_TOKEN, token)
                    .putExtra(EXTRA_FINGERPRINT, fingerprint)
            )
        }

        fun startRestore(
            context: Context,
            hub: String,
            token: String,
            fingerprint: String,
            deviceId: String,
            mode: RestoreRunner.Mode,
            folderName: String
        ) {
            ensureChannel(context)
            start(
                context,
                Intent(context, SyncService::class.java)
                    .setAction(ACTION_RESTORE)
                    .putExtra(EXTRA_HUB, hub)
                    .putExtra(EXTRA_TOKEN, token)
                    .putExtra(EXTRA_FINGERPRINT, fingerprint)
                    .putExtra(EXTRA_DEVICE, deviceId)
                    .putExtra(EXTRA_FOLDER, folderName)
                    .putExtra(EXTRA_NEW_FOLDER, mode == RestoreRunner.Mode.NEW_FOLDER)
            )
        }

        fun cancel(context: Context) {
            context.startService(Intent(context, SyncService::class.java).setAction(ACTION_STOP))
        }

        private fun start(context: Context, intent: Intent) {
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
