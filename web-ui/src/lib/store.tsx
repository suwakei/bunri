/**
 * bunri DAW — グローバル状態管理（React Context ベース）
 */
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import engine, { type PianoNote } from './engine';
import { describeError } from './api';
import type { ChartResponse, Glossary, SongChart, WaveformPeaks } from './chart';
import type { DiffResult } from './coach';
import { gridFromChart, roundBpm, secToStep, stepToSec } from './grid';
import { LEFT_WIDTH_DEFAULT, LEFT_WIDTH_MAX, LEFT_WIDTH_MIN, readStored, writeStored } from './storage';
import { UndoHistory, type PushOptions } from './history';
import { HISTORY_BUDGET, HISTORY_LIMIT, applyProject, captureProject, projectsEqual, snapshotCost, type ProjectSnapshot } from './project-snapshot';

/** 「〜を削除しました — 元に戻す」の知らせ。 */
export interface UndoToastState {
    /** 知らせの番号（同じ文が続いても、出し直しを見分ける） */
    id: number;
    /** 知らせの文（「「Track 1」を削除しました」） */
    message: string;
    /** この知らせの「元に戻す」で戻す記録。その後に別の操作をしたら、戻さない */
    entryId: number | null;
}

/** 編集の記録を始めたときに返す、記録を終える関数。操作で何かが変わっていたら記録して true を返す。 */
export type CommitEdit = (override?: { label?: string }) => boolean;

/** ステータスバーの文の種類。`error` は失敗の知らせで、色を変えて読み上げの対象にする。 */
export type StatusKind = 'info' | 'error';

/** 左パネルのタブの識別子。学ぶ（取り込み → カルテ → ガイド → 差分チェック）/ 音作り / ファイル。 */
export type LeftTab = 'learn' | 'sound' | 'file';

/** 「学ぶ」タブの中の段。曲とパート / カルテ / 再現ガイド / 差分チェック。 */
export type LearnTab = 'song' | 'chart' | 'guide' | 'coach';

/** 「音作り」タブの中の段。 */
export type SoundTab = 'synth' | 'drum' | 'fx';

/** お手本の重ね方。auto: 開いているトラックのお手本（練習のトラックなら、そのパートのお手本）/ off / 数値: そのトラックのお手本 */
export type GhostChoice = 'auto' | 'off' | number;

/** 差分チェックで比べる組（お手本を持つトラックと、打ち込みのトラック）。null は「既定のもの」。 */
export interface CoachPair {
    referenceId: number | null;
    attemptId: number | null;
}

/** 最後に比べた結果。どの組で比べたかも持つ（組を変えたら古い結果を出さないため）。 */
export interface CoachResult {
    referenceId: number;
    attemptId: number;
    result: DiffResult;
}

/**
 * 移動の行き先。秒かステップのどちらかで指す（両方あれば秒を使う）。
 * `pitch` を付けると、ピアノロールをその高さまで縦にも動かす。
 */
export interface JumpTarget {
    sec?: number;
    step?: number;
    pitch?: Pick<PianoNote, 'note' | 'octave'>;
}


/**
 * DAW グローバル状態のコンテキスト型定義。
 * AudioEngine への参照と、UI 全体で共有される状態・操作関数を提供する。
 */
export interface DawContextType {
    /** WebAudio 再生エンジンのシングルトン */
    engine: typeof engine;
    /** ステータスバーに表示するメッセージ */
    status: string;
    /** ステータスバーの文の種類（失敗の知らせなら `error`） */
    statusKind: StatusKind;
    /**
     * @param msg - 表示するステータスメッセージ
     * @param kind - 失敗の知らせなら `'error'`（省略時は `'info'`）
     */
    setStatus: (msg: string, kind?: StatusKind) => void;
    /** ヒントテキスト */
    hint: string;
    /** @param msg - 表示するヒントメッセージ */
    setHint: (msg: string) => void;
    /**
     * 時間のかかる処理が走っているか（プログレスバーの表示フラグ）。
     * 処理を始めるボタンは、これが true のあいだ押せなくする（二重に始めないため）。
     */
    showProgress: boolean;
    /**
     * 非同期処理をプログレス表示付きで実行するラッパー。
     * 失敗したときは、理由をステータスバーに失敗の知らせとして出す。
     * @param msg - 処理中に表示するステータスメッセージ
     * @param fn - 実行する非同期関数
     */
    withProgress: (msg: string, fn: () => Promise<void>) => Promise<void>;
    /** ウェルカムガイドの表示フラグ */
    showGuide: boolean;
    /** @param v - true でガイドを表示 */
    setShowGuide: (v: boolean) => void;
    /** ガイドを閉じ、localStorage に既読フラグを保存する */
    closeGuide: () => void;
    /** 現在の BPM */
    bpm: number;
    /**
     * BPM を更新し、AudioEngine にも反映する。
     * @param v - 新しい BPM 値（文字列または数値）
     */
    setBpm: (v: string | number) => void;
    /** 1 小節あたりの拍数 */
    beatsPerBar: number;
    /**
     * 拍子を更新し、AudioEngine にも反映する。
     * @param v - 新しい拍数（文字列または数値）
     */
    setBeatsPerBar: (v: string | number) => void;
    /** 再生中フラグ */
    isPlaying: boolean;
    /** @param v - true で再生中状態にする */
    setIsPlaying: (v: boolean) => void;
    /** メトロノーム有効フラグ */
    metronomeEnabled: boolean;
    /** @param v - true でメトロノームを有効にする */
    setMetronomeEnabled: (v: boolean) => void;
    /** トラックリスト変更を検知するためのバージョンカウンタ */
    trackVersion: number;
    /** trackVersion をインクリメントしてトラックリストの再レンダリングをトリガーする */
    bumpTracks: () => void;
    /** PianoRoll コンポーネントへの ref */
    pianoRollRef: React.MutableRefObject<any>;
    /** Timeline コンポーネントへの ref */
    timelineRef: React.MutableRefObject<any>;
    /** 左パネルで開いているタブ */
    leftTab: LeftTab;
    /** @param tab - 開くタブ。解析が終わったときにカルテを開く、といった画面の側からの切り替えにも使う */
    setLeftTab: (tab: LeftTab) => void;
    /** 「学ぶ」タブの中で開いている段 */
    learnTab: LearnTab;
    /** @param tab - 開く段（「学ぶ」タブそのものは開かない。両方なら `openLearn`） */
    setLearnTab: (tab: LearnTab) => void;
    /** 「学ぶ」タブを開き、その中の段を開く。進み具合の段階を押したとき、解析が終わったときに使う */
    openLearn: (tab: LearnTab) => void;
    /** 「音作り」タブの中で開いている段 */
    soundTab: SoundTab;
    /** @param tab - 開く段 */
    setSoundTab: (tab: SoundTab) => void;
    /** 左パネルの幅（px）。利用者が境目を動かして変えられる。この画面を開いた人ごとに覚える */
    leftWidth: number;
    /** @param px - 新しい幅。範囲（LEFT_WIDTH_MIN〜MAX）に収める */
    setLeftWidth: (px: number) => void;

    /** 1 小節目の 1 拍目の位置（秒）。ピアノロールのステップ 0（lib/grid.ts） */
    gridOffset: number;
    /** @param sec - 新しい位置（秒）。再生エンジンにも反映する */
    setGridOffset: (sec: number) => void;
    /**
     * カルテのグリッド（テンポ・拍子・1 小節目の位置）をプロジェクトに当てる。
     * お手本（パート分離で採譜したノート）が在るときは当てない。お手本は採譜したときのグリッドに
     * 載っているので、グリッドだけ変えると原曲の音とずれるため。
     * パートに分け直す直前は `force` で当てる（お手本は作り直すので、ずれない）。
     * @returns 当てたら true
     */
    applyChartGrid: (chart: SongChart, options?: { force?: boolean }) => boolean;
    /** 取り込んだ原曲のファイル。パートに分けるときに、もう一度送る */
    songFile: File | null;
    /** @param file - 取り込んだファイル */
    setSongFile: (file: File | null) => void;
    /** 曲を取り込むとき、テンポを自動で検出するか（false なら、いまの BPM で解析する） */
    autoBpm: boolean;
    /** @param v - true で自動で検出する */
    setAutoBpm: (v: boolean) => void;
    /** 原曲のファイルを選ぶ欄（画面に 1 つだけ。DawPage の SongPicker）。押すとファイルの選択が開く */
    songPickerRef: React.MutableRefObject<HTMLInputElement | null>;
    /** 原曲のファイルの選択を開く */
    openSongPicker: () => void;
    /** お手本の重ね方（ピアノロールの見出しの「お手本を重ねる」） */
    ghostChoice: GhostChoice;
    /** @param choice - 新しい重ね方 */
    setGhostChoice: (choice: GhostChoice) => void;
    /** 差分チェックで比べる組 */
    coachPair: CoachPair;
    /** @param pair - 新しい組。結果は消す（別の組の結果を出さないため） */
    setCoachPair: (pair: CoachPair) => void;
    /** 最後に比べた結果。まだ比べていなければ null */
    coachResult: CoachResult | null;
    /** @param result - 比べた結果 */
    setCoachResult: (result: CoachResult | null) => void;
    /**
     * 再生位置を移し、タイムラインとピアノロールをそこまでスクロールする。
     * カルテのコード・構成、ガイドの小節、差分チェックの指摘から使う。
     */
    jumpTo: (target: JumpTarget) => void;
    /** 再生中に、再生位置が見えるようにタイムラインとピアノロールを自動でスクロールするか */
    followPlayhead: boolean;
    /** @param v - true で自動でスクロールする */
    setFollowPlayhead: (v: boolean) => void;

    /** 現在読み込まれている楽曲カルテ。未解析なら null */
    chart: SongChart | null;
    /** カルテの識別子。`/api/chart/regrid` に渡す */
    chartId: string | null;
    /** 波形描画用のピーク配列。カルテ本体には含まれない */
    chartPeaks: WaveformPeaks | null;
    /** 初心者向けツールチップの用語辞書 */
    glossary: Glossary;
    /**
     * カルテ API のレスポンスをまとめて状態に反映する。
     * @param result - `/api/chart` または `/api/chart/regrid` のレスポンス
     */
    setChartResult: (result: ChartResponse) => void;
    /** 読み込み済みのカルテを破棄する */
    clearChart: () => void;
    /** グリッド補正モーダルの表示フラグ */
    showGridEditor: boolean;
    /** @param v - true でグリッド補正モーダルを開く */
    setShowGridEditor: (v: boolean) => void;

    // ---- 元に戻す / やり直す（lib/history.ts、lib/project-snapshot.ts） ----
    /** 元に戻せる操作が在るか */
    canUndo: boolean;
    /** やり直せる操作が在るか */
    canRedo: boolean;
    /** 次に元に戻す操作の名前（「ノートを追加」など）。無ければ null */
    undoLabel: string | null;
    /** 次にやり直す操作の名前。無ければ null */
    redoLabel: string | null;
    /** 最後の操作を元に戻す（ピアノロールのドラッグ中は何もしない） */
    undo: () => void;
    /** 元に戻した操作をやり直す */
    redo: () => void;
    /**
     * プロジェクトを書き換える操作を、元に戻せるように記録する。`fn` の前後でプロジェクトの控えを取る。
     * 何も変わらなければ記録しない。記録の中で `record` を呼ぶと、外側の記録にまとまる。
     * @param label - 操作の名前（「ノートを追加」。ボタンの説明と、元に戻したときの知らせに出す）
     * @param fn - 書き換える処理（同期）
     * @param options - 続けて同じ操作をしたら 1 つにまとめる鍵など
     */
    record: <T>(label: string, fn: () => T, options?: PushOptions) => T;
    /**
     * `record` の非同期版。待っているあいだにほかの操作をすると、この記録にまとまる。
     * 待つのは、デコードなど書き換えに直接かかわるところだけにする（API の応答を待つのは、囲む前に済ませる）。
     */
    recordAsync: <T>(label: string, fn: () => Promise<T>, options?: PushOptions) => Promise<T>;
    /**
     * 記録を始める（ドラッグのように、始めと終わりが別のイベントになる操作に使う）。
     * 返す関数を必ず 1 回呼んで終える。
     */
    beginEdit: (label: string, options?: PushOptions) => CommitEdit;
    /** 履歴を全部消す */
    clearHistory: () => void;
    /** 「〜を削除しました — 元に戻す」の知らせ。出していなければ null */
    undoToast: UndoToastState | null;
    /** いま記録した操作について、「元に戻す」付きの知らせを出す（`record` の直後に呼ぶ） */
    showUndoToast: (message: string) => void;
    /** 知らせを閉じる */
    dismissUndoToast: () => void;
    /** 知らせの「元に戻す」。知らせを出した後に別の操作をしていたら、戻さずにそう知らせる */
    undoFromToast: () => void;
}

const DawContext = createContext<DawContextType | null>(null);

/**
 * DAW グローバル状態を提供する Context プロバイダー。
 * アプリのルートを囲むことで、配下の全コンポーネントが `useDaw()` で状態にアクセスできる。
 * @param children - プロバイダーで囲む子コンポーネント
 */
export function DawProvider({ children }: { children: ReactNode }) {
    const [statusState, setStatusState] = useState<{ text: string; kind: StatusKind }>({ text: '準備完了', kind: 'info' });
    const [hint, setHint] = useState('');
    // 走っている処理の数。0 より大きいあいだ、プログレスバーを出す
    // (フラグ 1 つだと、2 つの処理が重なったときに、先に終わったほうがバーを消してしまう)
    const [progressCount, setProgressCount] = useState(0);
    // 初めて開いたときに案内を出す。使い方の画面からは `/?guide=1` で、もう一度出せる
    const [showGuide, setShowGuide] = useState(
        () => !readStored('bunri-guide-seen') || new URLSearchParams(window.location.search).has('guide'),
    );
    // 起動したときは「学ぶ」タブ。曲を取り込むところから始める
    const [leftTab, setLeftTab] = useState<LeftTab>('learn');
    const [learnTab, setLearnTab] = useState<LearnTab>('song');
    const [soundTab, setSoundTab] = useState<SoundTab>('synth');
    const [leftWidth, setLeftWidthState] = useState(() => {
        const stored = Number(readStored('bunri-left-width'));
        return Number.isFinite(stored) && stored >= LEFT_WIDTH_MIN && stored <= LEFT_WIDTH_MAX ? stored : LEFT_WIDTH_DEFAULT;
    });
    const [gridOffset, setGridOffsetState] = useState(0);
    const [songFile, setSongFile] = useState<File | null>(null);
    const songPickerRef = useRef<HTMLInputElement | null>(null);
    const [autoBpm, setAutoBpm] = useState(true);
    const [ghostChoice, setGhostChoice] = useState<GhostChoice>('auto');
    const [coachPair, setCoachPairState] = useState<CoachPair>({ referenceId: null, attemptId: null });
    const [coachResult, setCoachResult] = useState<CoachResult | null>(null);
    const [followPlayhead, setFollowPlayheadState] = useState(() => readStored('bunri-follow-playhead') !== '0');
    const [bpm, setBpmState] = useState(120);
    const [beatsPerBar, setBeatsPerBarState] = useState(4);
    const [isPlaying, setIsPlaying] = useState(false);
    const [metronomeEnabled, setMetronomeEnabled] = useState(false);
    const [trackVersion, setTrackVersion] = useState(0);

    // PianoRoll / Timeline の参照を保持
    const pianoRollRef = useRef<any>(null);
    const timelineRef = useRef<any>(null);

    const [chart, setChart] = useState<SongChart | null>(null);
    const [chartId, setChartId] = useState<string | null>(null);
    const [chartPeaks, setChartPeaks] = useState<WaveformPeaks | null>(null);
    const [glossary, setGlossary] = useState<Glossary>({});
    const [showGridEditor, setShowGridEditor] = useState(false);

    const bumpTracks = useCallback(() => setTrackVersion(v => v + 1), []);

    const setStatus = useCallback((msg: string, kind: StatusKind = 'info') => {
        setStatusState({ text: msg, kind });
    }, []);

    const setChartResult = useCallback((result: ChartResponse) => {
        setChart(result.chart);
        setChartId(result.chart_id);
        // regrid では peaks を返さない場合があるので、その際は既存を保持する
        if (result.peaks) setChartPeaks(result.peaks);
        if (result.glossary) setGlossary(result.glossary);
    }, []);

    const clearChart = useCallback(() => {
        setChart(null);
        setChartId(null);
        setChartPeaks(null);
    }, []);

    // テンポは小数も持つ (カルテの実測のテンポ。整数に丸めると、長い曲の後ろで拍がずれる)
    const setBpm = useCallback((v: string | number) => {
        const parsed = parseFloat(String(v));
        const val = Number.isFinite(parsed) && parsed > 0 ? roundBpm(parsed) : 120;
        setBpmState(val);
        engine.bpm = val;
    }, []);

    const setGridOffset = useCallback((sec: number) => {
        const val = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 10000) / 10000 : 0;
        setGridOffsetState(val);
        engine.gridOffset = val;
    }, []);

    const setBeatsPerBar = useCallback((v: string | number) => {
        const val = parseInt(String(v)) || 4;
        setBeatsPerBarState(val);
        engine.beatsPerBar = val;
    }, []);

    const withProgress = useCallback(async (processingMsg: string, fn: () => Promise<void>) => {
        setProgressCount(n => n + 1);
        setStatus(processingMsg);
        try {
            await fn();
        } catch (e) {
            setStatus(describeError(e), 'error');
        } finally {
            setProgressCount(n => Math.max(0, n - 1));
        }
    }, [setStatus]);

    const closeGuide = useCallback(() => {
        setShowGuide(false);
        writeStored('bunri-guide-seen', '1');
    }, []);

    const openLearn = useCallback((tab: LearnTab) => {
        setLeftTab('learn');
        setLearnTab(tab);
    }, []);

    const setLeftWidth = useCallback((px: number) => {
        const val = Math.round(Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, px)));
        setLeftWidthState(val);
        writeStored('bunri-left-width', String(val));
    }, []);

    const applyChartGrid = useCallback((target: SongChart, options: { force?: boolean } = {}) => {
        // お手本はパート分離のときのグリッドに載っている。グリッドを変えると原曲とずれるので変えない
        if (!options.force && engine.tracks.some(t => t.role === 'part')) return false;
        const grid = gridFromChart(target);
        setBpm(grid.bpm);
        setBeatsPerBarState(grid.beatsPerBar);
        engine.beatsPerBar = grid.beatsPerBar;
        setGridOffset(grid.offsetSec);
        return true;
    }, [setBpm, setGridOffset]);

    const openSongPicker = useCallback(() => songPickerRef.current?.click(), []);

    const setCoachPair = useCallback((pair: CoachPair) => {
        setCoachPairState(pair);
        setCoachResult(null);
    }, []);

    const setFollowPlayhead = useCallback((v: boolean) => {
        setFollowPlayheadState(v);
        writeStored('bunri-follow-playhead', v ? '1' : '0');
    }, []);

    const jumpTo = useCallback((target: JumpTarget) => {
        const grid = engine.grid;
        const sec = target.sec ?? (target.step !== undefined ? stepToSec(target.step, grid) : null);
        if (sec === null) return;
        engine.seek(sec);
        timelineRef.current?.scrollToTime?.(sec);
        const pr = pianoRollRef.current;
        if (pr) {
            pr.scrollToStep(target.step ?? Math.max(0, secToStep(sec, grid)));
            if (target.pitch) pr.scrollToPitch?.(target.pitch.note, target.pitch.octave);
        }
    }, []);

    // ---- 元に戻す / やり直す ----
    // 履歴は 1 本 (プロジェクト全体)。記録の中身はプロジェクトの控え (lib/project-snapshot.ts。
    // なぜ控えで持つかは、そのファイルの説明)。描き直しのきっかけは historyVersion
    const historyRef = useRef<UndoHistory<ProjectSnapshot> | null>(null);
    if (historyRef.current === null) {
        historyRef.current = new UndoHistory<ProjectSnapshot>({
            limit: HISTORY_LIMIT, budget: HISTORY_BUDGET, cost: snapshotCost, equals: projectsEqual,
        });
    }
    const [historyVersion, setHistoryVersion] = useState(0);
    // 直前に取った控え。中身が同じノートの並びを共有して、メモリを節約する
    const lastSnapshotRef = useRef<ProjectSnapshot | null>(null);
    // いま開いている記録の深さ (記録の中の記録は、外側にまとめる)
    const editDepthRef = useRef(0);
    const [undoToast, setUndoToast] = useState<UndoToastState | null>(null);
    const toastRef = useRef<UndoToastState | null>(null);
    const toastSeq = useRef(0);

    const setToast = useCallback((toast: UndoToastState | null) => {
        toastRef.current = toast;
        setUndoToast(toast);
    }, []);

    /** いまのプロジェクトの控えを取る。ピアノロールが手元に持っているノートを、先にトラックへ書き戻す。 */
    const capture = useCallback((): ProjectSnapshot => {
        pianoRollRef.current?._saveToEngine?.();
        const snap = captureProject(engine, lastSnapshotRef.current);
        lastSnapshotRef.current = snap;
        return snap;
    }, []);

    const beginEdit = useCallback((label: string, options: PushOptions = {}): CommitEdit => {
        let done = false;
        if (editDepthRef.current > 0) {
            // 記録の中の記録。外側の記録にまとまるので、ここでは記録しない
            editDepthRef.current += 1;
            return () => {
                if (!done) { done = true; editDepthRef.current = Math.max(0, editDepthRef.current - 1); }
                return false;
            };
        }
        editDepthRef.current = 1;
        const before = capture();
        return (override) => {
            if (done) return false;
            done = true;
            editDepthRef.current = 0;
            const after = capture();
            const entry = historyRef.current!.push(override?.label ?? label, before, after, options);
            setHistoryVersion(v => v + 1);
            // 別の操作をしたら、前の「元に戻す」の知らせは閉じる (押すと、その別の操作が戻ってしまう)
            if (toastRef.current && (!entry || entry.id !== toastRef.current.entryId)) setToast(null);
            return entry !== null;
        };
    }, [capture, setToast]);

    const record = useCallback(<T,>(label: string, fn: () => T, options?: PushOptions): T => {
        const commit = beginEdit(label, options);
        try {
            return fn();
        } finally {
            commit();
        }
    }, [beginEdit]);

    const recordAsync = useCallback(async <T,>(label: string, fn: () => Promise<T>, options?: PushOptions): Promise<T> => {
        const commit = beginEdit(label, options);
        try {
            return await fn();
        } finally {
            commit();
        }
    }, [beginEdit]);

    /** 記録の前後どちらかの控えを当てる。グリッドが変わっていれば、それも戻す。 */
    const restore = useCallback((target: ProjectSnapshot, other: ProjectSnapshot) => {
        const grid = applyProject(engine, target, other);
        if (grid) {
            setBpm(grid.bpm);
            setBeatsPerBarState(grid.beatsPerBar);
            engine.beatsPerBar = grid.beatsPerBar;
            setGridOffset(grid.offsetSec);
        }
        lastSnapshotRef.current = target;
        pianoRollRef.current?.reloadFromEngine?.();
        setTrackVersion(v => v + 1);
        setHistoryVersion(v => v + 1);
    }, [setBpm, setGridOffset]);

    /** 元に戻す・やり直すをしてよいか (記録の途中や、ピアノロールのドラッグ中はしない)。 */
    const canStep = useCallback(() => editDepthRef.current === 0 && !pianoRollRef.current?.isBusy?.(), []);

    const undo = useCallback(() => {
        if (!canStep()) return;
        pianoRollRef.current?._saveToEngine?.();
        const entry = historyRef.current!.undo();
        if (!entry) return;
        restore(entry.before, entry.after);
        if (toastRef.current?.entryId === entry.id) setToast(null);
        setStatus(`元に戻しました（${entry.label}）`);
    }, [canStep, restore, setToast, setStatus]);

    const redo = useCallback(() => {
        if (!canStep()) return;
        pianoRollRef.current?._saveToEngine?.();
        const entry = historyRef.current!.redo();
        if (!entry) return;
        restore(entry.after, entry.before);
        setStatus(`やり直しました（${entry.label}）`);
    }, [canStep, restore, setStatus]);

    const clearHistory = useCallback(() => {
        historyRef.current!.clear();
        lastSnapshotRef.current = null;
        setToast(null);
        setHistoryVersion(v => v + 1);
    }, [setToast]);

    const showUndoToast = useCallback((message: string) => {
        toastSeq.current += 1;
        setToast({ id: toastSeq.current, message, entryId: historyRef.current!.peekUndo()?.id ?? null });
    }, [setToast]);

    const dismissUndoToast = useCallback(() => setToast(null), [setToast]);

    const undoFromToast = useCallback(() => {
        const toast = toastRef.current;
        setToast(null);
        if (!toast || toast.entryId === null) return;
        if (historyRef.current!.peekUndo()?.id !== toast.entryId) {
            setStatus('その後に別の操作をしたので、この知らせからは元に戻せません。「元に戻す」で 1 つずつ戻してください');
            return;
        }
        undo();
    }, [setToast, setStatus, undo]);

    const history = historyRef.current;
    const nextUndo = history.peekUndo(), nextRedo = history.peekRedo();
    void historyVersion;

    const value: DawContextType = {
        engine,
        status: statusState.text, statusKind: statusState.kind, setStatus,
        hint, setHint,
        showProgress: progressCount > 0, withProgress,
        showGuide, setShowGuide, closeGuide,
        bpm, setBpm,
        beatsPerBar, setBeatsPerBar,
        isPlaying, setIsPlaying,
        metronomeEnabled, setMetronomeEnabled,
        trackVersion, bumpTracks,
        pianoRollRef, timelineRef,
        leftTab, setLeftTab, learnTab, setLearnTab, openLearn, soundTab, setSoundTab,
        leftWidth, setLeftWidth,
        gridOffset, setGridOffset, applyChartGrid,
        songFile, setSongFile, autoBpm, setAutoBpm, songPickerRef, openSongPicker,
        ghostChoice, setGhostChoice,
        coachPair, setCoachPair, coachResult, setCoachResult,
        jumpTo, followPlayhead, setFollowPlayhead,
        chart, chartId, chartPeaks, glossary,
        setChartResult, clearChart,
        showGridEditor, setShowGridEditor,
        canUndo: nextUndo !== null, canRedo: nextRedo !== null,
        undoLabel: nextUndo?.label ?? null, redoLabel: nextRedo?.label ?? null,
        undo, redo, record, recordAsync, beginEdit, clearHistory,
        undoToast, showUndoToast, dismissUndoToast, undoFromToast,
    };

    return <DawContext.Provider value={value}>{children}</DawContext.Provider>;
}

/**
 * DAW グローバル状態にアクセスするカスタムフック。
 * `DawProvider` の外で呼ぶとエラーをスローする。
 * @returns DawContextType — DAW の全状態と操作関数
 */
export function useDaw(): DawContextType {
    const ctx = useContext(DawContext);
    if (!ctx) throw new Error('useDaw must be used within DawProvider');
    return ctx;
}
