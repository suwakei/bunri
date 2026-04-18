/**
 * bunri DAW — グローバル状態管理（React Context ベース）
 */
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import engine from './engine';

/**
 * DAW グローバル状態のコンテキスト型定義。
 * AudioEngine への参照と、UI 全体で共有される状態・操作関数を提供する。
 */
export interface DawContextType {
    /** WebAudio 再生エンジンのシングルトン */
    engine: typeof engine;
    /** ステータスバーに表示するメッセージ */
    status: string;
    /** @param msg - 表示するステータスメッセージ */
    setStatus: (msg: string) => void;
    /** ヒントテキスト */
    hint: string;
    /** @param msg - 表示するヒントメッセージ */
    setHint: (msg: string) => void;
    /** プログレスバーの表示フラグ */
    showProgress: boolean;
    /** @param v - true でプログレスバーを表示 */
    setShowProgress: (v: boolean) => void;
    /**
     * 非同期処理をプログレス表示付きで実行するラッパー。
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
    /** AutomationEditor コンポーネントへの ref */
    automationRef: React.MutableRefObject<any>;
}

const DawContext = createContext<DawContextType | null>(null);

export function DawProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState('準備完了');
    const [hint, setHint] = useState('');
    const [showProgress, setShowProgress] = useState(false);
    const [showGuide, setShowGuide] = useState(!localStorage.getItem('bunri-guide-seen'));
    const [bpm, setBpmState] = useState(120);
    const [beatsPerBar, setBeatsPerBarState] = useState(4);
    const [isPlaying, setIsPlaying] = useState(false);
    const [metronomeEnabled, setMetronomeEnabled] = useState(false);
    const [trackVersion, setTrackVersion] = useState(0);

    // PianoRoll / Timeline / Automation の参照を保持
    const pianoRollRef = useRef<any>(null);
    const timelineRef = useRef<any>(null);
    const automationRef = useRef<any>(null);

    const bumpTracks = useCallback(() => setTrackVersion(v => v + 1), []);

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
        setShowProgress(true);
        setStatus(processingMsg);
        try {
            await fn();
        } catch (e) {
            setStatus('エラー: ' + (e as Error).message);
        } finally {
            setShowProgress(false);
        }
    }, []);

    const closeGuide = useCallback(() => {
        setShowGuide(false);
        localStorage.setItem('bunri-guide-seen', '1');
    }, []);

    const value: DawContextType = {
        engine,
        status, setStatus,
        hint, setHint,
        showProgress, setShowProgress, withProgress,
        showGuide, setShowGuide, closeGuide,
        bpm, setBpm,
        beatsPerBar, setBeatsPerBar,
        isPlaying, setIsPlaying,
        metronomeEnabled, setMetronomeEnabled,
        trackVersion, bumpTracks,
        pianoRollRef, timelineRef, automationRef,
    };

    return <DawContext.Provider value={value}>{children}</DawContext.Provider>;
}

export function useDaw(): DawContextType {
    const ctx = useContext(DawContext);
    if (!ctx) throw new Error('useDaw must be used within DawProvider');
    return ctx;
}
