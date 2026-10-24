import { createAccount } from './engine.js';
import { bootstrapMarket } from './market.js';
const prefix = 'moneta.fx.v1.';
export function createBook(mode) {
    const now = Date.now();
    const market = mode === 'offline' ? bootstrapMarket() : undefined;
    return { version: 1, mode, account: createAccount(mode, market?.time ?? now), market, quotes: {}, bars: market?.bars ?? {}, selected: 'EUR/USD' };
}
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const symbol = (value) => typeof value === 'string' && /^[A-Z]{3}\/[A-Z]{3}$/.test(value);
const validSettings = (s) => s && [10, 20, 30, 50, 100, 200, 500].includes(s.leverage) && finite(s.spreadMultiplier) && s.spreadMultiplier >= 0.5 && s.spreadMultiplier <= 10 && finite(s.slippage) && s.slippage >= 0 && s.slippage <= 20 && finite(s.commission) && s.commission >= 0 && s.commission <= 100 && finite(s.swapLong) && Math.abs(s.swapLong) <= 100 && finite(s.swapShort) && Math.abs(s.swapShort) <= 100;
export function validateBook(value, mode) {
    if (!value || typeof value !== 'object')
        throw new Error('存档格式不正确');
    const book = value;
    const account = book.account;
    if (book.version !== 1 || book.mode !== mode || !account || account.version !== 1 || account.mode !== mode || !finite(account.balance) || !finite(account.initialBalance) || account.initialBalance <= 0 || !validSettings(account.settings) || !Number.isInteger(account.lastRollover) || Math.abs(account.lastRollover) > 100000 || !symbol(book.selected))
        throw new Error('存档账户或模式无效');
    for (const list of [account.positions, account.pending, account.history, account.journal, account.equityCurve])
        if (!Array.isArray(list) || list.length > 20000)
            throw new Error('存档记录数量或结构不正确');
    for (const p of [...account.positions, ...account.history]) {
        if (!p || typeof p.id !== 'string' || !symbol(p.symbol) || !['buy', 'sell'].includes(p.side) || !finite(p.lots) || p.lots < 0.01 || p.lots > 1000 || Math.abs(p.lots * 100 - Math.round(p.lots * 100)) > 0.000001 || !finite(p.entry) || p.entry <= 0 || !finite(p.margin) || p.margin < 0 || !finite(p.openedAt) || !finite(p.swap) || !finite(p.openCommission) || !finite(p.lastPnl) || [p.sl, p.tp].some(v => v !== undefined && (!finite(v) || v <= 0)))
            throw new Error('存档持仓参数不正确');
    }
    for (const trade of account.history)
        if (!finite(trade.exit) || trade.exit <= 0 || !finite(trade.closedAt) || !finite(trade.pnl) || !finite(trade.netPnl) || !finite(trade.closeCommission) || typeof trade.reason !== 'string')
            throw new Error('存档历史交易不正确');
    for (const p of account.pending)
        if (!p || typeof p.id !== 'string' || !symbol(p.symbol) || !['buy', 'sell'].includes(p.side) || !['limit', 'stop'].includes(p.type) || !finite(p.lots) || p.lots < 0.01 || p.lots > 1000 || !finite(p.price) || p.price <= 0 || !finite(p.createdAt) || [p.sl, p.tp].some(v => v !== undefined && (!finite(v) || v <= 0)))
            throw new Error('存档挂单参数不正确');
    if (account.journal.some(j => !j || !finite(j.time) || typeof j.message !== 'string' || !['info', 'trade', 'warning'].includes(j.kind)) || account.equityCurve.some(p => !p || !finite(p.time) || !finite(p.value)))
        throw new Error('存档日志或净值不正确');
    if (!book.quotes || !book.bars || typeof book.quotes !== 'object' || typeof book.bars !== 'object')
        throw new Error('存档行情不正确');
    for (const [key, q] of Object.entries(book.quotes))
        if (!symbol(key) || !q || q.symbol !== key || !finite(q.mid) || q.mid <= 0 || !finite(q.bid) || q.bid <= 0 || !finite(q.ask) || q.ask < q.bid || !finite(q.time) || typeof q.marketOpen !== 'boolean')
            throw new Error('存档报价不正确');
    for (const [key, bars] of Object.entries(book.bars))
        if (!symbol(key) || !Array.isArray(bars) || bars.length > 2000 || bars.some(b => !b || !finite(b.time) || [b.open, b.high, b.low, b.close].some(v => !finite(v) || v <= 0)))
            throw new Error('存档 K 线不正确');
    if (mode === 'offline') {
        const market = book.market;
        if (!market || !Number.isInteger(market.seed) || !finite(market.time) || !finite(market.volatility) || market.volatility < 1 || market.volatility > 100 || typeof market.event !== 'string')
            throw new Error('离线行情状态不正确');
        for (const dict of [market.values, market.anchor, market.baseline, market.shock])
            if (!dict || typeof dict !== 'object' || Object.entries(dict).some(([key, v]) => !/^[A-Z]{3}$/.test(key) || !finite(v)))
                throw new Error('离线货币状态不正确');
        if (market.values.USD !== 1 || !market.values.EUR || Object.values(market.values).some(v => v <= 0))
            throw new Error('离线货币价格不正确');
        market.bars = book.bars;
    }
    else if (book.market)
        throw new Error('在线存档不可包含虚构行情');
    return book;
}
export function loadBook(mode) {
    const data = localStorage.getItem(prefix + mode);
    return data ? validateBook(JSON.parse(data), mode) : createBook(mode);
}
export const serializeBook = (book, spacing) => JSON.stringify({ ...book, market: book.market ? { ...book.market, bars: {} } : undefined }, null, spacing);
export function saveBook(book) { localStorage.setItem(prefix + book.mode, serializeBook(book)); }
export const saveKey = (mode) => prefix + mode;
export function downloadBook(book) {
    const blob = new Blob([serializeBook(book, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `MONETA-FX-${book.mode}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
