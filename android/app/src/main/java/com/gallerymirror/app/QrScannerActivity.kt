package com.gallerymirror.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.ImageFormat
import android.hardware.Camera
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import java.util.EnumMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 轻量二维码扫描页，只依赖 Android 旧 Camera API 和 ZXing core，保持 minSdk 26 可用。
 * 扫描页只把二维码文本交回主界面，不保存照片、不上传相机画面。
 */
@Suppress("DEPRECATION")
class QrScannerActivity : Activity(), SurfaceHolder.Callback, Camera.PreviewCallback {

    private lateinit var surface: PreviewSurfaceView
    private lateinit var instruction: TextView
    private var camera: Camera? = null
    private var previewSize: Camera.Size? = null
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val decoding = AtomicBoolean(false)
    private var finished = false
    @Volatile private var shuttingDown = false

    private val hints = EnumMap<DecodeHintType, Any>(DecodeHintType::class.java).apply {
        put(DecodeHintType.POSSIBLE_FORMATS, listOf(BarcodeFormat.QR_CODE))
        put(DecodeHintType.TRY_HARDER, true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surface = PreviewSurfaceView(this)
        root.addView(surface, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        instruction = TextView(this).apply {
                text = "正在启动相机…"
                setTextColor(Color.WHITE)
                textSize = 16f
                gravity = Gravity.CENTER
                setShadowLayer(4f, 0f, 2f, Color.BLACK)
                setPadding(24, 32, 24, 32)
        }
        root.addView(
            instruction,
            FrameLayout.LayoutParams(-1, -2, Gravity.TOP)
        )
        setContentView(root)
        // 旧 Camera API 在部分 ROM 上只有设置 PUSH_BUFFERS 后才会把预览帧送到 SurfaceView。
        @Suppress("DEPRECATION")
        surface.holder.setType(SurfaceHolder.SURFACE_TYPE_PUSH_BUFFERS)
        surface.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_UP) focusForScan()
            true
        }
        surface.holder.addCallback(this)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
            setResult(RESULT_CANCELED)
            finish()
        } else if (::surface.isInitialized) {
            // 权限返回后 Surface 可能已经创建过，主动补一次启动，避免黑屏/空白页。
            surface.post { if (!finished && camera == null) startCamera(surface.holder) }
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        startCamera(holder)
    }

    private fun startCamera(holder: SurfaceHolder) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return
        shuttingDown = false
        try {
            val opened = Camera.open()
            camera = opened
            opened.setPreviewDisplay(holder)
            opened.setDisplayOrientation(displayOrientation())
            val params = opened.parameters
            params.previewFormat = ImageFormat.NV21
            val supportedSizes = params.supportedPreviewSizes.orEmpty()
            val selected = supportedSizes
                // 640x480 在手机上看起来够用，但电脑二维码包含地址、指纹和配对码，
                // 模块很密时取景框里的有效像素不够；优先选接近 1280x720 的预览。
                .filter { it.width >= 960 && it.height >= 720 }
                .minByOrNull { abs(it.width * it.height - 1280 * 720) }
                ?: supportedSizes
                    .filter { it.width >= 640 && it.height >= 480 }
                    .minByOrNull { it.width * it.height }
                ?: supportedSizes.firstOrNull()
            if (selected != null) {
                params.setPreviewSize(selected.width, selected.height)
                previewSize = selected
            }
            // 旧 Camera API 在部分国产 ROM 上不会自动连续对焦；优先使用连续拍照，
            // 否则二维码需要用户反复点屏幕才能清晰，扫描页看起来像没有反应。
            val focusModes = params.supportedFocusModes.orEmpty()
            val focusMode = when {
                focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE) ->
                    Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
                focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO) ->
                    Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO
                focusModes.contains(Camera.Parameters.FOCUS_MODE_AUTO) -> Camera.Parameters.FOCUS_MODE_AUTO
                else -> null
            }
            if (focusMode != null) params.focusMode = focusMode
            opened.parameters = params
            val size = opened.parameters.previewSize ?: previewSize
            if (size != null) {
                previewSize = size
                // 相机回调通常是横向 4:3，而扫描页是竖屏；保持预览比例，避免二维码被
                // 拉伸后肉眼看着变形、取景框和实际解码区域不一致。
                val rotated = displayOrientation() % 180 != 0
                surface.setPreviewAspect(if (rotated) size.height else size.width, if (rotated) size.width else size.height)
                // 固定 Surface buffer 尺寸，避免部分厂商把回调尺寸和显示 Surface 解耦后输出黑帧。
                holder.setFixedSize(size.width, size.height)
                // NV21 4:2:0 需要约 1.5 倍宽高的回调缓冲区；准备两个，避免部分 ROM 复用首帧时崩溃。
                val bufferSize = size.width * size.height * 3 / 2 + 1
                repeat(2) { opened.addCallbackBuffer(ByteArray(bufferSize)) }
                opened.setPreviewCallbackWithBuffer(this)
            }
            opened.startPreview()
            instruction.text = "将电脑端二维码放入取景框\n保持稳定；无法识别时点按二维码对焦"
            if (focusMode == Camera.Parameters.FOCUS_MODE_AUTO) {
                // AUTO 模式不会自行触发对焦；部分旧设备没有连续对焦模式，必须主动对焦一次。
                runCatching { opened.autoFocus { _, _ -> } }
            }
        } catch (error: Exception) {
            Log.e(TAG, "启动相机预览失败", error)
            runOnUiThread { instruction.text = "相机预览启动失败，请返回后重试\n${error.message.orEmpty()}" }
            releaseCamera()
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        releaseCamera()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

    override fun onPreviewFrame(data: ByteArray?, source: Camera?) {
        val size = previewSize ?: return
        val frame = data ?: return
        if (finished || shuttingDown) return
        if (!decoding.compareAndSet(false, true)) {
            requeue(source, frame)
            return
        }
        try {
            executor.execute {
                val text = runCatching { decode(frame, size.width, size.height) }.getOrNull()
                decoding.set(false)
                if (text != null && !finished) {
                    runOnUiThread { finishWith(text) }
                } else {
                    requeue(source, frame)
                }
            }
        } catch (_: Exception) {
            decoding.set(false)
            requeue(source, frame)
        }
    }

    private fun requeue(source: Camera?, frame: ByteArray) {
        if (finished || shuttingDown) return
        runCatching { source?.addCallbackBuffer(frame) }
    }

    /** 部分旧版/国产 Camera HAL 的连续对焦不会在屏幕取景后重新触发，点按时强制对焦一次。 */
    private fun focusForScan() {
        val opened = camera ?: return
        runCatching {
            val params = opened.parameters
            if (params.supportedFocusModes?.contains(Camera.Parameters.FOCUS_MODE_AUTO) == true) {
                params.focusMode = Camera.Parameters.FOCUS_MODE_AUTO
                opened.parameters = params
                opened.autoFocus { _, _ ->
                    runCatching {
                        val next = opened.parameters
                        if (next.supportedFocusModes?.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE) == true) {
                            next.focusMode = Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
                            opened.parameters = next
                        }
                    }
                }
            }
        }
    }

    private fun decode(bytes: ByteArray, width: Int, height: Int): String? {
        val source = PlanarYUVLuminanceSource(bytes, width, height, 0, 0, width, height, false)
        val rotated90 = source.rotateCounterClockwise()
        val variants = listOf(
            source,
            rotated90,
            rotated90.rotateCounterClockwise(),
            rotated90.rotateCounterClockwise().rotateCounterClockwise()
        )

        // 电脑端二维码通常位于画面中央；先尝试中心区域可以降低背景文字、反光和边缘噪声的影响。
        val cropped = variants.mapNotNull { variant ->
            if (variant.width < 640 || variant.height < 480) null
            else variant.crop(variant.width / 10, variant.height / 10, variant.width * 4 / 5, variant.height * 4 / 5)
        }
        for (variant in variants) {
            decodeWith(variant, useGlobal = false)?.let { return it }
        }
        for (variant in cropped) {
            decodeWith(variant, useGlobal = false)?.let { return it }
        }
        // 光线不均时 HybridBinarizer 可能整帧失败，最后用全局直方图再试一次。
        for (variant in variants + cropped) {
            decodeWith(variant, useGlobal = true)?.let { return it }
        }
        return null
    }

    private fun decodeWith(source: LuminanceSource, useGlobal: Boolean): String? = runCatching {
        val binarizer = if (useGlobal) GlobalHistogramBinarizer(source) else HybridBinarizer(source)
        MultiFormatReader().run { setHints(hints); decodeWithState(BinaryBitmap(binarizer)).text }
    }.getOrNull()

    private fun finishWith(value: String) {
        if (finished) return
        finished = true
        setResult(RESULT_OK, Intent().setData(Uri.parse(value.trim())))
        finish()
    }

    private fun releaseCamera() {
        shuttingDown = true
        val current = camera
        camera = null
        if (current != null) {
            runCatching { current.setPreviewCallbackWithBuffer(null) }
            runCatching { current.stopPreview() }
            runCatching { current.release() }
        }
    }

    override fun onPause() {
        releaseCamera()
        super.onPause()
    }

    override fun onDestroy() {
        releaseCamera()
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun displayOrientation(): Int {
        val info = Camera.CameraInfo().also { Camera.getCameraInfo(Camera.CameraInfo.CAMERA_FACING_BACK, it) }
        val rotation = when (windowManager.defaultDisplay.rotation) {
            android.view.Surface.ROTATION_90 -> 90
            android.view.Surface.ROTATION_180 -> 180
            android.view.Surface.ROTATION_270 -> 270
            else -> 0
        }
        return (info.orientation - rotation + 360) % 360
    }

    /** SurfaceView 默认会把相机帧硬拉满屏，部分手机因此把二维码拉变形。 */
    private class PreviewSurfaceView(context: Context) : SurfaceView(context) {
        private var aspectWidth = 0
        private var aspectHeight = 0

        fun setPreviewAspect(width: Int, height: Int) {
            aspectWidth = width
            aspectHeight = height
            requestLayout()
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val maxWidth = MeasureSpec.getSize(widthMeasureSpec)
            val maxHeight = MeasureSpec.getSize(heightMeasureSpec)
            if (aspectWidth <= 0 || aspectHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) {
                super.onMeasure(widthMeasureSpec, heightMeasureSpec)
                return
            }
            val ratio = aspectWidth.toFloat() / aspectHeight.toFloat()
            var width = maxWidth
            var height = (width / ratio).roundToInt()
            if (height > maxHeight) {
                height = maxHeight
                width = (height * ratio).roundToInt()
            }
            setMeasuredDimension(width.coerceAtLeast(1), height.coerceAtLeast(1))
        }
    }

    companion object {
        const val REQUEST_CAMERA = 1007
        private const val TAG = "NekoSparkQrScanner"
    }
}
