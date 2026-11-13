import { describe, expect, it } from 'vitest';
import { placeTip, tip, TIP_GAP, TIP_MARGIN } from '../lib/tooltip';

const view = { width: 1000, height: 700 };
const size = { width: 200, height: 40 };

describe('placeTip', () => {
    it('入るなら、出したい向きに置き、要素の真ん中にそろえる', () => {
        const anchor = { left: 400, top: 300, width: 100, height: 30 };
        const p = placeTip(anchor, size, view, 'bottom');
        expect(p.side).toBe('bottom');
        expect(p.y).toBe(300 + 30 + TIP_GAP);
        expect(p.x).toBe(450 - 100);
        expect(p.arrow).toBe(100);
    });

    it('上に入らなければ下に置く (画面の上端のボタン)', () => {
        const anchor = { left: 400, top: 5, width: 60, height: 24 };
        expect(placeTip(anchor, size, view, 'top').side).toBe('bottom');
    });

    it('右に入らなければ左に置く', () => {
        const anchor = { left: 900, top: 300, width: 60, height: 24 };
        const p = placeTip(anchor, size, view, 'right');
        expect(p.side).toBe('left');
        expect(p.x + size.width).toBe(900 - TIP_GAP);
    });

    it('右端の要素でも、左右は画面の内側に押し込み、矢印は要素を指したまま', () => {
        const anchor = { left: 970, top: 300, width: 24, height: 24 };
        const p = placeTip(anchor, size, view, 'bottom');
        expect(p.x + size.width).toBe(view.width - TIP_MARGIN);
        // 矢印は要素の真ん中 (982) を指す。角の丸みに掛からないよう端から離す
        expect(p.x + p.arrow).toBeCloseTo(Math.min(982, p.x + size.width - 10));
    });

    it('どの向きにも入らないときも、画面の外には出さない', () => {
        const small = { width: 300, height: 120 };
        const anchor = { left: 0, top: 0, width: 300, height: 120 };
        const p = placeTip(anchor, { width: 280, height: 100 }, small, 'top');
        expect(p.x).toBeGreaterThanOrEqual(TIP_MARGIN);
        expect(p.y).toBeGreaterThanOrEqual(TIP_MARGIN);
    });

    it('枠があれば、出したい向きの端を枠の外側にそろえる (直交する向きは要素に合わせる)', () => {
        const box = { left: 0, top: 100, width: 180, height: 80 };
        const anchor = { left: 40, top: 130, width: 20, height: 20 };
        const p = placeTip(anchor, size, view, 'right', box);
        expect(p.side).toBe('right');
        expect(p.x).toBe(180 + TIP_GAP);
        expect(p.y + p.arrow).toBe(140);
    });

    it('枠の外に入らないときは、枠を使わない', () => {
        const box = { left: 0, top: 100, width: 990, height: 80 };
        const anchor = { left: 40, top: 130, width: 20, height: 20 };
        const p = placeTip(anchor, size, view, 'right', box);
        expect(p.x).toBe(60 + TIP_GAP);
    });
});

describe('tip', () => {
    it('説明と、キー・向き・切れたときだけの指定を属性にする', () => {
        expect(tip('止めます')).toEqual({ 'data-tip': '止めます' });
        expect(tip('鳴らします', { key: 'Space', side: 'bottom', overflow: true })).toEqual({
            'data-tip': '鳴らします', 'data-tip-key': 'Space', 'data-tip-side': 'bottom', 'data-tip-overflow': '',
        });
    });
});
