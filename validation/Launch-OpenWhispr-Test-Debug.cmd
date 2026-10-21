@echo off
setlocal
rem TEST-ONLY launcher, same isolation as Launch-OpenWhispr-Test.cmd plus debug
rem logging. Use this one to capture evidence of which cleanup mode a shortcut
rem used: the log records ROUTE_RESOLVED / REASONING_SKIPPED per recording.

set "OPENWHISPR_CHANNEL=staging"
set "OPENWHISPR_LOG_LEVEL=debug"

echo ============================================================
echo  OpenWhispr REVISION BUILD - debug logging ON
echo ============================================================
echo  Test profile : %APPDATA%\OpenWhispr-staging  (new + empty)
echo  Debug logs   : %APPDATA%\OpenWhispr-staging\logs
echo  Oct 14 build : %APPDATA%\OpenWhispr-development  (untouched)
echo  Updates      : disabled in this build
echo.
echo  Logs can contain transcript text - dictate synthetic test
echo  phrases only, and review a log before sharing it.
echo ============================================================
echo.

start "" "%~dp0OpenWhispr.exe" --log-level=debug
endlocal
