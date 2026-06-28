# Deployment Guide — Black Racks Snooker Club

## Option 1: Docker at the club (recommended)

Best for a counter tablet on the club Wi‑Fi. No monthly cloud fee.

### On the club PC (Windows/Mac/Linux with Docker Desktop)

1. Copy the whole `SnookerParlorManagement` folder to the club PC.

2. Create production env file:
   ```bash
   cp server/.env.example server/.env
   ```
   Edit `server/.env`:
   ```env
   NODE_ENV=production
   JWT_SECRET=put-a-long-random-string-here-min-32-chars
   CORS_ORIGIN=http://localhost:8080
   ```

3. Set a real admin password (default is `Zaid990340`):
   ```bash
   cd server && npm install
   node scripts/set-admin-password.js "YourSecurePasswordHere"
   ```

4. Start with Docker:
   ```bash
   docker compose up -d --build
   ```

5. On the counter tablet (same Wi‑Fi), open:
   ```
   http://<CLUB-PC-IP>:8080/login.html
   ```
   Find the PC IP: Mac `ipconfig getifaddr en0` / Windows `ipconfig`

6. Add to tablet home screen (Chrome → Add to Home screen).

### Stop / restart
```bash
docker compose down
docker compose up -d
```

Data is stored in Docker volume `black-racks-data` (survives restarts).

---

## Option 2: No Docker — Node.js on club PC

```bash
cd server
cp .env.example .env
# edit .env — set JWT_SECRET and NODE_ENV=production
npm install
node scripts/set-admin-password.js "YourPassword"
npm start
```

Open `http://localhost:8080` or `http://<PC-IP>:8080` from tablet.

Keep the terminal open, or use PM2:
```bash
npm install -g pm2
pm2 start server.js --name black-racks
pm2 save
pm2 startup
```

---

## Option 3: Cloud (Render.com)

Access from anywhere (phone, home, club).

1. Push this project to **your own** GitHub repo (not the original author’s).

2. Sign up at [render.com](https://render.com).

3. **New → Blueprint** → connect repo → Render reads `render.yaml`.

4. After deploy, set in Render dashboard:
   - `CORS_ORIGIN` = your Render URL (e.g. `https://black-racks-snooker.onrender.com`)
   - `REPORT_EMAIL_TO`, SMTP vars (optional)

5. Change admin password via Render shell or locally against exported DB.

**Note:** Render free tier sleeps when idle; **Starter plan ($7/mo)** keeps it always on.

---

## Before handing to Zaid

- [ ] Change password from `Zaid990340`
- [ ] Set strong `JWT_SECRET`
- [ ] Test Start → Stop → Mark as Paid on tablet
- [ ] Send him `CLIENT_GUIDE.md`
- [ ] Give URL + username + password (WhatsApp or printout)

---

## Handoff package for client

Send Zaid:
1. **URL** (e.g. `http://192.168.1.50:8080/login.html`)
2. **Username:** `admin`
3. **Password:** (the one you set)
4. **CLIENT_GUIDE.md** (how to use the app)

Your contact for support.
