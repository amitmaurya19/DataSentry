import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  ToastAndroid,
  TouchableOpacity,
  Vibration,
  View,
  useWindowDimensions,
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

type VpnStatus = 'ACTIVE' | 'STOPPED' | 'STARTING';
type VpnStatusTarget = 'ACTIVE' | 'STOPPED';

type VpnStatusWaiter = {
  target: VpnStatusTarget;
  sawStarting: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const { VpnModule } = NativeModules as {
  VpnModule: {
    startVpn: () => Promise<boolean>;
    stopVpn: () => Promise<boolean>;
    getVpnStatus: () => Promise<VpnStatus>;
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
  const { height: windowHeight } = useWindowDimensions();
  const eventEmitter = useMemo(() => new NativeEventEmitter(VpnModule), []);

  const [vpnStatus, setVpnStatus] = useState<VpnStatus | null>(null);
  const [vpnTransition, setVpnTransition] = useState<'STARTING' | 'STOPPING' | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  const [feed, setFeed] = useState<UploadDetectedEvent[]>([]);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const vpnStatusRef = React.useRef<VpnStatus | null>(null);
  const statusWaiterRef = React.useRef<VpnStatusWaiter | null>(null);
  const transitionInProgressRef = React.useRef(false);
  const lastStartFailureRef = React.useRef(false);
  const statusEventRevisionRef = React.useRef(0);

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

    const applyVpnStatus = (s: VpnStatus, fromEvent: boolean) => {
      const previousStatus = vpnStatusRef.current;
      if (s === 'STARTING') {
        lastStartFailureRef.current = false;
      } else if (previousStatus === 'STARTING' && s === 'STOPPED') {
        lastStartFailureRef.current = true;
      }

      if (fromEvent) statusEventRevisionRef.current += 1;
      vpnStatusRef.current = s;
      setVpnStatus(s);

      const waiter = statusWaiterRef.current;
      if (!waiter) return;
      if (s === 'STARTING' && waiter.target === 'ACTIVE') waiter.sawStarting = true;
      if (s === waiter.target) {
        clearTimeout(waiter.timeout);
        statusWaiterRef.current = null;
        waiter.resolve();
      } else if (s === 'STOPPED' && waiter.target === 'ACTIVE' && waiter.sawStarting) {
        clearTimeout(waiter.timeout);
        statusWaiterRef.current = null;
        waiter.reject(new Error('VPN service failed to establish the tunnel.'));
      }
    };

    const subStatus = eventEmitter.addListener('VPN_STATUS', (s: VpnStatus) => {
      if (s === 'ACTIVE' || s === 'STOPPED' || s === 'STARTING') applyVpnStatus(s, true);
    });

    const revisionBeforeRead = statusEventRevisionRef.current;
    VpnModule.getVpnStatus()
      .then(status => {
        if (
          revisionBeforeRead === statusEventRevisionRef.current &&
          (status === 'ACTIVE' || status === 'STOPPED' || status === 'STARTING')
        ) {
          applyVpnStatus(status, false);
        }
      })
      .catch(() => {
        // Leave status unknown and the toggle disabled if native status cannot be read.
      });

    return () => {
      subUpload.remove();
      subStatus.remove();
      const waiter = statusWaiterRef.current;
      if (waiter) {
        clearTimeout(waiter.timeout);
        statusWaiterRef.current = null;
        waiter.reject(new Error('Dashboard was unmounted while waiting for VPN status.'));
      }
    };
  }, [eventEmitter, intensity, pulse]);

  useEffect(() => {
    if (vpnStatus === 'ACTIVE') {
      cancelAnimation(blink);
      blink.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, true);
    } else {
      cancelAnimation(blink);
      blink.value = 0;
    }

    return () => cancelAnimation(blink);
  }, [blink, vpnStatus]);

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

  function waitForVpnStatus(target: VpnStatusTarget): Promise<void> {
    if (vpnStatusRef.current === target) return Promise.resolve();
    if (target === 'ACTIVE' && lastStartFailureRef.current) {
      return Promise.reject(new Error('VPN service failed to establish the tunnel.'));
    }

    return new Promise((resolve, reject) => {
      const waiter: VpnStatusWaiter = {
        target,
        sawStarting: vpnStatusRef.current === 'STARTING',
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (statusWaiterRef.current !== waiter) return;
          statusWaiterRef.current = null;
          reject(new Error(`Timed out waiting for VPN status ${target}.`));
        }, 15_000),
      };

      statusWaiterRef.current = waiter;
      if (vpnStatusRef.current === target) {
        clearTimeout(waiter.timeout);
        statusWaiterRef.current = null;
        resolve();
      } else if (target === 'ACTIVE' && lastStartFailureRef.current) {
        clearTimeout(waiter.timeout);
        statusWaiterRef.current = null;
        reject(new Error('VPN service failed to establish the tunnel.'));
      }
    });
  }

  async function onToggleVpn() {
    if (transitionInProgressRef.current) return;
    const currentStatus = vpnStatusRef.current;
    if (currentStatus !== 'ACTIVE' && currentStatus !== 'STOPPED') return;

    const starting = currentStatus === 'STOPPED';
    transitionInProgressRef.current = true;
    setVpnTransition(starting ? 'STARTING' : 'STOPPING');
    if (starting) lastStartFailureRef.current = false;

    try {
      if (starting) {
        if (Platform.OS === 'android' && Platform.Version >= 33) {
          try {
            const permission = await PermissionsAndroid.request(
              PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
              {
                title: 'Allow DataSentry alerts',
                message: 'Notifications let DataSentry show upload alerts while it is in the background.',
                buttonPositive: 'Allow',
                buttonNegative: 'Not now',
              },
            );
            if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
              ToastAndroid.show(
                'Allow DataSentry notifications in Android Settings to see alerts outside the app.',
                ToastAndroid.LONG,
              );
            }
          } catch {
            ToastAndroid.show(
              'Allow DataSentry notifications in Android Settings to see alerts outside the app.',
              ToastAndroid.LONG,
            );
          }
        }
        await VpnModule.startVpn();
        const statusRevision = statusEventRevisionRef.current;
        const nativeStatus = await VpnModule.getVpnStatus();
        if (statusRevision === statusEventRevisionRef.current) {
          vpnStatusRef.current = nativeStatus;
          setVpnStatus(nativeStatus);
        }
        await waitForVpnStatus('ACTIVE');
      } else {
        await VpnModule.stopVpn();
        const statusRevision = statusEventRevisionRef.current;
        const nativeStatus = await VpnModule.getVpnStatus();
        if (statusRevision === statusEventRevisionRef.current) {
          vpnStatusRef.current = nativeStatus;
          setVpnStatus(nativeStatus);
        }
        await waitForVpnStatus('STOPPED');
      }
    } catch (e: any) {
      if (starting && e?.code === 'USAGE_STATS_REQUIRED') {
        ToastAndroid.show('Enable Usage Access, then tap Start VPN again.', ToastAndroid.LONG);
      } else if (starting && e?.code === 'VPN_DENIED') {
        ToastAndroid.show('VPN permission was denied.', ToastAndroid.SHORT);
      } else {
        ToastAndroid.show(
          starting ? 'VPN failed to start. Check permissions and try again.' : 'VPN failed to stop. Try again.',
          ToastAndroid.SHORT,
        );
      }
    } finally {
      try {
        const statusRevision = statusEventRevisionRef.current;
        const nativeStatus = await VpnModule.getVpnStatus();
        if (statusRevision === statusEventRevisionRef.current) {
          vpnStatusRef.current = nativeStatus;
          setVpnStatus(nativeStatus);
        }
      } catch {}
      transitionInProgressRef.current = false;
      setVpnTransition(null);
    }
  }

  const isVpnBusy = vpnTransition !== null || vpnStatus === null || vpnStatus === 'STARTING';
  const isStopping = vpnStatus === 'ACTIVE' || vpnTransition === 'STOPPING';
  const actionColor = isStopping ? ALERT : ACCENT;
  const actionLabel =
    vpnTransition === 'STARTING' || vpnStatus === 'STARTING'
      ? 'Starting VPN'
      : vpnTransition === 'STOPPING'
        ? 'Stopping VPN'
        : vpnStatus === null
          ? 'Checking VPN'
          : vpnStatus === 'ACTIVE'
            ? 'Stop VPN'
            : 'Start VPN';
  const compactLayout = windowHeight < 700;
  const vpnStatusColor = vpnStatus === 'ACTIVE' ? ACCENT : vpnStatus === 'STARTING' ? '#FFB020' : ALERT;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />

      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Data Sentry</Text>
          <Text style={styles.subTitle}>VPN-based packet telemetry | anomaly feed | live dashboard</Text>
        </View>

        <View style={styles.vpnPill}>
          <Animated.View style={[styles.vpnDot, vpnDotStyle]} />
          <Text style={[styles.vpnText, { color: vpnStatusColor }]}>{vpnStatus ?? 'CHECKING'}</Text>
        </View>
      </View>

      <View style={[styles.grid, compactLayout && styles.compactGrid]}>
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

        <View style={[styles.card, styles.cardWide, styles.feedCard]}>
          <LinearGradient
            colors={['rgba(255,59,59,0.06)', 'rgba(17,25,39,0.98)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.cardInner, styles.feedCardInner]}
          >
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardLabel}>Threat Feed</Text>
              <Text style={styles.monoDim}>{feed.length ? `${feed.length} events` : 'idle'}</Text>
            </View>

            <View style={styles.feedBox}>
              {feed.length === 0 ? (
                <Text style={styles.feedEmpty}>No anomalies yet. Generate traffic and watch spikes.</Text>
              ) : (
                <FlatList
                  data={feed}
                  keyExtractor={(e, idx) => `${e.timestamp}-${idx}`}
                  showsVerticalScrollIndicator
                  style={styles.feedList}
                  contentContainerStyle={styles.feedListContent}
                  renderItem={({ item: e }) => (
                    <View style={styles.feedRow}>
                      <Text style={[styles.mono, styles.feedTime]}>{new Date(e.timestamp).toLocaleTimeString()}</Text>
                      <Text
                        style={[
                          styles.mono,
                          styles.feedMsg,
                          { color: e.severity === 'HIGH' ? ALERT : e.severity === 'MEDIUM' ? '#FFB020' : ACCENT },
                        ]}
                      >
                        {`UPLOAD_DETECTED | ${e.appName ?? e.packageName ?? 'unknown-app'} | size=${e.size}B | severity=${e.severity}`}
                      </Text>
                    </View>
                  )}
                />
              )}
            </View>
          </LinearGradient>
        </View>

        <View style={styles.actionsRow}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: isVpnBusy, busy: isVpnBusy }}
            accessibilityLabel={actionLabel}
            disabled={isVpnBusy}
            onPress={onToggleVpn}
            activeOpacity={0.85}
            style={[styles.actionBtn, isStopping ? styles.actionBtnStop : styles.actionBtnStart]}
          >
            {isVpnBusy ? (
              <ActivityIndicator color={actionColor} size="small" />
            ) : null}
            <Text style={[styles.actionText, isStopping ? styles.actionTextStop : styles.actionTextStart]}>{actionLabel}</Text>
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
    gap: 8,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
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
    lineHeight: 16,
    flexShrink: 1,
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
    flexShrink: 1,
    maxWidth: '43%',
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
    flexShrink: 1,
  },
  grid: {
    flex: 1,
    minHeight: 0,
    gap: 12,
  },
  compactGrid: {
    gap: 8,
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
    minWidth: 0,
  },
  cardInner: {
    padding: 14,
  },
  feedCard: {
    flex: 1,
    minHeight: 120,
  },
  feedCardInner: {
    flex: 1,
    minHeight: 0,
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
    gap: 8,
  },
  alertCount: {
    color: TEXT,
    fontSize: 46,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  alertMeta: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-end',
    paddingLeft: 8,
  },
  alertHint: {
    color: 'rgba(230,237,243,0.62)',
    fontSize: 12,
    marginBottom: 4,
    textAlign: 'right',
    flexShrink: 1,
  },
  alertHint2: {
    color: 'rgba(230,237,243,0.80)',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
    flexShrink: 1,
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
    gap: 8,
  },
  feedBox: {
    marginTop: 4,
    padding: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(11,15,20,0.65)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,198,0.10)',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  feedList: {
    flex: 1,
    minHeight: 0,
  },
  feedListContent: {
    paddingBottom: 4,
  },
  feedEmpty: {
    color: 'rgba(230,237,243,0.55)',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  feedRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  feedTime: {
    color: 'rgba(230,237,243,0.50)',
    width: 82,
    flexShrink: 0,
    marginTop: 10,
  },
  feedMsg: {
    flex: 1,
    minWidth: 0,
    marginTop: 0,
    lineHeight: 18,
    flexShrink: 1,
  },
  actionsRow: {
    width: '100%',
    marginTop: 4,
  },
  actionBtn: {
    paddingVertical: 14,
    minHeight: 54,
    borderRadius: 14,
    backgroundColor: 'rgba(17,25,39,0.85)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  actionBtnStart: {
    borderColor: 'rgba(0,255,198,0.45)',
  },
  actionBtnStop: {
    borderColor: 'rgba(255,59,59,0.45)',
  },
  actionText: {
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  actionTextStart: {
    color: ACCENT,
  },
  actionTextStop: {
    color: ALERT,
  },
  footerMono: {
    marginTop: 10,
    color: 'rgba(230,237,243,0.45)',
    fontSize: 11,
    fontFamily: 'monospace',
    flexShrink: 1,
  },
});
