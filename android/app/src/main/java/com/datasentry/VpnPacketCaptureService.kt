package com.datasentry

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.app.usage.NetworkStats
import android.app.usage.NetworkStatsManager
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.TrafficStats
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
import android.util.Log
import com.facebook.react.bridge.Arguments
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class VpnPacketCaptureService : VpnService() {
  private var tunInterface: ParcelFileDescriptor? = null
  private val running = AtomicBoolean(false)
  private var monitorThread: Thread? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopCapture()
        stopSelf()
        return START_NOT_STICKY
      }
      else -> {
        startCapture()
        return START_STICKY
      }
    }
  }

  override fun onDestroy() {
    stopCapture()
    super.onDestroy()
  }

  private fun startCapture() {
    if (running.getAndSet(true)) return

    updateVpnStatus("STARTING")

    try {
      val builder =
        Builder()
          .setSession("datasentry")
          .setMtu(1500)
          .addAddress("10.0.0.2", 32)
          // Do not claim the device default route in this simulator.
          // A full-tunnel route without forwarding/NAT breaks other apps' internet.
          .addRoute("10.0.0.0", 24)
          .allowBypass()

      // This simulator does not forward packets; route only this app's traffic so other apps
      // keep normal connectivity (WhatsApp/browser/etc).
      builder.addAllowedApplication(packageName)

      tunInterface = builder.establish()
      val pfd = tunInterface
      if (pfd == null) {
        Log.e(TAG, "Failed to establish VPN interface")
        running.set(false)
        updateVpnStatus("STOPPED")
        stopSelf()
        return
      }
      updateVpnStatus("ACTIVE")

      monitorThread =
        Thread({
          try {
            val networkStatsManager =
              getSystemService(NETWORK_STATS_SERVICE) as? NetworkStatsManager
            val packageManager = applicationContext.packageManager
            val appLabelCache = mutableMapOf<Int, Pair<String, String>>()
            val lastUidTotals = mutableMapOf<Int, Long>()
            var lastTotalTx = TrafficStats.getTotalTxBytes()

            while (running.get() && !Thread.currentThread().isInterrupted) {
              val now = System.currentTimeMillis()
              val currentTotalTx = TrafficStats.getTotalTxBytes()
              val totalDelta = safeDelta(lastTotalTx, currentTotalTx)
              lastTotalTx = currentTotalTx

              val uidTxSnapshot = collectUidTxSnapshot(networkStatsManager, now - SNAPSHOT_WINDOW_MS, now)
              val uidDeltas =
                uidTxSnapshot.mapNotNull { (uid, currentBytes) ->
                  val prevBytes = lastUidTotals[uid]
                  lastUidTotals[uid] = currentBytes
                  if (prevBytes == null) return@mapNotNull null
                  val delta = safeDelta(prevBytes, currentBytes)
                  if (delta <= 0L || uid == applicationInfo.uid) return@mapNotNull null
                  uid to delta
                }.sortedByDescending { it.second }

              val significant = uidDeltas.firstOrNull { it.second >= APP_ALERT_THRESHOLD_BYTES }
              if (significant != null || totalDelta >= DEVICE_ALERT_THRESHOLD_BYTES) {
                val (uid, appBytes) = significant ?: (uidDeltas.firstOrNull() ?: (Process.SYSTEM_UID to totalDelta))
                val severity = severityForBytes(appBytes)
                val (pkgName, label) = resolveAppForUid(packageManager, uid, appLabelCache)
                showUploadNotification(label, pkgName, appBytes, severity, now)

                val payload = Arguments.createMap().apply {
                  putInt("size", appBytes.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
                  putDouble("timestamp", now.toDouble())
                  putString("severity", severity)
                  putInt("uid", uid)
                  putDouble("deviceTotalDeltaBytes", totalDelta.toDouble())
                  putString("packageName", pkgName)
                  putString("appName", label)
                }
                EventBridge.emit(EventBridge.EVENT_UPLOAD_DETECTED, payload)
              }

              Thread.sleep(POLL_INTERVAL_MS)
            }
          } catch (t: Throwable) {
            Log.e(TAG, "Unhandled monitor thread failure", t)
          } finally {
            if (running.getAndSet(false)) {
              try {
                tunInterface?.close()
              } catch (_: Throwable) {}
              tunInterface = null
              updateVpnStatus("STOPPED")
              stopSelf()
            }
          }
        }, "datasentry-UploadMonitor")
          .apply { isDaemon = true }

      monitorThread?.start()
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to start VPN capture", t)
      running.set(false)
      try {
        tunInterface?.close()
      } catch (_: Throwable) {}
      tunInterface = null
      updateVpnStatus("STOPPED")
      stopSelf()
    }
  }

  private fun stopCapture() {
    if (!running.getAndSet(false)) return

    try {
      tunInterface?.close()
      tunInterface = null
    } catch (_: Throwable) {}

    try {
      monitorThread?.interrupt()
      monitorThread = null
    } catch (_: Throwable) {}

    updateVpnStatus("STOPPED")
  }

  override fun onRevoke() {
    stopCapture()
    stopSelf()
    super.onRevoke()
  }

  companion object {
    private const val TAG = "datasentryVPN"
    private const val POLL_INTERVAL_MS = 1500L
    private const val SNAPSHOT_WINDOW_MS = 15_000L
    private const val APP_ALERT_THRESHOLD_BYTES = 120_000L
    private const val DEVICE_ALERT_THRESHOLD_BYTES = 300_000L
    private const val ALERT_CHANNEL_ID = "datasentry_upload_alerts_v1"
    private const val ALERT_NOTIFICATION_TIMEOUT_MS = 15_000L
    const val ACTION_STOP = "com.datasentry.VPN_STOP"
    private val vpnStatus = AtomicReference("STOPPED")

    fun getVpnStatus(): String = vpnStatus.get()
  }

  private fun updateVpnStatus(status: String) {
    vpnStatus.set(status)
    EventBridge.emit(EventBridge.EVENT_VPN_STATUS, status)
  }

  private fun showUploadNotification(
    appName: String,
    packageName: String,
    bytes: Long,
    severity: String,
    timestamp: Long,
  ) {
    try {
      val notificationManager = getSystemService(NotificationManager::class.java) ?: return

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel =
          NotificationChannel(
            ALERT_CHANNEL_ID,
            "Upload alerts",
            NotificationManager.IMPORTANCE_HIGH,
          ).apply {
            description = "Alerts when DataSentry detects upload traffic."
            setSound(null, null)
            enableVibration(false)
          }
        notificationManager.createNotificationChannel(channel)
      }

      if (
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
      ) {
        Log.w(TAG, "Notification permission is not granted; skipping upload alert notification")
        return
      }
      if (!notificationManager.areNotificationsEnabled()) {
        Log.w(TAG, "Notifications are disabled for this app; skipping upload alert notification")
        return
      }

      val notificationId = (timestamp % Int.MAX_VALUE).toInt()
      val source = appName.ifBlank { packageName.ifBlank { "Unknown source" } }
      val detailText = "$source | ${bytes}B | $severity"
      val contentIntent =
        PendingIntent.getActivity(
          this,
          notificationId,
          Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
          },
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

      val builder =
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Notification.Builder(this, ALERT_CHANNEL_ID)
        } else {
          Notification.Builder(this)
        })
          .setSmallIcon(R.drawable.ic_stat_datasentry)
          .setContentTitle("Upload traffic detected")
          .setContentText(detailText)
          .setStyle(Notification.BigTextStyle().bigText(detailText))
          .setContentIntent(contentIntent)
          .setCategory(Notification.CATEGORY_EVENT)
          .setVisibility(Notification.VISIBILITY_PRIVATE)
          .setWhen(timestamp)
          .setShowWhen(true)
          .setAutoCancel(true)
          .setOnlyAlertOnce(false)

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        builder.setPriority(Notification.PRIORITY_HIGH)
      } else {
        builder.setTimeoutAfter(ALERT_NOTIFICATION_TIMEOUT_MS)
      }

      notificationManager.notify(notificationId, builder.build())
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to post upload alert notification", t)
    }
  }

  private fun safeDelta(previous: Long, current: Long): Long {
    if (previous < 0 || current < 0) return 0L
    if (current < previous) return 0L
    return current - previous
  }

  private fun severityForBytes(bytes: Long): String {
    return when {
      bytes >= 1_000_000L -> "HIGH"
      bytes >= 300_000L -> "MEDIUM"
      else -> "LOW"
    }
  }

  private fun collectUidTxSnapshot(
    networkStatsManager: NetworkStatsManager?,
    startTime: Long,
    endTime: Long,
  ): Map<Int, Long> {
    if (networkStatsManager == null) return emptyMap()
    val byUid = mutableMapOf<Int, Long>()
    collectForType(networkStatsManager, ConnectivityManager.TYPE_WIFI, startTime, endTime, byUid)
    collectForType(networkStatsManager, ConnectivityManager.TYPE_MOBILE, startTime, endTime, byUid)
    return byUid
  }

  private fun collectForType(
    networkStatsManager: NetworkStatsManager,
    networkType: Int,
    startTime: Long,
    endTime: Long,
    sink: MutableMap<Int, Long>,
  ) {
    var stats: NetworkStats? = null
    try {
      stats = networkStatsManager.querySummary(networkType, null, startTime, endTime)
      val bucket = NetworkStats.Bucket()
      while (stats.hasNextBucket()) {
        stats.getNextBucket(bucket)
        val uid = bucket.uid
        if (uid < 0) continue
        val updated = (sink[uid] ?: 0L) + bucket.txBytes
        sink[uid] = updated
      }
    } catch (se: SecurityException) {
      Log.e(TAG, "Usage access permission required for NetworkStatsManager", se)
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to query network stats for type=$networkType", t)
    } finally {
      try {
        stats?.close()
      } catch (_: Throwable) {}
    }
  }

  private fun resolveAppForUid(
    packageManager: PackageManager,
    uid: Int,
    cache: MutableMap<Int, Pair<String, String>>,
  ): Pair<String, String> {
    val cached = cache[uid]
    if (cached != null) return cached

    val packageName = packageManager.getNameForUid(uid) ?: "uid:$uid"
    val label =
      try {
        val appInfo = packageManager.getApplicationInfo(packageName, 0)
        packageManager.getApplicationLabel(appInfo).toString()
      } catch (_: Throwable) {
        packageName
      }
    val resolved = packageName to label
    cache[uid] = resolved
    return resolved
  }
}
