@echo off
setlocal
cd /d "%~dp0"

echo Arresto di Solo GM...
docker compose down

echo.
echo Fatto. I tuoi dati (campagne, documenti) restano salvati.
echo Per riavviare, usa il file avvia.bat
pause
