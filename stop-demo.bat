@echo off
title Academic Portal - Stop
cd /d "%~dp0"
docker compose down
echo Stopped. Data is kept in the Docker volume (docker compose down -v removes it).
pause
