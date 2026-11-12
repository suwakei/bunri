/**
 * プロジェクトの控えと、元に戻す (lib/project-snapshot.ts、ストアの record / undo / redo)。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    connect() { return this; }
}
class MockStereoPannerNode {
    pan = { value: 0 };
    connect() { return this; }
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return new MockStereoPannerNode() as unknown as StereoPannerNode; }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { default: engine } = await import('../lib/engine');
const { applyProject, captureProject, projectsEqual, snapshotCost } = await import('../lib/project-snapshot');
const { DawProvider, useDaw } = await import('../lib/store');

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });
const fakeBuffer = (duration: number) => ({ duration } as unknown as AudioBuffer);

beforeEach(() => {
    cleanup();
    engine.init();
    engine.tracks = [];
    engine.bpm = 120; engine.beatsPerBar = 4; engine.gridOffset = 0;
});

describe('captureProject / applyProject', () => {
    it('ノートの並びは、直前の控えと中身が同じなら同じ配列を共有する (写さない)', () => {
        const a = engine.addTrack('A'), b = engine.addTrack('B');
        a.pianoNotes = [note('C', 4, 0)];
        b.pianoNotes = [note('E', 4, 0)];
        const first = captureProject(engine);
        // A だけ書き換える (中身の同じ新しい配列にしても、共有する)
        b.pianoNotes = b.pianoNotes.map(n => ({ ...n }));
        a.pianoNotes = [...a.pianoNotes, note('D', 4, 4)];
        const second = captureProject(engine, first);
        expect(second.tracks[1].notes).toBe(first.tracks[1].notes);
        expect(second.tracks[0].notes).not.toBe(first.tracks[0].notes);
        // 記録が抱える量は、共有していないぶん (A の 2 ノート) だけ
        expect(snapshotCost(first, second)).toBe(1 + 2);
    });

    it('クリップの控えは、音声を写さずに同じ AudioBuffer を指す。その場で動かしても控えは変わらない', () => {
        const t = engine.addTrack('A');
        const buffer = fakeBuffer(2);
        t.clips.push({ buffer, offset: 0, name: 'x.wav', duration: 2 });
        const before = captureProject(engine);
        engine.moveClip(t.id, 0, 3);
        const after = captureProject(engine, before);
        expect(before.tracks[0].clips[0].buffer).toBe(buffer);
        expect(before.tracks[0].clips[0].offset).toBe(0);
        expect(after.tracks[0].clips[0].offset).toBe(3);
        applyProject(engine, before, after);
        expect(t.clips[0].offset).toBe(0);
        expect(t.clips[0].buffer).toBe(buffer);
    });

    it('消したトラックを戻すと、同じオブジェクト (同じ ID・再生のつなぎ) が同じ位置に戻る', () => {
        const a = engine.addTrack('A'), b = engine.addTrack('B'), c = engine.addTrack('C');
        b.pianoNotes = [note('G', 3, 8)];
        const before = captureProject(engine);
        engine.removeTrack(b.id);
        const after = captureProject(engine, before);
        applyProject(engine, before, after);
        expect(engine.tracks).toEqual([a, b, c]);
        expect(engine.tracks[1]).toBe(b);
        expect(b.pianoNotes).toEqual([note('G', 3, 8)]);
        // やり直すと、また消える
        applyProject(engine, after, before);
        expect(engine.tracks).toEqual([a, c]);
    });

    it('足したトラックは、元に戻すと外れる。並びの変更も戻る', () => {
        const a = engine.addTrack('A'), b = engine.addTrack('B');
        const before = captureProject(engine);
        const c = engine.addTrack('C');
        engine.tracks = [c, b, a];
        const after = captureProject(engine, before);
        applyProject(engine, before, after);
        expect(engine.tracks).toEqual([a, b]);
        applyProject(engine, after, before);
        expect(engine.tracks).toEqual([c, b, a]);
    });

    it('音量・パン・ミュートを戻すと、再生のつなぎにも当たる', () => {
        const t = engine.addTrack('A');
        const before = captureProject(engine);
        engine.updateTrackGain(t.id, -20);
        engine.updateTrackPan(t.id, -0.5);
        const after = captureProject(engine, before);
        expect(t.gainNode.gain.value).toBeCloseTo(0.1);
        applyProject(engine, before, after);
        expect([t.gain, t.pan, t.gainNode.gain.value, t.panNode.pan.value]).toEqual([0, 0, 1, 0]);
        engine.toggleMute(t.id);
        const muted = captureProject(engine);
        engine.toggleMute(t.id);
        applyProject(engine, muted, captureProject(engine));
        expect(t.mute).toBe(true);
        expect(t.gainNode.gain.value).toBe(0);
    });

    it('その操作で変えていないところは、元に戻しても変えない (履歴に載らない変更を巻き戻さない)', () => {
        const a = engine.addTrack('A'), b = engine.addTrack('B');
        const before = captureProject(engine);
        a.pianoNotes = [note('C', 4, 0)];
        const after = captureProject(engine, before);
        // 履歴に載らずに、B の名前とテンポが変わった
        b.name = 'ベース';
        engine.bpm = 90;
        expect(applyProject(engine, before, after)).toBeNull();
        expect(a.pianoNotes).toEqual([]);
        expect(b.name).toBe('ベース');
        expect(engine.bpm).toBe(90);
    });

    it('その操作でグリッドが変わっていたら、戻すグリッドを返す', () => {
        engine.addTrack('A');
        const before = captureProject(engine);
        engine.bpm = 97.5; engine.gridOffset = 0.25;
        const after = captureProject(engine, before);
        expect(applyProject(engine, before, after)).toEqual({ bpm: 120, beatsPerBar: 4, offsetSec: 0 });
    });

    it('projectsEqual: 中身が同じなら同じ (新しい配列でも)', () => {
        const t = engine.addTrack('A');
        t.pianoNotes = [note('C', 4, 0)];
        const a = captureProject(engine);
        t.pianoNotes = [note('C', 4, 0)];
        expect(projectsEqual(a, captureProject(engine))).toBe(true);
        t.pianoNotes = [note('C', 4, 4)];
        expect(projectsEqual(a, captureProject(engine))).toBe(false);
    });
});

/** ストアの元に戻す・やり直すを、外から呼べるようにする部品。 */
const probe: { current: ReturnType<typeof useDaw> | null } = { current: null };
function Probe() {
    const value = useDaw();
    useEffect(() => { probe.current = value; });
    const daw = value;
    return (
        <div>
            <span data-testid="undo">{daw.canUndo ? daw.undoLabel : '-'}</span>
            <span data-testid="redo">{daw.canRedo ? daw.redoLabel : '-'}</span>
            <span data-testid="toast">{daw.undoToast?.message ?? '-'}</span>
            <span data-testid="status">{daw.status}</span>
        </div>
    );
}

describe('ストアの record / undo / redo', () => {
    it('record で記録した操作を元に戻し、やり直せる。ボタンの名前に何を戻すかが出る', () => {
        render(<DawProvider><Probe /></DawProvider>);
        const t = engine.addTrack('A');
        act(() => { probe.current!.record('ノートを追加', () => { t.pianoNotes = [note('C', 4, 0)]; }); });
        expect(screen.getByTestId('undo').textContent).toBe('ノートを追加');
        act(() => probe.current!.undo());
        expect(t.pianoNotes).toEqual([]);
        expect(screen.getByTestId('undo').textContent).toBe('-');
        expect(screen.getByTestId('redo').textContent).toBe('ノートを追加');
        expect(screen.getByTestId('status').textContent).toBe('元に戻しました（ノートを追加）');
        act(() => probe.current!.redo());
        expect(t.pianoNotes).toEqual([note('C', 4, 0)]);
        expect(screen.getByTestId('status').textContent).toBe('やり直しました（ノートを追加）');
    });

    it('何も変えなかった操作は記録しない。記録の中の記録は外側にまとまる', () => {
        render(<DawProvider><Probe /></DawProvider>);
        const t = engine.addTrack('A');
        act(() => { probe.current!.record('何もしない', () => {}); });
        expect(probe.current!.canUndo).toBe(false);
        act(() => {
            probe.current!.record('外側', () => {
                t.name = 'B';
                probe.current!.record('内側', () => { t.pianoNotes = [note('C', 4, 0)]; });
            });
        });
        expect(probe.current!.undoLabel).toBe('外側');
        act(() => probe.current!.undo());
        expect([t.name, t.pianoNotes.length]).toEqual(['A', 0]);
        expect(probe.current!.canUndo).toBe(false);
    });

    it('処理が途中で失敗しても、記録は閉じる (その後の操作も記録される)', () => {
        render(<DawProvider><Probe /></DawProvider>);
        const t = engine.addTrack('A');
        expect(() => act(() => { probe.current!.record('失敗', () => { t.name = 'X'; throw new Error('boom'); }); })).toThrow('boom');
        act(() => { probe.current!.record('名前', () => { t.name = 'Y'; }); });
        expect(probe.current!.undoLabel).toBe('名前');
    });

    it('音量のつまみを続けて動かすと、1 つの記録にまとまる', () => {
        render(<DawProvider><Probe /></DawProvider>);
        const t = engine.addTrack('A');
        for (const db of [-1, -2, -3, -6]) {
            act(() => { probe.current!.record('「A」の音量を変更', () => engine.updateTrackGain(t.id, db), { coalesceKey: `gain:${t.id}` }); });
        }
        act(() => probe.current!.undo());
        expect(t.gain).toBe(0);
        expect(probe.current!.canUndo).toBe(false);
    });

    it('元に戻すの知らせ: 押すとその操作を戻す。別の操作をしたら閉じる', () => {
        render(<DawProvider><Probe /></DawProvider>);
        const a = engine.addTrack('A');
        act(() => { probe.current!.record('「A」を削除', () => engine.removeTrack(a.id)); probe.current!.showUndoToast('「A」を削除しました'); });
        expect(screen.getByTestId('toast').textContent).toBe('「A」を削除しました');
        act(() => probe.current!.undoFromToast());
        expect(engine.tracks).toEqual([a]);
        expect(screen.getByTestId('toast').textContent).toBe('-');

        act(() => { probe.current!.record('「A」を削除', () => engine.removeTrack(a.id)); probe.current!.showUndoToast('「A」を削除しました'); });
        act(() => { probe.current!.record('トラックを追加', () => engine.addTrack('B')); });
        expect(screen.getByTestId('toast').textContent).toBe('-');
    });
});
