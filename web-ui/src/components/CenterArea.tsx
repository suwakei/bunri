/**
 * bunri DAW — 中央エリア（タイムライン + ピアノロール）
 * TODO: Canvas系クラスの完全な型定義を追加する
 */
// @ts-nocheck
import { useEffect, useRef, useState, useCallback } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { cssVar } from '../lib/theme';
import { isDialogOpen, isTextEntry, isTypingTarget } from '../lib/keys';
import MidiInputBar from './MidiInputBar';
import GhostBar from './GhostBar';
import { secToStep, stepSeconds } from '../lib/grid';
import { isAudioFileName, useLearnActions } from '../lib/learn';

/** 音名を低い順に並べたもの (MIDI ノート番号を出すのに使う)。 */
const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** ノートを置いたり動かしたりしたときに、その高さの音を鳴らす長さ (ミリ秒)。 */
const AUDITION_MS = 220;

/** ピアノロールの高さの下限と、タイムラインに残す高さの下限 (px)。CSS の min-height と合わせる。 */
const PIANO_MIN_HEIGHT = 150;
const TIMELINE_MIN_HEIGHT = 200;
/** 境目をキーボードで動かすときの 1 回ぶん (px)。 */
const RESIZE_KEY_STEP = 24;

/**
 * Canvas ベースのピアノロールエディタエンジン。
 *
 * グリッド描画・ノートの追加/移動（横で位置、縦で高さ）/リサイズ/削除・アクティブトラックとの
 * 双方向同期（`_saveToEngine` / `_loadFromEngine`）を担う。
 * ノートを置いたとき・高さを変えたとき・鍵盤を押したときは、その高さの音を短く鳴らす。
 * React コンポーネントから `pianoRollRef.current` 経由で操作する。
 *
 * 主なパブリック API:
 * - `init(el)` — DOM 要素群を渡して初期化する
 * - `switchToTrack(trackId)` — 表示するトラックを切り替える
 * - `getNotes()` — 現在のノート配列を返す（エンジンへも保存）
 * - `setNotes(notes)` — ノートを一括セットして再描画する
 * - `getActiveTrackId()` — アクティブなトラック ID を返す
 * - `clear()` — 全ノートを削除する
 */
// ---- PianoRoll クラス（Canvasベース）----
class PianoRollEngine {
    constructor() {
        this.canvas = null; this.noteLayer = null; this.keysDiv = null; this.wrap = null; this.ctx = null;
        this.noteHeight = 14; this.stepWidth = 20;
        // 長さ (ステップ)。中身に合わせて伸び縮みする (_fitLength)。最短は 8 小節ぶん
        this.minSteps = 128; this.totalSteps = this.minSteps;
        // 伸ばせる上限 (999 小節ぶん)。グリッドは見えている範囲だけ描くので、長くしても描画は重くならない
        this.maxSteps = 16 * 999;
        // 最後のノートの後ろに空けておく余白 (小節)。続きを打ち込めるように
        this.tailBars = 4;
        // 表示する音域: C0〜B8 の 9 オクターブ ([下端のオクターブ, 上端のオクターブ + 1])。
        // 再生エンジンが鳴らせる範囲 (engine.ts の NOTE_FREQ) と同じで、88 鍵のピアノ (A0〜C8) と、
        // ベースの低い音 (4 弦の E1、5 弦の B0) を覆う。以前は C2〜B6 で、採譜したベースの音が外に出た
        this.octaveRange = [0, 9];
        this.noteNames = ['B','A#','A','G#','G','F#','F','E','D#','D','C#','C'];
        this.blackKeys = new Set(['A#','G#','F#','D#','C#']);
        this.activeTrackId = null; this.notes = []; this.selectedNote = null;
        // お手本として薄く重ねて見せるノート (編集はできない)。setGhostNotes で入れる
        this.ghostNotes = [];
        this.isDragging = false; this.isResizing = false;
        this.dragStartX = 0; this.dragStartStep = 0;
        // 縦のドラッグ (高さの変更) の起点
        this.dragStartY = 0; this.dragStartRow = 0;
        // 試し聴きの音を止めるタイマー (キーは MIDI ノート番号) と、押している鍵盤
        this._auditionTimers = new Map(); this._heldKey = null;
        this.snapToGrid = true; this.gridSize = 4;
        this.totalRows = (this.octaveRange[1] - this.octaveRange[0]) * 12;
        this.onTrackSwitch = null;
        // ノートの数が変わったとき (CenterArea が渡す)
        this.onNotesChanged = null;
        // 縦の位置を自動で据えた行 (_centerOnRow)。利用者がスクロールしたら null に戻す
        this._anchorRow = null; this._anchorTop = 0;
        // 再生位置の線 (setPlayhead で動かす)
        this.playhead = null;
    }
    /**
     * ピアノロールを DOM 要素群に紐付けて初期化する。
     * 鍵盤の構築・Canvas リサイズ・グリッド描画・イベント登録を行う。
     *
     * @param el - 初期化に必要な DOM 要素群
     * @param el.canvas - グリッド描画用 `<canvas>` 要素
     * @param el.noteLayer - ノートブロックを配置するオーバーレイ `<div>` 要素
     * @param el.keysDiv - 鍵盤キーを並べる `<div>` 要素
     * @param el.wrap - スクロール可能なラッパー `<div>` 要素
     */
    init(el) {
        this.canvas = el.canvas; this.noteLayer = el.noteLayer;
        this.keysDiv = el.keysDiv; this.wrap = el.wrap;
        this.ctx = this.canvas.getContext('2d');
        // 再生位置の線。ノートの層は描き直すたびに中身を作り直すので、その外 (スクロールする枠の中) に置く
        this.playhead = document.createElement('div');
        this.playhead.className = 'playhead'; this.playhead.id = 'piano-playhead';
        this.playhead.setAttribute('aria-hidden', 'true');
        this.wrap.appendChild(this.playhead);
        this._buildKeys(); this._resize(); this._drawGrid(); this._bindEvents();
        // グリッドは見えている範囲だけを描くので、スクロールや大きさの変化のたびに描き直す。
        // 鍵盤の列は別の要素なので、縦のスクロール位置を合わせる
        this.wrap.addEventListener('scroll', () => {
            // 自分で据えた位置から動いていたら、利用者 (か別の処理) が動かしたということ。据え直しをやめる
            if (this._anchorRow != null && Math.abs(this.wrap.scrollTop - this._anchorTop) > 1) this._anchorRow = null;
            this.keysDiv.scrollTop = this.wrap.scrollTop;
            this._drawGrid();
        });
        if (typeof ResizeObserver !== 'undefined') {
            // 大きさの変更は次の描画のタイミングに回す (その場で canvas の大きさを変えると、
            // それがまた大きさの変化として通知されて、通知が循環する)
            this._resizeObserver = new ResizeObserver(() => {
                cancelAnimationFrame(this._resizeFrame);
                this._resizeFrame = requestAnimationFrame(() => {
                    this._resize(); this._drawGrid();
                    if (this._anchorRow != null) this._centerOnRow(this._anchorRow);
                });
            });
            this._resizeObserver.observe(this.wrap);
        }
        // 最初は真ん中のド (C4) のあたりを見せる。一番上 (B8) から始めると、よく使う高さが見えない
        this._centerOnRow(this._noteToRow('F#', 4));
    }
    /**
     * 指定した行が、見えている範囲の縦の真ん中に来るようスクロールする。
     * 鍵盤の列も同じ位置に合わせる。
     *
     * @param row - 見せたい行 (0 が一番上)
     */
    _centerOnRow(row) {
        if (!this.wrap) return;
        const visible = this.wrap.clientHeight;
        const max = Math.max(0, this.totalRows * this.noteHeight - visible);
        this.wrap.scrollTop = Math.round(Math.max(0, Math.min(max, (row + 0.5) * this.noteHeight - visible / 2)));
        // どの行を真ん中に据えたかを覚えておく。利用者が自分でスクロールするまでは、ピアノロールの
        // 大きさが変わったとき (ResizeObserver) に同じ行へ据え直す。初期化の時点では、スタイルの
        // 適用が済んでおらず見える高さが定まっていないことがある (WebKit) ので、これが無いと
        // 最初の位置がずれる
        this._anchorRow = row;
        this._anchorTop = this.wrap.scrollTop;
        this.keysDiv.scrollTop = this.wrap.scrollTop;
        this._drawGrid();
    }
    /**
     * ノート (打ち込んだものと、お手本) が 1 つも見えていなければ、ノートの在る高さへ縦にスクロールする。
     * 1 つでも見えていれば動かさない (見ている場所を勝手に変えない)。
     * 音域が広いので、ベースのトラックを開いたときに、何も無いように見えるのを防ぐ。
     */
    _revealNotes() {
        if (!this.wrap) return;
        const rowsOf = (list) => list.map(n => this._noteToRow(n.note, n.octave)).filter(r => r >= 0 && r < this.totalRows);
        const own = rowsOf(this.notes), ghost = rowsOf(this.ghostNotes);
        if (own.length + ghost.length === 0) return;
        const first = this.wrap.scrollTop / this.noteHeight;
        const last = (this.wrap.scrollTop + this.wrap.clientHeight) / this.noteHeight;
        if (own.concat(ghost).some(r => r + 1 > first && r < last)) return;
        // 打ち込んだノートを優先し、その真ん中の高さ (中央値) へ寄せる
        const target = (own.length ? own : ghost).slice().sort((a, b) => a - b);
        this._centerOnRow(target[Math.floor(target.length / 2)]);
    }
    /**
     * その高さの行が見えるよう、縦にスクロールする。見えていれば動かさない (`center` なら真ん中に据える)。
     * 差分チェックの指摘や「このパートを練習する」から、その高さを見せるのに使う。
     *
     * @param name - 音名
     * @param octave - オクターブ
     * @param center - true なら、見えていても真ん中に据える
     */
    scrollToPitch(name, octave, center = false) {
        if (!this.wrap) return;
        const row = this._noteToRow(name, octave);
        if (row < 0 || row >= this.totalRows) return;
        const top = this.wrap.scrollTop, bottom = top + this.wrap.clientHeight;
        if (!center && row * this.noteHeight >= top && (row + 1) * this.noteHeight <= bottom) return;
        this._centerOnRow(row);
    }
    /**
     * 再生位置の線を動かす。1 小節目より前 (弱起) は出さない。
     * 再生中は毎フレーム呼ばれるので、位置は transform で動かす (配置の計算をやり直さない)。
     *
     * @param sec - 再生位置 (秒)
     */
    setPlayhead(sec) {
        if (!this.playhead) return;
        const step = secToStep(sec, engine.grid);
        const visible = this.activeTrackId !== null && step >= 0 && step <= this.totalSteps;
        this.playhead.style.display = visible ? 'block' : 'none';
        if (!visible) return;
        this.playhead.style.height = (this.totalRows * this.noteHeight) + 'px';
        this.playhead.style.transform = `translateX(${Math.round(step * this.stepWidth)}px)`;
        this.playheadStep = step;
    }
    /** 再生位置が見えている範囲の外に出たら、見えるところまで横にスクロールする (再生中の自動スクロール)。 */
    followPlayhead(sec) {
        if (!this.wrap || this.activeTrackId === null) return;
        const x = secToStep(sec, engine.grid) * this.stepWidth;
        if (x < 0) return;
        const left = this.wrap.scrollLeft, width = this.wrap.clientWidth;
        if (x < left || x > left + width - 24) this.wrap.scrollLeft = Math.max(0, x - width / 4);
    }
    /** 1 小節のステップ数 (拍子に従う。4/4 なら 16)。 */
    _stepsPerBar() { return Math.max(1, engine.beatsPerBar || 4) * 4; }
    /**
     * 長さを中身に合わせる。最後のノートの後ろに余白の小節を足し、小節の区切りに切り上げる。
     * 取り込んだ音声クリップが在れば、その長さも覆う。最短は 8 小節ぶん。
     * @returns 長さが変わったら true
     */
    _fitLength() {
        const bar = this._stepsPerBar();
        let last = 0;
        for (const n of this.notes) last = Math.max(last, n.step + n.length);
        for (const n of this.ghostNotes) last = Math.max(last, n.step + n.length);
        const track = this.activeTrackId !== null ? engine.getTrack(this.activeTrackId) : null;
        if (track) {
            // クリップは秒で置いてある。ステップ 0 は 1 小節目の位置 (engine.gridOffset)
            const stepSec = stepSeconds(engine);
            for (const clip of track.clips || []) last = Math.max(last, Math.ceil((clip.offset + clip.duration - engine.gridOffset) / stepSec));
        }
        const wanted = Math.min(this.maxSteps, Math.max(this.minSteps, (Math.ceil(last / bar) + this.tailBars) * bar));
        if (wanted === this.totalSteps) return false;
        this.totalSteps = wanted;
        this._resize();
        this._drawGrid();
        return true;
    }
    /**
     * アクティブトラックを切り替えてピアノロールを再描画する。
     * 切り替え前に現在のノートをエンジンへ保存し、新トラックのノートを読み込む。
     * `onTrackSwitch` コールバックが設定されていれば呼び出す。
     *
     * @param trackId - 切り替え先のトラック ID（`null` を渡すと選択解除）
     */
    switchToTrack(trackId) {
        this._saveToEngine();
        this.activeTrackId = trackId !== null ? Number(trackId) : null;
        this.selectedNote = null;
        this._loadFromEngine(); this._fitLength(); this._renderNotes(); this._revealNotes();
        if (this.onTrackSwitch) this.onTrackSwitch(this.activeTrackId);
    }
    _saveToEngine() {
        if (this.activeTrackId === null) return;
        const track = engine.getTrack(this.activeTrackId);
        if (!track) return;
        const before = (track.pianoNotes || []).length;
        track.pianoNotes = this.notes.map(n => ({ note: n.note, octave: n.octave, step: n.step, length: n.length }));
        // ノートの数が変わったら知らせる (トラックの見出しのノートの数、進み具合の「打ち込む」を描き直す)
        if (before !== track.pianoNotes.length && this.onNotesChanged) this.onNotesChanged();
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
                div.dataset.pitch = String(this._pitchOf(name, oct));
                div.title = `${name}${oct}（押すと鳴ります）`;
                this.keysDiv.appendChild(div);
            }
        }
    }
    _resize() {
        // ノートを置く層が、スクロールできる範囲の大きさを決める
        const w = this.totalSteps * this.stepWidth, h = this.totalRows * this.noteHeight;
        this.noteLayer.style.width = w + 'px'; this.noteLayer.style.height = h + 'px';
        // グリッドの下に横のスクロールバーが出ると、そのぶんグリッドの見える高さが鍵盤の列より低くなる。
        // 鍵盤の列の下に同じ高さの余白を足して、一番下までスクロールしたときも行がそろうようにする
        this.keysDiv.style.paddingBottom = Math.max(0, this.wrap.offsetHeight - this.wrap.clientHeight) + 'px';
        // グリッドの canvas は、見えている範囲の大きさにする。曲全体の大きさにすると、
        // 長い曲でブラウザの canvas の上限 (幅 32767px 前後) を超えて何も描けなくなる
        const vw = Math.max(1, this.wrap.clientWidth), vh = Math.max(1, this.wrap.clientHeight);
        if (this.canvas.width !== vw || this.canvas.height !== vh) {
            this.canvas.width = vw; this.canvas.height = vh;
            this.canvas.style.width = vw + 'px'; this.canvas.style.height = vh + 'px';
        }
    }
    _drawGrid() {
        const { ctx, canvas } = this; const w = canvas.width, h = canvas.height;
        const sx = this.wrap.scrollLeft, sy = this.wrap.scrollTop;
        const bar = this._stepsPerBar();
        ctx.clearRect(0, 0, w, h);
        // 横線 (音の高さ)。見えている行だけ
        const firstRow = Math.max(0, Math.floor(sy / this.noteHeight));
        const lastRow = Math.min(this.totalRows, Math.ceil((sy + h) / this.noteHeight));
        for (let row = firstRow; row < lastRow; row++) {
            const y = row * this.noteHeight - sy, noteIdx = row % 12;
            if (this.blackKeys.has(this.noteNames[noteIdx])) { ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(0, y, w, this.noteHeight); }
            ctx.strokeStyle = noteIdx === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        // 縦線 (ステップ・拍・小節)。見えているステップだけ
        const firstStep = Math.max(0, Math.floor(sx / this.stepWidth));
        const lastStep = Math.min(this.totalSteps, Math.ceil((sx + w) / this.stepWidth));
        const bottom = Math.min(h, this.totalRows * this.noteHeight - sy);
        for (let step = firstStep; step <= lastStep; step++) {
            const x = step * this.stepWidth - sx, isBeat = step % 4 === 0, isBar = step % bar === 0;
            ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.25)' : isBeat ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)';
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke();
            // 小節番号 (上の端に小さく)
            if (isBar && step < this.totalSteps) {
                ctx.fillStyle = cssVar('--text-dim', '#908c85'); ctx.font = '10px sans-serif';
                ctx.fillText(String(step / bar + 1), x + 3, 10);
            }
        }
    }
    _bindEvents() {
        this.noteLayer.addEventListener('dblclick', (e) => {
            if (this.activeTrackId === null) return;
            if (e.target.classList.contains('note-block')) return;
            // ノートの層は中身と一緒にスクロールするので、層の左上からの距離がそのまま曲の中の位置になる
            const rect = this.noteLayer.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            let step = Math.floor(x / this.stepWidth);
            if (this.snapToGrid) step = Math.floor(step / this.gridSize) * this.gridSize;
            const row = Math.floor(y / this.noteHeight);
            if (row < 0 || row >= this.totalRows || step < 0) return;
            const { note, octave } = this._rowToNote(row);
            this._addNote(note, octave, step, this.gridSize);
            // 置いた高さを耳で確かめられるように鳴らす
            this._audition(note, octave);
        });
        // 鍵盤を押すと、その高さの音が鳴る (押しているあいだ鳴り、離すと止まる)
        this.keysDiv.addEventListener('mousedown', (e) => {
            const key = e.target.closest ? e.target.closest('.piano-key') : null;
            if (!key || key.dataset.pitch === undefined) return;
            e.preventDefault();
            this._releaseKey();
            const pitch = Number(key.dataset.pitch);
            this._clearAudition(pitch);
            engine.liveNoteOn(pitch, 96);
            key.classList.add('sounding');
            this._heldKey = { pitch, el: key };
        });
        this.noteLayer.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('note-block')) {
                e.preventDefault();
                const idx = parseInt(e.target.dataset.index);
                // 押した場所 (右端か、それ以外か) は、選ぶ前に測る。選ぶとノートを描き直すので、
                // 押した要素は画面から外れて、大きさが 0 になる (以前はここで必ず「右端」と判定されて、
                // どこをつかんでも長さの変更になり、ノートを動かせなかった)
                const rect = e.target.getBoundingClientRect();
                this._selectNote(idx);
                if (e.clientX > rect.right - 10) this.isResizing = true;
                else this.isDragging = true;
                this.dragStartX = e.clientX;
                this.dragStartStep = this.notes[idx].step;
                this._dragLength = this.notes[idx].length;
                this.dragStartY = e.clientY;
                this.dragStartRow = this._noteToRow(this.notes[idx].note, this.notes[idx].octave);
            }
        });
        document.addEventListener('mousemove', (e) => {
            if (!this.isDragging && !this.isResizing) return;
            if (this.selectedNote === null) return;
            const dx = e.clientX - this.dragStartX, dSteps = Math.round(dx / this.stepWidth);
            const note = this.notes[this.selectedNote];
            if (this.isDragging) {
                let ns = this.dragStartStep + dSteps; if (this.snapToGrid) ns = Math.round(ns / this.gridSize) * this.gridSize; note.step = Math.max(0, ns);
                // 縦に動かすと、音の高さが変わる (1 行 = 半音)。音域の端で止める
                const dRows = Math.round((e.clientY - this.dragStartY) / this.noteHeight);
                const row = Math.max(0, Math.min(this.totalRows - 1, this.dragStartRow + dRows));
                const next = this._rowToNote(row);
                if (next.note !== note.note || next.octave !== note.octave) {
                    note.note = next.note; note.octave = next.octave;
                    this._audition(note.note, note.octave);
                }
            }
            else if (this.isResizing) { let nl = this._dragLength + dSteps; if (this.snapToGrid) nl = Math.max(this.gridSize, Math.round(nl / this.gridSize) * this.gridSize); else nl = Math.max(1, nl); note.length = nl; }
            this._renderNotes();
        });
        document.addEventListener('mouseup', () => {
            this._releaseKey();
            if (this.isDragging || this.isResizing) { this._saveToEngine(); this._fitLength(); }
            this.isDragging = false; this.isResizing = false;
        });
        // 選んでいるノートを消す。Mac の delete キーは Backspace なので、両方を受ける。
        // 入力欄に居るとき (BPM の数字を消しているときなど) と、案内などの窓が開いているときは消さない
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Delete' && e.key !== 'Backspace') return;
            // Backspace は、ブラウザによっては「前のページへ戻る」に割り当てられている (WebKit)。
            // 戻ると打ち込んだ内容が全部消えるので、文字を消す欄の外では戻らせない
            if (e.key === 'Backspace' && !isTextEntry(e.target)) e.preventDefault();
            if (this.selectedNote === null || isTypingTarget(e.target) || isDialogOpen()) return;
            e.preventDefault();
            this._removeNote(this.selectedNote);
        });
    }
    /** 音名とオクターブから MIDI ノート番号を出す (C4 = 60)。 */
    _pitchOf(name, octave) { return (octave + 1) * 12 + CHROMATIC.indexOf(name); }
    /** 試し聴きの音を止めるタイマーを取り消す。 */
    _clearAudition(pitch) {
        const timer = this._auditionTimers.get(pitch);
        if (timer !== undefined) { clearTimeout(timer); this._auditionTimers.delete(pitch); }
    }
    /**
     * その高さの音を短く鳴らす (試し聴き)。ノートを置いたときと、高さを変えたときに使う。
     * MIDI 入力のモニターと同じ仕組み (engine.liveNoteOn) で鳴らす。
     *
     * @param name - 音名
     * @param octave - オクターブ
     */
    _audition(name, octave) {
        const pitch = this._pitchOf(name, octave);
        this._clearAudition(pitch);
        engine.liveNoteOn(pitch, 96);
        this._auditionTimers.set(pitch, setTimeout(() => {
            this._auditionTimers.delete(pitch);
            engine.liveNoteOff(pitch);
        }, AUDITION_MS));
    }
    /** 押していた鍵盤を離す (音を止める)。 */
    _releaseKey() {
        if (!this._heldKey) return;
        engine.liveNoteOff(this._heldKey.pitch);
        this._heldKey.el.classList.remove('sounding');
        this._heldKey = null;
    }
    _rowToNote(row) { return { note: this.noteNames[row % 12], octave: this.octaveRange[1] - 1 - Math.floor(row / 12) }; }
    _noteToRow(name, oct) { return (this.octaveRange[1] - 1 - oct) * 12 + this.noteNames.indexOf(name); }
    _addNote(note, octave, step, length) { this.notes.push({ note, octave, step, length }); this._saveToEngine(); this._fitLength(); this._renderNotes(); }
    _removeNote(idx) { this.notes.splice(idx, 1); this.selectedNote = null; this._saveToEngine(); this._fitLength(); this._renderNotes(); }
    _selectNote(idx) { this.selectedNote = idx; this._renderNotes(); }
    _renderNotes() {
        if (!this.noteLayer) return; this.noteLayer.innerHTML = '';
        if (this.activeTrackId === null) {
            const msg = document.createElement('div');
            msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text-dim);font-size:13px;pointer-events:none;';
            msg.textContent = 'トラック名をクリックすると、ここにピアノロールが開きます';
            this.noteLayer.appendChild(msg); return;
        }
        // お手本は先に置く (打ち込んだノートの下に見える)。押しても反応しない
        for (const n of this.ghostNotes) {
            const row = this._noteToRow(n.note, n.octave);
            if (row < 0 || row >= this.totalRows) continue;
            const el = document.createElement('div');
            el.className = 'note-ghost';
            el.style.left = (n.step * this.stepWidth) + 'px'; el.style.top = (row * this.noteHeight) + 'px';
            el.style.width = (n.length * this.stepWidth - 1) + 'px'; el.style.height = (this.noteHeight - 1) + 'px';
            el.title = `お手本 ${n.note}${n.octave}`;
            this.noteLayer.appendChild(el);
        }
        // 表示できる音域の外のノートは描かず (データは残す)、在ることだけ知らせる
        let outOfRange = 0;
        this.notes.forEach((n, i) => {
            const row = this._noteToRow(n.note, n.octave);
            if (row < 0 || row >= this.totalRows) { outOfRange += 1; return; }
            const el = document.createElement('div');
            el.className = 'note-block' + (i === this.selectedNote ? ' selected' : '');
            el.style.left = (n.step * this.stepWidth) + 'px'; el.style.top = (row * this.noteHeight) + 'px';
            el.style.width = (n.length * this.stepWidth - 1) + 'px'; el.style.height = (this.noteHeight - 1) + 'px';
            el.dataset.index = i; el.title = `${n.note}${n.octave} step:${n.step} len:${n.length}`;
            this.noteLayer.appendChild(el);
        });
        if (outOfRange > 0) {
            const notice = document.createElement('div');
            notice.className = 'note-out-of-range';
            notice.textContent = `表示できる音域 (C${this.octaveRange[0]}〜B${this.octaveRange[1] - 1}) の外に、ノートが ${outOfRange} 個あります`;
            this.noteLayer.appendChild(notice);
        }
    }
    /**
     * 現在のノート一覧をエンジンに保存したうえで返す。
     * `/api/synth/sequence` へ送信するデータ取得時などに使用する。
     *
     * @returns ノート情報の配列（`note`, `octave`, `step`, `length` を含むオブジェクト）
     */
    getNotes() { this._saveToEngine(); return this.notes.map(n => ({ note: n.note, octave: n.octave, step: n.step, length: n.length })); }
    /**
     * ノートを一括セットしてピアノロールを再描画する。
     * 音声解析結果（`/api/analyze`）の配置などに使用する。
     *
     * @param notes - セットするノート情報の配列（`note`, `octave`, `step`, `length` を含む）
     */
    setNotes(notes) { this.notes = notes.map(n => ({ ...n })); this.selectedNote = null; this._saveToEngine(); this._fitLength(); this._renderNotes(); this._revealNotes(); }
    /**
     * お手本として薄く重ねて見せるノートを入れ替える (空の配列か null で消す)。
     * お手本は見るだけで、編集も保存もされない。
     *
     * @param notes - お手本のノート (`note`, `octave`, `step`, `length`)
     */
    setGhostNotes(notes) { this.ghostNotes = (notes || []).map(n => ({ ...n })); this._fitLength(); this._renderNotes(); this._revealNotes(); }
    /**
     * 指定したステップが見える位置まで、横にスクロールする (見えている幅の 4 分の 1 あたりに来る)。
     * 差分チェックの指摘から、その小節へ移動するのに使う。
     *
     * @param step - 見せたいステップ
     */
    scrollToStep(step) {
        if (!this.wrap) return;
        this.wrap.scrollLeft = Math.max(0, step * this.stepWidth - this.wrap.clientWidth / 4);
    }
    /**
     * 現在アクティブなトラックの ID を返す。
     *
     * @returns アクティブなトラック ID（数値）、未選択時は `null`
     */
    getActiveTrackId() { return this.activeTrackId; }
    /**
     * 全ノートを削除してピアノロールをクリアする。
     * エンジン側のピアノノートも同時に空にする。
     */
    clear() { this.notes = []; this.selectedNote = null; this._saveToEngine(); this._fitLength(); this._renderNotes(); }
}

/**
 * Canvas ベースのタイムライン（アレンジメントビュー）エンジン。
 *
 * 全トラックとそのクリップを DOM として描画し、以下の操作を提供する:
 * - クリップのドラッグ移動（拍グリッドにスナップ）
 * - クリップの右クリック削除
 * - WAV ファイルのドラッグ＆ドロップによるインポート
 * - トラックヘッダーのクリックによるピアノロール切り替え
 * - ミュート / ソロ / トラック削除 / トラック単体再生
 *   (M・S・✕ は 1 文字のボタンなので、何のボタンかを aria-label と title で伝える)
 *
 * 主なパブリック API:
 * - `init(el)` — DOM 要素を渡して初期化する
 * - `render(pianoRoll)` — 全トラックを再描画する
 */
// ---- Timeline クラス（Canvasベース）----
class TimelineEngine {
    constructor() {
        this.container = null; this.headerCanvas = null; this.headerCtx = null;
        this.pixelsPerSecond = 80; this.draggingClip = null; this.dragOffsetX = 0;
        this.onStatus = null; this.onTrackSelect = null; this.onTracksChanged = null;
        // スクロールする枠 (#timeline-area)。小節番号の段は、この枠の見えている範囲だけを描く
        this.scroller = null;
        // トラックの見出しの幅 (CSS の .track-header と同じ)。クリップを置く領域はこの右から始まるので、
        // 小節番号の段も同じだけ右から始める
        this.headerWidth = 130;
        // 再生位置の線 (setPlayhead で動かす)
        this.playhead = null;
        // 「このパートを練習する」を押したとき (CenterArea が渡す)
        this.onPractice = null;
    }
    /**
     * タイムラインを DOM 要素群に紐付けて初期化する。
     * ヘッダー Canvas の描画とグローバルマウスイベントの登録を行う。
     *
     * @param el - 初期化に必要な DOM 要素群
     * @param el.container - トラック行を配置するコンテナ `<div>` 要素
     * @param el.headerCanvas - 小節番号ルーラーを描画する `<canvas>` 要素
     * @param el.scroller - タイムライン全体をスクロールさせる枠 (`#timeline-area`)
     */
    init(el) {
        this.container = el.container; this.headerCanvas = el.headerCanvas; this.scroller = el.scroller || null;
        this.headerCtx = this.headerCanvas.getContext('2d');
        // 再生位置の線。トラックの行は描き直すたびに作り直すので、その外 (スクロールする枠の中) に置く
        if (this.scroller) {
            this.playhead = document.createElement('div');
            this.playhead.className = 'playhead'; this.playhead.id = 'timeline-playhead';
            this.playhead.setAttribute('aria-hidden', 'true');
            this.scroller.appendChild(this.playhead);
        }
        this._drawHeader(); this._bindGlobalEvents();
        // 小節番号の段は見えている範囲だけを描くので、スクロールや大きさの変化のたびに描き直す
        if (this.scroller) {
            this.scroller.addEventListener('scroll', () => this._drawHeader());
            if (typeof ResizeObserver !== 'undefined') {
                this._resizeObserver = new ResizeObserver(() => {
                    cancelAnimationFrame(this._resizeFrame);
                    this._resizeFrame = requestAnimationFrame(() => this._drawHeader());
                });
                this._resizeObserver.observe(this.scroller);
            }
        }
    }
    /** タイムラインの長さ (秒)。曲の終わりの後ろに 10 秒の余白を置く。最短は 30 秒。 */
    _totalSeconds() { return Math.max(30, engine.getTotalDuration() + 10); }
    /**
     * 小節番号の段を描く。見えている範囲だけを描き、枠の上端・左端に留める (CSS の sticky)。
     *
     * 曲全体の幅の canvas にはしない。長い曲でブラウザの canvas の上限を超えるうえ、
     * 縦にスクロールすると段ごと流れて見えなくなる。
     * 左の `headerWidth` はトラックの見出しの列なので空ける。ここを空けないと、
     * 小節番号が見出しの幅だけ左にずれて、クリップの位置と合わない。
     */
    _drawHeader() {
        if (!this.headerCanvas) return;
        const w = Math.max(1, this.scroller ? this.scroller.clientWidth : this.headerCanvas.clientWidth), h = 24;
        // 大きさを設定し直すと canvas は消える (描き直しの前の消去を兼ねる)
        this.headerCanvas.width = w; this.headerCanvas.height = h; this.headerCanvas.style.width = w + 'px';
        const ctx = this.headerCtx; ctx.fillStyle = cssVar('--bg-secondary', '#17171e'); ctx.fillRect(0, 0, w, h);
        const numberColor = cssVar('--text', '#e8e4de');
        const scrollLeft = this.scroller ? this.scroller.scrollLeft : 0, left = this.headerWidth;
        // 拍は 1 小節目の 1 拍目 (engine.gridOffset) から数える。ピアノロールの小節番号と同じ番号になる。
        // それより前 (弱起) の拍は、番号を付けずに目盛りだけ描く
        const beatPx = (60 / engine.bpm) * this.pixelsPerSecond, perBar = Math.max(1, engine.beatsPerBar || 4);
        const originPx = engine.gridOffset * this.pixelsPerSecond;
        const lastBeat = Math.ceil((this._totalSeconds() * this.pixelsPerSecond - originPx) / beatPx);
        const firstBeat = -Math.floor(originPx / beatPx);
        const first = Math.max(firstBeat, Math.floor((scrollLeft - originPx) / beatPx));
        const last = Math.min(lastBeat, Math.ceil((scrollLeft + w - left - originPx) / beatPx));
        for (let beat = first; beat <= last; beat++) {
            const x = left + originPx + beat * beatPx - scrollLeft;
            if (x < left) continue;
            if (beat >= 0 && beat % perBar === 0) { ctx.fillStyle = numberColor; ctx.font = '10px sans-serif'; ctx.fillText(String(beat / perBar + 1), x + 3, 14); ctx.strokeStyle = 'rgba(255,255,255,0.3)'; }
            else ctx.strokeStyle = beat < 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.1)';
            ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, 24); ctx.stroke();
        }
    }
    /**
     * 指定した位置 (秒) が見えるよう、横にスクロールする (見えている幅の 4 分の 1 あたりに来る)。
     * カルテやガイドの小節、差分チェックの指摘から移動するのに使う。
     *
     * @param sec - 見せたい位置 (秒)
     */
    scrollToTime(sec) {
        if (!this.scroller) return;
        const view = this.scroller.clientWidth - this.headerWidth;
        this.scroller.scrollLeft = Math.max(0, sec * this.pixelsPerSecond - view / 4);
    }
    /**
     * 再生位置の線を動かす。再生中は毎フレーム呼ばれるので、位置は transform で動かす。
     *
     * @param sec - 再生位置 (秒)
     */
    setPlayhead(sec) {
        if (!this.playhead || !this.container) return;
        const visible = engine.tracks.length > 0;
        this.playhead.style.display = visible ? 'block' : 'none';
        if (!visible) return;
        this.playhead.style.top = this.container.offsetTop + 'px';
        this.playhead.style.height = this.container.offsetHeight + 'px';
        this.playhead.style.transform = `translateX(${Math.round(this.headerWidth + sec * this.pixelsPerSecond)}px)`;
    }
    /** 再生位置が見えている範囲の外に出たら、見えるところまで横にスクロールする (再生中の自動スクロール)。 */
    followPlayhead(sec) {
        if (!this.scroller) return;
        const x = sec * this.pixelsPerSecond, left = this.scroller.scrollLeft;
        const view = this.scroller.clientWidth - this.headerWidth;
        if (x < left || x > left + view - 24) this.scroller.scrollLeft = Math.max(0, x - view / 4);
    }
    /**
     * エンジンの全トラックをタイムラインに再描画する。
     * トラックヘッダー・クリップ・ドラッグ＆ドロップ・各種ボタンのイベントを再バインドする。
     *
     * @param pianoRoll - 連携するピアノロールエンジン（トラック選択の同期に使用）
     */
    render(pianoRoll) {
        if (!this.container) return;
        this.container.innerHTML = ''; this._drawHeader();
        for (const track of engine.tracks) {
            const row = document.createElement('div'); row.className = 'track-row';
            const isActive = pianoRoll && pianoRoll.getActiveTrackId() === track.id;
            const noteCount = (track.pianoNotes || []).length;
            const header = document.createElement('div');
            header.className = 'track-header' + (isActive ? ' active-track' : '');
            header.dataset.trackId = track.id;
            const isTrackPlaying = engine.isPlaying && engine.soloTrackId === track.id;
            header.innerHTML = `<span class="track-name"></span>
                <div class="track-controls">
                    <button type="button" class="btn-track-play ${isTrackPlaying ? 'playing' : ''}" data-track="${track.id}">${isTrackPlaying ? '⏸' : '▶'}</button>
                    <button type="button" class="btn-mute ${track.mute ? 'muted' : ''}" data-track="${track.id}" aria-pressed="${track.mute ? 'true' : 'false'}">M</button>
                    <button type="button" class="btn-solo ${track.solo ? 'soloed' : ''}" data-track="${track.id}" aria-pressed="${track.solo ? 'true' : 'false'}">S</button>
                    <button type="button" class="btn-delete-track" data-track="${track.id}">✕</button>
                </div>`;
            // 1 文字のボタンが何をするかを、読み上げ (aria-label) とマウスを載せたときの説明 (title) で伝える。
            // トラック名を含むので、HTML に埋め込まず属性として入れる
            const describe = (selector, label, title) => {
                const button = header.querySelector(selector);
                button.setAttribute('aria-label', label); button.title = title;
            };
            describe('.btn-track-play', isTrackPlaying ? `「${track.name}」の再生を一時停止` : `「${track.name}」だけを再生`, isTrackPlaying ? '一時停止' : 'このトラックだけ再生');
            describe('.btn-mute', `「${track.name}」をミュート`, track.mute ? 'ミュート中（押すと鳴るように戻す）' : 'ミュート（このトラックを鳴らさない）');
            describe('.btn-solo', `「${track.name}」をソロ`, track.solo ? 'ソロ中（押すと解除）' : 'ソロ（このトラックだけ鳴らす）');
            describe('.btn-delete-track', `「${track.name}」を削除`, 'トラックを削除');
            // トラック名は文字として入れる。HTML に埋め込むと、名前に < や & が在るときに崩れ、
            // 読み込んだプロジェクトの名前がタグとして解釈されてしまう
            const nameEl = header.querySelector('.track-name');
            nameEl.textContent = track.name + ' ';
            if (noteCount > 0) {
                const badge = document.createElement('span');
                badge.className = 'notes-badge'; badge.title = `${noteCount}ノート`; badge.textContent = String(noteCount);
                nameEl.appendChild(badge);
            }
            // パートのトラック (お手本を持つもの) には、「このパートを練習する」を出す
            if (track.role === 'part' && track.referenceNotes && track.referenceNotes.length > 0 && this.onPractice) {
                const practice = document.createElement('button');
                practice.type = 'button'; practice.className = 'btn-practice'; practice.dataset.track = track.id;
                practice.textContent = '練習する';
                practice.setAttribute('aria-label', `「${track.name}」を練習する`);
                practice.title = 'このパートを練習する（お手本を重ねたピアノロールを開きます）';
                practice.addEventListener('click', (e) => { e.stopPropagation(); this.onPractice(track.id); });
                header.appendChild(practice);
            } else if (track.role === 'practice') {
                header.classList.add('practice-track');
            }
            row.appendChild(header);
            const canvasWrap = document.createElement('div'); canvasWrap.className = 'track-canvas-wrap'; canvasWrap.dataset.trackId = track.id;
            // クリップを置く領域は、曲全体の幅を持つ (行ごと横にスクロールする)
            canvasWrap.style.width = (this._totalSeconds() * this.pixelsPerSecond) + 'px';
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
                clipEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault(); engine.removeClip(track.id, ci); this.render(pianoRoll);
                    // 右クリックはその場で消える (取り消せない) ので、何を消したかを知らせる
                    if (this.onStatus) this.onStatus(`クリップ「${clip.name}」を「${track.name}」から削除しました`);
                    if (this.onTracksChanged) this.onTracksChanged();
                });
                canvasWrap.appendChild(clipEl);
            });
            canvasWrap.addEventListener('dragover', (e) => e.preventDefault());
            canvasWrap.addEventListener('drop', async (e) => {
                e.preventDefault();
                // 位置は、読み込みを待つ前に取っておく (待っているあいだに描き直されると、要素が入れ替わる)
                const dropSec = Math.max(0, (e.clientX - canvasWrap.getBoundingClientRect().left) / this.pixelsPerSecond);
                const added = [], rejected = [], failed = [];
                for (const file of e.dataTransfer.files) {
                    // 音声のファイル (WAV・MP3・FLAC など。拡張子は大文字でも受ける) だけを受ける。
                    // それ以外や、このブラウザで読めない形式は、黙って無視せずに知らせる
                    if (!isAudioFileName(file.name)) { rejected.push(file.name); continue; }
                    try {
                        await engine.addClipFromFile(track.id, file, dropSec);
                        added.push(file.name);
                    } catch {
                        failed.push(file.name);
                    }
                }
                this.render(pianoRoll);
                if (this.onStatus) {
                    if (rejected.length > 0) this.onStatus(`音声ではないファイルは追加できません: ${rejected.join('、')}。WAV・MP3・FLAC などの音声ファイルを追加してください`, 'error');
                    else if (failed.length > 0) this.onStatus(`${failed.join('、')} を読み込めませんでした。WAV に変換してから追加してください`, 'error');
                    else if (added.length > 0) this.onStatus(`${added.join('、')} を「${track.name}」に追加しました`);
                }
                if (added.length > 0 && this.onTracksChanged) this.onTracksChanged();
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
                this._renderKeepingFocus(pianoRoll, '.btn-track-play', id);
            });
        });
        this.container.querySelectorAll('.btn-mute').forEach(btn => {
            btn.addEventListener('click', () => { const id = parseInt(btn.dataset.track); engine.toggleMute(id); this._renderKeepingFocus(pianoRoll, '.btn-mute', id); });
        });
        this.container.querySelectorAll('.btn-solo').forEach(btn => {
            btn.addEventListener('click', () => { const id = parseInt(btn.dataset.track); const t = engine.getTrack(id); if (t) t.solo = !t.solo; this._renderKeepingFocus(pianoRoll, '.btn-solo', id); });
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
    /**
     * 描き直したあと、押したボタンにフォーカスを戻す。
     * 描き直しは行を作り直すので、そのままだとキーボードで操作している人の現在地が失われる。
     *
     * @param pianoRoll - 連携するピアノロールエンジン
     * @param selector - 押したボタンのセレクタ
     * @param trackId - 押したボタンのトラック ID
     */
    _renderKeepingFocus(pianoRoll, selector, trackId) {
        const hadFocus = this.container.contains(document.activeElement);
        this.render(pianoRoll);
        if (hadFocus) this.container.querySelector(`${selector}[data-track="${trackId}"]`)?.focus();
    }
    _bindGlobalEvents() {
        document.addEventListener('mousemove', (e) => {
            if (!this.draggingClip) return;
            const el = this.draggingClip.element, parent = el.parentElement;
            let x = e.clientX - parent.getBoundingClientRect().left - this.dragOffsetX;
            x = Math.max(0, x);
            // 拍の線 (1 小節目の位置から数えた拍) に吸い付ける
            const beatPx = (60 / engine.bpm) * this.pixelsPerSecond, originPx = engine.gridOffset * this.pixelsPerSecond;
            let snapped = originPx + Math.round((x - originPx) / beatPx) * beatPx;
            if (snapped < 0) snapped += beatPx * Math.ceil(-snapped / beatPx);
            el.style.left = snapped + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!this.draggingClip) return;
            engine.moveClip(this.draggingClip.trackId, this.draggingClip.clipIndex, parseFloat(this.draggingClip.element.style.left) / this.pixelsPerSecond);
            const pr = this._pianoRoll;
            this.draggingClip = null; this.render(pr);
        });
    }
}

/**
 * 再生位置のシークバーコンポーネント。
 * 100ms 間隔でエンジンの現在時刻・総時間をポーリングしてスライダーと時刻表示を更新する。
 * ドラッグ中はポーリングによる上書きを抑止し、離したタイミングでシーク処理を実行する。
 * ソロトラックが設定されている場合はシーク後に同じトラックの再生を再開する。
 *
 * @returns `<div id="seek-bar-area">` 要素（現在時刻・スライダー・総時間を含む）
 */
// ---- SeekBar コンポーネント ----
function SeekBar() {
    const { followPlayhead, setFollowPlayhead, setHint } = useDaw();
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
    // つまみを離したとき (マウス・タッチ・キー) に、その位置へ移動する。
    // 位置は、状態 (seekVal) ではなく入力欄そのものから読む。状態は次の描画まで古いままなので、
    // 押してすぐ離すと (WebKit のクリック)、1 つ前の位置へ移動してしまう
    const finishSeek = (e) => {
        if (!isSeeking.current) return; isSeeking.current = false;
        const dur = engine.getTotalDuration(); if (dur <= 0) return;
        engine.seek((Number(e.currentTarget.value) / 100) * dur);
    };

    return (
        <div id="seek-bar-area">
            <span id="seek-time-current">{curTime}</span>
            <input type="range" id="seek-bar" aria-label="再生位置" min="0" max="100" step="0.1" value={seekVal}
                onMouseDown={() => { isSeeking.current = true; }} onTouchStart={() => { isSeeking.current = true; }}
                onInput={handleInput} onMouseUp={finishSeek} onTouchEnd={finishSeek}
                // 矢印キーでも動かせる。キーを離したときと、欄を離れたときにも確定する
                // (確定しないと、移動されないうえに、以後つまみが再生位置を追わなくなる)
                onKeyUp={finishSeek} onBlur={finishSeek} />
            <span id="seek-time-total">{totalTime}</span>
            <label id="follow-playhead" onMouseEnter={() => setHint('再生中に、再生位置が見えるようにタイムラインとピアノロールを自動でスクロールします')}
                onMouseLeave={() => setHint('')}>
                <input type="checkbox" checked={followPlayhead} onChange={(e) => setFollowPlayhead(e.target.checked)} />
                再生位置を追う
            </label>
        </div>
    );
}

/**
 * トラックが 1 本も無いときに、タイムラインの場所に出す案内。
 * 主な操作は「曲を取り込んで始める」(学ぶ流れ)。曲を使わずに作るなら「自由に作る」で空のトラックを作る。
 */
function EmptyState() {
    const { openSongPicker, openLearn } = useDaw();
    const { startFree } = useLearnActions();
    return (
        <div id="empty-state" role="region" aria-label="はじめに">
            <h2>曲を取り込んで、自分で再現してみましょう</h2>
            <p>
                取り込んだ曲を解析してカルテを作り、パートに分けたお手本を見ながら、ピアノロールに自分で打ち込みます。
                最後に差分チェックで、お手本との違いを確かめます。
            </p>
            <div className="empty-actions">
                <button type="button" className="action-btn primary" onClick={() => { openLearn('song'); openSongPicker(); }}>
                    曲を取り込んで始める
                </button>
                <button type="button" className="action-btn secondary" onClick={startFree}>自由に作る</button>
            </div>
            <p className="empty-note">MP3・WAV・FLAC・M4A などの曲のファイルを選びます。「自由に作る」は、空のトラックを 1 本作ります。</p>
        </div>
    );
}

/**
 * 中央エリアコンポーネント。
 * タイムラインとピアノロールを縦に並べて表示する。あいだの境目を動かすと、ピアノロールの高さが変わる。
 *
 * マウント時に `PianoRollEngine` / `TimelineEngine` を初期化し、
 * それぞれを `pianoRollRef` / `timelineRef` に格納して
 * 他のコンポーネントからも参照できるようにする。
 * `trackVersion` が変わるたびにタイムラインを再描画して最新の状態を反映する。
 *
 * オートメーションの欄は、再生エンジンにつながっていない見た目だけのものだったので外した
 * (docs/daw-features.md の「実装していない機能」)。
 *
 * @returns 中央エリア全体の `<div id="center">` 要素
 */
// ---- メイン CenterArea コンポーネント ----
export default function CenterArea() {
    const { setStatus, bumpTracks, pianoRollRef, timelineRef, trackVersion, bpm, beatsPerBar, gridOffset, followPlayhead } = useDaw();
    const { practicePart } = useLearnActions();
    // タイムラインの「練習する」は、初期化のときに 1 回だけ渡すので、最新の関数を ref で引く
    const practiceRef = useRef(practicePart);
    const followRef = useRef(followPlayhead);
    useEffect(() => { practiceRef.current = practicePart; followRef.current = followPlayhead; }, [practicePart, followPlayhead]);
    const [activeTrackName, setActiveTrackName] = useState(null);
    const [activeTrackId, setActiveTrackId] = useState(null);
    // ピアノロールの高さ (px)。境目を動かすまでは null で、CSS の既定の高さになる
    const [pianoHeight, setPianoHeight] = useState(null);
    const [resizing, setResizing] = useState(false);

    const centerRef = useRef(null);
    const pianoAreaRef = useRef(null);
    const timelineAreaRef = useRef(null);
    const tracksContainerRef = useRef(null);
    const headerCanvasRef = useRef(null);
    const pianoCanvasRef = useRef(null);
    const noteLayerRef = useRef(null);
    const keysRef = useRef(null);
    const pianoWrapRef = useRef(null);
    // 境目のドラッグの起点 (押した位置と、そのときのピアノロールの高さ)
    const resizeStartRef = useRef(null);

    useEffect(() => {
        // 初期化は 1 回だけ。開発モード (React の StrictMode) ではこの effect が 2 回走るが、
        // 2 回作ると、同じ要素に操作の受け口が二重に付いて、古いほうが空の状態で反応してしまう
        if (pianoRollRef.current) return;

        // PianoRoll 初期化
        const pr = new PianoRollEngine();
        pr.init({ canvas: pianoCanvasRef.current, noteLayer: noteLayerRef.current, keysDiv: keysRef.current, wrap: pianoWrapRef.current });
        pr.onTrackSwitch = (trackId) => {
            const track = trackId ? engine.getTrack(trackId) : null;
            setActiveTrackName(track ? track.name : null);
            setActiveTrackId(track ? track.id : null);
        };
        pr.onNotesChanged = bumpTracks;
        pianoRollRef.current = pr;

        // Timeline 初期化
        const tl = new TimelineEngine();
        tl.init({ container: tracksContainerRef.current, headerCanvas: headerCanvasRef.current, scroller: timelineAreaRef.current });
        tl.onStatus = setStatus;
        tl.onTracksChanged = bumpTracks;
        tl.onPractice = (trackId) => practiceRef.current(trackId);
        tl._pianoRoll = pr;
        timelineRef.current = tl;

        // 起動したときはトラックを作らない。空の状態の案内 (EmptyState) から、曲を取り込むか、自由に作る
        tl.render(pr);
        bumpTracks();

        setStatus('準備完了 — 「曲を取り込んで始める」から始めます');
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // 再生位置の線。再生中だけ毎フレーム (requestAnimationFrame) 動かす。止まっているあいだは、
    // 軽い見回り (200ms ごと) で、シークなどで位置が変わったときと、再生が始まったときを拾う
    useEffect(() => {
        let frame = 0, last = -1;
        const draw = () => {
            const t = engine.getCurrentTime();
            timelineRef.current?.setPlayhead(t);
            pianoRollRef.current?.setPlayhead(t);
            if (engine.isPlaying && followRef.current) {
                timelineRef.current?.followPlayhead(t);
                pianoRollRef.current?.followPlayhead(t);
            }
            last = t;
        };
        const loop = () => {
            draw();
            frame = engine.isPlaying ? requestAnimationFrame(loop) : 0;
        };
        const watch = setInterval(() => {
            if (engine.isPlaying) { if (!frame) frame = requestAnimationFrame(loop); }
            else if (engine.getCurrentTime() !== last) draw();
        }, 200);
        draw();
        return () => { clearInterval(watch); cancelAnimationFrame(frame); };
    }, [timelineRef, pianoRollRef]);

    // trackVersion が変わるたびにタイムラインを再描画
    useEffect(() => {
        const tl = timelineRef.current;
        const pr = pianoRollRef.current;
        if (tl) { tl.render(pr); tl.setPlayhead(engine.getCurrentTime()); }
        pr?.setPlayhead(engine.getCurrentTime());
    }, [trackVersion, timelineRef, pianoRollRef]);

    // テンポか拍子が変わったら、拍と小節の線を描き直す (小節番号の段、ピアノロール)。
    // 描き直さないと、次にトラックを触るまで古いテンポの目盛りが残る
    useEffect(() => {
        timelineRef.current?._drawHeader();
        const pr = pianoRollRef.current;
        if (pr?.canvas) { pr._fitLength(); pr._drawGrid(); pr.setPlayhead(engine.getCurrentTime()); }
    }, [bpm, beatsPerBar, gridOffset, timelineRef, pianoRollRef]);

    const handleAddTrack = useCallback(() => {
        const t = engine.addTrack();
        bumpTracks();
        setStatus(`「${t.name}」を追加しました`);
    }, [bumpTracks, setStatus]);

    // ---- タイムラインとピアノロールの境目 ----
    /** ピアノロールに取れる高さの上限。タイムラインに最低限の高さを残す。 */
    const maxPianoHeight = useCallback(() => {
        const center = centerRef.current;
        if (!center) return PIANO_MIN_HEIGHT;
        const handle = center.querySelector('#resize-piano');
        return Math.max(PIANO_MIN_HEIGHT, center.clientHeight - TIMELINE_MIN_HEIGHT - (handle ? handle.offsetHeight : 0));
    }, []);
    const clampPianoHeight = useCallback(
        (height) => Math.round(Math.max(PIANO_MIN_HEIGHT, Math.min(maxPianoHeight(), height))),
        [maxPianoHeight],
    );
    const currentPianoHeight = useCallback(
        () => (pianoAreaRef.current ? pianoAreaRef.current.getBoundingClientRect().height : 300),
        [],
    );

    const handleResizeDown = useCallback((e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        resizeStartRef.current = { y: e.clientY, height: currentPianoHeight() };
        // 押したまま窓の外へ出ても、動きを受け取り続ける
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 取れなくても、窓の中では動かせる */ }
        setResizing(true);
    }, [currentPianoHeight]);
    // ドラッグのあいだの動きは、窓全体で受ける (境目は細いので、境目の上だけで受けると、すぐに外れる)
    useEffect(() => {
        if (!resizing) return;
        const onMove = (e) => {
            const start = resizeStartRef.current;
            if (!start) return;
            // 境目を上へ動かすと、ピアノロールが高くなる
            setPianoHeight(clampPianoHeight(start.height - (e.clientY - start.y)));
        };
        const onEnd = () => {
            resizeStartRef.current = null;
            setResizing(false);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointercancel', onEnd);
        };
    }, [resizing, clampPianoHeight]);
    const handleResizeKey = useCallback((e) => {
        let next = null;
        if (e.key === 'ArrowUp') next = currentPianoHeight() + RESIZE_KEY_STEP;
        else if (e.key === 'ArrowDown') next = currentPianoHeight() - RESIZE_KEY_STEP;
        else if (e.key === 'Home') next = maxPianoHeight();
        else if (e.key === 'End') next = PIANO_MIN_HEIGHT;
        if (next === null) return;
        e.preventDefault();
        setPianoHeight(clampPianoHeight(next));
    }, [currentPianoHeight, maxPianoHeight, clampPianoHeight]);

    const pianoLabel = activeTrackName
        ? <>ピアノロール — <strong style={{ color: 'var(--accent)' }}>{activeTrackName}</strong> <span className="area-hint">（ダブルクリックでノートを追加 / ドラッグで移動・高さの変更 / Delete か Backspace で削除）</span></>
        : <>ピアノロール <span className="area-hint">（タイムラインのトラック名をクリックすると開きます）</span></>;

    return (
        <div id="center" ref={centerRef}>
            {/* タイムライン */}
            <div id="timeline-area" ref={timelineAreaRef}>
                {/* 見出しと小節番号の段は、スクロールしても枠の上端・左端に留める */}
                <div id="timeline-top">
                    <div className="area-label">タイムライン <span className="area-hint">（音声ファイルをドロップして追加 / クリップをドラッグで移動 / 右クリックで削除）</span></div>
                    <canvas ref={headerCanvasRef} id="timeline-header-canvas" />
                </div>
                <div ref={tracksContainerRef} id="tracks-container" />
                {engine.tracks.length === 0 && <EmptyState />}
                <button id="btn-add-track" onClick={handleAddTrack} hidden={engine.tracks.length === 0}>+ トラック追加</button>
                <SeekBar />
            </div>

            {/* タイムラインとピアノロールの境目。ドラッグか、上下の矢印キーで動かす */}
            <div className={'resize-handle' + (resizing ? ' dragging' : '')} id="resize-piano"
                role="separator" aria-orientation="horizontal" tabIndex={0}
                aria-label="タイムラインとピアノロールの境目（上下の矢印キーで動かせます）"
                aria-valuemin={PIANO_MIN_HEIGHT} aria-valuenow={pianoHeight ?? 300}
                title="ドラッグすると、ピアノロールの高さが変わります"
                onPointerDown={handleResizeDown} onKeyDown={handleResizeKey} />

            {/* ピアノロール */}
            <div id="piano-roll-area" ref={pianoAreaRef} style={pianoHeight === null ? undefined : { height: pianoHeight }}>
                <div className="area-label">{pianoLabel}<MidiInputBar /><GhostBar activeTrackId={activeTrackId} /></div>
                <div id="piano-roll-body">
                    <div ref={keysRef} id="piano-keys" />
                    <div ref={pianoWrapRef} id="piano-grid-wrap">
                        <canvas ref={pianoCanvasRef} id="piano-grid-canvas" />
                        <div ref={noteLayerRef} id="note-layer" />
                    </div>
                </div>
            </div>
        </div>
    );
}
