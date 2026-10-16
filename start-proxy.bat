@echo off
echo ============================================
echo   Start gemini-bridge proxy (127.0.0.1:8899)
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList '\"%~dp0gemini-proxy.mjs\"' -WindowStyle Hidden"
echo   Proxy starting... (log: %USERPROFILE%\.zcode\gemini-proxy.log)
ping -n 3 127.0.0.1 >nul
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Output '  OK: proxy is listening on 8899' } else { Write-Output '  WARN: not listening yet, check the log' }"
pause