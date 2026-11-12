/**
 * bunri DAW — グローバル状態管理（React Context ベース）
 */
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import engine from './engine';
import { describeError } from './api';
import type { ChartResponse, Glossary, SongChart, WaveformPeaks } from './chart';

/** ステータスバーの文の種類。`error` は失敗の知らせで、色を変えて読み上げの対象にする。 */
export type StatusKind = 'info' | 'error';

/** 左パネルのタブの識別子。 */
export type LeftTab = 'synth' | 'drum' | 'fx' | 'file' | 'chart';

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
        () => !localStorage.getItem('bunri-guide-seen') || new URLSearchParams(window.location.search).has('guide'),
    );
    const [leftTab, setLeftTab] = useState<LeftTab>('synth');
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

    const setBpm = useCallback((v: string | number) => {
        const val = parseInt(String(v)) || 120;
        setBpmState(val);
        engine.bpm = val;
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
        localStorage.setItem('bunri-guide-seen', '1');
    }, []);

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
        leftTab, setLeftTab,
        chart, chartId, chartPeaks, glossary,
        setChartResult, clearChart,
        showGridEditor, setShowGridEditor,
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
