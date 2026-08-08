@echo off
cd /d "%~dp0"
echo ============================================
echo   博学谷视频播放器 - 启动中...
echo ============================================
echo.
echo 首次启动需要加载 Electron，请稍候...
echo.
npx electron . %*
pause
