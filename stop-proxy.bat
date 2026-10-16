@echo off
echo ============================================
echo   Stop gemini-bridge proxy (127.0.0.1:8899)
echo ============================================
powershell -NoProfile -Command "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*gemini-proxy.mjs*' -and $_.ProcessId -ne $PID }); if ($p.Count -gt 0) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output ('  Stopped proxy process PID ' + $_.ProcessId) }; Write-Output '  Done. Port 8899 released.' } else { Write-Output '  gemini proxy is not running.' }"
pause