/**
 * bunri DAW — 差分チェックの「強さの違い」の欄（左パネルの差分チェックと、練習画面の右の一覧で使う）。
 *
 * 強さ（ベロシティ）を比べるのは、お手本が MIDI ファイルから読み込んだもののときだけ。音源から採譜した
 * お手本では、この欄そのものを出さない（採譜の強さは当てにならない。docs/coach-diff-design.md「強さの違い」）。
 *
 * 出すのは、信号処理側（backend/coach_diff.py）がまとめた事実だけ: 全体に弱い・強い、強弱が付いていない、
 * ある小節の範囲が弱い・強い、アクセントが付いていない。1 ノートごとの数値の差は並べない
 * （マウスで置いたノートは全部同じ強さなので、並べると、ほとんどのノートが「違う」になって読めない）。
 * 押すと、当たるノートを選んで光らせる（選ぶと、ピアノロールの上の「強さ」の欄で変えられる）。
 */
import { tip } from '../lib/tooltip';
import { velocityFindingText, velocitySummaryText, type VelocityDiff, type VelocityFinding } from '../lib/coach';

/** 一覧に出す、まとまりの上限（曲が長いと、小節の範囲が何十個にもなりうる）。 */
const MAX_FINDINGS = 8;

interface Props {
    /** 強さの違い。比べていない（採譜したお手本・以前の版の結果）なら、何も出さない */
    velocity: VelocityDiff | null | undefined;
    /** まとまりを押したとき（その場所へ移り、当たるノートを選ぶ） */
    onSelect: (finding: VelocityFinding) => void;
    /** いま選んでいるまとまり（練習画面） */
    selected?: VelocityFinding | null;
}

/**
 * 強さの違いの欄。比べたノートが無ければ出さない。
 */
export default function VelocityFindings({ velocity, onSelect, selected = null }: Props) {
    if (!velocity || velocity.compared === 0) return null;
    const different = velocity.weaker + velocity.stronger;
    const shown = velocity.findings.slice(0, MAX_FINDINGS);
    return (
        <section className="coach-velocity" aria-label="強さの違い">
            <h4>強さの違い</h4>
            <p className="note-text">
                MIDI ファイルから読み込んだお手本なので、強さも比べています。{velocitySummaryText(velocity)}。
            </p>
            {shown.length > 0 && (
                <ul className="velocity-findings" aria-label="強さの指摘（押すと、そのノートを選びます）">
                    {shown.map((finding, i) => (
                        <li key={i}>
                            <button type="button" className="velocity-finding-btn" aria-current={finding === selected ? 'true' : undefined}
                                onClick={() => onSelect(finding)}
                                {...tip('ピアノロールで、強さの違うノートを選んで光らせます。選んだノートは、ピアノロールの上の「強さ」の欄で変えられます')}>
                                {velocityFindingText(finding, velocity)}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {velocity.findings.length > MAX_FINDINGS && (
                <p className="note-text">ほか {velocity.findings.length - MAX_FINDINGS} 件（小節の順に {MAX_FINDINGS} 件を表示しています）</p>
            )}
            {different > 0 && shown.length === 0 && (
                <p className="note-text">まとまった違いはありません（1〜2 ノートだけの強さの違いは、挙げていません）。</p>
            )}
            {different > 0 && velocity.attempt_unset > 0 && (
                <p className="note-text">
                    マウスで置いたノートは強さを持たないので、{velocity.default_velocity} として比べています。
                </p>
            )}
        </section>
    );
}
