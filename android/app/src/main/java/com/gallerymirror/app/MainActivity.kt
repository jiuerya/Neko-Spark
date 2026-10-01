package com.gallerymirror.app

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private val prefs by lazy { getSharedPreferences("gallery_mirror", MODE_PRIVATE) }
    private lateinit var urlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var fingerprintInput: EditText
    private lateinit var hostSummaryText: TextView
    private lateinit var identityText: TextView
    private lateinit var statusText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var mascotView: ImageView
    private lateinit var logText: TextView
    private lateinit var connectButton: Button
    private lateinit var scanButton: Button
    private lateinit var backupButton: Button
    private lateinit var restoreButton: Button
    private lateinit var cancelButton: Button
    private lateinit var unpairButton: Button
    private lateinit var overlaySwitch: Switch
    private var afterPermission: (() -> Unit)? = null
    // 系统设置页返回时保留用户刚才的开启意图；否则先把开关拨回去会触发监听器，永久写入 false。
    private var pendingOverlayEnable = false
    private var updatingOverlaySwitch = false
    private var hostDiscoveryRunning = false
    private var lastHostDiscoveryAt = 0L

    private val qrScannerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == RESULT_OK) {
                handlePairIntent(result.data)
            }
        }

    private val colorText: Int get() = ContextCompat.getColor(this, R.color.gm_text)
    private val colorDim: Int get() = ContextCompat.getColor(this, R.color.gm_text_dim)
    private val colorAccent: Int get() = ContextCompat.getColor(this, R.color.gm_accent)

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            val granted = grants.values.any { it }
            log(if (granted) "相册权限已授予" else "相册权限被拒绝，请在系统设置里手动开启")
            val action = afterPermission
            afterPermission = null
            if (granted) action?.invoke()
        }

    /**
     * 通知权限：**只影响能不能在通知栏看进度**，
     * 拒绝了传输照样在后台跑，所以绝不能拿它卡住流程。
     */
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            log(
                if (granted) "通知权限已授予：后台传输时可在通知栏看进度、点一下回到本页"
                else "未授予通知权限：传输照常在后台进行，只是通知栏看不到进度"
            )
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(14))
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.parseColor("#F2F8FF"), Color.parseColor("#E7F3FF"))
            )
        }

        // ---------- 顶部：贴图 + 标题 ----------
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        mascotView = ImageView(this).apply {
            setImageResource(R.drawable.mascot_hi)
            // 打包进来的用户贴图优先（构建时从电脑端数据目录复制）
            Stickers.firstBitmap(this@MainActivity)?.let { setImageBitmap(it) }
            adjustViewBounds = true
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        header.addView(mascotView, LinearLayout.LayoutParams(dp(64), dp(64)).apply { rightMargin = dp(12) })

        val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        titles.addView(TextView(this).apply {
            text = "Neko_Spark"
            textSize = 20f
            setTextColor(colorText)
            typeface = Typeface.DEFAULT_BOLD
        })
        titles.addView(TextView(this).apply {
            text = "手机 ⇄ 电脑双向迁移 · 数据留在你手里"
            textSize = 12f
            setTextColor(colorDim)
        })
        header.addView(titles)
        root.addView(header)

        // ---------- 分区一：电脑主机 / 配对 ----------
        val hostCard = makeCard()
        addSectionHeader(hostCard, "电脑主机", "配对后会自动保存 HTTPS 地址、证书指纹和访问密钥")
        urlInput = EditText(this).apply {
            setText(prefs.getString("hub_url", defaultHubUrl()))
            hint = "https://192.168.x.x:8787"
            textSize = 15f
            setTextColor(colorText)
            setHintTextColor(colorDim)
            setSingleLine()
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.bg_input)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        val searchButton = styledButton("搜索电脑", primary = false).apply {
            setOnClickListener { searchHubs() }
        }
        val urlRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        urlRow.addView(urlInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        urlRow.addView(
            searchButton,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                leftMargin = dp(8)
            }
        )
        hostCard.addView(
            urlRow,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
        )
        hostSummaryText = TextView(this).apply {
            textSize = 12f
            setTextColor(colorDim)
            setPadding(0, dp(7), 0, 0)
        }
        hostCard.addView(hostSummaryText)

        val pairRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val pairButton = styledButton("输入配对码", primary = false).apply {
            setOnClickListener { promptPairingCode(saveUrl(), saveFingerprint()) }
        }
        val scanPairButton = styledButton("扫一扫配对", primary = false).apply {
            setOnClickListener { startQrScanner() }
        }
        pairRow.addView(pairButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        pairRow.addView(scanPairButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = dp(8)
        })
        hostCard.addView(pairRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(8)
        })

        addFieldLabel(hostCard, "局域网访问密钥")
        tokenInput = EditText(this).apply {
            setText(prefs.getString("hub_token", ""))
            hint = "配对后自动填写；手动连接时再填写"
            textSize = 15f
            setTextColor(colorText)
            setHintTextColor(colorDim)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine()
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.bg_input)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        hostCard.addView(tokenInput, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })

        addFieldLabel(hostCard, "HTTPS 证书 SHA-256 指纹")
        fingerprintInput = EditText(this).apply {
            setText(prefs.getString("hub_fingerprint", ""))
            hint = "配对后自动填写；手动连接时填写 SHA-256"
            textSize = 15f
            setTextColor(colorText)
            setHintTextColor(colorDim)
            setSingleLine()
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.bg_input)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        hostCard.addView(fingerprintInput, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })

        val hostActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            weightSum = 2f
        }
        connectButton = styledButton("测试连接", primary = false).apply { setOnClickListener { testConnection() } }
        unpairButton = styledButton("取消本机配对", primary = false).apply { setOnClickListener { clearPairing() } }
        hostActions.addView(connectButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        hostActions.addView(unpairButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(8) })
        hostCard.addView(hostActions, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
        root.addView(hostCard, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

        // ---------- 分区二：手机身份 ----------
        val deviceCard = makeCard()
        addSectionHeader(deviceCard, "这台手机", "用设备身份区分多台手机，重装后可认领电脑端已有记录")
        identityText = TextView(this).apply {
            textSize = 14f
            setTextColor(colorText)
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.bg_input)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setOnClickListener { pickDeviceIdentity() }
        }
        deviceCard.addView(
            identityText,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
        )
        deviceCard.addView(TextView(this).apply {
            text = "点击上方身份卡可改名或认领电脑端已有设备"
            textSize = 11f
            setTextColor(colorDim)
            setPadding(0, dp(4), 0, 0)
        })
        root.addView(deviceCard, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })

        // ---------- 分区三：相册迁移 ----------
        val transferCard = makeCard()
        addSectionHeader(transferCard, "相册迁移", "先扫描确认数量，再选择备份；传输期间可留在后台")
        val buttonRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            weightSum = 2f
        }
        scanButton = styledButton("扫描相册", primary = false)
        backupButton = styledButton("开始备份", primary = true)
        for ((index, button) in listOf(scanButton, backupButton).withIndex()) {
            buttonRow.addView(button, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                if (index > 0) leftMargin = dp(8)
            })
        }
        transferCard.addView(buttonRow)

        restoreButton = styledButton("从电脑恢复（迁移回手机）", primary = false)
        transferCard.addView(
            restoreButton,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }
        )
        cancelButton = styledButton("取消当前任务", primary = false).apply {
            isEnabled = false
            alpha = 0.5f
            setOnClickListener { SyncService.cancel(this@MainActivity) }
        }
        transferCard.addView(cancelButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })

        statusText = TextView(this).apply {
            text = "就绪"
            textSize = 13f
            setTextColor(colorAccent)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, dp(12), 0, 0)
        }
        transferCard.addView(statusText)
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            visibility = View.GONE
            progressTintList = android.content.res.ColorStateList.valueOf(colorAccent)
            progressBackgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#E3F1FF"))
        }
        transferCard.addView(progressBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(10)).apply { topMargin = dp(6) })
        root.addView(transferCard, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })

        // ---------- 分区四：运行设置 ----------
        val settingsCard = makeCard()
        addSectionHeader(settingsCard, "运行设置", "后台同步会使用前台服务和通知栏显示进度")
        overlaySwitch = Switch(this).apply {
            text = "同步时显示悬浮窗进度"
            textSize = 13f
            setTextColor(colorText)
            isChecked = prefs.getBoolean("overlay_enabled", false)
        }
        overlaySwitch.setOnCheckedChangeListener { _, checked ->
            if (updatingOverlaySwitch) return@setOnCheckedChangeListener
            val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)
            if (checked && !allowed) {
                pendingOverlayEnable = true
                log("请在系统设置中允许悬浮窗权限，允许后再打开此开关")
                openOverlayPermissionSettings()
            } else {
                // 用户主动关闭时取消待处理意图，避免从设置页返回后又被自动打开。
                pendingOverlayEnable = false
                prefs.edit().putBoolean("overlay_enabled", checked).apply()
                log(if (checked) "已开启同步悬浮窗" else "已关闭同步悬浮窗")
            }
        }
        settingsCard.addView(overlaySwitch)
        settingsCard.addView(TextView(this).apply {
            text = "仅在备份/恢复运行期间显示；外圈从 12 点方向按顺时针表示实时进度。"
            textSize = 11f
            setTextColor(colorDim)
            setPadding(0, 0, 0, dp(2))
        })
        root.addView(settingsCard, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })

        // ---------- 分区五：活动日志 ----------
        val logCard = makeCard()
        addSectionHeader(logCard, "活动日志", "只显示本机操作结果，不会记录访问密钥")
        logText = TextView(this).apply {
            text = ""
            textSize = 12f
            setTextColor(colorText)
            movementMethod = ScrollingMovementMethod()
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.bg_card)
            setPadding(dp(14), dp(14), dp(14), dp(14))
            setLineSpacing(dp(3).toFloat(), 1f)
        }
        // 页面内容比小屏高度长时交给外层 ScrollView 滚动；日志保留固定高度，避免权重在
        // ScrollView 的非约束测量下吞掉其它控件或让整页无法向下滚动。
        logCard.addView(logText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(180)).apply { topMargin = dp(8) })
        root.addView(logCard, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })

        val page = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = true
        }
        page.addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(page)
        observeSyncState()

        scanButton.setOnClickListener { ensurePermissionThen { scanAlbum() } }
        backupButton.setOnClickListener { startBackup() }
        restoreButton.setOnClickListener { ensurePermissionThen { startRestore() } }

        log("提示：USB 连接时先在电脑执行 adb reverse tcp:8787 tcp:8787，地址填 https://127.0.0.1:8787，并填写证书指纹")
        log("手机 → 电脑：点「开始备份」；电脑 → 手机：点「从电脑恢复」")

        // 自动化测试入口：am start ... --ez autorun true [--es hub https://xxx:8787]
        intent?.getStringExtra("hub")?.let { urlInput.setText(it) }
        intent?.getStringExtra("token")?.let { tokenInput.setText(it) }
        intent?.getStringExtra("fingerprint")?.let { fingerprintInput.setText(it) }
        updateIdentity()
        updateHostSummary()
        if (intent?.getBooleanExtra("searchhubs", false) == true) {
            logText.postDelayed({ searchHubs() }, 500)
        }
        if (intent?.getBooleanExtra("autorun", false) == true) {
            logText.postDelayed({ runBackup(saveUrl(), saveToken(), saveFingerprint()) }, 400)
        }
        // 自动化测试入口：am start ... --ez restore true [--es restoremode merge|new] [--es restorefolder 名字]
        if (intent?.getBooleanExtra("restore", false) == true) {
            val mode = if (intent.getStringExtra("restoremode") == "new") {
                RestoreRunner.Mode.NEW_FOLDER
            } else {
                RestoreRunner.Mode.MERGE
            }
            val folder = intent.getStringExtra("restorefolder") ?: ""
            logText.postDelayed({ ensurePermissionThen { autoRestore(saveUrl(), saveToken(), saveFingerprint(), mode, folder) } }, 500)
        }
        handlePairIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handlePairIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        if (::overlaySwitch.isInitialized) {
            val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)
            if (allowed && pendingOverlayEnable) {
                pendingOverlayEnable = false
                prefs.edit().putBoolean("overlay_enabled", true).apply()
                log("悬浮窗权限已开启，同步时会显示进度")
            }
            // 权限被系统撤回时只更新界面，不改写用户配置；权限恢复后可自动恢复。
            val enabled = pendingOverlayEnable || (allowed && prefs.getBoolean("overlay_enabled", false))
            if (overlaySwitch.isChecked != enabled) {
                updatingOverlaySwitch = true
                overlaySwitch.isChecked = enabled
                updatingOverlaySwitch = false
            }
        }
        refreshPairedHostFromDiscovery()
    }

    /** 已配对手机回到前台时刷新 mDNS，自动跟随电脑端换端口或网卡变化。 */
    private fun refreshPairedHostFromDiscovery() {
        if (!::urlInput.isInitialized || hostDiscoveryRunning) return
        val token = prefs.getString("hub_token", "").orEmpty()
        val fingerprint = prefs.getString("hub_fingerprint", "").orEmpty()
        if (token.isBlank() || fingerprint.isBlank()) return
        val now = System.currentTimeMillis()
        if (now - lastHostDiscoveryAt < 10_000L) return
        lastHostDiscoveryAt = now
        hostDiscoveryRunning = true
        lifecycleScope.launch {
            try {
                val found = withContext(Dispatchers.IO) { HubDiscovery.search(this@MainActivity, timeoutMs = 1800L) }
                val expected = normalizeFingerprint(fingerprint)
                val target = found.firstOrNull { normalizeFingerprint(it.fingerprint) == expected }
                if (target != null && target.url != urlInput.text.toString().trim()) {
                    urlInput.setText(target.url)
                    fingerprintInput.setText(target.fingerprint)
                    prefs.edit()
                        .putString("hub_url", target.url)
                        .putString("hub_fingerprint", target.fingerprint)
                        .apply()
                    updateHostSummary("已通过局域网发现更新电脑地址：${target.url}")
                    log("电脑端地址已自动更新：${target.url}")
                }
            } catch (e: Exception) {
                log("更新电脑地址失败：${e.message}")
            } finally {
                hostDiscoveryRunning = false
            }
        }
    }

    private fun normalizeFingerprint(value: String): String =
        value.filter { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }.uppercase()

    /** 搜索局域网里的电脑端 Hub（一个局域网可能有多台） */
    private fun searchHubs() {
        statusText.text = "搜索局域网里的电脑..."
        lifecycleScope.launch {
            val found = withContext(Dispatchers.IO) { HubDiscovery.search(this@MainActivity) }
            statusText.text = "就绪"
            if (found.isEmpty()) {
                log("没有搜索到电脑。请确认：电脑端程序正在运行、手机与电脑连同一个 WiFi；也可以手动填地址。")
                return@launch
            }
            val labels = found.map { "${it.name}（${it.host}:${it.port}）\n指纹：${it.fingerprint.take(16)}…" }.toTypedArray()
            runOnUiThread {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("选择要连接的电脑（找到 ${found.size} 台）")
                    .setItems(labels) { _, which ->
                        val target = found[which]
                        urlInput.setText(target.url)
                        fingerprintInput.setText(target.fingerprint)
                        saveUrl()
                        saveFingerprint()
                        updateHostSummary("已发现电脑：${target.url}")
                        log("已选择电脑：${target.name}  ${target.url}")
                        promptPairingCode(target.url, target.fingerprint)
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
        }
    }

    private fun autoName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    /** 当前身份摘要：是否认领了电脑端已有设备 */
    private fun updateIdentity() {
        val bound = prefs.getString("bound_device_id", null)
        val name = prefs.getString("device_name", null)?.takeIf { it.isNotBlank() } ?: autoName()
        identityText.text = if (bound.isNullOrBlank()) "$name（自动识别）" else "$name（已认领电脑端已有设备）"
    }

    /** 选择设备身份：改名 / 新建 / 认领电脑端已有设备 */
    private fun pickDeviceIdentity() {
        val url = saveUrl()
        val token = saveToken()
        val fingerprint = saveFingerprint()
        lifecycleScope.launch {
            val devices = try {
                withContext(Dispatchers.IO) { HubClient(url, token, fingerprint).devices() }
            } catch (e: Exception) {
                log("获取电脑端设备列表失败：${e.message}")
                emptyList()
            }
            val options = mutableListOf(
                "修改这台手机的名字",
                "新建设备（用本机自动识别）"
            )
            for (d in devices) options.add("认领为「${d.name}」（${d.mediaCount} 项）")

            runOnUiThread {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("我是哪台手机？")
                    .setItems(options.toTypedArray()) { _, which ->
                        when (which) {
                            0 -> promptRename()
                            1 -> {
                                prefs.edit().remove("bound_device_id").apply()
                                updateIdentity()
                                log("设备身份：新建（自动识别），名称 ${prefs.getString("device_name", null) ?: autoName()}")
                            }
                            else -> {
                                val device = devices[which - 2]
                                prefs.edit()
                                    .putString("bound_device_id", device.id)
                                    .putString("device_name", device.name)
                                    .apply()
                                updateIdentity()
                                log("设备身份：已认领电脑端设备「${device.name}」，下次备份会记录到这台下面")
                            }
                        }
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
        }
    }

    private fun makeCard(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = ContextCompat.getDrawable(this@MainActivity, R.drawable.bg_card)
        setPadding(dp(14), dp(14), dp(14), dp(16))
    }

    private fun addSectionHeader(parent: LinearLayout, title: String, subtitle: String) {
        parent.addView(TextView(this).apply {
            text = title
            textSize = 17f
            setTextColor(colorText)
            typeface = Typeface.DEFAULT_BOLD
        })
        parent.addView(TextView(this).apply {
            text = subtitle
            textSize = 11f
            setTextColor(colorDim)
            setPadding(0, dp(3), 0, dp(8))
        })
    }

    private fun addFieldLabel(parent: LinearLayout, textValue: String) {
        parent.addView(TextView(this).apply {
            text = textValue
            textSize = 12f
            setTextColor(colorDim)
            setPadding(0, dp(12), 0, 0)
        })
    }

    private fun promptRename() {
        val input = EditText(this).apply {
            setText(prefs.getString("device_name", null)?.takeIf { it.isNotBlank() } ?: autoName())
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }
        AlertDialog.Builder(this)
            .setTitle("这台手机叫什么名字")
            .setView(input)
            .setPositiveButton("保存") { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) {
                    prefs.edit().putString("device_name", name).apply()
                    updateIdentity()
                    log("设备名已改为「$name」（下次备份同步到电脑端）")
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun styledButton(label: String, primary: Boolean): Button = Button(this).apply {
        text = label
        textSize = 13f
        isAllCaps = false
        stateListAnimator = null
        background = ContextCompat.getDrawable(
            this@MainActivity,
            if (primary) R.drawable.bg_primary else R.drawable.bg_secondary
        )
        setTextColor(if (primary) Color.WHITE else colorAccent)
        setPadding(dp(4), dp(10), dp(4), dp(10))
    }

    /**
     * 模拟器里 10.0.2.2 就是宿主机，可以直接用。
     * 真机没有可猜的默认值（每家的网段都不一样），留空让用户填写或使用搜索结果。
     */
    private fun defaultHubUrl(): String {
        val isEmulator = Build.FINGERPRINT.contains("generic") ||
            Build.FINGERPRINT.contains("emulator") ||
            Build.MODEL.contains("sdk", ignoreCase = true) ||
            Build.PRODUCT.contains("sdk", ignoreCase = true)
        return if (isEmulator) "https://10.0.2.2:8787" else ""
    }

    private fun saveUrl(): String {
        val url = urlInput.text.toString().trim().ifEmpty { defaultHubUrl() }
        prefs.edit().putString("hub_url", url).apply()
        return url
    }

    private fun startQrScanner() {
        // 由扫描页自己申请相机权限，避免主界面申请完成后 Surface 已经错过初始化时机。
        qrScannerLauncher.launch(Intent(this, QrScannerActivity::class.java))
    }

    private fun openOverlayPermissionSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        // 部分 ROM 会忽略带 package 的专属页面，失败后退回系统悬浮窗权限列表。
        val intents = listOf(
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")),
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
        )
        for (intent in intents) {
            if (runCatching { startActivity(intent) }.isSuccess) return
        }
        Toast.makeText(this, "请在系统设置中打开“允许显示在其他应用上层”", Toast.LENGTH_LONG).show()
    }

    private fun handlePairIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (!data.scheme.equals("neko-spark", ignoreCase = true) || !data.host.equals("pair", ignoreCase = true)) return
        val url = data.getQueryParameter("url").orEmpty().trim().trimEnd('/')
        val fingerprint = data.getQueryParameter("fingerprint").orEmpty().trim()
        val code = data.getQueryParameter("code").orEmpty().trim()
        if (url.isBlank() || fingerprint.isBlank() || !code.matches(Regex("\\d{6}"))) {
            log("二维码内容不完整，未开始配对")
            return
        }
        urlInput.setText(url)
        fingerprintInput.setText(fingerprint)
        updateHostSummary("已读取二维码，正在连接电脑：$url")
        pairHub(url, fingerprint, code)
    }

    private fun promptPairingCode(url: String, fingerprint: String) {
        if (url.isBlank() || fingerprint.isBlank()) {
            log("请先搜索电脑或填写 HTTPS 地址与证书指纹")
            return
        }
        val input = EditText(this).apply {
            hint = "6 位配对码"
            inputType = InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(InputFilter.LengthFilter(6))
            setSingleLine()
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }
        AlertDialog.Builder(this)
            .setTitle("输入电脑端配对码")
            .setMessage("配对码在电脑端设置页显示，有效期 10 分钟且成功后立即失效")
            .setView(input)
            .setPositiveButton("开始配对") { _, _ ->
                val code = input.text.toString().trim()
                if (!code.matches(Regex("\\d{6}"))) {
                    log("配对码必须是 6 位数字")
                } else {
                    pairHub(url, fingerprint, code)
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun pairHub(url: String, fingerprint: String, code: String) {
        statusText.text = "配对中..."
        lifecycleScope.launch {
            try {
                val runner = BackupRunner(this@MainActivity)
                val result = withContext(Dispatchers.IO) {
                    HubClient(url, "", fingerprint).pair(code, runner.deviceId(), runner.deviceName())
                }
                // 配对成功后重新发现 Hub，修正端口被占用切换、网卡变化或二维码生成时的旧地址。
                val discovered = withContext(Dispatchers.IO) {
                    HubDiscovery.search(this@MainActivity)
                }
                val expectedFingerprint = normalizeFingerprint(fingerprint)
                val currentHub = discovered.firstOrNull { it.fingerprint.equals(expectedFingerprint, ignoreCase = true) }
                val effectiveUrl = currentHub?.url ?: url
                val effectiveFingerprint = currentHub?.fingerprint ?: fingerprint
                if (currentHub != null && currentHub.url != url) {
                    log("已通过局域网发现更新电脑地址：${currentHub.url}")
                } else if (currentHub == null) {
                    log("配对成功，但暂未发现电脑的 mDNS 广播，保留二维码地址")
                }
                urlInput.setText(effectiveUrl)
                fingerprintInput.setText(effectiveFingerprint)
                tokenInput.setText(result.token)
                prefs.edit()
                    .putString("hub_url", effectiveUrl)
                    .putString("hub_fingerprint", effectiveFingerprint)
                    .putString("hub_token", result.token)
                    .apply()
                updateHostSummary("配对成功，正在验证电脑连接：$effectiveUrl")
                statusText.text = "配对成功"
                log("已与电脑端配对，访问密钥已安全保存到应用私有配置")
                Toast.makeText(this@MainActivity, "配对成功，连接信息已自动保存", Toast.LENGTH_LONG).show()
                testConnection()
            } catch (e: Exception) {
                statusText.text = "配对失败"
                log("配对失败：${e.message}")
                Toast.makeText(this@MainActivity, "配对失败，请检查地址、证书指纹和配对码", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun saveToken(): String {
        val token = tokenInput.text.toString().trim()
        prefs.edit().putString("hub_token", token).apply()
        return token
    }

    private fun saveFingerprint(): String {
        val fingerprint = fingerprintInput.text.toString().trim()
        prefs.edit().putString("hub_fingerprint", fingerprint).apply()
        return fingerprint
    }

    private fun updateHostSummary(message: String? = null) {
        if (!::hostSummaryText.isInitialized) return
        val url = prefs.getString("hub_url", "").orEmpty()
        val fingerprint = prefs.getString("hub_fingerprint", "").orEmpty()
        hostSummaryText.text = when {
            message != null -> message
            url.isBlank() || fingerprint.isBlank() -> "尚未配对：搜索电脑或扫一扫配对"
            else -> "已保存主机：$url\n证书指纹已保存，访问密钥已安全存储"
        }
    }

    private fun clearPairing() {
        if (running) {
            log("任务进行中，完成或取消任务后再取消配对")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("取消本机配对？")
            .setMessage("只清除这台手机保存的主机地址、证书指纹和访问密钥，电脑端相册与设备记录不会被删除。")
            .setPositiveButton("取消配对") { _, _ ->
                prefs.edit()
                    .remove("hub_url")
                    .remove("hub_token")
                    .remove("hub_fingerprint")
                    .apply()
                urlInput.setText(defaultHubUrl())
                tokenInput.setText("")
                fingerprintInput.setText("")
                statusText.text = "尚未配对"
                updateHostSummary()
                log("已取消本机配对，电脑端相册未受影响")
            }
            .setNegativeButton("保留", null)
            .show()
    }

    private fun testConnection() {
        val url = saveUrl()
        val token = saveToken()
        val fingerprint = saveFingerprint()
        statusText.text = "测试连接中..."
        updateHostSummary("正在连接电脑：$url")
        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { HubClient(url, token, fingerprint).health() }
                statusText.text = "连接成功"
                updateHostSummary("电脑已连接：$url")
                log("连接成功：$result")
                loadMascotFromHub(url, token, fingerprint)
            } catch (e: Exception) {
                statusText.text = "连接失败"
                updateHostSummary("电脑暂时不可达：$url")
                log("连接失败：${e.message}")
            }
        }
    }

    /** 电脑端设置了本地贴图时，手机端显示同一套图 */
    private fun loadMascotFromHub(url: String, token: String, fingerprint: String) {
        lifecycleScope.launch {
            try {
                val bitmap = withContext(Dispatchers.IO) {
                    val client = HubClient(url, token, fingerprint)
                    val stickers = client.stickerUrls()
                    if (stickers.isEmpty()) null else client.fetchBitmap(stickers.first())
                }
                if (bitmap != null) runOnUiThread { mascotView.setImageBitmap(bitmap) }
            } catch (_: Exception) {
                // 保持内置贴图
            }
        }
    }

    private fun requiredPermissions(): Array<String> {
        val list = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            list.add(Manifest.permission.READ_MEDIA_IMAGES)
            list.add(Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            list.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            list.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
        return list.toTypedArray()
    }

    private fun ensurePermissionThen(action: () -> Unit) {
        val missing = requiredPermissions().filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            action()
        } else {
            afterPermission = action
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    private fun scanAlbum() {
        statusText.text = "扫描相册中..."
        lifecycleScope.launch {
            try {
                val entries = withContext(Dispatchers.IO) { MediaScanner.scan(this@MainActivity) }
                val images = entries.count { it.kind == "image" }
                val videos = entries.count { it.kind == "video" }
                statusText.text = "共 ${entries.size} 个文件（图片 $images / 视频 $videos）"
                log("扫描完成：共 ${entries.size} 个文件（图片 $images 个，视频 $videos 个）")
                val byAlbum = entries
                    .groupBy { it.bucketName.ifBlank { "未分类" } }
                    .map { (name, list) -> name to list.size }
                    .sortedByDescending { it.second }
                log("按相册分类（共 ${byAlbum.size} 个相册）：")
                for ((name, count) in byAlbum) {
                    log("  · $name：$count 个")
                }
            } catch (e: Exception) {
                statusText.text = "扫描失败"
                log("扫描失败：${e.message}")
            }
        }
    }

    /** 任务跑在前台服务里，这里只是读它的状态 */
    private val running: Boolean get() = SyncService.state.value.running

    /** 订阅同步状态：界面只负责显示，Activity 重建后也能接着显示进度 */
    private fun observeSyncState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                SyncService.state.collect { state -> renderSyncState(state) }
            }
        }
    }

    private var lastSummary = ""

    private fun renderSyncState(state: SyncState) {
        setButtonsEnabled(!state.running)
        cancelButton.isEnabled = state.running
        cancelButton.alpha = if (state.running) 1f else 0.5f
        if (state.running) {
            progressBar.visibility = View.VISIBLE
            progressBar.max = 100
            if (state.percent >= 0) {
                progressBar.isIndeterminate = false
                progressBar.progress = state.percent
                statusText.text = "${state.percent}%  ${state.detail}"
            } else {
                progressBar.isIndeterminate = true
                statusText.text = "${state.title}  ${state.detail}"
            }
            return
        }
        if (state.finished && state.summary.isNotEmpty() && state.summary != lastSummary) {
            lastSummary = state.summary
            progressBar.isIndeterminate = false
            if (state.ok) {
                progressBar.visibility = View.VISIBLE
                progressBar.progress = 100
            } else {
                progressBar.visibility = View.GONE
            }
            statusText.text = state.summary
            log(state.summary)
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** 开始备份：先读取电脑端设备列表，让用户选择"新建"还是"认领已有" */
    private fun startBackup() {
        if (running) {
            log("任务进行中，请稍候")
            return
        }
        val url = saveUrl()
        val token = saveToken()
        val fingerprint = saveFingerprint()
        statusText.text = "读取电脑端设备列表..."
        lifecycleScope.launch {
            val devices = try {
                withContext(Dispatchers.IO) { HubClient(url, token, fingerprint).devices() }
            } catch (e: Exception) {
                log("读取设备列表失败（按当前身份继续备份）：${e.message}")
                emptyList()
            }
            statusText.text = "就绪"
            if (devices.isEmpty()) {
                runBackup(url, token, fingerprint)
            } else {
                runOnUiThread { askIdentityThenBackup(url, token, fingerprint, devices) }
            }
        }
    }

    /** 选择这台手机对应电脑端的哪台设备 */
    private fun askIdentityThenBackup(url: String, token: String, fingerprint: String, devices: List<HubClient.DeviceSummary>) {
        val boundId = prefs.getString("bound_device_id", null)
        val autoDeviceName = prefs.getString("device_name", null)?.takeIf { it.isNotBlank() } ?: autoName()
        val options = ArrayList<String>()
        options.add("新建设备（自动识别：$autoDeviceName）")
        for (device in devices) {
            val mark = if (device.id == boundId) "  ← 当前使用" else ""
            options.add("认领已有设备「${device.name}」（${device.mediaCount} 项）$mark")
        }
        AlertDialog.Builder(this)
            .setTitle("备份为哪台手机？")
            .setItems(options.toTypedArray()) { _, which ->
                if (which == 0) {
                    prefs.edit().remove("bound_device_id").apply()
                    log("已选择：新建设备（自动识别）")
                } else {
                    val device = devices[which - 1]
                    prefs.edit()
                        .putString("bound_device_id", device.id)
                        .putString("device_name", device.name)
                        .apply()
                    log("已选择：认领电脑端设备「${device.name}」")
                }
                updateIdentity()
                runBackup(url, token, fingerprint)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun runBackup(url: String, token: String, fingerprint: String) {
        setButtonsEnabled(false)
        ensureNotificationPermission()
        loadMascotFromHub(url, token, fingerprint)
        // 交给前台服务跑：切走 App / 息屏都不会中断，进度同时显示在通知栏
        SyncService.startBackup(this, url, token, fingerprint)
    }

    private fun setButtonsEnabled(enabled: Boolean) {
        for (button in listOf(backupButton, scanButton, restoreButton)) {
            button.isEnabled = enabled
            button.alpha = if (enabled) 1f else 0.5f
        }
    }

    /** 从电脑恢复（迁移回手机）：先选来源设备，再选恢复方式 */
    private fun startRestore() {
        if (running) {
            log("任务进行中，请稍候")
            return
        }
        val url = saveUrl()
        val token = saveToken()
        val fingerprint = saveFingerprint()
        statusText.text = "读取电脑端设备列表..."
        lifecycleScope.launch {
            val devices = try {
                withContext(Dispatchers.IO) { HubClient(url, token, fingerprint).devices() }
            } catch (e: Exception) {
                log("读取设备列表失败：${e.message}")
                emptyList()
            }
            statusText.text = "就绪"
            if (devices.isEmpty()) {
                log("电脑端没有可恢复的设备（先在手机上备份一次，或检查电脑端服务）")
                return@launch
            }
            askRestoreDevice(url, token, fingerprint, devices)
        }
    }

    private fun askRestoreDevice(url: String, token: String, fingerprint: String, devices: List<HubClient.DeviceSummary>) {
        val boundId = prefs.getString("bound_device_id", null)
        val options = devices.map { device ->
            val mark = if (device.id == boundId) "  ← 当前使用" else ""
            "「${device.name}」（${device.mediaCount} 项）$mark"
        }
        AlertDialog.Builder(this)
            .setTitle("从哪台设备恢复回手机？")
            .setItems(options.toTypedArray()) { _, which ->
                val device = devices[which]
                log("恢复来源：${device.name}")
                askRestoreMode(url, token, fingerprint, device)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun askRestoreMode(url: String, token: String, fingerprint: String, device: HubClient.DeviceSummary) {
        val options = arrayOf(
            "合并到同名文件夹（例如 DCIM/Camera 直接合并）",
            "新建文件夹（自己起名字，导入成一个新相册）"
        )
        AlertDialog.Builder(this)
            .setTitle("怎么恢复「${device.name}」？")
            .setItems(options) { _, which ->
                if (which == 0) {
                    runRestore(url, token, fingerprint, device.id, RestoreRunner.Mode.MERGE)
                } else {
                    promptRestoreFolderName(url, token, fingerprint, device)
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 新建文件夹模式：文件夹名字可自定义，默认用设备名 */
    private fun promptRestoreFolderName(url: String, token: String, fingerprint: String, device: HubClient.DeviceSummary) {
        val input = EditText(this).apply {
            setText(device.name)
            selectAll()
            hint = "新文件夹名字"
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }
        AlertDialog.Builder(this)
            .setTitle("新文件夹叫什么名字？")
            .setMessage("会在手机的 DCIM/ 下新建这个文件夹，导入成一个新相册")
            .setView(input)
            .setPositiveButton("开始恢复") { _, _ ->
                val name = input.text.toString().trim().ifBlank { device.name }
                runRestore(url, token, fingerprint, device.id, RestoreRunner.Mode.NEW_FOLDER, name)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun runRestore(
        url: String,
        token: String,
        fingerprint: String,
        deviceId: String,
        mode: RestoreRunner.Mode,
        folderName: String = ""
    ) {
        setButtonsEnabled(false)
        ensureNotificationPermission()
        // 同上：交给前台服务，切走 App / 息屏也能继续写回相册
        SyncService.startRestore(this, url, token, fingerprint, deviceId, mode, folderName)
    }

    /** 自动化测试入口：自动选当前绑定的设备（或第一台）恢复 */
    private fun autoRestore(url: String, token: String, fingerprint: String, mode: RestoreRunner.Mode, folderName: String) {
        lifecycleScope.launch {
            val devices = try {
                withContext(Dispatchers.IO) { HubClient(url, token, fingerprint).devices() }
            } catch (e: Exception) {
                log("读取设备列表失败：${e.message}")
                emptyList()
            }
            if (devices.isEmpty()) {
                log("自动恢复：电脑端没有设备")
                return@launch
            }
            val boundId = prefs.getString("bound_device_id", null)
            val target = devices.firstOrNull { it.id == boundId } ?: devices.first()
            val folder = folderName.ifBlank { target.name }
            if (mode == RestoreRunner.Mode.MERGE) {
                log("自动恢复：来源「${target.name}」，方式 合并")
            } else {
                log("自动恢复：来源「${target.name}」，方式 新建文件夹「$folder」")
            }
            runRestore(url, token, fingerprint, target.id, mode, folder)
        }
    }

    private fun log(line: String) {
        logText.append(line + "\n")
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
