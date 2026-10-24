# MONETA FX 云端服务端

MONETA FX 虚构外汇交易室的独立服务端：**原版 UI 1:1** + Python 交易引擎，可部署到任意云主机或 Docker。

> 全部行情、资金与成交均为虚构游戏数据，不对应任何真实市场，不构成投资建议。

配套的 N.E.K.O. 插件在仓库 [`n.e.k.o_plugin_moneta_fx`](https://github.com/baixiangyuan/n.e.k.o_plugin_moneta_fx)，两者共用同一套交易引擎。

## 快速开始

```bash
# 方式一：直接运行
uv run --with fastapi --with "uvicorn[standard]" --with pydantic python server/app.py

# 方式二：固定依赖
uv venv && uv pip install fastapi "uvicorn[standard]" pydantic
uv run uvicorn server.app:app --host 0.0.0.0 --port 4173

# Windows：双击 start-server.cmd
```

打开 `http://<服务器IP>:4173/` 就是原版交易室界面。

## Docker 部署

```bash
docker compose up -d
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MONETA_HOST` | `0.0.0.0` | 监听地址 |
| `MONETA_PORT` | `4173` | 监听端口 |
| `MONETA_DATA_DIR` | `./data` | 共享市场存档目录 |
| `MONETA_DEVELOPER_KEY` | `moneta-dev-key` | 开发者密钥 |
| `MONETA_ADMIN_PASSWORD` | 空 | 管理员面板口令；未设置时只允许本机访问 |
| `MONETA_PUBLIC_DOMAIN` | 空 | 对外域名，用于识别隧道转发请求 |
| `MONETA_INITIAL_BALANCE` | `100000` | 新账户初始资金 |
| `MONETA_TICK_MS` | `250` | 市场心跳间隔 |
| `MONETA_PERSIST_MS` | `5000` | 自动存档间隔 |

## 目录结构

```text
moneta-fx-server/
├── server/
│   ├── app.py              ← FastAPI 应用
│   └── static/             ← 原版 UI 1:1（index.html / styles.css / js/*）
├── scripts/
│   ├── patch_ui.py         ← 把原版 UI 的真实行情文案改为服务端共享行情
│   └── e2e_cloud.py        ← 端到端测试（35 项）
├── smoke_test.py           ← 引擎冒烟测试（41 项）
├── Dockerfile
├── docker-compose.yml
└── start-server.cmd
```

> `server/app.py` 通过 `sys.path` 引入同级插件仓库的 `moneta_fx` 引擎包，部署时需要把插件仓库的 Python 模块一并复制到容器内（Dockerfile 已处理）。

## API

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/config` | GET | 服务端配置与轮询间隔 |
| `/api/symbols` | GET | 货币对目录 |
| `/api/quotes?symbols=` | GET | 批量报价 |
| `/api/history?symbol=` | GET | 分钟线历史 |
| `/api/session` | GET | 当前登录账户 |
| `/api/auth/register` `login` `developer` `logout` | POST | 账户认证 |
| `/api/world/state` | GET | 账户快照 |
| `/api/world/trade` | POST | 下单/平仓/改单/撤单 |
| `/api/world/control` | POST | 开发者行情控制 |
| `/api/world/admin` | GET | 行情控制台数据 |
| `/api/admin/accounts` `account` `ledger` | GET | 账户管理 |
| `/api/admin/funding` | POST | 入金/扣款/转账 |
| `/api/admin/shutdown` | POST | 关闭服务端 |
| `/ws` | WebSocket | 实时快照推送 |

## 测试

```bash
# 引擎冒烟测试
uv run --python 3.12 python smoke_test.py

# 端到端测试（需服务端已启动）
uv run --python 3.12 python scripts/e2e_cloud.py
```

当前状态：引擎冒烟 41/41 通过，端到端 35/35 通过。

## 与原版的差异

| 项目 | 原版 | 本服务端 |
| --- | --- | --- |
| 行情源 | Twelve Data 真实参考价 + 本地虚构 | 纯虚构（服务端统一生成），无外部依赖 |
| 后端语言 | Node.js | Python（FastAPI） |
| 隧道 | cloudflared 随包分发 | 需自行准备隧道工具 |
| UI | 原版 HTML/CSS/JS | 原版文件 1:1 复用，仅文案调整 |

## 安全提醒

- `MONETA_DEVELOPER_KEY` 与 `MONETA_ADMIN_PASSWORD` 必须在部署前修改。
- 默认绑定 `0.0.0.0`，请配合防火墙或反向代理限制访问。
- 登录接口有每地址 15 次 / 10 分钟的限制；口令使用 scrypt 散列，不落明文。

## 许可

MIT。
