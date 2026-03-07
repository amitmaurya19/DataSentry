package com.datasentry

import android.app.Activity
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.VpnService
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = VpnModule.NAME)
class VpnModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
  private val ctx: ReactApplicationContext = reactApplicationContext
  private var pendingStartPromise: Promise? = null
  private val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70)

  init {
    ctx.addActivityEventListener(this)
    EventBridge.setReactContext(ctx)
  }

  override fun invalidate() {
    super.invalidate()
    EventBridge.clearReactContext()
    try {
      tone.release()
    } catch (_: Throwable) {}
  }

  override fun getName(): String = NAME

  /**
   * Required by React Native's NativeEventEmitter contract.
   * We manage listeners on the JS side; native side is push-based.
   */
  @ReactMethod
  fun addListener(eventName: String) = Unit

  /**
   * Required by React Native's NativeEventEmitter contract.
   */
  @ReactMethod
  fun removeListeners(count: Int) = Unit

  @ReactMethod
  fun startVpn(promise: Promise) {
    val activity = ctx.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "No foreground activity available to request VPN permission.")
      return
    }

    if (!hasUsageStatsAccess()) {
      try {
        activity.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
      } catch (_: Throwable) {}
      promise.reject("USAGE_STATS_REQUIRED", "Enable Usage Access for this app and try again.")
      return
    }

    val prepareIntent = VpnService.prepare(activity)
    if (prepareIntent != null) {
      if (pendingStartPromise != null) {
        pendingStartPromise?.reject("IN_PROGRESS", "VPN permission request already in progress.")
        pendingStartPromise = null
      }
      pendingStartPromise = promise
      activity.startActivityForResult(prepareIntent, REQ_VPN_PREPARE)
      return
    }

    // Permission already granted
    startServiceInternal()
    promise.resolve(true)
  }

  @ReactMethod
  fun stopVpn(promise: Promise) {
    val stopIntent = Intent(ctx, VpnPacketCaptureService::class.java).apply { action = VpnPacketCaptureService.ACTION_STOP }
    ctx.startService(stopIntent)
    promise.resolve(true)
  }

  @ReactMethod
  fun playTick() {
    // subtle audible tick
    try {
      tone.startTone(ToneGenerator.TONE_PROP_BEEP, 40)
    } catch (_: Throwable) {}
  }

  private fun startServiceInternal() {
    val startIntent = Intent(ctx, VpnPacketCaptureService::class.java)
    ctx.startService(startIntent)
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQ_VPN_PREPARE) return
    val p = pendingStartPromise
    pendingStartPromise = null
    if (p == null) return

    if (resultCode == Activity.RESULT_OK) {
      startServiceInternal()
      p.resolve(true)
    } else {
      p.reject("VPN_DENIED", "User denied VPN permission.")
    }
  }

  override fun onNewIntent(intent: Intent) = Unit

  private fun hasUsageStatsAccess(): Boolean {
    val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
    val mode =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), ctx.packageName)
      } else {
        @Suppress("DEPRECATION")
        appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), ctx.packageName)
      }
    return mode == AppOpsManager.MODE_ALLOWED
  }

  companion object {
    const val NAME = "VpnModule"
    private const val REQ_VPN_PREPARE = 42_042
  }
}
