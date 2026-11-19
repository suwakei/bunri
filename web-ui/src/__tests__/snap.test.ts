/**
 * 刻み（lib/snap.ts）と、ステップの値のそろえ方（lib/grid.ts の normStep ほか）のテスト。
 *
 * ピアノロールでノートを置く・動かす・伸ばす・貼る・複製する・矢印キーで動かす、の位置の計算は、ここの関数だけで
 * 決まる（components/CenterArea.tsx の PianoRollEngine は、選んだ刻みを渡して結果を使うだけ）。
 * 画面での動きは e2e/snap.spec.ts。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    MIN_LENGTH, STEP_UNITS, SWING_NONE, fromTicks, inStepRange, normLength, normNote, normStep, normSwing, sameStep, stepToBar, stepToBeat,
    stepUnits, toTicks,
} from '../lib/grid';
import {
    DEFAULT_SNAP, MIN_LINE_PX, SNAPS, SNAP_STORAGE, SWING_OPTIONS, cellLength, gridFeelOf, gridLines, isSnapId, isSwung, nearestSwingOption,
    nudgeSteps, quantize, readSnapPrefs, realtimeQuantum, snapCeil, snapDef, snapEnd, snapFloor, snapGrid, snapIndexFloor, snapLength,
    snapLengthCeil, snapPos, snapRound, snapSteps, spanLabel, stepCell, stepText, swingApplies, swingLabel, writeSnapPref,
} from '../lib/snap';

describe('ステップの値をそろえる（lib/grid.ts）', () => {
    it('1/60 ステップの倍数にそろえる。整数は整数のまま', () => {
        expect(normStep(4)).toBe(4);
        expect(normStep(4.0000001)).toBe(4);
        expect(Number.isInteger(normStep(3.9999999))).toBe(true);
        expect(normStep(0.5)).toBe(0.5);
        // 三連は、4 桁の小数で書かれても、ちょうど 4/3・2/3 になる
        expect(normStep(1.3333)).toBe(4 / 3);
        expect(normStep(0.6667)).toBe(2 / 3);
        expect(normStep(2.6667)).toBe(8 / 3);
        expect(normStep(NaN)).toBe(0);
        expect(normStep(Infinity)).toBe(0);
    });

    it('処理を担当する部分（Python の round(x * 60) / 60）と同じ値になる', () => {
        // 同じ有理数 k/60 を、同じ倍精度の割り算で作る。足し算を重ねた値も、そろえれば同じになる
        let step = 0;
        for (let i = 0; i < 300; i++) step += 4 / 3;
        expect(step).not.toBe(400);          // そのままだと、端数がたまっている
        expect(normStep(step)).toBe(400);
        expect(normStep(1 / 3 + 1 / 3 + 1 / 3 + 1 / 3)).toBe(80 / 60);
        expect(stepUnits(4 / 3)).toBe(80);
        expect(STEP_UNITS).toBe(60);
    });

    it('同じ位置かどうかは、そろえてから比べる', () => {
        expect(sameStep(4 / 3, 1.3333)).toBe(true);
        expect(sameStep(0.1 + 0.2, 0.3)).toBe(true);
        expect(sameStep(1, 1.02)).toBe(false);
    });

    it('差・範囲は、刻みの数（1/60 ステップの整数）で比べる（小数のまま比べると、境目で外れる）', () => {
        expect(toTicks(4 / 3)).toBe(80);
        expect(toTicks(1.3333)).toBe(80);
        expect(fromTicks(80)).toBe(4 / 3);
        expect(fromTicks(240)).toBe(4);
        expect(stepUnits).toBe(toTicks);
        // 処理を担当する部分の例と同じ: 小数のまま引くと、許容 2 を超える・下限 0.5 に届かない
        expect(25 / 6 - 13 / 6).not.toBe(2);
        expect(fromTicks(toTicks(25 / 6) - toTicks(13 / 6))).toBe(2);
        expect(0.7 - 0.2).toBeLessThan(0.5);
        expect(fromTicks(toTicks(0.7) - toTicks(0.2))).toBe(0.5);
        // 範囲 [start, end) に入るか。終わりちょうどは、範囲の外
        expect(inStepRange(4 / 3, 1.3333, 2.6667)).toBe(true);
        expect(inStepRange(8 / 3, 1.3333, 2.6667)).toBe(false);
        expect(inStepRange(0.1 + 0.2, 0.3, 1)).toBe(true);
        expect(inStepRange(15.9999999, 16, 32)).toBe(true);
        expect(inStepRange(100, 16, Infinity)).toBe(true);
        expect(inStepRange(15, 16, Infinity)).toBe(false);
    });

    it('小節と拍は、小数の位置でも整数（三連の 3 つ目は、その拍に数える）', () => {
        const grid = { beatsPerBar: 4 };
        expect([0, 4 / 3, 8 / 3, 4, 44 / 3, 16, 16 + 8 / 3].map((s) => [stepToBar(s, grid), stepToBeat(s, grid)]))
            .toEqual([[1, 1], [1, 1], [1, 1], [1, 2], [1, 4], [2, 1], [2, 1]]);
        // 小節の頭ちょうどに在る値が、誤差で前の小節に落ちない
        expect(stepToBar(15.9999999999, grid)).toBe(2);
        expect(stepToBar(12 * (4 / 3), grid)).toBe(2);
        expect(stepToBeat(11.9999999999, { beatsPerBar: 3 })).toBe(1);
    });

    it('長さは、そろえても 0 にしない（下限は 1/60 ステップ）', () => {
        expect(MIN_LENGTH).toBe(1 / 60);
        expect(normLength(0.001)).toBe(1 / 60);
        expect(normLength(1 / 200)).toBe(1 / 60);
        expect(normLength(0.5)).toBe(0.5);
        expect(normLength(4)).toBe(4);
        expect(normNote({ note: 'C', octave: 4, step: 0, length: 0.004 }).length).toBe(1 / 60);
    });

    it('normNote: 位置と長さだけをそろえた写しを返す（強さなどは、そのまま）', () => {
        const source = { note: 'C', octave: 4, step: 1.3333, length: 0.6667, velocity: 90 };
        const copy = normNote(source);
        expect(copy).toEqual({ note: 'C', octave: 4, step: 4 / 3, length: 2 / 3, velocity: 90 });
        expect(copy).not.toBe(source);
        expect(source.step).toBe(1.3333);
        // 強さを持たないノートに、項目を足さない
        expect(Object.keys(normNote({ note: 'C', octave: 4, step: 0, length: 4 }))).toEqual(['note', 'octave', 'step', 'length']);
    });

    it('normSwing: 0.5〜0.75 に収める。67% は、ちょうど 2/3', () => {
        expect(normSwing(undefined)).toBe(SWING_NONE);
        expect(normSwing('0.6')).toBe(0.5);
        expect(normSwing(0.4)).toBe(0.5);
        expect(normSwing(0.9)).toBe(0.75);
        expect(normSwing(0.67)).toBe(2 / 3);
        expect(normSwing(0.6667)).toBe(2 / 3);
        expect(normSwing(0.58)).toBe(0.58);
        expect(normSwing(0.583)).toBe(0.58);
    });
});

describe('刻み', () => {
    it('選べる刻みは 6 つ。どれも、1/60 ステップの整数倍', () => {
        expect(SNAPS.map((s) => [s.id, s.label, s.units / STEP_UNITS])).toEqual([
            ['1/4', '4 分', 4], ['1/8', '8 分', 2], ['1/16', '16 分', 1], ['1/32', '32 分', 0.5],
            ['1/8T', '8 分の三連', 4 / 3], ['1/16T', '16 分の三連', 2 / 3],
        ]);
        for (const s of SNAPS) expect(Number.isInteger(s.units), s.id).toBe(true);
        // 1 拍（240）を、割り切る
        for (const s of SNAPS) expect(240 % s.units, s.id).toBe(0);
        expect(snapSteps(snapGrid('1/8T'))).toBe(4 / 3);
        expect(isSnapId('1/8T')).toBe(true);
        expect(isSnapId('1/3')).toBe(false);
        expect(snapDef('1/16T').triplet).toBe(true);
    });

    it('既定は、これまでの動きと同じ（ふつうは 4 分、ドラムは 16 分）', () => {
        expect(DEFAULT_SNAP).toEqual({ normal: '1/4', drums: '1/16' });
        expect(snapSteps(snapGrid(DEFAULT_SNAP.normal))).toBe(4);
        expect(snapSteps(snapGrid(DEFAULT_SNAP.drums))).toBe(1);
    });

    it('4 分（既定）: これまでの計算と同じ位置になる', () => {
        const g = snapGrid('1/4');
        for (let x = 0; x <= 40; x += 0.25) {
            // 置く: Math.floor(Math.floor(x) / 4) * 4、動かす: Math.round(x / 4) * 4
            expect(snapFloor(g, x), `floor ${x}`).toBe(Math.floor(Math.floor(x) / 4) * 4);
            expect(snapRound(g, x), `round ${x}`).toBe(Math.round(x / 4) * 4);
        }
        // 伸ばす: Math.max(4, Math.round(len / 4) * 4)、複製: Math.max(4, Math.ceil(span / 4) * 4)
        for (let len = -3; len <= 20; len++) {
            expect(snapLength(g, len), `length ${len}`).toBe(Math.max(4, Math.round(len / 4) * 4));
            expect(snapLengthCeil(g, len), `ceil ${len}`).toBe(Math.max(4, Math.ceil(len / 4) * 4));
        }
        expect(nudgeSteps(g, 8, 1)).toBe(4);
        expect(nudgeSteps(g, 8, -1)).toBe(-4);
        expect(cellLength(g, 3)).toBe(4);
    });

    it('16 分（ドラムの既定）: 1 ステップごと', () => {
        const g = snapGrid('1/16');
        expect([0, 0.4, 0.99, 1, 7.5].map((x) => snapFloor(g, x))).toEqual([0, 0, 0, 1, 7]);
        expect(snapLength(g, 0.2)).toBe(1);
        expect(cellLength(g, 5)).toBe(1);
    });

    it('8 分の三連: 1 拍を 3 つに分けた位置に吸い付く', () => {
        const g = snapGrid('1/8T');
        expect([0, 1, 2, 3, 4, 5, 6].map((k) => snapPos(g, k))).toEqual([0, 4 / 3, 8 / 3, 4, 16 / 3, 20 / 3, 8]);
        // 置く: 押した位置の手前の三連
        expect(snapFloor(g, 1.2)).toBe(0);
        expect(snapFloor(g, 1.4)).toBe(4 / 3);
        expect(snapFloor(g, 3.99)).toBe(8 / 3);
        expect(snapFloor(g, 4)).toBe(4);
        // 動かす: いちばん近い三連
        expect(snapRound(g, 0.6)).toBe(0);
        expect(snapRound(g, 0.7)).toBe(4 / 3);
        expect(snapRound(g, 3.5)).toBe(4);
        expect(snapCeil(g, 1.4)).toBe(8 / 3);
        expect(snapCeil(g, 4 / 3)).toBe(4 / 3);
        // 置くノートの長さは、刻み 1 つぶん
        expect(cellLength(g, 0)).toBe(4 / 3);
        expect(cellLength(g, 2)).toBe(4 / 3);
        // 伸ばす: 三連の倍数。1 つぶんより短くはしない
        expect(snapLength(g, 0.1)).toBe(4 / 3);
        expect(snapLength(g, 2.5)).toBe(8 / 3);
        expect(snapLength(g, 4.1)).toBe(4);
        // 複製: 選んだ長さを、三連の倍数に切り上げた先へ
        expect(snapLengthCeil(g, 4 / 3)).toBe(4 / 3);
        expect(snapLengthCeil(g, 4)).toBe(4);
        expect(snapLengthCeil(g, 4.1)).toBe(16 / 3);
        // 負の位置は、曲の頭に止める
        expect(snapRound(g, -3)).toBe(0);
        expect(snapFloor(g, -0.1)).toBe(0);
    });

    it('そろえた位置を、もう一度そろえても動かない（浮動小数の誤差で、隣へ落ちない）', () => {
        for (const def of SNAPS) {
            const g = snapGrid(def.id);
            for (let k = 0; k < 400; k++) {
                const pos = snapPos(g, k);
                expect(snapFloor(g, pos), `${def.id} floor ${k}`).toBe(pos);
                expect(snapRound(g, pos), `${def.id} round ${k}`).toBe(pos);
                expect(snapCeil(g, pos), `${def.id} ceil ${k}`).toBe(pos);
                expect(snapIndexFloor(g, pos)).toBe(k);
                expect(normStep(pos)).toBe(pos);
            }
        }
    });

    it('矢印キーで 300 回動かしても、端数がたまらない（三連 3 つで、ちょうど 1 拍）', () => {
        const g = snapGrid('1/8T');
        let step = 0;
        for (let i = 0; i < 300; i++) step = normStep(step + nudgeSteps(g, step, 1));
        expect(step).toBe(400);
        for (let i = 0; i < 300; i++) step = normStep(step + nudgeSteps(g, step, -1));
        expect(step).toBe(0);
        // 16 分の三連も同じ（6 つで 1 拍）
        const fine = snapGrid('1/16T');
        for (let i = 0; i < 6; i++) step = normStep(step + nudgeSteps(fine, step, 1));
        expect(step).toBe(4);
    });

    it('32 分: 0.5 ステップごと', () => {
        const g = snapGrid('1/32');
        expect([0, 0.49, 0.5, 0.74, 0.75, 7.3].map((x) => snapRound(g, x))).toEqual([0, 0.5, 0.5, 0.5, 1, 7.5]);
        expect(snapFloor(g, 7.9)).toBe(7.5);
        expect(cellLength(g, 1)).toBe(0.5);
        expect(nudgeSteps(g, 3, 1)).toBe(0.5);
    });
});

describe('スウィング', () => {
    it('選べる値は 50%（なし）〜 75%。効くのは、8 分と 16 分だけ', () => {
        expect(SWING_OPTIONS.map((o) => o.label)).toEqual(['50%（なし）', '54%', '58%', '62%', '67%（三連）', '71%', '75%']);
        expect(SWING_OPTIONS[0].value).toBe(SWING_NONE);
        expect(SWING_OPTIONS[4].value).toBe(2 / 3);
        expect(SNAPS.filter((s) => swingApplies(s.id)).map((s) => s.id)).toEqual(['1/8', '1/16']);
        expect(swingLabel(2 / 3)).toBe('67%');
        expect(swingLabel(0.5)).toBe('50%');
        // プロジェクトの値が選択肢に無いときは、いちばん近い選択肢を出す
        expect(nearestSwingOption(0.6)).toBe(0.58);
        expect(nearestSwingOption(0.6667)).toBe(2 / 3);
        expect(nearestSwingOption(0.2)).toBe(0.5);
    });

    it('50% は、ずらさない。効かない刻みでは、値が在ってもずらさない', () => {
        expect(isSwung(snapGrid('1/8', 0.5))).toBe(false);
        expect(isSwung(snapGrid('1/8'))).toBe(false);
        expect(isSwung(snapGrid('1/4', 0.67))).toBe(false);
        expect(isSwung(snapGrid('1/8T', 0.67))).toBe(false);
        expect(isSwung(snapGrid('1/32', 0.75))).toBe(false);
        expect(isSwung(snapGrid('1/8', 0.67))).toBe(true);
    });

    it('8 分・67%: 裏の位置が、三連の 3 つ目と同じ位置になる', () => {
        const g = snapGrid('1/8', 2 / 3);
        // 表は 0・4・8、裏は 2.67・6.67（ずらさなければ 2・6）
        expect([0, 1, 2, 3, 4].map((k) => snapPos(g, k))).toEqual([0, 8 / 3, 4, 20 / 3, 8]);
        const triplet = snapGrid('1/8T');
        expect(snapPos(g, 1)).toBe(snapPos(triplet, 2));
        expect(snapPos(g, 3)).toBe(snapPos(triplet, 5));
        // 置く: 2.0〜2.66 を押すと、まだ表（0）。2.67 から裏
        expect(snapFloor(g, 2.5)).toBe(0);
        expect(snapFloor(g, 2.7)).toBe(8 / 3);
        // 置くノートの長さは、次の吸い付く位置まで（表は長く、裏は短い。重ならない）
        expect(cellLength(g, 0)).toBe(8 / 3);
        expect(cellLength(g, 1)).toBe(4 / 3);
        expect(cellLength(g, 0) + cellLength(g, 1)).toBe(4);
        // 動かす: いちばん近い位置（1.33 より手前は表、先は裏）
        expect(snapRound(g, 1.3)).toBe(0);
        expect(snapRound(g, 1.4)).toBe(8 / 3);
        expect(snapRound(g, 3.4)).toBe(4);
    });

    it('16 分・54%: 裏の位置が、少しだけ後ろへずれる', () => {
        const g = snapGrid('1/16', 0.54);
        // 刻み 2 つぶん（2 ステップ）の 54% = 1.08 → 1/60 ステップにそろえて 65/60
        expect([0, 1, 2, 3].map((k) => snapPos(g, k))).toEqual([0, 65 / 60, 2, 185 / 60]);
        expect(stepUnits(snapPos(g, 1))).toBe(65);
        expect(snapFloor(g, 1.05)).toBe(0);
        expect(snapFloor(g, 1.1)).toBe(65 / 60);
    });

    it('75%: 付点 8 分 + 16 分の位置', () => {
        expect(snapPos(snapGrid('1/8', 0.75), 1)).toBe(3);
        expect(snapPos(snapGrid('1/16', 0.75), 1)).toBe(1.5);
    });

    it('矢印キー: 表から裏へ、裏から表へ、隣の吸い付く位置まで動く', () => {
        const g = snapGrid('1/8', 2 / 3);
        expect(nudgeSteps(g, 0, 1)).toBe(8 / 3);
        expect(nudgeSteps(g, 8 / 3, 1)).toBe(4 / 3);
        expect(nudgeSteps(g, 4, -1)).toBe(-4 / 3);
        expect(nudgeSteps(g, 8 / 3, -1)).toBe(-8 / 3);
        // 往復すると、元の位置に戻る
        let step = 4;
        for (const dir of [1, 1, 1, -1, -1, -1] as const) step = normStep(step + nudgeSteps(g, step, dir));
        expect(step).toBe(4);
        // 曲の頭より前へは、負の幅が返る（呼ぶ側が止める）
        expect(nudgeSteps(g, 0, -1)).toBeLessThan(0);
    });

    it('伸ばす: 終わりを、吸い付く位置にそろえる。始まりの次の位置より手前には縮めない', () => {
        const g = snapGrid('1/8', 2 / 3);
        // 表（0）から始まるノートの終わりを、3.9 のあたりへ → 4
        expect(snapEnd(g, 0, 3.9)).toBe(4);
        expect(snapEnd(g, 0, 2.9)).toBe(8 / 3);
        expect(snapEnd(g, 0, -5)).toBe(8 / 3);
        // 裏（2.67）から始まるノートは、次の表（4）まで
        expect(snapEnd(g, 8 / 3, 2)).toBe(4 / 3);
        expect(snapEnd(g, 8 / 3, 6.5)).toBe(4);
    });
});

describe('MIDI 鍵盤の入力の刻み', () => {
    it('ステップ入力の 1 歩: カーソルの位置に、刻み 1 つぶんを置いて、隣へ進む', () => {
        const g = snapGrid('1/8T');
        expect(stepCell(g, 0)).toEqual({ step: 0, length: 4 / 3, next: 4 / 3 });
        expect(stepCell(g, 4 / 3)).toEqual({ step: 4 / 3, length: 4 / 3, next: 8 / 3 });
        // カーソルが刻みの上に無ければ、次の刻みから
        expect(stepCell(g, 1)).toEqual({ step: 4 / 3, length: 4 / 3, next: 8 / 3 });
        // スウィングでは、表と裏で長さが違う
        const swung = snapGrid('1/8', 2 / 3);
        expect(stepCell(swung, 0)).toEqual({ step: 0, length: 8 / 3, next: 8 / 3 });
        expect(stepCell(swung, 8 / 3)).toEqual({ step: 8 / 3, length: 4 / 3, next: 4 });
    });

    it('リアルタイム録音の丸め: 細かい刻みと三連はその刻み、ほかは 16 分音符', () => {
        expect(SNAPS.map((s) => [s.id, realtimeQuantum(s.id)])).toEqual([
            ['1/4', 1], ['1/8', 1], ['1/16', 1], ['1/32', 0.5], ['1/8T', 4 / 3], ['1/16T', 2 / 3],
        ]);
        expect(quantize(2.4, 1)).toBe(2);
        expect(quantize(2.5, 1)).toBe(3);
        expect(quantize(2.4, 0.5)).toBe(2.5);
        expect(quantize(2.4, 4 / 3)).toBe(8 / 3);
        expect(quantize(1.9, 4 / 3)).toBe(4 / 3);
        expect(quantize(0.3, 2 / 3)).toBe(0);
        expect(quantize(0.4, 2 / 3)).toBe(2 / 3);
    });
});

describe('グリッドの線', () => {
    const cellPx = (g: { cell: number } | null, stepWidth: number) => (g ? g.cell / STEP_UNITS * stepWidth : null);

    it('4 分・8 分・16 分は、これまでと同じ 16 分音符の線（詰まるときは省く）', () => {
        for (const id of ['1/4', '1/8', '1/16'] as const) {
            expect(gridLines(snapGrid(id), 20)?.id, id).toBe('1/16');
            expect(gridLines(snapGrid(id), MIN_LINE_PX)?.id, id).toBe('1/16');
            expect(gridLines(snapGrid(id), MIN_LINE_PX - 1), id).toBeNull();
        }
    });

    it('三連は三連の位置。16 分の三連が詰まるときは、8 分の三連に間引く', () => {
        expect(gridLines(snapGrid('1/8T'), 20)?.id).toBe('1/8T');
        expect(gridLines(snapGrid('1/8T'), 5)).toBeNull();
        expect(gridLines(snapGrid('1/16T'), 20)?.id).toBe('1/16T');
        expect(gridLines(snapGrid('1/16T'), 10)?.id).toBe('1/8T');
        expect(gridLines(snapGrid('1/16T'), 5)).toBeNull();
    });

    it('32 分は、横の拡大が足りるときだけ。足りなければ 16 分音符の線', () => {
        expect(gridLines(snapGrid('1/32'), 20)?.id).toBe('1/32');
        expect(cellPx(gridLines(snapGrid('1/32'), 20), 20)).toBe(10);
        expect(gridLines(snapGrid('1/32'), 12)?.id).toBe('1/16');
        expect(gridLines(snapGrid('1/32'), 6)).toBeNull();
    });

    it('スウィングは、ずらした位置の線。16 分で詰まるときは、表の位置（8 分）だけ', () => {
        const swung8 = gridLines(snapGrid('1/8', 2 / 3), 20);
        expect(swung8 && isSwung(swung8)).toBe(true);
        expect(swung8 && snapPos(swung8, 1)).toBe(8 / 3);
        const swung16 = snapGrid('1/16', 0.75);   // 裏から次の表まで 0.5 ステップ
        expect(isSwung(gridLines(swung16, 20)!)).toBe(true);
        expect(gridLines(swung16, 10)).toEqual(snapGrid('1/8'));
        expect(gridLines(swung16, 3)).toBeNull();
    });
});

describe('お手本のグリッドの見分け', () => {
    const at = (...steps: number[]) => steps.map((step) => ({ step }));

    it('三連の位置に載ったお手本は triplet、ストレートは straight', () => {
        // シャッフルのベース: 拍の頭と、三連の 3 つ目
        expect(gridFeelOf(at(0, 8 / 3, 4, 20 / 3, 8, 32 / 3, 12, 44 / 3))).toBe('triplet');
        // 8 分・16 分
        expect(gridFeelOf(at(0, 2, 4, 6, 8, 9, 10, 11))).toBe('straight');
        // 拍の頭だけ（どちらとも言えない）は、ストレート
        expect(gridFeelOf(at(0, 4, 8, 12))).toBe('straight');
        expect(gridFeelOf([])).toBe('straight');
        expect(gridFeelOf(null)).toBe('straight');
    });

    it('三連が 1 つ混ざっただけ・ストレートの裏が多い・人が弾いた揺れが多いときは、straight', () => {
        expect(gridFeelOf(at(0, 4 / 3, 4, 8, 12))).toBe('straight');
        expect(gridFeelOf(at(0, 4 / 3, 8 / 3, 5, 7, 9, 11))).toBe('straight');
        // MIDI の読み込み（1/6 ステップ）の、ばらばらな位置
        expect(gridFeelOf(at(1 / 6, 5 / 6, 7 / 6, 4 / 3, 8 / 3, 11 / 6, 13 / 6, 17 / 6))).toBe('straight');
    });
});

describe('ステップの幅の言い方', () => {
    it('整数のステップは、これまでどおり（拍 / 16 分音符）', () => {
        expect(spanLabel(4)).toBe('1 拍');
        expect(spanLabel(-8)).toBe('2 拍');
        expect(spanLabel(1)).toBe('16 分音符 1 個');
        expect(spanLabel(-3)).toBe('16 分音符 3 個');
    });

    it('三連・32 分は、その音符の数で言う（「16 分音符 0.67 個」とは言わない）', () => {
        expect(spanLabel(4 / 3)).toBe('8 分の三連符 1 個');
        expect(spanLabel(-8 / 3)).toBe('8 分の三連符 2 個');
        expect(spanLabel(2 / 3)).toBe('16 分の三連符 1 個');
        expect(spanLabel(10 / 3)).toBe('16 分の三連符 5 個');
        expect(spanLabel(0.5)).toBe('32 分音符 1 個');
        expect(spanLabel(-1.5)).toBe('32 分音符 3 個');
        for (const steps of [4 / 3, 2 / 3, 8 / 3, 0.5, 1.5]) expect(spanLabel(steps)).not.toMatch(/\d\.\d/);
    });

    it('どの音符の倍数でもない幅（人が弾いた揺れ）は、およその数で言う', () => {
        expect(spanLabel(5 / 6)).toBe('16 分音符でおよそ 0.8 個');
        expect(spanLabel(7 / 6)).toBe('16 分音符でおよそ 1.2 個');
    });

    it('stepText: 整数はそのまま、小数は 2 桁まで', () => {
        expect(stepText(4)).toBe('4');
        expect(stepText(4 / 3)).toBe('1.33');
        expect(stepText(8 / 3)).toBe('2.67');
        expect(stepText(0.5)).toBe('0.5');
    });
});

describe('刻みを覚える', () => {
    beforeEach(() => { localStorage.clear(); });

    it('ふつうのトラックとドラムのトラックで、別々に覚える', () => {
        expect(readSnapPrefs()).toEqual(DEFAULT_SNAP);
        writeSnapPref('normal', '1/8T');
        expect(readSnapPrefs()).toEqual({ normal: '1/8T', drums: '1/16' });
        writeSnapPref('drums', '1/32');
        expect(readSnapPrefs()).toEqual({ normal: '1/8T', drums: '1/32' });
        expect(localStorage.getItem(SNAP_STORAGE.normal)).toBe('1/8T');
        expect(localStorage.getItem(SNAP_STORAGE.drums)).toBe('1/32');
    });

    it('知らない値が入っていたら、既定に戻す', () => {
        localStorage.setItem(SNAP_STORAGE.normal, '1/3');
        localStorage.setItem(SNAP_STORAGE.drums, '');
        expect(readSnapPrefs()).toEqual(DEFAULT_SNAP);
    });
});
