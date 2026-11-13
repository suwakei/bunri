/**
 * bunri DAW — MIDI キーボード入力の仕組み（つなぐ・鳴らす・録る）。
 *
 * 中央エリアが 1 つだけ持ち、ふだんのピアノロールの見出し（components/MidiInputBar.tsx）と、
 * 練習画面の「入力」（components/PracticeView.tsx）の両方から使う（MIDI の処理を二重にしない）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaw } from './store';
import engine, { type PianoNote } from './engine';
import { secToStep } from './grid';
import { describeError, isDesktop } from './api';
import { MidiNoteRecorder, parseMidiMessage, pickMidiSource, type MidiSource, type RecordMode } from './midi-input';

/** 練習画面が、録る範囲と置き方を差し替えるための口（`useMidiInput` の `setPracticeHooks`）。 */
export interface MidiPracticeHooks {
    /** 録る範囲（ステップ。区間ループ）。無ければ null */
    bounds: () => { start: number; end: number } | null;
    /**
     * ノートを置く。置いたら true（false なら、ふだんの置き方で置く）。
     * 練習画面のリアルタイム録音は、重ねて録り、1 周ごとに記録を分ける
     */
    addNote: (note: PianoNote, mode: RecordMode) => boolean;
}

/** MIDI 入力の操作（`useMidiInput` が返す）。 */
export interface MidiInputController {
    /** この環境で MIDI 入力が使えるか */
    available: boolean;
    connected: boolean;
    /** つながっている機器の名前 */
    devices: string[];
    mode: RecordMode;
    setMode: (mode: RecordMode) => void;
    stepLength: number;
    setStepLength: (length: number) => void;
    /** ステップ入力の、次に置く位置 */
    cursor: number;
    setCursor: (step: number) => void;
    /** 入力を開く。開けたら true */
    connect: () => Promise<boolean>;
    disconnect: () => Promise<void>;
    /** 練習画面の口を付ける（null で外す） */
    setPracticeHooks: (hooks: MidiPracticeHooks | null) => void;
    /** リアルタイム録音の前に、1 小節ぶんのカウントを入れるか */
    countIn: boolean;
    setCountIn: (on: boolean) => void;
    /** リアルタイム録音で、弾いた位置を前へ戻す量（ミリ秒）。自分で決めていなければ、音の出力の遅れから決めた値 */
    latencyMs: number;
    /** 遅れの補正を、自分で決めずに任せているか */
    latencyAuto: boolean;
    /** 遅れの補正を決める（null で、任せる） */
    setLatencyMs: (ms: number | null) => void;
}

/** 設定の置き場（ブラウザの保存領域）。 */
const COUNT_IN_KEY = 'bunri-midi-count-in';
const LATENCY_KEY = 'bunri-midi-latency-ms';
/** 遅れの補正の上限（ミリ秒）。 */
export const MAX_LATENCY_MS = 500;

function readSetting(key: string): string | null {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function writeSetting(key: string, value: string | null): void {
    try {
        if (value === null) globalThis.localStorage?.removeItem(key);
        else globalThis.localStorage?.setItem(key, value);
    } catch { /* 保存できない環境では、その場かぎりの設定にする */ }
}

/**
 * MIDI キーボード入力の仕組み（つなぐ・鳴らす・録る）。中央エリアが 1 つだけ持つ。
 */
export function useMidiInput(): MidiInputController {
    const { pianoRollRef, setStatus, bumpTracks, beatsPerBar } = useDaw();
    const [available] = useState(() => pickMidiSource() !== null);
    const [connected, setConnected] = useState(false);
    const [devices, setDevices] = useState<string[]>([]);
    const [mode, setModeState] = useState<RecordMode>('step');
    const [stepLength, setStepLengthState] = useState(4);
    const [cursor, setCursorState] = useState(0);
    const sourceRef = useRef<MidiSource | null>(null);
    const recorderRef = useRef<MidiNoteRecorder | null>(null);
    const hooksRef = useRef<MidiPracticeHooks | null>(null);
    const [countIn, setCountInState] = useState(() => readSetting(COUNT_IN_KEY) !== '0');
    // 遅れの補正。null は「任せる」(音の出力の遅れから決める)
    const [manualLatency, setManualLatency] = useState<number | null>(() => {
        const saved = Number(readSetting(LATENCY_KEY));
        return readSetting(LATENCY_KEY) !== null && Number.isFinite(saved) ? Math.max(0, Math.min(MAX_LATENCY_MS, saved)) : null;
    });
    const [autoLatency, setAutoLatency] = useState(0);
    /** いま効いている遅れの補正（秒）と、処理中のメッセージが届いてから経った時間（秒）。録る部品が見にいく */
    const latencyRef = useRef(0);
    const messageAgeRef = useRef(0);
    latencyRef.current = (manualLatency ?? autoLatency) / 1000;

    // 録り方を決める部品。ピアノロールと再生位置を、呼ばれたときに見にいく
    if (recorderRef.current === null) {
        recorderRef.current = new MidiNoteRecorder({
            position: () => {
                const sec = engine.getPlayPosition();
                if (sec === null) return null;
                // 弾いた位置を、遅れのぶんだけ前へ戻す。聞こえた音に合わせて弾くと、音が耳に届くまでの遅れと、
                // 鍵盤からここに届くまでの遅れのぶんだけ、再生位置は先へ進んでいる
                const played = sec - latencyRef.current - messageAgeRef.current;
                // ステップ 0 は 1 小節目の位置 (engine.gridOffset)。それより前 (弱起) は 1 小節目の頭にする
                return Math.max(0, secToStep(played, engine.grid));
            },
            // 元に戻せる。リアルタイム録音は、弾き続けているあいだのノートを 1 つの記録にまとめる
            addNote: (n) => {
                const recordMode = recorderRef.current?.mode ?? 'off';
                if (hooksRef.current?.addNote(n, recordMode)) return;
                pianoRollRef.current?._addNote(n.note, n.octave, n.step, n.length, recordMode === 'realtime'
                    ? { label: 'MIDI 入力の録音', coalesceKey: 'midi-realtime', coalesceMs: 4000, velocity: n.velocity }
                    : { label: 'MIDI 入力でノートを追加', velocity: n.velocity });
            },
            // ピアノロールは打ち込むと伸びるので、末尾の制限は「伸ばせる上限」にする
            get totalSteps() { return pianoRollRef.current?.maxSteps ?? pianoRollRef.current?.totalSteps ?? 128; },
            get minOctave() { return pianoRollRef.current?.octaveRange?.[0] ?? 0; },
            get maxOctave() { return pianoRollRef.current?.octaveRange?.[1] ?? 9; },
            bounds: () => hooksRef.current?.bounds() ?? null,
        });
    }

    const handleMessage = useCallback((bytes: ArrayLike<number>, receivedAt?: number) => {
        const event = parseMidiMessage(bytes);
        const recorder = recorderRef.current;
        if (!event || !recorder) return;
        // 機器から届いた時刻が分かれば、ここで処理するまでの待ちも、遅れとして差し引く (長すぎる値は信用しない)
        const age = typeof receivedAt === 'number' ? (performance.now() - receivedAt) / 1000 : 0;
        messageAgeRef.current = age > 0 && age < 0.5 ? age : 0;

        // 弾いた音は、録るかどうかに関係なく鳴らす
        if (event.type === 'on') engine.liveNoteOn(event.pitch, event.velocity);
        else engine.liveNoteOff(event.pitch);

        if (recorder.mode === 'off') return;
        if (pianoRollRef.current?.getActiveTrackId?.() == null) {
            if (event.type === 'on') setStatus('MIDI 入力: 先に、ノートを入れるトラックをクリックして選んでください');
            return;
        }
        const result = recorder.handle(event);
        if (result.kind === 'added') {
            bumpTracks();
        } else if (result.kind === 'skipped' && result.reason === 'stopped' && engine.isCountingIn()) {
            // 録音前のカウントの間に弾いた音は、録らない (知らせも出さない。カウントが終われば録り始める)
        } else if (result.kind === 'skipped') {
            const inLoop = hooksRef.current?.bounds() != null;
            setStatus({
                range: 'MIDI 入力: この高さはピアノロールの範囲の外です',
                end: inLoop ? 'MIDI 入力: 区間の終わりまで入力しました（「区間の頭へ」で戻ります）' : 'MIDI 入力: ピアノロールの末尾まで入力しました',
                stopped: 'MIDI 入力: リアルタイム録音は、再生してから弾いてください',
            }[result.reason]);
        }
        setCursorState(recorder.cursor);
    }, [pianoRollRef, setStatus, bumpTracks]);

    const connect = useCallback(async () => {
        const source = pickMidiSource();
        if (!source) return false;
        try {
            await source.start(handleMessage, setDevices);
            sourceRef.current = source;
            setConnected(true);
            // 音の出力の遅れは、音を出す準備ができてから分かる
            engine.init();
            setAutoLatency(Math.min(MAX_LATENCY_MS, Math.round(engine.outputLatencySec() * 1000)));
            return true;
        } catch (e) {
            setStatus('MIDI 入力を開けませんでした。鍵盤がつながっているかを確かめて、もう一度押してください（' + describeError(e) + '）', 'error');
            return false;
        }
    }, [handleMessage, setStatus]);

    const disconnect = useCallback(async () => {
        const source = sourceRef.current;
        sourceRef.current = null;
        setConnected(false);
        setDevices([]);
        engine.liveAllNotesOff();
        try { await source?.stop(); } catch { /* 閉じる途中の失敗は無視する */ }
    }, []);

    // 画面を離れるときは入力を閉じ、鳴っている音を止める
    useEffect(() => () => {
        engine.liveAllNotesOff();
        void sourceRef.current?.stop().catch(() => {});
    }, []);

    const setMode = useCallback((next: RecordMode) => {
        setModeState(next);
        recorderRef.current?.setMode(next);
    }, []);

    const setStepLength = useCallback((length: number) => {
        setStepLengthState(length);
        if (recorderRef.current) recorderRef.current.stepLength = length;
    }, []);

    const setCursor = useCallback((step: number) => {
        if (recorderRef.current) recorderRef.current.cursor = step;
        setCursorState(step);
    }, []);

    const setPracticeHooks = useCallback((hooks: MidiPracticeHooks | null) => { hooksRef.current = hooks; }, []);

    const setCountIn = useCallback((on: boolean) => {
        setCountInState(on);
        writeSetting(COUNT_IN_KEY, on ? '1' : '0');
    }, []);

    const setLatencyMs = useCallback((ms: number | null) => {
        const value = ms === null || !Number.isFinite(ms) ? null : Math.max(0, Math.min(MAX_LATENCY_MS, Math.round(ms)));
        setManualLatency(value);
        writeSetting(LATENCY_KEY, value === null ? null : String(value));
    }, []);

    // リアルタイム録音を選んでいるあいだは、再生の前に 1 小節ぶんのカウントを入れる (再生エンジンが鳴らす)
    useEffect(() => {
        engine.countInBeats = connected && mode === 'realtime' && countIn ? Math.max(1, Number(beatsPerBar) || 4) : 0;
        return () => { engine.countInBeats = 0; };
    }, [connected, mode, countIn, beatsPerBar]);

    // 最初の録り方を、録る部品にも伝えておく
    useEffect(() => { recorderRef.current?.setMode(mode); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return {
        available, connected, devices, mode, setMode, stepLength, setStepLength, cursor, setCursor, connect, disconnect, setPracticeHooks,
        countIn, setCountIn, latencyMs: manualLatency ?? autoLatency, latencyAuto: manualLatency === null, setLatencyMs,
    };
}

/** MIDI 入力が使えない環境で出す文。 */
export function midiUnavailableText(): string {
    // 対応するブラウザの案内は、開発用のブラウザ起動のときだけ出す
    return isDesktop()
        ? 'MIDI 入力は、この環境では使えません'
        : 'MIDI 入力はこのブラウザでは使えません（Chrome / Edge、またはデスクトップ版で使えます）';
}

