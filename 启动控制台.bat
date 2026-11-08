@echo off
chcp 936 >nul 2>nul
setlocal enabledelayedexpansion
title ETS 控制台
cd /d "%~dp0"

rem ================= 1) 找 Node =================
set "NODE="

rem 1.1 PATH 里
for %%I in (node.exe) do if not defined NODE if exist "%%~$PATH:I" set "NODE=%%~$PATH:I"

rem 1.2 标准安装位置
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%APPDATA%\nvm\node.exe" set "NODE=%APPDATA%\nvm\node.exe"

rem 1.3 nvm / 绿色版目录
if not defined NODE for /d %%D in ("%LOCALAPPDATA%\nvm\v*") do if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"
if not defined NODE for /d %%D in ("%ProgramFiles%\nodejs") do if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"

rem 1.4 常见绿色安装根目录（如 D:\AppGallery\nodejs\node-*）
for %%R in (C D E F G) do if not defined NODE for /d %%D in ("%%R:\AppGallery\nodejs\node-*") do if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"
for %%R in (C D E F G) do if not defined NODE for /d %%D in ("%%R:\nodejs\node-*") do if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"
for %%R in (C D E F G) do if not defined NODE if exist "%%R:\nodejs\node.exe" set "NODE=%%R:\nodejs\node.exe"

if not defined NODE (
  echo.
  echo [x] 没找到 node.exe
  echo.
  echo     这个工具需要 Node.js 18 以上（推荐 22/24）：
  echo         https://nodejs.org/zh-cn/download
  echo     装的时候一路默认即可，装完重新双击本文件。
  echo     已经装了但还是报这个：把 node.exe 的完整路径发我，我改成写死路径。
  echo.
  pause
  exit /b 1
)

echo 使用 Node : "%NODE%"
echo 控制台地址: http://127.0.0.1:5173
echo 使用前提  : 讯飞E听说客户端已启动并登录
echo 关闭本窗口: 停止控制台（不影响客户端本身）
echo.

rem ================= 2) 起服务 =================
"%NODE%" "webui\server.js" --open
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" echo 服务退出码: %RC%
echo 控制台已退出。按任意键关闭窗口。
pause >nul
