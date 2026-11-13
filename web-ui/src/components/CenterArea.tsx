/**
 * bunri DAW — 中央エリア（タイムライン + ピアノロール）
 * TODO: Canvas系クラスの完全な型定義を追加する
 */
// @ts-nocheck
import { useEffect, useRef, useState, useCallback } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { cssVar } from '../lib/theme';
import { hasPrimaryModifier, isDialogOpen, isTextEntry, isTypingTarget } from '../lib/keys';
import { sameNotes } from '../lib/project-snapshot';
import MidiInputBar from './MidiInputBar';
import { useMidiInput } from '../lib/useMidiInput';
import GhostBar from './GhostBar';
import { PracticeBands, PracticeControls, PracticeHeader, PracticeProvider, PracticeSide } from './PracticeView';
import { secToStep, stepSeconds } from '../lib/grid';
import { isAudioFileName, useLearnActions } from '../lib/learn';
import { GAIN_MAX_DB, GAIN_MIN_DB, GAIN_STEP_DB, PAN_STEPS, clampGainDb, clampPan, formatGainDb, formatPan } from '../lib/mix';
import PopupMenu from './PopupMenu';
import RecentProjects from './RecentProjects';
import { cursorLabel } from '../lib/midi-input';
import { tip } from '../lib/tooltip';

/** 音名を低い順に並べたもの (MIDI ノート番号を出すのに使う)。 */
const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** ノートを置いたり動かしたりしたときに、その高さの音を鳴らす長さ (ミリ秒)。 */
const AUDITION_MS = 220;

/** ピアノロールの高さの下限と、タイムラインに残す高さの下限 (px)。CSS の min-height と合わせる。 */
const PIANO_MIN_HEIGHT = 150;
const TIMELINE_MIN_HEIGHT = 200;
/** 境目をキーボードで動かすときの 1 回ぶん (px)。 */
const RESIZE_KEY_STEP = 24;
/** タイムラインのトラックの見出しの幅 (px)。CSS の .track-header と合わせる。クリップを置く領域はこの右から始まる */
const TRACK_HEADER_WIDTH = 200;

/**
 * Canvas ベースのピアノロールエディタエンジン。
 *
 * グリッド描画・ノートの追加/移動（横で位置、縦で高さ）/リサイズ/削除・アクティブトラックとの
 * 双方向同期（`_saveToEngine` / `_loadFromEngine`）を担う。
 * ノートを置いたとき・高さを変えたとき・鍵盤を押したときは、その高さの音を短く鳴らす。
 * React コンポーネントから `pianoRollRef.current` 経由で操作する。
 *
 * 選択は複数持てる（ドラッグで囲む・Shift+クリック・Cmd+A）。選んだノートはまとめて動かし、
 * 矢印キーで動かし（←→ はグリッドの刻み、↑↓ は半音、Shift+↑↓ はオクターブ）、
 * コピー・切り取り・貼り付け・複製ができる。お手本（ghost）のノートは選べない。
 *
 * ノートを書き換える操作は、すべて `history`（ストアの `record` / `beginEdit`）で囲んで、
 * 元に戻せるようにする。ドラッグは押してから離すまでを 1 つの記録にする。
 *
 * 主なパブリック API:
 * - `init(el)` — DOM 要素群を渡して初期化する
 * - `switchToTrack(trackId)` — 表示するトラックを切り替える
 * - `getNotes()` — 現在のノート配列を返す（エンジンへも保存）
 * - `setNotes(notes, label?)` — ノートを一括セットして再描画する（元に戻せる）
 * - `reloadFromEngine()` — 元に戻したあと、トラックのノートを読み直す
 * - `getActiveTrackId()` — アクティブなトラック ID を返す
 * - `selectAll()` / `copySelection()` / `cutSelection()` / `paste()` / `duplicateSelection()`
 * - `zoomX(dir)` / `zoomY(dir)` — 表示の大きさを変える
 * - `clear()` — 全ノートを削除する
 */
// ---- PianoRoll クラス（Canvasベース）----
/** コピーしたノート（先頭のノートの位置を 0 にした並び）。トラックをまたいで貼り付けられる。 */
let noteClipboard = null;

/** 横の大きさの段階 (1 ステップの幅、px)。既定は 20。 */
const ZOOM_X_LEVELS = [5, 6, 8, 10, 12, 15, 20, 24, 30, 40, 50, 60];
/** 縦の大きさの段階 (1 行の高さ、px)。既定は 14。鍵盤の音名 (10px) が読める高さより下げない */
const ZOOM_Y_LEVELS = [10, 12, 14, 17, 20, 24];
/** ドラッグで囲み始めたとみなす動きの大きさ (px)。これより小さければ、ただのクリック */
const BAND_THRESHOLD = 3;

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
        this.activeTrackId = null; this.notes = [];
        // 選んでいるノート (this.notes の中のオブジェクト)。読み直したら空にする
        this.selection = new Set();
        // お手本として薄く重ねて見せるノート (編集はできない)。setGhostNotes で入れる
        this.ghostNotes = [];
        // ドラッグ中なら true (ほかの部品が「いまドラッグ中か」を見るのに使う)
        this.isDragging = false; this.isResizing = false;
        // ノートのドラッグ (動かす・長さを変える) と、囲んで選ぶドラッグの状態
        this._drag = null; this._band = null;
        // 試し聴きの音を止めるタイマー (キーは MIDI ノート番号) と、押している鍵盤
        this._auditionTimers = new Map(); this._heldKey = null;
        this.snapToGrid = true; this.gridSize = 4;
        this.totalRows = (this.octaveRange[1] - this.octaveRange[0]) * 12;
        this.onTrackSwitch = null;
        // ノートの数が変わったとき (CenterArea が渡す)
        this.onNotesChanged = null;
        // ステータスバーに出す (CenterArea が渡す)
        this.onStatus = null;
        // 表示の大きさが変わったとき (CenterArea が渡す。+/- のボタンの押せる・押せないに使う)
        this.onZoom = null;
        // 元に戻すための記録 (CenterArea がストアの record / beginEdit を渡す)。渡されるまでは記録しない
        this.history = { record: (_label, fn) => fn(), begin: () => () => false };
        // 縦の位置を自動で据えた行 (_centerOnRow)。利用者がスクロールしたら null に戻す
        this._anchorRow = null; this._anchorTop = 0;
        // 再生位置の線 (setPlayhead で動かす)
        this.playhead = null;
        // Cmd+ホイール / ピンチの量をためる (トラックパッドは 1 回の量が小さい)
        this._wheelAccum = 0;
        // 見えている範囲 (横のスクロール・表示の大きさ・長さ) が変わったときに知らせる先。
        // 練習画面の構成・コード・小節の段が、ピアノロールと横の位置をそろえるのに使う (onView)
        this._viewListeners = new Set();
        // ノートの中身が変わったときに知らせる先 (onNotesEdited)。練習画面が「比べた後に変えた」を知るのに使う
        this._notesListeners = new Set();
        // 差分の印 (setDiffMarks)。own[i] が notes[i]、ghost[i] が ghostNotes[i] の印。ノートを変えたら消す
        this.diffMarks = null;
        // 区間ループの範囲 (ステップ。setLoopRange)。グリッドに範囲を描く
        this.loopRange = null;
        // ノートを押したとき (練習画面が、そのノートの指摘を見せる)
        this.onNotePressed = null;
    }
    /**
     * 見えている範囲が変わったときに呼ばれる関数を足す。
     * @returns 外す関数
     */
    onView(fn) { this._viewListeners.add(fn); return () => this._viewListeners.delete(fn); }
    _emitView() { for (const fn of this._viewListeners) fn(this.viewState()); }
    /** 横の位置を出すのに要る値 (1 ステップの幅・横のスクロール・長さ・見えている幅・鍵盤の列の幅)。 */
    viewState() {
        return {
            stepWidth: this.stepWidth, scrollLeft: this.wrap ? this.wrap.scrollLeft : 0, totalSteps: this.totalSteps,
            clientWidth: this.wrap ? this.wrap.clientWidth : 0, keysWidth: this.keysDiv ? this.keysDiv.offsetWidth : 0,
        };
    }
    /**
     * ノートの中身が変わったときに呼ばれる関数を足す (書き戻したとき・元に戻したとき)。
     * @returns 外す関数
     */
    onNotesEdited(fn) { this._notesListeners.add(fn); return () => this._notesListeners.delete(fn); }
    _emitNotesEdited() { for (const fn of this._notesListeners) fn(); }
    /**
     * 差分の印を付ける (null で外す)。印はノートの並びの番号で持つので、ノートを変えると自動で外れる。
     * @param marks - `{ own, ghost, label }`。own[i] は notes[i] の印、ghost[i] は ghostNotes[i] の印 (lib/practice.ts の markNotes)。
     *   label(note, mark, isGhost) が読み上げの名前を返す
     */
    setDiffMarks(marks) { this.diffMarks = marks; this._renderNotes(); }
    /**
     * 区間ループの範囲を描く (null で消す)。
     * @param range - `{ start, end }` (ステップ。end は含まない)
     */
    setLoopRange(range) {
        const same = (range === null && this.loopRange === null)
            || (range && this.loopRange && range.start === this.loopRange.start && range.end === this.loopRange.end);
        if (same) return;
        this.loopRange = range ? { start: range.start, end: range.end } : null;
        if (this.canvas) this._drawGrid();
    }
    /**
     * ノートを選んで、短いあいだ光らせる (練習画面の指摘の一覧から)。お手本は選べないので光らせるだけ。
     * @param list - `{ own: notes の番号[], ghost: ghostNotes の番号[] }`
     */
    flashNotes(list) {
        const own = new Set(list.own || []), ghost = new Set(list.ghost || []);
        this.selection = new Set(this.notes.filter((_n, i) => own.has(i)));
        this._renderNotes();
        const els = [
            ...[...this.noteLayer.querySelectorAll('.note-block')].filter(el => own.has(Number(el.dataset.index))),
            ...[...this.noteLayer.querySelectorAll('.note-ghost')].filter(el => ghost.has(Number(el.dataset.index))),
        ];
        for (const el of els) el.classList.add('flash');
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => { for (const el of els) el.classList.remove('flash'); }, 1600);
    }
    /**
     * ピアノロールを DOM 要素群に紐付けて初期化する。
     * 鍵盤の構築・Canvas リサイズ・グリッド描画・イベント登録を行う。
     *
     * @param el - 初期化に必要な DOM 要素群
     * @param el.canvas - グリッド描画用 `<canvas>` 要素
     * @param el.noteLayer - ノートブロックを配置するオーバーレイ `<div>` 要素
     * @param el.keysDiv - 鍵盤キーを並べる `<div>` 要素
     * @param el.wrap - スクロール可能なラッパー `<div>` 要素（フォーカスを受けて、キーの操作を受ける）
     * @param el.area - ピアノロール全体 (`#piano-roll-area`)。この中にフォーカスがあれば、ピアノロールのショートカットを効かせる
     */
    init(el) {
        this.canvas = el.canvas; this.noteLayer = el.noteLayer;
        this.keysDiv = el.keysDiv; this.wrap = el.wrap; this.area = el.area || el.wrap;
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
            this._emitView();
        });
        if (typeof ResizeObserver !== 'undefined') {
            // 大きさの変更は次の描画のタイミングに回す (その場で canvas の大きさを変えると、
            // それがまた大きさの変化として通知されて、通知が循環する)
            this._resizeObserver = new ResizeObserver(() => {
                cancelAnimationFrame(this._resizeFrame);
                this._resizeFrame = requestAnimationFrame(() => {
                    this._resize(); this._drawGrid();
                    if (this._anchorRow != null) this._centerOnRow(this._anchorRow);
                    this._emitView();
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
        this._emitView();
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
        const changed = this.activeTrackId !== (trackId !== null ? Number(trackId) : null);
        this.activeTrackId = trackId !== null ? Number(trackId) : null;
        this.selection = new Set();
        if (changed) this.diffMarks = null;
        this._loadFromEngine(); this._fitLength(); this._renderNotes(); this._revealNotes();
        if (this.onTrackSwitch) this.onTrackSwitch(this.activeTrackId);
    }
    /**
     * 元に戻す・やり直すの後に、開いているトラックのノートを読み直す (手元の写しを書き戻さずに捨てる)。
     * 開いていたトラックが無くなっていたら、何も開いていない状態にする。
     */
    reloadFromEngine() {
        if (this.activeTrackId !== null && !engine.getTrack(this.activeTrackId)) {
            this.activeTrackId = null;
            if (this.onTrackSwitch) this.onTrackSwitch(null);
        }
        this.selection = new Set();
        const before = this.notes;
        this._loadFromEngine();
        if (!sameNotes(before, this.notes)) { this.diffMarks = null; this._emitNotesEdited(); }
        this._fitLength(); this._renderNotes();
    }
    /** ドラッグの途中か (このあいだは、元に戻す・やり直すをしない)。 */
    isBusy() { return this._drag !== null || this._band !== null; }
    _saveToEngine() {
        if (this.activeTrackId === null) return;
        const track = engine.getTrack(this.activeTrackId);
        if (!track) return;
        const before = track.pianoNotes || [];
        // 中身が同じなら書き換えない (元に戻すための控えが、同じ並びを共有できるように)
        if (sameNotes(before, this.notes)) return;
        track.pianoNotes = this.notes.map(n => ({ note: n.note, octave: n.octave, step: n.step, length: n.length }));
        // 差分の印は、比べたときのノートに付けたもの。中身が変わったら外す (古い色を出さない)
        if (this.diffMarks) { this.diffMarks = null; this._renderNotes(); }
        this._emitNotesEdited();
        // ノートの数が変わったら知らせる (トラックの見出しのノートの数、進み具合の「打ち込む」を描き直す)
        if (before.length !== track.pianoNotes.length && this.onNotesChanged) this.onNotesChanged();
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
                div.dataset.tip = `${name}${oct}。押すと、この高さの音が鳴ります`;
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
        // 区間ループ: 区間の外を暗くし、区間の端に金色の線を引く
        if (this.loopRange) {
            const x0 = this.loopRange.start * this.stepWidth - sx, x1 = this.loopRange.end * this.stepWidth - sx;
            const bottomY = Math.min(h, this.totalRows * this.noteHeight - sy);
            ctx.fillStyle = 'rgba(0,0,0,0.32)';
            if (x0 > 0) ctx.fillRect(0, 0, Math.min(w, x0), bottomY);
            if (x1 < w) ctx.fillRect(Math.max(0, x1), 0, w - Math.max(0, x1), bottomY);
            ctx.fillStyle = cssVar('--accent-dim', 'rgba(212,164,76,0.12)');
            ctx.fillRect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), 3);
        }
        // 横線 (音の高さ)。見えている行だけ
        const firstRow = Math.max(0, Math.floor(sy / this.noteHeight));
        const lastRow = Math.min(this.totalRows, Math.ceil((sy + h) / this.noteHeight));
        for (let row = firstRow; row < lastRow; row++) {
            const y = row * this.noteHeight - sy, noteIdx = row % 12;
            if (this.blackKeys.has(this.noteNames[noteIdx])) { ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(0, y, w, this.noteHeight); }
            ctx.strokeStyle = noteIdx === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        // 縦線 (ステップ・拍・小節)。見えているステップだけ。縮めて刻みが詰まったら、ステップの線は省く
        const firstStep = Math.max(0, Math.floor(sx / this.stepWidth));
        const lastStep = Math.min(this.totalSteps, Math.ceil((sx + w) / this.stepWidth));
        const bottom = Math.min(h, this.totalRows * this.noteHeight - sy);
        for (let step = firstStep; step <= lastStep; step++) {
            const x = step * this.stepWidth - sx, isBeat = step % 4 === 0, isBar = step % bar === 0;
            if (!isBeat && this.stepWidth < 8) continue;
            ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.25)' : isBeat ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)';
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke();
            if (this.loopRange && (step === this.loopRange.start || step === this.loopRange.end)) {
                ctx.strokeStyle = cssVar('--accent', '#d4a44c'); ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke();
                ctx.lineWidth = 1;
            }
            // 小節番号 (上の端に小さく)
            if (isBar && step < this.totalSteps) {
                ctx.fillStyle = cssVar('--text-dim', '#908c85'); ctx.font = '10px sans-serif';
                ctx.fillText(String(step / bar + 1), x + 3, 10);
            }
        }
    }
    /** ピアノロール (グリッド・鍵盤・見出しの操作) にフォーカスがあるか。 */
    _hasFocus() {
        const active = document.activeElement;
        return !!active && active !== document.body && !!this.area && this.area.contains(active);
    }
    /** ノートの層の中の、マウスの位置 (曲の中の px)。 */
    _layerPoint(e) {
        const rect = this.noteLayer.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    _bindEvents() {
        this.noteLayer.addEventListener('dblclick', (e) => {
            if (this.activeTrackId === null) return;
            if (e.target.classList.contains('note-block')) return;
            // ノートの層は中身と一緒にスクロールするので、層の左上からの距離がそのまま曲の中の位置になる
            const { x, y } = this._layerPoint(e);
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
            if (e.button !== 0 || this.activeTrackId === null) return;
            // キーの操作 (矢印・Cmd+C など) を受けられるよう、グリッドにフォーカスを移す
            this.wrap.focus({ preventScroll: true });
            if (e.target.classList.contains('note-block')) {
                e.preventDefault();
                const index = Number(e.target.dataset.index);
                this._startNoteDrag(e);
                // 差分の印が付いたノートを押したら、練習画面にその指摘を見せる
                if (this.onNotePressed) this.onNotePressed(index, this.diffMarks?.own?.[index] ?? null);
                return;
            }
            if (e.target !== this.noteLayer) return;
            // 何も無いところを押した: ドラッグで囲んで選ぶ。Shift を押していれば、いまの選択に足す
            e.preventDefault();
            const p = this._layerPoint(e);
            this._band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, base: e.shiftKey ? new Set(this.selection) : new Set(), started: false, el: null };
            if (!e.shiftKey && this.selection.size > 0) { this.selection = new Set(); this._refreshSelection(); }
        });
        document.addEventListener('mousemove', (e) => {
            if (this._drag) this._moveNoteDrag(e);
            else if (this._band) this._moveBand(e);
        });
        const endDrags = () => {
            this._releaseKey();
            if (this._drag) this._endNoteDrag();
            if (this._band) this._endBand();
        };
        document.addEventListener('mouseup', endDrags);
        // 押したまま別の窓へ移ると mouseup が届かないことがある。ドラッグの記録を開いたままにしない
        // (開いたままだと、その後の操作がすべてその記録にまとまってしまう)
        window.addEventListener('blur', endDrags);
        document.addEventListener('keydown', (e) => this._onKeyDown(e));
        // Cmd (Ctrl) + ホイール、トラックパッドのピンチで横の大きさを変える (マウスの位置を中心に)
        this.wrap.addEventListener('wheel', (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            this._wheelAccum += e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
            if (Math.abs(this._wheelAccum) < 40) return;
            const dir = this._wheelAccum < 0 ? 1 : -1;
            this._wheelAccum = 0;
            const rect = this.wrap.getBoundingClientRect();
            this.zoomX(dir, e.clientX - rect.left);
        }, { passive: false });
    }
    /** ノートを押した: 選んで、動かすか長さを変えるドラッグを始める。 */
    _startNoteDrag(e) {
        const idx = parseInt(e.target.dataset.index);
        const anchor = this.notes[idx];
        if (!anchor) return;
        // 押した場所 (右端か、それ以外か) は、選ぶ前に測る。選ぶとノートを描き直すので、
        // 押した要素は画面から外れて、大きさが 0 になる (以前はここで必ず「右端」と判定されて、
        // どこをつかんでも長さの変更になり、ノートを動かせなかった)
        const rect = e.target.getBoundingClientRect();
        const resize = e.clientX > rect.right - 10;
        const wasSelected = this.selection.has(anchor);
        if (e.shiftKey) {
            // Shift+クリックで、選択に足す・外す。外したノートはつかまない
            if (wasSelected) { this.selection.delete(anchor); this._refreshSelection(); return; }
            this.selection.add(anchor);
        } else if (!wasSelected) {
            this.selection = new Set([anchor]);
        }
        this._refreshSelection();
        const origins = new Map();
        for (const n of this.selection) origins.set(n, { step: n.step, length: n.length, row: this._noteToRow(n.note, n.octave) });
        this._drag = {
            mode: resize ? 'resize' : 'move', anchor, origins, startX: e.clientX, startY: e.clientY, moved: false, pitchMoved: false,
            // 選んでいる中の 1 つを、動かさずに押して離したら、そのノートだけを選び直す
            collapseTo: !e.shiftKey && wasSelected && this.selection.size > 1 ? anchor : null,
            commit: this.history.begin(resize ? 'ノートの長さを変更' : 'ノートを移動'),
        };
        this.isResizing = resize; this.isDragging = !resize;
    }
    _moveNoteDrag(e) {
        const d = this._drag;
        const dSteps = Math.round((e.clientX - d.startX) / this.stepWidth);
        let changed = false;
        if (d.mode === 'move') {
            // 位置: つかんだノートをグリッドに吸い付け、ほかのノートは同じだけずらす。0 より前には出さない
            const a = d.origins.get(d.anchor);
            let ns = a.step + dSteps;
            if (this.snapToGrid) ns = Math.round(ns / this.gridSize) * this.gridSize;
            let delta = ns - a.step;
            let minStep = Infinity, minRow = Infinity, maxRow = -Infinity;
            for (const o of d.origins.values()) { minStep = Math.min(minStep, o.step); minRow = Math.min(minRow, o.row); maxRow = Math.max(maxRow, o.row); }
            if (minStep + delta < 0) delta = -minStep;
            // 縦に動かすと、音の高さが変わる (1 行 = 半音)。音域の端で止める
            let dRows = Math.round((e.clientY - d.startY) / this.noteHeight);
            dRows = Math.max(-minRow, Math.min(this.totalRows - 1 - maxRow, dRows));
            const anchorBefore = `${d.anchor.note}${d.anchor.octave}`;
            for (const [n, o] of d.origins) {
                const next = this._rowToNote(o.row + dRows);
                const step = o.step + delta;
                if (n.step !== step || n.note !== next.note || n.octave !== next.octave) changed = true;
                n.step = step; n.note = next.note; n.octave = next.octave;
            }
            if (`${d.anchor.note}${d.anchor.octave}` !== anchorBefore) { d.pitchMoved = true; this._audition(d.anchor.note, d.anchor.octave); }
        } else {
            for (const [n, o] of d.origins) {
                let nl = o.length + dSteps;
                nl = this.snapToGrid ? Math.max(this.gridSize, Math.round(nl / this.gridSize) * this.gridSize) : Math.max(1, nl);
                if (n.length !== nl) changed = true;
                n.length = nl;
            }
        }
        if (changed) { d.moved = true; this._renderNotes(); }
    }
    _endNoteDrag() {
        const d = this._drag;
        this._drag = null; this.isDragging = false; this.isResizing = false;
        if (d.moved) {
            this._saveToEngine(); this._fitLength();
            const unchangedStep = [...d.origins].every(([n, o]) => n.step === o.step);
            d.commit({ label: d.mode === 'resize' ? 'ノートの長さを変更' : (d.pitchMoved && unchangedStep ? 'ノートの高さを変更' : 'ノートを移動') });
        } else {
            d.commit();
            if (d.collapseTo) { this.selection = new Set([d.collapseTo]); this._refreshSelection(); }
        }
    }
    _moveBand(e) {
        const b = this._band;
        const p = this._layerPoint(e);
        b.x1 = p.x; b.y1 = p.y;
        if (!b.started && Math.abs(b.x1 - b.x0) < BAND_THRESHOLD && Math.abs(b.y1 - b.y0) < BAND_THRESHOLD) return;
        b.started = true;
        const left = Math.min(b.x0, b.x1), right = Math.max(b.x0, b.x1);
        const top = Math.min(b.y0, b.y1), bottom = Math.max(b.y0, b.y1);
        if (!b.el) {
            // 囲みの枠は、ノートの層 (描き直すたびに中身を作り直す) の外に置く
            b.el = document.createElement('div');
            b.el.className = 'rubber-band'; b.el.setAttribute('aria-hidden', 'true');
            this.wrap.appendChild(b.el);
        }
        Object.assign(b.el.style, { left: left + 'px', top: top + 'px', width: (right - left) + 'px', height: (bottom - top) + 'px' });
        // 枠に少しでも掛かったノートを選ぶ (表示できる音域の外のノートは選ばない)
        const next = new Set(b.base);
        for (const n of this.notes) {
            const row = this._noteToRow(n.note, n.octave);
            if (row < 0 || row >= this.totalRows) continue;
            const x0 = n.step * this.stepWidth, x1 = (n.step + n.length) * this.stepWidth;
            const y0 = row * this.noteHeight, y1 = y0 + this.noteHeight;
            if (x1 > left && x0 < right && y1 > top && y0 < bottom) next.add(n);
        }
        this.selection = next;
        this._refreshSelection();
    }
    _endBand() {
        const b = this._band;
        this._band = null;
        if (b.el) b.el.remove();
        if (b.started && this.onStatus && this.selection.size > 0) this.onStatus(`${this.selection.size} ノートを選びました`);
    }
    /**
     * キーの操作。Delete / Backspace は、選んでいるノートがあればどこからでも消す (以前と同じ)。
     * それ以外 (矢印・Cmd+A/C/X/V/D・Esc) は、ピアノロールにフォーカスがあるときだけ受ける。
     * 文字を打ち込む欄に居るとき、案内などの窓が開いているときは、何もしない。
     */
    _onKeyDown(e) {
        // Backspace は、ブラウザによっては「前のページへ戻る」に割り当てられている (WebKit)。
        // 戻ると打ち込んだ内容が全部消えるので、文字を消す欄の外では戻らせない
        if (e.key === 'Backspace' && !isTextEntry(e.target)) e.preventDefault();
        if (isTypingTarget(e.target) || isDialogOpen()) return;
        const mod = hasPrimaryModifier(e);
        if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
            // タイムライン (クリップ・トラックの見出し) の上の Delete は、そちらの操作
            if (this.selection.size === 0 || (e.target instanceof Element && e.target.closest('#tracks-container'))) return;
            e.preventDefault();
            this.deleteSelection();
            return;
        }
        if (this.activeTrackId === null || !this._hasFocus()) return;
        const key = (e.key || '').toLowerCase();
        if (mod && !e.altKey) {
            if (key === 'a') { e.preventDefault(); this.selectAll(); }
            else if (key === 'c' && this.selection.size > 0) { e.preventDefault(); this.copySelection(); }
            else if (key === 'x' && this.selection.size > 0) { e.preventDefault(); this.cutSelection(); }
            else if (key === 'v' && noteClipboard) { e.preventDefault(); this.paste(); }
            else if (key === 'd' && this.selection.size > 0) { e.preventDefault(); this.duplicateSelection(); }
            return;
        }
        if (e.key === 'Escape' && this.selection.size > 0) { e.preventDefault(); this.selection = new Set(); this._refreshSelection(); return; }
        if (this.selection.size === 0 || e.altKey || mod) return;
        const moves = {
            ArrowLeft: [-this.gridSize, 0], ArrowRight: [this.gridSize, 0],
            ArrowUp: [0, e.shiftKey ? -12 : -1], ArrowDown: [0, e.shiftKey ? 12 : 1],
        };
        const move = moves[e.key];
        if (!move) return;
        e.preventDefault();
        this.nudgeSelection(move[0], move[1]);
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
    /**
     * ノートを 1 つ置く (元に戻せる)。ダブルクリックと、MIDI 入力から使う。
     * @param options.label - 記録の名前 (省略時は「ノートを追加」)
     * @param options.coalesceKey - 続けて置いたノートを 1 つの記録にまとめる鍵 (リアルタイム録音)
     * @param options.coalesceMs - まとめる間隔の上限 (ミリ秒)
     */
    _addNote(note, octave, step, length, options = {}) {
        const { label = 'ノートを追加', ...push } = options;
        this.history.record(label, () => {
            this.notes.push({ note, octave, step, length });
            this._saveToEngine();
        }, push);
        this._fitLength(); this._renderNotes();
    }
    /** 選んでいるノートを消す (元に戻せる)。 */
    deleteSelection() {
        const count = this.selection.size;
        if (count === 0) return;
        this.history.record(count > 1 ? `${count} ノートを削除` : 'ノートを削除', () => {
            this.notes = this.notes.filter(n => !this.selection.has(n));
            this.selection = new Set();
            this._saveToEngine();
        });
        this._fitLength(); this._renderNotes();
    }
    /** 開いているトラックのノートを全部選ぶ (表示できる音域の外のノートは除く)。 */
    selectAll() {
        this.selection = new Set(this.notes.filter(n => { const r = this._noteToRow(n.note, n.octave); return r >= 0 && r < this.totalRows; }));
        this._refreshSelection();
        if (this.onStatus) this.onStatus(`${this.selection.size} ノートを選びました`);
    }
    /** 選んでいるノートを、先頭の位置を 0 にした並びにする。 */
    _selectionAsClip() {
        const list = [...this.selection].sort((a, b) => a.step - b.step);
        const base = list[0].step;
        return {
            notes: list.map(n => ({ note: n.note, octave: n.octave, step: n.step - base, length: n.length })),
            span: Math.max(...list.map(n => n.step + n.length)) - base,
        };
    }
    /** 選んでいるノートをコピーする (アプリの中だけ。トラックをまたいで貼り付けられる)。 */
    copySelection() {
        if (this.selection.size === 0) return;
        noteClipboard = this._selectionAsClip();
        if (this.onStatus) this.onStatus(`${noteClipboard.notes.length} ノートをコピーしました`);
    }
    /** 選んでいるノートを切り取る (コピーしてから消す。元に戻せる)。 */
    cutSelection() {
        if (this.selection.size === 0) return;
        noteClipboard = this._selectionAsClip();
        const count = this.selection.size;
        this.history.record(`${count} ノートを切り取り`, () => {
            this.notes = this.notes.filter(n => !this.selection.has(n));
            this.selection = new Set();
            this._saveToEngine();
        });
        this._fitLength(); this._renderNotes();
        if (this.onStatus) this.onStatus(`${count} ノートを切り取りました`);
    }
    /**
     * ノートの並びを、指定した位置から置いて選ぶ (元に戻せる)。
     * @returns 置いたノートの数
     */
    _placeClip(clip, at, label) {
        const start = Math.max(0, Math.min(this.maxSteps - clip.span, at));
        const placed = clip.notes.map(n => ({ note: n.note, octave: n.octave, step: start + n.step, length: n.length }));
        this.history.record(label, () => {
            this.notes = this.notes.concat(placed);
            this._saveToEngine();
        });
        this.selection = new Set(placed);
        this._fitLength(); this._renderNotes();
        this.scrollToStep(start);
        return placed.length;
    }
    /** コピーしたノートを、再生位置 (グリッドの刻みに切り下げる) に貼り付ける。1 小節目より前なら、1 小節目の頭に。 */
    paste() {
        if (!noteClipboard || this.activeTrackId === null) return;
        const sec = engine.getCurrentTime();
        let at = Math.max(0, Math.floor(secToStep(sec, engine.grid)));
        if (this.snapToGrid) at = Math.floor(at / this.gridSize) * this.gridSize;
        const count = this._placeClip(noteClipboard, at, `${noteClipboard.notes.length} ノートを貼り付け`);
        if (this.onStatus) this.onStatus(`${count} ノートを貼り付けました（再生位置から）`);
    }
    /** 選んでいるノートを、すぐ後ろ (グリッドの刻みに切り上げた長さの先) に複製する。 */
    duplicateSelection() {
        if (this.selection.size === 0) return;
        const clip = this._selectionAsClip();
        const base = Math.min(...[...this.selection].map(n => n.step));
        const span = this.snapToGrid ? Math.max(this.gridSize, Math.ceil(clip.span / this.gridSize) * this.gridSize) : clip.span;
        const count = this._placeClip(clip, base + span, `${clip.notes.length} ノートを複製`);
        if (this.onStatus) this.onStatus(`${count} ノートを複製しました`);
    }
    /**
     * 選んでいるノートをずらす (元に戻せる。続けて押したぶんは 1 つの記録にまとめる)。
     * どれか 1 つでも、0 より前か音域の外に出るなら動かさない (形を崩さない)。
     * @param dSteps - 横のずれ (ステップ)
     * @param dRows - 縦のずれ (行。負が上 = 高い音)
     */
    nudgeSelection(dSteps, dRows) {
        const list = [...this.selection];
        const fits = list.every(n => {
            const row = this._noteToRow(n.note, n.octave) + dRows;
            return n.step + dSteps >= 0 && n.step + n.length + dSteps <= this.maxSteps && row >= 0 && row < this.totalRows;
        });
        if (!fits || list.length === 0) return;
        this.history.record(dRows !== 0 ? 'ノートの高さを変更' : 'ノートを移動', () => {
            for (const n of list) {
                const next = this._rowToNote(this._noteToRow(n.note, n.octave) + dRows);
                n.step += dSteps; n.note = next.note; n.octave = next.octave;
            }
            this._saveToEngine();
        }, { coalesceKey: dRows !== 0 ? 'nudge-pitch' : 'nudge-step' });
        // 高さを変えたら、いちばん高いノートの音を鳴らして確かめられるようにする
        if (dRows !== 0) {
            const top = list.reduce((a, b) => (this._noteToRow(a.note, a.octave) <= this._noteToRow(b.note, b.octave) ? a : b));
            this._audition(top.note, top.octave);
        }
        this._fitLength(); this._renderNotes();
    }
    /** 選択の縁取りだけを描き直す (ノートを作り直さない。囲んで選ぶあいだは毎回呼ぶので軽くする)。 */
    _refreshSelection() {
        if (!this.noteLayer) return;
        for (const el of this.noteLayer.querySelectorAll('.note-block')) {
            el.classList.toggle('selected', this.selection.has(this.notes[Number(el.dataset.index)]));
        }
    }
    _renderNotes() {
        if (!this.noteLayer) return; this.noteLayer.innerHTML = '';
        if (this.activeTrackId === null) {
            const msg = document.createElement('div');
            msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text-dim);font-size:13px;pointer-events:none;';
            msg.textContent = 'トラック名をクリックすると、ここにピアノロールが開きます';
            this.noteLayer.appendChild(msg); return;
        }
        const marks = this.diffMarks;
        // 印の数がノートの数と合わないときは使わない (お手本を入れ替えた直後など)
        const ghostMarks = marks && marks.ghost && marks.ghost.length === this.ghostNotes.length ? marks.ghost : null;
        const ownMarks = marks && marks.own && marks.own.length === this.notes.length ? marks.own : null;
        // お手本は先に置く (打ち込んだノートの下に見える)。押しても反応せず、選べない
        this.ghostNotes.forEach((n, i) => {
            const row = this._noteToRow(n.note, n.octave);
            if (row < 0 || row >= this.totalRows) return;
            const el = document.createElement('div');
            el.className = 'note-ghost';
            el.dataset.index = String(i);
            el.style.left = (n.step * this.stepWidth) + 'px'; el.style.top = (row * this.noteHeight) + 'px';
            el.style.width = (n.length * this.stepWidth - 1) + 'px'; el.style.height = (this.noteHeight - 1) + 'px';
            el.dataset.tip = `お手本 ${n.note}${n.octave}`;
            const mark = ghostMarks?.[i];
            if (mark) {
                el.classList.add(`ghost-${mark.kind}`);
                const label = marks.label ? marks.label(n, mark, true) : el.dataset.tip;
                el.dataset.tip = label; el.setAttribute('role', 'img'); el.setAttribute('aria-label', label);
            }
            this.noteLayer.appendChild(el);
        });
        // 表示できる音域の外のノートは描かず (データは残す)、在ることだけ知らせる
        let outOfRange = 0;
        this.notes.forEach((n, i) => {
            const row = this._noteToRow(n.note, n.octave);
            if (row < 0 || row >= this.totalRows) { outOfRange += 1; return; }
            const el = document.createElement('div');
            el.className = 'note-block' + (this.selection.has(n) ? ' selected' : '');
            el.style.left = (n.step * this.stepWidth) + 'px'; el.style.top = (row * this.noteHeight) + 'px';
            el.style.width = (n.length * this.stepWidth - 1) + 'px'; el.style.height = (this.noteHeight - 1) + 'px';
            el.dataset.index = i;
            // data-note は機械が読む形 (テストが音の高さと位置を読む)。説明 (data-tip) は人が読む形
            el.dataset.note = `${n.note}${n.octave} step:${n.step} len:${n.length}`;
            el.dataset.tip = `${n.note}${n.octave}（${cursorLabel(n.step, engine.beatsPerBar || 4)}）`;
            const mark = ownMarks?.[i];
            if (mark) {
                el.classList.add(`diff-${mark.kind}`);
                // 位置のずれは、ずれの向きも印で見せる (遅い ›、早い ‹)
                const timing = mark.issues.find(x => x.kind === 'timing');
                if (timing) el.dataset.shift = (timing.offset_steps ?? 0) > 0 ? 'late' : 'early';
                const label = marks.label ? marks.label(n, mark, false) : el.dataset.tip;
                el.dataset.tip = label; el.setAttribute('role', 'img'); el.setAttribute('aria-label', label);
            }
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
     * ノートを一括セットしてピアノロールを再描画する (元に戻せる)。
     * 音声解析結果（`/api/analyze`）の配置などに使用する。
     *
     * @param notes - セットするノート情報の配列（`note`, `octave`, `step`, `length` を含む）
     * @param label - 記録の名前 (省略時は「ノートを置き換え」)
     */
    setNotes(notes, label = 'ノートを置き換え') {
        this.history.record(label, () => {
            this.notes = notes.map(n => ({ ...n })); this.selection = new Set(); this._saveToEngine();
        });
        this._fitLength(); this._renderNotes(); this._revealNotes();
    }
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
    /** いまの表示の大きさと、まだ大きく・小さくできるか。 */
    zoomState() {
        return {
            stepWidth: this.stepWidth, noteHeight: this.noteHeight,
            canZoomInX: this.stepWidth < ZOOM_X_LEVELS[ZOOM_X_LEVELS.length - 1], canZoomOutX: this.stepWidth > ZOOM_X_LEVELS[0],
            canZoomInY: this.noteHeight < ZOOM_Y_LEVELS[ZOOM_Y_LEVELS.length - 1], canZoomOutY: this.noteHeight > ZOOM_Y_LEVELS[0],
        };
    }
    /**
     * 表示の大きさを変える。`anchor` の位置 (見えている範囲の中の px) に見えているものが、同じ場所に残るようにスクロールする。
     * ノート・お手本・グリッド・再生位置の線は、どれも同じ `stepWidth` / `noteHeight` から位置を出すので、ずれない。
     */
    setZoom(stepWidth, noteHeight, anchor = {}) {
        if (!this.wrap || (stepWidth === this.stepWidth && noteHeight === this.noteHeight)) return;
        const ax = anchor.x ?? this.wrap.clientWidth / 2, ay = anchor.y ?? this.wrap.clientHeight / 2;
        const stepAt = (this.wrap.scrollLeft + ax) / this.stepWidth;
        const rowAt = (this.wrap.scrollTop + ay) / this.noteHeight;
        const rows = noteHeight !== this.noteHeight;
        this.stepWidth = stepWidth; this.noteHeight = noteHeight;
        if (rows) this._buildKeys();
        this._resize();
        this.wrap.scrollLeft = Math.max(0, stepAt * stepWidth - ax);
        this.wrap.scrollTop = Math.max(0, rowAt * noteHeight - ay);
        this.keysDiv.scrollTop = this.wrap.scrollTop;
        this._anchorRow = null;
        this._drawGrid(); this._renderNotes(); this.setPlayhead(engine.getCurrentTime());
        if (this.onZoom) this.onZoom(this.zoomState());
        this._emitView();
    }
    /** 次の段階の大きさ (dir: 1 で大きく、-1 で小さく)。 */
    _nextLevel(levels, current, dir) {
        if (dir > 0) return levels.find(v => v > current) ?? levels[levels.length - 1];
        return [...levels].reverse().find(v => v < current) ?? levels[0];
    }
    /**
     * 横の大きさを 1 段階変える。
     * @param anchorX - 中心にする位置 (見えている範囲の左からの px)。省略時は真ん中。ただし曲の頭を見ているときは
     *   左端にする (広げたときに 1 小節目が左へ逃げないように)
     */
    zoomX(dir, anchorX) {
        const x = anchorX ?? (this.wrap && this.wrap.scrollLeft === 0 ? 0 : undefined);
        this.setZoom(this._nextLevel(ZOOM_X_LEVELS, this.stepWidth, dir), this.noteHeight, { x });
    }
    /** 縦の大きさを 1 段階変える。 */
    zoomY(dir) { this.setZoom(this.stepWidth, this._nextLevel(ZOOM_Y_LEVELS, this.noteHeight, dir)); }
    /**
     * 現在アクティブなトラックの ID を返す。
     *
     * @returns アクティブなトラック ID（数値）、未選択時は `null`
     */
    getActiveTrackId() { return this.activeTrackId; }
    /**
     * 全ノートを削除してピアノロールをクリアする (元に戻せる)。
     * エンジン側のピアノノートも同時に空にする。
     */
    clear() {
        this.history.record('ノートを全部削除', () => { this.notes = []; this.selection = new Set(); this._saveToEngine(); });
        this._fitLength(); this._renderNotes();
    }
}

/**
 * Canvas ベースのタイムライン（アレンジメントビュー）エンジン。
 *
 * 全トラックとそのクリップを DOM として描画し、以下の操作を提供する:
 * - クリップのドラッグ移動（拍グリッドにスナップ）
 * - クリップの右クリック（とキーボードのメニューキー）でメニュー（複製・削除）
 * - WAV ファイルのドラッグ＆ドロップによるインポート
 * - トラックヘッダーのクリックによるピアノロール切り替え
 * - ミュート / ソロ / トラック単体再生 / 音量とパンのつまみ / メニュー（名前の変更・並びの変更・削除）
 *   (M・S は 1 文字のボタンなので、何のボタンかを aria-label と title で伝える)
 *
 * トラックとクリップを書き換える操作は、すべて `history`（ストアの `record` / `beginEdit`）で囲んで、
 * 元に戻せるようにする。消す操作は確かめの窓を出さず、「元に戻す」付きの知らせ（`onUndoToast`）を出す。
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
        this.headerWidth = TRACK_HEADER_WIDTH;
        // 再生位置の線 (setPlayhead で動かす)
        this.playhead = null;
        // 「このパートを練習する」を押したとき (CenterArea が渡す)
        this.onPractice = null;
        // 練習のトラックの「練習画面」を押したとき (CenterArea が渡す)
        this.onOpenPractice = null;
        // メニューを開くとき (CenterArea が PopupMenu で出す)
        this.onMenu = null;
        // 消したときの「元に戻す」付きの知らせ (CenterArea がストアの showUndoToast を渡す)
        this.onUndoToast = null;
        // 元に戻すための記録 (CenterArea がストアの record / beginEdit を渡す)。渡されるまでは記録しない
        this.history = { record: (_label, fn) => fn(), begin: () => () => false };
        // 名前を変えている途中のトラック ID
        this.renamingId = null;
        // 練習画面の区間ループ (秒)。小節番号の段に帯で描く (setLoopRange)
        this.loopRange = null;
    }
    /**
     * 練習画面の区間を、小節番号の段に描く (null で消す)。
     * @param range - `{ start, end }` (秒)
     */
    setLoopRange(range) {
        this.loopRange = range ? { start: range.start, end: range.end } : null;
        this._drawHeader();
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
        // 練習画面の区間 (区間ループ)。上の端に金色の帯を引く (下の端は拍の目盛りなので空ける)
        if (this.loopRange) {
            const x0 = Math.max(left, left + this.loopRange.start * this.pixelsPerSecond - scrollLeft);
            const x1 = Math.min(w, left + this.loopRange.end * this.pixelsPerSecond - scrollLeft);
            if (x1 > x0) { ctx.fillStyle = cssVar('--accent', '#d4a44c'); ctx.fillRect(x0, 0, x1 - x0, 3); }
        }
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
        engine.tracks.forEach((track) => {
            const row = document.createElement('div'); row.className = 'track-row';
            const isActive = pianoRoll && pianoRoll.getActiveTrackId() === track.id;
            const noteCount = (track.pianoNotes || []).length;
            const header = document.createElement('div');
            header.className = 'track-header' + (isActive ? ' active-track' : '');
            header.dataset.trackId = track.id;
            // 見出しの中の説明は、見出しの外 (右、クリップの側) に出す。隣のボタンを隠さないため
            header.dataset.tipSide = 'right';
            header.dataset.tipBox = '';
            const isTrackPlaying = engine.isPlaying && engine.soloTrackId === track.id;
            // 1 行目: 名前・「練習する」・メニュー (…)。2 行目: ▶ M S とパン。3 行目: 音量。
            // トラックを消す操作はメニューの中に置く (S のすぐ隣に ✕ が在ると、押し間違えて消してしまう)
            header.innerHTML = `<div class="track-head-row">
                    <span class="track-name"></span>
                    <button type="button" class="btn-track-menu" data-track="${track.id}" aria-haspopup="menu">…</button>
                </div>
                <div class="track-controls">
                    <button type="button" class="btn-track-play ${isTrackPlaying ? 'playing' : ''}" data-track="${track.id}">${isTrackPlaying ? '⏸' : '▶'}</button>
                    <button type="button" class="btn-mute ${track.mute ? 'muted' : ''}" data-track="${track.id}" aria-pressed="${track.mute ? 'true' : 'false'}">M</button>
                    <button type="button" class="btn-solo ${track.solo ? 'soloed' : ''}" data-track="${track.id}" aria-pressed="${track.solo ? 'true' : 'false'}">S</button>
                    <span class="track-pan">
                        <input type="range" class="pan-slider" data-track="${track.id}" min="-${PAN_STEPS}" max="${PAN_STEPS}" step="1">
                        <span class="mix-readout pan-readout" aria-hidden="true"></span>
                    </span>
                </div>
                <div class="track-mix">
                    <input type="range" class="gain-slider" data-track="${track.id}" min="${GAIN_MIN_DB}" max="${GAIN_MAX_DB}" step="${GAIN_STEP_DB}">
                    <span class="mix-readout gain-readout" aria-hidden="true"></span>
                </div>`;
            // 1 文字のボタンが何をするかを、読み上げ (aria-label) とマウスを載せたときの説明 (data-tip、ツールチップ) で伝える。
            // トラック名を含むので、HTML に埋め込まず属性として入れる
            const describe = (selector, label, tipText) => {
                const el = header.querySelector(selector);
                el.setAttribute('aria-label', label); el.dataset.tip = tipText;
            };
            describe('.btn-track-play', isTrackPlaying ? `「${track.name}」の再生を一時停止` : `「${track.name}」だけを再生`,
                isTrackPlaying ? '一時停止します' : 'このトラックだけを、いまの位置から鳴らします');
            describe('.btn-mute', `「${track.name}」をミュート`,
                track.mute ? 'ミュート中です。押すと、また鳴るようになります' : 'このトラックの音を消します（ミュート）');
            describe('.btn-solo', `「${track.name}」をソロ`,
                track.solo ? 'ソロ中です。押すと、ほかのトラックも鳴るように戻ります' : '再生したとき、このトラックだけが聞こえるようにします（ソロ）');
            describe('.btn-track-menu', `「${track.name}」のメニュー`, '名前の変更、並べ替え、削除');
            describe('.gain-slider', `「${track.name}」の音量`, 'このトラックの音量。ダブルクリックで 0 dB に戻ります');
            describe('.pan-slider', `「${track.name}」のパン`, '音を左右のどちらから鳴らすか。ダブルクリックで中央に戻ります');
            this._showMix(header, track);
            // トラック名は文字として入れる。HTML に埋め込むと、名前に < や & が在るときに崩れ、
            // 読み込んだプロジェクトの名前がタグとして解釈されてしまう
            const nameEl = header.querySelector('.track-name');
            if (this.renamingId === track.id) {
                // 名前の変更中: 名前の代わりに入力欄を出す (Enter で決める、Esc でやめる)
                const input = document.createElement('input');
                input.type = 'text'; input.className = 'track-name-input'; input.value = track.name; input.maxLength = 60;
                input.setAttribute('aria-label', `「${track.name}」の新しい名前`);
                let finished = false;
                const finish = (save) => {
                    if (finished) return; finished = true;
                    this.renamingId = null;
                    this.renameTrack(track.id, save ? input.value : null);
                };
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); finish(true); this.container.querySelector(`.btn-track-menu[data-track="${track.id}"]`)?.focus(); }
                    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); this.container.querySelector(`.btn-track-menu[data-track="${track.id}"]`)?.focus(); }
                });
                input.addEventListener('blur', () => finish(true));
                nameEl.replaceWith(input);
            } else {
                nameEl.textContent = track.name + ' ';
                nameEl.dataset.tip = `${track.name}\nクリックすると、このトラックのノートをピアノロールで開きます`;
                if (noteCount > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'notes-badge'; badge.dataset.tip = `ノートが ${noteCount} 個あります`; badge.textContent = String(noteCount);
                    nameEl.appendChild(badge);
                }
            }
            // パートのトラック (お手本を持つもの) には、「このパートを練習する」を出す
            if (track.role === 'part' && track.referenceNotes && track.referenceNotes.length > 0 && this.onPractice) {
                const practice = document.createElement('button');
                practice.type = 'button'; practice.className = 'btn-practice'; practice.dataset.track = track.id;
                practice.textContent = '練習する';
                practice.setAttribute('aria-label', `「${track.name}」を練習する`);
                practice.dataset.tip = 'お手本を薄く重ねたピアノロールを開いて、このパートを練習します';
                practice.addEventListener('click', (e) => { e.stopPropagation(); this.onPractice(track.id); });
                header.querySelector('.btn-track-menu').before(practice);
            } else if (track.role === 'practice') {
                header.classList.add('practice-track');
                // 練習のトラックには、練習画面を開くボタンを出す
                if (this.onOpenPractice && track.practiceOf !== undefined && engine.getTrack(track.practiceOf)) {
                    const open = document.createElement('button');
                    open.type = 'button'; open.className = 'btn-practice'; open.dataset.track = track.id;
                    open.textContent = '練習画面';
                    open.setAttribute('aria-label', `「${track.name}」を練習画面で開く`);
                    open.dataset.tip = '練習画面を開きます。区間をくり返したり、速度を落としたり、お手本と比べたりできます';
                    open.addEventListener('click', (e) => { e.stopPropagation(); this.onOpenPractice(track.id); });
                    header.querySelector('.btn-track-menu').before(open);
                }
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
                clipEl.dataset.tip = `${clip.name}（${clip.offset.toFixed(1)} 秒から、長さ ${clip.duration.toFixed(1)} 秒）\nドラッグで移動、右クリックで複製・削除`;
                // キーボードでも選べる。Delete で削除、Shift+F10 かメニューキーでメニュー
                clipEl.tabIndex = 0;
                clipEl.setAttribute('role', 'button');
                clipEl.setAttribute('aria-haspopup', 'menu');
                clipEl.setAttribute('aria-label', `クリップ「${clip.name}」（「${track.name}」、${clip.offset.toFixed(1)} 秒から）`);
                clipEl.addEventListener('mousedown', (e) => {
                    // 右クリックは動かさない (メニューを出す)
                    if (e.button !== 0) return;
                    e.preventDefault();
                    this.draggingClip = { trackId: track.id, clipIndex: ci, element: clipEl };
                    this.dragOffsetX = e.clientX - clipEl.getBoundingClientRect().left;
                });
                // 右クリックは、その場で消さずにメニューを出す
                clipEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.openClipMenu(track.id, ci, e.clientX, e.clientY);
                });
                clipEl.addEventListener('keydown', (e) => {
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || e.key === 'Enter') {
                        e.preventDefault();
                        const rect = clipEl.getBoundingClientRect();
                        this.openClipMenu(track.id, ci, rect.left + 8, rect.bottom + 2);
                    } else if (e.key === 'Delete' || e.key === 'Backspace') {
                        e.preventDefault(); e.stopPropagation();
                        this.deleteClip(track.id, ci);
                    }
                });
                canvasWrap.appendChild(clipEl);
            });
            canvasWrap.addEventListener('dragover', (e) => e.preventDefault());
            canvasWrap.addEventListener('drop', async (e) => {
                e.preventDefault();
                // 位置は、読み込みを待つ前に取っておく (待っているあいだに描き直されると、要素が入れ替わる)
                const dropSec = Math.max(0, (e.clientX - canvasWrap.getBoundingClientRect().left) / this.pixelsPerSecond);
                const added = [], rejected = [], failed = [];
                // 落としたファイルをまとめて 1 つの記録にする (元に戻すと、まとめて外れる)
                const commit = this.history.begin('クリップを追加');
                try {
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
                } finally {
                    commit();
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
        });
        this._bindTrackEvents(pianoRoll);
        // 名前の変更中なら、入力欄にフォーカスを移して全体を選ぶ
        const renaming = this.container.querySelector('.track-name-input');
        if (renaming) { renaming.focus(); renaming.select(); }
    }
    /** 音量とパンのつまみに、トラックの値を出す (つまみの位置・横の数字・読み上げの文)。 */
    _showMix(header, track) {
        const gain = header.querySelector('.gain-slider'), pan = header.querySelector('.pan-slider');
        if (gain && document.activeElement !== gain) gain.value = String(clampGainDb(track.gain));
        if (pan && document.activeElement !== pan) pan.value = String(Math.round(clampPan(track.pan) * PAN_STEPS));
        const gainText = formatGainDb(track.gain), panText = formatPan(track.pan);
        gain?.setAttribute('aria-valuetext', gainText);
        pan?.setAttribute('aria-valuetext', panText);
        const gainOut = header.querySelector('.gain-readout'), panOut = header.querySelector('.pan-readout');
        if (gainOut) gainOut.textContent = gainText;
        if (panOut) panOut.textContent = panText;
    }
    _bindTrackEvents(pianoRoll) {
        this.container.querySelectorAll('.track-header').forEach(h => {
            h.addEventListener('click', (e) => {
                // ボタン・つまみ・名前の入力欄を押したときは、ピアノロールを開かない
                // (開くとトラックの行が描き直されて、つまみのドラッグが途切れる)
                if (e.target.closest('button, input, .track-mix, .track-pan')) return;
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
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track), track = engine.getTrack(id);
                if (!track) return;
                this.history.record(track.mute ? `「${track.name}」のミュートを解除` : `「${track.name}」をミュート`, () => engine.toggleMute(id));
                this._renderKeepingFocus(pianoRoll, '.btn-mute', id);
            });
        });
        this.container.querySelectorAll('.btn-solo').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track), track = engine.getTrack(id);
                if (!track) return;
                this.history.record(track.solo ? `「${track.name}」のソロを解除` : `「${track.name}」をソロ`, () => { track.solo = !track.solo; });
                this._renderKeepingFocus(pianoRoll, '.btn-solo', id);
            });
        });
        this.container.querySelectorAll('.btn-track-menu').forEach(btn => {
            btn.addEventListener('click', () => {
                const rect = btn.getBoundingClientRect();
                this.openTrackMenu(parseInt(btn.dataset.track), rect.left, rect.bottom + 2);
            });
        });
        // 音量とパン。動かしているあいだは 1 つの記録にまとめる (元に戻すと、動かす前の値に戻る)。
        // 行は描き直さない (描き直すと、つまみのドラッグが途切れる)
        const bindSlider = (selector, read, apply, labelOf, key) => {
            this.container.querySelectorAll(selector).forEach(input => {
                const id = parseInt(input.dataset.track);
                const set = (value) => {
                    const track = engine.getTrack(id);
                    if (!track) return;
                    this.history.record(labelOf(track), () => apply(id, value), { coalesceKey: `${key}:${id}`, coalesceMs: 1500 });
                    this._showMix(input.closest('.track-header'), track);
                };
                input.addEventListener('input', () => set(read(input)));
                // ダブルクリックで、既定の値 (0 dB・中央) に戻す
                input.addEventListener('dblclick', () => { input.value = '0'; set(0); });
            });
        };
        bindSlider('.gain-slider', (el) => Number(el.value), (id, v) => engine.updateTrackGain(id, v), (t) => `「${t.name}」の音量を変更`, 'gain');
        bindSlider('.pan-slider', (el) => Number(el.value) / PAN_STEPS, (id, v) => engine.updateTrackPan(id, v), (t) => `「${t.name}」のパンを変更`, 'pan');
    }
    /**
     * トラックのメニュー (名前の変更・上へ・下へ・削除) を開く。
     * @param trackId - トラック ID
     * @param x - 左上の位置 (画面の座標)
     * @param y - 左上の位置 (画面の座標)
     */
    openTrackMenu(trackId, x, y) {
        const track = engine.getTrack(trackId);
        if (!track || !this.onMenu) return;
        const index = engine.tracks.indexOf(track);
        this.onMenu({
            label: `「${track.name}」のメニュー`, x, y,
            returnFocus: () => this.container.querySelector(`.btn-track-menu[data-track="${trackId}"]`),
            items: [
                ...(track.role === 'practice' && this.onOpenPractice && track.practiceOf !== undefined && engine.getTrack(track.practiceOf)
                    ? [{ label: '練習画面で開く', action: () => this.onOpenPractice(trackId), restoreFocus: false }] : []),
                ...(track.role === 'part' && track.referenceNotes?.length && this.onPractice
                    ? [{ label: 'このパートを練習する', action: () => this.onPractice(trackId), restoreFocus: false }] : []),
                { label: '名前を変更', action: () => this.startRename(trackId), restoreFocus: false },
                { label: '上へ移動', action: () => this.moveTrack(trackId, -1), disabled: index === 0, title: index === 0 ? 'いちばん上のトラックです' : undefined },
                { label: '下へ移動', action: () => this.moveTrack(trackId, 1), disabled: index === engine.tracks.length - 1, title: index === engine.tracks.length - 1 ? 'いちばん下のトラックです' : undefined },
                { label: 'トラックを削除', action: () => this.deleteTrack(trackId), danger: true, title: '削除した後も、「元に戻す」で戻せます' },
            ],
        });
    }
    /**
     * クリップのメニュー (複製・削除) を開く。
     * @param trackId - トラック ID
     * @param clipIndex - クリップの番号
     * @param x - 左上の位置 (画面の座標)
     * @param y - 左上の位置 (画面の座標)
     */
    openClipMenu(trackId, clipIndex, x, y) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip || !this.onMenu) return;
        this.onMenu({
            label: `クリップ「${clip.name}」のメニュー`, x, y,
            returnFocus: () => this.container.querySelector(`.clip[data-track-id="${trackId}"][data-clip-index="${clipIndex}"]`),
            items: [
                { label: '複製', action: () => this.duplicateClip(trackId, clipIndex), title: 'すぐ後ろに同じクリップを置きます' },
                { label: '削除', action: () => this.deleteClip(trackId, clipIndex), danger: true, title: '削除した後も、「元に戻す」で戻せます' },
            ],
        });
    }
    /** トラックを消す (元に戻せる)。確かめの窓は出さず、「元に戻す」付きの知らせを出す。 */
    deleteTrack(trackId) {
        const track = engine.getTrack(trackId), pianoRoll = this._pianoRoll;
        if (!track) return;
        this.history.record(`「${track.name}」を削除`, () => {
            if (pianoRoll && pianoRoll.getActiveTrackId() === trackId) pianoRoll.switchToTrack(null);
            engine.removeTrack(trackId);
        });
        this.render(pianoRoll);
        if (this.onTracksChanged) this.onTracksChanged();
        if (this.onStatus) this.onStatus(`「${track.name}」を削除しました`);
        if (this.onUndoToast) this.onUndoToast(`「${track.name}」を削除しました`);
    }
    /** クリップを消す (元に戻せる)。確かめの窓は出さず、「元に戻す」付きの知らせを出す。 */
    deleteClip(trackId, clipIndex) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip) return;
        this.history.record(`クリップ「${clip.name}」を削除`, () => engine.removeClip(trackId, clipIndex));
        this.render(this._pianoRoll);
        const message = `クリップ「${clip.name}」を「${track.name}」から削除しました`;
        if (this.onStatus) this.onStatus(message);
        if (this.onUndoToast) this.onUndoToast(message);
        if (this.onTracksChanged) this.onTracksChanged();
    }
    /** クリップを複製して、すぐ後ろに置く (同じ音声を指す。元に戻せる)。 */
    duplicateClip(trackId, clipIndex) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip) return;
        this.history.record(`クリップ「${clip.name}」を複製`, () => {
            track.clips.splice(clipIndex + 1, 0, { ...clip, offset: clip.offset + clip.duration });
        });
        this.render(this._pianoRoll);
        if (this.onStatus) this.onStatus(`クリップ「${clip.name}」を複製しました（${(clip.offset + clip.duration).toFixed(1)} 秒から）`);
        if (this.onTracksChanged) this.onTracksChanged();
    }
    /** トラックを 1 つ上 (dir = -1) か下 (dir = 1) へ動かす (元に戻せる)。 */
    moveTrack(trackId, dir) {
        const index = engine.tracks.findIndex(t => t.id === trackId), to = index + dir;
        if (index < 0 || to < 0 || to >= engine.tracks.length) return;
        const track = engine.tracks[index];
        this.history.record(`「${track.name}」の並びを変更`, () => {
            const next = engine.tracks.slice();
            next.splice(index, 1); next.splice(to, 0, track);
            engine.tracks = next;
        });
        this._renderKeepingFocus(this._pianoRoll, '.btn-track-menu', trackId);
        if (this.onTracksChanged) this.onTracksChanged();
    }
    /** トラック名を、その場の入力欄で変え始める。 */
    startRename(trackId) {
        if (!engine.getTrack(trackId)) return;
        this.renamingId = trackId;
        this.render(this._pianoRoll);
    }
    /**
     * トラック名を変える (元に戻せる)。
     * @param name - 新しい名前。null か空ならやめる (名前は変えない)
     */
    renameTrack(trackId, name) {
        const track = engine.getTrack(trackId);
        const next = (name ?? '').trim();
        if (track && next && next !== track.name) {
            const before = track.name;
            this.history.record(`「${before}」の名前を変更`, () => { track.name = next; });
            if (this.onStatus) this.onStatus(`「${before}」の名前を「${next}」に変えました`);
        }
        this.render(this._pianoRoll);
        if (this.onTracksChanged) this.onTracksChanged();
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
            const { trackId, clipIndex, element } = this.draggingClip;
            const offset = parseFloat(element.style.left) / this.pixelsPerSecond;
            // 動かさずに離したときは、記録に残らない (前後が同じなので)
            this.history.record('クリップを移動', () => engine.moveClip(trackId, clipIndex, offset));
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
    const { followPlayhead, setFollowPlayhead } = useDaw();
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
        <div id="seek-bar-area" data-tip-side="top">
            <span id="seek-time-current">{curTime}</span>
            <input type="range" id="seek-bar" aria-label="再生位置" min="0" max="100" step="0.1" value={seekVal}
                {...tip('ドラッグすると、再生する位置が変わります')}
                onMouseDown={() => { isSeeking.current = true; }} onTouchStart={() => { isSeeking.current = true; }}
                onInput={handleInput} onMouseUp={finishSeek} onTouchEnd={finishSeek}
                // 矢印キーでも動かせる。キーを離したときと、欄を離れたときにも確定する
                // (確定しないと、移動されないうえに、以後つまみが再生位置を追わなくなる)
                onKeyUp={finishSeek} onBlur={finishSeek} />
            <span id="seek-time-total">{totalTime}</span>
            <label id="follow-playhead">
                <input type="checkbox" checked={followPlayhead} onChange={(e) => setFollowPlayhead(e.target.checked)}
                    {...tip('再生中、鳴っている場所が見えるように、タイムラインとピアノロールを自動でスクロールします')} />
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
                <button type="button" className="action-btn primary" onClick={() => { openLearn('song'); openSongPicker(); }}
                    {...tip('教材にする曲のファイルを選びます。取り込むと、カルテを自動で作ります')}>
                    曲を取り込んで始める
                </button>
                <button type="button" className="action-btn secondary" onClick={startFree}
                    {...tip('曲を使わずに、空のトラックを 1 本作って始めます')}>自由に作る</button>
            </div>
            <p className="empty-note">MP3・WAV・FLAC・M4A などの曲のファイルを選びます。「自由に作る」は、空のトラックを 1 本作ります。</p>
            <RecentProjects />
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
    const {
        setStatus, bumpTracks, pianoRollRef, timelineRef, trackVersion, bpm, beatsPerBar, gridOffset, followPlayhead,
        record, beginEdit, showUndoToast, practiceOpen, openPractice,
    } = useDaw();
    const { practicePart } = useLearnActions();
    // MIDI 入力の仕組みは 1 つだけ持ち、ふだんの見出しと練習画面の「入力」の両方から使う
    const midi = useMidiInput();
    const openPracticeRef = useRef(openPractice);
    useEffect(() => { openPracticeRef.current = openPractice; }, [openPractice]);
    // 開いているメニュー (クリップの右クリック、トラックの「…」)
    const [menu, setMenu] = useState(null);
    // ピアノロールの表示の大きさ (+/- のボタンの押せる・押せない)
    const [zoom, setZoom] = useState({ canZoomInX: true, canZoomOutX: true, canZoomInY: true, canZoomOutY: true });
    // タイムラインの「練習する」は、初期化のときに 1 回だけ渡すので、最新の関数を ref で引く
    const practiceRef = useRef(practicePart);
    const followRef = useRef(followPlayhead);
    useEffect(() => { practiceRef.current = practicePart; followRef.current = followPlayhead; }, [practicePart, followPlayhead]);
    const [activeTrackId, setActiveTrackId] = useState(null);
    // 見出しのトラック名は、描くたびにエンジンから引く (名前の変更・元に戻すで変わるため)
    const activeTrackName = activeTrackId !== null ? engine.getTrack(activeTrackId)?.name ?? null : null;
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
        pr.init({ canvas: pianoCanvasRef.current, noteLayer: noteLayerRef.current, keysDiv: keysRef.current, wrap: pianoWrapRef.current, area: pianoAreaRef.current });
        pr.onTrackSwitch = (trackId) => {
            const track = trackId ? engine.getTrack(trackId) : null;
            setActiveTrackId(track ? track.id : null);
        };
        pr.onNotesChanged = bumpTracks;
        pr.onStatus = setStatus;
        pr.onZoom = setZoom;
        // record / beginEdit はストアの中で同じ関数のまま (useCallback) なので、ここで 1 回渡せばよい
        const history = { record, begin: beginEdit };
        pr.history = history;
        pianoRollRef.current = pr;

        // Timeline 初期化
        const tl = new TimelineEngine();
        tl.init({ container: tracksContainerRef.current, headerCanvas: headerCanvasRef.current, scroller: timelineAreaRef.current });
        tl.onStatus = setStatus;
        tl.onTracksChanged = bumpTracks;
        tl.onPractice = (trackId) => practiceRef.current(trackId);
        tl.onOpenPractice = (trackId) => {
            const track = engine.getTrack(trackId);
            if (!track || track.practiceOf === undefined) return;
            pr.switchToTrack(trackId);
            openPracticeRef.current(track.practiceOf, trackId);
            bumpTracks();
            setStatus(`「${track.name}」を練習画面で開きました（Esc でアレンジに戻ります）`);
        };
        tl.onMenu = setMenu;
        tl.onUndoToast = showUndoToast;
        tl.history = history;
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
        const t = record('トラックを追加', () => engine.addTrack());
        bumpTracks();
        setStatus(`「${t.name}」を追加しました`);
    }, [record, bumpTracks, setStatus]);

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
        ? <>ピアノロール — <strong style={{ color: 'var(--accent)' }}>{activeTrackName}</strong> {!practiceOpen && <span className="area-hint">（ダブルクリックでノートを追加 / ドラッグで移動・高さの変更・囲んで選ぶ / Delete か Backspace で削除）</span>}</>
        : <>ピアノロール <span className="area-hint">（タイムラインのトラック名をクリックすると開きます）</span></>;
    const zoomBy = (axis, dir) => {
        const pr = pianoRollRef.current;
        if (!pr) return;
        if (axis === 'x') pr.zoomX(dir); else pr.zoomY(dir);
    };

    return (
        <PracticeProvider midi={midi}>
        <div id="center" ref={centerRef} className={practiceOpen ? 'practice-mode' : undefined}>
            {/* 練習画面の見出し。練習画面のあいだは、タイムラインと境目を隠す (外さない。CSS の .practice-mode) */}
            {practiceOpen && <PracticeHeader />}
            {/* タイムライン */}
            <div id="timeline-area" ref={timelineAreaRef}>
                {/* 見出しと小節番号の段は、スクロールしても枠の上端・左端に留める */}
                <div id="timeline-top">
                    <div className="area-label">タイムライン <span className="area-hint">（音声ファイルをドロップして追加 / クリップをドラッグで移動 / 右クリックでメニュー）</span></div>
                    <canvas ref={headerCanvasRef} id="timeline-header-canvas" />
                </div>
                <div ref={tracksContainerRef} id="tracks-container" />
                {engine.tracks.length === 0 && <EmptyState />}
                <button id="btn-add-track" onClick={handleAddTrack} hidden={engine.tracks.length === 0}
                    {...tip('空のトラックを 1 本、いちばん下に足します')}>+ トラック追加</button>
                <SeekBar />
            </div>

            {/* タイムラインとピアノロールの境目。ドラッグか、上下の矢印キーで動かす */}
            <div className={'resize-handle' + (resizing ? ' dragging' : '')} id="resize-piano"
                role="separator" aria-orientation="horizontal" tabIndex={0}
                aria-label="タイムラインとピアノロールの境目（上下の矢印キーで動かせます）"
                aria-valuemin={PIANO_MIN_HEIGHT} aria-valuenow={pianoHeight ?? 300}
                {...tip('上下にドラッグすると、ピアノロールの高さが変わります')}
                onPointerDown={handleResizeDown} onKeyDown={handleResizeKey} />

            {/* ピアノロール */}
            <div id="piano-roll-area" ref={pianoAreaRef} style={pianoHeight === null || practiceOpen ? undefined : { height: pianoHeight }}>
                {/* 説明は上に出す。下のノートを隠さないため */}
                <div className="area-label" data-tip-side="top">
                    {/* 練習画面では、MIDI 入力とお手本の切り替えは下の操作に出す (お手本の重ね方を決める GhostBar は隠して残す) */}
                    {pianoLabel}{!practiceOpen && <MidiInputBar midi={midi} />}<GhostBar activeTrackId={activeTrackId} />
                    {/* 表示の大きさ。Cmd (Ctrl) + ホイールか、トラックパッドのピンチでも横の大きさを変えられる */}
                    <span className="piano-zoom" role="group" aria-label="ピアノロールの表示の大きさ">
                        <span className="area-hint" aria-hidden="true">横</span>
                        <button type="button" aria-label="横に縮める" {...tip('横に縮めて、広い範囲を見渡します\nCmd か Ctrl を押しながらホイールでも変わります')}
                            disabled={!zoom.canZoomOutX} onClick={() => zoomBy('x', -1)}>−</button>
                        <button type="button" aria-label="横に広げる" {...tip('横に広げて、細かいタイミングを見やすくします\nCmd か Ctrl を押しながらホイールでも変わります')}
                            disabled={!zoom.canZoomInX} onClick={() => zoomBy('x', 1)}>＋</button>
                        <span className="area-hint" aria-hidden="true">縦</span>
                        <button type="button" aria-label="縦に縮める" {...tip('縦に縮めて、広い音域を見渡します')} disabled={!zoom.canZoomOutY} onClick={() => zoomBy('y', -1)}>−</button>
                        <button type="button" aria-label="縦に広げる" {...tip('縦に広げて、ノートを押しやすくします')} disabled={!zoom.canZoomInY} onClick={() => zoomBy('y', 1)}>＋</button>
                    </span>
                </div>
                {practiceOpen && <PracticeBands />}
                <div id="piano-roll-body">
                    <div ref={keysRef} id="piano-keys" data-tip-side="right" data-tip-box="" />
                    {/* フォーカスを受けて、キーの操作 (矢印・Cmd+A/C/X/V/D・Delete) を受ける */}
                    <div ref={pianoWrapRef} id="piano-grid-wrap" tabIndex={0} role="group"
                        aria-label="ピアノロールのノート（矢印キーで選んだノートを動かす。Cmd か Ctrl + A で全部選ぶ）">
                        <canvas ref={pianoCanvasRef} id="piano-grid-canvas" />
                        <div ref={noteLayerRef} id="note-layer" />
                    </div>
                </div>
            </div>
            {practiceOpen && <PracticeSide />}
            {practiceOpen && <PracticeControls />}
            <PopupMenu request={menu} onClose={() => setMenu(null)} />
        </div>
        </PracticeProvider>
    );
}
