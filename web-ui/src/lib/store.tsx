/**
 * bunri DAW — グローバル状態管理（React Context ベース）
 */
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import engine from './engine';

export interface DawContextType {
    engine: typeof engine;
    status: string;
    setStatus: (msg: string) => void;
    hint: string;
    setHint: (msg: string) => void;
    showProgress: boolean;
    setShowProgress: (v: boolean) => void;
    withProgress: (msg: string, fn: () => Promise<void>) => Promise<void>;
    showGuide: boolean;
    setShowGuide: (v: boolean) => void;
    closeGuide: () => void;
    bpm: number;
    setBpm: (v: string | number) => void;
    beatsPerBar: number;
    setBeatsPerBar: (v: string | number) => void;
    isPlaying: boolean;
    setIsPlaying: (v: boolean) => void;
    metronomeEnabled: boolean;
    setMetronomeEnabled: (v: boolean) => void;
    trackVersion: number;
    bumpTracks: () => void;
    pianoRollRef: React.MutableRefObject<any>;
    timelineRef: React.MutableRefObject<any>;
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
