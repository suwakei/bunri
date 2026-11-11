/**
 * bunri DAW — MIDI キーボード入力の操作バー（ピアノロールの見出し行に出す）。
 *
 * 「MIDI 入力」を押すと、つながっている鍵盤をすべて開く。弾くと音が鳴り、録り方に応じて
 * ピアノロールにノートが入る。
 *
 * - 録らない: 音を鳴らすだけ（音を探すとき用）
 * - ステップ入力: 弾くたびに、カーソルの位置へ決まった長さのノートを置いて進む
 * - リアルタイム録音: 再生中に弾いた位置と長さを、16 分音符に丸めて置く
 *
 * 入力元は環境で変わる（lib/midi-input.ts）。開発用のブラウザ起動は Web MIDI API（Chrome / Edge）、
 * デスクトップ版はネイティブ側。どちらも無い環境では、使えない旨だけを出す。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { MidiNoteRecorder, cursorLabel, parseMidiMessage, pickMidiSource, type MidiSource, type RecordMode } from '../lib/midi-input';

/** ステップ入力で選べるノートの長さ（ステップ数と呼び名）。 */
const STEP_LENGTHS: [number, string][] = [[1, '16 分'], [2, '8 分'], [4, '4 分'], [8, '2 分'], [16, '全音符']];

const controlStyle = {
    fontSize: 10, padding: '1px 4px', marginLeft: 6, textTransform: 'none', letterSpacing: 0,
} as const;

/**
 * MIDI キーボード入力の操作バー。
 */
export default function MidiInputBar() {
    const { pianoRollRef, setStatus, bumpTracks, beatsPerBar } = useDaw();
    const [available] = useState(() => pickMidiSource() !== null);
    const [connected, setConnected] = useState(false);
    const [devices, setDevices] = useState<string[]>([]);
    const [mode, setMode] = useState<RecordMode>('step');
    const [stepLength, setStepLength] = useState(4);
    const [cursor, setCursor] = useState(0);
    const sourceRef = useRef<MidiSource | null>(null);
    const recorderRef = useRef<MidiNoteRecorder | null>(null);

    // 録り方を決める部品。ピアノロールと再生位置を、呼ばれたときに見にいく
    if (recorderRef.current === null) {
        recorderRef.current = new MidiNoteRecorder({
            position: () => {
                const sec = engine.getPlayPosition();
                return sec === null ? null : sec / (60 / engine.bpm / 4);
            },
            addNote: (n) => pianoRollRef.current?._addNote(n.note, n.octave, n.step, n.length),
            get totalSteps() { return pianoRollRef.current?.totalSteps ?? 128; },
            get minOctave() { return pianoRollRef.current?.octaveRange?.[0] ?? 2; },
            get maxOctave() { return pianoRollRef.current?.octaveRange?.[1] ?? 7; },
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
            setStatus({
                range: 'MIDI 入力: この高さはピアノロールの範囲の外です',
                end: 'MIDI 入力: ピアノロールの末尾まで入力しました',
                stopped: 'MIDI 入力: リアルタイム録音は、再生してから弾いてください',
            }[result.reason]);
        }
        setCursor(recorder.cursor);
    }, [pianoRollRef, setStatus, bumpTracks]);

    const connect = useCallback(async () => {
        const source = pickMidiSource();
        if (!source) return;
        try {
            await source.start(handleMessage, setDevices);
            sourceRef.current = source;
            setConnected(true);
        } catch (e) {
            setStatus('MIDI 入力を開けませんでした: ' + String((e as Error)?.message ?? e));
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

    const handleMode = useCallback((next: RecordMode) => {
        setMode(next);
        recorderRef.current?.setMode(next);
    }, []);

    // 最初の録り方を、録る部品にも伝えておく
    useEffect(() => { recorderRef.current?.setMode(mode); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    if (!available) {
        return (
            <span className="area-hint" style={{ marginLeft: 12 }}>
                MIDI 入力はこのブラウザでは使えません（Chrome / Edge、またはデスクトップ版で使えます）
            </span>
        );
    }

    return (
        <span id="midi-input-bar" style={{ marginLeft: 12, textTransform: 'none', letterSpacing: 0 }}>
            <button type="button" style={controlStyle} aria-pressed={connected}
                onClick={connected ? disconnect : connect}>
                {connected ? 'MIDI 入力を止める' : 'MIDI 入力'}
            </button>
            {connected && (
                <>
                    <button type="button" style={controlStyle} onClick={connect} title="機器を挿し直したときに押す">再検出</button>
                    <select aria-label="録り方" style={controlStyle} value={mode} onChange={(e) => handleMode(e.target.value as RecordMode)}>
                        <option value="off">録らない（音だけ）</option>
                        <option value="step">ステップ入力</option>
                        <option value="realtime">リアルタイム録音</option>
                    </select>
                    {mode === 'step' && (
                        <>
                            <select aria-label="ノートの長さ" style={controlStyle} value={stepLength}
                                onChange={(e) => {
                                    const length = Number(e.target.value);
                                    setStepLength(length);
                                    if (recorderRef.current) recorderRef.current.stepLength = length;
                                }}>
                                {STEP_LENGTHS.map(([steps, label]) => <option key={steps} value={steps}>{label}</option>)}
                            </select>
                            <span className="area-hint" style={{ marginLeft: 6 }}>次の位置: {cursorLabel(cursor, beatsPerBar)}</span>
                            <button type="button" style={controlStyle}
                                onClick={() => { if (recorderRef.current) recorderRef.current.cursor = 0; setCursor(0); }}>
                                先頭へ
                            </button>
                        </>
                    )}
                    <span className="area-hint" style={{ marginLeft: 8 }}>
                        {devices.length > 0 ? devices.join(' / ') : '鍵盤が見つかりません（つないでから「再検出」）'}
                    </span>
                </>
            )}
        </span>
    );
}
