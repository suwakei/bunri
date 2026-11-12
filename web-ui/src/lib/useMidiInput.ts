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
}

/**
 * MIDI キーボード入力の仕組み（つなぐ・鳴らす・録る）。中央エリアが 1 つだけ持つ。
 */
export function useMidiInput(): MidiInputController {
    const { pianoRollRef, setStatus, bumpTracks } = useDaw();
    const [available] = useState(() => pickMidiSource() !== null);
    const [connected, setConnected] = useState(false);
    const [devices, setDevices] = useState<string[]>([]);
    const [mode, setModeState] = useState<RecordMode>('step');
    const [stepLength, setStepLengthState] = useState(4);
    const [cursor, setCursorState] = useState(0);
    const sourceRef = useRef<MidiSource | null>(null);
    const recorderRef = useRef<MidiNoteRecorder | null>(null);
    const hooksRef = useRef<MidiPracticeHooks | null>(null);

    // 録り方を決める部品。ピアノロールと再生位置を、呼ばれたときに見にいく
    if (recorderRef.current === null) {
        recorderRef.current = new MidiNoteRecorder({
            position: () => {
                const sec = engine.getPlayPosition();
                // ステップ 0 は 1 小節目の位置 (engine.gridOffset)。それより前 (弱起) は 1 小節目の頭にする
                return sec === null ? null : Math.max(0, secToStep(sec, engine.grid));
            },
            // 元に戻せる。リアルタイム録音は、弾き続けているあいだのノートを 1 つの記録にまとめる
            addNote: (n) => {
                const recordMode = recorderRef.current?.mode ?? 'off';
                if (hooksRef.current?.addNote(n, recordMode)) return;
                pianoRollRef.current?._addNote(n.note, n.octave, n.step, n.length, recordMode === 'realtime'
                    ? { label: 'MIDI 入力の録音', coalesceKey: 'midi-realtime', coalesceMs: 4000 }
                    : { label: 'MIDI 入力でノートを追加' });
            },
            // ピアノロールは打ち込むと伸びるので、末尾の制限は「伸ばせる上限」にする
            get totalSteps() { return pianoRollRef.current?.maxSteps ?? pianoRollRef.current?.totalSteps ?? 128; },
            get minOctave() { return pianoRollRef.current?.octaveRange?.[0] ?? 0; },
            get maxOctave() { return pianoRollRef.current?.octaveRange?.[1] ?? 9; },
            bounds: () => hooksRef.current?.bounds() ?? null,
        });
    }

    const handleMessage = useCallback((bytes: ArrayLike<number>) => {
        const event = parseMidiMessage(bytes);
        const recorder = recorderRef.current;
        if (!event || !recorder) return;

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

    // 最初の録り方を、録る部品にも伝えておく
    useEffect(() => { recorderRef.current?.setMode(mode); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return { available, connected, devices, mode, setMode, stepLength, setStepLength, cursor, setCursor, connect, disconnect, setPracticeHooks };
}

/** MIDI 入力が使えない環境で出す文。 */
export function midiUnavailableText(): string {
    // 対応するブラウザの案内は、開発用のブラウザ起動のときだけ出す
    return isDesktop()
        ? 'MIDI 入力は、この環境では使えません'
        : 'MIDI 入力はこのブラウザでは使えません（Chrome / Edge、またはデスクトップ版で使えます）';
}

