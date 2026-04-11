/**
 * bunri DAW — 中央エリア（タイムライン + ピアノロール + オートメーション）
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useDaw } from '../lib/store.jsx';
import engine from '../lib/engine.js';

// ---- PianoRoll クラス（Canvasベース）----
class PianoRollEngine {
    constructor() {
        this.canvas = null; this.noteLayer = null; this.keysDiv = null; this.wrap = null; this.ctx = null;
        this.noteHeight = 14; this.stepWidth = 20; this.totalSteps = 128;
        this.octaveRange = [2, 7];
        this.noteNames = ['B','A#','A','G#','G','F#','F','E','D#','D','C#','C'];
        this.blackKeys = new Set(['A#','G#','F#','D#','C#']);
        this.activeTrackId = null; this.notes = []; this.selectedNote = null;
        this.isDragging = false; this.isResizing = false;
        this.dragStartX = 0; this.dragStartStep = 0;
        this.snapToGrid = true; this.gridSize = 4;
        this.totalRows = (this.octaveRange[1] - this.octaveRange[0]) * 12;
        this.onTrackSwitch = null;
    }
    init(el) {
        this.canvas = el.canvas; this.noteLayer = el.noteLayer;
        this.keysDiv = el.keysDiv; this.wrap = el.wrap;
        this.ctx = this.canvas.getContext('2d');
        this._buildKeys(); this._resize(); this._drawGrid(); this._bindEvents();
    }
    switchToTrack(trackId) {
        this._saveToEngine();
        this.activeTrackId = trackId !== null ? Number(trackId) : null;
        this.selectedNote = null;
        this._loadFromEngine(); this._renderNotes();
        if (this.onTrackSwitch) this.onTrackSwitch(this.activeTrackId);
    }
    _saveToEngine() {
        if (this.activeTrackId === null) return;
        const track = engine.getTrack(this.activeTrackId);
        if (!track) return;
        track.pianoNotes = this.notes.map(n => ({ note: n.note, octave: n.octave, step: n.step, length: n.length }));
    }
    _loadFromEngine() {
        if (this.activeTrackId === null) { this.notes = []; return; }
        const track = engine.getTrack(this.activeTrackId);
        if (!track) { this.notes = []; return; }
        this.notes = (track.pianoNotes || []).map(n => ({ ...n }));
    }
    _buildKeys() {
        this.keysDiv.innerHTML = '';
        for (let oct = this.octaveRange[1] - 1; oct >= this.octaveRange[0]; oct--) {
            for (const name of this.noteNames) {
                const div = document.createElement('div');
                div.className = 'piano-key' + (this.blackKeys.has(name) ? ' black' : '');
                div.textContent = `${name}${oct}`;
                div.style.height = this.noteHeight + 'px';
                this.keysDiv.appendChild(div);
            }
        }
    }
    _resize() {
        const w = this.totalSteps * this.stepWidth, h = this.totalRows * this.noteHeight;
        this.canvas.width = w; this.canvas.height = h;
        this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
        this.noteLayer.style.width = w + 'px'; this.noteLayer.style.height = h + 'px';
    }
    _drawGrid() {
        const { ctx, canvas } = this; const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        for (let row = 0; row < this.totalRows; row++) {
            const y = row * this.noteHeight, noteIdx = row % 12;
            if (this.blackKeys.has(this.noteNames[noteIdx])) { ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(0, y, w, this.noteHeight); }
            ctx.strokeStyle = noteIdx === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        for (let step = 0; step <= this.totalSteps; step++) {
            const x = step * this.stepWidth, isBeat = step % 4 === 0, isBar = step % 16 === 0;
            ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.25)' : isBeat ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)';
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
    }
    _bindEvents() {
        this.canvas.addEventListener('dblclick', (e) => {
            if (this.activeTrackId === null) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left + this.wrap.scrollLeft, y = e.clientY - rect.top + this.wrap.scrollTop;
            let step = Math.floor(x / this.stepWidth);
            if (this.snapToGrid) step = Math.floor(step / this.gridSize) * this.gridSize;
            const row = Math.floor(y / this.noteHeight);
            const { note, octave } = this._rowToNote(row);
            this._addNote(note, octave, step, this.gridSize);
        });
        this.noteLayer.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('note-block')) {
                e.preventDefault();
                const idx = parseInt(e.target.dataset.index);
                this._selectNote(idx);
                const rect = e.target.getBoundingClientRect();
                if (e.clientX > rect.right - 10) this.isResizing = true;
                else this.isDragging = true;
                this.dragStartX = e.clientX;
                this.dragStartStep = this.notes[idx].step;
                this._dragLength = this.notes[idx].length;
            }
        });
        document.addEventListener('mousemove', (e) => {
            if (!this.isDragging && !this.isResizing) return;
            if (this.selectedNote === null) return;
            const dx = e.clientX - this.dragStartX, dSteps = Math.round(dx / this.stepWidth);
            const note = this.notes[this.selectedNote];
            if (this.isDragging) { let ns = this.dragStartStep + dSteps; if (this.snapToGrid) ns = Math.round(ns / this.gridSize) * this.gridSize; note.step = Math.max(0, ns); }
            else if (this.isResizing) { let nl = this._dragLength + dSteps; if (this.snapToGrid) nl = Math.max(this.gridSize, Math.round(nl / this.gridSize) * this.gridSize); else nl = Math.max(1, nl); note.length = nl; }
            this._renderNotes();
        });
        document.addEventListener('mouseup', () => { if (this.isDragging || this.isResizing) this._saveToEngine(); this.isDragging = false; this.isResizing = false; });
        document.addEventListener('keydown', (e) => { if (e.key === 'Delete' && this.selectedNote !== null) this._removeNote(this.selectedNote); });
    }
    _rowToNote(row) { return { note: this.noteNames[row % 12], octave: this.octaveRange[1] - 1 - Math.floor(row / 12) }; }
    _noteToRow(name, oct) { return (this.octaveRange[1] - 1 - oct) * 12 + this.noteNames.indexOf(name); }
    _addNote(note, octave, step, length) { this.notes.push({ note, octave, step, length }); this._saveToEngine(); this._renderNotes(); }
    _removeNote(idx) { this.notes.splice(idx, 1); this.selectedNote = null; this._saveToEngine(); this._renderNotes(); }
    _selectNote(idx) { this.selectedNote = idx; this._renderNotes(); }
    _renderNotes() {
        if (!this.noteLayer) return; this.noteLayer.innerHTML = '';
        if (this.activeTrackId === null) {
            const msg = document.createElement('div');
            msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text-dim);font-size:13px;pointer-events:none;';
            msg.textContent = 'トラックをクリックしてピアノロールを開く';
            this.noteLayer.appendChild(msg); return;
        }
        this.notes.forEach((n, i) => {
            const row = this._noteToRow(n.note, n.octave), el = document.createElement('div');
            el.className = 'note-block' + (i === this.selectedNote ? ' selected' : '');
            el.style.left = (n.step * this.stepWidth) + 'px'; el.style.top = (row * this.noteHeight) + 'px';
            el.style.width = (n.length * this.stepWidth - 1) + 'px'; el.style.height = (this.noteHeight - 1) + 'px';
            el.dataset.index = i; el.title = `${n.note}${n.octave} step:${n.step} len:${n.length}`;
            this.noteLayer.appendChild(el);
        });
    }
    getNotes() { this._saveToEngine(); return this.notes.map(n => ({ note: n.note, octave: n.octave, step: n.step, length: n.length })); }
    setNotes(notes) { this.notes = notes.map(n => ({ ...n })); this.selectedNote = null; this._saveToEngine(); this._renderNotes(); }
    getActiveTrackId() { return this.activeTrackId; }
    clear() { this.notes = []; this.selectedNote = null; this._saveToEngine(); this._renderNotes(); }
}

// ---- Timeline クラス（Canvasベース）----
class TimelineEngine {
    constructor() {
        this.container = null; this.headerCanvas = null; this.headerCtx = null;
        this.pixelsPerSecond = 80; this.draggingClip = null; this.dragOffsetX = 0;
        this.onStatus = null; this.onTrackSelect = null; this.onTracksChanged = null;
    }
    init(el) {
        this.container = el.container; this.headerCanvas = el.headerCanvas;
        this.headerCtx = this.headerCanvas.getContext('2d');
        this._drawHeader(); this._bindGlobalEvents();
    }
    _drawHeader() {
        if (!this.headerCanvas) return;
        const totalSec = Math.max(30, engine.getTotalDuration() + 10);
        const w = totalSec * this.pixelsPerSecond;
        this.headerCanvas.width = w; this.headerCanvas.height = 24; this.headerCanvas.style.width = w + 'px';
        const ctx = this.headerCtx; ctx.fillStyle = '#17171e'; ctx.fillRect(0, 0, w, 24);
        const beatSec = 60 / engine.bpm, barSec = beatSec * engine.beatsPerBar;
        for (let t = 0; t < totalSec; t += beatSec) {
            const x = t * this.pixelsPerSecond, barNum = Math.floor(t / barSec) + 1, beatInBar = Math.round((t % barSec) / beatSec);
            if (beatInBar === 0) { ctx.fillStyle = '#e0e0e0'; ctx.font = '10px sans-serif'; ctx.fillText(barNum.toString(), x + 3, 14); ctx.strokeStyle = 'rgba(255,255,255,0.3)'; }
            else ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, 24); ctx.stroke();
        }
    }
    render(pianoRoll) {
        if (!this.container) return;
        this.container.innerHTML = ''; this._drawHeader();
        for (const track of engine.tracks) {
            const row = document.createElement('div'); row.className = 'track-row';
            const isActive = pianoRoll && pianoRoll.getActiveTrackId() === track.id;
            const noteCount = (track.pianoNotes || []).length;
            const notesBadge = noteCount > 0 ? `<span class="notes-badge" title="${noteCount}ノート">${noteCount}</span>` : '';
            const header = document.createElement('div');
            header.className = 'track-header' + (isActive ? ' active-track' : '');
            header.dataset.trackId = track.id;
            const isTrackPlaying = engine.isPlaying && engine.soloTrackId === track.id;
            header.innerHTML = `<span class="track-name">${track.name} ${notesBadge}</span>
                <div class="track-controls">
                    <button class="btn-track-play ${isTrackPlaying ? 'playing' : ''}" data-track="${track.id}" title="このトラックだけ再生">${isTrackPlaying ? '⏸' : '▶'}</button>
                    <button class="btn-mute ${track.mute ? 'muted' : ''}" data-track="${track.id}">M</button>
                    <button class="btn-solo ${track.solo ? 'soloed' : ''}" data-track="${track.id}">S</button>
                    <button class="btn-delete-track" data-track="${track.id}">✕</button>
                </div>`;
            row.appendChild(header);
            const canvasWrap = document.createElement('div'); canvasWrap.className = 'track-canvas-wrap'; canvasWrap.dataset.trackId = track.id;
            const totalSec = Math.max(30, engine.getTotalDuration() + 10);
            canvasWrap.style.width = (totalSec * this.pixelsPerSecond) + 'px';
            track.clips.forEach((clip, ci) => {
                const clipEl = document.createElement('div'); clipEl.className = 'clip';
                clipEl.style.left = (clip.offset * this.pixelsPerSecond) + 'px';
                clipEl.style.width = (clip.duration * this.pixelsPerSecond) + 'px';
                clipEl.textContent = clip.name; clipEl.dataset.trackId = track.id; clipEl.dataset.clipIndex = ci;
                clipEl.title = `${clip.name}\n開始: ${clip.offset.toFixed(1)}s\n長さ: ${clip.duration.toFixed(1)}s`;
                clipEl.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this.draggingClip = { trackId: track.id, clipIndex: ci, element: clipEl };
                    this.dragOffsetX = e.clientX - clipEl.getBoundingClientRect().left;
                });
                clipEl.addEventListener('contextmenu', (e) => { e.preventDefault(); engine.removeClip(track.id, ci); this.render(pianoRoll); });
                canvasWrap.appendChild(clipEl);
            });
            canvasWrap.addEventListener('dragover', (e) => e.preventDefault());
            canvasWrap.addEventListener('drop', async (e) => {
                e.preventDefault();
                for (const file of e.dataTransfer.files) {
                    if (!file.name.endsWith('.wav')) continue;
                    const rect = canvasWrap.getBoundingClientRect();
                    await engine.addClipFromFile(track.id, file, (e.clientX - rect.left) / this.pixelsPerSecond);
                }
                this.render(pianoRoll);
                if (this.onStatus) this.onStatus('クリップを追加しました');
                if (this.onTracksChanged) this.onTracksChanged();
            });
            row.appendChild(canvasWrap); this.container.appendChild(row);
        }
        this._bindTrackEvents(pianoRoll);
    }
    _bindTrackEvents(pianoRoll) {
        this.container.querySelectorAll('.track-header').forEach(h => {
            h.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') return;
                const id = parseInt(h.dataset.trackId);
                if (pianoRoll) { pianoRoll.switchToTrack(id); this.render(pianoRoll); }
                const track = engine.getTrack(id);
                if (this.onStatus) this.onStatus(`ピアノロール: ${track ? track.name : ''}`);
            });
        });
        this.container.querySelectorAll('.btn-track-play').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track), track = engine.getTrack(id);
                if (!track) return;
                if (engine.isPlaying && engine.soloTrackId === id) { engine.pause(); if (this.onStatus) this.onStatus('一時停止'); }
                else { engine.playSingleTrack(id); if (this.onStatus) this.onStatus(`再生中: ${track.name}`); }
                this.render(pianoRoll);
            });
        });
        this.container.querySelectorAll('.btn-mute').forEach(btn => {
            btn.addEventListener('click', () => { engine.toggleMute(parseInt(btn.dataset.track)); this.render(pianoRoll); });
        });
        this.container.querySelectorAll('.btn-solo').forEach(btn => {
            btn.addEventListener('click', () => { const t = engine.getTrack(parseInt(btn.dataset.track)); if (t) t.solo = !t.solo; this.render(pianoRoll); });
        });
        this.container.querySelectorAll('.btn-delete-track').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track);
                if (pianoRoll && pianoRoll.getActiveTrackId() === id) pianoRoll.switchToTrack(null);
                engine.removeTrack(id); this.render(pianoRoll);
                if (this.onTracksChanged) this.onTracksChanged();
            });
        });
    }
    _bindGlobalEvents() {
        document.addEventListener('mousemove', (e) => {
            if (!this.draggingClip) return;
            const el = this.draggingClip.element, parent = el.parentElement;
            let x = e.clientX - parent.getBoundingClientRect().left - this.dragOffsetX;
            x = Math.max(0, x);
            const beatPx = (60 / engine.bpm) * this.pixelsPerSecond;
            el.style.left = Math.round(x / beatPx) * beatPx + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!this.draggingClip) return;
            engine.moveClip(this.draggingClip.trackId, this.draggingClip.clipIndex, parseFloat(this.draggingClip.element.style.left) / this.pixelsPerSecond);
            const pr = this._pianoRoll;
            this.draggingClip = null; this.render(pr);
        });
    }
}

// ---- AutomationEditor クラス ----
class AutomationEditorEngine {
    constructor() {
        this.canvas = null; this.ctx = null; this.data = {};
        this.activeTrackId = null; this.activeParam = 'volume';
        this.draggingPoint = null; this.pixelsPerSecond = 80;
    }
    init(el) {
        this.canvas = el.canvas; this.ctx = this.canvas.getContext('2d');
        this._resize(); this._bindEvents();
    }
    _resize() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width; this.canvas.height = rect.height;
    }
    setTrack(trackId, param) { this.activeTrackId = trackId; this.activeParam = param || 'volume'; this.draw(); }
    _getPoints() { if (!this.activeTrackId) return []; const k = `${this.activeTrackId}_${this.activeParam}`; if (!this.data[k]) this.data[k] = []; return this.data[k]; }
    _setPoints(pts) { if (!this.activeTrackId) return; this.data[`${this.activeTrackId}_${this.activeParam}`] = pts; }
    draw() {
        if (!this.canvas) return; this._resize();
        const { ctx, canvas } = this, w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        for (let y = 0; y <= h; y += h / 4) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        if (engine.bpm) { const bp = (60 / engine.bpm) * this.pixelsPerSecond; ctx.strokeStyle = 'rgba(255,255,255,0.08)'; for (let x = 0; x < w; x += bp) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); } }
        const points = this._getPoints();
        if (points.length === 0) { ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.font = '12px sans-serif'; ctx.fillText(this.activeTrackId ? 'ダブルクリックでポイントを追加' : 'トラックを選択してください', 12, h / 2); return; }
        ctx.strokeStyle = '#4ecdc4'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, h - points[0].value * h);
        for (let i = 0; i < points.length; i++) {
            const px = points[i].time * this.pixelsPerSecond, py = h - points[i].value * h;
            if (i === 0) ctx.lineTo(px, py);
            else { const prev = points[i - 1]; ctx.bezierCurveTo((prev.time * this.pixelsPerSecond + px) / 2, h - prev.value * h, (prev.time * this.pixelsPerSecond + px) / 2, py, px, py); }
        }
        ctx.lineTo(w, h - points[points.length - 1].value * h); ctx.stroke();
        for (const p of points) {
            const px = p.time * this.pixelsPerSecond, py = h - p.value * h;
            ctx.fillStyle = '#4ecdc4'; ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '10px sans-serif';
        const track = engine.getTrack(this.activeTrackId); ctx.fillText(track ? `${track.name} — ${this.activeParam}` : '', 8, 14);
    }
    _bindEvents() {
        this.canvas.addEventListener('dblclick', (e) => {
            if (!this.activeTrackId) return; const rect = this.canvas.getBoundingClientRect();
            const pts = this._getPoints(); pts.push({ time: Math.max(0, (e.clientX - rect.left) / this.pixelsPerSecond), value: Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)) });
            pts.sort((a, b) => a.time - b.time); this._setPoints(pts); this.draw();
        });
        this.canvas.addEventListener('mousedown', (e) => {
            if (!this.activeTrackId) return; const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top, pts = this._getPoints();
            for (let i = 0; i < pts.length; i++) { if (Math.abs(mx - pts[i].time * this.pixelsPerSecond) < 8 && Math.abs(my - (rect.height - pts[i].value * rect.height)) < 8) { this.draggingPoint = i; break; } }
        });
        this.canvas.addEventListener('mousemove', (e) => {
            if (this.draggingPoint === null) return; const rect = this.canvas.getBoundingClientRect(); const pts = this._getPoints();
            pts[this.draggingPoint].time = Math.max(0, (e.clientX - rect.left) / this.pixelsPerSecond);
            pts[this.draggingPoint].value = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)); this.draw();
        });
        this.canvas.addEventListener('mouseup', () => { if (this.draggingPoint !== null) { this._getPoints().sort((a, b) => a.time - b.time); this.draggingPoint = null; this.draw(); } });
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault(); if (!this.activeTrackId) return; const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top, pts = this._getPoints();
            for (let i = 0; i < pts.length; i++) { if (Math.abs(mx - pts[i].time * this.pixelsPerSecond) < 8 && Math.abs(my - (rect.height - pts[i].value * rect.height)) < 8) { pts.splice(i, 1); this._setPoints(pts); this.draw(); break; } }
        });
        window.addEventListener('resize', () => this.draw());
    }
    toJSON() { return JSON.parse(JSON.stringify(this.data)); }
    fromJSON(data) { this.data = data || {}; this.draw(); }
}

// ---- SeekBar コンポーネント ----
function SeekBar() {
    const [seekVal, setSeekVal] = useState(0);
    const [curTime, setCurTime] = useState('0:00.0');
    const [totalTime, setTotalTime] = useState('0:00.0');
    const isSeeking = useRef(false);

    const fmt = (t) => { const m = Math.floor(t / 60), s = (t % 60).toFixed(1); return `${m}:${s.padStart(4, '0')}`; };

    useEffect(() => {
        const iv = setInterval(() => {
            const t = engine.getCurrentTime(), dur = engine.getTotalDuration();
            if (!isSeeking.current) { setSeekVal(dur > 0 ? (t / dur) * 100 : 0); setCurTime(fmt(t)); }
            setTotalTime(fmt(dur));
        }, 100);
        return () => clearInterval(iv);
    }, []);

    const handleInput = (e) => { isSeeking.current = true; setSeekVal(+e.target.value); const dur = engine.getTotalDuration(); if (dur > 0) setCurTime(fmt((+e.target.value / 100) * dur)); };
    const finishSeek = () => {
        if (!isSeeking.current) return; isSeeking.current = false;
        const dur = engine.getTotalDuration(); if (dur <= 0) return;
        const seekTo = (seekVal / 100) * dur, wasPlaying = engine.isPlaying, wasSolo = engine.soloTrackId;
        if (wasPlaying) engine.stop();
        engine.playOffset = seekTo;
        if (wasPlaying) { if (wasSolo != null) engine.playSingleTrack(wasSolo); else engine.play(); }
    };

    return (
        <div id="seek-bar-area">
            <span id="seek-time-current">{curTime}</span>
            <input type="range" id="seek-bar" min="0" max="100" step="0.1" value={seekVal}
                onMouseDown={() => { isSeeking.current = true; }} onTouchStart={() => { isSeeking.current = true; }}
                onInput={handleInput} onMouseUp={finishSeek} onTouchEnd={finishSeek} />
            <span id="seek-time-total">{totalTime}</span>
        </div>
    );
}

// ---- メイン CenterArea コンポーネント ----
export default function CenterArea() {
    const { setStatus, bumpTracks, pianoRollRef, timelineRef, automationRef, trackVersion } = useDaw();
    const [activeTrackName, setActiveTrackName] = useState(null);

    const tracksContainerRef = useRef(null);
    const headerCanvasRef = useRef(null);
    const pianoCanvasRef = useRef(null);
    const noteLayerRef = useRef(null);
    const keysRef = useRef(null);
    const pianoWrapRef = useRef(null);
    const autoCanvasRef = useRef(null);

    useEffect(() => {
        // PianoRoll 初期化
        const pr = new PianoRollEngine();
        pr.init({ canvas: pianoCanvasRef.current, noteLayer: noteLayerRef.current, keysDiv: keysRef.current, wrap: pianoWrapRef.current });
        pr.onTrackSwitch = (trackId) => {
            const track = trackId ? engine.getTrack(trackId) : null;
            setActiveTrackName(track ? track.name : null);
        };
        pianoRollRef.current = pr;

        // Timeline 初期化
        const tl = new TimelineEngine();
        tl.init({ container: tracksContainerRef.current, headerCanvas: headerCanvasRef.current });
        tl.onStatus = setStatus;
        tl.onTracksChanged = bumpTracks;
        tl._pianoRoll = pr;
        timelineRef.current = tl;

        // Automation 初期化
        const auto = new AutomationEditorEngine();
        auto.init({ canvas: autoCanvasRef.current });
        automationRef.current = auto;

        // 初期トラック
        engine.addTrack('Track 1');
        engine.addTrack('Track 2');
        tl.render(pr);
        auto.draw();
        bumpTracks();

        setStatus('準備完了 — トラック名をクリックしてピアノロールを開く / WAVをD&Dで追加');
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // trackVersion が変わるたびにタイムラインを再描画
    useEffect(() => {
        const tl = timelineRef.current;
        const pr = pianoRollRef.current;
        if (tl) tl.render(pr);
    }, [trackVersion, timelineRef, pianoRollRef]);

    const handleAddTrack = useCallback(() => {
        const t = engine.addTrack();
        bumpTracks();
        setStatus(`「${t.name}」を追加しました`);
    }, [bumpTracks, setStatus]);

    const pianoLabel = activeTrackName
        ? <>ピアノロール — <strong style={{ color: 'var(--accent)' }}>{activeTrackName}</strong> <span className="area-hint">（ダブルクリックでノート追加 / ドラッグで移動 / Deleteで削除）</span></>
        : <>ピアノロール <span className="area-hint">（トラックをクリックして選択）</span></>;

    return (
        <div id="center">
            {/* タイムライン */}
            <div id="timeline-area">
                <div className="area-label">タイムライン <span className="area-hint">（WAVをD&D / クリップをドラッグで移動 / 右クリックで削除）</span></div>
                <canvas ref={headerCanvasRef} id="timeline-header-canvas" />
                <div ref={tracksContainerRef} id="tracks-container" />
                <button id="btn-add-track" onClick={handleAddTrack}>+ トラック追加</button>
                <SeekBar />
            </div>

            {/* ピアノロール */}
            <div className="resize-handle" id="resize-piano" />
            <div id="piano-roll-area">
                <div className="area-label">{pianoLabel}</div>
                <div ref={keysRef} id="piano-keys" />
                <div ref={pianoWrapRef} id="piano-grid-wrap">
                    <canvas ref={pianoCanvasRef} id="piano-grid-canvas" />
                    <div ref={noteLayerRef} id="note-layer" />
                </div>
            </div>

            {/* オートメーション */}
            <div className="resize-handle" id="resize-auto" />
            <div id="automation-area">
                <div className="area-label">オートメーション <span className="area-hint">（ダブルクリックでポイント追加 / ドラッグで移動 / 右クリックで削除）</span></div>
                <canvas ref={autoCanvasRef} id="automation-canvas" />
            </div>
        </div>
    );
}
