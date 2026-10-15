@echo off
rem Publishes the phone shell to Expo's servers so Expo Go loads it from anywhere (NJIT Wi-Fi, cellular). No laptop needed after this.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-phone.ps1"
