/**
 * ドラムの決まり（lib/drums.ts）、ドラムの音（lib/drum-sound.ts）、再生エンジンがドラムのトラックを鳴らすところのテスト。
 * AudioContext は、作られた音源と鳴らした時刻を記録する偽物。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** 鳴らした音源の記録。`voice` は、つないだ先から分かる音の作り（サイン波 / ノイズ / 三角波）。 */
interface Started {
    kind: 'osc' | 'noise';
    type?: string;
    when: number;
    /** オシレータの始めの高さ（Hz） */
    freq?: number;
    /** 山の高さ（音量の上げ先） */
    peak?: number;
    /** ノイズのフィルタ */
    filter?: { type: string; frequency: number };
    ctx: string;
}
const started: Started[] = [];
let buffersMade = 0;

class MockParam {
    value = 1;
    first: number | null = null;
    peak: number | null = null;
    setValueAtTime(v: number) { if (this.first === null) this.first = v; this.value = v; }
    linearRampToValueAtTime(v: number) { if (this.peak === null) this.peak = v; }
    exponentialRampToValueAtTime() {}
}
class MockNode {
    gain = new MockParam();
    frequency = new MockParam();
    type = '';
    out: MockNode | null = null;
    connect(node: MockNode) { this.out = node; return node; }
    disconnect() {}
}
/** つないだ先を辿って、山の高さとフィルタを集める。 */
function chain(node: MockNode): { peak?: number; filter?: { type: string; frequency: number } } {
    const found: { peak?: number; filter?: { type: string; frequency: number } } = {};
    for (let n: MockNode | null = node.out; n; n = n.out) {
        if (n.type) found.filter = { type: n.type, frequency: n.frequency.value };
        if (n.gain.peak !== null && found.peak === undefined) found.peak = n.gain.peak;
    }
    return found;
}
class MockContext {
    currentTime = 0;
    state = 'running';
    destination = new MockNode();
    constructor(public name = 'live', public sampleRate = 48000) {}
    createGain() { return new MockNode(); }
    createStereoPanner() { const node = new MockNode(); (node as unknown as { pan: { value: number } }).pan = { value: 0 }; return node; }
    createBiquadFilter() { return new MockNode(); }
    createBuffer(_channels: number, length: number, sampleRate: number) {
        buffersMade += 1;
        const data = new Float32Array(length);
        return { length, sampleRate, duration: length / sampleRate, numberOfChannels: 1, getChannelData: () => data };
    }
    createBufferSource() {
        const node = new MockNode() as MockNode & { buffer: unknown; onended: unknown; start: (when: number) => void; stop: () => void };
        node.buffer = null; node.onended = null; node.stop = () => {};
        node.start = (when: number) => { started.push({ kind: 'noise', when, ctx: this.name, ...chain(node) }); };
        return node;
    }
    createOscillator() {
        const node = new MockNode() as MockNode & { onended: unknown; start: (when?: number) => void; stop: () => void };
        node.type = ''; node.onended = null; node.stop = () => {};
        node.start = (when?: number) => {
            started.push({ kind: 'osc', type: node.type, when: when ?? this.currentTime, freq: node.frequency.first ?? node.frequency.value, ctx: this.name, ...chain(node) });
        };
        return node;
    }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockContext;

const { default: engine, noteLevel } = await import('../lib/engine');
const drums = await import('../lib/drums');
const { playDrum, noiseBuffer } = await import('../lib/drum-sound');
const { issueText } = await import('../lib/coach');
const { noteMarkLabel } = await import('../lib/practice');

const note = (name: string, octave: number, step: number, length = 1, velocity?: number) =>
    (velocity === undefined ? { note: name, octave, step, length } : { note: name, octave, step, length, velocity });
const ctx = () => engine.ctx as unknown as MockContext;

/** 鳴らした音を、種類の分かる短い名前にする（サイン波の始めの高さで、キックとタムを見分ける）。 */
function voiceOf(s: Started): string {
    if (s.kind === 'noise') return s.filter && s.filter.frequency >= 5000 ? 'hat' : 'snare-noise';
    if (s.type === 'triangle') return 'triangle';
    if (s.freq === 150) return 'kick';
    if (s.freq === 210) return 'tom';
    return 'snare-tone';
}

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

describe('種類と高さの対応', () => {
    it('キック C2・スネア D2・ハイハットとシンバル F#2・タム A2（GM のドラムの並び）', () => {
        expect(drums.DRUM_ROWS.map((row) => [row.voice, `${row.note}${row.octave}`, row.pitch, row.label])).toEqual([
            ['kick', 'C2', 36, 'キック'],
            ['snare', 'D2', 38, 'スネア'],
            ['hat', 'F#2', 42, 'ハイハット・シンバル'],
            ['tom', 'A2', 45, 'タム'],
        ]);
    });

    it('採譜の種類（分けたとき・分けなかったとき）から、行を引く', () => {
        const pitchOf = (type: string) => drums.drumRowOfType(type)?.pitch ?? null;
        // 種類ごとに分けたとき
        expect(['kick', 'snare', 'toms', 'cymbals'].map(pitchOf)).toEqual([36, 38, 45, 42]);
        // 分けなかったとき（これまでの 3 種類）。ハイハットは、シンバルと同じ行
        expect(['kick', 'snare', 'hihat'].map(pitchOf)).toEqual([36, 38, 42]);
        expect(pitchOf('cowbell')).toBeNull();
        expect(pitchOf('constructor')).toBeNull();
    });

    it('高さとノートから、行を引く。ドラムの行でない高さは null', () => {
        expect(drums.drumRowOfPitch(36)?.voice).toBe('kick');
        expect(drums.drumRowOfPitch(37)).toBeNull();
        expect(drums.drumRowOfNote(note('F#', 2, 0))?.label).toBe('ハイハット・シンバル');
        expect(drums.drumRowOfNote(note('F#', 3, 0))).toBeNull();
    });

    it('打音をノートにする: 決まった高さ・長さ 1・強さつき。ステップは小数でもそのまま', () => {
        expect(drums.drumEventsToNotes([
            { type: 'kick', step: 0, velocity: 100.4 }, { type: 'toms', step: 2.5, velocity: 300 },
            { type: 'snare', step: 4 }, { type: 'nope', step: 6, velocity: 90 }, { type: 'kick', step: -1, velocity: 90 },
        ])).toEqual([
            { note: 'C', octave: 2, step: 0, length: 1, velocity: 100 },
            { note: 'A', octave: 2, step: 2.5, length: 1, velocity: 127 },
            { note: 'D', octave: 2, step: 4, length: 1 },
        ]);
    });

    it('三連のグリッドで採譜した打音: 位置を 1/60 ステップの倍数にそろえる。長さが付いていれば、それを使う', () => {
        expect(drums.drumEventsToNotes([
            { type: 'hihat', step: 1.3333 }, { type: 'hihat', step: 2.6666666666666665 }, { type: 'kick', step: 4.0000001 },
            { type: 'cymbals', step: 5.3333, length: 0.6667 }, { type: 'snare', step: 8, length: 0 }, { type: 'snare', step: 12, length: Number.NaN },
        ])).toEqual([
            { note: 'F#', octave: 2, step: 4 / 3, length: 1 },
            { note: 'F#', octave: 2, step: 8 / 3, length: 1 },
            { note: 'C', octave: 2, step: 4, length: 1 },
            { note: 'F#', octave: 2, step: 16 / 3, length: 2 / 3 },
            { note: 'D', octave: 2, step: 8, length: 1 },
            { note: 'D', octave: 2, step: 12, length: 1 },
        ]);
    });
});

describe('ドラムのトラックの見分け方と、差分の比べ方', () => {
    const trackOf = (id: number) => (id === 7 ? { part: 'drums' } : id === 8 ? { part: 'bass' } : undefined);

    it('ドラムのパートと、その練習のトラックが、ドラムのトラック', () => {
        expect(drums.isDrumPart('drums')).toBe(true);
        expect(drums.isDrumPart('other_drums')).toBe(true);
        expect(drums.isDrumPart('bass')).toBe(false);
        expect(drums.isDrumPart(undefined)).toBe(false);
        expect(drums.isDrumTrack({ part: 'drums' })).toBe(true);
        expect(drums.isDrumTrack({ practiceOf: 7 }, trackOf)).toBe(true);
        expect(drums.isDrumTrack({ practiceOf: 8 }, trackOf)).toBe(false);
        expect(drums.isDrumTrack(null)).toBe(false);
    });

    it('お手本がドラムのパートのときだけ、ドラムの比べ方にする', () => {
        expect(drums.diffModeOf({ part: 'drums' })).toBe('drums');
        expect(drums.diffModeOf({ part: 'other_drums' })).toBe('drums');
        expect(drums.diffModeOf({ part: 'bass' })).toBeUndefined();
        expect(drums.diffModeOf({ part: 'midi' })).toBeUndefined();
        expect(drums.diffModeOf({})).toBeUndefined();
        expect(drums.diffModeOf(undefined)).toBeUndefined();
    });

    it('以前の分け方のドラム: ドラムのパートで、お手本を持たない', () => {
        expect(drums.isLegacyDrumPart({ role: 'part', part: 'drums' })).toBe(true);
        expect(drums.isLegacyDrumPart({ role: 'part', part: 'drums', referenceNotes: [] })).toBe(true);
        expect(drums.isLegacyDrumPart({ role: 'part', part: 'drums', referenceNotes: [note('C', 2, 0)] })).toBe(false);
        expect(drums.isLegacyDrumPart({ role: 'practice', part: 'drums' })).toBe(false);
        expect(drums.isLegacyDrumPart({ role: 'part', part: 'bass' })).toBe(false);
    });

    it('指摘の文は、ドラムの比べ方のときだけ、種類の名前で書く', () => {
        const issue = { kind: 'missing' as const, bar: 1, beat: 2, expected: note('D', 2, 4), actual: null, offset_steps: null, length_diff: null };
        expect(issueText(issue, 'drums')).toBe('1 小節 2 拍目: スネア が抜けています');
        expect(issueText(issue)).toBe('1 小節 2 拍目: D2 が抜けています');
        const late = { ...issue, kind: 'timing' as const, expected: note('F#', 2, 4), actual: note('F#', 2, 5), offset_steps: 1 };
        expect(issueText(late, 'drums')).toBe('1 小節 2 拍目: ハイハット・シンバル が16 分音符 1 個ぶん遅い');
        // ドラムの行でない高さに置いたノートは、音名のまま
        const extra = { ...issue, kind: 'extra' as const, expected: null, actual: note('E', 2, 4) };
        expect(issueText(extra, 'drums')).toBe('1 小節 2 拍目: E2 はお手本にありません');
        // ノートの読み上げの名前も同じ
        expect(noteMarkLabel(note('D', 2, 4), { kind: 'missing', issues: [issue] }, true, 'drums'))
            .toBe('お手本 スネア: お手本の抜け。1 小節 2 拍目: スネア が抜けています');
        expect(noteMarkLabel(note('D', 2, 4), { kind: 'ok', issues: [] })).toBe('D2: 合っている');
    });
});

describe('ドラムの音（playDrum）', () => {
    it('種類ごとに、決まった作りの音を、渡された時刻に鳴らす', () => {
        const c = new MockContext('test') as unknown as BaseAudioContext;
        const out = new MockNode() as unknown as AudioNode;
        for (const voice of ['kick', 'snare', 'hat', 'tom'] as const) {
            started.length = 0;
            const sources = playDrum(c, out, voice, 1.5, 0.25);
            expect(started.every((s) => s.when === 1.5)).toBe(true);
            expect(sources).toHaveLength(started.length);
            expect(started.map(voiceOf).sort()).toEqual({
                kick: ['kick'], snare: ['snare-noise', 'snare-tone'], hat: ['hat'], tom: ['tom'],
            }[voice]);
        }
    });

    it('キックとタムは下がるサイン波、スネアとハイハットはフィルタを通したノイズ', () => {
        const c = new MockContext('test') as unknown as BaseAudioContext;
        const out = new MockNode() as unknown as AudioNode;
        playDrum(c, out, 'kick', 0, 0.25); playDrum(c, out, 'hat', 0, 0.25); playDrum(c, out, 'snare', 0, 0.25);
        expect(started[0]).toMatchObject({ kind: 'osc', type: 'sine', freq: 150 });
        expect(started[1]).toMatchObject({ kind: 'noise', filter: { type: 'highpass', frequency: 7000 } });
        expect(started[2]).toMatchObject({ kind: 'noise', filter: { type: 'highpass', frequency: 1200 } });
    });

    it('音量は、渡された基準に比例する', () => {
        const c = new MockContext('test') as unknown as BaseAudioContext;
        const out = new MockNode() as unknown as AudioNode;
        playDrum(c, out, 'kick', 0, 0.25); playDrum(c, out, 'kick', 0, 0.125);
        expect(started[0].peak! / started[1].peak!).toBeCloseTo(2);
        expect(started[0].peak!).toBeGreaterThan(0.25);
    });

    it('ノイズのバッファは、サンプルレートごとに 1 度だけ作る', () => {
        const a = new MockContext('a', 32000) as unknown as BaseAudioContext;
        const b = new MockContext('b', 32000) as unknown as BaseAudioContext;
        const out = new MockNode() as unknown as AudioNode;
        const before = buffersMade;
        const first = noiseBuffer(a);
        playDrum(a, out, 'snare', 0, 0.25); playDrum(a, out, 'hat', 0.5, 0.25); playDrum(b, out, 'hat', 0, 0.25);
        expect(noiseBuffer(b)).toBe(first);
        expect(buffersMade - before).toBe(1);
        // 中身は −1〜1 のノイズ（無音ではない）で、作るたびに同じ数列
        const data = first.getChannelData(0);
        expect(Math.max(...data)).toBeGreaterThan(0.5);
        expect(Math.min(...data)).toBeLessThan(-0.5);
        // 別のサンプルレートでは、別に作る
        noiseBuffer(new MockContext('c', 22050) as unknown as BaseAudioContext);
        expect(buffersMade - before).toBe(2);
    });
});

describe('再生エンジン: ドラムのトラックのノート', () => {
    /** ドラムのパートと、その練習のトラックを作る。 */
    function drumTracks() {
        const part = engine.addTrack('ドラム'); part.role = 'part'; part.part = 'drums';
        const practice = engine.addTrack('ドラムの練習'); practice.role = 'practice'; practice.part = 'drums'; practice.practiceOf = part.id;
        return { part, practice };
    }
    const kit = [note('C', 2, 0), note('D', 2, 4), note('F#', 2, 4), note('A', 2, 8)];

    it('ドラムのトラックのノートは、種類ごとの音で鳴る。同時の打音は、両方鳴る', () => {
        const { practice } = drumTracks();
        practice.pianoNotes = kit;
        engine.play();
        // 120 BPM の 16 分音符は 0.125 秒
        const at = (when: number) => started.filter((s) => Math.abs(s.when - when) < 1e-9).map(voiceOf).sort();
        expect(at(0)).toEqual(['kick']);
        expect(at(0.5)).toEqual(['hat', 'snare-noise', 'snare-tone']);
        expect(at(1)).toEqual(['tom']);
        expect(started.some((s) => s.type === 'triangle')).toBe(false);
    });

    it('ドラムの行でない高さのノートと、ドラムでないトラックのノートは、これまでどおり三角波', () => {
        const { practice } = drumTracks();
        practice.pianoNotes = [note('E', 2, 0), note('C', 4, 4)];
        const bass = engine.addTrack('ベース'); bass.role = 'part'; bass.part = 'bass';
        bass.pianoNotes = [note('C', 2, 0), note('D', 2, 4)];
        engine.play();
        expect(started.map(voiceOf)).toEqual(['triangle', 'triangle', 'triangle', 'triangle']);
    });

    it('以前の分け方のドラム（ノートが打ち込みに置いてある）も、ドラムの音で鳴る', () => {
        const legacy = engine.addTrack('ドラム'); legacy.role = 'part'; legacy.part = 'drums';
        legacy.pianoNotes = [note('C', 2, 0), note('F#', 2, 2)];
        engine.play();
        expect(started.map(voiceOf)).toEqual(['kick', 'hat']);
    });

    it('強さ（velocity）が、音量に反映される', () => {
        const { practice } = drumTracks();
        practice.pianoNotes = [note('C', 2, 0, 1, 48), note('C', 2, 4, 1, 96), note('C', 2, 8)];
        engine.play();
        const [soft, normal, unset] = started.map((s) => s.peak!);
        expect(soft / normal).toBeCloseTo(noteLevel(48) / noteLevel(96));
        expect(unset).toBeCloseTo(normal);
    });

    it('再生位置がノートの頭を過ぎていたら、その打音は鳴らさない（打った瞬間の音なので、途中からは鳴らさない）', () => {
        const { practice } = drumTracks();
        practice.pianoNotes = [note('C', 2, 0, 4), note('D', 2, 4)];
        // キックの頭 (0 秒) を過ぎ、長さ (0.5 秒) の中に居る
        engine.playOffset = 0.25;
        engine.play();
        expect(started.map(voiceOf)).toEqual(['snare-noise', 'snare-tone']);
        expect(started[0].when).toBeCloseTo(0.25);
    });

    it('区間ループでも同じ音で鳴り、周ごとに鳴らし直す', () => {
        const { practice } = drumTracks();
        practice.pianoNotes = [note('C', 2, 0), note('F#', 2, 2)];
        engine.setLoopRange({ start: 0, end: 1 });
        engine.playOffset = 0;
        engine.play();
        ctx().currentTime = 0.6;
        vi.advanceTimersByTime(100);
        const kicks = started.filter((s) => voiceOf(s) === 'kick').map((s) => s.when);
        expect(kicks.slice(0, 2)).toEqual([0.03, 1.03]);
        expect(started.filter((s) => voiceOf(s) === 'hat').map((s) => s.when)[0]).toBeCloseTo(0.28);
        expect(started.some((s) => s.type === 'triangle')).toBe(false);
    });

    it('鍵盤の試し聴き: ドラムのトラックに向けて弾いたときだけ、ドラムの行が種類の音で鳴る', () => {
        engine.liveNoteOn(36, 96, { drums: true });
        engine.liveNoteOn(42, 96, { drums: true });
        expect(started.map(voiceOf)).toEqual(['kick', 'hat']);
        // 打った瞬間の音なので、押している音としては覚えない (離しても、止める相手が無い)
        expect(engine.liveVoices.size).toBe(0);
        // ドラムの行でない高さと、ドラムでないトラックでは、これまでどおり
        started.length = 0;
        engine.liveNoteOn(40, 96, { drums: true });
        engine.liveNoteOn(36, 96);
        expect(started.map(voiceOf)).toEqual(['triangle', 'triangle']);
        expect(engine.liveVoices.size).toBe(2);
        engine.liveAllNotesOff();
    });

    it('書き出し（OfflineAudioContext）でも、同じ関数で同じ音を鳴らす', async () => {
        const { practice } = drumTracks();
        practice.pianoNotes = kit;
        const original = globalThis.OfflineAudioContext;
        class MockOffline extends MockContext {
            constructor() { super('offline', 44100); }
            async startRendering() { return { duration: 1 } as unknown as AudioBuffer; }
        }
        // @ts-expect-error OfflineAudioContext モック
        globalThis.OfflineAudioContext = MockOffline;
        try {
            started.length = 0;
            await engine.mixdown();
        } finally {
            globalThis.OfflineAudioContext = original;
        }
        expect(started.every((s) => s.ctx === 'offline')).toBe(true);
        const at = (when: number) => started.filter((s) => Math.abs(s.when - when) < 1e-9).map(voiceOf).sort();
        expect(at(0)).toEqual(['kick']);
        expect(at(0.5)).toEqual(['hat', 'snare-noise', 'snare-tone']);
        expect(at(1)).toEqual(['tom']);
    });
});
