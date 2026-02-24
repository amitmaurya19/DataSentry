package com.datasentry

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference

object EventBridge {
  const val EVENT_UPLOAD_DETECTED = "UPLOAD_DETECTED"
  const val EVENT_VPN_STATUS = "VPN_STATUS"

  private val reactContextRef = AtomicReference<ReactApplicationContext?>(null)
  private val pendingEvents = ConcurrentLinkedQueue<Pair<String, Any?>>()

  fun setReactContext(ctx: ReactApplicationContext) {
    reactContextRef.set(ctx)
    flushPending()
  }

  fun clearReactContext() {
    reactContextRef.set(null)
  }

  fun emit(eventName: String, payload: Any?) {
    val ctx = reactContextRef.get()
    if (ctx == null || !ctx.hasActiveReactInstance()) {
      pendingEvents.add(eventName to payload)
      return
    }
    emitOnUiThread(ctx, eventName, payload)
  }

  private fun flushPending() {
    val ctx = reactContextRef.get() ?: return
    if (!ctx.hasActiveReactInstance()) return
    while (true) {
      val evt = pendingEvents.poll() ?: break
      emitOnUiThread(ctx, evt.first, evt.second)
    }
  }

  private fun emitOnUiThread(ctx: ReactApplicationContext, eventName: String, payload: Any?) {
    UiThreadUtil.runOnUiThread {
      try {
        if (!ctx.hasActiveReactInstance()) {
          pendingEvents.add(eventName to payload)
          return@runOnUiThread
        }
        ctx
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(eventName, payload)
      } catch (_: Throwable) {
        pendingEvents.add(eventName to payload)
      }
    }
  }
}
