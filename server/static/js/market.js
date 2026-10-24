import { pipSize } from './engine.js';
export const CURRENCIES = {
    USD: { name: '美元', value: 1 }, EUR: { name: '欧元', value: 1.085 }, GBP: { name: '英镑', value: 1.275 }, JPY: { name: '日元', value: 1 / 151.2 }, CHF: { name: '瑞郎', value: 1.12 }, AUD: { name: '澳元', value: 0.665 }, CAD: { name: '加元', value: 0.73 }, NZD: { name: '纽元', value: 0.615 }, CNY: { name: '人民币', value: 0.139 }, HKD: { name: '港元', value: 0.128 }, SGD: { name: '新加坡元', value: 0.745 }, NOK: { name: '挪威克朗', value: 0.093 }, SEK: { name: '瑞典克朗', value: 0.095 }, DKK: { name: '丹麦克朗', value: 0.146 }, ZAR: { name: '南非兰特', value: 0.054 }, TRY: { name: '土耳其里拉', value: 0.03 }, MXN: { name: '墨西哥比索', value: 0.057 }, PLN: { name: '波兰兹罗提', value: 0.25 }, HUF: { name: '匈牙利福林', value: 0.0028 }, CZK: { name: '捷克克朗', value: 0.043 }, INR: { name: '印度卢比', value: 0.012 }, KRW: { name: '韩元', value: 0.00074 }, BRL: { name: '巴西雷亚尔', value: 0.198 }, THB: { name: '泰铢', value: 0.027 }, AED: { name: '阿联酋迪拉姆', value: 0.272 }, SAR: { name: '沙特里亚尔', value: 0.267 }
};
export const MAJORS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF', 'USD/CAD', 'NZD/USD'];
export const WATCHLIST = [...MAJORS, 'EUR/JPY', 'GBP/JPY', 'EUR/GBP', 'EUR/CHF', 'AUD/JPY', 'GBP/CHF', 'AUD/NZD', 'EUR/AUD', 'CAD/JPY', 'USD/CNY', 'USD/HKD', 'USD/SGD', 'USD/MXN', 'USD/ZAR', 'USD/TRY'];
export const OFFLINE_SYMBOLS = [...new Set([...WATCHLIST, ...Object.keys(CURRENCIES).flatMap((a, i) => Object.keys(CURRENCIES).slice(i + 1).map(b => `${a}/${b}`))])];
export const symbolName = (symbol) => symbol.split('/').map(c => CURRENCIES[c]?.name ?? c).join(' / ');
function random(market) { let value = market.seed | 0; value ^= value << 13; value ^= value >>> 17; value ^= value << 5; market.seed = value >>> 0; return (market.seed + 1) / 4294967297; }
function gaussian(market) { return Math.sqrt(-2 * Math.log(Math.max(random(market), 1e-10))) * Math.cos(2 * Math.PI * random(market)); }
export function createMarket(seed = 735191, time = Date.now()) {
    const values = Object.fromEntries(Object.entries(CURRENCIES).map(([code, currency]) => [code, currency.value]));
    return { seed: seed || 1, time, values: { ...values }, anchor: { ...values }, baseline: { ...values }, shock: {}, volatility: 1, bars: {}, event: '常态市场' };
}
export function advanceMarket(market, seconds) {
    const global = gaussian(market) * 0.000008 * Math.sqrt(seconds) * market.volatility;
    for (const code of Object.keys(market.values)) {
        if (code === 'USD')
            continue;
        const exotic = !['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'HKD', 'AED', 'SAR'].includes(code);
        const noise = gaussian(market) * (exotic ? 0.000022 : 0.000014) * Math.sqrt(seconds) * market.volatility;
        const reversion = Math.log(market.anchor[code] / market.values[code]) * seconds / 200000;
        const shock = market.shock[code] ?? 0;
        market.values[code] *= Math.exp(noise + global + reversion + shock * seconds);
        if (Math.abs(shock) > 0.00000001)
            market.shock[code] = shock * Math.exp(-seconds / 240);
    }
    market.time += seconds * 1000;
    market.volatility = 1 + (market.volatility - 1) * Math.exp(-seconds / 1800);
}
export function marketQuotes(market, symbols = WATCHLIST, spreadMultiplier = 1) {
    const quotes = {};
    for (const symbol of symbols) {
        const [base, term] = symbol.split('/');
        if (!market.values[base] || !market.values[term])
            continue;
        const mid = market.values[base] / market.values[term];
        const normal = MAJORS.includes(symbol) ? 1.2 : mid > 100 && term !== 'JPY' ? 80 : WATCHLIST.includes(symbol) ? 2.4 : 6;
        const half = Math.min(mid * 0.004, pipSize(symbol) * normal * spreadMultiplier * Math.sqrt(market.volatility) / 2);
        quotes[symbol] = { symbol, mid, bid: mid - half, ask: mid + half, time: market.time, marketOpen: true };
    }
    return quotes;
}
export function recordQuote(bars, quote, interval = 60000) {
    const time = Math.floor(quote.time / interval) * interval;
    const last = bars.at(-1);
    if (last?.time === time) {
        last.close = quote.mid;
        last.high = Math.max(last.high, quote.mid);
        last.low = Math.min(last.low, quote.mid);
    }
    else if (!last || time > last.time)
        bars.push({ time, open: quote.mid, high: quote.mid, low: quote.mid, close: quote.mid });
    if (bars.length > 2000)
        bars.splice(0, bars.length - 2000);
}
export function bootstrapMarket(seed = 735191, time = Date.now()) {
    const market = createMarket(seed, time - 360 * 60000);
    for (let i = 0; i < 360; i++) {
        for (let j = 0; j < 4; j++) {
            advanceMarket(market, 15);
            for (const quote of Object.values(marketQuotes(market)))
                recordQuote(market.bars[quote.symbol] ??= [], quote);
        }
    }
    return market;
}
export function shockMarket(market, scenario) {
    market.volatility = scenario === 'storm' ? 7 : 3;
    if (scenario === 'dollar') {
        for (const code of Object.keys(market.values))
            if (code !== 'USD')
                market.shock[code] = -0.000005;
        market.event = '虚构事件 · 美元突然走强';
    }
    else if (scenario === 'euro') {
        market.shock.EUR = 0.000011;
        market.event = '虚构事件 · 欧元利好';
    }
    else if (scenario === 'yen') {
        market.shock.JPY = 0.000014;
        market.event = '虚构事件 · 日元干预冲击';
    }
    else {
        market.event = '虚构事件 · 流动性风暴';
        for (const code of Object.keys(market.values))
            if (code !== 'USD')
                market.values[code] *= Math.exp(gaussian(market) * 0.0025);
    }
}
export function aggregateBars(bars, minutes) {
    const result = [];
    const interval = minutes * 60000;
    for (const bar of bars) {
        const time = Math.floor(bar.time / interval) * interval;
        const last = result.at(-1);
        if (last?.time === time) {
            last.high = Math.max(last.high, bar.high);
            last.low = Math.min(last.low, bar.low);
            last.close = bar.close;
            if (bar.synthetic)
                last.synthetic = true;
        }
        else
            result.push({ ...bar, time });
    }
    return result;
}
