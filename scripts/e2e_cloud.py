"""End-to-end test against the running cloud server."""

import json
import os
import secrets
import urllib.error
import urllib.request

BASE = os.getenv("MONETA_E2E_BASE", "http://127.0.0.1:4180")
# 随机用户名，测试可以重复运行而不会撞上已存在的账户。
USERNAME = f"tester{secrets.token_hex(3)}"
PASSED = []
FAILED = []


def request(method: str, path: str, body: dict | None = None, headers: dict | None = None, cookie: str | None = None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Moneta-Request", "1")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}, response.headers.get("Set-Cookie")
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {"raw": raw.decode(errors="replace")}
        return error.code, payload, error.headers.get("Set-Cookie")


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(label)
        print(f"[PASS] {label}")
    else:
        FAILED.append(label)
        print(f"[FAIL] {label} {detail}")


# 1. 注册
status, payload, cookie = request("POST", "/api/auth/register", {"username": USERNAME, "password": "password123"})
check("register", status == 200 and payload.get("user", {}).get("role") == "player", str(payload))

# 2. 会话
status, payload, _ = request("GET", "/api/session", cookie=cookie)
check("session after register", status == 200 and payload.get("user", {}).get("username") == USERNAME, str(payload))

# 3. 报价
status, payload, _ = request("GET", "/api/quotes?symbols=EUR/USD,GBP/USD")
quotes = {q["symbol"]: q for q in payload.get("quotes", [])}
check("quotes", status == 200 and "EUR/USD" in quotes and quotes["EUR/USD"]["mid"] > 0, str(payload)[:200])

# 4. 历史
status, payload, _ = request("GET", "/api/history?symbol=EUR/USD")
check("history bars", status == 200 and len(payload.get("bars", [])) > 100, f"bars={len(payload.get('bars', []))}")

# 5. 世界状态
status, payload, _ = request("GET", "/api/world/state?symbol=EUR/USD", cookie=cookie)
check("world state", status == 200 and payload.get("book", {}).get("account", {}).get("balance") == 100000.0, str(payload)[:200])

# 6. 市价买入
status, payload, _ = request("POST", "/api/world/trade?symbol=EUR/USD", {
    "action": "order",
    "order": {"symbol": "EUR/USD", "side": "buy", "type": "market", "lots": 0.10},
    "requestId": "e2e-order-1",
}, cookie=cookie)
account = payload.get("book", {}).get("account", {})
check("market order", status == 200 and len(account.get("positions", [])) == 1, str(payload)[:300])
position_id = account["positions"][0]["id"] if account.get("positions") else None

# 7. 幂等重放
status, payload, _ = request("POST", "/api/world/trade?symbol=EUR/USD", {
    "action": "order",
    "order": {"symbol": "EUR/USD", "side": "buy", "type": "market", "lots": 0.10},
    "requestId": "e2e-order-1",
}, cookie=cookie)
check("idempotent replay", status == 200 and len(payload.get("book", {}).get("account", {}).get("positions", [])) == 1, str(payload)[:200])

# 8. 限价挂单
quote = quotes["EUR/USD"]
status, payload, _ = request("POST", "/api/world/trade?symbol=EUR/USD", {
    "action": "order",
    "order": {"symbol": "EUR/USD", "side": "buy", "type": "limit", "lots": 0.05, "price": round(quote["mid"] * 0.99, 5)},
    "requestId": "e2e-order-2",
}, cookie=cookie)
check("limit order", status == 200 and len(payload.get("book", {}).get("account", {}).get("pending", [])) == 1, str(payload)[:200])
pending_id = payload["book"]["account"]["pending"][0]["id"]

# 9. 撤单
status, payload, _ = request("POST", "/api/world/trade?symbol=EUR/USD", {"action": "cancel", "id": pending_id, "requestId": "e2e-cancel-1"}, cookie=cookie)
check("cancel order", status == 200 and len(payload.get("book", {}).get("account", {}).get("pending", [])) == 0, str(payload)[:200])

# 10. 改止损止盈
status, payload, _ = request("POST", "/api/world/trade?symbol=EUR/USD", {
    "action": "modify", "id": position_id,
    "sl": round(quote["mid"] * 0.995, 5), "tp": round(quote["mid"] * 1.005, 5),
    "requestId": "e2e-modify-1",
}, cookie=cookie)
position = payload.get("book", {}).get("account", {}).get("positions", [{}])[0]
check("modify protection", status == 200 and position.get("sl") is not None and position.get("tp") is not None, str(payload)[:200])

# 11. 平仓
status, payload, _ = request("POST", "/api/world/trade?symbol=EUR/USD", {"action": "close", "id": position_id, "requestId": "e2e-close-1"}, cookie=cookie)
account = payload.get("book", {}).get("account", {})
check("close position", status == 200 and len(account.get("positions", [])) == 0 and len(account.get("history", [])) == 1, str(payload)[:200])

# 12. 未登录不能交易
status, payload, _ = request("POST", "/api/world/trade", {"action": "closeAll", "requestId": "e2e-noauth"})
check("trade requires auth", status == 401, str(payload))

# 13. 普通账户不能控制行情
status, payload, _ = request("POST", "/api/world/control", {"kind": "clock", "speed": 5}, cookie=cookie)
check("control requires developer", status == 403, str(payload))

# 14. 开发者登录
status, payload, dev_cookie = request("POST", "/api/auth/developer", {"key": "moneta-dev-key"})
check("developer login", status == 200 and payload.get("user", {}).get("role") == "developer", str(payload)[:200])

# 15. 错误密钥
status, payload, _ = request("POST", "/api/auth/developer", {"key": "wrong-key"})
check("developer rejects bad key", status == 403, str(payload))

# 16. 行情控制
status, payload, _ = request("POST", "/api/world/control?symbol=EUR/USD", {"kind": "price", "symbol": "EUR/USD", "price": 1.10}, cookie=dev_cookie)
check("price control", status == 200, str(payload)[:200])

status, payload, _ = request("POST", "/api/world/control?symbol=EUR/USD", {"kind": "trend", "currency": "GBP", "percent": 2, "seconds": 60}, cookie=dev_cookie)
check("trend control", status == 200, str(payload)[:200])

status, payload, _ = request("GET", "/api/world/admin", cookie=dev_cookie)
check("admin snapshot", status == 200 and len(payload.get("plans", [])) == 1, str(payload)[:200])

# 17. 管理接口
headers = {"X-Admin-Password": "admin-pass"}
status, payload, _ = request("GET", "/api/admin/accounts", headers=headers, cookie=dev_cookie)
mine = next((a for a in payload.get("accounts", []) if a.get("username") == USERNAME), None)
check("admin accounts", status == 200 and mine is not None and payload.get("totals", {}).get("accounts", 0) >= 1, str(payload)[:200])
player_id = mine["id"] if mine else None

status, payload, _ = request("GET", f"/api/admin/account?id={player_id}", headers=headers, cookie=dev_cookie)
check("admin account detail", status == 200 and payload.get("user", {}).get("username") == USERNAME, str(payload)[:200])

# 18. 资金调度
FUND_REQUEST_ID = f"e2e-fund-{secrets.token_hex(4)}"
status, payload, _ = request("POST", "/api/admin/funding", {
    "requestId": FUND_REQUEST_ID, "kind": "credit", "accountId": player_id, "amount": 5000, "reason": "端到端测试入金",
}, headers=headers, cookie=dev_cookie)
check("funding credit", status == 200 and payload.get("entry", {}).get("amountCents") == 500000, str(payload)[:200])

status, payload, _ = request("GET", "/api/admin/ledger?limit=10", headers=headers, cookie=dev_cookie)
ledger_has_mine = any(
    entry.get("requestId") == FUND_REQUEST_ID for entry in payload.get("entries", [])
)
check("funding ledger", status == 200 and ledger_has_mine, str(payload)[:200])

# 19. 口令错误
status, payload, _ = request("GET", "/api/admin/accounts", headers={"X-Admin-Password": "nope"}, cookie=dev_cookie)
check("admin rejects bad password", status == 403, str(payload)[:200])

# 20. 静态资源
for asset in ("/styles.css", "/js/app.js", "/js/engine.js", "/js/market.js", "/js/chart.js", "/js/store.js", "/js/admin.js", "/js/tutorial.js", "/js/shared.js", "/icon.svg"):
    try:
        with urllib.request.urlopen(f"{BASE}{asset}", timeout=10) as response:
            check(f"asset {asset}", response.status == 200 and len(response.read()) > 100)
    except Exception as error:  # noqa: BLE001
        check(f"asset {asset}", False, str(error))

# 21. 退出登录
status, payload, _ = request("POST", "/api/auth/logout", {}, cookie=cookie)
check("logout", status == 200 and payload.get("user") is None, str(payload))
status, payload, _ = request("GET", "/api/session", cookie=cookie)
check("session cleared after logout", payload.get("user") is None, str(payload))

print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
if FAILED:
    raise SystemExit(1)
print("ALL CLOUD E2E TESTS PASSED")
