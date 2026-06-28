# Black Racks Snooker Club

A complete web application for table management, session billing, and customer tracking at Black Racks Snooker Club by Zaid.

This project is built as a browser-based admin dashboard with a Node.js backend, SQLite storage, and a progressive web app-style frontend. It is ready to run on a local club PC, inside Docker, or in the cloud.

## Quick start (development)

```bash
cd server
cp .env.example .env
npm install
npm start
```

Open `http://localhost:8080/login.html` in a browser.

Default administrator login:

- Username: `admin`
- Password: `Zaid990340`

> Recommended: change the default password before handing the app to the client.

## Deploy for production

See **[DEPLOY.md](DEPLOY.md)** for Docker, club PC, and cloud (Render) deployment instructions.

After deployment, share the final URL with the client so they can use the web app every day.

Send your client **[CLIENT_GUIDE.md](CLIENT_GUIDE.md)**.

## What is included

| Table   | Rate      | Minimum |
|---------|-----------|---------|
| Table 1 | Rs.5/min  | Rs.100  |
| Table 2 | Rs.7/min  | Rs.150  |

Bill = max(minimum, minutes × rate per minute).

## Configuration (`server/.env`)

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Required — long random string |
| `CORS_ORIGIN` | Your app URL in production |
| `REPORT_EMAIL_TO` | Daily report email |
| `SMTP_*` | Email sending |
| `DB_PATH` | SQLite file path (Docker: `/data/parlor.db`) |

## Change admin password

```bash
node scripts/set-admin-password.js "YourNewPassword"
```
(Run from the `server` folder, or `npm run set-password -- "YourNewPassword"`)
