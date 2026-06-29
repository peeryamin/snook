"""
FastAPI bridge for the Black Racks Snooker Club Node.js/Express app.

Supervisor launches this on port 8001 (uvicorn server:app).
On startup we spawn the original Express server (/app/server/server.js) on an
internal port (127.0.0.1:8002) and proxy every request — including the
Server-Sent Events stream at /api/events — straight through to it.

The original Node/Express + SQLite code in /app/server/* is left untouched.
"""

import asyncio
import os
import signal
import subprocess
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

NODE_HOST = "127.0.0.1"
NODE_PORT = 8002
NODE_BASE = f"http://{NODE_HOST}:{NODE_PORT}"
NODE_DIR = "/app/server"
NODE_ENTRY = "server.js"

_node_proc: subprocess.Popen | None = None
_client: httpx.AsyncClient | None = None


def _start_node() -> subprocess.Popen:
    env = os.environ.copy()
    env["PORT"] = str(NODE_PORT)
    env["HOST"] = NODE_HOST
    env["NODE_ENV"] = env.get("NODE_ENV", "production")
    env.setdefault("JWT_SECRET", "black-racks-preview-jwt-secret-change-in-prod-7f3a9d2e1b8c4e6a")
    env.setdefault("CORS_ORIGIN", "*")
    env.setdefault("CLUB_TIMEZONE", "Asia/Kolkata")
    env.setdefault("DB_PATH", "/app/server/parlor.db")

    proc = subprocess.Popen(
        ["node", NODE_ENTRY],
        cwd=NODE_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        preexec_fn=os.setsid,
    )
    return proc


def _wait_for_node(timeout: float = 30.0) -> None:
    import urllib.request
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{NODE_BASE}/api/health", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception as e:
            last_err = e
        time.sleep(0.5)
    raise RuntimeError(f"Node server did not become ready: {last_err}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _node_proc, _client
    _node_proc = _start_node()
    try:
        await asyncio.to_thread(_wait_for_node, 30.0)
    except Exception as exc:
        if _node_proc and _node_proc.poll() is None:
            os.killpg(os.getpgid(_node_proc.pid), signal.SIGTERM)
        raise

    _client = httpx.AsyncClient(base_url=NODE_BASE, timeout=None)
    try:
        yield
    finally:
        if _client is not None:
            await _client.aclose()
        if _node_proc and _node_proc.poll() is None:
            try:
                os.killpg(os.getpgid(_node_proc.pid), signal.SIGTERM)
                try:
                    _node_proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(os.getpgid(_node_proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass


app = FastAPI(lifespan=lifespan)


HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-encoding",
    "content-length",
}


def _filter_headers(headers) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in HOP_BY_HOP and k.lower() != "host"}


@app.get("/api/events")
async def proxy_events(request: Request):
    """Streaming proxy for Server-Sent Events."""
    assert _client is not None
    params = dict(request.query_params)
    headers = _filter_headers(request.headers)
    req = _client.build_request("GET", "/api/events", params=params, headers=headers)
    upstream = await _client.send(req, stream=True)

    async def gen():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    resp_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP}
    return StreamingResponse(
        gen(),
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type", "text/event-stream"),
    )


@app.api_route(
    "/{full_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy_all(full_path: str, request: Request):
    assert _client is not None
    url = "/" + full_path
    headers = _filter_headers(request.headers)
    body = await request.body()

    upstream = await _client.request(
        request.method,
        url,
        params=dict(request.query_params),
        headers=headers,
        content=body,
    )

    resp_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP}
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )
