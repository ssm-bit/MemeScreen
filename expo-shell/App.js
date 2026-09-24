// MemeScreen — Expo shell for iPhone / Android.
// Shows the MemeScreen phone app full screen and turns its alerts into real phone notifications.
// APP_URL is the hosted site on GitHub Pages, so the phone app works from anywhere with no laptop.
// The iPhone script swaps in a laptop address when it is run with -Local.
import { useEffect, useRef } from 'react';
import { Linking, Platform, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Notifications from 'expo-notifications';

// belt and braces: the page already locks itself on a phone, this makes sure of it before anything paints
const LOCK = `(function(){ var m=document.querySelector('meta[name=viewport]'); if(!m){ m=document.createElement('meta'); m.name='viewport'; (document.head||document.documentElement).appendChild(m); } m.content='width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover'; })(); true;`;

const APP_URL = 'https://ssm-bit.github.io/MemeScreen/?m=1';
const APP_ORIGIN = APP_URL.replace(/^(https?:\/\/[^/]+).*$/, '$1');

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export default function App() {
  const web = useRef(null);

  useEffect(() => {
    Notifications.requestPermissionsAsync();
    // tapping a notification opens that token's chart inside the app
    const sub = Notifications.addNotificationResponseReceivedListener(r => {
      const addr = r.notification.request.content.data?.addr;
      if (addr && web.current) web.current.injectJavaScript(`window.postMessage({ source:'phone-os', type:'open-token', addr:${JSON.stringify(addr)} }, location.origin); true;`);
    });
    return () => sub.remove();
  }, []);

  const onMessage = e => {
    let m; try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m?.source !== 'memescreen') return;
    if (m.type === 'ms-open-url' && /^https?:/i.test(m.url || '')) { Linking.openURL(m.url).catch(() => {}); return; }
    if (m.type !== 'ms-alert') return;
    Notifications.scheduleNotificationAsync({ content: { title: 'MemeScreen · ' + m.sym, body: m.msg, data: { addr: m.addr } }, trigger: null });
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#14161C" />
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
        <WebView
          ref={web}
          source={{ uri: APP_URL }}
          onMessage={onMessage}
          // only the MemeScreen site may load inside the app; every other link (news, DexScreener, X) opens in Safari
          onShouldStartLoadWithRequest={req => { const ok = req.url.startsWith(APP_ORIGIN) || req.url.startsWith('about:'); if (!ok && /^https?:/i.test(req.url)) Linking.openURL(req.url).catch(() => {}); return ok; }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          bounces={false}
          alwaysBounceVertical={false}
          alwaysBounceHorizontal={false}
          directionalLockEnabled
          pinchGestureEnabled={false}
          scalesPageToFit={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          allowsBackForwardNavigationGestures={false}
          allowsLinkPreview={false}
          dataDetectorTypes="none"
          textZoom={100}
          injectedJavaScriptBeforeContentLoaded={LOCK}
          overScrollMode="never"
          setSupportMultipleWindows={false}
          style={styles.web}
          renderError={() => <View style={styles.root} />}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#14161C' },
  web: { flex: 1, backgroundColor: '#0C0E12' },
});
