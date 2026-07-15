#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

echo "============================================"
echo "  Solo GM - avvio in corso..."
echo "============================================"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker non e' installato."
  echo "Scarica e installa Docker Desktop da https://www.docker.com/products/docker-desktop/"
  echo "poi riavvia il computer e riprova."
  read -p "Premi invio per chiudere questa finestra..."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop non sembra essere avviato."
  echo "Apri Docker Desktop (icona nella barra menu), aspetta che sia pronto"
  echo "e poi rilancia questo file."
  read -p "Premi invio per chiudere questa finestra..."
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "Manca il file .env nella cartella del progetto."
  echo "Assicurati di aver copiato il file .env che ti e' stato inviato in questa cartella."
  read -p "Premi invio per chiudere questa finestra..."
  exit 1
fi

echo "Costruzione e avvio dei servizi (la prima volta puo' richiedere diversi minuti,"
echo "scarica anche il modello di intelligenza artificiale locale per l'indicizzazione)..."
echo
if ! docker compose up -d --build; then
  echo
  echo "Si e' verificato un errore durante l'avvio. Copia il messaggio sopra"
  echo "e mandalo a chi ti ha dato il progetto."
  read -p "Premi invio per chiudere questa finestra..."
  exit 1
fi

echo
echo "Attendo che l'app sia pronta..."

until curl -s -o /dev/null http://localhost:4200; do
  sleep 3
done

echo "Pronto! Apro il browser..."
open http://localhost:4200

echo
echo "Puoi chiudere questa finestra: l'app restera' attiva in background."
echo "Per fermarla, usa il file ferma.command"
read -p "Premi invio per chiudere questa finestra..."
