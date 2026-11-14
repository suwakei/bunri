/**
 * 元に戻す / やり直すの履歴 (lib/history.ts)。
 */
import { describe, it, expect } from 'vitest';
import { UndoHistory } from '../lib/history';

/** 時刻を手で進められる履歴。状態は数で表す。 */
function makeHistory(options: { limit?: number; budget?: number; coalesceMs?: number } = {}) {
    let now = 0;
    const history = new UndoHistory<number>({ ...options, cost: (a, b) => Math.abs(b - a), now: () => now });
    return { history, advance: (ms: number) => { now += ms; } };
}

describe('UndoHistory', () => {
    it('記録した順に元に戻し、元に戻した順にやり直す', () => {
        const { history } = makeHistory();
        history.push('a', 0, 1);
        history.push('b', 1, 2);
        expect(history.peekUndo()?.label).toBe('b');
        expect(history.undo()?.before).toBe(1);
        expect(history.undo()?.before).toBe(0);
        expect(history.undo()).toBeNull();
        expect(history.redo()?.after).toBe(1);
        expect(history.peekRedo()?.label).toBe('b');
        expect(history.redo()?.after).toBe(2);
        expect(history.redo()).toBeNull();
    });

    it('前後が同じ操作 (何も変えなかった) は記録しない', () => {
        const { history } = makeHistory();
        expect(history.push('noop', 3, 3)).toBeNull();
        expect(history.undoCount).toBe(0);
    });

    it('元に戻した後に新しい操作をすると、やり直せる記録は消える', () => {
        const { history } = makeHistory();
        history.push('a', 0, 1);
        history.push('b', 1, 2);
        history.undo();
        expect(history.redoCount).toBe(1);
        history.push('c', 1, 5);
        expect(history.redoCount).toBe(0);
        expect(history.redo()).toBeNull();
        expect(history.peekUndo()?.label).toBe('c');
    });

    it('同じ鍵の操作が続いたら 1 つにまとめる (最初の「前」と最後の「後」)', () => {
        const { history, advance } = makeHistory({ coalesceMs: 1000 });
        history.push('音量', 0, 1, { coalesceKey: 'gain:1' });
        advance(300);
        history.push('音量', 1, 2, { coalesceKey: 'gain:1' });
        advance(300);
        const entry = history.push('音量', 2, 3, { coalesceKey: 'gain:1' });
        expect(history.undoCount).toBe(1);
        expect(entry).toMatchObject({ before: 0, after: 3 });
        expect(history.undo()?.before).toBe(0);
    });

    it('間が空いたら、鍵が違ったら、まとめない', () => {
        const { history, advance } = makeHistory({ coalesceMs: 1000 });
        history.push('音量', 0, 1, { coalesceKey: 'gain:1' });
        advance(1500);
        history.push('音量', 1, 2, { coalesceKey: 'gain:1' });
        history.push('パン', 2, 3, { coalesceKey: 'pan:1' });
        history.push('音量', 3, 4, { coalesceKey: 'gain:2' });
        expect(history.undoCount).toBe(4);
    });

    it('鍵ごとに、まとめる間隔を変えられる', () => {
        const { history, advance } = makeHistory({ coalesceMs: 1000 });
        history.push('録音', 0, 1, { coalesceKey: 'midi', coalesceMs: 4000 });
        advance(3000);
        history.push('録音', 1, 2, { coalesceKey: 'midi', coalesceMs: 4000 });
        expect(history.undoCount).toBe(1);
    });

    it('元に戻す・やり直すを挟んだら、まとめない', () => {
        const { history } = makeHistory();
        history.push('音量', 0, 1, { coalesceKey: 'gain:1' });
        history.push('ノート', 1, 2);
        history.undo();
        // いちばん上は「音量」だが、元に戻した後なので、まとめずに新しい記録にする
        history.push('音量', 1, 5, { coalesceKey: 'gain:1' });
        expect(history.undoCount).toBe(2);
        expect(history.peekUndo()).toMatchObject({ before: 1, after: 5 });
    });

    it('まとめた結果が元の値に戻ったら、記録ごと消す', () => {
        const { history } = makeHistory();
        history.push('音量', 0, 1, { coalesceKey: 'gain:1' });
        expect(history.push('音量', 1, 0, { coalesceKey: 'gain:1' })).toBeNull();
        expect(history.undoCount).toBe(0);
    });

    it('記録の数の上限を超えたら、古いものから捨てる', () => {
        const { history } = makeHistory({ limit: 3 });
        for (let i = 0; i < 5; i++) history.push(`op${i}`, i, i + 1);
        expect(history.undoCount).toBe(3);
        const labels: string[] = [];
        let entry;
        while ((entry = history.undo())) labels.push(entry.label);
        expect(labels).toEqual(['op4', 'op3', 'op2']);
    });

    it('抱える量の合計 (budget) を超えたら、古いものから捨てる。いちばん新しい記録は残す', () => {
        const { history } = makeHistory({ budget: 10 });
        history.push('small', 0, 4);
        history.push('small2', 4, 8);
        expect(history.size).toBe(8);
        history.push('big', 8, 15);
        // 4 + 4 + 7 = 15 > 10。古い 2 つを捨てて 7 にする
        expect(history.undoCount).toBe(1);
        expect(history.size).toBe(7);
        history.push('huge', 15, 100);
        expect(history.undoCount).toBe(1);
        expect(history.peekUndo()?.label).toBe('huge');
    });

    it('元に戻した記録は、抱える量に数えない。やり直すと数える', () => {
        const { history } = makeHistory();
        history.push('a', 0, 5);
        history.undo();
        expect(history.size).toBe(0);
        history.redo();
        expect(history.size).toBe(5);
    });

    it('clear で全部消える', () => {
        const { history } = makeHistory();
        history.push('a', 0, 1);
        history.push('b', 1, 2);
        history.undo();
        history.clear();
        expect([history.undoCount, history.redoCount, history.size]).toEqual([0, 0, 0]);
    });
});
