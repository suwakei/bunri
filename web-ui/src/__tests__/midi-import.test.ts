/**
 * lib/midi-import.ts のテスト。MIDI ファイルの中身を、どのトラックにどう読み込むか。
 */
import { beforeEach, describe, expect, it } from 'vitest';

class FakeNode { connect() {} disconnect() {} gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }; pan = { value: 0 }; }
class FakeAudioContext {
    currentTime = 0; destination = new FakeNode(); state = 'running';
    createGain() { return new FakeNode(); }
    createStereoPanner() { return new FakeNode(); }
    resume() { return Promise.resolve(); }
}
(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;

const { default: engine, MIDI_PART } = await import('../lib/engine');
const { notesToMidi, parseMidi } = await import('../lib/midi');
const {
    allowedModes, applyMidiImport, beatsPerBarOf, defaultModes, importedMessage, isEmptyProject, lossNotices, tempoNotice,
} = await import('../lib/midi-import');
import type { MidiImportResult } from '../lib/midi';

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });
const withVelocity = (notes: ReturnType<typeof note>[]) => notes.map((n) => ({ ...n, velocity: 96 }));

/** 2 本のメロディと、ドラムのチャンネル 1 本を持つ結果。 */
function sample(overrides: Partial<MidiImportResult> = {}): MidiImportResult {
    return {
        bpm: 96, timeSignature: [3, 4],
        tracks: [
            { name: 'Lead', notes: withVelocity([note('C', 4, 0), note('E', 4, 4)]), isDrum: false, rounded: 0, merged: 0, unterminated: 0 },
            { name: 'Bass', notes: withVelocity([note('E', 1, 0, 8)]), isDrum: false, rounded: 0, merged: 0, unterminated: 0 },
            { name: 'Kit', notes: withVelocity([note('C', 2, 0, 1)]), isDrum: true, rounded: 0, merged: 0, unterminated: 0 },
        ],
        loss: { rounded: 0, merged: 0, unterminated: 0, tempoChanges: 0 },
        ...overrides,
    };
}

beforeEach(() => {
    for (const track of engine.tracks.slice()) engine.removeTrack(track.id);
});

describe('読み込み方', () => {
    it('既定は、ドラムが「読み込まない」、ほかは「新しいトラック」', () => {
        expect(defaultModes(sample())).toEqual(['track', 'track', 'skip']);
    });

    it('ドラムは、お手本にできない', () => {
        const [lead, , kit] = sample().tracks;
        expect(allowedModes(lead)).toEqual(['track', 'reference', 'skip']);
        expect(allowedModes(kit)).toEqual(['track', 'skip']);
    });
});

describe('applyMidiImport', () => {
    it('新しいトラック: ノートが、強さごと打ち込みになる', () => {
        const outcome = applyMidiImport(engine, sample(), ['track', 'skip', 'skip']);

        expect(outcome.created.map((t) => t.name)).toEqual(['Lead']);
        expect(engine.tracks).toHaveLength(1);
        expect(engine.tracks[0].pianoNotes).toEqual(withVelocity([note('C', 4, 0), note('E', 4, 4)]));
        expect(engine.tracks[0].role).toBeUndefined();
        expect(outcome.references).toBe(0);
    });

    it('お手本: パートのトラックになり、ノートはお手本に入って、打ち込みは空のまま', () => {
        const outcome = applyMidiImport(engine, sample(), ['reference', 'track', 'skip']);
        const [lead, bass] = engine.tracks;

        expect(lead.role).toBe('part');
        expect(lead.part).toBe(MIDI_PART);
        expect(lead.referenceNotes).toEqual(withVelocity([note('C', 4, 0), note('E', 4, 4)]));
        expect(lead.pianoNotes).toEqual([]);
        expect(bass.pianoNotes).toEqual(withVelocity([note('E', 1, 0, 8)]));
        expect(outcome.references).toBe(1);
    });

    it('ドラムをお手本に、という指定は無視する', () => {
        const outcome = applyMidiImport(engine, sample(), ['skip', 'skip', 'reference']);
        expect(outcome.created).toHaveLength(0);
        expect(engine.tracks).toHaveLength(0);
    });

    it('プロジェクトが空のときだけ、テンポと拍子を MIDI に合わせる', () => {
        engine.addTrack('空のトラック');
        expect(isEmptyProject(engine)).toBe(true);
        expect(applyMidiImport(engine, sample(), ['track', 'skip', 'skip'])).toMatchObject({ bpm: 96, beatsPerBar: 3 });

        // 2 回目は、もうノートが在るので変えない
        expect(isEmptyProject(engine)).toBe(false);
        expect(applyMidiImport(engine, sample({ bpm: 150 }), ['track', 'skip', 'skip'])).toMatchObject({ bpm: null, beatsPerBar: null });
    });

    it('お手本だけを持つプロジェクトも、空ではない', () => {
        applyMidiImport(engine, sample(), ['reference', 'skip', 'skip']);
        expect(isEmptyProject(engine)).toBe(false);
    });

    it('書き出した MIDI を読んで、そのまま読み込める', () => {
        const bytes = notesToMidi([{ name: 'メロディ', notes: [note('G', 4, 0), note('A', 4, 4, 2)] }], 132);
        const result = parseMidi(bytes);
        const outcome = applyMidiImport(engine, result, defaultModes(result));

        expect(outcome.bpm).toBe(132);
        expect(engine.tracks[0].name).toBe('メロディ');
        // 書き出すときに付いた既定の強さ (96) が、読み込んだノートに入る
        expect(engine.tracks[0].pianoNotes).toEqual(withVelocity([note('G', 4, 0), note('A', 4, 4, 2)]));
    });
});

describe('MIDI のお手本の音', () => {
    it('打ち込みが空のあいだは、お手本のノートを鳴らす。打ち込んだら、打ち込みを鳴らす', () => {
        applyMidiImport(engine, sample(), ['reference', 'skip', 'skip']);
        const [lead] = engine.tracks;

        expect(engine.soundingNotes(lead)).toEqual(lead.referenceNotes);
        // お手本の終わり (8 ステップ = 120 BPM で 1 秒) までが、曲の長さになる
        expect(engine.getTotalDuration()).toBeCloseTo(8 * (60 / engine.bpm / 4));

        lead.pianoNotes = [note('D', 4, 0)];
        expect(engine.soundingNotes(lead)).toEqual([note('D', 4, 0)]);
    });

    it('パート分離で作ったパートは、お手本を鳴らさない（パートの音声がお手本の音）', () => {
        const track = engine.addTrack('ベース');
        track.role = 'part';
        track.part = 'bass';
        track.referenceNotes = [note('E', 1, 0)];

        expect(engine.soundingNotes(track)).toEqual([]);
    });
});

describe('画面の文', () => {
    it('拍子: 選択肢に在るものだけを、1 小節の拍数にする', () => {
        expect(beatsPerBarOf([4, 4])).toBe(4);
        expect(beatsPerBarOf([3, 4])).toBe(3);
        expect(beatsPerBarOf([6, 8])).toBe(6);
        expect(beatsPerBarOf([5, 4])).toBeNull();
        expect(beatsPerBarOf(null)).toBeNull();
    });

    it('テンポの扱いを、場合ごとに伝える', () => {
        expect(tempoNotice(sample(), 120, true)).toBe('テンポを、MIDI ファイルの 96 BPM に合わせます');
        expect(tempoNotice(sample(), 120, false)).toContain('いまのテンポ（120 BPM）は変えません');
        expect(tempoNotice(sample(), 96, false)).toBe('テンポは、いまと同じ 96 BPM です');
        expect(tempoNotice(sample({ bpm: null }), 120, true)).toContain('テンポが書かれていません');
    });

    it('丸めなどで変わることを伝える。変わることが無ければ、何も出さない', () => {
        expect(lossNotices(sample(), ['track', 'track', 'skip'])).toEqual([]);

        const lossy = sample({ loss: { rounded: 8, merged: 1, unterminated: 2, tempoChanges: 4 } });
        Object.assign(lossy.tracks[0], { rounded: 2, merged: 1, unterminated: 0 });
        Object.assign(lossy.tracks[1], { rounded: 1, merged: 0, unterminated: 2 });
        Object.assign(lossy.tracks[2], { rounded: 5, merged: 0, unterminated: 0 });
        const notices = lossNotices(lossy, ['track', 'track', 'skip']);
        expect(notices[0]).toContain('丸めたノートが 3 個');
        expect(notices[1]).toContain('1 つにまとめました（1 個）');
        expect(notices[2]).toContain('トラックの終わりまで伸ばしました（2 個）');
        expect(notices[3]).toContain('テンポの変化（4 回）');
        // 「読み込まない」にしたトラックのぶんは数えない
        expect(lossNotices(lossy, ['skip', 'track', 'skip'])[0]).toContain('丸めたノートが 1 個');
        expect(lossNotices(lossy, ['track', 'track', 'track'])[0]).toContain('丸めたノートが 8 個');
    });

    it('表示できない高さのノートは、読み込むトラックのぶんだけ数える', () => {
        const high = sample();
        high.tracks[0].notes = withVelocity([note('C', 9, 0), note('C', -1, 4), note('C', 4, 8)]);
        expect(lossNotices(high, ['track', 'track', 'skip'])[0]).toContain('外のノートが 2 個');
        expect(lossNotices(high, ['skip', 'track', 'skip'])).toEqual([]);
    });

    it('読み込んだ後の知らせ', () => {
        const lead = engine.addTrack('Lead'), bass = engine.addTrack('Bass');
        expect(importedMessage('a.mid', { created: [lead, bass], references: 0, bpm: null, beatsPerBar: null }))
            .toBe('a.mid から 2 本のトラックを読み込みました');
        expect(importedMessage('a.mid', { created: [lead], references: 1, bpm: null, beatsPerBar: null }))
            .toBe('a.mid から 1 本のお手本を読み込みました。お手本は「学ぶ」タブの「曲とパート」に出ます。「このパートを練習する」で始められます');
        expect(importedMessage('a.mid', { created: [lead, bass], references: 1, bpm: null, beatsPerBar: null }))
            .toContain('2 本のトラック（うちお手本 1 本）');
    });
});
