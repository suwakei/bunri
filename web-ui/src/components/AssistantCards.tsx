/**
 * bunri DAW — アシスタントのチャットに出すカード（再現ガイド・差分の説明）。
 *
 * 再現ガイドと差分の説明は、アシスタントのツール（`make_guide` / `explain_diff`）が作り、ここでカードとして出す
 * （形は lib/assistant-cards.ts）。以前は「学ぶ」→「ガイド」と「差分」のパネルに出していた表示を、ここへ移した。
 *
 * - 手順・点に付いた場所のボタンを押すと、そこへ移動する。差分の説明の場所は、比べた打ち込みのトラックをピアノロールで開き、
 *   その拍とノートの高さまでスクロールし、差分の段の指摘の一覧の該当する行を示す（`coachHighlight`）
 * - 説明文に、事実（カルテ・差分の結果）に無い語が出てきたら、その旨を添える（`UnverifiedTerms`）
 * - 作ったモデルと、作ったときの使用量を添える。保存済みを出しただけのときは、Claude を呼んでいないことを添える
 *
 * 表示は文と場所だけで、音符は出さない（Claude は音符を出力しない）。
 */
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { tip } from '../lib/tooltip';
import { chartBarToSec } from '../lib/grid';
import { coachHighlight } from '../lib/coach';
import { modelLabel, usageLine } from '../lib/claude-usage';
import { formatUsd } from '../lib/guide';
import { ruleNote, type CardExplanationRef, type CardGuideRef, type ChatCard, type ExplanationCard, type GuideCard } from '../lib/assistant-cards';
import { UnverifiedTerms } from './ClaudeParts';

/** 手順の主題ごとの見出しラベル。 */
const TOPIC_LABEL: Record<string, string> = {
    grid: 'テンポ・拍',
    key: 'キー',
    chords: 'コード',
    sections: '構成',
    mix: '音作り・ミックス',
    general: '全体',
};

/** 場所の、押せる小さな札。 */
function RefChip({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
    return <button type="button" className="guide-ref" {...tip(hint)} onClick={onClick}>{label}</button>;
}

/** 作成のモデルと日時、使用量。保存済みを出しただけなら、そう添える。 */
function CardFoot({ card, what }: { card: ChatCard; what: string }) {
    const when = card.createdAt ? new Date(card.createdAt) : null;
    return (
        <footer className="assistant-card-foot">
            <span>
                作成: {modelLabel(card.model)}
                {when && !Number.isNaN(when.getTime()) ? `（${when.toLocaleString('ja-JP')}）` : ''}
            </span>
            {card.cached
                ? <span>保存済みの{what}を出しました（Claude は呼んでいません{card.costUsd !== null ? `。作ったときは概算 ${formatUsd(card.costUsd)}` : ''}）</span>
                : card.usage && <span className="assistant-card-usage">この{what}を作ったときの使用量: {usageLine({ usage: card.usage, cost_usd: card.costUsd })}</span>}
        </footer>
    );
}

/** 再現ガイドのカード。 */
export function GuideCardView({ card }: { card: GuideCard }) {
    const { chart, chartId, jumpTo, setStatus } = useDaw();

    /** 手順の場所（区間・小節）へ移動する。小節が在れば小節へ、無ければ区間の頭へ。 */
    const jump = (ref: CardGuideRef) => {
        if (!chart || chartId !== card.chartId) {
            setStatus('このガイドは、いま開いているカルテとは別の曲のものなので、移動できません。その曲を取り込み直すと、移動できます', 'hint');
            return;
        }
        let sec: number | null = null;
        if (ref.bar !== null) sec = chartBarToSec(chart, ref.bar, ref.beat ?? 1);
        else if (ref.section_id !== null) sec = chart.sections.find((s) => s.id === ref.section_id)?.start_sec ?? null;
        if (sec === null) {
            setStatus(`「${ref.label}」が、いまのカルテに見つかりませんでした（構成を直した後かもしれません）`, 'hint');
            return;
        }
        jumpTo({ sec });
        setStatus(`${ref.label} へ移動しました`);
    };

    return (
        <section className="assistant-card guide-card" aria-label={`再現ガイド（${card.target}）`}>
            <header className="assistant-card-head">
                <span className="assistant-card-kind">再現ガイド</span>
                <span className="assistant-card-target">{card.target}</span>
            </header>
            <p className="assistant-card-text">{card.overview}</p>
            <ol className="assistant-card-steps" aria-label="再現の手順">
                {card.steps.map((step, i) => (
                    <li key={i}>
                        <div className="assistant-card-title">
                            {step.title}
                            <span className="assistant-card-topic">{TOPIC_LABEL[step.topic] ?? step.topic}</span>
                        </div>
                        <p className="assistant-card-text">{step.body}</p>
                        {step.refs.length > 0 && (
                            <div className="coach-refs">
                                {step.refs.map((ref, j) => <RefChip key={j} label={ref.label} hint="この場所へ移動します" onClick={() => jump(ref)} />)}
                            </div>
                        )}
                    </li>
                ))}
            </ol>
            {card.cautions.length > 0 && (
                <div className="assistant-card-cautions">
                    <div className="assistant-card-title">注意</div>
                    <ul>{card.cautions.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
            )}
            <UnverifiedTerms terms={card.unverifiedTerms} source="解析結果" />
            <CardFoot card={card} what="ガイド" />
        </section>
    );
}

/** 差分の説明のカード。 */
export function ExplanationCardView({ card }: { card: ExplanationCard }) {
    const { pianoRollRef, bumpTracks, jumpTo, beatsPerBar, setStatus } = useDaw();

    /**
     * 説明の場所（指摘か小節）へ移動する。比べた打ち込みのトラックをピアノロールで開き、その拍へ移る。
     * 指摘を指していれば、そのノートの高さまでスクロールし、差分の段の一覧の該当する行を示す。
     */
    const jump = (ref: Pick<CardExplanationRef, 'issueId' | 'bar' | 'beat' | 'pitch'>) => {
        // トラックの番号は、プロジェクトを開き直すと振り直される。名前も同じときだけ、同じトラックとみなす
        // (番号だけで探すと、開き直した後に、別のトラックを黙って開いてしまう)
        const track = engine.getTrack(card.attemptId);
        if (!track || track.name !== card.trackName) {
            setStatus(`説明した打ち込みのトラック（${card.trackName}）が見つかりません。削除したか、名前を変えたか、`
                + 'プロジェクトを開き直してトラックの番号が変わっています。もう一度「差分を説明して」と頼んでください', 'hint');
            return;
        }
        const pr = pianoRollRef.current;
        if (pr && pr.getActiveTrackId() !== card.attemptId) {
            pr.switchToTrack(card.attemptId);
            bumpTracks();
        }
        coachHighlight.set(ref.issueId
            ? { referenceId: card.referenceId, attemptId: card.attemptId, issueId: ref.issueId, bar: ref.bar, beat: ref.beat }
            : null);
        jumpTo({ step: (ref.bar - 1) * (beatsPerBar || 4) * 4 + ((ref.beat ?? 1) - 1) * 4, pitch: ref.pitch });
    };

    const nextStep = (
        <p className="assistant-card-text">
            <strong>最初にやること: </strong>{card.nextStep}
            {card.nextStepBar !== null && (
                <>{' '}<RefChip label={`${card.nextStepBar} 小節へ`} hint="この小節へ移動します"
                    onClick={() => jump({ issueId: null, bar: card.nextStepBar!, beat: null })} /></>
            )}
        </p>
    );

    return (
        <section className="assistant-card explanation-card" aria-label={`差分の説明（${card.trackName}）`}>
            <header className="assistant-card-head">
                <span className="assistant-card-kind">差分の説明</span>
                <span className="assistant-card-target">{card.trackName}</span>
            </header>
            {card.source === 'rule' ? (
                // Claude に頼むまでもないとき (決まった文)。要約は差分の段の件数の言い直しなので出さず、次にやることだけを出す
                <>
                    {nextStep}
                    <p className="assistant-card-note">{ruleNote(card.reason)}</p>
                </>
            ) : (
                <>
                    <p className="assistant-card-text">{card.summary}</p>
                    <ol className="coach-points" aria-label="見直すとよい点">
                        {card.points.map((point, i) => (
                            <li key={i}>
                                <div className="coach-point-title">{point.title}</div>
                                <p className="assistant-card-text"><span className="coach-point-label">傾向</span>{point.observation}</p>
                                <p className="assistant-card-text"><span className="coach-point-label">考えられる理由</span>{point.cause}</p>
                                <p className="assistant-card-text"><span className="coach-point-label">直し方</span>{point.fix}</p>
                                {point.refs.length > 0 && (
                                    <div className="coach-refs">
                                        {point.refs.map((ref, j) => (
                                            <RefChip key={j} label={ref.label} hint="この場所へ移動して、差分の段の指摘の一覧で示します" onClick={() => jump(ref)} />
                                        ))}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>
                    {nextStep}
                    <UnverifiedTerms terms={card.unverifiedTerms} source="差分の結果" what="音名・コード名・小節番号" />
                    {card.droppedPoints > 0 && <p className="assistant-card-note">差分の結果と結び付けられなかった点を {card.droppedPoints} 個省きました。</p>}
                    {card.input && card.input.issues > card.input.issuesSent && (
                        <p className="assistant-card-note">指摘 {card.input.issues} 件のうち {card.input.issuesSent} 件と、全体の件数を材料にしました。</p>
                    )}
                    <CardFoot card={card} what="説明" />
                </>
            )}
        </section>
    );
}

/** チャットのカード 1 つ。 */
export function CardView({ card }: { card: ChatCard }) {
    return card.card === 'guide' ? <GuideCardView card={card} /> : <ExplanationCardView card={card} />;
}
