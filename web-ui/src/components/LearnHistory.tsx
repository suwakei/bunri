/**
 * bunri DAW — 学習の記録（差分の段に出す、比べた結果の履歴）。
 * 直近の数回の一致率・範囲・時刻と、前回との差（「前回より +8%」）。決まりは lib/learn-history.ts。
 */
import { useDaw } from '../lib/store';
import { attemptsFor, deltaText, matchSummary, percentOf } from '../lib/learn-history';
import { KIND_LABEL } from '../lib/coach';
import { HISTORY_KINDS } from '../lib/learn-history';

/** 一覧に出す回数。 */
const SHOWN = 5;

/** 一致率の推移を、小さな棒にする（文字で読めるよう、値は aria-label に入れる）。 */
function Trend({ percents }: { percents: number[] }) {
    return (
        <span className="learn-trend" role="img" aria-label={`一致率の推移: ${percents.map(p => `${p}%`).join('、')}`}>
            {percents.map((p, i) => <span key={i} className="learn-trend-bar" style={{ height: `${Math.max(8, p)}%` }} />)}
        </span>
    );
}

export default function LearnHistory({ referenceId, attemptId }: { referenceId: number; attemptId: number }) {
    const { learnHistory } = useDaw();
    const list = attemptsFor(learnHistory, attemptId, referenceId);
    const summary = matchSummary(learnHistory, attemptId, referenceId);
    if (!summary) return null;
    const recent = list.slice(-SHOWN).reverse();
    return (
        <section id="learn-history" className="learn-history" aria-labelledby="learn-history-title">
            <h4 id="learn-history-title">学習の記録</h4>
            <p className="body-text">
                <strong>{`一致 ${summary.percent}%`}</strong>
                <span className={'learn-delta' + (summary.deltaPercent === null ? '' : summary.deltaPercent > 0 ? ' up' : summary.deltaPercent < 0 ? ' down' : '')}>
                    {' '}{deltaText(summary)}
                </span>
                <span className="note-text">（{summary.attempts} 回目・いちばん良かったのは {summary.bestPercent}%）</span>
            </p>
            <Trend percents={list.slice(-10).map(a => percentOf(a.matchRate))} />
            <ol className="learn-attempts" aria-label="最近の比較">
                {recent.map((a) => {
                    const counts = HISTORY_KINDS.filter(k => a.counts[k] > 0).map(k => `${KIND_LABEL[k]} ${a.counts[k]}`).join(' / ');
                    return (
                        <li key={a.id} className="note-text">
                            {new Date(a.recordedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            {' '}{a.startBar}〜{a.endBar} 小節 {percentOf(a.matchRate)}%
                            {counts ? `（${counts}）` : '（違いなし）'}
                            {a.explanationId ? ' ・説明あり' : ''}
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}
