# Free deployment (Oracle / office PC / Cloudflare free tier)

One stack, any host. Everything here is free. Check each provider's current free-tier terms before relying on them.

```
Users -> Cloudflare (DNS + CDN + HTTPS, free) -> Tunnel -> [Primary host]  app + backup
                                                              |
                                              Supabase Postgres (free, off-host data)
                       [Standby host, powered off or stopped]  same stack, SSD/HDD backups
```

## Pick the hosts
| Role | Best free choice | Notes |
|---|---|---|
| Primary | Oracle Always Free **A1 ARM** (up to 4 cores, 24 GB) | Image builds on ARM. Retry the region if capacity is full. |
| Primary (small) | Oracle `E2.1.Micro` (1 GB) or Google `e2-micro` | Needs 4 GB swap. Build the image elsewhere (see below). |
| Standby | Office PC or mini PC with an **SSD** | Same stack. Start it only if the primary is down. |
| Backup disk | **HDD** (USB or internal) on the standby | Set `BACKUP_DIR` to it. HDD is fine for backups, SSD for the live data. |
| Database | Supabase free Postgres | Keeps data off the VM. Use the session pooler, not port 6543. |
| DNS, CDN, HTTPS, tunnel | Cloudflare free | Tunnel needs no open ports. |
| Monitoring | UptimeRobot free (5 min checks) | Also stops Oracle treating the VM as idle. |

## 1. Cloudflare Tunnel (once)
Zero Trust -> Networks -> Tunnels -> Create (Cloudflared). Copy the token into `.env` as `TUNNEL_TOKEN`.
Public hostname: `os.swk.properties` -> service `http://swkos:8080`.

## 2. Primary host
```bash
# Oracle: Ubuntu 22.04. Micro/e2-micro only, add swap first:
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/swkpropertiesuae/swkpropertiesOS.git && cd swkpropertiesOS
cp .env.example .env && nano .env   # APP_SECRET, passwords, DATABASE_URL, PUBLIC_URL, TUNNEL_TOKEN, BACKUP_DIR
cd deploy/free && docker compose --env-file ../../.env up -d --build
docker compose logs -f swkos
```
1 GB hosts: the build can run out of memory. Build on your PC and push, or let CI build and the host `docker compose pull`.

## 3. Speed ("no loading")
- Cloudflare -> Caching -> Cache Rules: **cache** `URI Path starts with /assets/` (hashed files, cache for 1 year); **bypass** `/api/`.
- Enable Brotli, HTTP/3, Early Hints and "Always Use HTTPS".
- The app is a PWA: after the first visit the shell loads from the device cache instantly.
- Use Supabase in the region nearest the VM (Frankfurt or Mumbai for Dubai users).

## 4. Backups
- The `backup` service copies `/data` daily to `BACKUP_DIR` and keeps 14 days. Point it at an HDD.
- Settings -> Integrations: enable the Cloudflare R2 nightly backup too (R2 has a free 10 GB tier) for an off-site copy.
- Test a restore once: `docker run -v swkos-data:/data -v $PWD/backups:/b alpine tar xzf /b/swkos-DATE.tgz -C /data`.

## 5. Failover (manual, about 2 minutes)
Active/passive only. Never run both hosts' `swkos` at once: the scheduler would run twice.
1. Stop the dead primary's tunnel (or just wait: it is offline).
2. On the standby: copy `.env`, then `docker compose --env-file ../../.env up -d`.
3. Cloudflare routes to whichever connector is online. No DNS change.
With Supabase as the database the standby sees the same data. Uploaded files live on `/data`, so restore the latest backup first.

## What this cannot promise
- Free VMs can be reclaimed or become unavailable. Keep the backups and the standby.
- A single primary means a few minutes of downtime during failover or updates.
- Update with `git pull && docker compose --env-file ../../.env up -d --build`.
