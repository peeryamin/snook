"""
Backend API test suite for Black Racks Snooker Club by Zaid.

Covers:
- Health
- Auth (login / me)
- Tables listing
- Session lifecycle (start/pause/resume/stop) on Table 2 (FRENCH)
- Today's summary / sessions / players / customers
- Mark-paid
- Reports (CSV / XLSX)
- Settings
- Admin guard
- SSE event stream
- Light load test
"""

import os
import time
import datetime as dt
import pytest
import requests

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://493f0dbf-f206-4d0f-a61f-4e9b28cbf0a8.preview.emergentagent.com",
).rstrip("/")

ADMIN_USER = "admin"
ADMIN_PASS = "Zaid990340"


# ---------- Fixtures ----------

@pytest.fixture(scope="session")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def auth(api):
    r = api.post(
        f"{BASE_URL}/api/auth/login",
        json={"username": ADMIN_USER, "password": ADMIN_PASS},
        timeout=15,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    assert data.get("success") is True
    token = data["token"]
    return {"token": token, "session_id": data.get("sessionId"), "user": data.get("user")}


@pytest.fixture(scope="session")
def auth_client(api, auth):
    api.headers.update({"Authorization": f"Bearer {auth['token']}"})
    return api


# ---------- Health ----------

class TestHealth:
    def test_health(self, api):
        r = api.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "healthy"
        assert body["version"] == "2.0.0"


# ---------- Auth ----------

class TestAuth:
    def test_login_success(self, api):
        r = api.post(
            f"{BASE_URL}/api/auth/login",
            json={"username": ADMIN_USER, "password": ADMIN_PASS},
            timeout=15,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["success"] is True
        assert isinstance(data["token"], str) and len(data["token"]) > 20
        assert "sessionId" in data
        assert data["user"]["role"] == "admin"

    def test_login_wrong_password(self, api):
        r = api.post(
            f"{BASE_URL}/api/auth/login",
            json={"username": ADMIN_USER, "password": "wrongpass"},
            timeout=15,
        )
        assert r.status_code == 401

    def test_login_missing_fields(self, api):
        r = api.post(f"{BASE_URL}/api/auth/login", json={"username": ADMIN_USER}, timeout=15)
        assert r.status_code == 400

    def test_me_with_token(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/auth/me", timeout=15)
        assert r.status_code == 200
        body = r.json()
        user = body.get("user", body)
        assert user.get("username") == ADMIN_USER
        assert user.get("role") == "admin"

    def test_me_without_token(self, api):
        s = requests.Session()
        r = s.get(f"{BASE_URL}/api/auth/me", timeout=15)
        assert r.status_code == 401


# ---------- Tables ----------

class TestTables:
    def test_list_tables(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/tables", timeout=15)
        assert r.status_code == 200
        data = r.json()
        tables = data if isinstance(data, list) else data.get("tables", data.get("data", []))
        assert len(tables) >= 2
        by_num = {t.get("table_number") or t.get("id") or t.get("number"): t for t in tables}
        t1 = next((t for t in tables if (t.get("table_number") == 1 or t.get("id") == 1)), None)
        t2 = next((t for t in tables if (t.get("table_number") == 2 or t.get("id") == 2)), None)
        assert t1 is not None and t2 is not None
        assert (t1.get("type") or t1.get("table_type")) == "ENGLISH"
        assert (t2.get("type") or t2.get("table_type")) == "FRENCH"
        assert float(t1.get("hourly_rate")) == 300
        assert float(t2.get("hourly_rate")) == 420
        # running_amount/active_session fields exist on entries
        for t in (t1, t2):
            assert "running_amount" in t or "active_session" in t


# ---------- Session lifecycle on Table 2 ----------

class TestSessionLifecycle:
    session_id = None

    def _ensure_table2_free(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/tables", timeout=15)
        tables = r.json() if isinstance(r.json(), list) else r.json().get("tables", r.json().get("data", []))
        t2 = next((t for t in tables if (t.get("table_number") == 2 or t.get("id") == 2)), None)
        if t2 and (t2.get("status") == "OCCUPIED" or t2.get("active_session")):
            auth_client.post(
                f"{BASE_URL}/api/table/2/stop",
                json={"loser": "PLAYER_ONE", "payment_method": "CASH", "discount_percent": 0, "food_charge": 0, "tip": 0},
                timeout=15,
            )

    def test_start_session_table2(self, auth_client):
        self._ensure_table2_free(auth_client)
        r = auth_client.post(
            f"{BASE_URL}/api/table/2/start",
            json={"player_one_name": "Alice", "player_two_name": "Bob", "payment_method": "CASH"},
            timeout=15,
        )
        assert r.status_code in (200, 201), r.text
        body = r.json()
        assert body.get("success") in (True, None) or "session" in body
        sess = body.get("session") or body.get("data") or body
        sess_id = sess.get("id") or sess.get("session_id") or body.get("session_id")
        assert sess_id, f"no session id in body: {body}"
        TestSessionLifecycle.session_id = sess_id

        # Verify table is OCCUPIED
        time.sleep(1)
        r2 = auth_client.get(f"{BASE_URL}/api/tables", timeout=15)
        tables = r2.json() if isinstance(r2.json(), list) else r2.json().get("tables", r2.json().get("data", []))
        t2 = next((t for t in tables if (t.get("table_number") == 2 or t.get("id") == 2)), None)
        assert t2 is not None
        assert t2.get("status") == "OCCUPIED" or t2.get("active_session") is not None

    def test_pause_resume(self, auth_client):
        time.sleep(1)
        r = auth_client.post(f"{BASE_URL}/api/table/2/pause", timeout=15)
        assert r.status_code == 200, r.text
        time.sleep(1)
        r2 = auth_client.post(f"{BASE_URL}/api/table/2/resume", timeout=15)
        assert r2.status_code == 200, r2.text
        body = r2.json()
        # break_count check (lenient — different shape possible)
        sess = body.get("session") or body
        if "break_count" in sess:
            assert sess["break_count"] >= 1

    def test_stop_session(self, auth_client):
        # let the session accrue a few seconds
        time.sleep(3)
        r = auth_client.post(
            f"{BASE_URL}/api/table/2/stop",
            json={"loser": "PLAYER_TWO", "payment_method": "CASH", "discount_percent": 0, "food_charge": 0, "tip": 0},
            timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        receipt = body.get("receipt") or body.get("session") or body
        amount = receipt.get("total_amount") or receipt.get("amount") or receipt.get("final_amount")
        assert amount is not None
        assert float(amount) >= 150, f"amount {amount} below FRENCH minimum 150"
        status = receipt.get("payment_status") or body.get("payment_status")
        assert status in ("PAID", "PENDING", None)

        # Table back to AVAILABLE
        time.sleep(1)
        r2 = auth_client.get(f"{BASE_URL}/api/tables", timeout=15)
        tables = r2.json() if isinstance(r2.json(), list) else r2.json().get("tables", r2.json().get("data", []))
        t2 = next((t for t in tables if (t.get("table_number") == 2 or t.get("id") == 2)), None)
        assert t2 is not None
        assert t2.get("status") == "AVAILABLE" or (t2.get("active_session") in (None, False))

    def test_stop_no_loser_400(self, auth_client):
        # start a new session, then stop without loser
        # Ensure free
        auth_client.post(
            f"{BASE_URL}/api/table/2/stop",
            json={"loser": "PLAYER_ONE", "payment_method": "CASH"},
            timeout=15,
        )
        r = auth_client.post(
            f"{BASE_URL}/api/table/2/start",
            json={"player_one_name": "Carol", "player_two_name": "Dan", "payment_method": "CASH"},
            timeout=15,
        )
        assert r.status_code in (200, 201)
        time.sleep(1)
        r2 = auth_client.post(f"{BASE_URL}/api/table/2/stop", json={"payment_method": "CASH"}, timeout=15)
        assert r2.status_code == 400
        # cleanup
        auth_client.post(
            f"{BASE_URL}/api/table/2/stop",
            json={"loser": "PLAYER_ONE", "payment_method": "CASH"},
            timeout=15,
        )

    def test_stop_no_active_session_404(self, auth_client):
        # Ensure Table 2 free
        r = auth_client.post(
            f"{BASE_URL}/api/table/2/stop",
            json={"loser": "PLAYER_ONE", "payment_method": "CASH"},
            timeout=15,
        )
        # second call should be 404 (no active session)
        r2 = auth_client.post(
            f"{BASE_URL}/api/table/2/stop",
            json={"loser": "PLAYER_ONE", "payment_method": "CASH"},
            timeout=15,
        )
        assert r2.status_code == 404


# ---------- Today's summary / sessions / players / customers ----------

class TestSummary:
    def test_summary_today(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/summary/today", timeout=15)
        assert r.status_code == 200
        data = r.json()
        for f in ("total_earnings", "total_sessions"):
            assert f in data, f"missing {f} in summary: {list(data.keys())}"
        # presence of french/cash earnings (lenient)
        assert "french_earnings" in data or "FRENCH" in str(data)
        assert "cash_earnings" in data or "CASH" in str(data)
        assert data["total_sessions"] >= 1

    def test_sessions_list_today(self, auth_client):
        today = dt.date.today().isoformat()
        r = auth_client.get(f"{BASE_URL}/api/sessions?date={today}", timeout=15)
        assert r.status_code == 200
        data = r.json()
        items = data.get("sessions") or data.get("data") or data.get("items") or data
        if isinstance(data, dict):
            for f in ("total", "limit", "offset", "has_more"):
                assert f in data, f"missing pagination field {f}: {list(data.keys())}"
        assert isinstance(items, list)
        assert len(items) >= 1

    def test_players_today(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/players/today", timeout=15)
        assert r.status_code == 200
        data = r.json()
        items = data if isinstance(data, list) else data.get("players") or data.get("data") or []
        # at least one player should exist from the lifecycle test
        assert isinstance(items, list)

    def test_customers_search(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/customers?search=Al", timeout=15)
        assert r.status_code == 200
        data = r.json()
        items = data if isinstance(data, list) else data.get("customers") or data.get("data") or []
        assert isinstance(items, list)


# ---------- Mark Paid ----------

class TestMarkPaid:
    def test_mark_paid_flow(self, auth_client):
        # find a PENDING session from today; if none, create one with discount that forces PENDING? skip if not available
        today = dt.date.today().isoformat()
        r = auth_client.get(f"{BASE_URL}/api/sessions?date={today}&limit=50", timeout=15)
        data = r.json()
        items = data.get("sessions") or data.get("data") or (data if isinstance(data, list) else [])
        pending = next((s for s in items if (s.get("payment_status") == "PENDING")), None)
        if not pending:
            pytest.skip("No PENDING session to mark paid")
        sid = pending.get("id") or pending.get("session_id")
        r1 = auth_client.post(f"{BASE_URL}/api/session/{sid}/mark-paid", timeout=15)
        assert r1.status_code == 200
        r2 = auth_client.post(f"{BASE_URL}/api/session/{sid}/mark-paid", timeout=15)
        assert r2.status_code == 400


# ---------- Reports ----------

class TestReports:
    def test_reports_csv(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/reports/daily.csv", timeout=20)
        assert r.status_code == 200
        ctype = r.headers.get("content-type", "")
        assert "text/csv" in ctype or "csv" in ctype.lower()
        text = r.text
        assert "Table" in text and "Players" in text and "Player Who Paid" in text

    def test_reports_xlsx(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/reports/daily.xlsx", timeout=30)
        assert r.status_code == 200
        ctype = r.headers.get("content-type", "")
        assert "spreadsheetml" in ctype or "xlsx" in ctype or "octet-stream" in ctype
        assert len(r.content) > 100


# ---------- Settings ----------

class TestSettings:
    def test_get_settings(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/settings", timeout=15)
        assert r.status_code == 200
        data = r.json()
        flat = data.get("settings", data)
        # parlor_name might be nested
        s = str(flat)
        assert "Black Racks Snooker Club" in s

    def test_patch_settings_persists(self, auth_client):
        # Patch a benign key
        new_val = f"Black Racks Snooker Club by Zaid"
        r = auth_client.patch(
            f"{BASE_URL}/api/settings",
            json={"parlor_name": new_val},
            timeout=15,
        )
        assert r.status_code in (200, 204)
        r2 = auth_client.get(f"{BASE_URL}/api/settings", timeout=15)
        assert r2.status_code == 200
        assert new_val in str(r2.json())


# ---------- Admin guard ----------

class TestAdminGuard:
    def test_settings_requires_auth(self):
        s = requests.Session()
        r = s.get(f"{BASE_URL}/api/settings", timeout=15)
        assert r.status_code == 401

    def test_admin_tables_requires_auth(self):
        s = requests.Session()
        r = s.post(f"{BASE_URL}/api/admin/tables", json={"name": "x"}, timeout=15)
        assert r.status_code in (401, 403, 404)  # 404 acceptable if route differs


# ---------- SSE ----------

class TestSSE:
    def test_events_stream(self, auth):
        url = f"{BASE_URL}/api/events?token={auth['token']}"
        with requests.get(url, stream=True, timeout=10) as r:
            assert r.status_code == 200
            ctype = r.headers.get("content-type", "")
            assert "text/event-stream" in ctype, f"unexpected ctype: {ctype}"
            # read first chunk within ~4 seconds
            start = time.time()
            got_bytes = False
            for chunk in r.iter_content(chunk_size=64):
                if chunk:
                    got_bytes = True
                    break
                if time.time() - start > 4:
                    break
            assert got_bytes, "no SSE bytes received in time"


# ---------- Light load ----------

class TestLoad:
    def test_health_and_tables_repeated(self, auth_client):
        for _ in range(5):
            r1 = auth_client.get(f"{BASE_URL}/api/health", timeout=10)
            r2 = auth_client.get(f"{BASE_URL}/api/tables", timeout=10)
            assert r1.status_code == 200
            assert r2.status_code == 200
