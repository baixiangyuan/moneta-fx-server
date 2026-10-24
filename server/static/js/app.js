import { cancelOrder, closePosition, digits, estimateOrder, log, metrics, modifyPosition, pipSize, placeOrder, positionPnl, processAccount } from './engine.js';
import { advanceMarket, aggregateBars, MAJORS, marketQuotes, OFFLINE_SYMBOLS, recordQuote, shockMarket, symbolName, WATCHLIST } from './market.js';
import { createBook, downloadBook, loadBook, saveBook, saveKey, validateBook } from './store.js';
import { PriceChart } from './chart.js';
import { tutorialMarkup } from './tutorial.js';
import { ApiError, worldAPI } from './shared.js';
import { CURRENCIES } from './market.js';
import { adminMarkup, mountAdmin } from './admin.js';
let destroyAdmin = null;
const el = (id) => document.getElementById(id);
const input = (id) => el(id);
const set = (id, text) => { el(id).textContent = text; };
const icon = (name) => `<svg class="icon"><use href="#i-${name}"/></svg>`;
const money = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v) => `${v >= 0 ? '+' : ''}${money(v)}`;
const price = (v, symbol = book.selected) => v === undefined ? '—' : v.toFixed(digits(symbol));
const escape = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const symbolsText = { EUR: '€', USD: '$', GBP: '£', JPY: '¥', CHF: '₣', AUD: 'A', CAD: 'C', NZD: 'N', CNY: '¥' };
function currencyGlyph(code) { return symbolsText[code] ?? code.slice(0, 1); }
function toast(text, kind = '') { const node = document.createElement('div'); node.className = `toast ${kind}`; node.textContent = text; el('toast-stack').append(node); setTimeout(() => node.remove(), 5500); }
const damaged = new Set();
function safeLoad(mode) { try {
    return loadBook(mode);
}
catch {
    damaged.add(mode);
    setTimeout(() => toast(`${mode === 'offline' ? '离线' : '在线'}存档损坏，原数据已保留。可在设置中导出原始数据或重置。`, 'error'), 300);
    return createBook(mode);
} }
const storedMode = localStorage.getItem('moneta.last-mode');
let mode = storedMode === 'shared' ? 'shared' : storedMode === 'online' ? 'online' : 'offline';
const books = { offline: safeLoad('offline'), online: safeLoad('online'), shared: createBook('shared') };
let user = null;
let shared = null;
let sharedBusy = false;
let tradeBusy = false;
let sharedReceived = 0;
let sharedError = '';
let sharedGeneration = 0;
let lastSharedPoll = 0;
let pendingTrade = null;
const developer = () => user?.role === 'developer';
const sharedReady = () => !!user && !!shared && shared.user.id === user.id && Date.now() - sharedReceived < 5000 && !sharedError;
const modeName = () => mode === 'shared' ? '共享虚构市场' : mode === 'offline' ? '离线沙盒' : '云端共享';
let book = books[mode];
let side = 'sell';
let orderType = 'market';
let tab = 'positions';
let filter = 'watch';
let period = 1;
let paused = false;
let speed = 1;
let canWrite = false;
let releaseLock;
let onlineSymbols = [...WATCHLIST];
let previous = {};
let pollBusy = false;
let lastPoll = 0;
let onlineError = '';
let trial = true;
let pollSeconds = 1;
const historyBusy = new Set();
let symbolsLoaded = false;
let lastJournal = 0;
let switching = false;
const now = () => mode === 'offline' ? book.market.time : mode === 'shared' ? shared?.market.time ?? Date.now() : Date.now();
const chart = new PriceChart(el('price-chart'), bar => {
    set('ohlc', bar ? `O ${price(bar.open)}   H ${price(bar.high)}   L ${price(bar.low)}   C ${price(bar.close)}${bar.synthetic ? ' · 停机补绘' : ''}` : 'O —   H —   L —   C —');
});
if (book.market)
    book.quotes = marketQuotes(book.market, OFFLINE_SYMBOLS, book.account.settings.spreadMultiplier);
function persist() {
    if (mode === 'shared' || !canWrite || damaged.has(mode))
        return;
    try {
        saveBook(book);
        set('save-status', `${mode === 'offline' ? '离线' : '在线'}存档已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
    }
    catch {
        set('save-status', '存档写入失败，请导出备份');
        toast('浏览器存储空间不足或不可用，请在设置中导出当前存档。', 'error');
    }
}
function refreshSavedBook(nextMode) {
    if (nextMode === 'shared')
        return;
    if (!localStorage.getItem(saveKey(nextMode)))
        return;
    books[nextMode] = safeLoad(nextMode);
    if (nextMode !== mode)
        return;
    book = books[nextMode];
    if (book.market)
        book.quotes = marketQuotes(book.market, OFFLINE_SYMBOLS, book.account.settings.spreadMultiplier);
    lastJournal = book.account.journal.length;
}
async function acquireLock(nextMode) {
    releaseLock?.();
    releaseLock = undefined;
    canWrite = false;
    if (nextMode === 'shared') {
        canWrite = !!user;
        return;
    }
    if (!navigator.locks) {
        refreshSavedBook(nextMode);
        canWrite = true;
        toast('当前浏览器不支持标签页锁，请只打开一个交易页面。', 'info');
        return;
    }
    await new Promise(resolve => {
        void navigator.locks.request(`moneta-fx-account-${nextMode}`, { ifAvailable: true }, async (lock) => {
            if (!lock) {
                refreshSavedBook(nextMode);
                toast('这一模式已在另一个标签页运行，当前页面为只读。关闭另一页并刷新即可操作。', 'info');
                resolve();
                return;
            }
            refreshSavedBook(nextMode);
            canWrite = true;
            resolve();
            await new Promise(release => { releaseLock = release; });
        });
    });
}
function changePercent(symbol) {
    const quote = book.quotes[symbol];
    if (!quote)
        return null;
    const [base, term] = symbol.split('/');
    const reference = mode === 'offline' ? book.market.baseline[base] / book.market.baseline[term] : mode === 'shared' ? shared && shared.baseline[base] / shared.baseline[term] : previous[symbol];
    return reference ? (quote.mid / reference - 1) * 100 : null;
}
function renderWatch() {
    const query = input('watch-search').value.trim().toUpperCase().replace(/\s/g, '');
    let symbols = mode !== 'online' ? OFFLINE_SYMBOLS : onlineSymbols;
    if (!query) {
        if (filter === 'watch')
            symbols = WATCHLIST.filter(s => symbols.includes(s));
        else if (filter === 'major')
            symbols = symbols.filter(s => MAJORS.includes(s));
        else if (filter === 'cross')
            symbols = symbols.filter(s => !s.includes('USD'));
    }
    symbols = symbols.filter(s => s.replace('/', '').includes(query.replace('/', '')) || symbolName(s).includes(query)).slice(0, 90);
    set('market-count', `${mode !== 'online' ? OFFLINE_SYMBOLS.length : onlineSymbols.length} 对`);
    const html = symbols.map(symbol => {
        const q = book.quotes[symbol];
        const change = changePercent(symbol);
        const [base, term] = symbol.split('/');
        return `<button class="watch-row ${symbol === book.selected ? 'active' : ''}" data-symbol="${symbol}"><span class="pair-badge">${currencyGlyph(base)}<small>${currencyGlyph(term)}</small></span><span class="pair-info"><strong>${symbol}</strong><small>${symbolName(symbol)}</small></span><span class="pair-quote"><strong>${price(q?.mid, symbol)}</strong><small class="${change === null ? '' : change >= 0 ? 'positive' : 'negative'}">${change === null ? mode === 'online' ? '点击获取' : '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</small></span></button>`;
    }).join('');
    el('watch-list').innerHTML = html || '<div class="muted" style="padding:22px;font-size:11px">没有匹配的货币对</div>';
}
function renderAccount() {
    const m = metrics(book.account, book.quotes);
    set('balance', money(book.account.balance));
    set('equity', money(m.equity));
    set('unrealized', signed(m.unrealized));
    el('unrealized').className = m.unrealized >= 0 ? 'positive' : 'negative';
    set('equity-caption', m.complete ? '含浮动盈亏' : '部分持仓按上次价格估值');
    set('free-margin', money(m.freeMargin));
    set('used-margin', `已用 ${money(m.margin)}`);
    set('margin-level', m.marginLevel === Infinity ? '—' : `${m.marginLevel.toFixed(1)}%`);
    el('margin-level').className = m.marginLevel < 100 ? 'negative' : '';
    el('risk-label').innerHTML = `<span class="status-dot" style="background:${m.marginLevel < 100 ? 'var(--red)' : 'var(--green)'}"></span>${m.margin ? m.marginLevel < 50 ? '等待强平' : m.marginLevel < 100 ? '保证金紧张' : '账户正常' : '空仓'}`;
    set('position-count', `${book.account.positions.length} 笔持仓`);
    set('leverage-badge', `1:${book.account.settings.leverage}`);
    set('positions-badge', String(book.account.positions.length));
    set('pending-badge', String(book.account.pending.length));
}
function readOrder() {
    const optional = (id) => input(id).value.trim() ? Number(input(id).value) : undefined;
    return { symbol: book.selected, side, lots: Number(input('lots-input').value), type: orderType, price: optional('entry-input'), sl: optional('sl-input'), tp: optional('tp-input') };
}
function renderOrder() {
    const quote = book.quotes[book.selected];
    const order = readOrder();
    set('sell-price', price(quote?.bid));
    set('buy-price', price(quote?.ask));
    el('side-sell').classList.toggle('selected', side === 'sell');
    el('side-buy').classList.toggle('selected', side === 'buy');
    el('spread-label').innerHTML = `${quote ? ((quote.ask - quote.bid) / pipSize(book.selected)).toFixed(1) : '—'}<small>点差</small>`;
    set('units-label', `${Number.isFinite(order.lots) ? (order.lots * 100000).toLocaleString() : '—'} 单位`);
    el('submit-order').className = `submit-order ${side}`;
    el('submit-order').innerHTML = `${orderType === 'market' ? '' : '挂单 '}${side === 'buy' ? '买入' : '卖出'} ${book.selected} ${icon('arrow')}`;
    el('pending-price-field').classList.toggle('hidden', orderType === 'market');
    for (const id of ['entry-input', 'sl-input', 'tp-input'])
        input(id).step = String(pipSize(book.selected) / 10);
    let warning = '模拟交易，不涉及真实资金';
    let available = !!quote && canWrite && !damaged.has(mode);
    if (mode === 'shared' && !user) {
        warning = '登录普通账户后即可交易';
        available = false;
    }
    else if (mode === 'shared' && (!sharedReady() || tradeBusy || pendingTrade)) {
        warning = pendingTrade ? '上一笔交易待确认，请点击重试' : tradeBusy ? '交易正在确认' : '等待连接共享市场';
        available = false;
    }
    else if (!canWrite)
        warning = '只读模式 · 账户已在另一标签页运行';
    else if (damaged.has(mode))
        warning = '原存档损坏，请先导出或重置';
    else if (!quote)
        warning = mode === 'online' ? '等待该货币对的服务端报价' : '暂无报价';
    else if (mode === 'online' && Date.now() - quote.time > 180000) {
        warning = '报价已暂停，暂时无法成交';
        available = false;
    }
    else if (mode === 'online' && !quote.marketOpen) {
        warning = '市场暂停，暂时无法成交';
        available = false;
    }
    try {
        const estimate = estimateOrder(book.account, order, book.quotes);
        set('order-margin', `${money(estimate.margin)} USD`);
        set('order-commission', `${money(estimate.commission)} USD`);
        set('order-spread', `${money(estimate.spreadCost)} USD`);
        set('sl-estimate', estimate.risk === null ? '—' : `−$${money(estimate.risk)}`);
        set('tp-estimate', estimate.reward === null ? '—' : `+$${money(estimate.reward)}`);
        if (estimate.risk !== null && quote) {
            const riskPercent = estimate.risk / metrics(book.account, book.quotes).equity * 100;
            if (available)
                warning = `止损价格风险约 ${riskPercent.toFixed(2)}% · 未含跳空及费用`;
        }
    }
    catch (error) {
        for (const id of ['order-margin', 'order-commission', 'order-spread', 'sl-estimate', 'tp-estimate'])
            set(id, '—');
        if (quote && available)
            warning = error instanceof Error ? error.message : '无法估算';
        available = false;
    }
    set('order-warning', warning);
    el('order-warning').classList.toggle('error', !available);
    el('submit-order').disabled = !available;
    document.querySelectorAll('[data-lots]').forEach(button => button.classList.toggle('active', Number(button.dataset.lots) === order.lots));
}
function renderInstrument() {
    const quote = book.quotes[book.selected];
    const change = changePercent(book.selected);
    const [base, term] = book.selected.split('/');
    set('instrument-symbol', book.selected);
    set('instrument-name', symbolName(book.selected));
    el('currency-symbol').innerHTML = `${currencyGlyph(base)}<span>${currencyGlyph(term)}</span>`;
    set('main-price', price(quote?.mid));
    set('main-change', change === null ? '等待报价' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}% ${mode !== 'online' ? '本次模拟' : '来源日变化'}`);
    el('main-change').className = change !== null && change >= 0 ? 'positive' : 'negative';
    const bars = aggregateBars(book.bars[book.selected] ?? [], period);
    chart.update(bars, book.selected, quote, book.account.positions);
    el('chart-empty').classList.toggle('hidden', bars.length > 0);
    set('chart-time', new Date(now()).toISOString().slice(5, 19).replace('T', ' '));
    set('source-time', quote ? `报价 ${new Date(quote.time).toLocaleTimeString('zh-CN', { hour12: false })}` : '无来源报价');
    if (mode === 'offline') {
        set('market-event', book.market.event);
        set('connection-text', !canWrite ? '离线账户 · 只读' : paused ? '离线引擎已暂停' : `离线引擎运行中 · ${speed}×`);
    }
    else if (mode === 'shared') {
        set('connection-text', !user ? '共享虚构市场 · 请登录' : sharedError || (!sharedReady() ? '共享市场连接中' : `共享市场 · ${shared?.market.paused ? '已暂停' : `${shared?.market.speed}×`} · ${user.role === 'developer' ? '管理员' : '普通账户'}`));
        el('connection-dot').style.background = sharedReady() ? 'var(--green)' : 'var(--yellow)';
        set('shared-event', shared?.market.event || '所有账户共享同一虚构行情');
        set('save-status', sharedReady() ? '账户已由服务端保存' : '等待服务器 · 本地练习存档保留');
        el('retry-trade').classList.toggle('hidden', !pendingTrade);
    }
    else {
        const stale = !quote || Date.now() - quote.time > 180000;
        set('connection-text', onlineError || (stale ? '等待服务端行情' : !quote.marketOpen ? '市场休市' : 'MONETA FX · 服务端共享行情'));
        el('connection-dot').style.background = onlineError || stale ? 'var(--yellow)' : 'var(--green)';
    }
}
function table(headers, rows) { return `<table class="data-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`; }
function renderPositions() {
    let html;
    if (tab === 'positions') {
        html = book.account.positions.length ? table(['货币对', '方向 / 手数', '开仓价', '当前价', '止损 / 止盈', '保证金', '浮动盈亏', '操作'], book.account.positions.map(p => {
            let pnl = p.lastPnl;
            try {
                pnl = positionPnl(p, book.quotes);
            }
            catch { /* Saved valuation is clearly marked in account summary. */ }
            return `<tr><td>${p.symbol}</td><td><span class="side-tag ${p.side}">${p.side === 'buy' ? '买入' : '卖出'}</span> ${p.lots.toFixed(2)}</td><td>${price(p.entry, p.symbol)}</td><td>${price(p.side === 'buy' ? book.quotes[p.symbol]?.bid : book.quotes[p.symbol]?.ask, p.symbol)}</td><td>${price(p.sl, p.symbol)} / ${price(p.tp, p.symbol)}</td><td>${money(p.margin)}</td><td class="${pnl >= 0 ? 'positive' : 'negative'}">${signed(pnl)}</td><td><button data-action="modify-position" data-id="${p.id}">修改</button><button data-action="partial-close" data-id="${p.id}" ${p.lots < .02 ? 'disabled' : ''}>部分</button><button data-action="close-position" data-id="${p.id}">平仓</button></td></tr>`;
        }).join('')) : `<div class="empty-state"><div class="empty-icon">${icon('chart')}</div><div><strong>准备好你的第一笔交易</strong><p>选择货币对，设定手数和风险，在右侧下单。</p></div></div>`;
    }
    else if (tab === 'pending') {
        html = book.account.pending.length ? table(['货币对', '类型', '方向', '手数', '挂单价', '止损 / 止盈', '操作'], book.account.pending.map(p => `<tr><td>${p.symbol}</td><td>${p.type === 'limit' ? '限价单' : '突破单'}</td><td><span class="side-tag ${p.side}">${p.side === 'buy' ? '买入' : '卖出'}</span></td><td>${p.lots.toFixed(2)}</td><td>${price(p.price, p.symbol)}</td><td>${price(p.sl, p.symbol)} / ${price(p.tp, p.symbol)}</td><td><button data-action="cancel-order" data-id="${p.id}">撤单</button></td></tr>`).join('')) : `<div class="empty-state"><div class="empty-icon">${icon('log')}</div><div><strong>当前没有挂单</strong><p>限价等待回调，突破单等待越过触发价格。</p></div></div>`;
    }
    else {
        html = book.account.history.length ? table(['货币对', '方向 / 手数', '开仓价', '平仓价', '净盈亏', '离场原因', '平仓时间 UTC'], [...book.account.history].reverse().slice(0, 100).map(p => `<tr><td>${p.symbol}</td><td><span class="side-tag ${p.side}">${p.side === 'buy' ? '买入' : '卖出'}</span> ${p.lots.toFixed(2)}</td><td>${price(p.entry, p.symbol)}</td><td>${price(p.exit, p.symbol)}</td><td class="${p.netPnl >= 0 ? 'positive' : 'negative'}">${signed(p.netPnl)}</td><td>${escape(p.reason)}</td><td>${new Date(p.closedAt).toISOString().slice(5, 19).replace('T', ' ')}</td></tr>`).join('')) : `<div class="empty-state"><div class="empty-icon">${icon('log')}</div><div><strong>每一次练习都值得复盘</strong><p>平仓后的记录会出现在这里，包含佣金和隔夜费用。</p></div></div>`;
    }
    el('positions-content').innerHTML = html;
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    el('close-all').disabled = !book.account.positions.length || !canWrite || (mode === 'shared' && (!sharedReady() || tradeBusy || !!pendingTrade));
}
function render() { renderWatch(); renderAccount(); renderOrder(); renderInstrument(); renderPositions(); }
function configureMode() {
    set('mode-label', modeName());
    set('account-title', mode === 'shared' ? `${user?.username ?? '待登录'} · 共享账户` : mode === 'offline' ? '离线模拟账户' : '云端共享账户');
    set('account-label', mode === 'shared' ? 'SHARED MARKET ACCOUNT' : mode === 'offline' ? 'SANDBOX ACCOUNT' : 'CLOUD SHARED ACCOUNT');
    set('chart-source', mode === 'online' ? '服务端共享行情' : mode === 'shared' ? '开发者可控 · 虚构市场' : '虚构市场');
    set('watch-source', mode === 'online' ? 'MONETA FX · 服务端共享行情 · 仅供游戏' : mode === 'shared' ? '共享虚构行情 · 仅供游戏' : '虚构行情 · 仅供游戏');
    set('account-button', user ? `${user.username} · ${developer() ? '开发者' : '普通账户'}` : '登录 / 注册');
    el('account-button').classList.toggle('developer-account', developer());
    el('developer-button').classList.toggle('hidden', !developer() || mode !== 'shared');
    el('admin-button').classList.toggle('hidden', !developer());
    el('sandbox-controls').classList.toggle('hidden', mode !== 'offline' || !developer());
    el('online-note').classList.toggle('hidden', mode !== 'online');
    el('shared-note').classList.toggle('hidden', mode !== 'shared');
    el('shared-login').classList.toggle('hidden', !!user);
    el('connection-dot').style.background = 'var(--green)';
}
async function fetchJSON(url) { const response = await fetch(url, { signal: AbortSignal.timeout(16000), cache: 'no-store' }); const data = await response.json(); if (!response.ok)
    throw new Error(data.error || '行情服务暂不可用'); return data; }
async function loadSymbols() {
    if (symbolsLoaded)
        return;
    symbolsLoaded = true;
    const result = await Promise.allSettled([fetchJSON('/api/symbols'), fetchJSON('/api/config')]);
    if (result[0].status === 'fulfilled' && result[0].value.symbols.length)
        onlineSymbols = result[0].value.symbols.map(s => s.symbol);
    if (result[1].status === 'fulfilled') {
        trial = result[1].value.trial;
        pollSeconds = Math.max(1, Number(result[1].value.pollSeconds) || 1);
    }
    if (mode === 'online') {
        renderWatch();
        set('online-note', `服务端共享虚构行情 · 模拟点差与成交 · 每 ${Math.max(1, Math.round(pollSeconds))} 秒刷新`);
    }
}
async function loadHistory(target) {
    const symbol = target.selected;
    if (historyBusy.has(symbol) || target.bars[symbol]?.length > 10)
        return;
    historyBusy.add(symbol);
    try {
        const data = await fetchJSON(`/api/history?symbol=${encodeURIComponent(symbol)}`);
        const existing = target.bars[symbol] ?? [];
        const merged = new Map(data.bars.map(b => [b.time, b]));
        for (const b of existing)
            merged.set(b.time, b);
        target.bars[symbol] = [...merged.values()].sort((a, b) => a.time - b.time).slice(-2000);
        if (book === target)
            renderInstrument();
    }
    catch { /* Actual received quotes still form truthful one-minute bars. */ }
    finally {
        historyBusy.delete(symbol);
    }
}
function conversionSymbol(currency) { return ['EUR', 'GBP', 'AUD', 'NZD'].includes(currency) ? `${currency}/USD` : `USD/${currency}`; }
async function pollOnline() {
    if (mode !== 'online' || pollBusy)
        return;
    const target = book;
    pollBusy = true;
    lastPoll = Date.now();
    onlineError = '';
    const needed = [...new Set([target.selected, ...target.account.positions.map(p => p.symbol), ...target.account.pending.map(p => p.symbol)])];
    const currencies = new Set(needed.flatMap(s => s.split('/')).filter(c => c !== 'USD'));
    const symbols = [...new Set([...needed, ...[...currencies].map(conversionSymbol)])];
    try {
        for (let i = 0; i < symbols.length; i += 12) {
            const data = await fetchJSON(`/api/quotes?symbols=${encodeURIComponent(symbols.slice(i, i + 12).join(','))}`);
            for (const q of data.quotes) {
                const half = Math.min(q.mid * .004, pipSize(q.symbol) * (MAJORS.includes(q.symbol) ? 1.2 : 2.4) * target.account.settings.spreadMultiplier / 2);
                target.quotes[q.symbol] = { ...q, bid: q.mid - half, ask: q.mid + half };
                previous[q.symbol] = q.previousClose;
                recordQuote(target.bars[q.symbol] ??= [], target.quotes[q.symbol]);
            }
            const error = data.errors.find(e => e.symbol === target.selected);
            if (error && target === book)
                onlineError = error.message;
        }
        if (target === book && mode === 'online') {
            if (canWrite && !damaged.has(mode))
                processAccount(target.account, target.quotes, Date.now());
            render();
            persist();
        }
    }
    catch (error) {
        if (target === book) {
            onlineError = error instanceof Error ? error.message : '行情连接中断';
            render();
        }
    }
    finally {
        pollBusy = false;
        if (mode === 'online' && book !== target)
            void pollOnline();
    }
    void loadHistory(target);
}
async function switchMode(next) {
    if (next === mode || switching)
        return;
    switching = true;
    sharedGeneration++;
    persist();
    mode = next;
    book = books[mode];
    localStorage.setItem('moneta.last-mode', mode);
    previous = {};
    onlineError = '';
    lastJournal = book.account.journal.length;
    if (book.market)
        book.quotes = marketQuotes(book.market, OFFLINE_SYMBOLS, book.account.settings.spreadMultiplier);
    for (const id of ['sl-input', 'tp-input', 'entry-input'])
        input(id).value = '';
    el('mode-menu').classList.add('hidden');
    el('mode-toggle').setAttribute('aria-expanded', 'false');
    configureMode();
    chart.reset();
    await acquireLock(mode);
    render();
    switching = false;
    toast(`已进入${modeName()}，资金和存档独立。`, 'info');
    if (mode === 'shared') {
        await pollShared();
        if (!user)
            openAccount();
    }
    if (mode === 'online') {
        void loadSymbols();
        void pollOnline();
    }
}
function requireWrite() { if (mode === 'shared')
    throw new Error('共享账户由服务端管理'); if (!canWrite || damaged.has(mode))
    throw new Error('当前账户只读或存档损坏，无法修改'); }
function action(callback) { try {
    requireWrite();
    callback();
    render();
    persist();
}
catch (error) {
    toast(error instanceof Error ? error.message : '操作失败', 'error');
} }
function openModal(title, html, eyebrow = 'MONETA FX') { destroyAdmin?.(); destroyAdmin = null; el('app-modal').classList.remove('admin-modal'); set('modal-title', title); set('modal-eyebrow', eyebrow); el('modal-content').innerHTML = html; el('modal-content').scrollTop = 0; if (!el('app-modal').open)
    el('app-modal').showModal(); }
function closeModal() { destroyAdmin?.(); destroyAdmin = null; el('app-modal').close(); }
function openAdmin() {
    if (!developer() || !user)
        return;
    openModal('账户管理', adminMarkup(), 'ADMINISTRATION');
    el('app-modal').classList.add('admin-modal');
    destroyAdmin = mountAdmin(el('modal-content'), user.id, () => { clearIdentity(); closeModal(); toast('管理员会话已失效，请重新登录', 'error'); });
}
function clearIdentity() {
    user = null;
    shared = null;
    sharedReceived = 0;
    sharedGeneration++;
    pendingTrade = null;
    paused = false;
    speed = 1;
    el('speed-select').value = '1';
    books.shared = createBook('shared');
    if (mode === 'shared') {
        book = books.shared;
        canWrite = false;
    }
    configureMode();
    render();
}
function acceptShared(data) {
    if (shared && shared.user.id === data.user.id && data.market.revision < shared.market.revision)
        return;
    const selected = book.selected;
    if (user?.id !== data.user.id)
        pendingTrade = null;
    user = data.user;
    shared = data;
    sharedReceived = Date.now();
    sharedError = '';
    canWrite = true;
    books.shared = { ...data.book, selected, bars: { ...books.shared.bars, ...data.book.bars } };
    if (mode === 'shared') {
        book = books.shared;
        configureMode();
        render();
    }
}
async function pollShared() {
    if (mode !== 'shared' || sharedBusy || tradeBusy)
        return;
    lastSharedPoll = Date.now();
    if (!user)
        return;
    sharedBusy = true;
    const generation = sharedGeneration;
    try {
        const data = await worldAPI(`/api/world/state?symbol=${encodeURIComponent(book.selected)}`);
        if (mode === 'shared' && generation === sharedGeneration)
            acceptShared(data);
    }
    catch (error) {
        if (mode !== 'shared' || generation !== sharedGeneration)
            return;
        if (error instanceof ApiError && error.status === 401)
            clearIdentity();
        else {
            sharedError = '共享市场连接中断 · 等待重连';
            renderOrder();
            renderInstrument();
        }
    }
    finally {
        sharedBusy = false;
    }
}
async function initializeSession() {
    const params = new URLSearchParams(location.hash.slice(1));
    const key = params.get('developer');
    if (key)
        window.history.replaceState(null, '', location.pathname + location.search);
    try {
        const result = await worldAPI(key ? '/api/auth/developer' : '/api/session', key ? { key } : undefined);
        user = result.user;
        if (key && user || localStorage.getItem('moneta.last-mode') === 'shared') {
            mode = 'shared';
            book = books.shared;
            localStorage.setItem('moneta.last-mode', mode);
        }
        if (key)
            localStorage.setItem('moneta.welcomed', '1');
    }
    catch (error) {
        if (key)
            toast(error instanceof Error ? error.message : '开发者登录失败', 'error');
    }
}
function openAccount(register = false) {
    if (user) {
        openModal('我的账户', `<div class="identity-card"><span class="identity-symbol">${developer() ? icon('shield') : icon('chart')}</span><h3>${escape(user.username)}</h3><span class="role-badge">${developer() ? '管理员 · 行情与账户管理权限' : '普通账户 · 模拟交易权限'}</span><p>共享账户的资金、持仓和历史保存在服务器。离线练习单独保存在当前浏览器。</p></div><div class="modal-actions"><button class="primary-button" data-action="account-market">进入共享虚构市场</button><button class="secondary-button" data-action="logout">退出登录</button></div>`, 'YOUR ACCOUNT');
        return;
    }
    openModal(register ? '创建普通账户' : '登录共享市场', `<div class="settings-tabs"><button data-action="account-login" class="${register ? '' : 'active'}">登录</button><button data-action="account-register" class="${register ? 'active' : ''}">创建账户</button></div><p class="account-intro">${register ? '从 100,000 USD 模拟资金开始。普通账户可以交易、复盘与学习。' : '进入同一个虚构市场，行情由开发者控制，账户资金各自独立。'}</p><form id="account-form" data-register="${register}"><div class="settings-grid"><div class="settings-field"><label for="auth-username">用户名</label><input id="auth-username" name="username" minlength="2" maxlength="24" autocomplete="username" required placeholder="2–24 个字符"></div><div class="settings-field"><label for="auth-password">密码</label><input id="auth-password" name="password" type="password" minlength="8" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}" required placeholder="至少 8 个字符"></div></div><p id="auth-error" class="negative" role="alert"></p><div class="modal-actions"><button class="primary-button" type="submit" id="auth-submit">${register ? '创建并进入' : '登录并进入'}</button></div></form><p class="account-footnote">开发者请在本机双击「开发者入口.cmd」。离线练习无需登录。</p>`, 'SHARED FICTIONAL MARKET');
}
async function authenticate(form) {
    const button = el('auth-submit');
    if (button.disabled)
        return;
    const credentials = { username: input('auth-username').value.trim(), password: input('auth-password').value };
    button.disabled = true;
    set('auth-error', '');
    try {
        const data = await worldAPI(form.dataset.register === 'true' ? '/api/auth/register' : '/api/auth/login', credentials);
        sharedGeneration++;
        shared = null;
        books.shared = createBook('shared');
        user = data.user;
        closeModal();
        localStorage.setItem('moneta.welcomed', '1');
        if (mode === 'shared') {
            book = books.shared;
            canWrite = true;
            await pollShared();
        }
        else
            await switchMode('shared');
        configureMode();
        render();
        toast(`已登录 · ${user?.username}`);
    }
    catch (error) {
        if (document.getElementById('auth-error'))
            set('auth-error', error instanceof Error ? error.message : '登录失败');
    }
    finally {
        button.disabled = false;
    }
}
async function runSharedTrade(command) {
    if (tradeBusy)
        return;
    if (!user) {
        openAccount();
        return;
    }
    if (!sharedReady()) {
        toast('共享市场尚未连接，请等待重连。', 'error');
        return;
    }
    if (pendingTrade && command) {
        toast('上一笔交易结果待确认，请先点击重试交易。', 'info');
        return;
    }
    pendingTrade ??= command ? { ...command, requestId: crypto.randomUUID(), accountId: user.id } : null;
    if (!pendingTrade)
        return;
    const generation = sharedGeneration;
    const identity = user.id;
    tradeBusy = true;
    renderOrder();
    try {
        const data = await worldAPI(`/api/world/trade?symbol=${encodeURIComponent(book.selected)}`, pendingTrade);
        if (generation !== sharedGeneration || identity !== user?.id)
            return;
        if (pendingTrade?.action === 'order')
            tab = pendingTrade.order.type === 'market' ? 'positions' : 'pending';
        pendingTrade = null;
        if (mode === 'shared')
            acceptShared(data);
        closeModal();
        toast('交易已确认 · 服务端已保存');
    }
    catch (error) {
        if (generation !== sharedGeneration)
            return;
        if (error instanceof ApiError) {
            pendingTrade = null;
            if (error.status === 401)
                clearIdentity();
        }
        toast(error instanceof ApiError ? error.message : '交易结果待确认。恢复连接后点击「重试交易」，同一请求只会执行一次。', 'error');
    }
    finally {
        tradeBusy = false;
        renderOrder();
        renderInstrument();
    }
}
function openSharedSettings(section) {
    const s = book.account.settings;
    const tabs = `<div class="settings-tabs"><button data-settings-tab="rules" class="${section === 'rules' ? 'active' : ''}">交易参数</button><button data-settings-tab="tutorial">详细教程</button><button data-settings-tab="storage" class="${section === 'storage' ? 'active' : ''}">存档管理</button><button data-settings-tab="source">行情说明</button></div>`;
    const content = section === 'storage'
        ? `<div class="settings-note">共享账户由服务器自动保存。关闭浏览器不会删除账户；服务器运行时，挂单、止损和止盈继续执行。服务器关闭时模拟时间冻结。</div><div class="storage-card"><h3>共享账户 · ${escape(user?.username ?? '待登录')}</h3><p>可以导出账户记录供复盘。共享资金和持仓以服务器为准，无法通过导入文件或重置本地存档修改。</p><button class="secondary-button" data-action="export">导出账户快照</button></div><p class="account-footnote">离线与在线练习分别保存在当前浏览器，在对应模式的设置中备份和恢复。</p>`
        : `<div class="settings-note">共享市场使用统一的成交规则，普通账户可以查看。开发者的行情控制只影响虚构市场。</div><div class="shared-rules"><div><span>杠杆</span><strong>1:${s.leverage}</strong></div><div><span>点差倍率</span><strong>${s.spreadMultiplier}×</strong></div><div><span>最大不利滑点</span><strong>${s.slippage} 点</strong></div><div><span>每手每边佣金</span><strong>${s.commission} USD</strong></div><div><span>多单 / 空单隔夜费</span><strong>${s.swapLong} / ${s.swapShort} USD</strong></div><div><span>强平阈值</span><strong>50%</strong></div></div><div class="modal-actions"><button class="secondary-button" data-settings-tab="tutorial">查看详细教程</button></div>`;
    openModal('设置与教程', tabs + content, 'SHARED MARKET SETTINGS');
}
let controlBusy = false;
async function openDeveloper() {
    if (!developer() || mode !== 'shared')
        return;
    try {
        const data = await worldAPI('/api/world/admin');
        if (!developer() || mode !== 'shared')
            return;
        const field = (id, label, value, min, max, step) => `<div class="settings-field"><label for="${id}">${label}</label><input id="${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" required></div>`;
        const current = book.quotes[book.selected]?.mid;
        openModal('行情控制台', `<div class="developer-heading"><span class="role-badge">开发者专属</span><span>共享虚构市场 · ${data.paused ? '已暂停' : '运行中'} · ${data.speed}×</span></div><p class="account-intro">操作会同步到所有账户，并可能触发挂单、止损和强平。未来走势计划只对开发者可见。</p><div class="developer-grid"><section class="control-card"><h3>直接调整价格 <small>${book.selected}</small></h3><form data-control="price">${field('control-price', '目标中间价', current ? Number(current.toFixed(digits(book.selected))) : 1.1, 0, 100000, pipSize(book.selected) / 10)}<p>一次可调至当前价的 50%–200%。相关交叉汇率联动。</p><button class="primary-button" type="submit">立即应用价格</button></form></section><section class="control-card"><h3>编排一段走势</h3><form data-control="trend"><div class="settings-field"><label for="control-currency">货币（相对 USD）</label><select id="control-currency">${Object.keys(CURRENCIES).filter(c => c !== 'USD').map(c => `<option value="${c}" ${c === 'EUR' ? 'selected' : ''}>${c} · ${escape(CURRENCIES[c].name)}</option>`).join('')}</select></div><div class="settings-grid">${field('control-percent', '涨跌幅（%）', 2, -30, 30, .1)}${field('control-seconds', '模拟秒数', 60, 5, 86400, 1)}</div><p>以当前价为起点，保留过程波动，在指定模拟时间到达目标。</p><button class="primary-button" type="submit">安排走势</button></form></section><section class="control-card"><h3>时间与波动</h3><form data-control="clock"><div class="settings-field"><label for="control-speed">市场时间速度</label><select id="control-speed">${[1, 5, 20, 100].map(v => `<option value="${v}" ${v === data.speed ? 'selected' : ''}>${v}×</option>`).join('')}</select></div><label class="check-row"><input id="control-paused" type="checkbox" ${data.paused ? 'checked' : ''}>暂停市场时钟（仍可交易）</label><button class="secondary-button" type="submit">应用时钟</button></form><form data-control="volatility" class="separated-control">${field('control-volatility', '波动强度（1–20）', data.volatility, 1, 20, .5)}<button class="secondary-button" type="submit">应用波动</button></form></section><section class="control-card"><h3>触发虚构事件</h3><p>事件注入冲击，后续随市场时间逐步演化。</p><div class="event-buttons"><button data-action="dev-event" data-event="dollar">美元加息</button><button data-action="dev-event" data-event="euro">欧元利好</button><button data-action="dev-event" data-event="yen">日元干预</button><button data-action="dev-event" data-event="storm">流动性风暴</button></div></section></div><div class="control-section"><div class="control-section-title"><h3>正在执行的走势</h3><button class="secondary-button" data-action="dev-cancel">取消全部编排</button></div>${data.plans.length ? data.plans.map(plan => `<div class="plan-row"><strong>${plan.currency}</strong><span>目标 USD 价值 ${plan.target.toFixed(6)}</span><span>剩余 ${Math.ceil(plan.remaining)} 模拟秒</span></div>`).join('') : '<p class="muted">当前没有未来走势编排，市场自然运行。</p>'}</div><div class="control-section"><h3>最近操作</h3><div class="audit-list">${data.audit.length ? [...data.audit].reverse().slice(0, 20).map(entry => `<div><time>${new Date(entry.realTime).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>${escape(entry.message)}</span></div>`).join('') : '<p class="muted">你的首次操作会记录在这里。</p>'}</div></div>`, 'MARKET DIRECTOR');
    }
    catch (error) {
        toast(error instanceof Error ? error.message : '控制台连接失败', 'error');
    }
}
async function runControl(command) {
    if (!developer() || mode !== 'shared' || controlBusy)
        return;
    controlBusy = true;
    el('modal-content').querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
        const data = await worldAPI(`/api/world/control?symbol=${encodeURIComponent(book.selected)}`, command);
        if (mode === 'shared' && developer()) {
            acceptShared(data);
            await openDeveloper();
        }
        toast('行情控制已生效 · 所有账户同步');
    }
    catch (error) {
        toast(error instanceof Error ? error.message : '控制失败', 'error');
    }
    finally {
        controlBusy = false;
        el('modal-content').querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
}
function handleSharedAction(data) {
    const action = data.action;
    if (action === 'account-login' || action === 'account-register') {
        openAccount(action === 'account-register');
        return true;
    }
    if (action === 'account-market') {
        closeModal();
        void switchMode('shared');
        return true;
    }
    if (action === 'logout') {
        void worldAPI('/api/auth/logout', {}).then(() => { clearIdentity(); closeModal(); toast('已退出登录'); }).catch(error => toast(error.message, 'error'));
        return true;
    }
    if (action === 'dev-event') {
        void runControl({ kind: 'event', event: data.event });
        return true;
    }
    if (action === 'dev-cancel') {
        void runControl({ kind: 'cancel-trends' });
        return true;
    }
    if (mode !== 'shared')
        return false;
    const id = data.id;
    if (action === 'close-position')
        void runSharedTrade({ action: 'close', id });
    else if (action === 'cancel-order')
        void runSharedTrade({ action: 'cancel', id });
    else if (action === 'confirm-partial')
        void runSharedTrade({ action: 'close', id, lots: Number(input('partial-lots').value) });
    else if (action === 'confirm-modify')
        void runSharedTrade({ action: 'modify', id, sl: input('modify-sl').value ? Number(input('modify-sl').value) : undefined, tp: input('modify-tp').value ? Number(input('modify-tp').value) : undefined });
    else if (['save-settings', 'import', 'confirm-reset', 'reset-request', 'export-raw'].includes(action || ''))
        toast('共享账户由服务器保存，交易规则和资金不能在本地修改。', 'info');
    else
        return false;
    return true;
}
function openSettings(section = 'rules') {
    if (mode === 'shared' && (section === 'rules' || section === 'storage')) {
        openSharedSettings(section);
        return;
    }
    const settings = book.account.settings;
    const tabs = `<div class="settings-tabs"><button data-settings-tab="rules" class="${section === 'rules' ? 'active' : ''}">交易参数</button><button data-settings-tab="tutorial" class="${section === 'tutorial' ? 'active' : ''}">详细教程</button><button data-settings-tab="storage" class="${section === 'storage' ? 'active' : ''}">存档管理</button><button data-settings-tab="source" class="${section === 'source' ? 'active' : ''}">行情说明</button></div>`;
    let content;
    if (section === 'rules') {
        const field = (id, label, value, min, max, step, hint) => `<div class="settings-field"><label for="${id}">${label}</label><input id="${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}"><small>${hint}</small></div>`;
        content = `<div class="settings-note">参数只作用于当前的<strong>${mode === 'offline' ? '离线沙盒' : '云端共享'}</strong>账户。点差、滑点、费用属于游戏成交规则，不是经纪商报价。强平阈值为 50%；已有持仓的开仓保证金固定。</div><div class="settings-grid"><div class="settings-field"><label for="setting-leverage">账户杠杆</label><select id="setting-leverage" ${book.account.positions.length || book.account.pending.length ? 'disabled' : ''}>${[10, 20, 30, 50, 100, 200, 500].map(v => `<option value="${v}" ${v === settings.leverage ? 'selected' : ''}>1:${v}</option>`).join('')}</select><small>仅空仓且无挂单时可修改。手数相同时，杠杆不改变每点盈亏。</small></div>${field('setting-spread', '模拟点差倍率', settings.spreadMultiplier, .5, 10, .1, '基础点差随货币对变化；离线波动越大，点差可能越宽。')}${field('setting-slippage', '最大滑点（点）', settings.slippage, 0, 20, .1, '市价成交在 0 至上限之间随机产生不利滑点。')}${field('setting-commission', '每手每边佣金（USD）', settings.commission, 0, 100, .1, '开仓与平仓各收一次。部分平仓按实际手数收取。')}${field('setting-swap-long', '多单每手模拟隔夜费（USD）', settings.swapLong, -100, 100, .1, '负数扣费、正数入账；UTC 22:00，周三三倍，周末不结算。')}${field('setting-swap-short', '空单每手模拟隔夜费（USD）', settings.swapShort, -100, 100, .1, '统一的游戏参数，不是实际货币对或经纪商融资费率。')}</div><div class="modal-actions"><button class="primary-button" data-action="save-settings">保存参数</button><button class="secondary-button" data-settings-tab="tutorial">读懂这些数字</button></div>`;
    }
    else if (section === 'tutorial')
        content = tutorialMarkup(0);
    else if (section === 'storage') {
        const account = book.account;
        content = `<div class="settings-note">在线和离线各有独立存档。存档只在当前浏览器中；清理浏览器数据会丢失。导出文件可以备份，也可以在同一模式导入恢复。</div><div class="storage-cards"><div class="storage-card"><h3>${mode === 'offline' ? '离线沙盒' : '云端共享'} · 当前存档</h3><p>余额 ${money(account.balance)} USD<br>${account.positions.length} 笔持仓 · ${account.pending.length} 笔挂单 · ${account.history.length} 条已平仓记录</p><button class="secondary-button" data-action="export">导出当前存档</button></div><div class="storage-card"><h3>恢复与重新开始</h3><p>导入会替换当前模式账户。<br>重置后重新获得 100,000 USD 模拟资金；另一模式不受影响。</p><button class="secondary-button" data-action="import">导入存档</button></div></div><div class="modal-actions"><button class="danger-button" data-action="reset-request">重置当前模式账户</button>${damaged.has(mode) ? '<button class="secondary-button" data-action="export-raw">导出损坏的原始数据</button>' : ''}</div>`;
    }
    else {
        content = `<article class="tutorial-article"><h3>报价来源与真实程度</h3><h4>共享：开发者控制的虚构市场</h4><p>所有登录账户共用服务器行情，成交由服务器计算。开发者专属控制台提供直接改价、定时走势、时钟、波动和事件；普通账户只有交易、看图和复盘功能。未来计划仅开发者可见。共享账户自动保存到服务器，资金与其他模式独立。</p><h4>云端：服务端共享虚构行情</h4><p>行情由 MONETA FX 服务端统一生成并持续撮合，所有登录账户看到同一份虚构行情。默认每秒取所选、持仓和必要换算报价；报价时间由服务端市场时钟决定。</p><p>货币对目录由服务端提供，覆盖全部主要与交叉盘。图表使用服务端分钟线，不在两笔报价之间编造走势。</p><h4>服务端部署</h4><p>通过环境变量 <strong>MONETA_PORT</strong>、<strong>MONETA_DATA_DIR</strong>、<strong>MONETA_DEVELOPER_KEY</strong> 配置服务端；共享市场存档保存在数据目录，重启后只补绘图表，不会补成交。</p><h4>离线：虚构行情</h4><p>云端与离线全部报价均由服务端或本机的共同货币过程生成，不对应真实历史。每个模式有自己的账户、行情和 K 线，网络中断时不会自动切换。</p><div class="tutorial-callout">共享虚构市场由服务器持续撮合，关闭玩家页面后保护单仍然有效；服务器停止期间模拟时钟冻结。独立的在线、离线练习仅在页面运行时执行交易。图表没有真实成交量或订单簿；隔夜费和强平机制是明确的模拟参数。</div></article>`;
    }
    openModal('设置与教程', tabs + content, mode === 'offline' ? 'SANDBOX SETTINGS' : 'CLOUD SETTINGS');
}
function openTutorial(index = 0) { openModal('交易指南', tutorialMarkup(index), 'LEARN THE MARKET'); }
function openWelcome() {
    openModal('欢迎来到你的交易室', `<p class="welcome-intro">从 100,000 美元模拟资金开始，在真实的交易机制里自由试错。先熟悉离线沙盒，再登录进入服务端共享市场。</p><div class="welcome-steps"><div class="welcome-step"><span>01</span><strong>选一个货币对</strong>左侧选 EUR/USD，右侧设 0.01 手，小仓位探索买入和卖出。</div><div class="welcome-step"><span>02</span><strong>给风险设个边界</strong>设置止损和止盈，观察保证金、点差和成交后的浮动盈亏。</div><div class="welcome-step"><span>03</span><strong>让市场快一点</strong>登录普通账户进入共享虚构市场；开发者可以编排走势。离线练习与云端账户各自独立保存。</div></div><div class="modal-actions"><button class="primary-button" data-action="start-playing">进入交易室</button><button class="secondary-button" data-action="open-tutorial">先看详细教程</button></div>`, 'YOUR EDGE STARTS HERE');
}
function openReport() {
    const account = book.account;
    const history = account.history;
    const m = metrics(account, book.quotes);
    const total = history.reduce((sum, p) => sum + p.netPnl, 0);
    const wins = history.filter(p => p.netPnl > 0).length;
    const gains = history.reduce((sum, p) => sum + Math.max(0, p.netPnl), 0);
    const losses = history.reduce((sum, p) => sum + Math.max(0, -p.netPnl), 0);
    const curve = [...account.equityCurve, { time: now(), value: m.equity }];
    let peak = curve[0].value;
    let drawdown = 0;
    for (const point of curve) {
        peak = Math.max(peak, point.value);
        if (peak > 0)
            drawdown = Math.max(drawdown, (peak - point.value) / peak * 100);
    }
    const min = Math.min(...curve.map(p => p.value)) - 10;
    const max = Math.max(...curve.map(p => p.value)) + 10;
    const path = curve.map((p, i) => `${i ? 'L' : 'M'}${(15 + i / Math.max(1, curve.length - 1) * 690).toFixed(2)},${(140 - (p.value - min) / (max - min) * 120).toFixed(2)}`).join(' ');
    const card = (label, value, cls = '') => `<div class="report-card"><small>${label}</small><strong class="${cls}">${value}</strong></div>`;
    openModal('账户分析', `<div class="report-grid">${card('已实现净盈亏（含费用）', signed(total), total >= 0 ? 'positive' : 'negative')}${card('已平仓胜率', history.length ? `${(wins / history.length * 100).toFixed(1)}%` : '—')}${card('盈利因子', losses ? (gains / losses).toFixed(2) : gains ? '∞' : '—')}${card('采样最大回撤', `${drawdown.toFixed(2)}%`)}</div><svg class="report-plot" viewBox="0 0 720 160" preserveAspectRatio="none" aria-label="账户净值曲线"><path d="M15 30H705M15 80H705M15 140H705" stroke="#233342"/><path d="${path}" fill="none" stroke="#60dcb4" stroke-width="2"/></svg><p class="report-caption">当前净值 ${money(m.equity)} USD · 账户总回报 ${((m.equity / account.initialBalance - 1) * 100).toFixed(2)}% · ${history.length} 条已平仓记录<br>部分平仓各计一条记录；曲线每模拟分钟采样，最大回撤可能漏掉短时变化。在线与离线统计分别保存。</p>`, mode === 'offline' ? 'SANDBOX PERFORMANCE' : 'CLOUD PERFORMANCE');
}
function openJournal() { openModal('交易日志', `<div class="journal-list">${[...book.account.journal].reverse().slice(0, 100).map(j => `<div class="journal-item ${j.kind}"><time>${new Date(j.time).toISOString().slice(5, 19).replace('T', ' ')} UTC</time><span>${escape(j.message)}</span></div>`).join('')}</div>`, 'ACCOUNT JOURNAL'); }
function openPositionDialog(id, partial) {
    const p = book.account.positions.find(p => p.id === id);
    if (!p)
        return;
    if (partial)
        openModal(`部分平仓 · ${p.symbol}`, `<div class="settings-note">当前持仓 ${p.lots.toFixed(2)} 手。输入要平掉的手数，剩余部分继续持有。平仓按当时可成交价和模拟滑点执行。</div><div class="settings-field"><label for="partial-lots">平仓手数</label><input id="partial-lots" type="number" min="0.01" max="${p.lots}" step="0.01" value="${(Math.max(.01, Math.floor(p.lots * 50) / 100)).toFixed(2)}"></div><div class="modal-actions"><button class="primary-button" data-action="confirm-partial" data-id="${p.id}">确认部分平仓</button></div>`);
    else
        openModal(`风险控制 · ${p.symbol}`, `<div class="settings-note">当前${p.side === 'buy' ? '多' : '空'}单 ${p.lots.toFixed(2)} 手，开仓 ${price(p.entry, p.symbol)}。修改的止损和止盈需要位于当前可平仓价格的正确一侧；留空可移除。</div><div class="settings-grid"><div class="settings-field"><label for="modify-sl">止损</label><input id="modify-sl" type="number" step="${pipSize(p.symbol) / 10}" value="${p.sl ?? ''}" placeholder="未设置"></div><div class="settings-field"><label for="modify-tp">止盈</label><input id="modify-tp" type="number" step="${pipSize(p.symbol) / 10}" value="${p.tp ?? ''}" placeholder="未设置"></div></div><div class="modal-actions"><button class="primary-button" data-action="confirm-modify" data-id="${p.id}">保存止损止盈</button></div>`);
}
function setSide(next) { side = next; input('sl-input').value = ''; input('tp-input').value = ''; renderOrder(); }
function setLots(value) { input('lots-input').value = Math.max(.01, Math.min(1000, value)).toFixed(2); renderOrder(); }
function selectSymbol(symbol) {
    book.selected = symbol;
    chart.reset();
    for (const id of ['sl-input', 'tp-input', 'entry-input'])
        input(id).value = '';
    if (mode === 'offline') {
        if (!book.bars[symbol])
            book.bars[symbol] = [];
        recordQuote(book.bars[symbol], book.quotes[symbol]);
    }
    render();
    persist();
    if (mode === 'shared')
        void pollShared();
    if (mode === 'online') {
        void pollOnline();
        void loadHistory(book);
    }
}
document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) {
        if (!event.target.closest('.mode-wrap')) {
            el('mode-menu').classList.add('hidden');
            el('mode-toggle').setAttribute('aria-expanded', 'false');
        }
        return;
    }
    const data = target.dataset;
    if (data.mode) {
        void switchMode(data.mode);
        return;
    }
    if (data.symbol) {
        selectSymbol(data.symbol);
        return;
    }
    if (data.filter) {
        filter = data.filter;
        document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
        renderWatch();
        return;
    }
    if (data.period) {
        period = Number(data.period);
        document.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('active', Number(b.dataset.period) === period));
        chart.reset();
        renderInstrument();
        return;
    }
    if (data.type) {
        orderType = data.type;
        document.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === orderType));
        renderOrder();
        return;
    }
    if (data.lots) {
        setLots(Number(data.lots));
        return;
    }
    if (data.tab) {
        tab = data.tab;
        renderPositions();
        return;
    }
    if (data.settingsTab) {
        openSettings(data.settingsTab);
        return;
    }
    if (data.lesson) {
        if (el('modal-title').textContent === '设置与教程') {
            openSettings('tutorial');
            const nav = el('modal-content').querySelector('.settings-tabs').outerHTML;
            el('modal-content').innerHTML = nav + tutorialMarkup(Number(data.lesson));
        }
        else
            openTutorial(Number(data.lesson));
        return;
    }
    if (handleSharedAction(data))
        return;
    const id = data.id ?? '';
    switch (data.action) {
        case 'start-playing':
            localStorage.setItem('moneta.welcomed', '1');
            closeModal();
            break;
        case 'open-tutorial':
            openTutorial();
            break;
        case 'finish-tutorial':
            localStorage.setItem('moneta.welcomed', '1');
            closeModal();
            break;
        case 'close-position':
            action(() => { const trade = closePosition(book.account, id, book.quotes, now()); toast(`已平仓 ${trade.symbol} · 净盈亏 ${signed(trade.netPnl)} USD`); });
            break;
        case 'cancel-order':
            action(() => cancelOrder(book.account, id, now()));
            break;
        case 'modify-position':
            openPositionDialog(id, false);
            break;
        case 'partial-close':
            openPositionDialog(id, true);
            break;
        case 'confirm-partial':
            action(() => { const trade = closePosition(book.account, id, book.quotes, now(), Number(input('partial-lots').value)); closeModal(); toast(`已平 ${trade.lots.toFixed(2)} 手 · 净盈亏 ${signed(trade.netPnl)} USD`); });
            break;
        case 'confirm-modify':
            action(() => { modifyPosition(book.account, id, book.quotes, input('modify-sl').value ? Number(input('modify-sl').value) : undefined, input('modify-tp').value ? Number(input('modify-tp').value) : undefined); log(book.account, now(), '已修改持仓保护单'); closeModal(); toast('止损止盈已更新'); });
            break;
        case 'save-settings':
            action(() => {
                const settings = book.account.settings;
                const spread = Number(input('setting-spread').value);
                const slip = Number(input('setting-slippage').value);
                const commission = Number(input('setting-commission').value);
                const long = Number(input('setting-swap-long').value);
                const short = Number(input('setting-swap-short').value);
                if (![spread, slip, commission, long, short].every(Number.isFinite) || spread < .5 || spread > 10 || slip < 0 || slip > 20 || commission < 0 || commission > 100 || Math.abs(long) > 100 || Math.abs(short) > 100)
                    throw new Error('交易参数超出允许范围');
                const leverage = Number(el('setting-leverage').value);
                if (!book.account.positions.length && !book.account.pending.length && [10, 20, 30, 50, 100, 200, 500].includes(leverage))
                    settings.leverage = leverage;
                Object.assign(settings, { spreadMultiplier: spread, slippage: slip, commission, swapLong: long, swapShort: short });
                if (mode === 'offline')
                    book.quotes = marketQuotes(book.market, OFFLINE_SYMBOLS, spread);
                else
                    for (const quote of Object.values(book.quotes)) {
                        const half = Math.min(quote.mid * .004, pipSize(quote.symbol) * (MAJORS.includes(quote.symbol) ? 1.2 : 2.4) * spread / 2);
                        quote.bid = quote.mid - half;
                        quote.ask = quote.mid + half;
                    }
                log(book.account, now(), '已更新模拟交易参数');
                closeModal();
                toast('交易参数已保存');
            });
            break;
        case 'export':
            downloadBook(book);
            break;
        case 'import':
            input('import-file').click();
            break;
        case 'export-raw': {
            const raw = localStorage.getItem(saveKey(mode)) ?? '';
            const blob = new Blob([raw], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `MONETA-FX-${mode}-damaged.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            break;
        }
        case 'reset-request':
            openModal('重新开始当前账户', `<div class="settings-note">你将重置<strong>${mode === 'offline' ? '离线沙盒' : '云端共享'}</strong>账户的持仓、挂单、历史和资金。另一模式保留原存档。建议先导出备份。</div><div class="modal-actions"><button class="secondary-button" data-action="export">先导出存档</button><button class="danger-button" data-action="confirm-reset">确认重置当前账户</button></div>`);
            break;
        case 'confirm-reset': {
            if (!canWrite) {
                toast('只读账户无法重置', 'error');
                break;
            }
            damaged.delete(mode);
            book = books[mode] = createBook(mode);
            if (book.market)
                book.quotes = marketQuotes(book.market, OFFLINE_SYMBOLS, book.account.settings.spreadMultiplier);
            lastJournal = book.account.journal.length;
            closeModal();
            chart.reset();
            render();
            persist();
            if (mode === 'online')
                void pollOnline();
            toast('当前账户已重置 · 100,000 USD 模拟资金');
            break;
        }
    }
});
el('mode-toggle').addEventListener('click', () => { const visible = el('mode-menu').classList.toggle('hidden'); el('mode-toggle').setAttribute('aria-expanded', String(!visible)); });
el('settings-button').addEventListener('click', () => openSettings());
el('account-button').addEventListener('click', () => openAccount());
el('developer-button').addEventListener('click', () => { void openDeveloper(); });
el('admin-button').addEventListener('click', openAdmin);
el('app-modal').addEventListener('close', () => { destroyAdmin?.(); destroyAdmin = null; });
el('shared-login').addEventListener('click', () => openAccount());
el('retry-trade').addEventListener('click', () => { void runSharedTrade(); });
el('modal-content').addEventListener('submit', event => {
    const form = event.target;
    event.preventDefault();
    if (form.id === 'account-form') {
        void authenticate(form);
        return;
    }
    const kind = form.dataset.control;
    if (kind === 'price')
        void runControl({ kind, symbol: book.selected, price: Number(input('control-price').value) });
    else if (kind === 'trend')
        void runControl({ kind, currency: el('control-currency').value, percent: Number(input('control-percent').value), seconds: Number(input('control-seconds').value) });
    else if (kind === 'clock')
        void runControl({ kind, speed: Number(el('control-speed').value), paused: input('control-paused').checked });
    else if (kind === 'volatility')
        void runControl({ kind, value: Number(input('control-volatility').value) });
});
for (const id of ['help-button', 'rail-help'])
    el(id).addEventListener('click', () => openTutorial());
el('report-button').addEventListener('click', openReport);
el('journal-button').addEventListener('click', openJournal);
el('terminal-button').addEventListener('click', closeModal);
el('modal-close').addEventListener('click', closeModal);
el('app-modal').addEventListener('click', event => { if (event.target !== el('app-modal'))
    return; const rect = el('app-modal').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)
    closeModal(); });
el('watch-search').addEventListener('input', renderWatch);
for (const id of ['lots-input', 'entry-input', 'sl-input', 'tp-input'])
    el(id).addEventListener('input', renderOrder);
el('side-buy').addEventListener('click', () => setSide('buy'));
el('side-sell').addEventListener('click', () => setSide('sell'));
el('lots-minus').addEventListener('click', () => setLots(Number(input('lots-input').value) - .01));
el('lots-plus').addEventListener('click', () => setLots(Number(input('lots-input').value) + .01));
el('auto-protection').addEventListener('click', () => { const q = book.quotes[book.selected]; if (!q)
    return; const entry = orderType === 'market' ? (side === 'buy' ? q.ask : q.bid) : Number(input('entry-input').value); if (!(entry > 0)) {
    toast('请先填写挂单价格', 'info');
    return;
} const distance = pipSize(book.selected) * 30; input('sl-input').value = price(entry + (side === 'buy' ? -distance : distance)); input('tp-input').value = price(entry + (side === 'buy' ? distance : -distance)); renderOrder(); });
el('submit-order').addEventListener('click', () => { if (mode === 'shared') {
    void runSharedTrade({ action: 'order', order: readOrder() });
    return;
} action(() => { const order = readOrder(); placeOrder(book.account, order, book.quotes, now()); tab = orderType === 'market' ? 'positions' : 'pending'; processAccount(book.account, book.quotes, now()); toast(`${orderType === 'market' ? '已成交' : '挂单已提交'} · ${side === 'buy' ? '买入' : '卖出'} ${book.selected} ${order.lots.toFixed(2)} 手`); }); });
el('close-all').addEventListener('click', () => { if (!book.account.positions.length)
    return; openModal('确认全部平仓', `<div class="settings-note">将尝试按当前有效报价关闭全部 ${book.account.positions.length} 笔持仓。没有有效报价的持仓保留。挂单继续有效。</div><div class="modal-actions"><button class="danger-button" data-action="confirm-close-all">确认全部平仓</button></div>`); });
el('modal-content').addEventListener('click', event => { if (!event.target.closest('[data-action="confirm-close-all"]'))
    return; if (mode === 'shared') {
    void runSharedTrade({ action: 'closeAll' });
    return;
} action(() => { let count = 0; const failures = []; for (const p of [...book.account.positions]) {
    try {
        closePosition(book.account, p.id, book.quotes, now());
        count++;
    }
    catch (e) {
        failures.push(e instanceof Error ? e.message : '无法成交');
    }
} closeModal(); toast(`已关闭 ${count} 笔持仓${failures.length ? ` · ${failures.length} 笔保留：${failures[0]}` : ''}`, failures.length ? 'info' : ''); }); });
el('pause-button').addEventListener('click', () => { if (!developer() || mode !== 'offline')
    return; paused = !paused; el('pause-button').innerHTML = icon(paused ? 'play' : 'pause'); el('pause-button').setAttribute('aria-label', paused ? '继续行情' : '暂停行情'); set('chart-hint', paused ? '行情已暂停 · 可以继续模拟下单' : '滚轮缩放 · 拖动查看历史'); renderInstrument(); });
el('speed-select').addEventListener('change', () => { if (!developer() || mode !== 'offline')
    return; speed = Number(el('speed-select').value); renderInstrument(); });
el('event-select').addEventListener('change', () => { const select = el('event-select'); const event = select.value; if (event && mode === 'offline' && developer())
    action(() => { shockMarket(book.market, event); log(book.account, now(), book.market.event); book.quotes = marketQuotes(book.market, OFFLINE_SYMBOLS, book.account.settings.spreadMultiplier); processAccount(book.account, book.quotes, now()); toast(book.market.event, 'info'); }); select.value = ''; });
el('ema-button').addEventListener('click', () => { chart.ema = !chart.ema; el('ema-button').classList.toggle('active', chart.ema); el('ema-legend').classList.toggle('hidden', !chart.ema); chart.draw(); });
el('reset-chart').addEventListener('click', () => chart.reset());
el('fullscreen-chart').addEventListener('click', () => { if (document.fullscreenElement)
    void document.exitFullscreen();
else
    void el('chart-panel').requestFullscreen().catch(() => toast('当前浏览器暂不支持全屏', 'info')); });
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) && !el('app-modal').open) {
    event.preventDefault();
    input('watch-search').focus();
} });
input('import-file').addEventListener('change', async () => {
    if (mode === 'shared') {
        toast('共享账户不支持导入本地存档', 'error');
        return;
    }
    const file = input('import-file').files?.[0];
    if (!file)
        return;
    try {
        if (file.size > 8 * 1024 * 1024)
            throw new Error('存档文件过大，最大 8 MB');
        const imported = validateBook(JSON.parse(await file.text()), mode);
        openModal('恢复当前模式存档', `<div class="settings-note">文件已校验：${mode === 'offline' ? '离线沙盒' : '云端共享'}，余额 ${money(imported.account.balance)} USD，${imported.account.positions.length} 笔持仓。确认后替换当前模式，另一模式不变。</div><div class="modal-actions"><button class="primary-button" id="confirm-import">确认恢复</button></div>`);
        el('confirm-import').addEventListener('click', () => { if (!canWrite) {
            toast('只读账户无法导入', 'error');
            return;
        } damaged.delete(mode); book = books[mode] = imported; if (book.market)
            book.quotes = marketQuotes(book.market, OFFLINE_SYMBOLS, book.account.settings.spreadMultiplier); closeModal(); chart.reset(); lastJournal = book.account.journal.length; render(); persist(); if (mode === 'online')
            void pollOnline(); toast('存档已恢复'); });
    }
    catch (error) {
        toast(error instanceof Error ? error.message : '存档解析失败', 'error');
    }
    input('import-file').value = '';
});
let lastTick = performance.now();
let lastSave = 0;
setInterval(() => {
    const tick = performance.now();
    const seconds = Math.min(2, (tick - lastTick) / 1000);
    lastTick = tick;
    if (mode === 'offline' && !paused && canWrite && !damaged.has(mode)) {
        let remaining = seconds * speed;
        while (remaining > .000001) {
            const step = Math.min(5, remaining);
            advanceMarket(book.market, step);
            book.quotes = marketQuotes(book.market, OFFLINE_SYMBOLS, book.account.settings.spreadMultiplier);
            for (const symbol of Object.keys(book.bars))
                if (book.quotes[symbol])
                    recordQuote(book.bars[symbol], book.quotes[symbol]);
            processAccount(book.account, book.quotes, book.market.time);
            remaining -= step;
        }
        render();
    }
    else if (mode === 'shared') {
        renderOrder();
        renderInstrument();
        if (Date.now() - lastSharedPoll >= 1000)
            void pollShared();
    }
    else if (mode === 'online') {
        renderAccount();
        renderOrder();
        renderInstrument();
        if (Date.now() - lastPoll >= pollSeconds * 1000)
            void pollOnline();
    }
    const recent = book.account.journal.slice(lastJournal);
    for (const entry of recent)
        if (entry.kind === 'warning' || /止损|止盈/.test(entry.message))
            toast(entry.message, entry.kind === 'warning' ? 'error' : 'info');
    lastJournal = book.account.journal.length;
    if (Date.now() - lastSave > 5000) {
        persist();
        lastSave = Date.now();
    }
}, 500);
window.addEventListener('pagehide', persist);
window.addEventListener('storage', event => { if (mode !== 'shared' && !canWrite && event.key === saveKey(mode)) {
    books[mode] = safeLoad(mode);
    book = books[mode];
    render();
} });
await initializeSession();
configureMode();
await acquireLock(mode);
lastJournal = book.account.journal.length;
render();
persist();
if (!localStorage.getItem('moneta.welcomed'))
    openWelcome();
if (mode === 'shared') {
    await pollShared();
    if (developer())
        void openDeveloper();
}
if (mode === 'online') {
    void loadSymbols();
    void pollOnline();
}
if ('serviceWorker' in navigator)
    void navigator.serviceWorker.register('/sw.js').catch(() => { });
