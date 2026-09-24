# Sets up the Expo shell for MemeScreen and starts everything needed to open it on phones with Expo Go.
# Any number of phones can scan the same QR code. They only need to be on the same Wi-Fi / hotspot as this laptop.
# Safe to run again: it skips whatever is already done.
param([switch]$Anywhere)
# -Anywhere : for school / office Wi-Fi that blocks phones from reaching a laptop. Puts the website and Expo behind
#             secure public tunnels, so a phone on ANY network (NJIT Wi-Fi, cellular, home) can scan and join.
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$app   = Join-Path $root 'memescreen'
$shell = Join-Path $root 'expo-shell\App.js'
$expo  = Join-Path $root 'memescreen-phone'

function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }

Step 'Checking Node'
try { $v = node -v; Write-Host "Node $v" } catch { Write-Host 'Node.js is not installed. Get the LTS from nodejs.org and run this again.' -ForegroundColor Red; exit 1 }

Step 'Finding this laptop''s address on the iPhone hotspot'
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' }
$ip = ($ips | Where-Object { $_.IPAddress -like '172.20.10.*' } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = ($ips | Where-Object { $_.IPAddress -eq '192.168.137.1' } | Select-Object -First 1).IPAddress }   # this laptop's own Windows Mobile hotspot
if (-not $ip) { $ip = ($ips | Where-Object { $_.InterfaceAlias -match 'Wi-?Fi|WLAN' } | Select-Object -First 1).IPAddress }
if (-not $ip) { $ip = ($ips | Select-Object -First 1).IPAddress }
if (-not $ip) { Write-Host 'Could not find a network address. Connect the laptop to the iPhone hotspot and run this again.' -ForegroundColor Red; exit 1 }
Write-Host "Laptop address: $ip"
if ($ip -notlike '172.20.10.*' -and $ip -ne '192.168.137.1') { Write-Host 'Heads up: that is not a hotspot address. It works if the phones are on the same Wi-Fi, but school Wi-Fi often blocks phones from reaching a laptop. A hotspot is the safe choice.' -ForegroundColor Yellow }

Step 'Creating the Expo project (first run only, takes a few minutes)'
if (-not (Test-Path (Join-Path $expo 'package.json'))) {
  Push-Location $root
  cmd /c "npx --yes create-expo-app@latest memescreen-phone --template blank --yes"
  Pop-Location
  if (-not (Test-Path (Join-Path $expo 'package.json'))) { Write-Host 'create-expo-app did not finish. Scroll up for the error.' -ForegroundColor Red; exit 1 }
} else { Write-Host 'Already there.' }

Step 'Installing the WebView, notifications and safe-area packages'
Push-Location $expo
$pkg = Get-Content package.json -Raw
if ($pkg -notmatch 'react-native-webview' -or $pkg -notmatch 'expo-notifications' -or $pkg -notmatch 'react-native-safe-area-context') {
  cmd /c "npx expo install react-native-webview expo-notifications react-native-safe-area-context"
} else { Write-Host 'Already installed.' }
Pop-Location

Step 'Starting the MemeScreen server and website in their own windows'
$busy4000 = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
$busy5173 = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
$cfg = Get-Content (Join-Path $app 'src\config.js') -Raw
$useB4A = $cfg -match "appId:\s*'[^']+'"
if ($useB4A) { Write-Host 'Backend is Back4App, so the local API server is not needed.' }
elseif (-not $busy4000) { Start-Process cmd -ArgumentList '/k', "title MemeScreen API && cd /d `"$app\server`" && npm start" } else { Write-Host 'Server already running on 4000.' }
if ($busy5173 -and $Anywhere) { Write-Host 'The website window is already open. If it was started before this update, close it and run this file again, or phones will see a "Blocked request" page.' -ForegroundColor Yellow }
if (-not $busy5173) { Start-Process cmd -ArgumentList '/k', "title MemeScreen web && cd /d `"$app`" && npm run dev" } else { Write-Host 'Website already running on 5173. If it was started before today, close that window and run this again so it picks up the latest code.' -ForegroundColor Yellow }

$webUrl = "http://${ip}:5173"
$hostedFile = Join-Path $root 'hosted-url.txt'
$hosted = if (Test-Path $hostedFile) { (Get-Content $hostedFile -Raw).Trim().TrimEnd('/') } else { '' }
if ($hosted -match '^https://') { $webUrl = $hosted; Write-Host "Using the hosted site: $webUrl  (phones load the app from there, from any location)" -ForegroundColor Green }
if ($Anywhere -and -not $hosted) {
  Step 'Opening a secure public tunnel to the website (Cloudflare quick tunnel, no account needed)'
  $cf = Join-Path $root 'cloudflared.exe'
  if (-not (Test-Path $cf)) { Write-Host 'Downloading cloudflared (one time, about 60 MB)...'; [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf }
  $log = Join-Path $root 'tunnel.log'; if (Test-Path $log) { Remove-Item $log -Force }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Process $cf -ArgumentList 'tunnel','--url','http://localhost:5173','--logfile',"`"$log`"" -WindowStyle Minimized
  $found = $null
  for ($i = 0; $i -lt 40 -and -not $found; $i++) { Start-Sleep -Seconds 1; if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $found = $m.Matches[0].Value } } }
  if (-not $found) { Write-Host 'The tunnel did not come up. The network may block it. Falling back to the local address.' -ForegroundColor Red } else { $webUrl = $found; Write-Host "Website is public at: $webUrl" -ForegroundColor Green }
}

Step 'Pointing the phone app at the website'
$code = Get-Content $shell -Raw
$code = [regex]::Replace($code, "const APP_URL = '[^']*';", "const APP_URL = '$webUrl/?m=1';")
Set-Content -Path (Join-Path $expo 'App.js') -Value $code -Encoding UTF8
Write-Host "App.js -> $webUrl/?m=1"

Write-Host ""
Write-Host "If Windows asks about the firewall for Node.js, tick BOTH Private and Public and click Allow." -ForegroundColor Yellow
Write-Host ""
Write-Host "Quick check on a phone first: open Safari and go to  $webUrl/?m=1" -ForegroundColor Green
Write-Host "If that loads, scan the QR code below with the iPhone Camera. It opens in Expo Go." -ForegroundColor Green

Step 'Expo accounts for the phones'
# Expo Go only opens a project for a signed-in phone when the server on this laptop is signed in as that same Expo user.
# So each Expo account gets its own small Expo server (own port, own login folder). Up to 4: the main one plus 3 more.
# Passwords are typed here, handed straight to "expo login", and never written to disk.
$homes = Join-Path $root '.expo-homes'; New-Item -ItemType Directory -Force -Path $homes | Out-Null
$acctFile = Join-Path $root 'expo-accounts.json'
$saved = @{}; if (Test-Path $acctFile) { try { (Get-Content $acctFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $saved[$_.Name] = $_.Value } } catch {} }

# the project reads its owner / project id from the environment, so one folder can serve several accounts
$appJson = Join-Path $expo 'app.json'
if (Test-Path $appJson) { $j = Get-Content $appJson -Raw | ConvertFrom-Json
  if ($j.expo.PSObject.Properties.Name -contains 'owner') { $j.expo.PSObject.Properties.Remove('owner') }
  if (($j.expo.PSObject.Properties.Name -contains 'extra') -and ($j.expo.extra.PSObject.Properties.Name -contains 'eas')) { $j.expo.extra.PSObject.Properties.Remove('eas') }
  $j | ConvertTo-Json -Depth 20 | Set-Content $appJson -Encoding UTF8 }
Set-Content -Path (Join-Path $expo 'app.config.js') -Encoding UTF8 -Value @'
module.exports = ({ config }) => {
  const owner = process.env.MS_EXPO_OWNER, id = process.env.MS_EXPO_PROJECT_ID;
  if (owner) config.owner = owner;
  if (id) config.extra = { ...(config.extra || {}), eas: { projectId: id } };
  return config;
};
'@

function Clean($t) { (($t | Out-String) -replace "\x1b\[[0-9;]*[A-Za-z]", '').Trim() }
function InSlot($i, $cmdline) {   # run a command with slot i's Expo login folder
  if ($i -eq 0) { Remove-Item Env:__UNSAFE_EXPO_HOME_DIRECTORY -ErrorAction SilentlyContinue } else { $env:__UNSAFE_EXPO_HOME_DIRECTORY = (Join-Path $homes "slot$i") }
  Push-Location $expo; $out = cmd /c "$cmdline 2>&1"; Pop-Location
  Remove-Item Env:__UNSAFE_EXPO_HOME_DIRECTORY -ErrorAction SilentlyContinue
  return (Clean $out)
}
function WhoIs($i) { $w = InSlot $i 'npx expo whoami'; if (-not $w -or $w -match 'Not logged in|rror') { return $null }; return ($w -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() }

$slots = @()
for ($i = 0; $i -le 3; $i++) {
  $label = if ($i -eq 0) { 'Main account (nae23)' } else { "Extra account $i of 3" }
  $who = WhoIs $i
  if ($who) { Write-Host "$label : already signed in as $who" -ForegroundColor Green }
  else {
    Write-Host ""
    Write-Host "$label : not signed in." -ForegroundColor Yellow
    $u = Read-Host "  Expo email or username (press Enter to skip this one)"
    if ($u) {
      $sec = Read-Host "  Password for $u (hidden while you type)" -AsSecureString
      $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
      $env:MS_PW = $pw; $r = InSlot $i "npx expo login -u `"$u`" -p `"%MS_PW%`""; Remove-Item Env:MS_PW; $pw = $null
      $who = WhoIs $i
      if ($who) { Write-Host "  Signed in as $who" -ForegroundColor Green } else { Write-Host "  Login failed: $r" -ForegroundColor Red; Write-Host '  (Accounts made with Google or GitHub have no password. Set one at expo.dev -> Settings, or skip this one.)' -ForegroundColor Yellow }
    }
  }
  if ($who) {
    $projId = $saved[$who]
    if (-not $projId) {
      Write-Host "  Linking the project to $who (one time)..."
      $env:MS_EXPO_OWNER = $who; $o = InSlot $i 'npx --yes eas-cli@latest init --non-interactive --force'; Remove-Item Env:MS_EXPO_OWNER
      $m = [regex]::Match($o, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
      if ($m.Success) { $projId = $m.Value; $saved[$who] = $projId; Write-Host "  Linked ($projId)" -ForegroundColor Green } else { Write-Host "  Could not link automatically. That phone may need to log out of Expo Go instead." -ForegroundColor Yellow }
    }
    $slots += [pscustomobject]@{ i = $i; who = $who; port = 8081 + $i; projId = $projId }
  }
}
$saved | ConvertTo-Json | Set-Content $acctFile -Encoding UTF8
if (-not $slots.Count) { Write-Host 'No Expo account is signed in. Phones can still join if they log out of Expo Go, or use the No install code.' -ForegroundColor Yellow; $slots = @([pscustomobject]@{ i = 0; who = ''; port = 8081; projId = $null }) }

Step 'Starting Expo. Leave every window open during the demo.'
$mode = if ($Anywhere) { '--tunnel' } else { '--lan' }
if ($Anywhere) { Push-Location $expo; if ((Get-Content package.json -Raw) -notmatch '@expo/ngrok') { Write-Host 'Installing the Expo tunnel helper (one time)...'; cmd /c "npm install --save-dev @expo/ngrok@^4.1.0" }; Pop-Location }
$first = $slots[0]
foreach ($s in ($slots | Select-Object -Skip 1)) {
  $h = Join-Path $homes "slot$($s.i)"
  Start-Process cmd -ArgumentList '/k', "title Expo for $($s.who) (port $($s.port)) && cd /d `"$expo`" && set __UNSAFE_EXPO_HOME_DIRECTORY=$h&& set MS_EXPO_OWNER=$($s.who)&& set MS_EXPO_PROJECT_ID=$($s.projId)&& npx expo start $mode --port $($s.port)"
}
$acctParam = ($slots | Where-Object { $_.who } | ForEach-Object { "$($_.who)@$($_.port)" }) -join ','
if ($Anywhere) { $join = "$webUrl/join.html?web=$webUrl/?m=1" } else { $join = "http://${ip}:5173/join.html?accts=$acctParam" }
Write-Host ""
Write-Host "Join page for the projector:  $join" -ForegroundColor Green
if ($Anywhere) { Write-Host "Tunnel mode: each Expo window shows its own QR code. Each person scans the window titled with THEIR Expo account." -ForegroundColor Yellow }
else { Write-Host "On the join page each person taps the tab with THEIR Expo account name, then scans that code." -ForegroundColor Green
       Write-Host "If phones cannot open it (school Wi-Fi blocks this), close everything and run  Put-MemeScreen-on-Phones-ANYWHERE.bat" -ForegroundColor Yellow }
Start-Sleep -Seconds 3
Start-Process $join
Set-Location $expo
if ($first.who) { $env:MS_EXPO_OWNER = $first.who; if ($first.projId) { $env:MS_EXPO_PROJECT_ID = $first.projId } }
if ($first.i -ne 0) { $env:__UNSAFE_EXPO_HOME_DIRECTORY = (Join-Path $homes "slot$($first.i)") }
$host.UI.RawUI.WindowTitle = "Expo for $($first.who) (port $($first.port))"
cmd /c "npx expo start $mode --port $($first.port)"
