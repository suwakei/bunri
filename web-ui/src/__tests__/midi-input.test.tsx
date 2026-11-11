/**
 * MIDI キーボード入力のテスト: メッセージの読み取り、録り方、入力元、操作バー。
 * @vitest-environment jsdom
 */
import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

class MockParam { value = 0; setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class MockGainNode { gain = new MockParam(); connect() { return this; } disconnect() {} }
const oscillators: { freq: number; started: boolean; stopped: boolean }[] = [];
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { return this; }, disconnect() {} } as unknown as StereoPannerNode; }
    createOscillator() {
        const record = { freq: 0, started: false, stopped: false };
        oscillators.push(record);
        return {
            type: 'sine',
            frequency: { get value() { return record.freq; }, set value(v: number) { record.freq = v; } },
            connect() {}, start() { record.started = true; }, stop() { record.stopped = true; },
        } as unknown as OscillatorNode;
    }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { parseMidiMessage, pitchToNote, cursorLabel, MidiNoteRecorder, pickMidiSource } = await import('../lib/midi-input');
type PianoNote = import('../lib/engine').PianoNote;
const { DawProvider, useDaw } = await import('../lib/store');
const engine = (await import('../lib/engine')).default;
const MidiInputBar = (await import('../components/MidiInputBar')).default;
const StatusBar = (await import('../components/StatusBar')).default;

const on = (pitch: number, velocity = 100) => ({ type: 'on' as const, pitch, velocity });
const off = (pitch: number) => ({ type: 'off' as const, pitch, velocity: 0 });

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    delete (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess;
});

describe('parseMidiMessage', () => {
    it('押した・離したを読む', () => {
        expect(parseMidiMessage([0x90, 60, 100])).toEqual({ type: 'on', pitch: 60, velocity: 100 });
        expect(parseMidiMessage([0x80, 60, 64])).toEqual({ type: 'off', pitch: 60, velocity: 0 });
    });
    it('強さ 0 の「押した」は「離した」', () => {
        expect(parseMidiMessage([0x90, 60, 0])).toEqual({ type: 'off', pitch: 60, velocity: 0 });
    });
    it('チャンネルは区別しない', () => {
        expect(parseMidiMessage(new Uint8Array([0x93, 64, 80]))).toEqual({ type: 'on', pitch: 64, velocity: 80 });
        expect(parseMidiMessage([0x8f, 64, 0])?.type).toBe('off');
    });
    it('それ以外のメッセージや短いものは無視する', () => {
        expect(parseMidiMessage([0xb0, 64, 127])).toBeNull();   // ペダル
        expect(parseMidiMessage([0xe0, 0, 64])).toBeNull();     // ピッチベンド
        expect(parseMidiMessage([0xf8])).toBeNull();            // クロック
        expect(parseMidiMessage([0x90, 60])).toBeNull();
        expect(parseMidiMessage(null)).toBeNull();
    });
});

describe('pitchToNote / cursorLabel', () => {
    it('60 は C4、69 は A4', () => {
        expect(pitchToNote(60)).toEqual({ note: 'C', octave: 4 });
        expect(pitchToNote(69)).toEqual({ note: 'A', octave: 4 });
        expect(pitchToNote(37)).toEqual({ note: 'C#', octave: 2 });
        expect(pitchToNote(0)).toEqual({ note: 'C', octave: -1 });
    });
    it('ステップ位置を小節と拍で言う', () => {
        expect(cursorLabel(0, 4)).toBe('1 小節 1 拍');
        expect(cursorLabel(24, 4)).toBe('2 小節 3 拍');
        expect(cursorLabel(12, 3)).toBe('2 小節 1 拍');
    });
});

function makeRecorder(position: () => number | null = () => null) {
    const notes: PianoNote[] = [];
    const recorder = new MidiNoteRecorder({ position, addNote: (n) => notes.push(n), totalSteps: 32, minOctave: 2, maxOctave: 7 });
    return { recorder, notes };
}

describe('MidiNoteRecorder — ステップ入力', () => {
    it('弾くたびにカーソルの位置へ置き、離すと進む', () => {
        const { recorder, notes } = makeRecorder();
        recorder.setMode('step');
        expect(recorder.handle(on(60))).toEqual({ kind: 'added', note: { note: 'C', octave: 4, step: 0, length: 4 } });
        recorder.handle(off(60));
        recorder.handle(on(64)); recorder.handle(off(64));
        expect(notes.map((n) => [n.note, n.step])).toEqual([['C', 0], ['E', 4]]);
        expect(recorder.cursor).toBe(8);
    });

    it('同時に押した鍵盤は和音として同じ位置に入る', () => {
        const { recorder, notes } = makeRecorder();
        recorder.setMode('step');
        recorder.handle(on(60)); recorder.handle(on(64)); recorder.handle(on(67));
        recorder.handle(off(60)); recorder.handle(off(64));
        expect(recorder.cursor).toBe(0);            // まだ 1 つ押している
        recorder.handle(off(67));
        expect(recorder.cursor).toBe(4);
        expect(notes.map((n) => n.step)).toEqual([0, 0, 0]);
    });

    it('ノートの長さを変えると、置く長さも進む幅も変わる', () => {
        const { recorder, notes } = makeRecorder();
        recorder.setMode('step');
        recorder.stepLength = 2;
        recorder.handle(on(60)); recorder.handle(off(60));
        expect(notes[0].length).toBe(2);
        expect(recorder.cursor).toBe(2);
    });

    it('ピアノロールの音域の外は置かず、カーソルも進めない', () => {
        const { recorder, notes } = makeRecorder();
        recorder.setMode('step');
        expect(recorder.handle(on(24))).toEqual({ kind: 'skipped', reason: 'range' });   // C1
        recorder.handle(off(24));
        expect(recorder.handle(on(96))).toEqual({ kind: 'skipped', reason: 'range' });   // C7
        recorder.handle(off(96));
        expect(notes).toEqual([]);
        expect(recorder.cursor).toBe(0);
    });

    it('末尾を越える位置には置かない', () => {
        const { recorder, notes } = makeRecorder();
        recorder.setMode('step');
        recorder.cursor = 30;
        expect(recorder.handle(on(60))).toEqual({ kind: 'skipped', reason: 'end' });
        expect(notes).toEqual([]);
    });
});

describe('MidiNoteRecorder — リアルタイム録音', () => {
    it('押した位置から離した位置までを、16 分音符に丸めて置く', () => {
        let now: number | null = 3.8;
        const { recorder, notes } = makeRecorder(() => now);
        recorder.setMode('realtime');
        expect(recorder.handle(on(60))).toEqual({ kind: 'ignored' });
        now = 7.6;
        expect(recorder.handle(off(60))).toEqual({ kind: 'added', note: { note: 'C', octave: 4, step: 4, length: 4 } });
        expect(notes).toHaveLength(1);
    });

    it('短く弾いても長さは最低 1', () => {
        let now: number | null = 8.1;
        const { recorder, notes } = makeRecorder(() => now);
        recorder.setMode('realtime');
        recorder.handle(on(62)); now = 8.2; recorder.handle(off(62));
        expect(notes[0]).toEqual({ note: 'D', octave: 4, step: 8, length: 1 });
    });

    it('重なって弾いた音は、それぞれの位置と長さで入る', () => {
        let now: number | null = 0;
        const { recorder, notes } = makeRecorder(() => now);
        recorder.setMode('realtime');
        recorder.handle(on(60)); now = 2; recorder.handle(on(64)); now = 4; recorder.handle(off(60)); now = 8; recorder.handle(off(64));
        expect(notes).toEqual([{ note: 'C', octave: 4, step: 0, length: 4 }, { note: 'E', octave: 4, step: 2, length: 6 }]);
    });

    it('再生していないときは録らない', () => {
        const { recorder, notes } = makeRecorder(() => null);
        recorder.setMode('realtime');
        expect(recorder.handle(on(60))).toEqual({ kind: 'skipped', reason: 'stopped' });
        expect(recorder.handle(off(60))).toEqual({ kind: 'ignored' });
        expect(notes).toEqual([]);
    });

    it('離す前に再生が止まったら、最短の長さで置く', () => {
        let now: number | null = 4;
        const { recorder, notes } = makeRecorder(() => now);
        recorder.setMode('realtime');
        recorder.handle(on(60)); now = null; recorder.handle(off(60));
        expect(notes).toEqual([{ note: 'C', octave: 4, step: 4, length: 1 }]);
    });

    it('末尾を越える長さは、末尾までに切る', () => {
        let now: number | null = 30;
        const { recorder, notes } = makeRecorder(() => now);
        recorder.setMode('realtime');
        recorder.handle(on(60)); now = 40; recorder.handle(off(60));
        expect(notes[0]).toEqual({ note: 'C', octave: 4, step: 30, length: 2 });
    });
});

describe('MidiNoteRecorder — 録らない', () => {
    it('何も置かない', () => {
        const { recorder, notes } = makeRecorder(() => 0);
        expect(recorder.handle(on(60))).toEqual({ kind: 'ignored' });
        expect(notes).toEqual([]);
    });
    it('録り方を切り替えると、押しかけの鍵盤を忘れる', () => {
        let now: number | null = 0;
        const { recorder, notes } = makeRecorder(() => now);
        recorder.setMode('realtime');
        recorder.handle(on(60));
        recorder.setMode('realtime');
        now = 4;
        expect(recorder.handle(off(60))).toEqual({ kind: 'ignored' });
        expect(notes).toEqual([]);
    });
});

/** Web MIDI API のモック。`send` で鍵盤からのメッセージを流す */
function stubWebMidi(names = ['Keystation 49']) {
    const inputs = names.map((name) => ({ name, state: 'connected', onmidimessage: null as null | ((e: { data: Uint8Array }) => void) }));
    const access = { inputs: { forEach: (fn: (i: (typeof inputs)[number]) => void) => inputs.forEach(fn) }, onstatechange: null as null | (() => void) };
    const request = vi.fn(async () => access);
    (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess = request;
    return {
        request, inputs, access,
        send: (bytes: number[], index = 0) => inputs[index].onmidimessage?.({ data: new Uint8Array(bytes) }),
    };
}

describe('pickMidiSource', () => {
    it('Web MIDI が在ればそれを使う', async () => {
        const midi = stubWebMidi(['A', 'B']);
        const source = pickMidiSource()!;
        expect(source.kind).toBe('web');
        const received: number[][] = [];
        const devices = vi.fn();
        await source.start((bytes) => received.push(Array.from(bytes)), devices);
        expect(midi.request).toHaveBeenCalledWith({ sysex: false });
        expect(devices).toHaveBeenLastCalledWith(['A', 'B']);
        midi.send([0x90, 60, 100], 1);
        expect(received).toEqual([[0x90, 60, 100]]);
        await source.stop();
        expect(midi.inputs.every((i) => i.onmidimessage === null)).toBe(true);
    });

    it('機器が増えたら、その機器からも受ける', async () => {
        const midi = stubWebMidi(['A']);
        const source = pickMidiSource()!;
        const received: number[][] = [];
        const devices = vi.fn();
        await source.start((bytes) => received.push(Array.from(bytes)), devices);
        midi.inputs.push({ name: 'B', state: 'connected', onmidimessage: null });
        midi.access.onstatechange?.();
        expect(devices).toHaveBeenLastCalledWith(['A', 'B']);
        midi.send([0x90, 62, 90], 1);
        expect(received).toEqual([[0x90, 62, 90]]);
    });

    it('Web MIDI が無く、デスクトップ版の中ならネイティブ側を使う', async () => {
        let handler: ((e: { payload: number[] }) => void) | null = null;
        const unlisten = vi.fn();
        const invoke = vi.fn(async (cmd: string) => (cmd === 'midi_start' ? ['USB Keyboard'] : undefined));
        const listen = vi.fn(async (_name: string, h: (e: { payload: number[] }) => void) => { handler = h; return unlisten; });
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke }, event: { listen } };
        const source = pickMidiSource()!;
        expect(source.kind).toBe('desktop');
        const received: number[][] = [];
        const devices = vi.fn();
        await source.start((bytes) => received.push(Array.from(bytes)), devices);
        // 受け口を用意してから開く
        expect(listen.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
        expect(listen).toHaveBeenCalledWith('midi-message', expect.any(Function));
        expect(devices).toHaveBeenCalledWith(['USB Keyboard']);
        handler!({ payload: [0x90, 60, 100] });
        expect(received).toEqual([[0x90, 60, 100]]);
        await source.stop();
        expect(unlisten).toHaveBeenCalled();
        expect(invoke).toHaveBeenLastCalledWith('midi_stop', undefined);
    });

    it('どちらも無ければ null', () => {
        expect(pickMidiSource()).toBeNull();
    });
});

/** ピアノロールの代わり。置かれたノートを覚えるだけ */
function FakePianoRoll({ notes, activeTrackId }: { notes: PianoNote[]; activeTrackId: number | null }) {
    const { pianoRollRef } = useDaw();
    useEffect(() => {
        pianoRollRef.current = {
            totalSteps: 128, octaveRange: [2, 7],
            getActiveTrackId: () => activeTrackId,
            _addNote: (note: string, octave: number, step: number, length: number) => notes.push({ note, octave, step, length }),
        };
    }, [pianoRollRef, notes, activeTrackId]);
    return null;
}

function renderBar(notes: PianoNote[], activeTrackId: number | null = 1) {
    return render(<DawProvider><FakePianoRoll notes={notes} activeTrackId={activeTrackId} /><MidiInputBar /><StatusBar /></DawProvider>);
}

describe('MidiInputBar', () => {
    beforeEach(() => { oscillators.length = 0; engine.init(); engine.liveAllNotesOff(); });

    it('使えない環境では、その旨だけを出す', () => {
        renderBar([]);
        expect(screen.getByText(/MIDI 入力はこのブラウザでは使えません/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'MIDI 入力' })).not.toBeInTheDocument();
    });

    it('つなぐと機器の名前が出て、弾くと音が鳴り、ステップ入力でノートが入る', async () => {
        const midi = stubWebMidi(['Keystation 49']);
        const notes: PianoNote[] = [];
        renderBar(notes);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 入力' }));
        await waitFor(() => expect(screen.getByText('Keystation 49')).toBeInTheDocument());

        act(() => { midi.send([0x90, 60, 100]); });
        expect(oscillators).toHaveLength(1);
        expect(oscillators[0].started).toBe(true);
        expect(Math.round(oscillators[0].freq)).toBe(262);          // C4
        act(() => { midi.send([0x80, 60, 0]); });
        expect(oscillators[0].stopped).toBe(true);

        act(() => { midi.send([0x90, 64, 100]); midi.send([0x80, 64, 0]); });
        expect(notes).toEqual([{ note: 'C', octave: 4, step: 0, length: 4 }, { note: 'E', octave: 4, step: 4, length: 4 }]);
        expect(screen.getByText('次の位置: 1 小節 3 拍')).toBeInTheDocument();
    });

    it('「録らない」にすると、音は鳴るがノートは入らない', async () => {
        const midi = stubWebMidi();
        const notes: PianoNote[] = [];
        renderBar(notes);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 入力' }));
        await screen.findByLabelText('録り方');
        fireEvent.change(screen.getByLabelText('録り方'), { target: { value: 'off' } });
        act(() => { midi.send([0x90, 60, 100]); midi.send([0x80, 60, 0]); });
        expect(oscillators).toHaveLength(1);
        expect(notes).toEqual([]);
    });

    it('トラックを選んでいなければ、ノートを入れずに案内する', async () => {
        const midi = stubWebMidi();
        const notes: PianoNote[] = [];
        renderBar(notes, null);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 入力' }));
        await screen.findByLabelText('録り方');
        act(() => { midi.send([0x90, 60, 100]); });
        expect(notes).toEqual([]);
        expect(screen.getByText(/トラックをクリックして選んでください/)).toBeInTheDocument();
    });

    it('リアルタイム録音は、再生していなければ案内を出す', async () => {
        const midi = stubWebMidi();
        const notes: PianoNote[] = [];
        renderBar(notes);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 入力' }));
        await screen.findByLabelText('録り方');
        fireEvent.change(screen.getByLabelText('録り方'), { target: { value: 'realtime' } });
        act(() => { midi.send([0x90, 60, 100]); });
        expect(notes).toEqual([]);
        expect(screen.getByText(/再生してから弾いてください/)).toBeInTheDocument();
    });

    it('止めると、鳴っている音も止まる', async () => {
        const midi = stubWebMidi();
        renderBar([]);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 入力' }));
        await screen.findByLabelText('録り方');
        act(() => { midi.send([0x90, 60, 100]); });
        expect(oscillators[0].stopped).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 入力を止める' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'MIDI 入力' })).toBeInTheDocument());
        expect(oscillators[0].stopped).toBe(true);
    });

    it('開けなかったら理由を出す', async () => {
        (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess = vi.fn(async () => { throw new Error('許可されませんでした'); });
        renderBar([]);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 入力' }));
        await waitFor(() => expect(screen.getByText(/MIDI 入力を開けませんでした: 許可されませんでした/)).toBeInTheDocument());
    });
});
