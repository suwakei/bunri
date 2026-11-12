/**
 * bunri DAW — お手本の重ね表示の切り替え（ピアノロールの見出し行に出す）。
 *
 * お手本（原曲を採譜した時点のノート）を、ピアノロールに薄く重ねて見せる。
 * お手本を見ながら自分で打ち込み、「差分チェック」で比べる、という流れのためのもの。
 *
 * - 既定では、いま開いているトラックがお手本を持っていれば、それを重ねる
 * - 自分で一から打ち込むトラック（お手本を持たない）では、お手本にするトラックを選ぶ
 * - お手本を持つトラックが 1 本も無いときは、何も出さない
 */
import { useEffect, useState } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';

/** 重ね方。auto: 開いているトラック自身のお手本 / off: 重ねない / 数値: そのトラックのお手本 */
type Choice = 'auto' | 'off' | number;

const controlStyle = {
    fontSize: 10, padding: '1px 6px', marginLeft: 6, textTransform: 'none', letterSpacing: 0,
    background: 'var(--bg-deep)', color: 'var(--text-mid)', border: '1px solid var(--border)',
    borderRadius: 3, fontFamily: 'inherit',
} as const;

/**
 * お手本の重ね表示の切り替え。
 *
 * @param activeTrackId - ピアノロールで開いているトラックの ID（開いていなければ null）
 */
export default function GhostBar({ activeTrackId }: { activeTrackId: number | null }) {
    // trackVersion を読んでおくと、トラックやお手本が増減したときに描き直される
    const { pianoRollRef, trackVersion } = useDaw();
    const [choice, setChoice] = useState<Choice>('auto');

    const withReference = engine.tracks.filter((t) => t.referenceNotes && t.referenceNotes.length > 0);
    const source = choice === 'off'
        ? undefined
        : withReference.find((t) => t.id === (choice === 'auto' ? activeTrackId : choice));

    // 選んだお手本を、ピアノロールに渡す
    useEffect(() => {
        pianoRollRef.current?.setGhostNotes(activeTrackId !== null && source ? source.referenceNotes : []);
    }, [pianoRollRef, activeTrackId, source, trackVersion]);

    if (withReference.length === 0) return null;

    return (
        <span id="ghost-bar" style={{ marginLeft: 12, textTransform: 'none', letterSpacing: 0 }}>
            <label htmlFor="ghost-source" className="area-hint">お手本を重ねる</label>
            <select id="ghost-source" style={controlStyle} value={String(choice)}
                onChange={(e) => setChoice(e.target.value === 'auto' || e.target.value === 'off' ? e.target.value : Number(e.target.value))}>
                <option value="auto">このトラックのお手本</option>
                <option value="off">重ねない</option>
                {withReference.map((t) => <option key={t.id} value={t.id}>{t.name} のお手本</option>)}
            </select>
        </span>
    );
}
