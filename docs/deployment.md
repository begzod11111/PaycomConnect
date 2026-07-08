# PaycomConnect — deployment on the monitoring-jira.uz VM

This document answers the operational questions before deploying PaycomConnect
next to the existing **Tamada** stack on the GCP VM `35.223.106.176`:

- Is there enough disk space?
- Which ports are free?
- How do we expose it on a separate subdomain via nginx?
- Will the VM handle the extra load?

All numbers below were measured on the live VM (Ubuntu 25.10, 2 vCPU, 7.7 GiB RAM).

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

Then run §4 to publish it on the subdomain, and (optionally) set the Telegram
webhook:

```bash
npm run setup:telegram -- --webhook   # uses TELEGRAM_WEBHOOK_URL from .env
```

---

## 6a. Git on the VM + rebuilding the image

To pull/push code and rebuild the container from the VM, git needs to be
configured once. Two helper scripts do this:

### One-time git setup

```bash
# In the repo directory on the VM:
GIT_USER_NAME="Deploy Bot" \
GIT_USER_EMAIL="deploy@paycom" \
GIT_REMOTE_URL="https://github.com/begzod11111/PaycomConnect.git" \
GIT_BRANCH="master" \
GITHUB_TOKEN="ghp_xxx"            # optional PAT (repo scope) for HTTPS push/pull
./deploy/setup-git.sh
```

`deploy/setup-git.sh` is idempotent and:

- marks the repo as a **safe.directory** (fixes "detected dubious ownership" on a
  shared VM),
- sets the commit **identity** (`user.name` / `user.email`),
- sets `pull.ff only` for predictable pulls,
- sets the **origin** remote,
- optionally stores a **GitHub token** so HTTPS `git pull` / `git push` are not
  prompted (`credential.helper store` → `~/.git-credentials`, chmod 600),
- switches off a **detached HEAD** onto the target branch (common after a deploy
  checked out a specific commit).

> Prefer SSH? Skip `GITHUB_TOKEN`, add a deploy key to the VM
> (`~/.ssh/id_ed25519`) and register its public part on GitHub, then use an
> `git@github.com:...` URL for `GIT_REMOTE_URL`.

### Pull + rebuild + restart

```bash
./deploy/deploy.sh                 # git pull -> docker build -> up -d -> health check
NO_PULL=1 ./deploy/deploy.sh       # rebuild the current checkout without pulling
GIT_BRANCH=master ./deploy/deploy.sh
```

`deploy/deploy.sh` fast-forward-pulls the branch, rebuilds the image via
`docker compose build`, restarts with `docker compose up -d`, prunes dangling
images, and polls `/api/health` until the container is healthy (printing recent
logs and failing if it never comes up).

---

## 6b. Viewing the local dashboard (private)

The app serves a small inspection dashboard (logs / messages / connections /
system) at `/api/dashboard` — see [`local-dashboard.md`](./local-dashboard.md).
It is **not** exposed publicly:

- The nginx site config **returns 404 for `/api/dashboard`**, so it can never be
  reached through `https://paycom.monitoring-jira.uz`.
- In production it is also **disabled by default** (`NODE_ENV=production`); set
  `ENABLE_DASHBOARD=true` in `.env` to turn it on for local viewing.

Reach it over an SSH tunnel to the loopback-bound container port:

```bash
# On your laptop:
ssh -L 9010:127.0.0.1:9010 <user>@35.223.106.176
# then open in your browser:
#   http://localhost:9010/api/dashboard
```

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
