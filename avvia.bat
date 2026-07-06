@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Solo GM - avvio in corso...
echo ============================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker non e' installato o non e' nel PATH.
  echo Scarica e installa Docker Desktop da https://www.docker.com/products/docker-desktop/
  echo poi riavvia il computer e riprova.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop non sembra essere avviato.
  echo Apri Docker Desktop dal menu Start, aspetta che sia pronto (icona verde/stabile)
  echo e poi rilancia questo file.
  pause
  exit /b 1
)

if not exist ".env" (
  echo Manca il file .env nella cartella del progetto.
  echo Assicurati di aver copiato il file .env che ti e' stato inviato in questa cartella.
  pause
  exit /b 1
)

echo Costruzione e avvio dei servizi (la prima volta puo' richiedere diversi minuti,
echo scarica anche il modello di intelligenza artificiale locale per l'indicizzazione)...
echo.
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Si e' verificato un errore durante l'avvio. Copia il messaggio sopra
  echo e mandalo a chi ti ha dato il progetto.
  pause
  exit /b 1
)

echo.
echo Attendo che l'app sia pronta...

:wait
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri http://localhost:3000 -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  timeout /t 3 >nul
  goto wait
)

echo Pronto! Apro il browser...
start http://localhost:3000

echo.
echo Puoi chiudere questa finestra: l'app restera' attiva in background.
echo Per fermarla, usa il file ferma.bat
pause
