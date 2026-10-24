import { ApiError, worldAPI } from './shared.js';
const escape = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (value) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (value) => `${value >= 0 ? '+' : ''}${money(value)}`;
const date = (time) => time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '早期存档 · 时间未记录';
const presence = (value) => ({ online: '活跃', idle: '已登录 · 暂离', offline: '未登录' })[value] || value;
const empty = (message) => `<div class="admin-empty">${message}</div>`;
const stat = (label, value, extra = '') => `<div class="admin-stat ${extra}"><span>${label}</span><strong>${value}</strong></div>`;
export const adminMarkup = () => `<div id="admin-dashboard"><div class="admin-toolbar"><span class="role-badge">管理员专属</span><span id="admin-updated" class="muted">读取账户中…</span><button type="button" class="secondary-button" data-admin-refresh>刷新</button></div><p class="account-intro">查看共享虚构市场的普通账户，资金均为游戏模拟资金。活跃表示最近 15 秒有访问，数据每 5 秒更新。</p><p id="admin-error" role="alert" class="negative"></p><div id="admin-summary" class="admin-overview"></div><div class="admin-layout"><aside class="admin-sidebar"><label for="admin-search" class="field-label">普通账户</label><input id="admin-search" class="field-input" placeholder="搜索用户名或账户 ID" autocomplete="off"><div id="admin-account-list" class="admin-account-list"></div></aside><section class="admin-main"><div id="admin-detail">${empty('选择账户查看状况，或在另一个浏览器注册一个普通账户。')}</div><div id="admin-account-sections" class="hidden"><div class="admin-tabs" role="tablist"><button data-admin-tab="activity" class="active" role="tab">操作记录</button><button data-admin-tab="positions" role="tab">持仓</button><button data-admin-tab="pending" role="tab">挂单</button><button data-admin-tab="history" role="tab">成交历史</button><button data-admin-tab="journal" role="tab">交易日志</button></div><div id="admin-records" class="admin-records"></div><div id="admin-funding" class="control-section"></div></div></section></div><section class="control-section"><div class="control-section-title"><h3>资金调度流水 <span id="admin-ledger-count" class="muted"></span></h3><button class="text-button" data-admin-ledger-latest>回到最新</button></div><div id="admin-ledger"></div><button type="button" id="admin-ledger-older" class="secondary-button hidden" data-admin-ledger-older>查看更早流水</button></section></div>`;
export function mountAdmin(root, ownerId, onUnauthorized) {
    const abort = new AbortController();
    const query = (id) => root.querySelector(`#${id}`);
    let accounts = [];
    let selected = '';
    let detail = null;
    let active = true;
    let busy = false;
    let fundingBusy = false;
    let tab = 'activity';
    let before = null;
    let ledgerBefore = null;
    let ledgerNext = null;
    let historyCount = 100;
    let pending = null;
    let preview = null;
    const pendingKey = `moneta.admin-funding.${ownerId}`;
    try {
        const saved = localStorage.getItem(pendingKey);
        if (saved)
            pending = JSON.parse(saved);
    }
    catch { /* Damaged local draft must not affect server funds. */ }
    function errorText(error) { return error instanceof Error ? error.message : '读取失败，请重试'; }
    function showError(error) {
        if (!active)
            return;
        query('admin-error').textContent = errorText(error);
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
            onUnauthorized();
            destroy();
        }
    }
    function renderAccounts() {
        const text = query('admin-search').value.trim().toLowerCase();
        const matches = accounts.filter(user => user.username.toLowerCase().includes(text) || user.id.includes(text));
        query('admin-account-list').innerHTML = matches.length ? matches.map(user => `<button type="button" class="admin-account ${user.id === selected ? 'selected' : ''}" data-admin-account="${user.id}"><div><strong>${escape(user.username)}</strong><span class="admin-presence ${user.presence}">${presence(user.presence)}</span></div><small>${money(user.balance)} USD</small><small>${user.positions} 持仓 · ${user.pending} 挂单</small></button>`).join('') : empty(accounts.length ? '没有匹配的账户' : '还没有普通账户');
    }
    function table(headers, rows) { return rows.length ? `<div class="admin-table-scroll"><table class="admin-table"><thead><tr>${headers.map(v => `<th>${v}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty('暂无记录'); }
    function renderDetail() {
        if (!detail)
            return;
        const user = detail.user;
        const m = user.metrics;
        query('admin-detail').innerHTML = `<div class="admin-identity"><h3>${escape(user.username)}</h3><span class="admin-presence ${user.presence}">${presence(user.presence)}</span></div><p class="admin-id">${user.id}</p><div class="admin-metrics">${stat('账户余额 · USD', money(user.balance))}${stat('净值 · USD', money(m.equity))}${stat('浮动盈亏', signed(m.unrealized), m.unrealized < 0 ? 'negative' : 'positive')}${stat('占用保证金', money(m.margin))}${stat('可用保证金', money(m.freeMargin))}${stat('保证金比例', m.marginLevel === null ? '空仓' : money(m.marginLevel) + '%')}${stat('累计净调入', signed(user.netFunding))}${stat('交易盈亏（含费用）', signed(user.tradingPnl), user.tradingPnl < 0 ? 'negative' : 'positive')}</div><p class="admin-dates">注册 ${date(user.createdAt)}<br>最近登录 ${date(user.lastLoginAt)} · 最近访问 ${date(user.lastSeenAt)}</p>`;
        query('admin-account-sections').classList.remove('hidden');
        renderRecords();
        if (query('funding-limit'))
            query('funding-limit').textContent = `当前最多可调出 ${money(user.transferable)} USD；提交时按最新状态校验。`;
    }
    function renderRecords() {
        if (!detail)
            return;
        const account = detail.account;
        let html;
        if (tab === 'positions')
            html = table(['货币对 / 方向', '手数', '入场价', '止损 / 止盈', '保证金', '开仓时间'], account.positions.map(p => [p.symbol + ' · ' + (p.side === 'buy' ? '买入' : '卖出'), p.lots.toFixed(2), String(p.entry), `${p.sl ?? '—'} / ${p.tp ?? '—'}`, money(p.margin), date(p.openedAt)]));
        else if (tab === 'pending')
            html = table(['货币对 / 方向', '类型', '手数', '触发价', 'SL / TP', '提交时间'], account.pending.map(p => [p.symbol + ' · ' + (p.side === 'buy' ? '买入' : '卖出'), p.type === 'limit' ? '限价' : '突破', p.lots.toFixed(2), String(p.price), `${p.sl ?? '—'} / ${p.tp ?? '—'}`, date(p.createdAt)]));
        else if (tab === 'history')
            html = table(['货币对 / 方向', '手数', '进 / 出场', '净盈亏', '成交原因', '平仓时间'], [...account.history].reverse().slice(0, historyCount).map(p => [p.symbol + ' · ' + (p.side === 'buy' ? '买入' : '卖出'), p.lots.toFixed(2), `${p.entry} / ${p.exit}`, signed(p.netPnl), escape(p.reason), date(p.closedAt)])) + (account.history.length > historyCount ? '<button class="secondary-button" data-admin-history-older>加载更早成交</button>' : '');
        else if (tab === 'journal')
            html = `<p class="admin-record-note">账户内最近 ${account.journal.length} 条日志；完整的新操作保存在「操作记录」。下方时间为市场时间。</p>` + table(['市场时间', '日志'], [...account.journal].reverse().map(e => [date(e.time), escape(e.message)]));
        else
            html = `<div class="admin-record-toolbar"><span>共 ${detail.activity.total} 条操作 · ${before ? '历史页' : '最新记录'}</span><button class="text-button" data-admin-activity-latest>回到最新</button></div>` + (detail.activity.entries.length ? `<div class="admin-timeline">${detail.activity.entries.map(entry => `<div class="admin-event ${entry.kind === 'warning' ? 'warning' : ''}"><time>${entry.realTime ? date(entry.realTime) : '早期日志 · 市场时间 ' + date(entry.time)}</time><p>${escape(entry.message)}</p>${entry.fundingId ? `<small>资金流水 ${escape(entry.fundingId)}</small>` : ''}</div>`).join('')}</div>` : empty('暂无操作')) + (detail.activity.nextBefore ? '<button class="secondary-button" data-admin-activity-older>查看更早操作</button>' : '');
        query('admin-records').innerHTML = html;
    }
    function renderFunding() {
        const user = accounts.find(a => a.id === selected);
        if (!user)
            return;
        query('admin-funding').innerHTML = `<h3>资金调度 · ${escape(user.username)}</h3><p class="admin-record-note">金额以 USD 计，最多两位小数。入金增加模拟资金，扣款回收资金，转账从当前账户转给另一普通账户。</p><form id="admin-funding-form"><fieldset id="funding-fields"><div class="settings-grid"><div class="settings-field"><label for="funding-kind">调度方式</label><select id="funding-kind"><option value="credit">管理员入金</option><option value="debit">管理员扣款</option><option value="transfer">转给另一账户</option></select></div><div class="settings-field"><label for="funding-amount">金额（USD）</label><input id="funding-amount" type="number" min="0.01" max="100000000" step="0.01" placeholder="例如 1000.00" required></div><div id="funding-destination-field" class="settings-field hidden"><label for="funding-destination">收款账户</label><select id="funding-destination"><option value="">请选择收款账户</option>${accounts.filter(a => a.id !== selected).map(a => `<option value="${a.id}">${escape(a.username)}</option>`).join('')}</select></div><div class="settings-field funding-reason"><label for="funding-reason">调度原因</label><input id="funding-reason" minlength="2" maxlength="200" placeholder="例如：新手练习奖励" required></div></div><p id="funding-limit" class="admin-record-note"></p><button class="primary-button" id="funding-preview-button" type="submit">预览调度</button></fieldset></form><div id="funding-preview" class="hidden"></div><p id="funding-feedback" role="status"></p><button class="secondary-button hidden" id="funding-retry" type="button" data-admin-funding-retry>按原编号重试 / 确认结果</button>`;
        if (pending) {
            query('funding-fields').disabled = true;
            query('funding-retry').classList.remove('hidden');
            query('funding-feedback').textContent = `有一笔 ${pending.amount} USD 调度尚待确认，请先按原编号重试。`;
        }
    }
    async function refresh() {
        if (!active || busy || fundingBusy)
            return;
        busy = true;
        const requestSelected = selected;
        const requestBefore = before;
        const requestLedger = ledgerBefore;
        try {
            const [list, response, ledger] = await Promise.all([
                worldAPI('/api/admin/accounts'),
                selected ? worldAPI(`/api/admin/account?id=${selected}&limit=50${before ? '&before=' + before : ''}`) : Promise.resolve(null),
                worldAPI(`/api/admin/ledger?limit=20${ledgerBefore ? '&before=' + ledgerBefore : ''}`)
            ]);
            if (!active)
                return;
            accounts = list.accounts;
            query('admin-error').textContent = '';
            query('admin-updated').textContent = `更新于 ${new Date(list.realTime).toLocaleTimeString('zh-CN', { hour12: false })}`;
            query('admin-summary').innerHTML = stat('普通账户', String(list.totals.accounts)) + stat('当前活跃', String(list.totals.online), 'positive') + stat('总余额 · USD', money(list.totals.balance)) + stat('总净值 · USD', money(list.totals.equity));
            renderAccounts();
            if (response && selected === requestSelected && before === requestBefore) {
                detail = response;
                renderDetail();
            }
            if (requestLedger === ledgerBefore) {
                ledgerNext = ledger.nextBefore;
                query('admin-ledger-count').textContent = `共 ${ledger.total} 笔`;
                query('admin-ledger').innerHTML = table(['实际时间 / 操作者', '方式 / 金额', '账户与余额变化', '原因 / 流水编号'], ledger.entries.map(e => [date(e.realTime) + '<br>' + escape(e.actor), ({ credit: '入金', debit: '扣款', transfer: '转账' })[e.kind] + '<br>' + money(e.amountCents / 100) + ' USD', e.changes.map(c => `${escape(c.username)} ${signed(c.deltaCents / 100)}<br><small>${money(c.before)} → ${money(c.after)}</small>`).join('<br>'), escape(e.reason) + `<br><small>${e.transactionId}</small>`]));
                query('admin-ledger-older').classList.toggle('hidden', !ledgerNext);
            }
            if (!selected && accounts.length) {
                selected = pending?.accountId || accounts[0].id;
                renderFunding();
                busy = false;
                void refresh();
            }
        }
        catch (error) {
            showError(error);
        }
        finally {
            busy = false;
        }
    }
    function selectAccount(id) { if (pending || fundingBusy) {
        query('funding-feedback').textContent = '请先确认正在处理的调度，再切换账户。';
        return;
    } selected = id; detail = null; before = null; historyCount = 100; preview = null; renderAccounts(); renderFunding(); if (!busy)
        void refresh(); }
    function showPreview() {
        if (fundingBusy || pending)
            return;
        const kind = query('funding-kind').value;
        const destinationId = query('funding-destination').value;
        if (kind === 'transfer' && !destinationId) {
            query('funding-feedback').textContent = '请选择收款账户';
            return;
        }
        const amount = query('funding-amount').value;
        const reason = query('funding-reason').value.trim();
        if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || reason.length < 2) {
            query('funding-feedback').textContent = '请填写正数金额（最多两位小数）及至少两个字符的原因。';
            return;
        }
        preview = { kind, accountId: selected, ...(kind === 'transfer' ? { destinationId } : {}), amount, reason, requestId: crypto.randomUUID() };
        const source = accounts.find(u => u.id === selected);
        const target = accounts.find(u => u.id === destinationId);
        query('funding-preview').classList.remove('hidden');
        query('funding-feedback').textContent = '';
        query('funding-preview').innerHTML = `<div class="funding-confirmation"><strong>${({ credit: '入金到', debit: '从账户扣款', transfer: '转账' })[kind]} ${escape(source.username)}${target && kind === 'transfer' ? ' → ' + escape(target.username) : ''} · ${money(Number(amount))} USD</strong><p>原因：${escape(reason)}</p><p>资金变更将立即生效并保存流水。</p><button class="primary-button" id="funding-confirm" data-admin-funding-confirm>确认执行</button><button class="text-button" data-admin-funding-cancel>修改</button></div>`;
        query('funding-fields').disabled = true;
    }
    async function submitFunding() {
        if (fundingBusy || (!pending && !preview))
            return;
        pending ??= preview;
        preview = null;
        try {
            localStorage.setItem(pendingKey, JSON.stringify(pending));
        }
        catch {
            query('funding-feedback').textContent = '浏览器无法保存重试编号，请启用本地存储后再执行。';
            pending = null;
            query('funding-fields').disabled = false;
            return;
        }
        fundingBusy = true;
        query('funding-fields').disabled = true;
        const confirm = query('funding-confirm');
        if (confirm)
            confirm.disabled = true;
        query('funding-retry').disabled = true;
        query('funding-feedback').textContent = '提交调度中…';
        try {
            const result = await worldAPI('/api/admin/funding', pending);
            localStorage.removeItem(pendingKey);
            pending = null;
            if (!active)
                return;
            query('funding-feedback').textContent = `调度成功${result.duplicate ? ' · 已确认原操作，未重复执行' : ''} · 流水 ${result.entry.transactionId}`;
            query('funding-preview').classList.add('hidden');
            query('funding-retry').classList.add('hidden');
            query('funding-fields').disabled = false;
            query('funding-amount').value = '';
            ledgerBefore = null;
            before = null;
        }
        catch (error) {
            if (!active)
                return;
            query('funding-feedback').textContent = errorText(error);
            if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401, 403].includes(error.status)) {
                localStorage.removeItem(pendingKey);
                pending = null;
                query('funding-fields').disabled = false;
                query('funding-preview').classList.add('hidden');
                query('funding-retry').classList.add('hidden');
            }
            else {
                query('funding-retry').classList.remove('hidden');
                query('funding-preview').classList.add('hidden');
                if (error instanceof ApiError && [401, 403].includes(error.status))
                    showError(error);
            }
        }
        finally {
            fundingBusy = false;
            if (active) {
                query('funding-retry').disabled = false;
                void refresh();
            }
        }
    }
    root.addEventListener('input', event => { if (event.target.id === 'admin-search')
        renderAccounts(); }, { signal: abort.signal });
    root.addEventListener('change', event => { if (event.target.id === 'funding-kind')
        query('funding-destination-field').classList.toggle('hidden', query('funding-kind').value !== 'transfer'); }, { signal: abort.signal });
    root.addEventListener('submit', event => { if (event.target.id !== 'admin-funding-form')
        return; event.preventDefault(); showPreview(); }, { signal: abort.signal });
    root.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button)
            return;
        const data = button.dataset;
        if (data.adminAccount)
            selectAccount(data.adminAccount);
        if (data.adminTab) {
            tab = data.adminTab;
            root.querySelectorAll('[data-admin-tab]').forEach(b => { b.classList.toggle('active', b.dataset.adminTab === tab); b.setAttribute('aria-selected', String(b.dataset.adminTab === tab)); });
            renderRecords();
        }
        if ('adminRefresh' in data)
            void refresh();
        if ('adminActivityOlder' in data && detail?.activity.nextBefore) {
            before = detail.activity.nextBefore;
            void refresh();
        }
        if ('adminActivityLatest' in data) {
            before = null;
            void refresh();
        }
        if ('adminHistoryOlder' in data) {
            historyCount += 100;
            renderRecords();
        }
        if ('adminLedgerOlder' in data && ledgerNext) {
            ledgerBefore = ledgerNext;
            void refresh();
        }
        if ('adminLedgerLatest' in data) {
            ledgerBefore = null;
            void refresh();
        }
        if ('adminFundingConfirm' in data || 'adminFundingRetry' in data)
            void submitFunding();
        if ('adminFundingCancel' in data) {
            preview = null;
            query('funding-preview').classList.add('hidden');
            query('funding-fields').disabled = false;
        }
    }, { signal: abort.signal });
    const timer = setInterval(() => { void refresh(); }, 5000);
    function destroy() { active = false; clearInterval(timer); abort.abort(); }
    void refresh();
    return destroy;
}
