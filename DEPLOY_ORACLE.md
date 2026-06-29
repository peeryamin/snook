# Deploy Black Racks on Oracle Cloud (Always Free)

A complete guide to host the Black Racks Snooker Club app on a free-forever
Oracle Cloud VM with Docker. Time required: ~20 minutes the first time.

You get: a public URL accessible from anywhere, persistent SQLite database,
SSE real-time updates working, automatic restart on reboot, all for ₹0/month.

---

## Part 1 — Create the free VM (10 min)

### 1.1 Sign up
1. Go to https://www.oracle.com/cloud/free/ → **Start for free**
2. Pick your region (closest to India: **Mumbai** or **Hyderabad**)
3. Verify with a credit/debit card (no charge — required only for identity)
4. After verification, sign in to the Oracle Cloud Console

### 1.2 Create the VM
1. Top-left menu → **Compute** → **Instances** → **Create instance**
2. Name: `black-racks`
3. **Image and shape** → click **Edit** → **Change shape**
   - Shape series: **Ampere** (ARM-based, the truly-free one)
   - Shape name: `VM.Standard.A1.Flex`
   - OCPUs: `2`, Memory: `12 GB` (well within Always Free limits)
4. **Image**: pick **Ubuntu 22.04** (or latest LTS)
5. **Networking**:
   - Keep "Create new virtual cloud network" selected
   - ✅ **Assign a public IPv4 address**
6. **SSH keys**:
   - ✅ Generate a key pair for me
   - Click **Save private key** — keep this `.key` file safe, you need it to log in
7. **Storage**: default 47 GB is fine
8. Click **Create**

Wait ~1 minute for the instance status to go green (**RUNNING**). Note the
**Public IP address** shown on the instance page — you'll need it.

### 1.3 Open ports 80 + 443 in the firewall
1. On the instance page, click the **Subnet** link under "Primary VNIC"
2. Click the **Default Security List**
3. **Add Ingress Rules** → add two rules:
   - Source CIDR `0.0.0.0/0`, Destination port `80` (HTTP)
   - Source CIDR `0.0.0.0/0`, Destination port `443` (HTTPS)
4. Save

---

## Part 2 — Log in and install Docker (5 min)

On your laptop, open a terminal in the folder where you saved the `.key` file:

```bash
chmod 600 your-key.key                 # macOS / Linux only
ssh -i your-key.key ubuntu@<PUBLIC_IP>
```

On Windows use **PowerShell** or **PuTTY** with the same key.

Once logged in:

```bash
# Install Docker (one-time)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker

# Open ports inside the VM firewall (Ubuntu's local iptables)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

---

## Part 3 — Deploy the app (5 min)

### 3.1 Clone your repo on the VM
```bash
git clone <YOUR_REPO_URL> black-racks
cd black-racks
```

### 3.2 Create the env file
```bash
cp server/.env.example server/.env
nano server/.env
```

Set at minimum:
```
PORT=8080
HOST=0.0.0.0
NODE_ENV=production
JWT_SECRET=<paste a long random string, e.g. from `openssl rand -base64 48`>
CORS_ORIGIN=http://<PUBLIC_IP>
CLUB_TIMEZONE=Asia/Kolkata
DB_PATH=/data/parlor.db
```

Save (`Ctrl+O`, Enter, `Ctrl+X`).

### 3.3 Start it
```bash
docker compose up -d
```

Wait ~30 seconds for the image to build. Verify it's running:
```bash
docker compose ps
docker compose logs -f --tail=50
```
You should see `Server running on http://0.0.0.0:8080`.

### 3.4 Point port 80 at the app
```bash
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080
sudo netfilter-persistent save
```

Now open **http://\<PUBLIC_IP\>/login.html** in any browser, anywhere.

Default login: `admin` / `Zaid990340` — **change this immediately**:
```bash
docker compose exec parlor node scripts/set-admin-password.js "YourNewPassword"
```

---

## Part 4 — Optional polish

### 4.1 Custom domain
Buy a cheap domain (Namecheap, GoDaddy, ~₹800/year), point an **A record** at
your `<PUBLIC_IP>`. Then update `server/.env`:
```
CORS_ORIGIN=https://blackracks.club
```
and restart: `docker compose restart`.

### 4.2 Free HTTPS with Caddy (recommended)
Replace the iptables port-forward with Caddy as a reverse proxy — gives you
auto-renewing Let's Encrypt SSL with zero config.

Create `/home/ubuntu/black-racks/Caddyfile`:
```
blackracks.club {
    reverse_proxy localhost:8080
}
```

Add to `docker-compose.yml` (under `services:`):
```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

`docker compose up -d` → HTTPS works in 30 seconds. Then update CORS_ORIGIN
to `https://blackracks.club`.

### 4.3 Nightly backup (recommended)
```bash
crontab -e
```
Add:
```
0 23 * * * cp /home/ubuntu/black-racks/data/parlor.db /home/ubuntu/backups/parlor-$(date +\%F).db
```
And `mkdir -p /home/ubuntu/backups`. For off-site backup, scp this folder to
Google Drive / Dropbox using `rclone`.

---

## Part 5 — Daily operations

| Need | Command (run on the VM) |
|---|---|
| Update the app after a `git push` | `git pull && docker compose up -d --build` |
| View live logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` |
| Change admin password | `docker compose exec parlor node scripts/set-admin-password.js "NewPass"` |
| Manual backup | `cp data/parlor.db ~/backups/manual-$(date +%F).db` |
| See disk usage | `du -sh data/` |

---

## Always Free limits (you'll stay well under)

- ✅ 2 ARM Ampere A1 VMs total (4 OCPU + 24 GB RAM combined)
- ✅ 200 GB block storage
- ✅ 10 TB outbound traffic / month
- ✅ Forever (no trial expiry)

For a snooker club, your app uses ~50 MB RAM and ~10 MB/month traffic.
You're nowhere near the limits.

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Can't reach `http://<IP>/` | Re-check VCN ingress rules (Part 1.3) AND the iptables REDIRECT command (Part 3.4) |
| `502 Bad Gateway` | `docker compose ps` — if `parlor` is not "Up", run `docker compose logs` |
| Database locked / corrupted | Restore from backup: `docker compose down`, replace `data/parlor.db`, `docker compose up -d` |
| Lost the SSH key | Use Oracle Console → Instance → Console connection (in-browser terminal) |
| App is slow | `docker stats` — if RAM is high, the cron daily-reset is fine; otherwise reboot the VM |

That's it. Free, persistent, real-time, accessible from anywhere.
