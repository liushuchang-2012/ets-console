@echo off
chcp 936 >nul 2>nul
setlocal
title 发布到 GitHub
cd /d "%~dp0"

echo 本脚本会把当前目录推送到你的 GitHub 仓库。
echo 先在 https://github.com/new 建一个空仓库（Public，不要勾 README）。
echo.
set /p REPO=粘贴仓库地址（形如 https://github.com/用户名/ets-console.git）: 
if "%REPO%"=="" (echo 没输入地址，退出。& pause & exit /b 1)

git remote remove origin >nul 2>nul
git remote add origin "%REPO%" || (echo 添加远程失败 & pause & exit /b 1)
git branch -M main
echo.
echo 正在推送，第一次会弹出登录窗口...
git push -u origin main
echo.
if errorlevel 1 (echo 推送失败，把上面的报错发我。) else (echo 推送成功，去 GitHub 看吧。)
pause
