import React, { useEffect, useMemo, useState } from 'react';
import {
  NativeEventEmitter,
  NativeModules,
  StatusBar,
  StyleSheet,
  Text,
  ToastAndroid,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

type UploadDetectedEvent = {
  size: number;
  timestamp: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  uid?: number;
  appName?: string;
  packageName?: string;
  deviceTotalDeltaBytes?: number;
};

type VpnStatus = 'ACTIVE' | 'STOPPED';

const { VpnModule } = NativeModules as {
  VpnModule: {
    startVpn: () => Promise<boolean>;
    stopVpn: () => Promise<boolean>;
    playTick: () => void;
    addListener: (eventType: string) => void;
    removeListeners: (count: number) => void;
  };
};

const BG = '#0B0F14';
const PANEL = '#111927';
const ACCENT = '#00FFC6';
const ALERT = '#FF3B3B';
const TEXT = '#E6EDF3';

function normalizeUploadEvent(evt: Partial<UploadDetectedEvent> | null | undefined): UploadDetectedEvent | null {
  if (!evt) return null;
  const size = Number(evt.size);
  const timestamp = Number(evt.timestamp);
  const severityRaw = `${evt.severity ?? ''}`.toUpperCase();
  const severity: UploadDetectedEvent['severity'] =
    severityRaw === 'HIGH' || severityRaw === 'MEDIUM' || severityRaw === 'LOW' ? severityRaw : 'LOW';

  if (!Number.isFinite(size) || !Number.isFinite(timestamp)) return null;
  return {
    size: Math.max(0, Math.floor(size)),
    timestamp,
    severity,
    uid: evt.uid != null ? Number(evt.uid) : undefined,
    appName: evt.appName ? String(evt.appName) : undefined,
    packageName: evt.packageName ? String(evt.packageName) : undefined,
    deviceTotalDeltaBytes: evt.deviceTotalDeltaBytes != null ? Number(evt.deviceTotalDeltaBytes) : undefined,
  };
}

function Dashboard() {
  const insets = useSafeAreaInsets();
  const eventEmitter = useMemo(() => new NativeEventEmitter(VpnModule), []);

  const [vpnStatus, setVpnStatus] = useState<VpnStatus>('STOPPED');
  const [alertCount, setAlertCount] = useState(0);
  const [feed, setFeed] = useState<UploadDetectedEvent[]>([]);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const pulse = useSharedValue(0);
  const blink = useSharedValue(0);
  const intensity = useSharedValue(0.15);

  useEffect(() => {
    const subUpload = eventEmitter.addListener('UPLOAD_DETECTED', (evt: UploadDetectedEvent) => {
      try {
        const normalized = normalizeUploadEvent(evt);
        if (!normalized) return;

        setLastEventAt(Date.now());
        setAlertCount(c => c + 1);
        setFeed(prev => [normalized, ...prev].slice(0, 60));

        ToastAndroid.show('UPLOAD TRAFFIC DETECTED', ToastAndroid.SHORT);
        try {
          Vibration.vibrate(40);
        } catch {}
        try {
          VpnModule.playTick();
        } catch {}

        pulse.value = 0;
        pulse.value = withSequence(
          withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 520, easing: Easing.out(Easing.quad) }),
        );

        intensity.value = withTiming(1, { duration: 120 });
        intensity.value = withTiming(0.15, { duration: 1600, easing: Easing.out(Easing.cubic) });
      } catch {}
    });

    const subStatus = eventEmitter.addListener('VPN_STATUS', (s: VpnStatus) => {
      setVpnStatus(s);
      if (s === 'ACTIVE') {
        cancelAnimation(blink);
        blink.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, true);
      } else {
        cancelAnimation(blink);
        blink.value = 0;
      }
    });

    return () => {
      subUpload.remove();
      subStatus.remove();
    };
  }, [eventEmitter, blink, intensity, pulse]);

  const alertCardStyle = useAnimatedStyle(() => {
    const glow = interpolate(pulse.value, [0, 1], [0, 18]);
    const border = interpolateColor(pulse.value, [0, 1], ['rgba(0,255,198,0.18)', 'rgba(255,59,59,0.95)']);
    return {
      shadowOpacity: 0.65,
      shadowRadius: glow,
      borderColor: border,
    };
  });

  const vpnDotStyle = useAnimatedStyle(() => {
    const alpha = interpolate(blink.value, [0, 1], [0.45, 1]);
    const color = vpnStatus === 'ACTIVE' ? `rgba(0,255,198,${alpha})` : `rgba(255,59,59,${alpha})`;
    return { backgroundColor: color };
  });

  const intensityBarStyle = useAnimatedStyle(() => {
    return {
      width: interpolate(intensity.value, [0.15, 1], [36, 220]),
      backgroundColor: interpolateColor(intensity.value, [0.15, 1], ['rgba(0,255,198,0.35)', 'rgba(0,255,198,0.95)']),
    };
  });

  async function onStart() {
    try {
      await VpnModule.startVpn();
    } catch (e: any) {
      if (e?.code === 'USAGE_STATS_REQUIRED') {
        ToastAndroid.show('Enable Usage Access, then tap Start VPN again.', ToastAndroid.LONG);
      } else {
        ToastAndroid.show('VPN start failed (permission denied?)', ToastAndroid.SHORT);
      }
    }
  }

  async function onStop() {
    try {
      await VpnModule.stopVpn();
    } catch {}
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />

      <View style={styles.headerRow}>
        <View>
          <Text style={styles.title}>Data Sentry</Text>
          <Text style={styles.subTitle}>VPN-based packet telemetry | anomaly feed | live dashboard</Text>
        </View>

        <View style={styles.vpnPill}>
          <Animated.View style={[styles.vpnDot, vpnDotStyle]} />
          <Text style={[styles.vpnText, { color: vpnStatus === 'ACTIVE' ? ACCENT : ALERT }]}>{vpnStatus}</Text>
        </View>
      </View>

      <View style={styles.grid}>
        <Animated.View style={[styles.card, styles.cardWide, alertCardStyle]}>
          <LinearGradient
            colors={['rgba(0,255,198,0.12)', 'rgba(17,25,39,0.95)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cardInner}
          >
            <Text style={styles.cardLabel}>Upload Alerts</Text>
            <View style={styles.alertRow}>
              <Text style={styles.alertCount}>{alertCount}</Text>
              <View style={styles.alertMeta}>
                <Text style={styles.alertHint}>Pulses on detection</Text>
                <Text style={styles.alertHint2}>Last: {feed[0] ? `${feed[0].severity} | ${feed[0].size}B` : '--'}</Text>
              </View>
            </View>
          </LinearGradient>
        </Animated.View>

        <View style={[styles.card, styles.cardWide]}>
          <LinearGradient
            colors={['rgba(0,255,198,0.08)', 'rgba(17,25,39,0.98)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cardInner}
          >
            <Text style={styles.cardLabel}>Traffic Intensity</Text>
            <View style={styles.intensityTrack}>
              <Animated.View style={[styles.intensityFill, intensityBarStyle]} />
            </View>
            <Text style={styles.mono}>
              {vpnStatus === 'ACTIVE' ? `Live window | spike rule: >1200B + frequency in 2s` : 'Start VPN to begin telemetry'}
            </Text>
          </LinearGradient>
        </View>

        <View style={[styles.card, styles.cardWide]}>
          <LinearGradient
            colors={['rgba(255,59,59,0.06)', 'rgba(17,25,39,0.98)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cardInner}
          >
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardLabel}>Threat Feed</Text>
              <Text style={styles.monoDim}>{feed.length ? `${feed.length} events` : 'idle'}</Text>
            </View>

            <View style={styles.feedBox}>
              {feed.length === 0 ? (
                <Text style={styles.feedEmpty}>No anomalies yet. Generate traffic and watch spikes.</Text>
              ) : (
                feed.slice(0, 12).map((e, idx) => (
                  <View key={`${e.timestamp}-${idx}`} style={styles.feedRow}>
                    <Text style={[styles.mono, styles.feedTime]}>{new Date(e.timestamp).toLocaleTimeString()}</Text>
                    <Text
                      style={[
                        styles.mono,
                        styles.feedMsg,
                        { color: e.severity === 'HIGH' ? ALERT : e.severity === 'MEDIUM' ? '#FFB020' : ACCENT },
                      ]}
                      numberOfLines={1}
                    >
                      {`UPLOAD_DETECTED | ${e.appName ?? e.packageName ?? 'unknown-app'} | size=${e.size}B | severity=${e.severity}`}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </LinearGradient>
        </View>

        <View style={styles.actionsRow}>
          <TouchableOpacity
            onPress={onStart}
            activeOpacity={0.85}
            style={[styles.actionBtn, { borderColor: 'rgba(0,255,198,0.45)' }]}
          >
            <Text style={[styles.actionText, { color: ACCENT }]}>Start VPN</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onStop}
            activeOpacity={0.85}
            style={[styles.actionBtn, { borderColor: 'rgba(255,59,59,0.45)' }]}
          >
            <Text style={[styles.actionText, { color: ALERT }]}>Stop VPN</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.footerMono}>
        {vpnStatus === 'ACTIVE' ? 'Capturing packets from VPN TUN interface' : 'VPN stopped'}
        {'  '}|{'  '}
        {lastEventAt ? `last event ${Math.round((Date.now() - lastEventAt) / 1000)}s ago` : 'no events'}
      </Text>
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: BG }}>
      <SafeAreaProvider>
        <Dashboard />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: BG,
    paddingHorizontal: 14,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    gap: 12,
  },
  title: {
    color: TEXT,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  subTitle: {
    color: 'rgba(230,237,243,0.72)',
    marginTop: 3,
    fontSize: 12,
  },
  vpnPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(17,25,39,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,198,0.14)',
  },
  vpnDot: {
    width: 8,
    height: 8,
    borderRadius: 8,
  },
  vpnText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  grid: {
    flex: 1,
    gap: 12,
  },
  card: {
    backgroundColor: PANEL,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(0,255,198,0.12)',
    shadowColor: ACCENT,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 2,
    overflow: 'hidden',
  },
  cardWide: {
    width: '100%',
  },
  cardInner: {
    padding: 14,
  },
  cardLabel: {
    color: 'rgba(230,237,243,0.85)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  alertCount: {
    color: TEXT,
    fontSize: 46,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  alertMeta: {
    alignItems: 'flex-end',
  },
  alertHint: {
    color: 'rgba(230,237,243,0.62)',
    fontSize: 12,
    marginBottom: 4,
  },
  alertHint2: {
    color: 'rgba(230,237,243,0.80)',
    fontSize: 12,
    fontWeight: '700',
  },
  intensityTrack: {
    width: '100%',
    height: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(0,255,198,0.12)',
    overflow: 'hidden',
  },
  intensityFill: {
    height: 10,
    borderRadius: 999,
  },
  mono: {
    color: 'rgba(230,237,243,0.78)',
    fontSize: 12,
    marginTop: 10,
    fontFamily: 'monospace',
  },
  monoDim: {
    color: 'rgba(230,237,243,0.55)',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  feedBox: {
    marginTop: 4,
    padding: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(11,15,20,0.65)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,198,0.10)',
    gap: 6,
  },
  feedEmpty: {
    color: 'rgba(230,237,243,0.55)',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  feedRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  feedTime: {
    color: 'rgba(230,237,243,0.50)',
    width: 96,
  },
  feedMsg: {
    flex: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(17,25,39,0.85)',
    borderWidth: 1,
    alignItems: 'center',
  },
  actionText: {
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  footerMono: {
    marginTop: 10,
    color: 'rgba(230,237,243,0.45)',
    fontSize: 11,
    fontFamily: 'monospace',
  },
});
