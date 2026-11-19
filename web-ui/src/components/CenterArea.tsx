/**
 * bunri DAW — 中央エリア（タイムライン + ピアノロール）
 * TODO: Canvas系クラスの完全な型定義を追加する
 */
// @ts-nocheck
import { useEffect, useRef, useState, useCallback } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { cloneNote } from '../lib/engine';
import { cssVar } from '../lib/theme';
import { hasPrimaryModifier, isDialogOpen, isTextEntry, isTypingTarget } from '../lib/keys';
import { sameNotes } from '../lib/project-snapshot';
import MidiInputBar from './MidiInputBar';
import { useMidiInput } from '../lib/useMidiInput';
import GhostBar from './GhostBar';
import VelocityBar from './VelocityBar';
import { VELOCITY_STEP, applyVelocity, sameSummary, summarizeVelocity } from '../lib/velocity';
import { PracticeBands, PracticeControls, PracticeHeader, PracticeProvider, PracticeSide } from './PracticeView';
import { normNote, normStep, secToStep, stepSeconds, stepUnits } from '../lib/grid';
import {
    cellLength, gridLines, isSnapId, isSwung, nudgeSteps, readSnapPrefs, snapEnd, snapFloor, snapGrid, snapIndexFloor, snapLength,
    snapLengthCeil, snapPos, snapRound, snapSteps, stepText, writeSnapPref,
} from '../lib/snap';
import SnapBar from './SnapBar';
import { isAudioFileName, useLearnActions } from '../lib/learn';
import { GAIN_MAX_DB, GAIN_MIN_DB, GAIN_STEP_DB, PAN_STEPS, clampGainDb, clampPan, formatGainDb, formatPan } from '../lib/mix';
import PopupMenu from './PopupMenu';
import RecentProjects from './RecentProjects';
import { cursorLabel } from '../lib/midi-input';
import { tip } from '../lib/tooltip';
import { blockedBy } from '../lib/notice';
import { firstRegionEndingAfter, inMask } from '../lib/pitch-hints';
import { DRUM_ROWS, drumRowOfPitch, isDrumTrack } from '../lib/drums';
import PitchHintBar from './PitchHintBar';
import PianoInstrument from './PianoInstrument';
import { MIN_CLIP_SEC, audioStartOf, fadeGain, fadeInOf, fadeOutOf, formatSeconds, playLength, setClipFades, setClipRange, splitClip } from '../lib/clip';
import { onPeaksReady, peakColumns, peaksOf } from '../lib/waveform';
import ClipFadeDialog from './ClipFadeDialog';

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
/** クリップの中の高さ (px)。CSS の .clip の高さ (52px) から、上下の縁を引いたもの。波形はこの高さで描く */
const CLIP_INNER_HEIGHT = 50;
/** 波形を、見えている範囲の左右にどれだけ余分に描いておくか (px)。少しのスクロールでは描き直さない */
const WAVE_MARGIN = 240;
/** フェードのつまみを出す、クリップの幅の下限 (px)。これより狭いクリップでは、メニューの「フェード…」を使う */
const FADE_HANDLE_MIN_WIDTH = 36;

/**
 * Canvas ベースのピアノロールエディタエンジン。
 *
 * グリッド描画・ノートの追加/移動（横で位置、縦で高さ）/リサイズ/削除・アクティブトラックとの
 * 双方向同期（`_saveToEngine` / `_loadFromEngine`）を担う。
 * ノートを置いたとき・高さを変えたとき・鍵盤を押したときは、その高さの音を短く鳴らす。
 * React コンポーネントから `pianoRollRef.current` 経由で操作する。
 *
 * 選択は複数持てる（ドラッグで囲む・Shift+クリック・Cmd+A）。選んだノートはまとめて動かし、
 * 矢印キーで動かし（←→ は選んだ刻み 1 つぶん、↑↓ は半音、Shift+↑↓ はオクターブ）、
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
 * - `setTrackNotes(trackId, notes, label?)` — どのトラックでも（開いていても、いなくても）ノートを丸ごと差し替える
 * - `reloadFromEngine()` — 元に戻したあと、トラックのノートを読み直す
 * - `getActiveTrackId()` — アクティブなトラック ID を返す
 * - `selectAll()` / `copySelection()` / `cutSelection()` / `paste()` / `duplicateSelection()`
 * - `zoomX(dir)` / `zoomY(dir)` — 表示の大きさを変える
 * - `snapId()` / `setSnapId(id, { remember? })` / `refreshSnap()` — 刻み（ノートを置く・動かすときに吸い付く間隔。lib/snap.ts）。
 *   三連・32 分・スウィングでは、ノートの位置と長さが小数のステップになる（1/60 ステップの倍数にそろえて持つ。lib/grid.ts）
 * - `clear()` — 全ノートを削除する
 */
// ---- PianoRoll クラス（Canvasベース）----
/** コピーしたノート（先頭のノートの位置を 0 にした並び）。トラックをまたいで貼り付けられる。 */
let noteClipboard = null;

/**
 * 横の大きさの段階 (1 ステップの幅、px)。既定は 20。上の 2 つ (80・100) は、32 分音符や 16 分の三連を
 * 置きやすくするためのもの (100 で、32 分音符 1 つが 50px)。
 */
const ZOOM_X_LEVELS = [5, 6, 8, 10, 12, 15, 20, 24, 30, 40, 50, 60, 80, 100];
/** 縦の大きさの段階 (1 行の高さ、px)。既定は 14。鍵盤の音名 (10px) が読める高さより下げない */
const ZOOM_Y_LEVELS = [10, 12, 14, 17, 20, 24];
/** ノートの幅の下限 (px)。細かい刻みのノートを縮めて見ているときも、見えて、押せるように */
const NOTE_MIN_WIDTH = 2;
/** ノートの右端の、長さを変えるつかみしろ (px)。幅の狭いノートでは、幅の 3 分の 1 まで (残りは、動かすつかみしろ) */
const RESIZE_GRIP = 10;
/** ドラッグで囲み始めたとみなす動きの大きさ (px)。これより小さければ、ただのクリック */
const BAND_THRESHOLD = 3;
/**
 * キーの音・コードの音の色の濃さ (0〜1)。背景の層なので薄くする。色そのものはトークン
 * (キーは --accent、コードは --secondary) から引き、ここでは濃さだけを決める。
 * いちばん濃く重なる行 (主音がコードのルートでもある行) の上でも、ノートの色 (--accent) とお手本の縁 (--ghost) が
 * 4.5:1 以上のコントラストを保つ値にしてある (e2e/pitch-hints.spec.ts が、描いた色から確かめる)。
 */
const HINT_ALPHA = { keyTone: 0.06, keyTonic: 0.12, chordTone: 0.1, chordRoot: 0.18 };

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
        // 刻み (ノートを置く・動かすときに吸い付く間隔。lib/snap.ts)。選んだ刻みは、ふつうのトラックとドラムのトラックで
        // 別々に覚える。既定は、これまでの動きと同じ (ふつうは 1 拍、ドラムは 16 分音符)。
        // snap が吸い付く位置の並び (スウィングを含む)、gridSize は刻み 1 つぶんのステップ数
        this.snapToGrid = true;
        this.snapPrefs = readSnapPrefs();
        this.snap = snapGrid(this.snapPrefs.normal, engine.swing);
        this.gridSize = snapSteps(this.snap);
        // 刻みが変わったとき (SnapBar が渡す。選択欄に、いまの刻みを出す)
        this.onSnap = null;
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
        // 選択か、選んだノートの強さが変わったとき (CenterArea が渡す。見出しの「強さ」の欄に出す)
        this.onSelection = null;
        this._lastSummary = null;
        // キーの音・コードの音の色分け (setPitchHints)。グリッドの背景に描く
        this.pitchHints = { key: null, chords: [] };
        // 行 (12 行で 1 オクターブ) → 高さの番号 (C = 0)
        this._rowPitchClass = this.noteNames.map(name => CHROMATIC.indexOf(name));
        // ドラムのトラックを開いているか (_syncDrumMode)。鍵盤の列に種類の名前を出し、試し聴きをドラムの音にする
        this.drumMode = false;
    }
    /**
     * 開いているトラックがドラムか (ドラムのパートと、その練習のトラック。lib/drums.ts) を見て、鍵盤の列を切り替える。
     * ドラムのあいだは、ドラムの行 (キック・スネア・ハイハット・シンバル・タム) に種類の名前を出し、列を広げる。
     * いまドラムかどうかは、グリッドの枠の `data-drums` で読める。
     */
    _syncDrumMode() {
        const track = this.activeTrackId !== null ? engine.getTrack(this.activeTrackId) : null;
        const drums = isDrumTrack(track, (id) => engine.getTrack(id));
        if (drums === this.drumMode) return;
        this.drumMode = drums;
        // ドラムのトラックは、ドラム用に覚えた刻み (既定は 16 分音符。ふだんの 1 拍の刻みだと、8 分や 16 分で刻む
        // ハイハットを、マウスで置けない)。ほかのトラックに戻ったら、ふだんの刻みに戻す
        this._applySnap();
        if (this.wrap) { if (drums) this.wrap.dataset.drums = 'true'; else delete this.wrap.dataset.drums; }
        this._labelKeys();
        // 鍵盤の列の幅が変わる。グリッドの大きさを取り直し、横の位置をそろえている部品 (練習画面の段) に知らせる
        if (this.canvas) { this._resize(); this._drawGrid(); this._emitView(); }
    }
    /** いま効いている刻みの種類 (覚える置き場)。ドラムのトラックを開いているあいだは `drums`。 */
    snapKind() { return this.drumMode ? 'drums' : 'normal'; }
    /** いま効いている刻みの名前 (`1/8T` など。lib/snap.ts の `SnapId`)。 */
    snapId() { return this.snapPrefs[this.snapKind()]; }
    /**
     * 刻みを選ぶ。いま開いているトラックの種類 (ふつう / ドラム) の刻みが変わる。
     * ノートを置く・動かす・伸ばす・貼る・複製する・矢印キーで動かす、がこの刻みに従い、グリッドの線も描き直す。
     * いまの刻みは、グリッドの枠の `data-snap` で読める。
     *
     * @param id - 刻み (`1/4` `1/8` `1/16` `1/32` `1/8T` `1/16T`)
     * @param options.remember - false なら、覚えない (開き直すと、利用者が最後に選んだ刻みに戻る)。
     *   お手本が三連の曲の練習を始めたときに、アプリが合わせるのに使う。省略すると覚える
     * @returns 変えたら true (同じ刻みなら false)
     */
    setSnapId(id, options = {}) {
        if (!isSnapId(id)) return false;
        const kind = this.snapKind();
        if (options.remember !== false) writeSnapPref(kind, id);
        if (this.snapPrefs[kind] === id) return false;
        this.snapPrefs = { ...this.snapPrefs, [kind]: id };
        this._applySnap();
        return true;
    }
    /** スウィング (プロジェクトの値。engine.swing) が変わったあとに呼ぶ。吸い付く位置とグリッドの線を作り直す。 */
    refreshSnap() { this._applySnap(); }
    /** 吸い付く位置の並びを、いまの刻みとスウィングから作り直す。変わっていれば、グリッドを描き直して知らせる。 */
    _applySnap() {
        const next = snapGrid(this.snapId(), engine.swing);
        const changed = next.id !== this.snap.id || next.cell !== this.snap.cell || next.off !== this.snap.off;
        this.snap = next;
        this.gridSize = snapSteps(next);
        if (this.wrap) this.wrap.dataset.snap = next.id;
        if (!changed) return;
        if (this.canvas) this._drawGrid();
        if (this.onSnap) this.onSnap(next.id);
    }
    /**
     * 鍵盤の列の文字と説明を付ける。ドラムのトラックを開いているあいだは、ドラムの行に種類の名前を出す。
     * 最後に、キーの音のしるしを付け直す (_markKeys は、ここで決めた説明の後ろに書き足す。2 つを食い違わせない)。
     */
    _labelKeys() {
        if (!this.keysDiv) return;
        this.keysDiv.classList.toggle('drum-keys', this.drumMode);
        for (const el of this.keysDiv.querySelectorAll('.piano-key')) {
            const row = this.drumMode ? drumRowOfPitch(Number(el.dataset.pitch)) : null;
            el.textContent = row ? row.label : el.dataset.name;
            el.classList.toggle('drum-row', !!row);
            if (row) el.dataset.drum = row.voice; else delete el.dataset.drum;
            el.dataset.base = row
                ? `${row.label}（${el.dataset.name}）。押すと、この音が鳴ります`
                : `${el.dataset.name}。押すと、この高さの音が鳴ります`;
        }
        this._markKeys();
    }
    /** ドラムの行 (キック〜タム) が全部は見えていなければ、その真ん中の行へ縦にスクロールする。 */
    _revealDrumRows() {
        if (!this.wrap) return;
        const rows = DRUM_ROWS.map(r => this._noteToRow(r.note, r.octave));
        const top = Math.min(...rows), bottom = Math.max(...rows);
        const first = this.wrap.scrollTop / this.noteHeight;
        const last = (this.wrap.scrollTop + this.wrap.clientHeight) / this.noteHeight;
        if (top >= first && bottom + 1 <= last) return;
        this._centerOnRow(Math.round((top + bottom) / 2));
    }
    /**
     * キーの音・コードの音の色分けを入れ替える (lib/pitch-hints.ts の buildPitchHints)。
     * グリッドの背景 (ノートとお手本の下) に描き、鍵盤の列にキーの音のしるしを付ける。
     * いま出しているものは、グリッドの枠の `data-key-hint` (「C major」) と `data-chord-hint` (区間の数) で読める
     * (canvas の中身は外から読みにくいので、テストが読めるように出す)。
     *
     * @param hints - `{ key, chords }`。key は null で出さない。chords は始まりの順に並んだ、重ならない区間
     */
    setPitchHints(hints) {
        const key = hints?.key ?? null, chords = hints?.chords ?? [];
        // 前と同じものなら、描き直さない (呼ぶ側は、カルテかグリッドが変わったときだけ作り直した値を渡す)
        const prev = this.pitchHints;
        if (key === prev.key && (chords === prev.chords || (chords.length === 0 && prev.chords.length === 0))) return;
        this.pitchHints = { key, chords };
        if (this.wrap) {
            if (key) this.wrap.dataset.keyHint = `${key.tonic} ${key.mode}`; else delete this.wrap.dataset.keyHint;
            if (chords.length > 0) this.wrap.dataset.chordHint = String(chords.length); else delete this.wrap.dataset.chordHint;
        }
        this._markKeys();
        if (this.canvas) this._drawGrid();
    }
    /** 鍵盤の列に、キーの音 (音階の音と主音) のしるしと説明を付ける。 */
    _markKeys() {
        if (!this.keysDiv) return;
        const key = this.pitchHints.key;
        for (const el of this.keysDiv.querySelectorAll('.piano-key')) {
            const pc = Number(el.dataset.pitch) % 12;
            const tonic = !!key && pc === key.tonicPc, inKey = !!key && inMask(key.mask, pc);
            el.classList.toggle('in-key', inKey);
            el.classList.toggle('key-tonic', tonic);
            // 鍵盤の文字と、説明の頭は _labelKeys が決める (ドラムの行は、種類の名前)
            const base = el.dataset.base ?? `${el.textContent}。押すと、この高さの音が鳴ります`;
            el.dataset.tip = tonic ? `${base}\nキー（${key.label}）の主音です`
                : inKey ? `${base}\nキー（${key.label}）の音階に入る音です` : base;
        }
    }
    /**
     * キーの音・コードの音を、グリッドの背景に描く。見えている行と、見えている範囲に掛かるコードの区間だけを描く
     * (区間は始まりの順に並んでいるので、最初の 1 つを二分探索で探す)。スクロールや再生のたびに呼ばれるので、
     * ここでは計算し直さない (構成音と区間は、lib/pitch-hints.ts で前もって出してある)。
     */
    _drawPitchHints(ctx, w, h, sx, sy) {
        const { key, chords } = this.pitchHints;
        if (!key && chords.length === 0) return;
        const nh = this.noteHeight, sw = this.stepWidth;
        const firstRow = Math.max(0, Math.floor(sy / nh));
        const lastRow = Math.min(this.totalRows, Math.ceil((sy + h) / nh));
        ctx.save();
        if (key) {
            ctx.fillStyle = cssVar('--accent', '#d4a44c');
            for (let row = firstRow; row < lastRow; row++) {
                const pc = this._rowPitchClass[row % 12];
                if (!inMask(key.mask, pc)) continue;
                ctx.globalAlpha = pc === key.tonicPc ? HINT_ALPHA.keyTonic : HINT_ALPHA.keyTone;
                ctx.fillRect(0, row * nh - sy, w, nh);
            }
        }
        if (chords.length > 0) {
            ctx.fillStyle = cssVar('--secondary', '#4ecdc4');
            const lastStep = (sx + w) / sw;
            for (let i = firstRegionEndingAfter(chords, sx / sw); i < chords.length && chords[i].start < lastStep; i++) {
                const chord = chords[i];
                // 区間の右端を 1px 空けて、隣のコードとの境目が見えるようにする (ノートの幅と同じ決まり)
                const x0 = Math.max(0, Math.round(chord.start * sw - sx)), x1 = Math.min(w, Math.round(chord.end * sw - sx) - 1);
                if (x1 <= x0) continue;
                for (let row = firstRow; row < lastRow; row++) {
                    const pc = this._rowPitchClass[row % 12];
                    if (!inMask(chord.mask, pc)) continue;
                    ctx.globalAlpha = pc === chord.rootPc ? HINT_ALPHA.chordRoot : HINT_ALPHA.chordTone;
                    ctx.fillRect(x0, row * nh - sy, x1 - x0, nh);
                }
            }
        }
        ctx.restore();
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
        this.wrap.dataset.snap = this.snap.id;
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
    /** 縦の位置は、手で動かした位置か、自動で中央に据えた高さかを区別して控える。 */
    verticalView() {
        const top = this.wrap?.scrollTop ?? 0;
        return { top, anchorRow: this._anchorRow != null && Math.abs(top - this._anchorTop) <= 1 ? this._anchorRow : null };
    }
    /** 見える高さが変わった後も、自動で見せていたノートを隠さない。手で動かした位置はそのまま戻す。 */
    restoreVerticalView(top, anchorRow) {
        if (!this.wrap) return;
        if (anchorRow == null) {
            this._anchorRow = null;
            this.wrap.scrollTop = top;
            this.keysDiv.scrollTop = this.wrap.scrollTop;
            return;
        }
        this._centerOnRow(anchorRow);
        const rows = this.notes.concat(this.ghostNotes).map(n => this._noteToRow(n.note, n.octave))
            .filter(row => row >= 0 && row < this.totalRows);
        if (!rows.length) return;
        let low = this.totalRows, high = 0;
        for (const row of rows) { low = Math.min(low, row); high = Math.max(high, row); }
        const first = low * this.noteHeight;
        const end = (high + 1) * this.noteHeight;
        const visible = this.wrap.clientHeight;
        // 音域が見える高さに収まるなら、端のノートも欠けない位置に収める。
        if (end - first <= visible) {
            const fitted = Math.max(end - visible, Math.min(first, this.wrap.scrollTop));
            this._centerOnRow((fitted + visible / 2) / this.noteHeight - 0.5);
        }
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
        this._loadFromEngine(); this._syncDrumMode(); this._fitLength(); this._renderNotes(); this._revealNotes();
        // ドラムのトラックを開いたら、種類の名前の付いた行が見える位置へ
        if (changed && this.drumMode) this._revealDrumRows();
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
        // 元に戻して、開いているトラックの役割が変わっていたら (パートの入れ替えなど)、鍵盤の列も合わせる
        this._syncDrumMode();
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
        track.pianoNotes = this.notes.map(cloneNote);
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
                div.dataset.name = `${name}${oct}`;
                div.dataset.tip = `${name}${oct}。押すと、この高さの音が鳴ります`;
                this.keysDiv.appendChild(div);
            }
        }
        // 鍵盤を作り直したら (縦の大きさを変えたとき)、ドラムの種類の名前と、キーの音のしるしも付け直す
        // (_labelKeys が、最後に _markKeys を呼ぶ)
        this._labelKeys();
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
        // キーの音・コードの音。いちばん下の層 (この上に、区間の外の暗さ・行と拍の線が重なる)
        this._drawPitchHints(ctx, w, h, sx, sy);
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
        // 縦線。見えている範囲だけ
        const firstStep = Math.max(0, Math.floor(sx / this.stepWidth));
        const lastStep = Math.min(this.totalSteps, Math.ceil((sx + w) / this.stepWidth));
        const bottom = Math.min(h, this.totalRows * this.noteHeight - sy);
        // 拍のあいだの線: 選んだ刻みの位置に引く (三連なら三連の位置、スウィングならずらした位置。4 分・8 分・16 分は、
        // これまでと同じ 16 分音符の線)。縮めて詰まるときは、粗い線に間引くか、省く (lib/snap.ts の gridLines)
        const lines = gridLines(this.snap, this.stepWidth);
        if (lines) {
            for (let k = snapIndexFloor(lines, firstStep); ; k++) {
                const step = snapPos(lines, k);
                if (step > lastStep) break;
                const units = stepUnits(step);
                // 拍と小節の線は、下でまとめて引く
                if (units % 240 === 0) continue;
                // 16 分音符の位置に無い線 (32 分・三連・スウィングの裏) は、少しだけ濃くして見分けやすくする
                ctx.strokeStyle = units % 60 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)';
                const x = Math.round(step * this.stepWidth) - sx;
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke();
            }
        }
        // 拍と小節の線 (必ず引く)
        for (let step = Math.ceil(firstStep / 4) * 4; step <= lastStep; step += 4) {
            const x = step * this.stepWidth - sx, isBar = step % bar === 0;
            ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)';
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
            if (this.activeTrackId === null) {
                // 黙って何も置かないままにしない (なぜ置けないかを知らせる)
                if (this.onStatus) this.onStatus('ノートを置くトラックが、まだ開いていません。上のトラックの名前をクリックしてピアノロールを開いてから、ここをダブルクリックしてください（トラックが無ければ「＋ トラックを追加」）', 'hint');
                return;
            }
            if (e.target.classList.contains('note-block')) return;
            // ノートの層は中身と一緒にスクロールするので、層の左上からの距離がそのまま曲の中の位置になる
            const { x, y } = this._layerPoint(e);
            const row = Math.floor(y / this.noteHeight);
            if (row < 0 || row >= this.totalRows || x < 0) return;
            // 押した位置の手前の刻みに置く。長さは刻み 1 つぶん (スウィングのときは、次の刻みまで)
            let step = Math.floor(x / this.stepWidth), length = 1;
            if (this.snapToGrid) {
                const k = snapIndexFloor(this.snap, x / this.stepWidth);
                step = snapPos(this.snap, k); length = cellLength(this.snap, k);
            }
            const { note, octave } = this._rowToNote(row);
            this._addNote(note, octave, step, length);
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
            // ドラムのトラックでは、ドラムの行は種類ごとの音で鳴る (再生と同じ音)
            const voice = engine.liveNoteOn(pitch, 96, { drums: this.drumMode, trackId: this.activeTrackId });
            key.classList.add('sounding');
            this._heldKey = { pitch, el: key, voice };
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
        // 右端のつかみしろは 10px。幅の狭いノート (細かい刻み・縮めた表示) では、幅の 3 分の 1 までにして、
        // 残りを「動かす」に空ける (全部が右端になって、動かせなくならないように)
        const rect = e.target.getBoundingClientRect();
        const resize = e.clientX > rect.right - Math.min(RESIZE_GRIP, rect.width / 3);
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
        // 動かした幅 (ステップ)。刻みが 16 分音符以上でスウィングも無いとき (これまでの刻み) は、これまでどおり、
        // 先に 16 分音符の単位に丸めてから刻みに吸い付ける。細かい刻み・三連・スウィングでは、丸めずに吸い付ける
        const coarse = !isSwung(this.snap) && stepUnits(this.gridSize) % 60 === 0;
        const moved = (e.clientX - d.startX) / this.stepWidth;
        const dSteps = coarse || !this.snapToGrid ? Math.round(moved) : moved;
        let changed = false;
        if (d.mode === 'move') {
            // 位置: つかんだノートをグリッドに吸い付け、ほかのノートは同じだけずらす。0 より前には出さない
            const a = d.origins.get(d.anchor);
            let ns = a.step + dSteps;
            if (this.snapToGrid) ns = snapRound(this.snap, ns);
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
                const step = normStep(o.step + delta);
                if (n.step !== step || n.note !== next.note || n.octave !== next.octave) changed = true;
                n.step = step; n.note = next.note; n.octave = next.octave;
            }
            if (`${d.anchor.note}${d.anchor.octave}` !== anchorBefore) { d.pitchMoved = true; this._audition(d.anchor.note, d.anchor.octave); }
        } else {
            for (const [n, o] of d.origins) {
                let nl = o.length + dSteps;
                // 長さは刻みの倍数にそろえる (刻み 1 つぶんより短くはしない)。スウィングのときは、終わりを吸い付く位置にそろえる
                if (!this.snapToGrid) nl = Math.max(1, nl);
                else if (isSwung(this.snap)) nl = snapEnd(this.snap, o.step, o.step + nl);
                else nl = snapLength(this.snap, nl);
                nl = normStep(nl);
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
            if (e.target instanceof Element && e.target.closest('#tracks-container')) return;
            if (this.selection.size === 0) {
                // ピアノロールを触っているときだけ知らせる (ほかの場所での Delete には口を出さない)
                if (this.activeTrackId !== null && this._hasFocus()) this._needSelection('削除');
                return;
            }
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
            // 選ばずに押した・コピーせずに貼り付けた: 何も起きない理由を知らせる
            else if (key === 'c' || key === 'x' || key === 'd') this._needSelection({ c: 'コピー', x: '切り取り', d: '複製' }[key]);
            else if (key === 'v' && this.onStatus) this.onStatus('貼り付けるノートが、まだありません。先に、ノートを選んでコピーしてください', 'hint');
            return;
        }
        if (e.key === 'Escape' && this.selection.size > 0) { e.preventDefault(); this.selection = new Set(); this._refreshSelection(); return; }
        // Option (Alt) + ↑↓ で、選んでいるノートの強さを上下させる (Shift も押すと 1 ずつ)
        if (e.altKey && !mod && this.selection.size > 0 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            const amount = e.shiftKey ? 1 : VELOCITY_STEP;
            this.nudgeSelectionVelocity(e.key === 'ArrowUp' ? amount : -amount);
            return;
        }
        if (this.selection.size === 0 || e.altKey || mod) return;
        // ←→ は、選んだ刻み 1 つぶん (スウィングのときは、隣の吸い付く位置まで。いちばん前のノートを基準にする)
        const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
        const first = horizontal ? Math.min(...[...this.selection].map(n => n.step)) : 0;
        const moves = {
            ArrowLeft: [horizontal ? nudgeSteps(this.snap, first, -1) : 0, 0], ArrowRight: [horizontal ? nudgeSteps(this.snap, first, 1) : 0, 0],
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
        const voice = engine.liveNoteOn(pitch, 96, { drums: this.drumMode, trackId: this.activeTrackId });
        this._auditionTimers.set(pitch, setTimeout(() => {
            this._auditionTimers.delete(pitch);
            engine.liveNoteOff(pitch, voice);
        }, AUDITION_MS));
    }
    /** 押していた鍵盤を離す (音を止める)。 */
    _releaseKey() {
        if (!this._heldKey) return;
        engine.liveNoteOff(this._heldKey.pitch, this._heldKey.voice);
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
     * @param options.velocity - 強さ (1〜127)。MIDI 鍵盤で弾いたノートが持つ。省略すると、強さを持たないノートになる
     */
    _addNote(note, octave, step, length, options = {}) {
        const { label = 'ノートを追加', velocity, ...push } = options;
        this.history.record(label, () => {
            this.notes.push(cloneNote({ note, octave, step, length, velocity }));
            this._saveToEngine();
        }, push);
        this._fitLength(); this._renderNotes();
    }
    /** ノートを選ばずに、選んだノートへの操作をしようとしたときの知らせ。 */
    _needSelection(action) {
        if (this.onStatus) this.onStatus(`${action}するノートが選ばれていません。ノートをクリックするか、何もないところからドラッグして囲んで選んでから、もう一度押してください`, 'hint');
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
            notes: list.map(n => ({ ...cloneNote(n), step: normStep(n.step - base) })),
            span: normStep(Math.max(...list.map(n => n.step + n.length)) - base),
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
        const placed = clip.notes.map(n => ({ ...cloneNote(n), step: normStep(start + n.step) }));
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
        // 再生位置の手前の刻みへ。秒 → ステップの計算の誤差で、刻みちょうどの再生位置が 1 つ手前に落ちないようにする
        const raw = Math.max(0, secToStep(sec, engine.grid));
        let at = Math.floor(raw + 1e-6);
        if (this.snapToGrid) at = snapFloor(this.snap, raw + 1e-6);
        const count = this._placeClip(noteClipboard, at, `${noteClipboard.notes.length} ノートを貼り付け`);
        if (this.onStatus) this.onStatus(`${count} ノートを貼り付けました（再生位置から）`);
    }
    /** 選んでいるノートを、すぐ後ろ (グリッドの刻みに切り上げた長さの先) に複製する。 */
    duplicateSelection() {
        if (this.selection.size === 0) return;
        const clip = this._selectionAsClip();
        const base = Math.min(...[...this.selection].map(n => n.step));
        // 選んだノートの長さを、刻みの倍数に切り上げた先へ置く。スウィングのときは、置く先を吸い付く位置にそろえる
        // (表から始まるまとまりは表へ、の形を保つために、刻み 2 つぶん (表と裏の 1 組) の倍数だけ先へ)
        let span = clip.span;
        if (this.snapToGrid) {
            span = isSwung(this.snap)
                ? Math.max(1, Math.ceil(stepUnits(clip.span) / (2 * this.snap.cell))) * 2 * this.gridSize
                : snapLengthCeil(this.snap, clip.span);
        }
        const count = this._placeClip(clip, normStep(base + span), `${clip.notes.length} ノートを複製`);
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
            // 小数のステップ (三連など) の足し算の誤差で、端のノートを止めない
            return normStep(n.step + dSteps) >= 0 && normStep(n.step + n.length + dSteps) <= this.maxSteps && row >= 0 && row < this.totalRows;
        });
        if (list.length === 0) return;
        if (!fits) {
            if (this.onStatus) this.onStatus(dRows !== 0
                ? 'これ以上は、その向きに動かせません。選んだノートのどれかが、ピアノロールの音域の外に出てしまいます'
                : 'これ以上は、その向きに動かせません。選んだノートのどれかが、曲の頭より前か、末尾より後ろに出てしまいます', 'hint');
            return;
        }
        this.history.record(dRows !== 0 ? 'ノートの高さを変更' : 'ノートを移動', () => {
            for (const n of list) {
                const next = this._rowToNote(this._noteToRow(n.note, n.octave) + dRows);
                n.step = normStep(n.step + dSteps); n.note = next.note; n.octave = next.octave;
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
    /** 選んでいるノートの強さのまとめ (見出しの「強さ」の欄に出す)。 */
    velocitySummary() {
        return this.activeTrackId === null ? { count: 0, value: null, unset: 0 } : summarizeVelocity(this.selection);
    }
    /** 選択か、選んだノートの強さが変わったら知らせる (中身が前と同じなら知らせない)。 */
    _emitSelection() {
        if (!this.onSelection) return;
        const next = this.velocitySummary();
        if (this._lastSummary && sameSummary(this._lastSummary, next)) return;
        this._lastSummary = next;
        this.onSelection(next);
    }
    /**
     * 選んでいるノートの強さを変える (元に戻せる)。
     * 強さを持たないノートは 96 として扱い、値が変わったノートにだけ強さを書き込む。
     *
     * @param next - 今の強さから新しい強さを出す関数 (結果は 1〜127 に収める)
     * @param options.coalesceKey - 続けて押したぶんを 1 つの記録にまとめる鍵 (−/＋ と Option+↑↓)
     */
    _changeSelectionVelocity(next, options = {}) {
        const list = [...this.selection];
        if (list.length === 0) return;
        let changed = 0;
        this.history.record(list.length > 1 ? `${list.length} ノートの強さを変更` : 'ノートの強さを変更', () => {
            changed = applyVelocity(list, next);
            this._saveToEngine();
        }, options);
        if (changed === 0) {
            if (this.onStatus) this.onStatus('強さは変わりませんでした。すでにその値になっているか、端（1 か 127）に達しています', 'hint');
            return;
        }
        this._renderNotes();
        const s = summarizeVelocity(list);
        if (this.onStatus) this.onStatus(s.value !== null ? `強さを ${s.value} にしました` : `${changed} ノートの強さを変えました`);
    }
    /** 選んでいるノートの強さを、全部同じ値にする。 */
    setSelectionVelocity(value) { this._changeSelectionVelocity(() => value); }
    /** 選んでいるノートの強さを、差を保ったまま上下させる (端では 1〜127 で止まる)。 */
    nudgeSelectionVelocity(delta) { this._changeSelectionVelocity(v => v + delta, { coalesceKey: 'nudge-velocity' }); }
    /** 選択の縁取りだけを描き直す (ノートを作り直さない。囲んで選ぶあいだは毎回呼ぶので軽くする)。 */
    _refreshSelection() {
        if (!this.noteLayer) return;
        for (const el of this.noteLayer.querySelectorAll('.note-block')) {
            el.classList.toggle('selected', this.selection.has(this.notes[Number(el.dataset.index)]));
        }
        this._emitSelection();
    }
    _renderNotes() {
        if (!this.noteLayer) return; this.noteLayer.innerHTML = '';
        // 描き直すのは、選択かノートの中身が変わったとき。見出しの「強さ」の欄も合わせる
        this._emitSelection();
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
            el.style.width = Math.max(NOTE_MIN_WIDTH, n.length * this.stepWidth - 1) + 'px'; el.style.height = (this.noteHeight - 1) + 'px';
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
            el.style.width = Math.max(NOTE_MIN_WIDTH, n.length * this.stepWidth - 1) + 'px'; el.style.height = (this.noteHeight - 1) + 'px';
            el.dataset.index = i;
            const hasVelocity = typeof n.velocity === 'number';
            // data-note は機械が読む形 (テストが音の高さ・位置・強さを読む)。説明 (data-tip) は人が読む形。
            // 小数のステップ (三連・32 分) は、小数 2 桁で出す (8 分の三連の 2 つ目は step:1.33)
            el.dataset.note = `${n.note}${n.octave} step:${stepText(n.step)} len:${stepText(n.length)}` + (hasVelocity ? ` 強さ:${n.velocity}` : '');
            el.dataset.tip = `${n.note}${n.octave}（${cursorLabel(n.step, engine.beatsPerBar || 4)}${hasVelocity ? `、強さ ${n.velocity}` : ''}）`;
            // 強さを持つノートは、弱いほど薄く見せる (強さを持たないノートは、これまでどおり)
            if (hasVelocity) el.style.opacity = String(0.45 + 0.55 * Math.max(1, Math.min(127, n.velocity)) / 127);
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
    getNotes() { this._saveToEngine(); return this.notes.map(cloneNote); }
    /**
     * ノートを一括セットしてピアノロールを再描画する (元に戻せる)。
     * 音声解析結果（`/api/analyze`）の配置などに使用する。
     *
     * @param notes - セットするノート情報の配列（`note`, `octave`, `step`, `length` を含む）
     * @param label - 記録の名前 (省略時は「ノートを置き換え」)
     */
    setNotes(notes, label = 'ノートを置き換え') {
        this.history.record(label, () => {
            this.notes = notes.map(n => normNote(n)); this.selection = new Set(); this._saveToEngine();
        });
        this._fitLength(); this._renderNotes(); this._revealNotes();
    }
    /**
     * どのトラックでも (開いていても、いなくても)、ノートを丸ごと差し替える (元に戻せる)。アシスタントが使う。
     *
     * 開いているトラックは、手元の写しごと差し替える (`setNotes`)。トラックの `pianoNotes` だけを直接差し替えると、
     * 次に控えを取るとき (`_saveToEngine`) に、手元の古い写しで上書きされてしまう。
     * 開いていないトラックは、トラックの並びを新しい配列に差し替える (ノートの配列は書き換えない約束。lib/project-snapshot.ts)。
     *
     * @param trackId - トラック ID
     * @param notes - 差し替えた後のノート (`note`, `octave`, `step`, `length`, あれば `velocity`)
     * @param label - 記録の名前 (省略時は「ノートを置き換え」)
     * @returns 差し替えたら true (トラックが無ければ false)
     */
    setTrackNotes(trackId, notes, label = 'ノートを置き換え') {
        const id = Number(trackId);
        const track = engine.getTrack(id);
        if (!track) return false;
        if (this.activeTrackId === id) { this.setNotes(notes, label); return true; }
        this.history.record(label, () => { track.pianoNotes = notes.map(cloneNote); });
        // 開いていないトラックは、見出しのノートの数だけが変わる
        if (this.onNotesChanged) this.onNotesChanged();
        return true;
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
 * - クリップの左右の端のドラッグで、縮める・伸ばす（音声は書き換えない。拍にスナップ。Option / Alt を押しているあいだは吸い付けない）
 * - クリップの上の角のつまみのドラッグで、フェードイン・フェードアウト（スナップしない）
 * - クリップの右クリック（とキーボードのメニューキー）でメニュー（複製・再生位置で分割・フェード…・削除）。
 *   フォーカスしたクリップでは S キーでも、再生位置で分割する
 * - クリップに、音声の波形とフェードの形を描く（山の値は lib/waveform.ts が音声ごとに 1 度だけ作る。
 *   描くのは見えている範囲だけで、スクロールしたら描き足す）
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
 * - `addTrack(name?)` / `selectTrack(id)` / `renameTrack(id, name)` / `deleteTrack(id)`
 * - `setMute(id, on)` / `setSolo(id, on)` / `setGain(id, dB)` / `setPan(id, v)` — 値を指定して変える。
 *   見出しのボタンとつまみも、アシスタント（lib/assistant-tools.ts）も、これを呼ぶ
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
        // クリップの端かフェードのつまみを動かしている途中 (_beginClipDrag)
        this.clipEdit = null;
        // フェードの長さを秒で決める窓を開くとき (CenterArea が渡す)
        this.onFadeDialog = null;
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
            // クリップの波形も、見えている範囲だけを描いているので、スクロールで描き足す
            this.scroller.addEventListener('scroll', () => { this._drawHeader(); this._scheduleWaves(false); });
            if (typeof ResizeObserver !== 'undefined') {
                this._resizeObserver = new ResizeObserver(() => {
                    cancelAnimationFrame(this._resizeFrame);
                    this._resizeFrame = requestAnimationFrame(() => { this._drawHeader(); this._drawWaves(false); });
                });
                this._resizeObserver.observe(this.scroller);
            }
        }
        // 長い音声の山の値は、少しずつ作られる。できたら、波形だけを描き足す (行は作り直さない)
        onPeaksReady(() => this._scheduleWaves(true));
    }
    /** 次の描画のときに、クリップの波形を描き直す (続けて呼ばれても 1 回にまとめる)。 */
    _scheduleWaves(force) {
        this._wavesForce = this._wavesForce || force;
        if (this._wavesFrame) return;
        const run = () => { this._wavesFrame = 0; const f = this._wavesForce; this._wavesForce = false; this._drawWaves(f); };
        this._wavesFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
    }
    /**
     * 全部のクリップの波形を描く。
     * @param force - false なら、見えている範囲が前に描いた範囲に収まっているクリップは描き直さない (スクロールのとき)
     */
    _drawWaves(force) {
        if (!this.container) return;
        this.container.querySelectorAll('.clip').forEach((el) => { if (el._clip) this._drawClipWave(el, el._clip, force); });
    }
    /**
     * クリップの波形と、フェードの形を描く。描くのは、見えている範囲 (と左右の余白) だけ。
     * 曲全体の幅の canvas にはしない (長い曲でブラウザの canvas の上限を超え、メモリも使う)。
     * 山の値は lib/waveform.ts が音声ごとに覚えている。ここでは、見えている幅のぶんを引いて描くだけ。
     *
     * 波形の高さには、フェードの音量を掛ける (鳴る音の形に近づける)。フェードの範囲は、暗い三角と線でも示す。
     */
    _drawClipWave(clipEl, clip, force = true) {
        const canvas = clipEl.querySelector('.clip-wave');
        if (!canvas || !this.scroller) return;
        const pps = this.pixelsPerSecond, len = playLength(clip), width = len * pps, clipLeft = clip.offset * pps;
        const viewStart = this.scroller.scrollLeft - clipLeft;
        const viewEnd = viewStart + this.scroller.clientWidth - this.headerWidth;
        const needStart = Math.max(0, viewStart), needEnd = Math.min(width, viewEnd);
        if (needEnd <= needStart) { canvas.style.display = 'none'; canvas._range = null; return; }
        if (!force && canvas._range && canvas._range.start <= needStart && canvas._range.end >= needEnd) return;
        const start = Math.max(0, Math.floor(viewStart - WAVE_MARGIN)), end = Math.min(width, Math.ceil(viewEnd + WAVE_MARGIN));
        const w = Math.max(1, Math.round(end - start));
        const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
        if (!ctx) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.style.display = 'block'; canvas.style.left = start + 'px'; canvas.style.width = w + 'px';
        // 大きさを設定し直すと canvas は消える (描き直しの前の消去を兼ねる)
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(CLIP_INNER_HEIGHT * dpr);
        canvas._range = { start, end };
        const cols = canvas.width, h = canvas.height, mid = h / 2, amp = h / 2 - dpr;
        const fadeIn = fadeInOf(clip), fadeOut = fadeOutOf(clip);
        const secPerCol = 1 / (pps * dpr), fromSec = start / pps;
        // 音声の無いクリップ (無音の置き場所) には、波形を描かない
        const peaks = clip.missing ? null : peaksOf(clip.buffer);
        if (peaks) {
            const { min, max } = peakColumns(peaks, audioStartOf(clip) + fromSec, secPerCol, cols);
            ctx.fillStyle = cssVar('--accent', '#d4a44c'); ctx.globalAlpha = 0.5;
            for (let x = 0; x < cols; x++) {
                const gain = fadeGain(fromSec + (x + 0.5) * secPerCol, len, fadeIn, fadeOut);
                const top = mid - max[x] * gain * amp, bottom = mid - min[x] * gain * amp;
                ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
            }
            ctx.globalAlpha = 1;
        }
        // フェードの形: 音量が下がっているところを暗くし、音量の線を引く
        const px = (sec) => (sec - fromSec) * pps * dpr;
        const shape = (x0, x1, lowAtStart) => {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
            ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x1, 0); ctx.lineTo(lowAtStart ? x0 : x1, h); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = cssVar('--text', '#e8e4de'); ctx.lineWidth = dpr; ctx.globalAlpha = 0.85;
            ctx.beginPath(); ctx.moveTo(x0, lowAtStart ? h : 0); ctx.lineTo(x1, lowAtStart ? 0 : h); ctx.stroke();
            ctx.globalAlpha = 1;
        };
        if (fadeIn > 0) shape(px(0), px(fadeIn), true);
        if (fadeOut > 0) shape(px(len - fadeOut), px(len), false);
    }
    /**
     * クリップの要素に、位置・幅・説明・つまみの位置を当てて、波形を描く。
     * 描き直し (render) と、端やつまみを動かしている途中の見た目 (まだトラックには入れていないクリップ) の両方で使う。
     */
    _layoutClip(clipEl, clip, track) {
        const pps = this.pixelsPerSecond, len = playLength(clip), width = len * pps;
        const fadeIn = fadeInOf(clip), fadeOut = fadeOutOf(clip), audioStart = audioStartOf(clip);
        clipEl._clip = clip;
        clipEl.style.left = (clip.offset * pps) + 'px';
        clipEl.style.width = width + 'px';
        // 説明と読み上げ。1 行目の形 (名前・位置・長さ) は変えない。縮めた・フェードを付けたクリップは、その値を足す
        const extra = [
            audioStart > 0 ? `音声の ${formatSeconds(audioStart)} 秒目から` : '',
            fadeIn > 0 ? `フェードイン ${formatSeconds(fadeIn)} 秒` : '',
            fadeOut > 0 ? `フェードアウト ${formatSeconds(fadeOut)} 秒` : '',
        ].filter(Boolean).join('、');
        clipEl.dataset.tip = `${clip.name}（${clip.offset.toFixed(1)} 秒から、長さ ${len.toFixed(1)} 秒）${extra ? `\n${extra}` : ''}`
            + '\nドラッグで移動、左右の端をドラッグで縮める・伸ばす、上の角のつまみでフェード\n右クリックでメニュー（複製・分割・フェード・削除）';
        clipEl.setAttribute('aria-label', `クリップ「${clip.name}」（「${track.name}」、${clip.offset.toFixed(1)} 秒から、長さ ${len.toFixed(1)} 秒${extra ? `、${extra}` : ''}）`);
        // フェードのつまみは、フェードの終わり (始まり) の位置に置く。端のつまみ (6px) とは重ねない
        const showFades = width >= FADE_HANDLE_MIN_WIDTH;
        const place = (el, px, side, on) => {
            if (!el) return;
            el.style.display = showFades ? '' : 'none';
            el.style[side] = Math.max(6, Math.min(width - 28, px - 5)) + 'px';
            el.classList.toggle('set', on);
        };
        place(clipEl.querySelector('.clip-fade.in'), fadeIn * pps, 'left', fadeIn > 0);
        place(clipEl.querySelector('.clip-fade.out'), fadeOut * pps, 'right', fadeOut > 0);
        this._drawClipWave(clipEl, clip, true);
    }
    /** 秒の位置を、拍の線 (1 小節目の位置から数えた拍) に吸い付ける。クリップの移動と同じ決まり。 */
    _snapSec(sec) {
        const beatSec = 60 / engine.bpm, origin = engine.gridOffset;
        let snapped = origin + Math.round((sec - origin) / beatSec) * beatSec;
        if (snapped < 0) snapped += beatSec * Math.ceil(-snapped / beatSec);
        return snapped;
    }
    /**
     * クリップの端 (縮める・伸ばす) か、フェードのつまみを動かし始める。
     * 動かしているあいだは見た目だけを変え、離したときに 1 つの記録としてトラックに入れる (クリップの移動と同じ)。
     * @param kind - 'trim-start' / 'trim-end' / 'fade-in' / 'fade-out'
     */
    _beginClipDrag(e, kind, trackId, clipIndex, clipEl) {
        // 右クリックは、クリップのメニューに任せる
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip) return;
        const len = playLength(clip);
        // つまんだ位置と、動かすもの (端・フェードの終わり) の位置のずれ。押しただけでは動かないようにする
        const at = kind === 'trim-start' ? clip.offset : kind === 'trim-end' ? clip.offset + len
            : kind === 'fade-in' ? clip.offset + fadeInOf(clip) : clip.offset + len - fadeOutOf(clip);
        const x = e.clientX - clipEl.parentElement.getBoundingClientRect().left;
        this.clipEdit = { kind, trackId, clipIndex, element: clipEl, original: clip, next: clip, grab: x - at * this.pixelsPerSecond, at, moved: false };
        clipEl.classList.add('dragging');
    }
    /** 端かつまみを動かしている途中: マウスの位置から、動かした後のクリップを作って、見た目に当てる。 */
    _moveClipDrag(e) {
        const d = this.clipEdit, track = engine.getTrack(d.trackId);
        if (!track || !d.element.parentElement) return;
        const x = e.clientX - d.element.parentElement.getBoundingClientRect().left - d.grab;
        let sec = Math.max(0, x / this.pixelsPerSecond);
        const original = d.original;
        // 動かそうとした向きと、拍にそろえたか (離したときに何も変わらなかったら、理由を知らせるのに使う)
        d.moved = true; d.wantedDelta = x / this.pixelsPerSecond - (d.at ?? 0); d.snapped = !e.altKey;
        if (d.kind === 'trim-start' || d.kind === 'trim-end') {
            // 端は拍に吸い付ける。Option / Alt を押しているあいだは、吸い付けない (波形を見て、細かく決められる)
            if (!e.altKey) sec = this._snapSec(sec);
            d.next = setClipRange(original, d.kind === 'trim-start' ? { start: sec } : { end: sec });
        } else if (d.kind === 'fade-in') {
            d.next = setClipFades(original, { fadeIn: sec - original.offset });
        } else {
            d.next = setClipFades(original, { fadeOut: original.offset + playLength(original) - sec });
        }
        this._layoutClip(d.element, d.next, track);
    }
    /** 端かつまみを離した: 動かした後のクリップをトラックに入れる (動かしていなければ、何もしない)。 */
    _endClipDrag() {
        const d = this.clipEdit;
        this.clipEdit = null;
        d.element.classList.remove('dragging');
        const track = engine.getTrack(d.trackId);
        // 動かしているあいだに、クリップが入れ替わっていたら (元に戻す、アシスタントの操作)、入れない
        if (track && track.clips[d.clipIndex] === d.original) {
            const changed = this._commitClip(d.trackId, d.clipIndex, d.next, d.kind.startsWith('fade') ? 'fade' : 'range');
            // ドラッグしたのに何も変わらなかったときは、黙って戻さずに、理由を知らせる
            if (!changed && d.moved && this.onStatus) this.onStatus(this._dragBlocked(d), 'hint');
        } else {
            this.render(this._pianoRoll);
        }
    }
    /** 端かつまみをドラッグしたのに、何も変わらなかった理由 (と、どうすれば変えられるか)。 */
    _dragBlocked(d) {
        const outward = d.kind === 'trim-start' || d.kind === 'fade-in' ? d.wantedDelta < 0 : d.wantedDelta > 0;
        if (d.kind === 'trim-start' || d.kind === 'trim-end') {
            if (outward) return 'クリップの端は、音声の端より外へは伸ばせません。縮めたぶんだけ、引き戻せます';
            return d.snapped
                ? '端は拍にそろうので、動きませんでした。もう少し大きく動かすか、Option（Alt）を押しながらドラッグすると、細かく動かせます'
                : 'クリップは、これより短くできません';
        }
        if (outward) return 'フェードを付けるには、つまみをクリップの内側へドラッグしてください';
        return 'フェードは、これより長くできません（フェードインとフェードアウトは、重ねられません）';
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
        // キーボードで選んでいたクリップを覚えておく。行を作り直した後、同じ場所のクリップにフォーカスを戻す
        // (分割やフェードの後に、続けてキーで操作できるように。描き直しは、ノートの変更などでも起きる)
        const active = document.activeElement;
        const focusedClip = active instanceof HTMLElement && active.classList.contains('clip') && this.container.contains(active)
            ? { trackId: active.dataset.trackId, clipIndex: active.dataset.clipIndex } : null;
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
                clipEl.dataset.trackId = track.id; clipEl.dataset.clipIndex = ci;
                // 波形 (canvas) の手前に、名前を文字として出す。クリップの中の文字は、名前だけにする
                const wave = document.createElement('canvas'); wave.className = 'clip-wave'; wave.setAttribute('aria-hidden', 'true');
                const nameEl = document.createElement('span'); nameEl.className = 'clip-name'; nameEl.textContent = clip.name;
                clipEl.append(wave, nameEl);
                // 左右の端 (縮める・伸ばす) と、上の角のつまみ (フェード)。マウスで使う。
                // キーボードでは、メニューの「再生位置で分割」「フェード…」を使う
                [
                    ['trim-start', 'clip-edge left', '左右にドラッグすると、クリップの頭を縮めます（音の位置は動きません）。縮めたぶんは、引き戻せば戻ります\n拍にそろいます。Option（Alt）を押しているあいだは、そろえません'],
                    ['trim-end', 'clip-edge right', '左右にドラッグすると、クリップの終わりを縮めます。縮めたぶんは、引き戻せば戻ります\n拍にそろいます。Option（Alt）を押しているあいだは、そろえません'],
                    ['fade-in', 'clip-fade in', '右へドラッグすると、頭の音量をだんだん上げます（フェードイン）。左の端まで戻すと外れます'],
                    ['fade-out', 'clip-fade out', '左へドラッグすると、終わりの音量をだんだん下げます（フェードアウト）。右の端まで戻すと外れます'],
                ].forEach(([kind, className, tipText]) => {
                    const handle = document.createElement('span');
                    handle.className = className; handle.dataset.tip = tipText; handle.setAttribute('aria-hidden', 'true');
                    handle.addEventListener('mousedown', (e) => this._beginClipDrag(e, kind, track.id, ci, clipEl));
                    clipEl.appendChild(handle);
                });
                // キーボードでも選べる。Delete で削除、S で再生位置で分割、Shift+F10 かメニューキーでメニュー
                clipEl.tabIndex = 0;
                clipEl.setAttribute('role', 'button');
                clipEl.setAttribute('aria-haspopup', 'menu');
                clipEl.setAttribute('aria-keyshortcuts', 'S Delete Shift+F10');
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
                    } else if ((e.key === 's' || e.key === 'S') && !hasPrimaryModifier(e) && !e.altKey) {
                        // S: 再生位置で分割 (⌘S の保存とは別。修飾キーが在るときは受けない)
                        e.preventDefault(); e.stopPropagation();
                        this.splitClipAtPlayhead(track.id, ci);
                    }
                });
                canvasWrap.appendChild(clipEl);
                // 行に入れてから、位置と波形を当てる (波形は、見えている範囲を行の中の位置から決める)
                this._layoutClip(clipEl, clip, track);
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
                    // ファイルではないもの (文字や画像の一部など) を落とした
                    else this.onStatus('追加できるファイルがありませんでした。音声ファイル（WAV・MP3・FLAC など）を、ここへドロップしてください', 'hint');
                }
                if (added.length > 0 && this.onTracksChanged) this.onTracksChanged();
            });
            row.appendChild(canvasWrap); this.container.appendChild(row);
        });
        this._bindTrackEvents(pianoRoll);
        // 選んでいたクリップに、フォーカスを戻す (スクロールは動かさない)
        if (focusedClip) {
            this.container.querySelector(`.clip[data-track-id="${focusedClip.trackId}"][data-clip-index="${focusedClip.clipIndex}"]`)
                ?.focus({ preventScroll: true });
        }
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
                this.selectTrack(parseInt(h.dataset.trackId));
            });
        });
        this.container.querySelectorAll('.btn-track-play').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track), track = engine.getTrack(id);
                if (!track) return;
                if (engine.isPlaying && engine.soloTrackId === id) { engine.pause(); if (this.onStatus) this.onStatus('一時停止'); }
                else {
                    engine.playSingleTrack(id);
                    // 鳴らすものが無い・ミュート中のときは、再生は進むが何も聞こえない。その理由を知らせる
                    if (!this.onStatus) { /* 知らせる先が無い */ }
                    else if (engine.getTrackDuration(id) <= 0) this.onStatus(`「${track.name}」には、まだ鳴らすものがありません。ノートを置くか、音声ファイルを追加すると鳴ります`, 'hint');
                    else if (track.mute) this.onStatus(`「${track.name}」はミュート中なので、再生しても聞こえません。M を押してミュートを解くと鳴ります`, 'hint');
                    else this.onStatus(`再生中: ${track.name}`);
                }
                this._renderKeepingFocus(pianoRoll, '.btn-track-play', id);
            });
        });
        this.container.querySelectorAll('.btn-mute').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track), track = engine.getTrack(id);
                if (track) this.setMute(id, !track.mute);
            });
        });
        this.container.querySelectorAll('.btn-solo').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.track), track = engine.getTrack(id);
                if (track) this.setSolo(id, !track.solo);
            });
        });
        this.container.querySelectorAll('.btn-track-menu').forEach(btn => {
            btn.addEventListener('click', () => {
                const rect = btn.getBoundingClientRect();
                this.openTrackMenu(parseInt(btn.dataset.track), rect.left, rect.bottom + 2);
            });
        });
        // 音量とパン。値を変えるのは setGain / setPan (動かしているあいだは 1 つの記録にまとまる)
        const bindSlider = (selector, read, set) => {
            this.container.querySelectorAll(selector).forEach(input => {
                const id = parseInt(input.dataset.track);
                input.addEventListener('input', () => set(id, read(input)));
                // ダブルクリックで、既定の値 (0 dB・中央) に戻す
                input.addEventListener('dblclick', () => { input.value = '0'; set(id, 0); });
            });
        };
        bindSlider('.gain-slider', (el) => Number(el.value), (id, v) => this.setGain(id, v));
        bindSlider('.pan-slider', (el) => Number(el.value) / PAN_STEPS, (id, v) => this.setPan(id, v));
    }
    /**
     * 空のトラックを 1 本、いちばん下に足す (元に戻せる)。「+ トラック追加」とアシスタントが使う。
     * @param name - トラックの名前。省略すると「Track N」
     * @returns 足したトラック
     */
    addTrack(name) {
        const track = this.history.record('トラックを追加', () => engine.addTrack(name || undefined));
        if (this.onTracksChanged) this.onTracksChanged();
        if (this.onStatus) this.onStatus(`「${track.name}」を追加しました`);
        return track;
    }
    /**
     * トラックをピアノロールで開く (トラックの見出しを押したときと同じ)。
     * @returns 開いたら true (トラックが無ければ false)
     */
    selectTrack(trackId) {
        const id = Number(trackId), track = engine.getTrack(id), pianoRoll = this._pianoRoll;
        if (!track) return false;
        if (pianoRoll) { pianoRoll.switchToTrack(id); this.render(pianoRoll); }
        if (this.onStatus) this.onStatus(`ピアノロール: ${track.name}`);
        return true;
    }
    /**
     * ミュートを入れる・外す (元に戻せる)。いまと同じなら何もしない。
     * @param on - true でミュートする
     */
    setMute(trackId, on) {
        const id = Number(trackId), track = engine.getTrack(id);
        if (!track || track.mute === !!on) return;
        this.history.record(track.mute ? `「${track.name}」のミュートを解除` : `「${track.name}」をミュート`, () => engine.toggleMute(id));
        this._renderKeepingFocus(this._pianoRoll, '.btn-mute', id);
    }
    /**
     * ソロを入れる・外す (元に戻せる)。いまと同じなら何もしない。
     * @param on - true でソロにする
     */
    setSolo(trackId, on) {
        const id = Number(trackId), track = engine.getTrack(id);
        if (!track || track.solo === !!on) return;
        this.history.record(track.solo ? `「${track.name}」のソロを解除` : `「${track.name}」をソロ`, () => {
            track.solo = !track.solo;
            // デスクトップ版 (Rust の engine) では、再生中でもすぐ効かせる。Web Audio では、次に鳴らし直すときから効く
            engine.syncNative();
        });
        this._renderKeepingFocus(this._pianoRoll, '.btn-solo', id);
    }
    /**
     * 音量かパンを変える (元に戻せる)。つまみを動かしているあいだのように、続けて変えたぶんは 1 つの記録にまとめる
     * (元に戻すと、動かす前の値に戻る)。行は描き直さない (描き直すと、つまみのドラッグが途切れる)。
     */
    _setMix(trackId, key, value) {
        const id = Number(trackId), track = engine.getTrack(id);
        if (!track) return;
        const gain = key === 'gain';
        this.history.record(`「${track.name}」の${gain ? '音量' : 'パン'}を変更`,
            () => { if (gain) engine.updateTrackGain(id, value); else engine.updateTrackPan(id, value); },
            { coalesceKey: `${key}:${id}`, coalesceMs: 1500 });
        const header = this.container?.querySelector(`.track-header[data-track-id="${id}"]`);
        if (header) this._showMix(header, track);
    }
    /**
     * 音量を変える (元に戻せる)。
     * @param db - 音量 (dB。lib/mix.ts の範囲に収める)
     */
    setGain(trackId, db) { this._setMix(trackId, 'gain', clampGainDb(Number(db))); }
    /**
     * パンを変える (元に戻せる)。
     * @param pan - パン (-1 = 左 〜 1 = 右)
     */
    setPan(trackId, pan) { this._setMix(trackId, 'pan', clampPan(Number(pan))); }
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
     * クリップのメニュー (複製・再生位置で分割・フェード…・削除) を開く。
     * @param trackId - トラック ID
     * @param clipIndex - クリップの番号
     * @param x - 左上の位置 (画面の座標)
     * @param y - 左上の位置 (画面の座標)
     */
    openClipMenu(trackId, clipIndex, x, y) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip || !this.onMenu) return;
        const blocked = this.splitBlocked(clip);
        this.onMenu({
            label: `クリップ「${clip.name}」のメニュー`, x, y,
            returnFocus: () => this.container.querySelector(`.clip[data-track-id="${trackId}"][data-clip-index="${clipIndex}"]`),
            items: [
                { label: '複製', action: () => this.duplicateClip(trackId, clipIndex), title: 'すぐ後ろに同じクリップを置きます（縮めた範囲とフェードも、そのまま写します）' },
                // 再生位置がクリップの外なら押せない。理由は説明に出し、押すと知らせとしても出る (lib/notice.ts の blockedBy)
                {
                    label: '再生位置で分割', action: () => this.splitClipAtPlayhead(trackId, clipIndex),
                    disabled: !!blocked, blocked: blocked ?? undefined,
                    title: blocked ?? '再生位置の線のところで、クリップを 2 つに分けます（S キーでも分けられます）',
                },
                {
                    label: 'フェード…', action: () => this.onFadeDialog?.({ trackId, clipIndex }), restoreFocus: false,
                    title: '頭と終わりの音量を、だんだん上げる・下げる長さを、秒で決めます',
                },
                { label: '削除', action: () => this.deleteClip(trackId, clipIndex), danger: true, title: '削除した後も、「元に戻す」で戻せます' },
            ],
        });
    }
    /**
     * 再生位置でクリップを分割できない理由。分割できるなら null。
     * 再生位置は、クリップの中 (両側に少しでも残る位置) に無ければならない。
     */
    splitBlocked(clip) {
        const at = engine.getCurrentTime(), start = clip.offset, end = clip.offset + playLength(clip);
        if (at <= start || at >= end) {
            return `再生位置（${at.toFixed(1)} 秒）が、このクリップの中（${start.toFixed(1)}〜${end.toFixed(1)} 秒）に在りません。分けたい場所へ再生位置を動かしてから、分割してください`;
        }
        if (at < start + MIN_CLIP_SEC || at > end - MIN_CLIP_SEC) return '再生位置が、クリップの端に近すぎます。端から少し離れた場所で分割してください';
        return null;
    }
    /**
     * 範囲かフェードを変えたクリップを、トラックに入れる (元に戻せる)。変わっていなければ、描き直すだけ。
     * 端やつまみのドラッグ・フェードの窓・アシスタントが、どれもここを通る。
     * @param kind - 'range' (縮める・伸ばす) / 'fade'
     * @returns 変えたら true
     */
    _commitClip(trackId, clipIndex, next, kind) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip) return false;
        const before = { offset: clip.offset, len: playLength(clip), fadeIn: fadeInOf(clip), fadeOut: fadeOutOf(clip) };
        const after = { offset: next.offset, len: playLength(next), fadeIn: fadeInOf(next), fadeOut: fadeOutOf(next) };
        const same = (a, b) => Math.abs(a - b) < 1e-9;
        const rangeChanged = !same(before.offset, after.offset) || !same(before.len, after.len);
        const changed = rangeChanged || !same(before.fadeIn, after.fadeIn) || !same(before.fadeOut, after.fadeOut);
        if (changed) {
            this.history.record(kind === 'fade' ? `クリップ「${clip.name}」のフェードを変更` : `クリップ「${clip.name}」の長さを変更`,
                () => { track.clips[clipIndex] = next; });
        }
        // 描き直しても、キーボードで選んでいたクリップにフォーカスが残る (render が戻す)
        this.render(this._pianoRoll);
        if (!changed) return false;
        if (this.onStatus) {
            if (kind === 'fade') {
                this.onStatus(after.fadeIn === 0 && after.fadeOut === 0
                    ? `クリップ「${clip.name}」のフェードを外しました`
                    : `クリップ「${clip.name}」のフェード: フェードイン ${formatSeconds(after.fadeIn)} 秒、フェードアウト ${formatSeconds(after.fadeOut)} 秒`);
            } else {
                const verb = after.len < before.len - 1e-9 ? '縮めました' : after.len > before.len + 1e-9 ? '伸ばしました' : '変えました';
                this.onStatus(`クリップ「${clip.name}」を${verb}（${after.offset.toFixed(1)} 秒から、長さ ${after.len.toFixed(1)} 秒）`);
            }
        }
        if (this.onTracksChanged) this.onTracksChanged();
        return true;
    }
    /**
     * クリップの端を動かす (縮める・伸ばす。元に戻せる)。音声は書き換えず、音の位置も動かない。
     * 端のドラッグと同じ処理 (lib/clip.ts の `setClipRange`)。アシスタントが使う。
     * @param range.start - 新しい左の端 (曲の時刻、秒)
     * @param range.end - 新しい右の端 (曲の時刻、秒)
     * @returns 変えたら true
     */
    trimClip(trackId, clipIndex, range) {
        const clip = engine.getTrack(trackId)?.clips[clipIndex];
        if (!clip) return false;
        const changed = this._commitClip(trackId, clipIndex, setClipRange(clip, range), 'range');
        if (!changed && this.onStatus) this.onStatus(`クリップ「${clip.name}」は、すでにその範囲です（音声の端より外へは伸ばせません）`, 'hint');
        return changed;
    }
    /**
     * フェードインとフェードアウトの長さを決める (元に戻せる)。0 で外す。指定しなかったほうは変えない。
     * つまみのドラッグ・フェードの窓・アシスタントが使う (lib/clip.ts の `setClipFades`)。
     * @returns 変えたら true
     */
    setClipFades(trackId, clipIndex, fades) {
        const clip = engine.getTrack(trackId)?.clips[clipIndex];
        if (!clip) return false;
        const changed = this._commitClip(trackId, clipIndex, setClipFades(clip, fades), 'fade');
        if (!changed && this.onStatus) this.onStatus(`クリップ「${clip.name}」のフェードは、すでにその長さです`, 'hint');
        return changed;
    }
    /**
     * クリップを、曲の時刻 `atSec` で 2 つに分ける (元に戻せる)。2 つは同じ音声を指す (音声は写さない)。
     * メニュー・S キー・アシスタントが使う (lib/clip.ts の `splitClip`)。
     * @returns 分けたら true (位置がクリップの外なら false)
     */
    splitClipAt(trackId, clipIndex, atSec) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip) return false;
        const parts = splitClip(clip, atSec);
        if (!parts) return false;
        this.history.record(`クリップ「${clip.name}」を分割`, () => { track.clips.splice(clipIndex, 1, ...parts); });
        // 描き直しても、キーボードで選んでいたクリップにフォーカスが残る (render が戻す)
        this.render(this._pianoRoll);
        if (this.onStatus) this.onStatus(`クリップ「${clip.name}」を、${formatSeconds(atSec)} 秒の位置で 2 つに分けました`);
        if (this.onTracksChanged) this.onTracksChanged();
        return true;
    }
    /** 再生位置でクリップを分割する。再生位置がクリップの外なら、分けずに理由を知らせる。 */
    splitClipAtPlayhead(trackId, clipIndex) {
        const clip = engine.getTrack(trackId)?.clips[clipIndex];
        if (!clip) return false;
        const blocked = this.splitBlocked(clip);
        if (blocked) { if (this.onStatus) this.onStatus(blocked, 'hint'); return false; }
        return this.splitClipAt(trackId, clipIndex, engine.getCurrentTime());
    }

    /**
     * トラックを消す (元に戻せる)。確かめの窓は出さず、「元に戻す」付きの知らせを出す。
     * @param options.toast - false なら、「元に戻す」付きの知らせを出さない (アシスタントが消したとき。
     *   依頼ごとの記録がまだ開いていて、知らせの「元に戻す」が指す記録が無いため。戻すのは、チャットの「元に戻す」)
     */
    deleteTrack(trackId, options = {}) {
        const track = engine.getTrack(trackId), pianoRoll = this._pianoRoll;
        if (!track) return;
        this.history.record(`「${track.name}」を削除`, () => {
            if (pianoRoll && pianoRoll.getActiveTrackId() === trackId) pianoRoll.switchToTrack(null);
            engine.removeTrack(trackId);
        });
        this.render(pianoRoll);
        if (this.onTracksChanged) this.onTracksChanged();
        if (this.onStatus) this.onStatus(`「${track.name}」を削除しました`);
        if (this.onUndoToast && options.toast !== false) this.onUndoToast(`「${track.name}」を削除しました`);
    }
    /**
     * クリップを消す (元に戻せる)。確かめの窓は出さず、「元に戻す」付きの知らせを出す。
     * @param options.toast - false なら、「元に戻す」付きの知らせを出さない (アシスタントが消したとき。`deleteTrack` と同じ理由)
     */
    deleteClip(trackId, clipIndex, options = {}) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip) return;
        this.history.record(`クリップ「${clip.name}」を削除`, () => engine.removeClip(trackId, clipIndex));
        this.render(this._pianoRoll);
        const message = `クリップ「${clip.name}」を「${track.name}」から削除しました`;
        if (this.onStatus) this.onStatus(message);
        if (this.onUndoToast && options.toast !== false) this.onUndoToast(message);
        if (this.onTracksChanged) this.onTracksChanged();
    }
    /**
     * クリップを、タイムラインの上の別の位置へ動かす (元に戻せる)。ドラッグで動かすのと同じ。アシスタントが使う。
     * @param offsetSec - 新しい始まりの位置 (秒。0 より前にはならない)
     */
    moveClip(trackId, clipIndex, offsetSec) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip) return;
        this.history.record('クリップを移動', () => engine.moveClip(trackId, clipIndex, offsetSec));
        this.render(this._pianoRoll);
        if (this.onStatus) this.onStatus(`クリップ「${clip.name}」を ${Math.max(0, offsetSec).toFixed(1)} 秒へ動かしました`);
        if (this.onTracksChanged) this.onTracksChanged();
    }
    /** クリップを複製して、すぐ後ろに置く (同じ音声を指す。縮めた範囲とフェードも、そのまま写す。元に戻せる)。 */
    duplicateClip(trackId, clipIndex) {
        const track = engine.getTrack(trackId), clip = track?.clips[clipIndex];
        if (!clip) return;
        // すぐ後ろ = 見えている範囲 (鳴らす長さ) の終わり
        const at = clip.offset + playLength(clip);
        this.history.record(`クリップ「${clip.name}」を複製`, () => {
            track.clips.splice(clipIndex + 1, 0, { ...clip, offset: at });
        });
        this.render(this._pianoRoll);
        if (this.onStatus) this.onStatus(`クリップ「${clip.name}」を複製しました（${at.toFixed(1)} 秒から）`);
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
        } else if (track && name !== null && name !== undefined && !next) {
            if (this.onStatus) this.onStatus(`名前が空なので、「${track.name}」のままにしました`, 'hint');
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
            // 端 (縮める) かフェードのつまみを動かしている途中
            if (this.clipEdit) { this._moveClipDrag(e); return; }
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
            if (this.clipEdit) { this._endClipDrag(); return; }
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
        setStatus, bumpTracks, pianoRollRef, timelineRef, midiRef, trackVersion, bpm, beatsPerBar, gridOffset, swing, followPlayhead,
        record, beginEdit, showUndoToast, practiceOpen, openPractice,
    } = useDaw();
    const { practicePart } = useLearnActions();
    // MIDI 入力の仕組みは 1 つだけ持ち、ふだんの見出しと練習画面の「入力」の両方から使う
    const midi = useMidiInput();
    // 中央エリアの外 (アシスタント) も同じ 1 つを使えるよう、いまの値をストアの ref に載せる
    useEffect(() => {
        midiRef.current = midi;
        return () => { midiRef.current = null; };
    }, [midi, midiRef]);
    const openPracticeRef = useRef(openPractice);
    useEffect(() => { openPracticeRef.current = openPractice; }, [openPractice]);
    // 開いているメニュー (クリップの右クリック、トラックの「…」)
    const [menu, setMenu] = useState(null);
    // フェードの長さを秒で決める窓 (クリップのメニューの「フェード…」)。開いていなければ null
    const [fadeTarget, setFadeTarget] = useState(null);
    // ピアノロールの表示の大きさ (+/- のボタンの押せる・押せない)
    const [zoom, setZoom] = useState({ canZoomInX: true, canZoomOutX: true, canZoomInY: true, canZoomOutY: true });
    // 選んでいるノートの強さ (見出しの「強さ」の欄)
    const [velocity, setVelocity] = useState({ count: 0, value: null, unset: 0 });
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
        pr.onSelection = setVelocity;
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
        tl.onFadeDialog = setFadeTarget;
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

    // スウィング (プロジェクトの値) が変わったら、吸い付く位置とグリッドの線を作り直す
    // (選び直したとき、プロジェクトを開いたとき、元に戻したとき)
    useEffect(() => { pianoRollRef.current?.refreshSnap?.(); }, [swing, pianoRollRef]);

    const handleAddTrack = useCallback(() => { timelineRef.current?.addTrack(); }, [timelineRef]);

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
                    <div className="area-label">タイムライン <span className="area-hint">（音声ファイルをドロップして追加 / クリップをドラッグで移動、端をドラッグで縮める / 右クリックでメニュー）</span></div>
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
                    <VelocityBar summary={velocity} open={activeTrackId !== null}
                        onSet={(v) => pianoRollRef.current?.setSelectionVelocity(v)}
                        onNudge={(d) => pianoRollRef.current?.nudgeSelectionVelocity(d)} />
                    {/* 刻み (ノートを置く・動かすときに吸い付く間隔) とスウィング。練習画面でも同じものを出す */}
                    <SnapBar activeTrackId={activeTrackId} />
                    {/* キーの音・コードの音の色分け (カルテから。練習画面でも同じものを出す) */}
                    <PitchHintBar activeTrackId={activeTrackId} />
                    {/* 表示の大きさ。Cmd (Ctrl) + ホイールか、トラックパッドのピンチでも横の大きさを変えられる */}
                    <span className="piano-zoom" role="group" aria-label="ピアノロールの表示の大きさ">
                        <span className="area-hint" aria-hidden="true">横</span>
                        <button type="button" aria-label="横に縮める" {...tip('横に縮めて、広い範囲を見渡します\nCmd か Ctrl を押しながらホイールでも変わります')}
                            disabled={!zoom.canZoomOutX} {...blockedBy(!zoom.canZoomOutX && 'これ以上は、横に縮められません（いちばん広く見渡せる大きさです）')} onClick={() => zoomBy('x', -1)}>−</button>
                        <button type="button" aria-label="横に広げる" {...tip('横に広げて、細かいタイミングを見やすくします\nCmd か Ctrl を押しながらホイールでも変わります')}
                            disabled={!zoom.canZoomInX} {...blockedBy(!zoom.canZoomInX && 'これ以上は、横に広げられません（いちばん細かく見える大きさです）')} onClick={() => zoomBy('x', 1)}>＋</button>
                        <span className="area-hint" aria-hidden="true">縦</span>
                        <button type="button" aria-label="縦に縮める" {...tip('縦に縮めて、広い音域を見渡します')} disabled={!zoom.canZoomOutY} {...blockedBy(!zoom.canZoomOutY && 'これ以上は、縦に縮められません（いちばん広い音域が見える大きさです）')} onClick={() => zoomBy('y', -1)}>−</button>
                        <button type="button" aria-label="縦に広げる" {...tip('縦に広げて、ノートを押しやすくします')} disabled={!zoom.canZoomInY} {...blockedBy(!zoom.canZoomInY && 'これ以上は、縦に広げられません（いちばん大きい表示です）')} onClick={() => zoomBy('y', 1)}>＋</button>
                    </span>
                </div>
                <PianoInstrument activeTrackId={activeTrackId} />
                {practiceOpen && <PracticeBands />}
                <div id="piano-roll-body">
                    <div ref={keysRef} id="piano-keys" data-tip-side="right" data-tip-box="" />
                    {/* フォーカスを受けて、キーの操作 (矢印・Cmd+A/C/X/V/D・Delete) を受ける */}
                    <div ref={pianoWrapRef} id="piano-grid-wrap" tabIndex={0} role="group"
                        aria-label="ピアノロールのノート（矢印キーで選んだノートを動かす。Option + ↑↓ で強さを変える。Cmd か Ctrl + A で全部選ぶ）">
                        <canvas ref={pianoCanvasRef} id="piano-grid-canvas" />
                        <div ref={noteLayerRef} id="note-layer" />
                    </div>
                </div>
            </div>
            {practiceOpen && <PracticeSide />}
            {practiceOpen && <PracticeControls />}
            <PopupMenu request={menu} onClose={() => setMenu(null)} />
            {fadeTarget && <ClipFadeDialog target={fadeTarget} timelineRef={timelineRef} onClose={() => setFadeTarget(null)} />}
        </div>
        </PracticeProvider>
    );
}
