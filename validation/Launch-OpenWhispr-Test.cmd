@echo off
setlocal
rem TEST-ONLY launcher for the OpenWhispr dictation raw/cleaned hotkeys
rem validation build. Not an OpenWhispr release. See READ-ME-FIRST.txt.

rem Isolated channel: profile %APPDATA%\OpenWhispr-development, OAuth scheme
rem openwhispr-dev://, its own AppUserModelId and tray identity. The packaged
rem build also pins this channel itself, so starting OpenWhispr.exe directly is
rem safe too; this launcher only makes the isolation visible.
set "OPENWHISPR_CHANNEL=development"

echo ============================================================
echo  OpenWhispr VALIDATION BUILD - test only, not a release
echo ============================================================
echo  Test profile : %APPDATA%\OpenWhispr-development
echo  Updates      : disabled in this build
echo.
echo  Quit your production OpenWhispr from its tray first, or the
echo  two copies compete for the same global hotkeys.
echo ============================================================
echo.

start "" "%~dp0OpenWhispr.exe"
endlocal
