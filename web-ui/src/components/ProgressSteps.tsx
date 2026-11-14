/**
 * bunri DAW — 学ぶ流れの進み具合（ヘッダの下の段）。
 *
 * ① 曲を取り込む ② カルテを見る ③ パートに分ける ④ 打ち込む ⑤ 差分で直す の 5 段階を並べ、
 * それぞれが済んだか・いまの段階か・まだかを、実際の状態（カルテが在るか、パートに分けたか、
 * 練習のトラックにノートが在るか、差分チェックで比べたか）から決めて見せる（lib/learn.ts の `stepStates`）。
 * 段階を押すと、その作業をする場所（左パネルのタブ・段）を開く。
 *
 * 縦の場所を取らないよう 1 行にし、畳むこともできる（畳んだかどうかは、この画面を開いた人ごとに覚える）。
 */
import { useCallback, useState } from 'react';
import { useDaw } from '../lib/store';
import { readStored, writeStored } from '../lib/storage';
import engine from '../lib/engine';
import { tip } from '../lib/tooltip';
import { LEARN_STEPS, partTracks, progressFacts, stepStates, useLearnActions, type StepKey, type StepState } from '../lib/learn';

/** 段階の状態の、読み上げ用の言い方。 */
const STATE_LABEL: Record<StepState, string> = { done: '済み', current: 'いまの段階', todo: 'まだ' };

/** 段階に載せたときの説明（押すと開く場所で、何をするか） */
const STEP_TIP: Record<StepKey, string> = {
    import: '教材にする曲のファイルを選ぶ場所を開きます',
    chart: '取り込んだ曲のキー・コード進行・構成を見ます',
    separate: '曲をボーカルやベースなどのパートに分ける場所を開きます',
    practice: 'お手本を薄く重ねたピアノロールで、パートを自分で打ち込みます',
    diff: '打ち込みをお手本と比べて、違うところを一覧にします',
};

/** 左パネルの中の要素を、描き直しのあとで見える位置までスクロールする。 */
function revealLater(selector: string) {
    requestAnimationFrame(() => document.querySelector(selector)?.scrollIntoView({ block: 'start' }));
}

/**
 * 進み具合の段。
 */
export default function ProgressSteps() {
    const { chart, songFile, coachResult, coachPair, trackVersion, openLearn, pianoRollRef, setStatus } = useDaw();
    const { practicePart } = useLearnActions();
    const [collapsed, setCollapsed] = useState(() => readStored('bunri-progress-collapsed') === '1');
    void trackVersion;

    // 「差分で直す」は、打ち込みのあるトラックと比べたときに済む (空の打ち込みと比べただけでは済まない)
    const diffed = coachResult !== null && coachResult.result.summary.attempt_count > 0;
    const states = stepStates(progressFacts(chart !== null, songFile !== null, diffed));
    const current = LEARN_STEPS.find(s => states[s.key] === 'current');

    const toggle = useCallback(() => {
        setCollapsed(v => {
            writeStored('bunri-progress-collapsed', v ? '0' : '1');
            return !v;
        });
    }, []);

    /** 段階を押したとき、その作業をする場所を開く。 */
    const go = useCallback((key: StepKey) => {
        switch (key) {
            case 'import':
                openLearn('song');
                revealLater('#song-panel');
                break;
            case 'chart':
                openLearn('chart');
                break;
            case 'separate':
                openLearn('song');
                revealLater('#learn-parts');
                break;
            case 'practice': {
                // 練習中のパートが在ればそれを、無ければお手本を持つ最初のパートを練習する
                const pairPart = coachPair.referenceId !== null ? engine.getTrack(coachPair.referenceId) : undefined;
                const part = pairPart?.role === 'part' ? pairPart : partTracks().find(t => (t.referenceNotes?.length ?? 0) > 0);
                if (part) {
                    practicePart(part.id);
                } else {
                    openLearn('song');
                    revealLater('#learn-parts');
                    setStatus('打ち込む前に、原曲をパートに分けてください（「パートに分ける」）');
                }
                // ピアノロールが見えるように
                pianoRollRef.current?.wrap?.scrollIntoView?.({ block: 'nearest' });
                break;
            }
            case 'diff':
                openLearn('coach');
                break;
        }
    }, [openLearn, coachPair, practicePart, pianoRollRef, setStatus]);

    return (
        <nav id="learn-progress" aria-label="学ぶ流れの進み具合" className={collapsed ? 'collapsed' : undefined} data-tip-side="bottom">
            <button type="button" className="progress-toggle" aria-expanded={!collapsed} aria-controls="learn-progress-steps"
                {...tip(collapsed ? '5 つの段階を並べて表示します' : '段階の表示を畳んで、いまの段階だけにします')} onClick={toggle}>
                <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span> 進み具合
            </button>
            {collapsed ? (
                current && (
                    <button type="button" className="progress-current" onClick={() => go(current.key)} {...tip(STEP_TIP[current.key])}>
                        いま: {current.num} {current.label}
                    </button>
                )
            ) : (
                <ol id="learn-progress-steps">
                    {LEARN_STEPS.map((step, i) => (
                        <li key={step.key} className="progress-step-item">
                            {i > 0 && <span className="progress-sep" aria-hidden="true">›</span>}
                            <button type="button" className={`progress-step ${states[step.key]}`}
                                data-step={step.key} data-state={states[step.key]}
                                aria-current={states[step.key] === 'current' ? 'step' : undefined}
                                aria-label={`${step.num} ${step.label}（${STATE_LABEL[states[step.key]]}）`}
                                {...tip(STEP_TIP[step.key] + (states[step.key] === 'done' ? '\n（済んでいます）' : ''))}
                                onClick={() => go(step.key)}>
                                <span className="progress-mark" aria-hidden="true">{states[step.key] === 'done' ? '✓' : step.num}</span>
                                {step.label}
                            </button>
                        </li>
                    ))}
                </ol>
            )}
        </nav>
    );
}
