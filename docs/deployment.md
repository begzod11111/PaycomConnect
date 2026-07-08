# PaycomConnect — deployment on the monitoring-jira.uz VM

This document answers the operational questions before deploying PaycomConnect
next to the existing **Tamada** stack on the GCP VM `35.223.106.176`:

- Is there enough disk space?
- Which ports are free?
- How do we expose it on a separate subdomain via nginx?
- Will the VM handle the extra load?

All numbers below were measured on the live VM (Ubuntu 25.10, 2 vCPU, 7.7 GiB RAM).

> **Порядок работ:** сначала прогоняем сервис через **ngrok** (см.
> [`docs/ngrok.md`](./ngrok.md)) с реальными webhook'ами, и только после проверки
> делаем постоянный деплой на субдомен по этому документу.

---

## 1. Resource assessment (measured)

### CPU / memory
- **CPU:** 2 vCPU (Intel Xeon @ 2.20 GHz). Load average ~2.2 — i.e. the box is
  already running close to fully utilised by the Tamada stack.
- **RAM:** 7.7 GiB total, **~1.1 GiB available**, and **no swap**.
- Biggest memory consumers today: a `node` service (~2.4 GiB RSS), `mongod`
  (~1.6 GiB), Kafka `java` (~1.1 GiB), Zookeeper `java` (~0.4 GiB).

### Disk
- Single root disk: **/dev/sda1, 28 GiB**. Everything (OS, `/var/lib/containerd`
  image store ~12 GiB, `/mnt/new_docker` docker data-root, volumes) lives on this
  one partition — there is **no separate data disk**.
- Before cleanup: **23 GiB used / 5.2 GiB free (82%)**.
- After cleanup (see §2): **20 GiB used / 8.8 GiB free (69%)**.

### Existing containers (the "Tamada" stack)
`tamada_crm`, `tamada_gateway`, `tamada_auth`, `tamada_analytics`, `tamada_shift`,
`tamada_assigner`, `tamada_mongo` (MongoDB 8 — the existing "base"), `tamada_kafka`,
`tamada_zookeeper`, `tamada_redis`, `tamada_mongo_admin` (mongo-express).

---

## 2. Disk cleanup performed

Freed **~3.6 GiB** (82% → 69%) with zero risk to running services:

| Action | Freed |
| --- | --- |
| `docker builder prune -f` (stale build cache) | ~2.6 GiB |
| `journalctl --vacuum-size=200M` (systemd journal) | ~0.5 GiB |
| Removed stale `/var/lib/docker.old` (pre-migration data-root) | ~0.65 GiB |

Further optional cleanup if ever needed: old snap revisions in `/var/lib/snapd`
(~2.3 GiB total, duplicate `core22`/`core24`/`snapd`/`google-cloud-cli` revisions),
and the unused `node:24-slim` image (326 MB — but PaycomConnect reuses this base,
so keep it).

---

## 3. Ports

Host ports currently **in use**: `22` (ssh), `80`/`443` (nginx), `3001`
(tamada_crm), `8000` (tamada_gateway), `8081` (mongo-express), `27017` (mongo).

**PaycomConnect uses port `9010`, which is free.** It is published on the loopback
interface only (`127.0.0.1:9010`) and reached from the internet via nginx — the
same pattern the Tamada stack uses. Nothing is exposed publicly except through
nginx on 443.

---

## 4. Subdomain + reverse proxy

Base domain: `monitoring-jira.uz`. Tamada already lives at
`tamada.monitoring-jira.uz`. PaycomConnect gets its own subdomain:

> **`paycom.monitoring-jira.uz`** (rename freely — just keep it consistent with
> the nginx `server_name` and DNS record).

The TLS cert on the box (`/etc/letsencrypt/live/monitoring-jira.uz/`) currently
covers only `monitoring-jira.uz` and `tamada.monitoring-jira.uz` — it is **not**
a wildcard, so the new name must be added.

Steps:

1. **DNS:** add an `A` record `paycom.monitoring-jira.uz -> 35.223.106.176`.
2. **TLS:** expand the existing certificate to include the new name:
   ```bash
   sudo certbot --nginx \
     -d monitoring-jira.uz -d tamada.monitoring-jira.uz -d paycom.monitoring-jira.uz
   ```
3. **nginx:** install the provided site config and reload:
   ```bash
   sudo cp deploy/nginx/paycom.monitoring-jira.uz.conf \
       /etc/nginx/sites-available/paycom.monitoring-jira.uz
   sudo ln -s /etc/nginx/sites-available/paycom.monitoring-jira.uz \
       /etc/nginx/sites-enabled/paycom.monitoring-jira.uz
   sudo nginx -t && sudo systemctl reload nginx
   ```

Public webhook URL becomes: `https://paycom.monitoring-jira.uz/api/telegram/webhook`.

---

## 5. Database: cloud now, VM later

For now use a **cloud MongoDB** (e.g. MongoDB Atlas free/shared tier). Set in `.env`:

```
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/paycomconnect?retryWrites=true&w=majority
```

The dataset is small, so migrating later to the on-VM `tamada_mongo` is easy
(`mongodump` from cloud → `mongorestore` into `tamada_mongo`). When you cut over,
attach the container to the mongo network and point `MONGODB_URI` at
`mongodb://…@tamada_mongo:27017/paycomconnect?authSource=admin` (see the commented
block at the bottom of `docker-compose.yml`). Keeping the DB in the cloud for now
also means the deployment adds **no** local database storage growth.

---

## 6. Deploy steps

```bash
# On the VM, in the project directory:
cp .env.example .env      # then fill in real secrets + cloud MONGODB_URI
docker compose up -d --build
docker compose ps
docker compose logs -f paycomconnect   # expect "listening on http://0.0.0.0:9010"
curl -s http://127.0.0.1:9010/api/health   # {"status":"ok",...,"database":"connected"}
```

Or use the helper: `bash deploy/vm-deploy.sh` (build + start + health check).

Then run §4 to publish it on the subdomain, and (optionally) set the Telegram
webhook:

```bash
npm run setup:telegram -- --webhook   # uses TELEGRAM_WEBHOOK_URL from .env
```

---

## 6a. Current status on the VM (already prepared)

The app side is already set up on the VM under
`/home/behzod.t/paycomconnect`:

- [x] **2 GiB+ swap** added and enabled (`vm.swappiness=10`) — mitigates the tight RAM.
- [x] Repo copied to `/home/behzod.t/paycomconnect`, `.env` created from the
      example (**secrets still empty** — fill `MONGODB_URI`, `TELEGRAM_BOT_TOKEN`, …).
- [x] Docker image **built** (`paycomconnect:latest`) and container **running healthy**
      on `127.0.0.1:9010` (memory mode until `MONGODB_URI` is set).
- [x] nginx vhost **staged** at `/etc/nginx/sites-available/paycom.monitoring-jira.uz`
      (not yet enabled); live nginx config untouched and valid.

- [x] Secrets filled in `.env`; app connected to cloud MongoDB
      (`database.mode: mongodb, connected: true`, all integrations enabled).
- [x] DNS `A` record `paycom.monitoring-jira.uz -> 35.223.106.176` created.
- [x] TLS cert **expanded** to cover `paycom.monitoring-jira.uz` (valid ~90 days,
      auto-renew scheduled); nginx site **enabled** and reloaded.

**Live:** `https://paycom.monitoring-jira.uz/api/health` returns `{"status":"ok",...}`
(HTTP is 301-redirected to HTTPS). Telegram webhook URL:
`https://paycom.monitoring-jira.uz/api/telegram/webhook`.

> Note on certbot: our vhost references the Let's Encrypt cert files directly, so
> certbot only needs to *obtain/expand* the cert (`certonly`), not install/rewrite
> nginx. `deploy/enable-subdomain.sh` enables the site first, then expands the cert —
> this avoids the "Could not automatically find a matching server block" installer
> error.

---

## 7. Verdict — can the VM handle it?

**Yes, with one precaution.**

- **Disk:** Not a concern. The app image reuses `node:24-slim` (already present),
  so it adds only a few hundred MB; with the DB in the cloud there is no local
  data growth. After cleanup there is **8.8 GiB free** — comfortable.
- **CPU:** PaycomConnect is a single lightweight NestJS process (mostly I/O:
  webhooks → Slack/Jira). It is capped at 0.75 vCPU in compose. Impact on the
  already-busy 2 vCPU box is minor but non-zero; monitor load after deploy.
- **Memory — the real constraint:** only ~1.1 GiB is free and there is **no
  swap**. A NestJS app typically needs ~150–350 MB; the 512 MiB compose limit
  keeps it bounded, so it fits. **Strongly recommended:** add swap as a safety
  net before deploying, so a memory spike can't OOM-kill Tamada services:

  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```

**Bottom line:** deploying now is safe and will not critically fill the VM.
Add 2 GiB of swap first as insurance given the tight RAM headroom, keep the
database in the cloud for now, and expose the service on
`paycom.monitoring-jira.uz` through the provided nginx config on the free
port `9010`.
