"""MONETA FX 独立服务端 — 原版 UI 1:1 + Python 交易引擎。

用法：
    uv run --with fastapi --with uvicorn --with pydantic python server/app.py

环境变量：
    MONETA_HOST            监听地址（默认 0.0.0.0）
    MONETA_PORT            监听端口（默认 4173）
    MONETA_DATA_DIR        共享市场存档目录（默认 ./data）
    MONETA_DEVELOPER_KEY   开发者密钥（默认 moneta-dev-key）
    MONETA_PUBLIC_DOMAIN   对外域名，用于识别隧道转发请求
    MONETA_INITIAL_BALANCE 新账户初始资金（默认 100000）
    MONETA_TICK_MS         市场心跳间隔毫秒（默认 250）
    MONETA_PERSIST_MS      自动存档间隔毫秒（默认 5000）
    MONETA_ADMIN_PASSWORD  管理员面板口令（未设置时只允许本机访问）
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from moneta_fx import auth
from moneta_fx.engine import TradeError
from moneta_fx.market import OFFLINE_SYMBOLS, WATCHLIST
from moneta_fx.world import MarketRuntime

HOST = os.getenv("MONETA_HOST", "0.0.0.0")
PORT = int(os.getenv("MONETA_PORT", "4173"))
DATA_DIR = Path(os.getenv("MONETA_DATA_DIR", str(Path(__file__).resolve().parent / "data")))
DEVELOPER_KEY = os.getenv("MONETA_DEVELOPER_KEY", "moneta-dev-key")
PUBLIC_DOMAIN = os.getenv("MONETA_PUBLIC_DOMAIN", "").strip()
INITIAL_BALANCE = float(os.getenv("MONETA_INITIAL_BALANCE", "100000"))
TICK_MS = int(os.getenv("MONETA_TICK_MS", "250"))
PERSIST_MS = int(os.getenv("MONETA_PERSIST_MS", "5000"))
ADMIN_PASSWORD = os.getenv("MONETA_ADMIN_PASSWORD", "")
STATE_PATH = DATA_DIR / "world.json"
STATIC_DIR = Path(__file__).resolve().parent / "static"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}

runtime = MarketRuntime(
    initial_balance=INITIAL_BALANCE,
    tick_interval_ms=TICK_MS,
    persist_interval_ms=PERSIST_MS,
)
runtime._developer_key = DEVELOPER_KEY
runtime._admin_password = ADMIN_PASSWORD

app = FastAPI(title="MONETA FX", docs_url=None, redoc_url=None)


# ── 持久化 ─────────────────────────────────────────────────────────────
def load_state() -> None:
    if not STATE_PATH.exists():
        return
    try:
        import json

        raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        saved_at = raw.pop("_savedAtMs", None)
        runtime.load(raw, saved_at_ms=saved_at)
    except Exception as error:  # pragma: no cover - defensive
        print(f"[moneta] 存档读取失败，已重新开局：{error}")


def save_state() -> None:
    try:
        import json

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        state = runtime.snapshot_state()
        state["_savedAtMs"] = int(time.time() * 1000)
        temp = STATE_DIR_TMP
        temp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        temp.replace(STATE_PATH)
    except Exception as error:  # pragma: no cover - defensive
        print(f"[moneta] 存档写入失败：{error}")


STATE_DIR_TMP = DATA_DIR / "world.tmp"

runtime.persist = lambda force=False: save_state()  # type: ignore[assignment]


@app.on_event("startup")
async def _startup() -> None:
    load_state()
    runtime.start()
    asyncio.create_task(_autosave())


@app.on_event("shutdown")
async def _shutdown() -> None:
    runtime.stop()
    save_state()


async def _autosave() -> None:
    while True:
        await asyncio.sleep(max(1.0, PERSIST_MS / 1000.0))
        save_state()


# ── 工具 ──────────────────────────────────────────────────────────────
def json_response(payload: Dict[str, Any], status: int = 200, headers: Optional[Dict[str, str]] = None) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers=headers or {"Cache-Control": "no-store"})


def error_response(message: str, status: int) -> JSONResponse:
    return json_response({"error": message}, status=status)


def client_address(request: Request) -> str:
    forwarded = request.headers.get("cf-connecting-ip")
    if PUBLIC_DOMAIN and request.headers.get("host") == PUBLIC_DOMAIN and _is_loopback(request.client.host if request.client else ""):
        if forwarded and _is_ip(forwarded):
            return forwarded
    return request.client.host if request.client and request.client.host else "unknown"


def _is_loopback(host: str) -> bool:
    if not host:
        return False
    if host.lower().rstrip(".") == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def from_tunnel(request: Request) -> bool:
    return bool(
        PUBLIC_DOMAIN
        and request.headers.get("host") == PUBLIC_DOMAIN
        and _is_loopback(request.client.host if request.client else "")
        and request.headers.get("x-forwarded-proto") == "https"
        and _is_ip(request.headers.get("cf-connecting-ip") or "")
    )


def secure_cookie(request: Request) -> bool:
    return bool(request.url.scheme == "https" or (request.client and request.client.port == 443) or from_tunnel(request))


def session_token(request: Request) -> Optional[str]:
    return auth.read_cookie(request.headers.get("cookie"))


def current_user(request: Request) -> Optional[Dict[str, Any]]:
    token = session_token(request)
    user_id = runtime.sessions.user_id(token) if token else None
    return runtime.world.find(user_id) if user_id else None


def require_user(request: Request) -> Dict[str, Any]:
    user = current_user(request)
    if user is None:
        raise TradeError("请先登录虚构市场账户", status=401)
    return user


async def read_json(request: Request) -> Dict[str, Any]:
    if request.method != "POST":
        raise TradeError("此操作需要 POST", status=405)
    if request.headers.get("x-moneta-request") != "1" or not (request.headers.get("content-type") or "").startswith("application/json"):
        raise TradeError("请求来源或格式不正确", status=403)
    if request.headers.get("origin"):
        try:
            origin_host = urlparse(request.headers["origin"]).hostname
        except ValueError:
            raise TradeError("请求来源不正确", status=403)
        if origin_host != (request.headers.get("host") or "").split(":")[0]:
            raise TradeError("禁止跨站修改账户或行情", status=403)
    chunks: List[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 32768:
            raise TradeError("请求内容过大", status=413)
        chunks.append(chunk)
    import json

    try:
        body = json.loads(b"".join(chunks).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise TradeError("JSON 格式不正确", status=400)
    if not isinstance(body, dict):
        raise TradeError("请求内容不正确", status=400)
    return body


def snapshot_for(user: Optional[Dict[str, Any]], selected: str = "EUR/USD") -> Dict[str, Any]:
    if user is None:
        return {"user": None, "market": runtime.admin_snapshot(), "selected": selected}
    return runtime.snapshot(user, selected)


# ── 页面 ──────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


# ── 行情 API（原版兼容） ──────────────────────────────────────────────
@app.get("/api/config")
async def api_config() -> JSONResponse:
    return json_response({
        "source": "MONETA FX 虚构市场",
        "configured": True,
        "pollSeconds": max(1, TICK_MS // 1000),
        "staleSeconds": 180,
        "trial": False,
    })


@app.get("/api/symbols")
async def api_symbols() -> JSONResponse:
    return json_response({"symbols": [{"symbol": s, "group": "FX"} for s in WATCHLIST], "source": "MONETA FX"})


@app.get("/api/quotes")
async def api_quotes(symbols: str = "EUR/USD") -> JSONResponse:
    wanted = list(dict.fromkeys((symbols or "EUR/USD").split(",")))
    if not wanted or len(wanted) > 12 or any(not _valid_symbol(s) for s in wanted):
        return error_response("最多请求 12 个有效 FX 货币对", status=400)
    quotes = runtime.all_quotes()
    result = []
    errors = []
    for symbol in wanted:
        quote = quotes.get(symbol)
        if not quote:
            errors.append({"symbol": symbol, "message": "该货币对暂不可用"})
            continue
        baseline = runtime.world.market.baseline
        base, term = symbol.split("/")
        previous = baseline.get(base, 1) / baseline.get(term, 1)
        result.append({
            "symbol": symbol,
            "mid": quote["mid"],
            "time": quote["time"] // 1000,
            "marketOpen": True,
            "previousClose": previous,
            "changePercent": (quote["mid"] / previous - 1) * 100 if previous else 0,
        })
    return json_response({"quotes": result, "errors": errors, "source": "MONETA FX", "receivedAt": auth.now_ms()})


@app.get("/api/history")
async def api_history(symbol: str = "EUR/USD") -> JSONResponse:
    if not _valid_symbol(symbol):
        return error_response("货币对格式不正确", status=400)
    bars = runtime.world.market.bars.get(symbol)
    if bars is None:
        quotes = runtime.all_quotes()
        quote = quotes.get(symbol)
        if not quote:
            return error_response("该货币对暂不可用", status=400)
        runtime.world.market.bars[symbol] = []
        from moneta_fx.market import record_quote

        record_quote(runtime.world.market.bars[symbol], quote)
        bars = runtime.world.market.bars[symbol]
    payload = [
        {"time": bar["time"], "open": bar["open"], "high": bar["high"], "low": bar["low"], "close": bar["close"]}
        for bar in bars[-400:]
    ]
    return json_response({"symbol": symbol, "bars": payload, "source": "MONETA FX"})


def _valid_symbol(symbol: Any) -> bool:
    return isinstance(symbol, str) and symbol in OFFLINE_SYMBOLS


# ── 世界 API ──────────────────────────────────────────────────────────
@app.get("/api/session")
async def api_session(request: Request) -> JSONResponse:
    user = current_user(request)
    return json_response({"user": MarketRuntime.profile(user)})


@app.post("/api/auth/register")
@app.post("/api/auth/login")
@app.post("/api/auth/developer")
async def api_auth(request: Request) -> JSONResponse:
    route = request.url.path
    try:
        body = await read_json(request)
        address = client_address(request)
        runtime.limiter.check(address)
        if route.endswith("developer"):
            if not auth.constant_time_equal(body.get("key"), DEVELOPER_KEY):
                runtime.limiter.denied(address)
                raise TradeError("开发者密钥不正确", status=403)
            user = runtime.world.developer()
            if user is None:
                raise TradeError("开发者账户不存在", status=404)
            result = runtime._start_session(user)
        else:
            username = body.get("username")
            password = body.get("password")
            if route.endswith("register"):
                try:
                    result = runtime.register(username, password, address=address)
                except TradeError as error:
                    if "用户名" in str(error) or "密码" in str(error):
                        runtime.limiter.denied(address)
                    raise
            else:
                try:
                    result = runtime.login(username, password, address=address)
                except TradeError:
                    runtime.limiter.denied(address)
                    raise
        response = json_response({"user": result["user"]})
        response.set_cookie(
            auth.SESSION_COOKIE,
            result["token"],
            path="/",
            httponly=True,
            samesite="strict",
            max_age=auth.SESSION_TTL_MS // 1000,
            secure=secure_cookie(request),
        )
        return response
    except TradeError as error:
        return error_response(str(error), status=error.status)


@app.post("/api/auth/logout")
async def api_logout(request: Request) -> JSONResponse:
    token = session_token(request)
    if token:
        runtime.logout(token)
    response = json_response({"user": None})
    response.set_cookie(auth.SESSION_COOKIE, "", path="/", httponly=True, samesite="strict", max_age=0)
    return response


@app.get("/api/world/state")
async def api_world_state(request: Request, symbol: str = "EUR/USD") -> JSONResponse:
    try:
        user = current_user(request)
        return json_response(snapshot_for(user, symbol))
    except TradeError as error:
        return error_response(str(error), status=error.status)


@app.get("/api/world/admin")
async def api_world_admin(request: Request) -> JSONResponse:
    try:
        user = require_user(request)
        if user["role"] != "developer":
            raise TradeError("只有开发者可以查看行情控制台", status=403)
        return json_response(runtime.admin_snapshot())
    except TradeError as error:
        return error_response(str(error), status=error.status)


@app.post("/api/world/control")
async def api_world_control(request: Request, symbol: str = "EUR/USD") -> JSONResponse:
    try:
        user = require_user(request)
        body = await read_json(request)
        runtime.control(user, body)
        return json_response(snapshot_for(user, symbol))
    except TradeError as error:
        return error_response(str(error), status=error.status)


@app.post("/api/world/trade")
async def api_world_trade(request: Request, symbol: str = "EUR/USD") -> JSONResponse:
    try:
        user = require_user(request)
        body = await read_json(request)
        body.setdefault("requestId", secrets.token_hex(8))
        body.setdefault("accountId", user["id"])
        return json_response(runtime.trade(user, body))
    except TradeError as error:
        return error_response(str(error), status=error.status)


# ── 管理 API ──────────────────────────────────────────────────────────
def require_admin(request: Request) -> None:
    user = current_user(request)
    if user is None or user["role"] != "developer":
        raise TradeError("只有管理员可以管理账户和资金", status=403)
    if ADMIN_PASSWORD:
        supplied = request.headers.get("x-admin-password", "")
        if not auth.constant_time_equal(supplied, ADMIN_PASSWORD):
            raise TradeError("管理员口令不正确", status=403)
    elif not _is_loopback(request.client.host if request.client else ""):
        raise TradeError("未配置管理员口令，仅允许本机访问", status=403)


@app.get("/api/admin/accounts")
async def api_admin_accounts(request: Request) -> JSONResponse:
    try:
        require_admin(request)
        return json_response(runtime.admin_accounts())
    except TradeError as error:
        return error_response(str(error), status=error.status)


@app.get("/api/admin/account")
async def api_admin_account(request: Request, id: str, limit: int = 100, before: Optional[int] = None) -> JSONResponse:
    try:
        require_admin(request)
        return json_response(runtime.admin_account_detail(id, limit=limit, before=before))
    except TradeError as error:
        return error_response(str(error), status=error.status)


@app.get("/api/admin/ledger")
async def api_admin_ledger(request: Request, accountId: Optional[str] = None, limit: int = 20, before: Optional[int] = None) -> JSONResponse:
    try:
        require_admin(request)
        return json_response(runtime.admin_ledger(account_id=accountId, limit=limit, before=before))
    except TradeError as error:
        return error_response(str(error), status=error.status)


@app.post("/api/admin/funding")
async def api_admin_funding(request: Request) -> JSONResponse:
    try:
        user = require_user(request)
        require_admin(request)
        body = await read_json(request)
        body.setdefault("requestId", secrets.token_hex(8))
        return json_response(runtime.fund(user, body))
    except TradeError as error:
        return error_response(str(error), status=error.status)


@app.post("/api/admin/shutdown")
async def api_admin_shutdown(request: Request) -> JSONResponse:
    try:
        require_user(request)
        require_admin(request)
        await read_json(request)
    except TradeError as error:
        return error_response(str(error), status=error.status)
    save_state()
    asyncio.create_task(_shutdown())
    return json_response({"stopped": True})


# ── WebSocket：实时推送 ───────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    token = websocket.cookies.get(auth.SESSION_COOKIE)
    user_id = runtime.sessions.user_id(token)
    user = runtime.world.find(user_id) if user_id else None
    selected = "EUR/USD"
    try:
        while True:
            message = await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
            import json

            try:
                payload = json.loads(message)
            except ValueError:
                continue
            if isinstance(payload, dict) and _valid_symbol(payload.get("symbol")):
                selected = payload["symbol"]
            await websocket.send_text(json.dumps(snapshot_for(user, selected), ensure_ascii=False, default=str))
    except WebSocketDisconnect:
        return
    except asyncio.TimeoutError:
        pass

    # 定时推送
    try:
        while True:
            await asyncio.sleep(TICK_MS / 1000.0)
            await websocket.send_text(json.dumps(snapshot_for(user, selected), ensure_ascii=False, default=str))
    except WebSocketDisconnect:
        return


# 静态资源放在最后：路径参数会匹配一切，必须让 API 路由先注册。
@app.get("/{file_path:path}")
async def static_files(file_path: str) -> Response:
    if file_path.startswith("api/"):
        return error_response("接口不存在", status=404)
    relative = file_path or "index.html"
    target = (STATIC_DIR / relative).resolve()
    try:
        target.relative_to(STATIC_DIR.resolve())
    except ValueError:
        return error_response("文件不存在", status=404)
    if not target.is_file():
        return error_response("文件不存在", status=404)
    suffix = target.suffix.lower()
    return FileResponse(
        str(target),
        media_type=MIME.get(suffix, "application/octet-stream"),
        headers={"Cache-Control": "no-cache"},
    )


def main() -> None:
    import uvicorn

    print(f"MONETA FX 已启动：http://{HOST}:{PORT}")
    print(f"数据目录：{DATA_DIR}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
