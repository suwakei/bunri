/**
 * bunri DAW — オートメーション曲線エディタ
 * Canvas 上にベジェ曲線でパラメータ変化を描画・編集
 * Vue.js コンポーネントから init() で初期化して使う
 */
class AutomationEditor {
    constructor() {
        this.canvas = null;
        this.ctx = null;

        // オートメーションデータ: trackId → paramName → [{time, value}]
        this.data = {};

        this.activeTrackId = null;
        this.activeParam = 'volume';
        this.draggingPoint = null;
        this.pixelsPerSecond = 80;
    }

    /**
     * DOM要素を受け取って初期化する（Vue の onMounted から呼ぶ）
     */
    init(elements) {
        this.canvas = elements.canvas;
        this.ctx = this.canvas.getContext('2d');

        this._resize();
        this._bindEvents();
    }

    _resize() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
    }

    setTrack(trackId, param) {
        this.activeTrackId = trackId;
        this.activeParam = param || 'volume';
        this.draw();
    }

    _getPoints() {
        if (!this.activeTrackId) return [];
        const key = `${this.activeTrackId}_${this.activeParam}`;
        if (!this.data[key]) this.data[key] = [];
        return this.data[key];
    }

    _setPoints(points) {
        if (!this.activeTrackId) return;
        const key = `${this.activeTrackId}_${this.activeParam}`;
        this.data[key] = points;
    }

    draw() {
        if (!this.canvas) return;
        this._resize();
        const { ctx, canvas } = this;
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        // 背景グリッド
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        for (let y = 0; y <= h; y += h / 4) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        // 拍線
        if (engine.bpm) {
            const beatSec = 60 / engine.bpm;
            const beatPx = beatSec * this.pixelsPerSecond;
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            for (let x = 0; x < w; x += beatPx) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
        }

        const points = this._getPoints();
        if (points.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.font = '12px sans-serif';
            ctx.fillText(
                this.activeTrackId
                    ? 'ダブルクリックでポイントを追加'
                    : 'トラックを選択してください',
                12, h / 2
            );
            return;
        }

        // 曲線描画
        ctx.strokeStyle = '#4ecdc4';
        ctx.lineWidth = 2;
        ctx.beginPath();

        const firstY = h - points[0].value * h;
        ctx.moveTo(0, firstY);

        for (let i = 0; i < points.length; i++) {
            const px = points[i].time * this.pixelsPerSecond;
            const py = h - points[i].value * h;

            if (i === 0) {
                ctx.lineTo(px, py);
            } else {
                const prev = points[i - 1];
                const prevX = prev.time * this.pixelsPerSecond;
                const prevY = h - prev.value * h;
                const cpx = (prevX + px) / 2;
                ctx.bezierCurveTo(cpx, prevY, cpx, py, px, py);
            }
        }

        const lastY = h - points[points.length - 1].value * h;
        ctx.lineTo(w, lastY);
        ctx.stroke();

        // ポイントを描画
        for (let i = 0; i < points.length; i++) {
            const px = points[i].time * this.pixelsPerSecond;
            const py = h - points[i].value * h;

            ctx.fillStyle = '#4ecdc4';
            ctx.beginPath();
            ctx.arc(px, py, 5, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(px, py, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // ラベル
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '10px sans-serif';
        const track = engine.getTrack(this.activeTrackId);
        const label = track ? `${track.name} — ${this.activeParam}` : '';
        ctx.fillText(label, 8, 14);
    }

    _bindEvents() {
        this.canvas.addEventListener('dblclick', (e) => {
            if (!this.activeTrackId) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const time = x / this.pixelsPerSecond;
            const value = 1 - (y / rect.height);

            const points = this._getPoints();
            points.push({ time: Math.max(0, time), value: Math.max(0, Math.min(1, value)) });
            points.sort((a, b) => a.time - b.time);
            this._setPoints(points);
            this.draw();
        });

        this.canvas.addEventListener('mousedown', (e) => {
            if (!this.activeTrackId) return;
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const points = this._getPoints();

            for (let i = 0; i < points.length; i++) {
                const px = points[i].time * this.pixelsPerSecond;
                const py = rect.height - points[i].value * rect.height;
                if (Math.abs(mx - px) < 8 && Math.abs(my - py) < 8) {
                    this.draggingPoint = i;
                    break;
                }
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (this.draggingPoint === null) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const points = this._getPoints();
            points[this.draggingPoint].time = Math.max(0, x / this.pixelsPerSecond);
            points[this.draggingPoint].value = Math.max(0, Math.min(1, 1 - y / rect.height));
            this.draw();
        });

        this.canvas.addEventListener('mouseup', () => {
            if (this.draggingPoint !== null) {
                const points = this._getPoints();
                points.sort((a, b) => a.time - b.time);
                this.draggingPoint = null;
                this.draw();
            }
        });

        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this.activeTrackId) return;
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const points = this._getPoints();

            for (let i = 0; i < points.length; i++) {
                const px = points[i].time * this.pixelsPerSecond;
                const py = rect.height - points[i].value * rect.height;
                if (Math.abs(mx - px) < 8 && Math.abs(my - py) < 8) {
                    points.splice(i, 1);
                    this._setPoints(points);
                    this.draw();
                    break;
                }
            }
        });

        window.addEventListener('resize', () => this.draw());
    }

    // シリアライズ
    toJSON() { return JSON.parse(JSON.stringify(this.data)); }
    fromJSON(data) { this.data = data || {}; this.draw(); }
}

// Vue側で初期化するため、自動インスタンス化しない
