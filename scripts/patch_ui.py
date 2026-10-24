"""Patch the original MONETA FX UI for the cloud (no real quote source)."""

from pathlib import Path

TARGET = Path(r"C:\Users\ADMIN\Downloads\neko-moneta-fx\server\static\js\app.js")

REPLACEMENTS = [
    ("'Twelve Data · 真实参考报价'", "'MONETA FX · 服务端共享行情'"),
    ("'Twelve Data · 参考报价'", "'MONETA FX · 服务端共享行情 · 仅供游戏'"),
    ("'真实参考行情'", "'服务端共享行情'"),
    ("'在线模拟'", "'云端共享'"),
    ("'PAPER TRADING ACCOUNT'", "'CLOUD SHARED ACCOUNT'"),
    ("'ONLINE SETTINGS'", "'CLOUD SETTINGS'"),
    ("'ONLINE PERFORMANCE'", "'CLOUD PERFORMANCE'"),
    ("'在线模拟账户'", "'云端共享账户'"),
    (
        "set('online-note', `Twelve Data ${trial ? '官方试用 · 货币对与额度有限' : '个人密钥'} · 真实中价 + 模拟点差 · 每 60 秒刷新`);",
        "set('online-note', `服务端共享虚构行情 · 模拟点差与成交 · 每 ${Math.max(1, Math.round(pollSeconds))} 秒刷新`);",
    ),
    (
        "<h4>在线：真实参考价 + 模拟成交</h4>",
        "<h4>云端：服务端共享虚构行情</h4>",
    ),
    (
        "<p>来源为 Twelve Data。当前为 ${trial ? '官方 demo 试用' : '服务端个人 API 密钥'}。默认每 60 秒取所选、持仓和必要换算报价；上游时间超过 180 秒或标记休市时拒绝成交。</p>",
        "<p>行情由 MONETA FX 服务端统一生成并持续撮合，所有登录账户看到同一份虚构行情。默认每秒取所选、持仓和必要换算报价；报价时间由服务端市场时钟决定。</p>",
    ),
    (
        "<p>目录提供可搜索的货币对，实际能否取得报价取决于密钥权限、覆盖和额度。试用不保证每一对可用。图表只用来源历史和实际收到的价格，不在两笔报价之间编造在线走势。</p>",
        "<p>货币对目录由服务端提供，覆盖全部主要与交叉盘。图表使用服务端分钟线，不在两笔报价之间编造走势。</p>",
    ),
    (
        "<h4>配置自己的行情密钥</h4><p>把项目里的 .env.example 复制成 .env，填写 <strong>TWELVE_DATA_API_KEY</strong>，重新启动本地服务。密钥留在服务端，网页不会展示或保存它。</p>",
        "<h4>服务端部署</h4><p>通过环境变量 <strong>MONETA_PORT</strong>、<strong>MONETA_DATA_DIR</strong>、<strong>MONETA_DEVELOPER_KEY</strong> 配置服务端；共享市场存档保存在数据目录，重启后只补绘图表，不会补成交。</p>",
    ),
    (
        "<p>离线全部报价均由共同货币过程生成，不对应真实历史。每个模式有自己的账户、行情和 K 线，网络中断时不会自动切换。</p>",
        "<p>云端与离线全部报价均由服务端或本机的共同货币过程生成，不对应真实历史。每个模式有自己的账户、行情和 K 线，网络中断时不会自动切换。</p>",
    ),
    ("'离线引擎运行中'", "'离线引擎运行中'"),
    ("'等待有效真实报价'", "'等待服务端行情'"),
    ("'等待该货币对的真实报价'", "'等待该货币对的服务端报价'"),
    ("'报价已过期，暂时无法成交'", "'报价已暂停，暂时无法成交'"),
    ("'市场休市，暂时无法成交'", "'市场暂停，暂时无法成交'"),
    ("'尚无可用报价'", "'尚无可用报价'"),
    ("先熟悉离线沙盒，再用真实参考报价练习。", "先熟悉离线沙盒，再登录进入服务端共享市场。"),
    ("离线练习与在线模拟各自独立保存。", "离线练习与云端账户各自独立保存。"),
    # 轮询间隔跟随服务端配置
    (
        "    if (result[1].status === 'fulfilled')\n        trial = result[1].value.trial;",
        "    if (result[1].status === 'fulfilled') {\n        trial = result[1].value.trial;\n        pollSeconds = Math.max(1, Number(result[1].value.pollSeconds) || 1);\n    }",
    ),
    (
        "let trial = true;",
        "let trial = true;\nlet pollSeconds = 1;",
    ),
    (
        "        if (Date.now() - lastPoll >= 60000)",
        "        if (Date.now() - lastPoll >= pollSeconds * 1000)",
    ),
]


def main() -> None:
    text = TARGET.read_text(encoding="utf-8")
    applied = 0
    for old, new in REPLACEMENTS:
        if old in text:
            text = text.replace(old, new)
            applied += 1
    TARGET.write_text(text, encoding="utf-8")
    print(f"applied {applied}/{len(REPLACEMENTS)} replacements")


if __name__ == "__main__":
    main()
