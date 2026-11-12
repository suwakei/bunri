/**
 * bunri DAW — 時間のかかる処理（ジョブ）を画面の部品から使うフック。
 *
 * 見張りの本体は `lib/jobs.ts` の `jobTracker`（画面に 1 つ）。ここは、それを React の部品から読むだけ。
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { jobTracker, type Job, type JobSlot, type JobsSnapshot } from './jobs';

/** ジョブの様子（動いているジョブ、置き場所ごとのジョブ）を読む。変わると描き直す。 */
export function useJobs(): JobsSnapshot {
    return useSyncExternalStore(jobTracker.subscribe, jobTracker.getSnapshot, jobTracker.getSnapshot);
}

/** `useJob` の戻り値。 */
export interface JobHandle {
    /** この置き場所で動いているジョブ（開き直す前に始めたものを含む）。無ければ null */
    job: Job | null;
    /** 始めようとして断られたとき（409）に動いていたジョブ。そのジョブが終わると消える */
    busyJob: Job | null;
    /** どこかで重い処理が動いているか。処理を始めるボタンは、この間押せなくする（同時に 1 つ） */
    heavyBusy: boolean;
    /** どこかで動いているジョブ */
    active: Job | null;
    /** この置き場所でジョブを始め、終わるまで待つ（`jobTracker.run`） */
    run: <T>(path: string, body: FormData) => Promise<T>;
    /** ジョブ（既定は、この置き場所のジョブ）の中止を頼む */
    cancel: (job?: Job | null) => Promise<void>;
}

/**
 * 1 つの置き場所（処理を始めるボタンの在る場所）のジョブを扱う。
 *
 * @param slot - 置き場所
 * @param onAttachedEnd - つなぎ直したジョブ（この画面で始めていないもの。開き直す前に始めたジョブなど）が
 *   終わったときに呼ばれる。この画面で始めたジョブの結果は `run` の戻り値で受け取るので、ここには来ない
 */
export function useJob(slot: JobSlot, onAttachedEnd?: (job: Job) => void): JobHandle {
    const snapshot = useJobs();
    const handler = useRef(onAttachedEnd);
    useEffect(() => { handler.current = onAttachedEnd; });
    // 受け手は置き場所ごとに 1 つ。受け手を渡さない部品（同じ置き場所のボタンだけを持つもの）は登録しない
    const hasHandler = onAttachedEnd !== undefined;
    useEffect(() => (hasHandler ? jobTracker.onAttachedEnd(slot, (job) => handler.current?.(job)) : undefined),
        [slot, hasHandler]);

    const job = snapshot.bySlot[slot] ?? null;
    const run = useCallback(<T,>(path: string, body: FormData) => jobTracker.run<T>(slot, path, body), [slot]);
    const cancel = useCallback(async (target?: Job | null) => {
        const id = (target ?? job)?.id;
        if (id) await jobTracker.cancel(id);
    }, [job]);
    return {
        job,
        busyJob: snapshot.busy[slot] ?? null,
        heavyBusy: snapshot.active !== null,
        active: snapshot.active,
        run,
        cancel,
    };
}
