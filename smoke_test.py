"""Smoke test: drive the shared runtime without the N.E.K.O. host.

只依赖本仓库的 ``moneta_fx`` 引擎包，可在任意机器上直接运行：

    python smoke_test.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from moneta_fx.engine import TradeError, metrics, place_order
from moneta_fx.market import OFFLINE_SYMBOLS, WATCHLIST
from moneta_fx.world import MarketRuntime


def check(label, condition):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        raise SystemExit(f"smoke test failed at: {label}")


runtime = MarketRuntime(initial_balance=100000.0, tick_interval_ms=100000, persist_interval_ms=100000)
world = runtime.world

check("market bootstrapped with bars", len(world.market.bars) == len(WATCHLIST))
check("bars have history", all(len(bars) > 300 for bars in world.market.bars.values()))
check("watchlist quoted", all(s in runtime.all_quotes() for s in WATCHLIST))
check("symbol universe", "EUR/USD" in OFFLINE_SYMBOLS and len(OFFLINE_SYMBOLS) > 300)

# register + login
registered = runtime.register("trader_one", "password123")
check("register returns player", registered["user"]["role"] == "player")
logged = runtime.login("trader_one", "password123")
check("login returns token", len(logged["token"]) == 64)

user = runtime.world.player(registered["user"]["id"])
second = None  # filled in later
account = user["account"]
check("initial balance", account["balance"] == 100000.0)

quotes = runtime.all_quotes()
now = world.market.time

# market order
position = place_order(account, {"symbol": "EUR/USD", "side": "buy", "type": "market", "lots": 0.10}, quotes, now)
check("market order filled", position["lots"] == 0.10 and len(account["positions"]) == 1)
check("commission charged", account["balance"] < 100000.0)

# margin / free margin sanity
m = metrics(account, quotes)
check("margin used", m["margin"] > 0)
check("free margin reduced", m["freeMargin"] < 100000.0)

# limit order
pending = place_order(account, {"symbol": "EUR/USD", "side": "buy", "type": "limit", "lots": 0.05,
                               "price": quotes["EUR/USD"]["bid"] * 0.99}, quotes, now)
check("limit order pending", pending["type"] == "limit" and len(account["pending"]) == 1)

# protection
place_order(account, {"symbol": "EUR/USD", "side": "sell", "type": "market", "lots": 0.10,
                      "sl": quotes["EUR/USD"]["ask"] * 1.001, "tp": quotes["EUR/USD"]["bid"] * 0.999}, quotes, now)
check("protection accepted", len(account["positions"]) == 2)

# run simulation steps
for _ in range(40):
    runtime.advance(1.0)
check("market advanced", world.market.time > now)
check("bars recorded", len(world.market.bars["EUR/USD"]) > 0)

# close via runtime (idempotent request id)
snapshot = runtime.trade(user, {"action": "close", "id": position["id"], "requestId": "req-1", "accountId": user["id"]})
check("close via runtime", len(snapshot["book"]["account"]["positions"]) == 1)
again = runtime.trade(user, {"action": "close", "id": position["id"], "requestId": "req-1", "accountId": user["id"]})
check("duplicate request id is idempotent", again["book"]["account"] == snapshot["book"]["account"])

# developer control
developer = world.developer()
before = world.market.values["EUR"]
runtime.control(developer, {"kind": "price", "symbol": "EUR/USD", "price": 1.10})
check("price control applied", abs(world.market.values["EUR"] - 1.10) < 1e-9)

runtime.control(developer, {"kind": "trend", "currency": "GBP", "percent": 2.0, "seconds": 60})
check("trend plan created", len(world.plans) == 1)
runtime.advance(30.0)
check("trend executing", world.plans and world.plans[0]["remaining"] < 60)

runtime.control(developer, {"kind": "cancel-trends"})
check("trends cancelled", world.plans == [])

runtime.control(developer, {"kind": "clock", "speed": 20, "paused": False})
check("clock control", world.speed == 20)

runtime.control(developer, {"kind": "volatility", "value": 3.0})
check("volatility control", world.market.volatility == 3.0)

runtime.control(developer, {"kind": "event", "event": "storm"})
check("event control", "风暴" in world.market.event)

# funding
second = runtime.world.player(runtime.register("trader_two", "password123")["user"]["id"])
funded = runtime.fund(developer, {"requestId": "fund-1", "kind": "credit", "accountId": second["id"],
                                  "amount": 5000, "reason": "新手练习奖励"})
check("credit applied", funded["entry"]["changes"][0]["deltaCents"] == 500000)
dup = runtime.fund(developer, {"requestId": "fund-1", "kind": "credit", "accountId": second["id"],
                               "amount": 5000, "reason": "新手练习奖励"})
check("funding idempotent", dup["duplicate"] is True)

transferred = runtime.fund(developer, {"requestId": "fund-2", "kind": "transfer", "accountId": second["id"],
                                       "destinationId": registered["user"]["id"], "amount": 1000, "reason": "测试转账"})
check("transfer applied", len(transferred["entry"]["changes"]) == 2)

admin = runtime.admin_accounts()
check("admin lists players", admin["totals"]["accounts"] == 2)
detail = runtime.admin_account_detail(second["id"])
check("admin detail", detail["user"]["username"] == "trader_two")
ledger = runtime.admin_ledger()
check("ledger entries", ledger["total"] == 2)

# validation guards
try:
    runtime.login("trader_one", "wrong-password")
    check("bad password rejected", False)
except TradeError as error:
    check("bad password rejected", "用户名或密码不正确" in str(error))

try:
    runtime.register("trader_one", "password123")
    check("duplicate username rejected", False)
except TradeError as error:
    check("duplicate username rejected", "用户名已存在" in str(error))

try:
    place_order(account, {"symbol": "XXX/YYY", "side": "buy", "type": "market", "lots": 0.10}, quotes, now)
    check("invalid symbol rejected", False)
except TradeError as error:
    check("invalid symbol rejected", "尚无可用报价" in str(error))

try:
    place_order(account, {"symbol": "EUR/USD", "side": "buy", "type": "market", "lots": 0.001}, quotes, now)
    check("invalid lots rejected", False)
except TradeError as error:
    check("invalid lots rejected", "手数" in str(error))

# persistence round-trip
state = runtime.snapshot_state()
runtime2 = MarketRuntime(initial_balance=100000.0, tick_interval_ms=100000, persist_interval_ms=100000)
runtime2.load(state, saved_at_ms=None)
check("state round-trip users", len(runtime2.world.users) == len(world.users))
check("state round-trip balance", runtime2.world.player(second["id"])["account"]["balance"] == second["account"]["balance"])
check("state round-trip funding", len(runtime2.world.funding["entries"]) == 2)

# resume market backfill
runtime3 = MarketRuntime(initial_balance=100000.0, tick_interval_ms=100000, persist_interval_ms=100000)
runtime3.load(state, saved_at_ms=int(time.time() * 1000) - 7200000)
check("resume backfilled", len(runtime3.world.gaps) == 1)
check("resume kept users", len(runtime3.world.users) == len(world.users))

# report
report_user = user
print("\n--- report sample ---")
print("balance:", round(report_user["account"]["balance"], 2))
print("positions:", len(report_user["account"]["positions"]))
print("history:", len(report_user["account"]["history"]))
print("journal:", len(report_user["account"]["journal"]))
print("\nALL SMOKE TESTS PASSED")
