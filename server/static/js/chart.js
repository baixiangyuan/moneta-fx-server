import { digits } from './engine.js';
export class PriceChart {
    canvas;
    onHover;
    ctx;
    bars = [];
    quote;
    positions = [];
    symbol = 'EUR/USD';
    width = 0;
    height = 0;
    count = 85;
    offset = 0;
    pointer;
    dragging;
    ema = true;
    constructor(canvas, onHover) {
        this.canvas = canvas;
        this.onHover = onHover;
        this.ctx = canvas.getContext('2d');
        new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
        canvas.addEventListener('wheel', event => { event.preventDefault(); this.count = Math.max(20, Math.min(250, this.count + Math.sign(event.deltaY) * 8)); this.draw(); }, { passive: false });
        canvas.addEventListener('pointermove', event => {
            const rect = canvas.getBoundingClientRect();
            this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            if (this.dragging) {
                this.offset = Math.max(0, Math.min(Math.max(0, this.bars.length - 10), this.dragging.offset + Math.round((this.dragging.x - event.clientX) / Math.max(1, (this.width - 80) / this.count)) * -1));
            }
            this.draw();
        });
        canvas.addEventListener('pointerleave', () => { this.pointer = undefined; this.onHover(this.bars.at(-1)); this.draw(); });
        canvas.addEventListener('pointerdown', event => { this.dragging = { x: event.clientX, offset: this.offset }; canvas.setPointerCapture(event.pointerId); });
        canvas.addEventListener('pointerup', () => { this.dragging = undefined; });
    }
    resize() { const rect = this.canvas.parentElement.getBoundingClientRect(); this.width = rect.width; this.height = rect.height; const dpr = window.devicePixelRatio || 1; this.canvas.width = this.width * dpr; this.canvas.height = this.height * dpr; this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.draw(); }
    reset() { this.offset = 0; this.count = 85; this.draw(); }
    update(bars, symbol, quote, positions = []) { this.bars = bars; this.symbol = symbol; this.quote = quote; this.positions = positions; this.draw(); }
    draw() {
        const { ctx, width: w, height: h } = this;
        if (!w || !h)
            return;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0d141c';
        ctx.fillRect(0, 0, w, h);
        const right = w - 72;
        const top = 52;
        const bottom = h - 28;
        const end = Math.max(0, this.bars.length - this.offset);
        const start = Math.max(0, end - this.count);
        const visible = this.bars.slice(start, end);
        if (!visible.length)
            return;
        let min = Math.min(...visible.map(b => b.low));
        let max = Math.max(...visible.map(b => b.high));
        if (this.quote && !this.offset) {
            min = Math.min(min, this.quote.mid);
            max = Math.max(max, this.quote.mid);
        }
        const padding = Math.max((max - min) * 0.14, max * 0.00012);
        min -= padding;
        max += padding;
        const y = (price) => top + (max - price) / (max - min) * (bottom - top);
        const step = (right - 18) / Math.max(visible.length + 3, 24);
        const x = (index) => 18 + (index + 0.5) * step;
        ctx.font = '9px "Segoe UI",sans-serif';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 5; i++) {
            const py = top + (bottom - top) * i / 5;
            ctx.strokeStyle = '#1b2631';
            ctx.beginPath();
            ctx.moveTo(0, Math.round(py) + .5);
            ctx.lineTo(right, Math.round(py) + .5);
            ctx.stroke();
            ctx.fillStyle = '#5d768d';
            ctx.fillText((max - (max - min) * i / 5).toFixed(digits(this.symbol)), right + 9, py + 3);
        }
        for (let i = 0; i < visible.length; i += Math.max(1, Math.floor(visible.length / 6))) {
            ctx.strokeStyle = '#1a2630';
            ctx.beginPath();
            ctx.moveTo(x(i), top - 8);
            ctx.lineTo(x(i), bottom);
            ctx.stroke();
            ctx.fillStyle = '#5b748b';
            ctx.fillText(new Date(visible[i].time).toISOString().slice(11, 16), x(i) - 12, h - 10);
        }
        visible.forEach((bar, i) => { const px = x(i); const green = bar.close >= bar.open; ctx.strokeStyle = ctx.fillStyle = green ? '#5dd8b2' : '#e78481'; ctx.beginPath(); ctx.moveTo(px, y(bar.high)); ctx.lineTo(px, y(bar.low)); ctx.stroke(); const upper = Math.min(y(bar.open), y(bar.close)); ctx.fillRect(px - Math.max(1, step * .31), upper, Math.max(2, step * .62), Math.max(1.1, Math.abs(y(bar.open) - y(bar.close)))); });
        if (this.ema)
            for (const [period, color] of [[20, '#d5b276'], [60, '#8993bf']]) {
                let value = this.bars[0].close;
                const alpha = 2 / (period + 1);
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                for (let i = 0; i < end; i++) {
                    value = this.bars[i].close * alpha + value * (1 - alpha);
                    if (i >= start) {
                        if (i === start)
                            ctx.moveTo(x(i - start), y(value));
                        else
                            ctx.lineTo(x(i - start), y(value));
                    }
                }
                ctx.stroke();
            }
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, top - 6, right, bottom - top + 6);
        ctx.clip();
        for (const position of this.positions.filter(p => p.symbol === this.symbol)) {
            for (const [price, label, color] of [[position.entry, `${position.side === 'buy' ? 'BUY' : 'SELL'} ${position.lots.toFixed(2)}`, '#8aaac2'], [position.sl, 'SL', '#ef827f'], [position.tp, 'TP', '#60dcb4']]) {
                if (!price || price < min || price > max)
                    continue;
                ctx.setLineDash([4, 5]);
                ctx.lineWidth = 1;
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.moveTo(8, y(price));
                ctx.lineTo(right, y(price));
                ctx.stroke();
                ctx.fillStyle = '#182632';
                ctx.fillRect(9, y(price) - 8, 63, 15);
                ctx.fillStyle = color;
                ctx.fillText(label, 13, y(price) + 3);
            }
        }
        ctx.restore();
        ctx.setLineDash([]);
        if (this.quote && !this.offset) {
            const py = y(this.quote.mid);
            ctx.setLineDash([3, 4]);
            ctx.strokeStyle = '#5dccaa77';
            ctx.beginPath();
            ctx.moveTo(0, py);
            ctx.lineTo(right, py);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#5dd8b2';
            ctx.fillRect(right, py - 10, 70, 20);
            ctx.fillStyle = '#0e2b22';
            ctx.font = '10px "Segoe UI",sans-serif';
            ctx.fillText(this.quote.mid.toFixed(digits(this.symbol)), right + 7, py + 4);
        }
        if (this.pointer && this.pointer.x < right && this.pointer.y >= top && this.pointer.y <= bottom) {
            const i = Math.max(0, Math.min(visible.length - 1, Math.round((this.pointer.x - 18) / step - .5)));
            const px = x(i);
            const py = this.pointer.y;
            ctx.setLineDash([3, 4]);
            ctx.strokeStyle = '#728ca6';
            ctx.beginPath();
            ctx.moveTo(px, top);
            ctx.lineTo(px, bottom);
            ctx.moveTo(0, py);
            ctx.lineTo(right, py);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#34485c';
            ctx.fillRect(right, py - 9, 70, 18);
            ctx.fillStyle = '#e0e9f0';
            ctx.font = '9px "Segoe UI",sans-serif';
            ctx.fillText((max - (py - top) / (bottom - top) * (max - min)).toFixed(digits(this.symbol)), right + 7, py + 3);
            ctx.fillStyle = '#34485c';
            ctx.fillRect(px - 37, bottom + 3, 74, 19);
            ctx.fillStyle = '#d0dfeb';
            ctx.fillText(new Date(visible[i].time).toISOString().slice(5, 16).replace('T', ' '), px - 32, bottom + 16);
            this.onHover(visible[i]);
        }
        else
            this.onHover(visible.at(-1));
    }
}
