#!/usr/bin/env bash
# Mac / Linux version of Publish-Phone-App.bat: publishes the MemeScreen phone shell to Expo (EAS Update).
# Run from the memescreen-project folder:  bash publish-phone.sh
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"; EXPO="$ROOT/memescreen-phone"; PROJ=ba75b1bb-0046-4852-8543-a10363235b2b
HOSTED="$( [ -f "$ROOT/hosted-url.txt" ] && tr -d '\n\r' < "$ROOT/hosted-url.txt" || echo https://ssm-bit.github.io/MemeScreen )"; HOSTED="${HOSTED%/}"
if [ ! -f "$EXPO/package.json" ]; then
  echo "Creating memescreen-phone (first time)..."
  (cd "$ROOT" && npx --yes create-expo-app@latest memescreen-phone --template blank)
  (cd "$EXPO" && npx expo install react-native-webview expo-notifications expo-linking expo-constants react-native-get-random-values react-native-safe-area-context && npm install tweetnacl bs58)
fi
sed "s#const APP_URL = '[^']*';#const APP_URL = '$HOSTED/?m=1';#" "$ROOT/expo-shell/App.js" > "$EXPO/App.js"
echo "App.js -> $HOSTED/?m=1"
cd "$EXPO"
python3 - <<PY
import json; p='app.json'; j=json.load(open(p)); e=j.setdefault('expo',{}); e['scheme']='memescreen'
e.setdefault('extra',{}).setdefault('eas',{})['projectId']='$PROJ'; json.dump(j,open(p,'w'),indent=2); print('app.json: scheme + projectId set')
PY
npx expo whoami >/dev/null 2>&1 || npx expo login
npx --yes eas-cli@latest init --id "$PROJ" --non-interactive --force || true
grep -q '"updates"' app.json || npx --yes eas-cli@latest update:configure --non-interactive
npx --yes eas-cli@latest update --branch main --environment production --message "MemeScreen $(date '+%Y-%m-%d %H:%M')"
echo "Done. Expo Go -> Projects -> memescreen-phone -> main (open it twice)."
