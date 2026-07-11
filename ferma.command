#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

echo "Arresto di Solo GM..."
docker compose down

echo
echo "Fatto. I tuoi dati (campagne, documenti) restano salvati."
echo "Per riavviare, usa il file avvia.command"
read -p "Premi invio per chiudere questa finestra..."
