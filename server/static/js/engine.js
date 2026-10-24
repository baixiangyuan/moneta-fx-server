const DAY = 86400000;
const rolloverSlot = (time) => Math.floor((time - 22 * 3600000) / DAY);
const uid = () => crypto.randomUUID();
export const DEFAULT_SETTINGS = { leverage: 100, spreadMultiplier: 1, slippage: 0.3, commission: 3, swapLong: -6, swapShort: 1.5 };
export const pipSize = (symbol) => symbol.endsWith('/JPY') ? 0.01 : 0.0001;
export const digits = (symbol) => symbol.endsWith('/JPY') ? 3 : 5;
export function createAccount(mode, time = Date.now(), balance = 100000) {
    return { version: 1, mode, initialBalance: balance, balance, positions: [], pending: [], history: [], journal: [{ time, message: `${mode === 'offline' ? '离线沙盒' : mode === 'shared' ? '共享虚构市场' : '在线模拟'}账户已创建 · ${balance.toLocaleString()} USD 模拟资金`, kind: 'info' }], settings: { ...DEFAULT_SETTINGS }, lastRollover: rolloverSlot(time), equityCurve: [{ time, value: balance }] };
}
export function log(account, time, message, kind = 'info') {
    account.journal.push({ time, message, kind });
    if (account.journal.length > 1000)
        account.journal.shift();
}
function checkQuote(quote, mode, now) {
    if (!quote || !Number.isFinite(quote.mid) || quote.bid <= 0 || quote.ask < quote.bid)
        throw new Error('尚无可用报价');
    if (mode === 'online' && now !== undefined) {
        if (now - quote.time > 180000 || quote.time - now > 30000)
            throw new Error('行情过期，等待新报价后再交易');
        if (!quote.marketOpen)
            throw new Error('市场休市，暂时无法成交');
    }
}
export function currencyToUsd(currency, quotes, mode, now) {
    if (currency === 'USD')
        return 1;
    const queue = [{ currency, factor: 1, path: [] }];
    const visited = new Set([currency]);
    for (const node of queue) {
        for (const quote of Object.values(quotes)) {
            const [base, term] = quote.symbol.split('/');
            if (!(quote.mid > 0) || !Number.isFinite(quote.mid))
                continue;
            const next = base === node.currency ? term : term === node.currency ? base : '';
            if (!next || visited.has(next))
                continue;
            const factor = node.factor * (base === node.currency ? quote.mid : 1 / quote.mid);
            const path = [...node.path, quote];
            if (next === 'USD') {
                for (const item of path)
                    checkQuote(item, mode, now);
                return factor;
            }
            visited.add(next);
            queue.push({ currency: next, factor, path });
        }
    }
    throw new Error(`缺少 ${currency} → USD 换算报价，无法成交`);
}
export function positionPnl(position, quotes) {
    const quote = quotes[position.symbol];
    checkQuote(quote);
    const price = position.side === 'buy' ? quote.bid : quote.ask;
    const [, term] = position.symbol.split('/');
    return (price - position.entry) * (position.side === 'buy' ? 1 : -1) * position.lots * 100000 * currencyToUsd(term, quotes);
}
export function metrics(account, quotes) {
    let unrealized = 0;
    let complete = true;
    for (const position of account.positions) {
        try {
            unrealized += positionPnl(position, quotes);
        }
        catch {
            unrealized += position.lastPnl;
            complete = false;
        }
    }
    const margin = account.positions.reduce((sum, p) => sum + p.margin, 0);
    const equity = account.balance + unrealized;
    return { unrealized, equity, margin, freeMargin: equity - margin, marginLevel: margin ? equity / margin * 100 : Infinity, complete };
}
function validateLots(lots) {
    if (!Number.isFinite(lots) || lots < 0.01 || lots > 1000 || Math.abs(lots * 100 - Math.round(lots * 100)) > 0.000001)
        throw new Error('手数必须是 0.01 至 1000 之间的 0.01 倍数');
}
function validateProtection(side, entry, sl, tp) {
    if (sl !== undefined && (!Number.isFinite(sl) || sl <= 0 || (side === 'buy' ? sl >= entry : sl <= entry)))
        throw new Error('止损价格方向不正确：多单止损低于买价，空单止损高于卖价');
    if (tp !== undefined && (!Number.isFinite(tp) || tp <= 0 || (side === 'buy' ? tp <= entry : tp >= entry)))
        throw new Error('止盈价格方向不正确：多单止盈高于买价，空单止盈低于卖价');
}
function executionPrice(side, quote, slippage) {
    return side === 'buy' ? quote.ask + slippage * Math.random() * pipSize(quote.symbol) : quote.bid - slippage * Math.random() * pipSize(quote.symbol);
}
export function estimateOrder(account, order, quotes) {
    const quote = quotes[order.symbol];
    checkQuote(quote);
    const [base, term] = order.symbol.split('/');
    const conversion = currencyToUsd(term, quotes);
    const margin = order.lots * 100000 * currencyToUsd(base, quotes) / account.settings.leverage;
    const spreadCost = (quote.ask - quote.bid) * order.lots * 100000 * conversion;
    const price = order.type === 'market' ? (order.side === 'buy' ? quote.ask : quote.bid) : (order.price ?? quote.mid);
    return { margin, spreadCost, commission: order.lots * account.settings.commission, risk: order.sl ? Math.abs(price - order.sl) * order.lots * 100000 * conversion : null, reward: order.tp ? Math.abs(order.tp - price) * order.lots * 100000 * conversion : null };
}
export function placeOrder(account, order, quotes, now) {
    validateLots(order.lots);
    if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(order.symbol) || !['buy', 'sell'].includes(order.side) || !['market', 'limit', 'stop'].includes(order.type))
        throw new Error('订单参数无效');
    const quote = quotes[order.symbol];
    checkQuote(quote, account.mode, now);
    const [base, term] = order.symbol.split('/');
    currencyToUsd(base, quotes, account.mode, now);
    currencyToUsd(term, quotes, account.mode, now);
    if (order.type !== 'market') {
        const price = order.price;
        if (price === undefined || !Number.isFinite(price) || price <= 0)
            throw new Error('请输入有效的挂单价格');
        const current = order.side === 'buy' ? quote.ask : quote.bid;
        const below = order.side === 'buy' ? order.type === 'limit' : order.type === 'stop';
        if (below ? price >= current : price <= current)
            throw new Error('挂单价格方向不正确，请检查限价/突破类型');
        validateProtection(order.side, price, order.sl, order.tp);
        const pending = { ...order, id: uid(), createdAt: now };
        account.pending.push(pending);
        log(account, now, `挂单 ${order.side === 'buy' ? '买入' : '卖出'} ${order.symbol} ${order.lots.toFixed(2)} 手 @ ${price.toFixed(digits(order.symbol))}`, 'trade');
        return pending;
    }
    return openPosition(account, order, quotes, now);
}
function openPosition(account, order, quotes, now, limit) {
    const quote = quotes[order.symbol];
    checkQuote(quote, account.mode, now);
    const [base, term] = order.symbol.split('/');
    const baseUsd = currencyToUsd(base, quotes, account.mode, now);
    const termUsd = currencyToUsd(term, quotes, account.mode, now);
    let entry = executionPrice(order.side, quote, account.settings.slippage);
    if (limit !== undefined)
        entry = order.side === 'buy' ? Math.min(entry, limit) : Math.max(entry, limit);
    if (order.type === 'market')
        validateProtection(order.side, entry, order.sl, order.tp);
    const margin = order.lots * 100000 * baseUsd / account.settings.leverage;
    const commission = order.lots * account.settings.commission;
    const mark = order.side === 'buy' ? quote.bid : quote.ask;
    const cost = Math.abs(entry - mark) * order.lots * 100000 * termUsd;
    const accountMetrics = metrics(account, quotes);
    if (!accountMetrics.complete || accountMetrics.freeMargin + 0.000001 < margin + commission + cost)
        throw new Error('可用保证金不足，降低手数或平掉部分持仓');
    const position = { id: uid(), symbol: order.symbol, side: order.side, lots: order.lots, entry, margin, openedAt: now, sl: order.sl, tp: order.tp, swap: 0, openCommission: commission, lastPnl: -cost };
    account.balance -= commission;
    account.positions.push(position);
    log(account, now, `${order.side === 'buy' ? '买入' : '卖出'} ${order.symbol} ${order.lots.toFixed(2)} 手，成交 ${entry.toFixed(digits(order.symbol))}`, 'trade');
    return position;
}
export function closePosition(account, id, quotes, now, lots, reason = '手动平仓') {
    const position = account.positions.find(p => p.id === id);
    if (!position)
        throw new Error('持仓不存在');
    const amount = lots ?? position.lots;
    validateLots(amount);
    if (amount > position.lots + 0.000001)
        throw new Error('平仓手数超过持仓手数');
    const quote = quotes[position.symbol];
    checkQuote(quote, account.mode, now);
    const [, term] = position.symbol.split('/');
    const conversion = currencyToUsd(term, quotes, account.mode, now);
    const exit = executionPrice(position.side === 'buy' ? 'sell' : 'buy', quote, account.settings.slippage);
    const fraction = amount / position.lots;
    const closeCommission = amount * account.settings.commission;
    const pnl = (exit - position.entry) * (position.side === 'buy' ? 1 : -1) * amount * 100000 * conversion;
    const closed = { ...position, id: uid(), lots: amount, margin: position.margin * fraction, swap: position.swap * fraction, openCommission: position.openCommission * fraction, exit, closedAt: now, pnl, closeCommission, netPnl: pnl + position.swap * fraction - position.openCommission * fraction - closeCommission, reason };
    account.balance += pnl - closeCommission;
    account.history.push(closed);
    if (amount >= position.lots - 0.000001)
        account.positions = account.positions.filter(p => p.id !== id);
    else {
        position.lots = Math.round((position.lots - amount) * 100) / 100;
        position.margin *= 1 - fraction;
        position.swap *= 1 - fraction;
        position.openCommission *= 1 - fraction;
        position.lastPnl *= 1 - fraction;
    }
    log(account, now, `${reason} · ${position.symbol} ${amount.toFixed(2)} 手 · 净盈亏 ${closed.netPnl >= 0 ? '+' : ''}${closed.netPnl.toFixed(2)} USD`, reason === '强制平仓' ? 'warning' : 'trade');
    return closed;
}
export function modifyPosition(account, id, quotes, sl, tp) {
    const position = account.positions.find(p => p.id === id);
    if (!position)
        throw new Error('持仓不存在');
    const quote = quotes[position.symbol];
    checkQuote(quote);
    validateProtection(position.side, position.side === 'buy' ? quote.bid : quote.ask, sl, tp);
    position.sl = sl;
    position.tp = tp;
}
function processProtection(account, position, quotes, now) {
    const quote = quotes[position.symbol];
    if (!quote)
        return;
    try {
        checkQuote(quote, account.mode, now);
        const mark = position.side === 'buy' ? quote.bid : quote.ask;
        if (position.sl !== undefined && (position.side === 'buy' ? mark <= position.sl : mark >= position.sl))
            closePosition(account, position.id, quotes, now, undefined, '止损');
        else if (position.tp !== undefined && (position.side === 'buy' ? mark >= position.tp : mark <= position.tp))
            closePosition(account, position.id, quotes, now, undefined, '止盈');
    }
    catch { /* Stale or unavailable conversion quotes never execute a trade. */ }
}
export function processAccount(account, quotes, now) {
    for (const position of account.positions) {
        try {
            position.lastPnl = positionPnl(position, quotes);
        }
        catch { /* Keep the previous marked value until a valid quote arrives. */ }
    }
    const slot = rolloverSlot(now);
    for (let day = account.lastRollover + 1; day <= slot; day++) {
        const at = day * DAY + 22 * 3600000;
        const weekday = new Date(at).getUTCDay();
        if (weekday === 0 || weekday === 6)
            continue;
        for (const position of account.positions) {
            if (position.openedAt >= at)
                continue;
            const charge = (position.side === 'buy' ? account.settings.swapLong : account.settings.swapShort) * position.lots * (weekday === 3 ? 3 : 1);
            position.swap += charge;
            account.balance += charge;
            log(account, at, `模拟隔夜结算 · ${position.symbol} ${charge >= 0 ? '+' : ''}${charge.toFixed(2)} USD${weekday === 3 ? ' · 周三三倍' : ''}`);
        }
    }
    account.lastRollover = Math.max(slot, account.lastRollover);
    for (const position of [...account.positions])
        processProtection(account, position, quotes, now);
    for (const pending of [...account.pending]) {
        const quote = quotes[pending.symbol];
        if (!quote)
            continue;
        try {
            checkQuote(quote, account.mode, now);
        }
        catch {
            continue;
        }
        const mark = pending.side === 'buy' ? quote.ask : quote.bid;
        const price = pending.price;
        const trigger = pending.type === 'limit' ? (pending.side === 'buy' ? mark <= price : mark >= price) : (pending.side === 'buy' ? mark >= price : mark <= price);
        if (!trigger)
            continue;
        try {
            const position = openPosition(account, pending, quotes, now, pending.type === 'limit' ? price : undefined);
            processProtection(account, position, quotes, now);
        }
        catch (error) {
            log(account, now, `挂单取消 · ${pending.symbol} · ${error instanceof Error ? error.message : '无法成交'}`, 'warning');
        }
        account.pending = account.pending.filter(p => p.id !== pending.id);
    }
    while (account.positions.length && metrics(account, quotes).marginLevel < 50) {
        const sorted = [...account.positions].sort((a, b) => a.lastPnl - b.lastPnl);
        let closed = false;
        for (const position of sorted) {
            try {
                closePosition(account, position.id, quotes, now, undefined, '强制平仓');
                closed = true;
                break;
            }
            catch { /* Untradeable positions remain open. */ }
        }
        if (!closed)
            break;
    }
    const last = account.equityCurve.at(-1);
    if (!last || now - last.time >= 60000) {
        account.equityCurve.push({ time: now, value: metrics(account, quotes).equity });
        if (account.equityCurve.length > 1500)
            account.equityCurve.shift();
    }
}
export function cancelOrder(account, id, now) {
    const order = account.pending.find(p => p.id === id);
    if (!order)
        throw new Error('挂单不存在');
    account.pending = account.pending.filter(p => p.id !== id);
    log(account, now, `已撤销 ${order.symbol} 挂单`);
}
