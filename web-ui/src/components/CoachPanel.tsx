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
 *
 * 比べたあとは「Claude に説明してもらう」で、違いの傾向・考えられる理由・まず何を見直すかを言葉にしてもらえる
 * （差分の説明。docs/coach-diff-design.md「言語化」）。説明の点に付いた場所を押すと、そこへ移動し、
 * 指摘の一覧の該当する行を示す。費用まわり（保存済みなら呼ばない・作り直しは明示的に・使用量と今日の累計）は
 * 再現ガイドと同じ（components/ClaudeParts.tsx）。保存済みの説明と、Claude に頼むまでもないときの決まった文は、
 * 比べた直後に Claude を呼ばずに取ってきて、最初から出す。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDaw } from '../lib/store';
import engine, { type PianoNote } from '../lib/engine';
import { describeError } from '../lib/api';
import { chartIdOfParts, practiceTrackOf } from '../lib/learn';
import {
    ExplainRequestError, KIND_LABEL, comparedOf, explanationRefLabel, fetchSavedExplanation, issueText, issuesById,
    rememberCompared, requestDiff, requestExplanation, type DiffIssue, type DiffResult, type ExplainRequest, type ExplanationRef,
    type ExplanationResponse, type IssueKind,
} from '../lib/coach';
import { formatUsd, type GuideToday } from '../lib/guide';
import { todayLine, usageLine } from '../lib/claude-usage';
import { ClaudeSendNote, ClaudeSettings, UnverifiedTerms } from './ClaudeParts';
import LearnHistory from './LearnHistory';
import { attemptFromDiff } from '../lib/learn-history';

/** 一覧に出す指摘の上限。多すぎると読めないので、重い小節から順に出して打ち切る。 */
const MAX_ISSUES = 40;

const KIND_ORDER: IssueKind[] = ['missing', 'pitch', 'octave', 'extra', 'timing', 'length'];

/** 比べた結果ごとの、学習の記録の番号（説明の鍵を、その記録に結び付けるため）。 */
const attemptEntry = new WeakMap<DiffResult, number>();

/** Claude に頼むまでもないとき（決まった文）の、理由の一言。 */
const RULE_NOTE: Record<string, string> = {
    no_diff: 'お手本と違うところが無いので、Claude は呼んでいません（費用はかかっていません）。',
    no_attempt: '打ち込みがまだ無いので、Claude は呼んでいません（費用はかかっていません）。',
    few_notes: 'お手本のノートが少なく傾向を言えないので、Claude は呼んでいません（費用はかかっていません）。',
    few_issues: '違いが少なく一覧を読めば足りるので、Claude は呼んでいません（費用はかかっていません）。',
};

/** 説明の参照の、押せる小さな札。 */
function RefChip({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button type="button" className="guide-ref" title="押すと、この場所へ移動し、指摘の一覧で示します" onClick={onClick}
            style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-mid)', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
            {label}
        </button>
    );
}

/**
 * 差分コーチのパネル。お手本を持つトラックが無いときは、使い方の案内だけを出す。
 */
export default function CoachPanel() {
    // trackVersion を読んでおくと、トラックが増減したときに選択肢が更新される
    const {
        pianoRollRef, beatsPerBar, trackVersion, bumpTracks, coachPair, setCoachPair, coachResult, setCoachResult, jumpTo,
        openLearn, chart, chartId, bpm, gridOffset, recordLearnAttempt, setAttemptExplanation,
    } = useDaw();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // 差分の説明
    const [explain, setExplain] = useState<ExplanationResponse | null>(null);
    const [explaining, setExplaining] = useState(false);
    const [explainError, setExplainError] = useState<InstanceType<typeof ExplainRequestError> | null>(null);
    const [today, setToday] = useState<GuideToday | null>(null);
    const [showKeyForm, setShowKeyForm] = useState(false);
    const [highlightId, setHighlightId] = useState<string | null>(null);
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
            const referenceNotes = reference.referenceNotes ?? [];
            const attemptNotes = attempt.pianoNotes ?? [];
            const stepsPerBar = (beatsPerBar || 4) * 4;
            const diff = await requestDiff(referenceNotes, attemptNotes, stepsPerBar);
            rememberCompared(diff, { reference: referenceNotes.map((n) => ({ ...n })), attempt: attemptNotes.map((n) => ({ ...n })), stepsPerBar });
            // 学習の記録に 1 件足す (説明ができたら、その鍵を結び付ける)
            attemptEntry.set(diff, recordLearnAttempt(attemptFromDiff(diff, {
                referenceId: reference.id, attemptId: attempt.id, part: reference.part ?? attempt.part ?? null,
                reference: referenceNotes, stepsPerBar,
            })));
            setCoachResult({ referenceId: reference.id, attemptId: attempt.id, result: diff });
        } catch (e) {
            setCoachResult(null);
            setError(describeError(e));
        } finally {
            setBusy(false);
        }
    }, [reference, attempt, pianoRollRef, beatsPerBar, setCoachResult, recordLearnAttempt]);

    // Claude の説明 (作った・保存済みを出した) を、この比較の記録に結び付ける
    useEffect(() => {
        if (!result || !explain || explain.source !== 'claude' || !explain.key) return;
        const entry = attemptEntry.get(result);
        if (entry !== undefined) setAttemptExplanation(entry, explain.key);
    }, [result, explain, setAttemptExplanation]);

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

    /**
     * 説明の材料。比べたときのノートに、お手本と同じ曲のカルテを添える（カルテのグリッドで採譜したパートのときだけ。
     * 別の曲を取り込んだあとの古いパートには、新しい曲のカルテを添えない）。
     */
    const request = useMemo<ExplainRequest | null>(() => {
        const compared = result ? comparedOf(result) : undefined;
        if (!compared) return null;
        const body: ExplainRequest = { reference: compared.reference, attempt: compared.attempt, steps_per_bar: compared.stepsPerBar };
        if (chart && chartId && reference?.role === 'part' && chartIdOfParts() === chartId) {
            body.chart_id = chartId;
            body.bpm = bpm;
            body.grid_offset_sec = gridOffset;
        }
        return body;
    }, [result, chart, chartId, reference, bpm, gridOffset]);

    // 比べ直したら（結果が変わったら）、前の説明は消して、Claude を呼ばずに返せる説明を探す。在れば最初から出す
    useEffect(() => {
        setExplain(null);
        setExplainError(null);
        setHighlightId(null);
        if (!request) return;
        let stale = false;
        fetchSavedExplanation(request)
            .then((saved) => {
                if (stale) return;
                if (saved.today) setToday(saved.today);
                if (saved.saved === true) setExplain(saved);
            })
            .catch(() => {
                // 取れなくても、頼むことはできる。ここでは何も出さない
            });
        return () => { stale = true; };
    }, [request]);

    const handleExplain = useCallback(async () => {
        if (!request) return;
        setExplaining(true);
        setExplainError(null);
        try {
            // すでに Claude の説明を出しているときに押すのは「作り直す」。そのときだけ、保存済みを使わせない
            const made = await requestExplanation(request, explain?.source === 'claude');
            setExplain(made);
            setHighlightId(null);
            if (made.today) setToday(made.today);
        } catch (e) {
            const err = e instanceof ExplainRequestError ? e : new ExplainRequestError(describeError(e), 'api');
            setExplainError(err);
            if (err.needsKey) setShowKeyForm(true);
        } finally {
            setExplaining(false);
        }
    }, [request, explain]);

    const handleSettingsSaved = useCallback((what: 'key' | 'limit') => {
        if (what === 'key') setShowKeyForm(false);
        setExplainError(null);
    }, []);

    /** 指摘の ID ⇔ 指摘（一覧の行に ID を付け、説明の参照から行を引く）。 */
    const ids = useMemo(() => {
        const byId = result ? issuesById(result) : new Map<string, DiffIssue>();
        const idOf = new Map<DiffIssue, string>();
        for (const [id, issue] of byId) idOf.set(issue, id);
        return { byId, idOf };
    }, [result]);

    // 説明の参照から選んだ行を、一覧の見える位置まで動かす
    useEffect(() => {
        if (!highlightId) return;
        document.querySelector(`#coach-panel [data-issue-id="${highlightId}"]`)?.scrollIntoView?.({ block: 'nearest' });
    }, [highlightId]);

    /** 説明の参照（指摘か小節）へ移動する。指摘なら、一覧の該当する行も示す。 */
    const jumpToRef = useCallback((ref: Pick<ExplanationRef, 'issue_id' | 'bar' | 'beat'>) => {
        const issue = ref.issue_id ? ids.byId.get(ref.issue_id) : undefined;
        if (issue) {
            handleJump(issue);
            setHighlightId(ref.issue_id);
            return;
        }
        const pr = pianoRollRef.current;
        if (pr && attempt && pr.getActiveTrackId() !== attempt.id) {
            pr.switchToTrack(attempt.id);
            bumpTracks();
        }
        setHighlightId(null);
        jumpTo({ step: (ref.bar - 1) * (beatsPerBar || 4) * 4 + ((ref.beat ?? 1) - 1) * 4 });
    }, [ids, handleJump, pianoRollRef, attempt, bumpTracks, jumpTo, beatsPerBar]);

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
                        </>
                    )}
                    {reference && attempt && <LearnHistory referenceId={reference.id} attemptId={attempt.id} />}
                    {request && (
                        <ExplanationSection explain={explain} explaining={explaining} error={explainError} today={today}
                            showKeyForm={showKeyForm} onToggleKeyForm={() => setShowKeyForm((v) => !v)}
                            onToday={setToday} onSettingsSaved={handleSettingsSaved}
                            onExplain={handleExplain} onJump={jumpToRef} />
                    )}
                    {total > 0 && (
                        <>
                            <ul aria-label="指摘の一覧" style={{ paddingLeft: 16, margin: '8px 0 0' }}>
                                {ordered.flatMap((bar) => bar.issues.map((issue, i) => {
                                    if (shown >= MAX_ISSUES) return [];
                                    shown += 1;
                                    return [
                                        <li key={`${bar.bar}-${i}`} data-issue-id={ids.idOf.get(issue)}
                                            className={`body-text coach-issue${highlightId && ids.idOf.get(issue) === highlightId ? ' highlighted' : ''}`}
                                            aria-current={highlightId && ids.idOf.get(issue) === highlightId ? 'true' : undefined}>
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

interface ExplanationSectionProps {
    explain: ExplanationResponse | null;
    explaining: boolean;
    error: InstanceType<typeof ExplainRequestError> | null;
    today: GuideToday | null;
    showKeyForm: boolean;
    onToggleKeyForm: () => void;
    onToday: (today: GuideToday) => void;
    onSettingsSaved: (what: 'key' | 'limit') => void;
    onExplain: () => void;
    onJump: (ref: Pick<ExplanationRef, 'issue_id' | 'bar' | 'beat'>) => void;
}

/** 差分の説明の欄。ボタン・費用の表示・説明の本文。 */
function ExplanationSection({
    explain, explaining, error, today, showKeyForm, onToggleKeyForm, onToday, onSettingsSaved, onExplain, onJump,
}: ExplanationSectionProps) {
    const body = explain?.explanation;
    const nextStep = body && (
        <p className="body-text" style={{ marginTop: 8 }}>
            <strong>最初にやること: </strong>{body.next_step}
            {body.next_step_bar !== null && (
                <>{' '}<RefChip label={`${body.next_step_bar} 小節へ`} onClick={() => onJump({ issue_id: null, bar: body.next_step_bar!, beat: null })} /></>
            )}
        </p>
    );

    // Claude に頼むまでもないとき (決まった文)。費用はかからないので、費用の表示もボタンも出さない。
    // 要約は上の正確さ・件数の言い直しなので出さず、次にやることだけを出す
    if (explain?.source === 'rule' && body) {
        return (
            <section className="coach-explain" aria-label="差分の説明">
                {nextStep}
                <p className="note-text" style={{ marginTop: 4 }}>{RULE_NOTE[explain.reason ?? ''] ?? 'Claude は呼んでいません（費用はかかっていません）。'}</p>
            </section>
        );
    }

    const fromClaude = explain?.source === 'claude' && body;
    return (
        <section className="coach-explain" aria-label="差分の説明">
            <button className="action-btn" onClick={onExplain} disabled={explaining}>
                {explaining ? '説明を作っています…（数十秒かかります）' : fromClaude ? '説明を作り直す（費用がかかります）' : 'Claude に説明してもらう'}
            </button>
            {fromClaude && !explaining && (
                <p className="note-text" style={{ marginTop: 6 }}>
                    この説明は保存済みです。同じ打ち込みで比べ直しても Claude は呼びません。作り直すと、もう一度 Claude を呼びます
                    {typeof explain.cost_usd === 'number' ? `（前回は概算 ${formatUsd(explain.cost_usd)}）` : ''}。
                </p>
            )}
            <ClaudeSendNote open={showKeyForm} onToggle={onToggleKeyForm}>
                お手本と打ち込みの違い（差分チェックの結果）を Anthropic の Claude に送ります。音声は送りません。ファイル名も送りません。
            </ClaudeSendNote>
            {today && <p id="coach-today" className="note-text" style={{ marginTop: 4 }}>{todayLine(today)}</p>}
            {error && <p role="alert" className="error-text" style={{ marginTop: 8 }}>{error.message}</p>}
            <ClaudeSettings idPrefix="coach" open={showKeyForm} today={today} onToday={onToday} onSaved={onSettingsSaved} />

            {fromClaude && (
                <div style={{ marginTop: 10 }}>
                    <p className="body-text">{body.summary}</p>
                    <ol className="coach-points" aria-label="見直すとよい点">
                        {body.points.map((point, i) => (
                            <li key={i}>
                                <div className="coach-point-title">{point.title}</div>
                                <p className="body-text"><span className="coach-point-label">傾向</span>{point.observation}</p>
                                <p className="body-text"><span className="coach-point-label">考えられる理由</span>{point.cause}</p>
                                <p className="body-text"><span className="coach-point-label">直し方</span>{point.fix}</p>
                                {point.refs.length > 0 && (
                                    <div className="coach-refs">
                                        {point.refs.map((ref, j) => <RefChip key={j} label={explanationRefLabel(ref)} onClick={() => onJump(ref)} />)}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>
                    {nextStep}
                    <UnverifiedTerms terms={body.unverified_terms} source="差分の結果" what="音名・コード名・小節番号" />
                    {body.dropped_points > 0 && (
                        <p className="note-text" style={{ marginTop: 6 }}>
                            差分の結果と結び付けられなかった点を {body.dropped_points} 個省きました。
                        </p>
                    )}
                    {explain.input && explain.input.issues > explain.input.issues_sent && (
                        <p className="note-text" style={{ marginTop: 6 }}>
                            指摘 {explain.input.issues} 件のうち {explain.input.issues_sent} 件と、全体の件数を材料にしました。
                        </p>
                    )}
                    <p className="note-text" style={{ marginTop: 8 }}>
                        作成: {explain.model}
                        {explain.created_at ? `（${new Date(explain.created_at).toLocaleString('ja-JP')}）` : ''}
                    </p>
                    <p id="coach-usage" className="note-text">この説明を作ったときの使用量: {usageLine(explain)}</p>
                </div>
            )}
        </section>
    );
}
