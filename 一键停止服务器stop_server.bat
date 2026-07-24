@echo off
cd /d "%~dp0"

echo ============================================
echo   VCPToolBox - Stopping Services via PM2
echo ============================================
echo.

echo [Cleanup] Stopping and deleting PM2 processes...
call npx pm2 delete vcp-main 2>nul
call npx pm2 delete vcp-admin 2>nul
call npx pm2 delete server 2>nul

echo.
echo ============================================
echo   All VCPToolBox services stopped!
echo ============================================
echo.
call npx pm2 list
echo.
pause
