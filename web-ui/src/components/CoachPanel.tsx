/**
 * bunri DAW — 差分コーチ（第3層の土台）のパネル。
 *
 * お手本（原曲を採譜した時点のノート）と、いまの打ち込みを比べて、どの小節のどのノートが
 * 抜けているか・違っているかを一覧にする。指摘は機械的に出した事実で、LLM は使っていない。
 *
 * お手本を持つのは、パート分離（採譜）で作ったパートのトラックだけ。既定では、そのパートの
 * 練習のトラック（「このパートを練習する」で作ったもの）と比べる。パートのトラック自身や、
 * 別のトラックに自分で打ち込んだものと比べることもできる。
 *
 * 比べる組と結果は全体の状態（`coachPair` / `coachResult`）に置いてある。「このパートを練習する」が
 * 組を決め、進み具合の段が「差分で直す」の済んだかを見るため。
 *
 * 指摘を押すと、その場所へ移動する（ピアノロールは、その小節とノートの高さまでスクロールする）。
 */
import { useCallback, useState } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { describeError } from '../lib/api';
import { practiceTrackOf } from '../lib/learn';
import { KIND_LABEL, issueText, requestDiff, type DiffIssue, type IssueKind } from '../lib/coach';

/** 一覧に出す指摘の上限。多すぎると読めないので、重い小節から順に出して打ち切る。 */
const MAX_ISSUES = 40;

const KIND_ORDER: IssueKind[] = ['missing', 'pitch', 'octave', 'extra', 'timing', 'length'];

/**
 * 差分コーチのパネル。お手本を持つトラックが無いときは、使い方の案内だけを出す。
 */
export default function CoachPanel() {
    // trackVersion を読んでおくと、トラックが増減したときに選択肢が更新される
    const { pianoRollRef, beatsPerBar, trackVersion, bumpTracks, coachPair, setCoachPair, coachResult, setCoachResult, jumpTo, openLearn } = useDaw();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    void trackVersion;

    const withReference = engine.tracks.filter((t) => t.referenceNotes && t.referenceNotes.length > 0);
    const reference = withReference.find((t) => t.id === coachPair.referenceId) ?? withReference[0];
    // 打ち込みの既定は、そのパートの練習のトラック。無ければお手本のトラック自身
    const attempt = engine.tracks.find((t) => t.id === coachPair.attemptId)
        ?? (reference ? practiceTrackOf(reference.id) ?? reference : undefined);
    // 結果は、いま選んでいる組で比べたものだけを出す
    const result = coachResult && reference && attempt
        && coachResult.referenceId === reference.id && coachResult.attemptId === attempt.id ? coachResult.result : null;

    const handleCompare = useCallback(async () => {
        if (!reference || !attempt) return;
        // ピアノロールで編集中の内容を、トラックに書き戻してから比べる
        pianoRollRef.current?._saveToEngine();
        setBusy(true);
        setError('');
        try {
            const diff = await requestDiff(reference.referenceNotes ?? [], attempt.pianoNotes ?? [], (beatsPerBar || 4) * 4);
            setCoachResult({ referenceId: reference.id, attemptId: attempt.id, result: diff });
        } catch (e) {
            setCoachResult(null);
            setError(describeError(e));
        } finally {
            setBusy(false);
        }
    }, [reference, attempt, pianoRollRef, beatsPerBar, setCoachResult]);

    /**
     * 指摘の在る場所を開く。比べた打ち込みのトラックをピアノロールで開き、再生位置をその拍へ移して、
     * タイムラインとピアノロールをそこまで（ピアノロールは、そのノートの高さまで縦にも）スクロールする。
     */
    const handleJump = useCallback((issue: DiffIssue) => {
        const pr = pianoRollRef.current;
        if (!pr || !attempt) return;
        if (pr.getActiveTrackId() !== attempt.id) {
            pr.switchToTrack(attempt.id);
            bumpTracks();
        }
        const pitch = issue.actual ?? issue.expected ?? undefined;
        jumpTo({ step: (issue.bar - 1) * (beatsPerBar || 4) * 4 + (issue.beat - 1) * 4, pitch });
    }, [pianoRollRef, attempt, beatsPerBar, bumpTracks, jumpTo]);

    const header = (
        <>
            <h3 style={{ marginBottom: 6 }}>差分チェック</h3>
            <p className="panel-desc" style={{ marginBottom: 8 }}>
                お手本（原曲を採譜したノート）と、いまの打ち込みを比べます。
            </p>
        </>
    );
    if (!reference) {
        return (
            <div id="coach-panel" className="panel-content">
                {header}
                <p className="body-text" style={{ color: 'var(--text-mid)' }}>
                    お手本になるトラックがまだありません。「曲とパート」で原曲をパートに分けると、採譜したノートがお手本になります。
                </p>
                <button className="action-btn" onClick={() => openLearn('song')}>曲とパートを開く</button>
            </div>
        );
    }

    // 重い小節を先に、残りは小節順に並べて、上限まで出す
    const ordered = result
        ? [
            ...result.worst_bars.map((bar) => result.bars.find((b) => b.bar === bar)!).filter(Boolean),
            ...result.bars.filter((b) => !result.worst_bars.includes(b.bar)),
        ]
        : [];
    let shown = 0;
    const total = result ? result.bars.reduce((sum, b) => sum + b.issues.length, 0) : 0;

    return (
        <div id="coach-panel" className="panel-content">
            {header}
            <div>
                <label htmlFor="coach-reference">お手本</label>
                <select id="coach-reference" value={reference.id} disabled={busy}
                    onChange={(e) => setCoachPair({ referenceId: Number(e.target.value), attemptId: null })}>
                    {withReference.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.referenceNotes!.length} ノート）</option>)}
                </select>
            </div>
            <div>
                <label htmlFor="coach-attempt">比べる打ち込み</label>
                <select id="coach-attempt" value={attempt?.id ?? reference.id} disabled={busy}
                    onChange={(e) => setCoachPair({ referenceId: reference.id, attemptId: Number(e.target.value) })}>
                    {engine.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}（{(t.pianoNotes || []).length} ノート）</option>)}
                </select>
            </div>
            <button className="action-btn" onClick={handleCompare} disabled={busy}>
                {busy ? '比べています…' : 'お手本と比べる'}
            </button>

            {error && <p role="alert" className="error-text" style={{ marginTop: 8 }}>{error}</p>}

            {result && (
                <div style={{ marginTop: 12 }}>
                    <p className="body-text">
                        お手本 {result.summary.reference_count} ノートのうち、
                        <strong>{Math.round(result.summary.accuracy * 100)}%</strong> が合っています
                        （位置も長さもぴったり: {result.summary.exact} ノート）。
                    </p>
                    {total === 0 ? (
                        <p className="body-text" style={{ marginTop: 6 }}>お手本どおりです。</p>
                    ) : (
                        <>
                            <p style={{ fontSize: 12, color: 'var(--text-mid)', marginTop: 4 }}>
                                {KIND_ORDER.filter((k) => result.summary[k] > 0).map((k) => `${KIND_LABEL[k]} ${result.summary[k]}`).join(' / ')}
                            </p>
                            {result.worst_bars.length > 0 && (
                                <p className="body-text" style={{ marginTop: 6 }}>
                                    まず見るとよい小節: {result.worst_bars.map((b) => `${b} 小節`).join('、')}
                                </p>
                            )}
                            <ul aria-label="指摘の一覧" style={{ paddingLeft: 16, margin: '8px 0 0' }}>
                                {ordered.flatMap((bar) => bar.issues.map((issue, i) => {
                                    if (shown >= MAX_ISSUES) return [];
                                    shown += 1;
                                    return [
                                        <li key={`${bar.bar}-${i}`} className="body-text">
                                            <button type="button" title="ピアノロールでこの場所を開く"
                                                onClick={() => handleJump(issue)}
                                                style={{ display: 'block', width: '100%', background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', textDecoration: 'underline dotted' }}>
                                                {issueText(issue)}
                                            </button>
                                        </li>,
                                    ];
                                }))}
                            </ul>
                            {total > MAX_ISSUES && (
                                <p className="note-text" style={{ marginTop: 4 }}>
                                    ほか {total - MAX_ISSUES} 件（重い小節から {MAX_ISSUES} 件を表示しています）
                                </p>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
