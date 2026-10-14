@echo off
setlocal
rem TEST-ONLY launcher, same isolation as Launch-OpenWhispr-Test.cmd plus debug
rem logging. Use this one to capture evidence that raw dictation made no cleanup
rem request: the log records ROUTE_RESOLVED / REASONING_SKIPPED per recording.

set "OPENWHISPR_CHANNEL=development"
set "OPENWHISPR_LOG_LEVEL=debug"

echo ============================================================
echo  OpenWhispr VALIDATION BUILD - debug logging ON
echo ============================================================
echo  Test profile : %APPDATA%\OpenWhispr-development
echo  Debug logs   : %APPDATA%\OpenWhispr-development\logs
echo  Updates      : disabled in this build
echo.
echo  Logs can contain transcript text - dictate synthetic test
echo  phrases only, and review a log before sharing it.
echo ============================================================
echo.

start "" "%~dp0OpenWhispr.exe" --log-level=debug
endlocal
