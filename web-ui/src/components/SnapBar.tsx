/**
 * bunri DAW — 刻みとスウィングの選択（ピアノロールの見出し行に出す。練習画面でも同じもの）。
 *
 * - 刻み: ノートを置く・動かす・伸ばす・貼る・複製する・矢印キーで動かすときに吸い付く間隔。
 *   4 分 / 8 分 / 16 分 / 32 分 / 8 分の三連 / 16 分の三連。置くノートの長さは、刻み 1 つぶん。
 *   選んだ刻みは、利用者ごとに覚える（localStorage。ふつうのトラックとドラムのトラックで別々。
 *   既定は、ふつうが 4 分、ドラムが 16 分）
 * - スウィング: 刻みが 8 分か 16 分のとき、裏の位置を後ろへずらす割合（50% = ずらさない 〜 75%。67% が三連と同じ位置）。
 *   曲の性質なので、プロジェクトに入る（ストアの `swing`。保存・元に戻す・保存していない変更の扱いは、テンポや拍子と同じ）
 *
 * 計算は `lib/snap.ts`、刻みを持って吸い付けるのは `CenterArea.tsx` の `PianoRollEngine`（`setSnapId` / `refreshSnap`）。
 * この部品は、選択欄を出して、選んだ値を渡すだけ。どちらもキーボードで選べる（`<select>`）。
 */
import { useEffect, useState } from 'react';
import { useDaw } from '../lib/store';
import { tip } from '../lib/tooltip';
import { blockedBy } from '../lib/notice';
import { DEFAULT_SNAP, SNAPS, SWING_OPTIONS, isSnapId, nearestSwingOption, snapDef, swingApplies, swingLabel, type SnapId } from '../lib/snap';

/** スウィングを選べないあいだの理由（どうすれば選べるか）。 */
const SWING_BLOCKED = 'スウィングは、刻みが 8 分か 16 分のときに使えます。先に、刻みを 8 分か 16 分にしてください';

/**
 * 刻みとスウィングの選択。
 *
 * @param activeTrackId - ピアノロールで開いているトラックの ID（開いていなければ null。そのあいだは出さない）
 */
export default function SnapBar({ activeTrackId }: { activeTrackId: number | null }) {
    // trackVersion が変わったとき（トラックの役割が変わる元に戻す・開き直す）にも、刻みを読み直す
    const { pianoRollRef, swing, setSwing, setStatus, trackVersion } = useDaw();
    // いまの刻みと、ドラムのトラックを開いているか。持っているのはピアノロールで、ここは写しを出すだけ
    const [snap, setSnap] = useState<{ id: SnapId; drums: boolean }>({ id: DEFAULT_SNAP.normal, drums: false });

    // ピアノロールの刻みを読む。ピアノロールの側で変わったとき（ドラムのトラックを開いた、練習を始めるときにアプリが
    // 三連に合わせた）にも読み直す。ピアノロールは、この部品より後に用意されるので、トラックを開いたときに結び直す
    useEffect(() => {
        const pr = pianoRollRef.current;
        if (!pr) return;
        const sync = () => {
            const current = pr.snapId?.();
            const next = { id: isSnapId(current) ? current : DEFAULT_SNAP.normal, drums: pr.drumMode === true };
            setSnap((prev) => (prev.id === next.id && prev.drums === next.drums ? prev : next));
        };
        pr.onSnap = sync;
        sync();
        return () => { if (pr.onSnap === sync) pr.onSnap = null; };
    }, [pianoRollRef, activeTrackId, trackVersion]);

    if (activeTrackId === null) return null;

    const { id, drums } = snap;
    const def = snapDef(id);
    const canSwing = swingApplies(id);
    const swingValue = nearestSwingOption(swing);

    const chooseSnap = (value: string) => {
        if (!isSnapId(value)) return;
        // 選んだ刻みを渡す。ピアノロールが、変わったことを知らせ返して、選択欄が変わる
        pianoRollRef.current?.setSnapId?.(value);
        const next = snapDef(value);
        const swung = swingApplies(value) && swingValue !== SWING_OPTIONS[0].value ? `（スウィング ${swingLabel(swingValue)}）` : '';
        setStatus(`刻みを「${next.label}」にしました${swung}。ノートを置く・動かす位置が、この刻みに合います`);
    };

    const chooseSwing = (value: string) => {
        const option = SWING_OPTIONS[Number(value)];
        if (!option) return;
        setSwing(option.value);
        setStatus(option.value === SWING_OPTIONS[0].value
            ? 'スウィングをなしにしました（裏の位置は、ずらしません）'
            : `スウィングを ${swingLabel(option.value)} にしました。${def.label}の裏の位置が、後ろへずれます（すでに置いたノートは動きません）`);
    };

    const snapTip = `${def.tip}\n刻みは、ノートを置く・動かす・伸ばすときに吸い付く間隔です。${drums ? 'ドラムのトラックの刻みとして' : 'ふつうのトラックの刻みとして'}覚えます`;
    const swingTip = canSwing
        ? '裏の位置（刻みの 2 つ目・4 つ目…）を、後ろへずらす割合です。50% はずらさず、67% は三連と同じ位置になります。曲ごとに、プロジェクトに保存されます'
        : SWING_BLOCKED;

    return (
        <span className="snap-bar" role="group" aria-label="ノートを置く刻みとスウィング">
            <label>
                <span className="area-hint" aria-hidden="true">刻み</span>
                <select id="snap-select" aria-label="刻み" value={id} {...tip(snapTip)} onChange={(e) => chooseSnap(e.target.value)}>
                    {SNAPS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
            </label>
            <label>
                <span className="area-hint" aria-hidden="true">スウィング</span>
                <select id="swing-select" aria-label="スウィング" value={String(SWING_OPTIONS.findIndex((o) => o.value === swingValue))}
                    disabled={!canSwing} {...blockedBy(!canSwing && SWING_BLOCKED)} {...tip(swingTip)}
                    onChange={(e) => chooseSwing(e.target.value)}>
                    {SWING_OPTIONS.map((o, i) => <option key={o.label} value={String(i)}>{o.label}</option>)}
                </select>
            </label>
        </span>
    );
}
