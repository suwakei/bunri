/**
 * 再生エンジンの区間ループ・速度・「聴く」のテスト (AudioContext は時計を進められるモック)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const started: { kind: 'buffer' | 'osc'; when: number; offset?: number; duration?: number; buffer?: unknown; freq?: number }[] = [];
class MockParam { value = 1; setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class MockGain { gain = new MockParam(); connect() { return this; } disconnect() {} }
class MockContext {
    currentTime = 0;
    state = 'running';
    destination = {};
    createGain() { return new MockGain() as unknown as GainNode; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { return this; } } as unknown as StereoPannerNode; }
    createBufferSource() {
        const node = { buffer: null as unknown, onended: null, connect() {}, stop() {},
            start(when: number, offset?: number, duration?: number) { started.push({ kind: 'buffer', when, offset, duration, buffer: node.buffer }); } };
        return node;
    }
    createOscillator() {
        const node = { type: 'sine', frequency: { value: 0 }, onended: null, connect() {}, stop() {},
            start(when: number) { started.push({ kind: 'osc', when, freq: node.frequency.value }); } };
        return node;
    }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockContext;

const { default: engine } = await import('../lib/engine');
const ctx = () => engine.ctx as unknown as MockContext;
const fakeBuffer = (duration: number) => ({ duration, length: duration * 100, sampleRate: 100, numberOfChannels: 1 }) as unknown as AudioBuffer;

beforeEach(() => {
    vi.useFakeTimers();
    started.length = 0;
    engine.stop();
    engine.tracks = [];
    engine.bpm = 120; engine.beatsPerBar = 4; engine.gridOffset = 0;
    engine.loopRange = null; engine.tempoRate = 1; engine.stretched = null; engine.listenOverride = null;
    engine.metronomeEnabled = false;
    engine.init();
    ctx().currentTime = 0;
});
afterEach(() => { engine.stop(); vi.useRealTimers(); });

describe('区間ループ', () => {
    it('周ごとに、クリップの読み始めと鳴らす時刻を決めて先に用意する (隙間なし)', () => {
        const t = engine.addTrack('パート');
        t.clips.push({ buffer: fakeBuffer(10), offset: 0, name: 'x', duration: 10 });
        engine.setLoopRange({ start: 2, end: 4 });
        engine.playOffset = 0;
        engine.play();
        // 区間の外から始めると、区間の頭から。0.03 秒先から鳴らす
        const clips = () => started.filter((s) => s.kind === 'buffer');
        expect(clips()).toEqual([expect.objectContaining({ when: 0.03, offset: 2, duration: 2 })]);
        // 時計が進むと、1.5 秒先までの周を用意する (前の周の終わりと次の周の頭が、同じ時刻)
        ctx().currentTime = 0.6;
        vi.advanceTimersByTime(100);
        expect(clips()[1]).toMatchObject({ when: 2.03, offset: 2, duration: 2 });
        ctx().currentTime = 2.6;
        vi.advanceTimersByTime(100);
        expect(clips().map((s) => s.when)).toEqual([0.03, 2.03, 4.03]);
    });
    it('再生位置は区間の終わりで頭に戻る。何周目かも分かる。一時停止すると、その位置を覚える', () => {
        engine.addTrack();
        engine.setLoopRange({ start: 2, end: 4 });
        engine.playOffset = 3;
        engine.play();
        ctx().currentTime = 0.03 + 0.5;
        expect(engine.getCurrentTime()).toBeCloseTo(3.5);
        ctx().currentTime = 0.03 + 1.5;
        expect(engine.getCurrentTime()).toBeCloseTo(2.5);
        expect(engine.getLoopPass()).toBe(1);
        engine.pause();
        expect(engine.playOffset).toBeCloseTo(2.5);
    });
    it('ノートは周ごとに鳴らす (区間の外のノートは鳴らさない)', () => {
        const t = engine.addTrack();
        t.pianoNotes = [{ note: 'A', octave: 4, step: 4, length: 2 }, { note: 'C', octave: 4, step: 40, length: 2 }];
        engine.setLoopRange({ start: 0, end: 1 }); // 1 ステップ = 0.125 秒。ステップ 4 は 0.5 秒
        engine.play(0);
        const a4 = started.filter((s) => s.kind === 'osc' && s.freq === 440).map((s) => s.when);
        expect(a4[0]).toBeCloseTo(0.53);
        expect(a4[1]).toBeCloseTo(1.53);
        expect(started.some((s) => s.kind === 'osc' && Math.round(s.freq!) === 262)).toBe(false);
    });
});

describe('速度', () => {
    it('速度を変えると、伸ばした音声を鳴らし、ノートの間隔も伸ばす (音の高さはそのまま)', () => {
        const part = engine.addTrack('パート');
        part.clips.push({ buffer: fakeBuffer(10), offset: 0, name: 'x', duration: 10 });
        part.pianoNotes = [{ note: 'A', octave: 4, step: 4, length: 2 }];
        engine.setLoopRange({ start: 0, end: 2 });
        const stretched = { trackId: part.id, start: 0, end: 2, rate: 0.5, buffer: fakeBuffer(4) };
        engine.setTempo(0.5, stretched);
        engine.play(0);
        ctx().currentTime = 3;
        vi.advanceTimersByTime(100);
        const clips = started.filter((s) => s.kind === 'buffer');
        expect(clips[0]).toMatchObject({ when: 0.03, offset: 0, duration: 4, buffer: stretched.buffer });
        expect(clips[1].when).toBeCloseTo(4.03);
        ctx().currentTime = 0;
        const note = started.find((s) => s.kind === 'osc')!;
        expect(note.when).toBeCloseTo(0.03 + 1);
        expect(note.freq).toBe(440);
        ctx().currentTime = 0.03 + 2;
        expect(engine.getCurrentTime()).toBeCloseTo(1);
    });
    it('伸ばした音声が無いトラックのクリップは、速度を変えているあいだ鳴らさない (ずれた音を出さない)', () => {
        const t = engine.addTrack();
        t.clips.push({ buffer: fakeBuffer(10), offset: 0, name: 'x', duration: 10 });
        engine.setLoopRange({ start: 0, end: 2 });
        engine.setTempo(0.75, null);
        engine.play(0);
        expect(started.filter((s) => s.kind === 'buffer')).toHaveLength(0);
    });
    it('区間ループが無ければ、速度は効かない', () => {
        engine.tempoRate = 0.5;
        expect(engine.effectiveRate()).toBe(1);
    });
});

describe('聴く (一時的な上書き)', () => {
    it('ミュート・ソロを書き換えずに、鳴らすトラックを差し替える。外すと元に戻る', () => {
        const part = engine.addTrack('パート'), mine = engine.addTrack('練習'), song = engine.addTrack('原曲');
        engine.toggleMute(part.id);
        engine.setListenOverride([part.id]);
        expect(engine.playbackTracks()).toEqual([part]);
        expect(part.mute).toBe(true);
        expect(part.gainNode.gain.value).toBe(1);
        expect(song.gainNode.gain.value).toBe(0);
        // 書き出しはプロジェクトのミュートとソロのとおり
        expect(engine.audibleTracks()).toEqual([mine, song]);
        engine.setListenOverride(null);
        expect(engine.playbackTracks()).toEqual([mine, song]);
        expect(part.gainNode.gain.value).toBe(0);
        expect(song.gainNode.gain.value).toBe(1);
    });
});
