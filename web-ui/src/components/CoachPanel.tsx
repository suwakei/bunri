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
 * 「差分」の段では、このパネルの上に、練習の地図（components/PracticeMap.tsx。パートと構成の区間ごとの一致率）が出る。
 *
 * 比べる組と結果は全体の状態（`coachPair` / `coachResult`）に置いてある。「このパートを練習する」が
 * 組を決め、進み具合の段が「差分で直す」の済んだかを見るため。
 *
 * 指摘を押すと、その場所へ移動する（ピアノロールは、その小節とノートの高さまでスクロールする）。
 *
 * お手本が MIDI ファイルから読み込んだもののときだけ、強さ（ベロシティ）も比べて「強さの違い」の欄を出す
 * （components/VelocityFindings.tsx）。音源から採譜したお手本では、強さの欄そのものを出さない。
 *
 * 比べたあとは「Claude に説明してもらう」で、違いの傾向・考えられる理由・まず何を見直すかを言葉にしてもらえる
 * （差分の説明。docs/coach-diff-design.md「言語化」）。説明を作るのはアシスタント（右のドックのチャット）で、
 * ボタンはドックを開いて依頼を送るだけ（ストアの `askAssistant`）。説明はチャットにカードとして出る
 * （components/AssistantCards.tsx）。カードの場所を押すと、そこへ移動し、この一覧の該当する行を示す（`coachHighlight`）。
 * このパネルは Claude を呼ばない（設定の欄も持たない）。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useDaw, type CoachPair } from '../lib/store';
import { tip } from '../lib/tooltip';
import { blockedBy } from '../lib/notice';
import engine from '../lib/engine';
import { describeError } from '../lib/api';
import { referenceSourceOf } from '../lib/learn';
import { DRUM_DIFF_NOTE, DRUM_EXPLAIN_NOTE, diffModeOf } from '../lib/drums';
import {
    KIND_LABEL, coachHighlight, hasVelocityDiff, issueText, issuesById, rememberAttemptEntry, rememberCompared, requestDiff,
    resolveCoachPair, velocityNotesOf, type DiffIssue, type IssueKind, type VelocityFinding,
} from '../lib/coach';
import LearnHistory from './LearnHistory';
import VelocityFindings from './VelocityFindings';
import { attemptFromDiff } from '../lib/learn-history';

/** 一覧に出す指摘の上限。多すぎると読めないので、重い小節から順に出して打ち切る。 */
const MAX_ISSUES = 40;

const KIND_ORDER: IssueKind[] = ['missing', 'pitch', 'octave', 'extra', 'timing', 'length'];

/**
 * いま比べる組 (お手本のトラックと、打ち込みのトラック)。描画のたびに、トラックの一覧から選び直す
 * (決め方は lib/coach.ts の `resolveCoachPair`)。
 *
 * フックにしてある。描画の中で `engine.tracks` (React の外の、書き換わる値) を直接読むと、選んだトラックを使う
 * `useCallback` / `useMemo` を React Compiler が保てず、lint (react-hooks/preserve-manual-memoization) が落ちる。
 * 選んだトラックは、描画のあいだに書き換えない (比べる・移動するときに、そのまま使う)。
 */
function useCoachTracks(coachPair: CoachPair) {
    return resolveCoachPair(engine.tracks, coachPair);
}

/**
 * 差分コーチのパネル。お手本を持つトラックが無いときは、使い方の案内だけを出す。
 */
export default function CoachPanel() {
    // trackVersion を読んでおくと、トラックが増減したときに選択肢が更新される
    const {
        pianoRollRef, beatsPerBar, trackVersion, bumpTracks, coachPair, setCoachPair, coachResult, setCoachResult, jumpTo,
        openLearn, recordLearnAttempt, askAssistant,
    } = useDaw();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // チャットのカード (差分の説明) の場所のボタンで示している行
    const highlight = useSyncExternalStore(coachHighlight.subscribe, coachHighlight.get);
    void trackVersion;

    // 打ち込みの既定は、そのパートの練習のトラック。無ければお手本のトラック自身 (アシスタントの explain_diff も同じ決め方)
    const { reference, attempt, withReference } = useCoachTracks(coachPair);
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
            // 強さを比べるのは、MIDI ファイルから読み込んだお手本のときだけ (採譜したお手本の強さは当てにならない)
            const referenceSource = referenceSourceOf(reference);
            // お手本がドラムのパートなら、種類ごとの叩く位置だけを比べる (練習画面・アシスタントと同じ決め方)
            const diff = await requestDiff(referenceNotes, attemptNotes, stepsPerBar, referenceSource, diffModeOf(reference));
            rememberCompared(diff, {
                reference: referenceNotes.map((n) => ({ ...n })), attempt: attemptNotes.map((n) => ({ ...n })), stepsPerBar, referenceSource,
            });
            // 学習の記録に 1 件足す (説明ができたら、その鍵を結び付ける。lib/assistant-env.ts の linkExplanation)
            rememberAttemptEntry(diff, recordLearnAttempt(attemptFromDiff(diff, {
                referenceId: reference.id, attemptId: attempt.id, part: reference.part ?? attempt.part ?? null,
                reference: referenceNotes, stepsPerBar,
            })));
            setCoachResult({ referenceId: reference.id, attemptId: attempt.id, result: diff });
            // 前の差分を指していた示しは消す
            coachHighlight.set(null);
        } catch (e) {
            setCoachResult(null);
            setError(describeError(e));
        } finally {
            setBusy(false);
        }
    }, [reference, attempt, pianoRollRef, beatsPerBar, setCoachResult, recordLearnAttempt]);

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
     * 強さの違いのまとまりを開く。比べた打ち込みのトラックをピアノロールで開き、最初のノートの場所へ移って、
     * 当たるノートを選んで光らせる（選ぶと、ピアノロールの上の「強さ」の欄で変えられる）。
     */
    const handleVelocity = useCallback((finding: VelocityFinding) => {
        const pr = pianoRollRef.current;
        const velocity = result?.velocity;
        if (!pr || !attempt || !velocity) return;
        if (pr.getActiveTrackId() !== attempt.id) {
            pr.switchToTrack(attempt.id);
            bumpTracks();
        }
        const first = velocity.notes[finding.notes[0]]?.actual;
        jumpTo({ step: first ? first.step : (finding.start_bar - 1) * (beatsPerBar || 4) * 4, pitch: first });
        // ピアノロールがいま持っているノートの並びで探す (比べたあとにノートを変えていても、同じ形のノートが残っていれば選ぶ)
        pr.flashNotes?.(velocityNotesOf(finding, velocity, pr.notes ?? attempt.pianoNotes ?? []));
    }, [pianoRollRef, result, attempt, beatsPerBar, bumpTracks, jumpTo]);

    /** 指摘の ID ⇔ 指摘（一覧の行に ID を付け、説明の参照から行を引く）。 */
    const ids = useMemo(() => {
        const byId = result ? issuesById(result) : new Map<string, DiffIssue>();
        const idOf = new Map<DiffIssue, string>();
        for (const [id, issue] of byId) idOf.set(issue, id);
        return { byId, idOf };
    }, [result]);

    // 示している行は、いま出している差分の同じ組・同じ場所の指摘のときだけ光らせる (比べ直した後の古い示しは光らせない)
    const highlightId = useMemo(() => {
        if (!highlight || !reference || !attempt || highlight.referenceId !== reference.id || highlight.attemptId !== attempt.id) return null;
        const issue = ids.byId.get(highlight.issueId);
        return issue && issue.bar === highlight.bar && (highlight.beat === null || issue.beat === highlight.beat) ? highlight.issueId : null;
    }, [highlight, ids, reference, attempt]);

    // 説明の場所から示した行を、一覧の見える位置まで動かす
    useEffect(() => {
        if (!highlightId) return;
        document.querySelector(`#coach-panel [data-issue-id="${highlightId}"]`)?.scrollIntoView?.({ block: 'nearest' });
    }, [highlightId]);

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
                <button className="action-btn" onClick={() => openLearn('song')} {...tip('パートに分ける場所を開きます')}>曲とパートを開く</button>
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
    // お手本がドラムのパートのとき。比べ方の説明を添え、指摘を種類の名前で書き、Claude の説明は出さない
    const drums = diffModeOf(reference) === 'drums';

    return (
        <div id="coach-panel" className="panel-content">
            {header}
            <div>
                <label htmlFor="coach-reference">お手本</label>
                <select id="coach-reference" value={reference.id} disabled={busy} {...blockedBy(busy && 'いま比べています。終わるまで待ってください')}
                    {...tip('比べる相手にするお手本（パート）')}
                    onChange={(e) => setCoachPair({ referenceId: Number(e.target.value), attemptId: null })}>
                    {withReference.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.referenceNotes!.length} ノート）</option>)}
                </select>
            </div>
            <div>
                <label htmlFor="coach-attempt">比べる打ち込み</label>
                <select id="coach-attempt" value={attempt?.id ?? reference.id} disabled={busy} {...blockedBy(busy && 'いま比べています。終わるまで待ってください')}
                    {...tip('お手本と比べる、自分の打ち込みが入ったトラック')}
                    onChange={(e) => setCoachPair({ referenceId: reference.id, attemptId: Number(e.target.value) })}>
                    {engine.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}（{(t.pianoNotes || []).length} ノート）</option>)}
                </select>
            </div>
            <button className="action-btn" onClick={handleCompare} disabled={busy} {...blockedBy(busy && 'いま比べています。終わるまで待ってください')}
                {...tip(referenceSourceOf(reference) === 'midi'
                    ? '打ち込みをお手本と比べて、違うところを小節ごとに挙げます。MIDI ファイルから読み込んだお手本なので、強さも比べます'
                    : drums
                        ? '打ち込みをお手本と比べて、違うところを小節ごとに挙げます。ドラムなので、種類ごとの叩く位置だけを比べます'
                        : '打ち込みをお手本と比べて、違うところを小節ごとに挙げます')}>
                {busy ? '比べています…' : 'お手本と比べる'}
            </button>
            {drums && <p className="note-text" id="coach-drum-note" style={{ marginTop: 6 }}>{DRUM_DIFF_NOTE}</p>}

            {error && <p role="alert" className="error-text" style={{ marginTop: 8 }}>{error}</p>}

            {result && (
                <div style={{ marginTop: 12 }}>
                    <p className="body-text">
                        お手本 {result.summary.reference_count} ノートのうち、
                        <strong>{Math.round(result.summary.accuracy * 100)}%</strong> が合っています
                        （{drums ? '位置がぴったり' : '位置も長さもぴったり'}: {result.summary.exact} ノート）。
                    </p>
                    {total === 0 ? (
                        <p className="body-text" style={{ marginTop: 6 }}>
                            {hasVelocityDiff(result) ? '高さ・位置・長さは、お手本どおりです。' : 'お手本どおりです。'}
                        </p>
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
                    <VelocityFindings velocity={result.velocity} onSelect={handleVelocity} />
                    {reference && attempt && <LearnHistory referenceId={reference.id} attemptId={attempt.id} />}
                    {!drums && attempt && (
                        <section className="coach-explain" aria-label="差分の説明">
                            <button className="action-btn" id="coach-explain-ask" onClick={() => askAssistant(`差分を説明して（${attempt.name}）`)}
                                {...tip('アシスタントのドックを開いて、この差分の説明を頼みます。違いの傾向・考えられる理由・まず何を見直すかが、チャットに出ます')}>
                                Claude に説明してもらう
                            </button>
                            <p className="note-text" style={{ marginTop: 6 }}>
                                説明はアシスタント（右のドック）が作り、チャットに出ます。お手本と打ち込みの違い（差分チェックの結果）を
                                Anthropic の Claude に送ります。音声とファイル名は送りません。保存済みの説明や、違いが少なくて Claude に頼むまでもないときは、
                                作り直さずにそれを出します。
                            </p>
                        </section>
                    )}
                    {drums && (
                        // ドラムでは、説明のボタンの代わりに決まった文を出す (Claude は呼ばない)
                        <section className="coach-explain" aria-label="差分の説明">
                            <p className="note-text" id="coach-drum-explain" style={{ marginTop: 4 }}>{DRUM_EXPLAIN_NOTE}</p>
                        </section>
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
                                            <button type="button" {...tip('ピアノロールでこの場所を開きます')}
                                                onClick={() => handleJump(issue)}
                                                style={{ display: 'block', width: '100%', background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', textDecoration: 'underline dotted' }}>
                                                {issueText(issue, drums ? 'drums' : undefined)}
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
