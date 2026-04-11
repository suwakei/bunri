/**
 * bunri DAW — グローバル状態管理（React Context ベース）
 */
import { createContext, useContext, useState, useCallback, useRef } from 'react';
import engine from './engine.js';

const DawContext = createContext(null);

export function DawProvider({ children }) {
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
    const pianoRollRef = useRef(null);
    const timelineRef = useRef(null);
    const automationRef = useRef(null);

    const bumpTracks = useCallback(() => setTrackVersion(v => v + 1), []);

    const setBpm = useCallback((v) => {
        const val = parseInt(v) || 120;
        setBpmState(val);
        engine.bpm = val;
    }, []);

    const setBeatsPerBar = useCallback((v) => {
        const val = parseInt(v) || 4;
        setBeatsPerBarState(val);
        engine.beatsPerBar = val;
    }, []);

    const withProgress = useCallback(async (processingMsg, fn) => {
        setShowProgress(true);
        setStatus(processingMsg);
        try {
            await fn();
        } catch (e) {
            setStatus('エラー: ' + e.message);
        } finally {
            setShowProgress(false);
        }
    }, []);

    const closeGuide = useCallback(() => {
        setShowGuide(false);
        localStorage.setItem('bunri-guide-seen', '1');
    }, []);

    const value = {
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

export function useDaw() {
    const ctx = useContext(DawContext);
    if (!ctx) throw new Error('useDaw must be used within DawProvider');
    return ctx;
}
