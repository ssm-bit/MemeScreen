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
import Constants from 'expo-constants';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// belt and braces: the page already locks itself on a phone, this makes sure of it before anything paints
const LOCK = `(function(){ var m=document.querySelector('meta[name=viewport]'); if(!m){ m=document.createElement('meta'); m.name='viewport'; (document.head||document.documentElement).appendChild(m); } m.content='width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover'; })(); true;`;

const SHELL_VERSION = '3';   // shown in the app under Settings → Notifications, so an old shell is easy to spot
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
let phantomShared = null, phantomSession = null;   // set after connect; needed to sign
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
    phantomShared = shared; phantomSession = j.session;
    return { pub: j.public_key };
  } catch (e) { return { error: e.message }; }
}
// signTransaction / signAndSendTransaction over deep links: payload encrypted with the shared secret from connect
function phantomSignUrl(txB58, send) {
  if (!phantomShared || !phantomSession) throw new Error('Connect Phantom first');
  const nonce = nacl.randomBytes(24);
  const payload = new TextEncoder().encode(JSON.stringify({ transaction: txB58, session: phantomSession }));
  const enc = nacl.box.after(payload, nonce, phantomShared);
  const q = new URLSearchParams({ dapp_encryption_public_key: bs58.encode(dapp.publicKey), nonce: bs58.encode(nonce), redirect_link: ExpoLinking.createURL('phantom-sign'), payload: bs58.encode(enc) });
  return 'https://phantom.app/ul/v1/' + (send ? 'signAndSendTransaction' : 'signTransaction') + '?' + q.toString();
}
function phantomSignDecode(url) {
  try {
    const p = new URL(url).searchParams;
    if (p.get('errorCode')) return { error: p.get('errorMessage') || 'Phantom declined' };
    const open = nacl.box.open.after(bs58.decode(p.get('data')), bs58.decode(p.get('nonce')), phantomShared);
    if (!open) return { error: 'Could not decrypt Phantom\'s reply' };
    const j = JSON.parse(utf8(open));
    return j.signature ? { signature: j.signature } : { signed: true, transaction: j.transaction };
  } catch (e) { return { error: e.message }; }
}

export default function App() {
  const web = useRef(null);
  const pushToken = useRef(null);
  const pendingWallet = useRef(null);     // wallet result waiting for the page to acknowledge it
  const tell = msg => { try { web.current?.injectJavaScript(`window.postMessage(${JSON.stringify({ source: 'phone-os', ...msg })}, location.origin); true;`); } catch {} };
  const hello = () => tell({ type: 'shell-hello', version: SHELL_VERSION, platform: Platform.OS, pushToken: pushToken.current });
  // the page may have been reloaded while Phantom was open: keep sending the wallet until the page says it got it
  const deliverWallet = r => { pendingWallet.current = r; let n = 0; const t = setInterval(() => { if (!pendingWallet.current || n++ > 20) return clearInterval(t); tell({ type: 'wallet', ...pendingWallet.current }); }, 1500); tell({ type: 'wallet', ...r }); };
  // Expo push token → the web app saves it to Back4App (PushDevice), the sendPush cloud function delivers through Expo
  const registerPush = async () => {
    try {
      const perm = await Notifications.requestPermissionsAsync(); if (!perm.granted) return tell({ type: 'push-token', error: 'notifications not allowed' });
      const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
      const t = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      pushToken.current = t.data;
      tell({ type: 'push-token', token: t.data, platform: Platform.OS });
    } catch (e) { tell({ type: 'push-token', error: e.message }); }
  };

  useEffect(() => {
    Notifications.requestPermissionsAsync();
    // tapping a notification opens that token's chart inside the app
    const sub = Notifications.addNotificationResponseReceivedListener(r => {
      const addr = r.notification.request.content.data?.addr;
      if (addr) tell({ type: 'open-token', addr });
    });
    // Phantom sends the user back here with the wallet address
    const onUrl = ({ url }) => {
      if (!url) return;
      if (/phantom-sign/.test(url)) { const r = phantomSignDecode(url); tell({ type: 'wallet-signed', ...r }); return; }
      if (/phantom/.test(url)) { const r = phantomDecode(url); if (r) deliverWallet(r); }
    };
    const lsub = Linking.addEventListener('url', onUrl);
    Linking.getInitialURL().then(url => url && onUrl({ url }));
    return () => { sub.remove(); lsub.remove(); };
  }, []);

  const onMessage = e => {
    let m; try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m?.source !== 'memescreen') return;
    if (m.type === 'ms-open-url' && /^https?:/i.test(m.url || '')) { Linking.openURL(m.url).catch(() => {}); return; }
    if (m.type === 'ms-wallet-connect') { Linking.openURL(phantomConnectUrl()).catch(() => tell({ type: 'wallet', error: 'Phantom is not installed' })); return; }
    if (m.type === 'ms-wallet-sign') { try { Linking.openURL(phantomSignUrl(m.tx, m.send)).catch(() => tell({ type: 'wallet-signed', error: 'Could not open Phantom' })); } catch (e) { tell({ type: 'wallet-signed', error: e.message }); } return; }
    if (m.type === 'ms-push-register') { registerPush(); return; }
    if (m.type === 'ms-wallet-ack') { pendingWallet.current = null; return; }
    if (m.type === 'ms-wallet-disconnect') { phantomShared = null; phantomSession = null; return; }
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
          onLoadEnd={hello}
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
