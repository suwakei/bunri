/**
 * bunri DAW — 選んだノートの強さ (ベロシティ) の欄（ピアノロールの見出し行に出す）。
 *
 * ピアノロールでトラックを開いているあいだ、いつも出す (何も選んでいなければ押せない)。
 * 選んだときだけ出すと、見出しの行が折り返したり戻ったりして、グリッドが上下にずれる。
 * - 数値を入れて Enter (か、欄の外へ移る) と、選んだノートが全部その強さになる
 * - −/＋ (と、ピアノロールでの Option + ↑↓) は、差を保ったまま全部を上下させる
 * - 強さがばらばらなら、欄は空にして「混在」と出す
 * - 強さを持たないノート (マウスで置いたもの) は 96 として鳴るので、96 と出す。
 *   変えたときに初めて値を持たせる (触っていないノートは持たないまま)
 *
 * 変える処理と元に戻すための記録は、ピアノロールのエンジン (`setSelectionVelocity` /
 * `nudgeSelectionVelocity`) が持つ。この部品は値を見せて、押された・入れられたを伝えるだけ。
 */
import { useState } from 'react';
import { VELOCITY_MAX, VELOCITY_MIN, VELOCITY_STEP } from '../lib/velocity';
import type { VelocitySummary } from '../lib/velocity';
import { tip } from '../lib/tooltip';

interface Props {
    /** 選んでいるノートの強さのまとめ */
    summary: VelocitySummary;
    /** ピアノロールでトラックを開いているか (開いていなければ出さない) */
    open: boolean;
    /** 全部を同じ強さにする */
    onSet: (value: number) => void;
    /** 差を保ったまま上下させる */
    onNudge: (delta: number) => void;
}

/** 入れた文字を強さにする。範囲の外や数でないものは null。 */
function parseVelocity(text: string): number | null {
    const t = text.trim();
    if (!/^\d+$/.test(t)) return null;
    const v = Number(t);
    return v >= VELOCITY_MIN && v <= VELOCITY_MAX ? v : null;
}

/**
 * 選んだノートの強さの欄。
 */
export default function VelocityBar({ summary, open, onSet, onNudge }: Props) {
    const shown = summary.value === null ? '' : String(summary.value);
    // 入れかけの値 (null なら、今の値を出す)
    const [draft, setDraft] = useState<string | null>(null);
    // 選択や強さが変わったら、入れかけの値を捨てて今の値を出す (描く途中で合わせる。effect にすると 1 回余計に描く)
    const key = `${shown}/${summary.count}`;
    const [draftKey, setDraftKey] = useState(key);
    if (draftKey !== key) { setDraftKey(key); setDraft(null); }

    if (!open) return null;
    const none = summary.count === 0;

    const commit = () => {
        if (draft === null) return;
        const v = parseVelocity(draft);
        setDraft(null);
        if (v !== null && draft.trim() !== shown) onSet(v);
    };
    const allUnset = summary.unset === summary.count;
    // 押せないあいだは、どうすれば押せるようになるかを書く
    const inputTip = none
        ? 'ピアノロールでノートを選ぶと、そのノートを弾く強さをここで変えられます'
        : `選んだノートを弾く強さ（${VELOCITY_MIN}〜${VELOCITY_MAX}）。大きいほど強く鳴ります。数字を入れて Enter を押すと、選んだノートが全部その強さになります`;
    const nudgeTip = (dir: '上げ' | '下げ') => none
        ? 'ピアノロールでノートを選ぶと押せます'
        : `選んだノートの強さを ${VELOCITY_STEP} ずつ${dir}ます。ノートどうしの強さの差は変わりません`;

    return (
        <span className="piano-velocity" role="group" aria-label="選んだノートの強さ">
            <label htmlFor="velocity-input" className="area-hint">強さ</label>
            <input id="velocity-input" type="text" inputMode="numeric" value={draft ?? shown} size={3} maxLength={3}
                disabled={none}
                aria-describedby="velocity-note" {...tip(inputTip)}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commit(); }
                    else if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
                }} />
            <button type="button" aria-label={`強さを ${VELOCITY_STEP} 下げる`} disabled={none}
                {...tip(nudgeTip('下げ'), { key: 'Option + ↓' })} onClick={() => onNudge(-VELOCITY_STEP)}>−</button>
            <button type="button" aria-label={`強さを ${VELOCITY_STEP} 上げる`} disabled={none}
                {...tip(nudgeTip('上げ'), { key: 'Option + ↑' })} onClick={() => onNudge(VELOCITY_STEP)}>＋</button>
            <span id="velocity-note" className="area-hint">
                {none ? '' : summary.value === null ? '混在' : allUnset ? '既定' : ''}
                {summary.count > 1 ? `（${summary.count} ノート）` : ''}
            </span>
        </span>
    );
}
