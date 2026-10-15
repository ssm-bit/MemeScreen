# Publishes the MemeScreen phone shell to Expo's servers (EAS Update), so Expo Go loads it from the internet.
# No laptop, no hotspot, no tunnel: works on NJIT Wi-Fi, cellular, anywhere. Run again after changing expo-shell\App.js.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$expo = Join-Path $root 'memescreen-phone'
if (-not (Test-Path (Join-Path $expo 'package.json'))) { Write-Host 'memescreen-phone is missing. Run Put-MemeScreen-on-iPhone.bat once first (it creates the project), then run this again.' -ForegroundColor Red; exit 1 }

Write-Host '== MemeScreen: publish the phone app to Expo ==' -ForegroundColor Cyan
# latest shell + hosted site address, same as the iPhone script does
$shell = Join-Path $root 'expo-shell\App.js'
$hostedFile = Join-Path $root 'hosted-url.txt'
$hosted = if (Test-Path $hostedFile) { (Get-Content $hostedFile -Raw).Trim().TrimEnd('/') } else { 'https://ssm-bit.github.io/MemeScreen' }
$code = Get-Content $shell -Raw -Encoding UTF8
$code = [regex]::Replace($code, "const APP_URL = '[^']*';", "const APP_URL = '$hosted/?m=1';")
Set-Content -Path (Join-Path $expo 'App.js') -Value $code -Encoding UTF8
Write-Host "App.js -> $hosted/?m=1"

Set-Location $expo
$who = (cmd /c "npx expo whoami 2>nul" | Select-Object -Last 1)
if (-not $who -or $who -match 'Not logged in') { Write-Host 'Not signed in to Expo. Signing in (use the nae23 account)...' -ForegroundColor Yellow; cmd /c "npx expo login" }
$who = (cmd /c "npx expo whoami 2>nul" | Select-Object -Last 1)
Write-Host "Expo account: $who"

# link this folder to the team's Expo project (the same id the push notifications use)
$projId = 'ba75b1bb-0046-4852-8543-a10363235b2b'
$acctFile = Join-Path $root 'expo-accounts.json'
if (Test-Path $acctFile) { try { $saved = Get-Content $acctFile -Raw | ConvertFrom-Json; if ($saved.$who) { $projId = $saved.$who } } catch {} }
Write-Host "Linking to Expo project $projId ..."
cmd /c "npx --yes eas-cli@latest init --id $projId --non-interactive --force"

# Phantom needs a custom URL scheme to send the phone back to this app
$ajPath = Join-Path $expo 'app.json'
$aj = Get-Content $ajPath -Raw
if ($aj -notmatch '"scheme"') { $aj = $aj -replace '"expo"\s*:\s*\{', '"expo": { "scheme": "memescreen",'; Set-Content -Path $ajPath -Value $aj -Encoding UTF8; Write-Host 'Added scheme "memescreen" to app.json' }

# one-time: gives the project a runtime version and an updates URL in app.json
$aj = Get-Content (Join-Path $expo 'app.json') -Raw
if ($aj -notmatch '"updates"' -or $aj -notmatch 'runtimeVersion') {
  Write-Host 'Configuring EAS Update (one time)...'
  cmd /c "npx --yes eas-cli@latest update:configure --non-interactive"
}

Write-Host 'Publishing...' -ForegroundColor Cyan
cmd /c "npx --yes eas-cli@latest update --branch main --environment production --message ""MemeScreen $(Get-Date -Format 'yyyy-MM-dd HH:mm')"" --non-interactive"

Write-Host ''
Write-Host 'Done. On a phone with Expo Go signed in as this account:' -ForegroundColor Green
Write-Host "  open Expo Go -> Projects -> memescreen-phone -> branch main (or scan the QR on https://expo.dev/accounts/$who/projects/memescreen-phone/updates)" -ForegroundColor Green
Write-Host 'Teammates: add them as members of this Expo account (expo.dev -> account -> Members) and they see the same project in Expo Go.' -ForegroundColor Green
Write-Host 'Nothing needs to stay running on this laptop.' -ForegroundColor Green
pause
