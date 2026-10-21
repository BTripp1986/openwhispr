@echo off
setlocal
rem TEST-ONLY launcher for the OpenWhispr per-shortcut cleanup REVISION build.
rem Not an OpenWhispr release. See READ-ME-FIRST.txt.
rem
rem This candidate is pinned to the 'staging' channel, which is DIFFERENT from
rem the October 14 candidate's 'development' channel. It therefore starts on a
rem fresh, empty profile and cannot read, change or delete anything belonging
rem to the earlier test build or to your production install.
rem
rem The channel is baked into the package, so starting OpenWhispr.exe directly
rem is equally safe; this launcher only makes the isolation visible.
set "OPENWHISPR_CHANNEL=staging"

echo ============================================================
echo  OpenWhispr REVISION BUILD - test only, not a release
echo ============================================================
echo  Test profile : %APPDATA%\OpenWhispr-staging  (new + empty)
echo  Oct 14 build : %APPDATA%\OpenWhispr-development  (untouched)
echo  Updates      : disabled in this build
echo.
echo  This build starts with no settings. You will re-enter your
echo  OpenAI key and shortcuts - that is expected, and is how the
echo  earlier test profile is left intact.
echo.
echo  Quit your production OpenWhispr from its tray first, or the
echo  two copies compete for the same global hotkeys.
echo ============================================================
echo.

start "" "%~dp0OpenWhispr.exe"
endlocal
