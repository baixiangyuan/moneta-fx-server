@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if "%MONETA_PORT%"=="" set MONETA_PORT=4173
if "%MONETA_DATA_DIR%"=="" set MONETA_DATA_DIR=%~dp0data
if "%MONETA_DEVELOPER_KEY%"=="" set MONETA_DEVELOPER_KEY=moneta-dev-key

echo MONETA FX 云端服务端
echo 端口: %MONETA_PORT%
echo 数据目录: %MONETA_DATA_DIR%
echo 打开 http://localhost:%MONETA_PORT%/ 进入交易室
echo 按 Ctrl+C 停止服务。
echo.

uv run --with fastapi --with "uvicorn[standard]" --with pydantic --python 3.12 python server\app.py
pause
