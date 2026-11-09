@echo off
chcp 65001 >nul
title Sigma 客户端
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   没找到 Node.js
  echo.
  echo   请先装 Node ^(LTS 版即可^)：https://nodejs.org/zh-cn
  echo   装完重新双击本文件。
  echo.
  pause
  exit /b 1
)

node server.mjs
if errorlevel 1 pause
