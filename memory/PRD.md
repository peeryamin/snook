# Black Racks Snooker Club by Zaid — PRD

## Origin
Existing repo brought by user. Node.js + Express + SQLite monolith, vanilla-JS PWA frontend.
Bridged into Emergent preview via FastAPI proxy (`/app/backend/server.py`) → Node on 127.0.0.1:8002,
and a tiny Express static host (`/app/frontend/serve.js`) for `/app/web` on :3000.

## Original problem statement (verbatim)
"do you have my repo" → "Assume Default and Proceed" → "Run the testing agent across the whole API/UI"
→ Feature request (2026-01-29): Loser pays the game-time bill; food billed PER PLAYER (two separate
bills at checkout because we don't know who ordered what); replace "Player One/Player Two" labels in
the stop modal with the actual entered names; in history block the session is still recorded as ONE
session (not split); **don't include tips**.

## User
Single-admin snooker club operator (Zaid). Login: `admin / Zaid990340`. Two tables: T1 ENGLISH
₹5/min (min ₹100), T2 FRENCH ₹7/min (min ₹150). Billed per minute (ceil) with minimum charge.

## Implemented (with dates)
- 2026-01-29 — Bridged repo into preview (FastAPI proxy + static host), installed deps, verified all 25 backend tests + UI critical flows passing (100%).
- 2026-01-29 — **Per-player split billing**:
  - DB: added `food_charge_p1`, `food_items_p1`, `food_charge_p2`, `food_items_p2` (idempotent migration).
  - `POST /api/table/:id/stop`: accepts new per-player fields; returns `receipt.bills[]` with two bills (loser pays game + their food, winner pays only their food). Legacy `food_charge` + `tip` still accepted for back-compat.
  - Tip removed from billing math; receipt total = game + food_p1 + food_p2.
  - CSV/XLSX export: replaced single "Food/Tip" columns with `Food P1`, `Food Items P1`, `Food P2`, `Food Items P2`, `Food Total`.
  - UI: stop modal now shows player names in radio + food labels, two-bill live preview, no tip field. History table replaces "Tip" column with "Food (P1)" & "Food (P2)". Stored as one session row.

## Backlog (next-up)
- P1: Add ENGLISH/FRENCH badge on each table card (cosmetic note from initial test run).
- P1: "Print receipt" — per-player printable receipts using the new `receipt.bills[]` payload (e.g. open `window.print()`-friendly modal or send WhatsApp).
- P2: Per-player payment status (loser CASH, winner UPI) — currently single `payment_method` per session.
- P2: Daily / monthly revenue chart on dashboard.
- P2: Member discounts & loyalty redemption flow.
- P3: Add more tables through the admin UI.
- P3: Hard-reset / DB cleanup workflow polish.

## Files
- Backend bridge: `/app/backend/server.py`
- Static host: `/app/frontend/serve.js`
- Original API: `/app/server/server.js`, `/app/server/db.js`, `/app/server/schema.sql`
- Original frontend: `/app/web/index.html`, `/app/web/app.js`, `/app/web/styles.css`
- Tests: `/app/backend/tests/backend_test.py` (25 pytest cases)
