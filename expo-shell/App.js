// MemeScreen — Expo shell for iPhone / Android.
// Shows the MemeScreen phone app full screen, turns its alerts into real phone notifications, and connects
// Phantom through Phantom's deep-link protocol so the wallet comes back INTO this app (read-only).
// APP_URL is the hosted site on GitHub Pages, so the phone app works from anywhere with no laptop.
// The iPhone script swaps in a laptop address when it is run with -Local.
import 'react-native-get-random-values';
import { useEffect, useRef } from 'react';
import { Linking, Platform, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as ExpoLinking from 'expo-linking';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// belt and braces: the page already locks itself on a phone, this makes sure of it before anything paints
const LOCK = `(function(){ var m=document.querySelector('meta[name=viewport]'); if(!m){ m=document.createElement('meta'); m.name='viewport'; (document.head||document.documentElement).appendChild(m); } m.content='width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover'; })(); true;`;

const APP_URL = 'https://ssm-bit.github.io/MemeScreen/?m=1';
const APP_ORIGIN = APP_URL.replace(/^(https?:\/\/[^/]+).*$/, '$1');

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

// ---------- Phantom deep-link connect ----------
// https://docs.phantom.com/phantom-deeplinks/provider-methods/connect
// We make an X25519 keypair, send Phantom our public key and a link back to this app. Phantom opens, the user
// approves, Phantom opens our link with an encrypted payload holding the wallet address. We decrypt it here.
let dapp = null;                                   // { publicKey, secretKey }
function phantomConnectUrl() {
  dapp = nacl.box.keyPair();
  const redirect = ExpoLinking.createURL('phantom');  // exp://…/--/phantom in Expo Go, memescreen://phantom in a build
  const q = new URLSearchParams({ app_url: APP_ORIGIN, dapp_encryption_public_key: bs58.encode(dapp.publicKey), redirect_link: redirect, cluster: 'mainnet-beta' });
  return 'https://phantom.app/ul/v1/connect?' + q.toString();
}
function utf8(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); try { return decodeURIComponent(escape(s)); } catch { return s; } }
function phantomDecode(url) {
  try {
    const u = new URL(url); const p = u.searchParams;
    if (p.get('errorCode')) return { error: p.get('errorMessage') || 'Phantom said no' };
    const pk = p.get('phantom_encryption_public_key'), nonce = p.get('nonce'), data = p.get('data');
    if (!pk || !nonce || !data || !dapp) return null;
    const shared = nacl.box.before(bs58.decode(pk), dapp.secretKey);
    const open = nacl.box.open.after(bs58.decode(data), bs58.decode(nonce), shared);
    if (!open) return { error: 'Could not decrypt Phantom\'s reply' };
    const j = JSON.parse(utf8(open));
    return { pub: j.public_key };
  } catch (e) { return { error: e.message }; }
}

export default function App() {
  const web = useRef(null);
  const tell = msg => { try { web.current?.injectJavaScript(`window.postMessage(${JSON.stringify({ source: 'phone-os', ...msg })}, location.origin); true;`); } catch {} };

  useEffect(() => {
    Notifications.requestPermissionsAsync();
    // tapping a notification opens that token's chart inside the app
    const sub = Notifications.addNotificationResponseReceivedListener(r => {
      const addr = r.notification.request.content.data?.addr;
      if (addr) tell({ type: 'open-token', addr });
    });
    // Phantom sends the user back here with the wallet address
    const onUrl = ({ url }) => { if (!url || !/phantom/.test(url)) return; const r = phantomDecode(url); if (!r) return; tell({ type: 'wallet', ...r }); };
    const lsub = Linking.addEventListener('url', onUrl);
    Linking.getInitialURL().then(url => url && onUrl({ url }));
    return () => { sub.remove(); lsub.remove(); };
  }, []);

  const onMessage = e => {
    let m; try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m?.source !== 'memescreen') return;
    if (m.type === 'ms-open-url' && /^https?:/i.test(m.url || '')) { Linking.openURL(m.url).catch(() => {}); return; }
    if (m.type === 'ms-wallet-connect') { Linking.openURL(phantomConnectUrl()).catch(() => tell({ type: 'wallet', error: 'Phantom is not installed' })); return; }
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
