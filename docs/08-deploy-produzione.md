# Deploy in produzione (VPS)

File coinvolti: [`docker-compose.prod.yml`](../docker-compose.prod.yml), [`Caddyfile`](../Caddyfile), [`.env.prod.example`](../.env.prod.example).

Differenze rispetto al `docker-compose.yml` di sviluppo:

- **Niente Ollama locale**: i servizi `ollama`/`ollama-pull` sono rimossi. Un VPS senza GPU non regge modelli chat locali, e anche l'embedding (`bge-m3`) è pesante in RAM. Embeddings su Voyage, chat su Anthropic/DeepSeek (o Ollama Cloud, che gira da remoto).
- **Postgres non esposto**: niente `ports: 5432`, resta raggiungibile solo dalla rete Docker interna.
- **Caddy come reverse proxy**: termina TLS (Let's Encrypt automatico) e inoltra ad `app:4200`. `app` non pubblica più la porta direttamente.
- **`POSTGRES_PASSWORD`**: prima era `sologm` fisso, ora obbligatorio da `.env`.

## Passi

1. Sul VPS (Ubuntu consigliato): installa Docker + Docker Compose plugin.
2. `git clone` del repo, poi:
   ```bash
   cp .env.prod.example .env
   ```
   Compila `.env`: `DOMAIN` (deve già puntare al VPS via DNS A record), `POSTGRES_PASSWORD`, `AUTH_SECRET`, credenziali utente, chiavi AI.
3. Apri le porte 80/443 sul firewall del VPS (`ufw allow 80,443/tcp`).
4. Avvia:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
   Al primo avvio Caddy richiede il certificato HTTPS per `DOMAIN` (serve che il DNS sia già propagato).
5. Verifica: `https://<DOMAIN>` deve mostrare la pagina di login.

## Backup

Nessun backup automatico incluso. Minimo consigliato, da schedulare (cron):

```bash
docker exec solo-gm-postgres pg_dump -U sologm sologm | gzip > backup-$(date +%F).sql.gz
```

Il volume `sologm_uploads` (PDF caricati) va backuppato separatamente (es. `docker run --rm -v sologm_uploads:/data -v $(pwd):/backup alpine tar czf /backup/uploads-$(date +%F).tar.gz /data`).

## Aggiornare l'app

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

`migrate` rigira `db:migrate` (idempotente) a ogni deploy.

## Attenzione

- Le API key salvate dalla pagina Impostazioni finiscono **in chiaro** nella tabella `userSettings` del DB — il backup del dump le contiene.
- L'app resta pensata per un solo utente registrato (`AGENTS.md`/architettura): non è pronta per registrazioni pubbliche aperte.
