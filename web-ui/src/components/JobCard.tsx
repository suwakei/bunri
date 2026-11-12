/**
 * bunri DAW — 時間のかかる処理（ジョブ）の進み具合のカード。
 *
 * 処理を始めたボタンの近くに出す。処理の名前、いまの段階（「段階 2/5」）、進み具合のバー
 * （割合が分かる段階だけ数字で。分からなければ動き続けるバー）、経過時間、中止のボタンを並べる。
 *
 * 始めようとして断られた（ほかの処理が動いていた）ときは、何が動いているかと、そのカードを見るボタンを出す。
 */
import { useEffect, useRef } from 'react';
import { busyMessage, isModelDownload, jobTracker, stageCount, stageText, type Job, type JobSlot } from '../lib/jobs';
import { formatElapsed } from '../lib/time';

interface JobCardProps {
    /** カードを出す場所（ステータスバーからの「カードを見る」で、ここへスクロールする）。 */
    slot: JobSlot;
    /** 動いているジョブ。無ければカードを出さない。 */
    job: Job | null;
    /** 始めようとして断られたときに動いていたジョブ。 */
    busyJob?: Job | null;
    /** 中止を押したとき。 */
    onCancel: () => void;
    /** 断られたときの「実行中の処理を見る」を押したとき。 */
    onShowBusy?: (job: Job) => void;
    /** 待っている間にできることの案内（「待っている間も、カルテは読めます」など）。 */
    hint?: string;
}

/** 進み具合のカード（または、断られたときの知らせ）。どちらも無ければ何も出さない。 */
export default function JobCard({ slot, job, busyJob, onCancel, onShowBusy, hint }: JobCardProps) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => jobTracker.onFocusRequest((target) => {
        if (target !== slot || !ref.current) return;
        // 隠れていたタブを開いた直後に呼ばれることがあるので、描き直しのあとで動かす
        requestAnimationFrame(() => {
            ref.current?.scrollIntoView({ block: 'nearest' });
            ref.current?.focus({ preventScroll: true });
        });
    }), [slot]);

    if (!job) {
        if (!busyJob) return null;
        return (
            <div className="job-busy" role="alert">
                <span>{busyMessage(busyJob)}</span>
                {onShowBusy && (
                    <button type="button" className="link-btn" onClick={() => onShowBusy(busyJob)}>実行中の処理を見る</button>
                )}
            </div>
        );
    }

    const percent = job.progress === null ? null : Math.round(job.progress * 100);
    const count = stageCount(job);
    return (
        <div ref={ref} className="job-card" role="group" aria-label={`${job.title}の進み具合`} tabIndex={-1}
            data-slot={slot}>
            <div className="job-card-title">
                <strong>{job.title}</strong>
                {job.filename && <span className="job-card-file" title={job.filename}>{job.filename}</span>}
            </div>
            <div className="job-card-stage" aria-live="polite">
                <span>{stageText(job)}</span>
                {count && <span className="job-card-count">{count}</span>}
            </div>
            <div className={`job-bar${percent === null ? ' indeterminate' : ''}`} role="progressbar"
                aria-label="進み具合" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? '割合は分かりません' : `${percent}%`}>
                <div className="job-bar-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
            </div>
            {isModelDownload(job) && (
                <p className="job-card-note">
                    初めて使うときだけ、分離に使うモデル（数百 MB）をダウンロードします。回線によっては数分かかります。次からはすぐ始まります。
                </p>
            )}
            <div className="job-card-foot">
                <span className="job-card-elapsed">経過 {formatElapsed(job.elapsed_sec)}{percent !== null ? ` ・ ${percent}%` : ''}</span>
                <button type="button" className="job-cancel" onClick={onCancel} disabled={job.cancel_requested}>
                    {job.cancel_requested ? 'キャンセル中…' : '中止'}
                </button>
            </div>
            {hint && <p className="job-card-note">{hint}</p>}
        </div>
    );
}
