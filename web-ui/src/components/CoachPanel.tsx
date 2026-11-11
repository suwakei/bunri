/**
 * bunri DAW — 差分コーチ（第3層の土台）のパネル。
 *
 * お手本（原曲を採譜した時点のノート）と、いまの打ち込みを比べて、どの小節のどの音が
 * 抜けているか・違っているかを一覧にする。指摘は機械的に出した事実で、LLM は使っていない。
 *
 * お手本を持つのは、楽曲の解析（採譜）で作ったトラックだけ。そのトラック自身を直した結果と
 * 比べることも、別のトラックに自分で打ち込んだものと比べることもできる。
 */
import { useCallback, useState } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { KIND_LABEL, issueText, requestDiff, type DiffResult, type IssueKind } from '../lib/coach';

/** 一覧に出す指摘の上限。多すぎると読めないので、重い小節から順に出して打ち切る。 */
const MAX_ISSUES = 40;

const KIND_ORDER: IssueKind[] = ['missing', 'pitch', 'octave', 'extra', 'timing', 'length'];

/**
 * 差分コーチのパネル。お手本を持つトラックが無いときは、使い方の案内だけを出す。
 */
export default function CoachPanel() {
    // trackVersion を読んでおくと、トラックが増減したときに選択肢が更新される
    const { pianoRollRef, beatsPerBar, trackVersion } = useDaw();
    const [referenceId, setReferenceId] = useState<number | null>(null);
    const [attemptId, setAttemptId] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<DiffResult | null>(null);
    const [error, setError] = useState('');
    void trackVersion;

    const withReference = engine.tracks.filter((t) => t.referenceNotes && t.referenceNotes.length > 0);
    const reference = withReference.find((t) => t.id === referenceId) ?? withReference[0];
    const attempt = engine.tracks.find((t) => t.id === attemptId) ?? reference;

    const handleCompare = useCallback(async () => {
        if (!reference || !attempt) return;
        // ピアノロールで編集中の内容を、トラックに書き戻してから比べる
        pianoRollRef.current?._saveToEngine();
        setBusy(true);
        setError('');
        try {
            setResult(await requestDiff(reference.referenceNotes ?? [], attempt.pianoNotes ?? [], (beatsPerBar || 4) * 4));
        } catch (e) {
            setResult(null);
            setError(String((e as Error)?.message ?? e));
        } finally {
            setBusy(false);
        }
    }, [reference, attempt, pianoRollRef, beatsPerBar]);

    const header = (
        <>
            <h3 style={{ marginBottom: 6 }}>差分チェック</h3>
            <p className="panel-desc" style={{ marginBottom: 8 }}>
                お手本（原曲を採譜したノート）と、いまの打ち込みを比べます。
            </p>
        </>
    );
    const wrapper = { marginTop: 20, paddingTop: 12, borderTop: '1px solid var(--border, #2a2a35)' } as const;

    if (!reference) {
        return (
            <div id="coach-panel" style={wrapper}>
                {header}
                <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                    お手本になるトラックがまだありません。「ファイル」タブで楽曲を解析すると、採譜したノートがお手本になります。
                </p>
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
        <div id="coach-panel" style={wrapper}>
            {header}
            <div className="field">
                <label htmlFor="coach-reference">お手本</label>
                <select id="coach-reference" value={reference.id} disabled={busy}
                    onChange={(e) => { setReferenceId(Number(e.target.value)); setResult(null); }}>
                    {withReference.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.referenceNotes!.length} 音）</option>)}
                </select>
            </div>
            <div className="field">
                <label htmlFor="coach-attempt">比べる打ち込み</label>
                <select id="coach-attempt" value={attempt?.id ?? reference.id} disabled={busy}
                    onChange={(e) => { setAttemptId(Number(e.target.value)); setResult(null); }}>
                    {engine.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}（{(t.pianoNotes || []).length} 音）</option>)}
                </select>
            </div>
            <button className="btn btn-primary" onClick={handleCompare} disabled={busy}>
                {busy ? '比べています…' : 'お手本と比べる'}
            </button>

            {error && <p role="alert" style={{ fontSize: 11, color: '#e87878', marginTop: 8 }}>{error}</p>}

            {result && (
                <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 12, lineHeight: 1.7 }}>
                        お手本 {result.summary.reference_count} 音のうち、
                        <strong>{Math.round(result.summary.accuracy * 100)}%</strong> が合っています
                        （位置も長さもぴったり: {result.summary.exact} 音）。
                    </p>
                    {total === 0 ? (
                        <p style={{ fontSize: 12, marginTop: 6 }}>お手本どおりです。</p>
                    ) : (
                        <>
                            <p style={{ fontSize: 11, color: 'var(--text-mid)', marginTop: 4 }}>
                                {KIND_ORDER.filter((k) => result.summary[k] > 0).map((k) => `${KIND_LABEL[k]} ${result.summary[k]}`).join(' / ')}
                            </p>
                            {result.worst_bars.length > 0 && (
                                <p style={{ fontSize: 11, marginTop: 6 }}>
                                    まず見るとよい小節: {result.worst_bars.map((b) => `${b} 小節`).join('、')}
                                </p>
                            )}
                            <ul aria-label="指摘の一覧" style={{ paddingLeft: 16, margin: '8px 0 0' }}>
                                {ordered.flatMap((bar) => bar.issues.map((issue, i) => {
                                    if (shown >= MAX_ISSUES) return [];
                                    shown += 1;
                                    return [<li key={`${bar.bar}-${i}`} style={{ fontSize: 11, lineHeight: 1.7 }}>{issueText(issue)}</li>];
                                }))}
                            </ul>
                            {total > MAX_ISSUES && (
                                <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
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
