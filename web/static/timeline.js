/**
 * bunri DAW — タイムライン / アレンジメントビュー
 * トラック上にクリップを非破壊で配置・移動
 * Vue.js コンポーネントから init() で初期化して使う
 */
class Timeline {
    constructor() {
        this.container = null;
        this.headerCanvas = null;
        this.headerCtx = null;
        this.pixelsPerSecond = 80;
        this.draggingClip = null;
        this.dragOffsetX = 0;

        // コールバック（Vue側で設定）
        this.onStatus = null;
        this.onTrackSelect = null;
        this.onTracksChanged = null;
    }

    /**
     * DOM要素を受け取って初期化する（Vue の onMounted から呼ぶ）
     */
    init(elements) {
        this.container = elements.container;
        this.headerCanvas = elements.headerCanvas;
        this.headerCtx = this.headerCanvas.getContext('2d');

        this._drawHeader();
        this._bindGlobalEvents();
    }

    _setStatus(msg) {
        if (this.onStatus) this.onStatus(msg);
    }

    _drawHeader() {
        if (!this.headerCanvas) return;
        const totalSec = Math.max(30, engine.getTotalDuration() + 10);
        const w = totalSec * this.pixelsPerSecond;
        this.headerCanvas.width = w;
        this.headerCanvas.height = 24;
        this.headerCanvas.style.width = w + 'px';

        const ctx = this.headerCtx;
        ctx.fillStyle = '#17171e';
        ctx.fillRect(0, 0, w, 24);

        const bpm = engine.bpm;
        const beatSec = 60 / bpm;
        const beatsPerBar = engine.beatsPerBar;
        const barSec = beatSec * beatsPerBar;

        for (let t = 0; t < totalSec; t += beatSec) {
            const x = t * this.pixelsPerSecond;
            const barNum = Math.floor(t / barSec) + 1;
            const beatInBar = Math.round((t % barSec) / beatSec);

            if (beatInBar === 0) {
                ctx.fillStyle = '#e0e0e0';
                ctx.font = '10px sans-serif';
                ctx.fillText(barNum.toString(), x + 3, 14);
                ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            } else {
                ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            }
            ctx.beginPath();
            ctx.moveTo(x, 16);
            ctx.lineTo(x, 24);
            ctx.stroke();
        }
    }

    render() {
        if (!this.container) return;
        this.container.innerHTML = '';
        this._drawHeader();

        for (const track of engine.tracks) {
            const row = document.createElement('div');
            row.className = 'track-row';

            // トラックヘッダー
            const isActive = window.pianoRoll && window.pianoRoll.getActiveTrackId() === track.id;
            const noteCount = (track.pianoNotes || []).length;
            const notesBadge = noteCount > 0 ? `<span class="notes-badge" title="${noteCount}ノート">${noteCount}</span>` : '';
            const header = document.createElement('div');
            header.className = 'track-header' + (isActive ? ' active-track' : '');
            header.dataset.trackId = track.id;
            const isTrackPlaying = engine.isPlaying && engine.soloTrackId === track.id;
            header.innerHTML = `
                <span class="track-name">${track.name} ${notesBadge}</span>
                <div class="track-controls">
                    <button class="btn-track-play ${isTrackPlaying ? 'playing' : ''}" data-track="${track.id}" title="このトラックだけ再生">${isTrackPlaying ? '⏸' : '▶'}</button>
                    <button class="btn-mute ${track.mute ? 'muted' : ''}" data-track="${track.id}">M</button>
                    <button class="btn-solo ${track.solo ? 'soloed' : ''}" data-track="${track.id}">S</button>
                    <button class="btn-delete-track" data-track="${track.id}">✕</button>
                </div>
            `;
            row.appendChild(header);

            // クリップ描画エリア
            const canvasWrap = document.createElement('div');
            canvasWrap.className = 'track-canvas-wrap';
            canvasWrap.dataset.trackId = track.id;

            const totalSec = Math.max(30, engine.getTotalDuration() + 10);
            canvasWrap.style.width = (totalSec * this.pixelsPerSecond) + 'px';

            // クリップ
            track.clips.forEach((clip, ci) => {
                const clipEl = document.createElement('div');
                clipEl.className = 'clip';
                clipEl.style.left = (clip.offset * this.pixelsPerSecond) + 'px';
                clipEl.style.width = (clip.duration * this.pixelsPerSecond) + 'px';
                clipEl.textContent = clip.name;
                clipEl.dataset.trackId = track.id;
                clipEl.dataset.clipIndex = ci;
                clipEl.title = `${clip.name}\n開始: ${clip.offset.toFixed(1)}s\n長さ: ${clip.duration.toFixed(1)}s`;

                clipEl.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this.draggingClip = { trackId: track.id, clipIndex: ci, element: clipEl };
                    this.dragOffsetX = e.clientX - clipEl.getBoundingClientRect().left;
                });

                clipEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    engine.removeClip(track.id, ci);
                    this.render();
                });

                canvasWrap.appendChild(clipEl);
            });

            // ドロップ対応
            canvasWrap.addEventListener('dragover', (e) => e.preventDefault());
            canvasWrap.addEventListener('drop', async (e) => {
                e.preventDefault();
                const files = e.dataTransfer.files;
                if (files.length === 0) return;
                const rect = canvasWrap.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const offsetSec = x / this.pixelsPerSecond;
                for (const file of files) {
                    if (!file.name.endsWith('.wav')) continue;
                    await engine.addClipFromFile(track.id, file, offsetSec);
                }
                this.render();
                this._setStatus('クリップを追加しました');
                if (this.onTracksChanged) this.onTracksChanged();
            });

            row.appendChild(canvasWrap);
            this.container.appendChild(row);
        }

        this._bindTrackEvents();
    }

    _bindTrackEvents() {
        // トラックヘッダークリック → ピアノロール切替
        this.container.querySelectorAll('.track-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') return;
                const id = parseInt(header.dataset.trackId);
                if (window.pianoRoll) {
                    window.pianoRoll.switchToTrack(id);
                    this.render();
                    const track = engine.getTrack(id);
                    this._setStatus(`ピアノロール: ${track ? track.name : ''}`);
                    if (this.onTrackSelect) this.onTrackSelect(id);
                }
            });
        });
        // トラック個別再生
        this.container.querySelectorAll('.btn-track-play').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track);
                const track = engine.getTrack(id);
                if (!track) return;

                if (engine.isPlaying && engine.soloTrackId === id) {
                    engine.pause();
                    document.getElementById('btn-play').textContent = '▶';
                    this._setStatus('一時停止');
                } else {
                    engine.playSingleTrack(id);
                    document.getElementById('btn-play').textContent = '⏸';
                    this._setStatus(`再生中: ${track.name}`);
                }
                this.render();
            });
        });
        // ミュート
        this.container.querySelectorAll('.btn-mute').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track);
                engine.toggleMute(id);
                this.render();
            });
        });
        // ソロ
        this.container.querySelectorAll('.btn-solo').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track);
                const track = engine.getTrack(id);
                if (track) track.solo = !track.solo;
                this.render();
            });
        });
        // 削除
        this.container.querySelectorAll('.btn-delete-track').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track);
                if (window.pianoRoll && window.pianoRoll.getActiveTrackId() === id) {
                    window.pianoRoll.switchToTrack(null);
                }
                engine.removeTrack(id);
                this.render();
                if (this.onTracksChanged) this.onTracksChanged();
            });
        });
    }

    _bindGlobalEvents() {
        document.addEventListener('mousemove', (e) => {
            if (!this.draggingClip) return;
            const el = this.draggingClip.element;
            const parent = el.parentElement;
            const rect = parent.getBoundingClientRect();
            let x = e.clientX - rect.left - this.dragOffsetX;
            x = Math.max(0, x);

            const beatSec = 60 / engine.bpm;
            const beatPx = beatSec * this.pixelsPerSecond;
            x = Math.round(x / beatPx) * beatPx;

            el.style.left = x + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!this.draggingClip) return;
            const el = this.draggingClip.element;
            const newOffset = parseFloat(el.style.left) / this.pixelsPerSecond;
            engine.moveClip(this.draggingClip.trackId, this.draggingClip.clipIndex, newOffset);
            this.draggingClip = null;
            this.render();
        });
    }

    zoom(factor) {
        this.pixelsPerSecond = Math.max(20, Math.min(300, this.pixelsPerSecond * factor));
        this.render();
    }
}

// Vue側で初期化するため、自動インスタンス化しない
