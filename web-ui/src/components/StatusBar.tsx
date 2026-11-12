/**
 * bunri DAW — ステータスバー + プログレスバー
 */
import { useDaw } from '../lib/store';
import { useJobs } from '../lib/useJob';
import { jobTracker, slotOf, stageCount, type Job } from '../lib/jobs';
import { hasDawCard, useShowJob } from '../lib/job-focus';
import { formatElapsed } from '../lib/time';

/**
 * 動いている時間のかかる処理（ジョブ）の小さな表示。押すと、その処理のカード（始めた場所）を開く。
 * ツールの画面で始めた処理のように、DAW の画面にカードが無いものは、ここで中止できる。
 */
function JobIndicator({ job }: { job: Job }) {
    const showJob = useShowJob();
    const percent = job.progress === null ? '' : ` ${Math.round(job.progress * 100)}%`;
    const count = stageCount(job);
    const where = hasDawCard(slotOf(job));
    const text = `${job.title}${job.cancel_requested ? '（キャンセル中…）' : ''}${count ? ` ${count}` : ''}${percent} ・ ${formatElapsed(job.elapsed_sec)}`;
    return (
        <span id="job-indicator">
            <button type="button" className="job-indicator-open" disabled={!where}
                title={where ? `${job.title}の進み具合を見る` : `${job.title}（${job.stage ?? '準備しています…'}）`}
                aria-label={`実行中: ${text}${where ? '。押すと進み具合を表示します' : ''}`}
                onClick={() => showJob(job)}>
                <span className="job-indicator-dot" aria-hidden="true" />
                <span className="job-indicator-text">{text}</span>
            </button>
            {!where && (
                <button type="button" className="job-cancel" disabled={job.cancel_requested}
                    onClick={() => void jobTracker.cancel(job.id)}>
                    {job.cancel_requested ? 'キャンセル中…' : '中止'}
                </button>
            )}
        </span>
    );
}

/**
 * 画面下部に表示するステータスバーコンポーネント。
 * `useDaw()` から `status`（操作状況）と `hint`（ヒントテキスト）を取得して表示する。
 * 時間のかかる処理が動いている間は、その小さな表示も出す（`JobIndicator`）。
 *
 * 失敗の知らせ（`statusKind` が `error`）は、色を変えて、読み上げの対象（`role="alert"`）にする。
 * 文が長いときは 1 行に収めて末尾を … にするので、全文は `title` でも読めるようにしてある。
 * @returns ステータスバーの JSX 要素
 */
export default function StatusBar() {
    const { status, statusKind, hint } = useDaw();
    const { active } = useJobs();
    const isError = statusKind === 'error';
    return (
        <div id="status-bar">
            <span id="status-text" className={isError ? 'error' : undefined}
                role={isError ? 'alert' : 'status'} title={status}>{status}</span>
            {active && <JobIndicator job={active} />}
            <span id="hint-text">{hint}</span>
        </div>
    );
}
