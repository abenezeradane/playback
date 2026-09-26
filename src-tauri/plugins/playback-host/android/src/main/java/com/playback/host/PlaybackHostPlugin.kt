package com.playback.host

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.Settings
import android.view.View
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Playback's Android host (android-001): the one place Android-native code
 * lives. The Rust side calls these by name through run_mobile_plugin; nothing
 * here is reachable from the WebView.
 */
@TauriPlugin
class PlaybackHostPlugin(private val activity: Activity) : Plugin(activity) {

    /** styles.css `--canvas`: shown behind the system bars. */
    private val canvas = 0xFF07080A.toInt()

    override fun load(webView: WebView) {
        // An opened video autoplays, as on desktop. The WebView default would
        // demand a second tap, because the play() call lands after async work
        // that has lost the tap's gesture.
        webView.settings.mediaPlaybackRequiresUserGesture = false

        // Keep web content out from under the status bar, cutout and gesture
        // bar. The activity draws edge-to-edge, and the WebView's CSS
        // env(safe-area-inset-*) does not reliably report system bars, so the
        // WebView's container is padded natively instead. Edge-to-edge also
        // means the window no longer shrinks for the soft keyboard, so the
        // bottom padding follows the keyboard while it is up: a focused text
        // field (a tag, a playlist name, a chapter) stays above it.
        val container = (webView.parent as? View) ?: webView
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        container.setBackgroundColor(canvas)
        activity.window.decorView.setBackgroundColor(canvas)
        // The app is always dark, so the system bar icons are always light.
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        ViewCompat.requestApplyInsets(container)
    }

    @Command
    fun storageAccess(invoke: Invoke) {
        val ret = JSObject()
        ret.put("granted", Environment.isExternalStorageManager())
        invoke.resolve(ret)
    }

    @Command
    fun requestStorageAccess(invoke: Invoke) {
        if (Environment.isExternalStorageManager()) {
            val ret = JSObject()
            ret.put("granted", true)
            invoke.resolve(ret)
            return
        }
        val intent = Intent(
            Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.parse("package:${activity.packageName}")
        )
        startActivityForResult(invoke, intent, "storageAccessResult")
    }

    /** Runs when the user comes back from Settings: report what they chose. */
    @ActivityCallback
    fun storageAccessResult(invoke: Invoke, result: ActivityResult) {
        val ret = JSObject()
        ret.put("granted", Environment.isExternalStorageManager())
        invoke.resolve(ret)
    }

    @Command
    fun storageVolumes(invoke: Invoke) {
        val manager = activity.getSystemService(StorageManager::class.java)
        val volumes = JSArray()
        for (volume in manager.storageVolumes) {
            if (volume.state != Environment.MEDIA_MOUNTED) continue
            val dir = volume.directory ?: continue
            val entry = JSObject()
            entry.put("label", volume.getDescription(activity))
            entry.put("path", dir.absolutePath)
            entry.put("removable", volume.isRemovable)
            volumes.put(entry)
        }
        val ret = JSObject()
        ret.put("volumes", volumes)
        invoke.resolve(ret)
    }

    @Command
    fun moveToBackground(invoke: Invoke) {
        activity.moveTaskToBack(true)
        invoke.resolve()
    }
}
