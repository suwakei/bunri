/**
 * bunri DAW — 時間のかかる処理（ジョブ）の始め方・進み具合・中止。
 *
 * 音源分離・パート分離・カルテ・採譜は、API に `?async=1` を付けて始め、`GET /api/jobs/{id}` で
 * 進み具合を聞く（API の約束は docs/jobs.md）。この画面からは、ここを通して使う。
 *
 * - 重い処理は同時に 1 つ。動いている間の開始は API が 409 で断り、何が動いているかを返す
 * - 進み具合は 0.7 秒おきに聞く。画面が隠れている間（別のアプリの裏など）は 3 秒おきにする
 * - 画面を開き直したとき（再読み込み、アプリの起動し直し）は、`GET /api/jobs` で動いているジョブを
 *   見つけて、つなぎ直す（`startDiscovery`。ほかの窓 — ツールの画面 — で始めたジョブもここで見つかる）
 *
 * 進み具合のカードは、処理を始めたボタンの在る場所（置き場所 = `JobSlot`）に出す。どの置き場所で
 * 始めたかは、ジョブの ID ごとに localStorage に覚えておく（開き直したときに、同じ場所へカードを出すため）。
 *
 * 画面の部品からは `lib/useJob.ts` のフックで使う。
 */
import { apiFetch, errorDetail, statusMessage } from './api';
import { readStored, writeStored } from './storage';

/** ジョブの種類（API の `kind`）。 */
export type JobKind = 'separate' | 'deep_separate' | 'decompose' | 'chart' | 'chart_regrid' | 'analyze';

/** ジョブの状態。 */
export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** `GET /api/jobs/{id}` が返す、ジョブの状態（docs/jobs.md「ジョブの状態」）。 */
export interface Job<T = unknown> {
    id: string;
    kind: JobKind;
    /** 処理の名前（例: 「パート分離と採譜」）。そのまま見せてよい */
    title: string;
    /** 対象のファイル名（chart_regrid はカルテの ID） */
    filename: string | null;
    state: JobState;
    /** キャンセルを頼まれたが、まだ止まっていない間 true（止まったあとも true のまま） */
    cancel_requested: boolean;
    /** いまのステージの表示名。そのまま見せてよい。走り始めた直後は null のことがある */
    stage: string | null;
    stage_key: string | null;
    /** 何番目のステージか（0 始まり） */
    stage_index: number | null;
    stage_count: number;
    /** いまのステージの中での進み具合（0〜1）。分からないときは null */
    progress: number | null;
    elapsed_sec: number;
    error: { status: number; detail: string } | null;
    result?: T | null;
}

/**
 * 進み具合のカードを出す場所。処理を始めたボタンの在る場所。
 *
 * - learn-song: 「学ぶ」→「曲とパート」の、曲の取り込み（カルテ）
 * - learn-parts: 同じ段の「パートに分ける」
 * - grid: グリッドの確認・補正（カルテの再計算）
 * - file-analyze: 「ファイル」タブの単音メロディの解析
 * - tools-*: ツールの画面の各タブ
 */
export type JobSlot =
    | 'learn-song' | 'learn-parts' | 'grid' | 'file-analyze'
    | 'tools-separate' | 'tools-decompose';

/** どこで始めたか分からないジョブ（覚え書きが無い）を出す場所。種類から決まるものだけ。 */
const SLOT_BY_KIND: Partial<Record<JobKind, JobSlot>> = {
    chart: 'learn-song',
    chart_regrid: 'grid',
    analyze: 'file-analyze',
    separate: 'tools-separate',
    deep_separate: 'tools-separate',
};

/** 終わったか。 */
export function isFinished(job: Pick<Job, 'state'>): boolean {
    return job.state === 'done' || job.state === 'error' || job.state === 'cancelled';
}

/** ほかのジョブが動いていて始められなかった（409）。`job` が動いているジョブ。 */
export class JobBusyError extends Error {
    job: Job;

    constructor(message: string, job: Job) {
        super(message);
        this.name = 'JobBusyError';
        this.job = job;
    }
}

/** ジョブが失敗で終わった。`message` は利用者に見せる文。 */
export class JobFailedError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'JobFailedError';
        this.status = status;
    }
}

/** ジョブが中止で終わった。 */
export class JobCancelledError extends Error {
    constructor() {
        super('中止しました');
        this.name = 'JobCancelledError';
    }
}

/**
 * 動いているジョブを知らせる文（409 のときに出す）。API の文と同じ組み立て。
 * 例: 「song.wav」のパート分離と採譜を実行中です。終わるか、中止してから始めてください
 */
export function busyMessage(job: Job): string {
    const target = job.filename ? `「${job.filename}」の` : '';
    return `${target}${job.title || 'ほかの処理'}を実行中です。終わるか、中止してから始めてください`;
}

/**
 * 失敗で終わったジョブの、利用者に見せる文。`errorDetail` と同じく、処理の側の失敗 (5xx) には
 * 次にどうすればよいかを添える。
 */
export function jobErrorMessage(job: Job): string {
    const status = job.error?.status ?? 500;
    const detail = (job.error?.detail ?? '').trim();
    if (!detail) return statusMessage(status);
    return status >= 500 ? `${statusMessage(status)}（理由: ${detail}）` : detail;
}

// ---- 画面に出す文 ----

/** 初回のモデルのダウンロードの段階か（表示名で見分ける。docs/jobs.md「対象の処理とステージ」）。 */
export function isModelDownload(job: Pick<Job, 'stage_key' | 'stage'>): boolean {
    return job.stage_key === 'model' && (job.stage ?? '').includes('ダウンロード');
}

/** 段階の 1 行（「テンポと拍を調べています」「順番を待っています…」など）。 */
export function stageText(job: Job): string {
    if (job.cancel_requested) return 'キャンセル中…（区切りのよいところで止まります）';
    if (job.state === 'queued') return '順番を待っています…';
    return job.stage ?? '準備しています…';
}

/** 「段階 2/5」。段階が 1 つだけ、または分からないときは空。 */
export function stageCount(job: Job): string {
    if (job.stage_index === null || job.stage_count <= 1) return '';
    return `段階 ${job.stage_index + 1}/${job.stage_count}`;
}

// ---- どこで始めたかの覚え書き ----

const ORIGIN_KEY = 'bunri-job-origins';
const ORIGIN_LIMIT = 20;

function readOrigins(): [string, JobSlot][] {
    try {
        const parsed = JSON.parse(readStored(ORIGIN_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((e) => Array.isArray(e) && e.length === 2) : [];
    } catch {
        return [];
    }
}

function rememberOrigin(id: string, slot: JobSlot): void {
    const entries = readOrigins().filter(([known]) => known !== id);
    entries.push([id, slot]);
    writeStored(ORIGIN_KEY, JSON.stringify(entries.slice(-ORIGIN_LIMIT)));
}

/** ジョブを出す場所。始めた場所を覚えていればそこ、無ければ種類から（決まらなければ null）。 */
export function slotOf(job: Job): JobSlot | null {
    const known = readOrigins().find(([id]) => id === job.id);
    return known ? known[1] : SLOT_BY_KIND[job.kind] ?? null;
}

// ---- API ----

/** ジョブの状態を聞く。無ければ（記録が消えた）null。 */
export async function fetchJob(id: string): Promise<Job | null> {
    const resp = await apiFetch(`/api/jobs/${encodeURIComponent(id)}`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(await errorDetail(resp));
    return (await resp.json()) as Job;
}

/** 動いているジョブを聞く（結果は入らない）。 */
export async function fetchActiveJob(): Promise<Job | null> {
    const resp = await apiFetch('/api/jobs');
    if (!resp.ok) throw new Error(await errorDetail(resp));
    return ((await resp.json()) as { active: Job | null }).active;
}

// ---- 見張り ----

/** 画面の部品が読む、ジョブの様子。 */
export interface JobsSnapshot {
    /** 動いている（順番待ちを含む）ジョブ。無ければ null */
    active: Job | null;
    /** 置き場所ごとの、動いているジョブ */
    bySlot: Partial<Record<JobSlot, Job>>;
    /** 置き場所ごとの、始めようとして断られたとき（409）に動いていたジョブ */
    busy: Partial<Record<JobSlot, Job>>;
}

/** 聞きに行く間隔（ミリ秒）。テストでは短くする（`configure`）。 */
interface Intervals {
    /** 動いているジョブの進み具合 */
    poll: number;
    /** 画面が隠れている間の進み具合 */
    hiddenPoll: number;
    /** 動いているジョブが無いときに、ほかで始まったジョブを探す */
    discover: number;
    /** 画面が隠れている間に探す */
    hiddenDiscover: number;
}

const DEFAULT_INTERVALS: Intervals = { poll: 700, hiddenPoll: 3000, discover: 3000, hiddenDiscover: 10000 };

const EMPTY: JobsSnapshot = { active: null, bySlot: {}, busy: {} };

/** ジョブを見張り、様子を画面の部品に知らせる（画面に 1 つ）。 */
class JobTracker {
    private snapshot: JobsSnapshot = EMPTY;
    private listeners = new Set<() => void>();
    /** 進み具合を聞いているジョブ */
    private watching: Job | null = null;
    /** 終わるのを待っている呼び出し（`run`） */
    private waiters = new Map<string, ((job: Job) => void)[]>();
    /** この画面で始めたジョブ（結果は `run` の戻り値で受け取る） */
    private owned = new Set<string>();
    /** 置き場所ごとの、つなぎ直したジョブが終わったときの受け手 */
    private endHandlers = new Map<JobSlot, (job: Job) => void>();
    /** 受け手がまだ居ないうちに終わった、つなぎ直したジョブ */
    private pendingEnds = new Map<JobSlot, Job>();
    private discovering = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private ticking = false;
    private intervals: Intervals = DEFAULT_INTERVALS;
    private focusListeners = new Set<(slot: JobSlot) => void>();

    constructor() {
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                // 見えるようになったら、すぐ聞き直す（隠れている間は間隔を空けていたため）
                if (document.visibilityState === 'visible' && (this.watching || this.discovering > 0)) this.schedule(0);
            });
        }
    }

    // ---- 画面の部品から ----

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    getSnapshot = (): JobsSnapshot => this.snapshot;

    /**
     * ジョブを始めて、終わるまで待つ。
     *
     * @param slot - 進み具合のカードを出す場所
     * @param path - 時間のかかる API（`/api/chart` など。`?async=1` はここで付ける）
     * @param body - フォームの中身（待つ呼び方と同じ）
     * @returns ジョブの結果（待つ呼び方の応答の本文と同じ）
     * @throws {JobBusyError} ほかのジョブが動いていた
     * @throws {JobFailedError} 失敗で終わった
     * @throws {JobCancelledError} 中止で終わった
     */
    async run<T>(slot: JobSlot, path: string, body: FormData): Promise<T> {
        const job = await this.start(slot, path, body);
        const final = await this.wait(job.id);
        if (final.state === 'done') return final.result as T;
        if (final.state === 'cancelled') throw new JobCancelledError();
        throw new JobFailedError(jobErrorMessage(final), final.error?.status ?? 500);
    }

    /**
     * ジョブを始める（終わるのは待たない）。
     *
     * @throws {JobBusyError} ほかのジョブが動いていた（その置き場所に、動いているジョブを知らせる）
     */
    async start(slot: JobSlot, path: string, body: FormData): Promise<Job> {
        this.setBusy(slot, null);
        const sep = path.includes('?') ? '&' : '?';
        const resp = await apiFetch(`${path}${sep}async=1`, { method: 'POST', body });
        if (resp.status === 409) {
            let data: { detail?: unknown; code?: unknown; job?: Job } | null = null;
            try { data = await resp.json(); } catch { /* 本文が JSON でない */ }
            if (data?.code === 'job_busy' && data.job) {
                this.setBusy(slot, data.job);
                this.observe(data.job);
                throw new JobBusyError(busyMessage(data.job), data.job);
            }
            throw new Error(typeof data?.detail === 'string' ? data.detail : statusMessage(409));
        }
        if (!resp.ok) throw new Error(await errorDetail(resp));
        const job = (await resp.json()) as Job;
        this.owned.add(job.id);
        rememberOrigin(job.id, slot);
        this.observe(job, slot);
        return job;
    }

    /** ジョブが終わるまで待ち、最後の状態を返す。 */
    wait(id: string): Promise<Job> {
        return new Promise((resolve) => {
            const list = this.waiters.get(id) ?? [];
            list.push(resolve);
            this.waiters.set(id, list);
        });
    }

    /** ジョブの中止を頼む。すぐ止まるとは限らない（止まるまで「キャンセル中」）。 */
    async cancel(id: string): Promise<void> {
        const resp = await apiFetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
        if (resp.status === 404) return;
        if (!resp.ok) throw new Error(await errorDetail(resp));
        const job = (await resp.json()) as Job;
        // 中止の応答には結果が入らないので、終わっていたらもう一度聞いて受け取る
        if (isFinished(job)) this.schedule(0);
        else this.update(job);
    }

    /** 置き場所の「断られた」知らせを消す（または出す）。 */
    setBusy(slot: JobSlot, job: Job | null): void {
        const busy = { ...this.snapshot.busy };
        if (job) busy[slot] = job;
        else if (busy[slot]) delete busy[slot];
        else return;
        this.publish({ ...this.snapshot, busy });
    }

    /**
     * つなぎ直したジョブ（この画面で始めていないジョブ。開き直す前に始めたものなど）が
     * 終わったときの受け手を登録する。受け手が居ないうちに終わっていたら、登録したときに渡す。
     *
     * @returns 登録を外す関数
     */
    onAttachedEnd(slot: JobSlot, handler: (job: Job) => void): () => void {
        this.endHandlers.set(slot, handler);
        const pending = this.pendingEnds.get(slot);
        if (pending) {
            this.pendingEnds.delete(slot);
            handler(pending);
        }
        return () => { if (this.endHandlers.get(slot) === handler) this.endHandlers.delete(slot); };
    }

    /** 置き場所のカードを見せてほしいと頼む（ステータスバーや「実行中の処理を見る」から）。 */
    requestFocus(slot: JobSlot): void {
        for (const listener of this.focusListeners) listener(slot);
    }

    /** カードを見せてほしいという頼みを受け取る。 */
    onFocusRequest(listener: (slot: JobSlot) => void): () => void {
        this.focusListeners.add(listener);
        return () => { this.focusListeners.delete(listener); };
    }

    /**
     * ほかで始まったジョブを探し始める（画面を開いたときに 1 回呼ぶ）。
     * 開き直す前に始めたジョブや、ツールの画面（別の窓）で始めたジョブにつなぎ直す。
     *
     * @returns 探すのをやめる関数
     */
    startDiscovery(): () => void {
        this.discovering += 1;
        this.schedule(0);
        return () => { this.discovering = Math.max(0, this.discovering - 1); };
    }

    /**
     * 処理を担当する部分（API サーバ）が起動し直されたときに呼ぶ。ジョブの記録は消えているので、
     * 見張っていたジョブは失敗として終わらせる。
     */
    serverRestarted(): void {
        const job = this.watching;
        if (job) {
            this.update({
                ...job, state: 'error',
                error: { status: 503, detail: '処理を担当する部分が起動し直されたため、処理は止まりました。もう一度実行してください' },
            });
        }
        this.publish({ ...this.snapshot, busy: {} });
        if (this.discovering > 0) this.schedule(0);
    }

    /** テスト用: 聞きに行く間隔を変える。 */
    configure(intervals: Partial<Intervals>): void {
        this.intervals = { ...this.intervals, ...intervals };
    }

    /** テスト用: 初めの状態に戻す。 */
    resetForTest(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.snapshot = EMPTY;
        this.watching = null;
        this.waiters.clear();
        this.owned.clear();
        this.endHandlers.clear();
        this.pendingEnds.clear();
        this.discovering = 0;
        this.ticking = false;
        this.intervals = DEFAULT_INTERVALS;
        this.focusListeners.clear();
    }

    // ---- 中身 ----

    private publish(next: JobsSnapshot): void {
        this.snapshot = next;
        for (const listener of this.listeners) listener();
    }

    private hidden(): boolean {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    /** 動いているジョブとして見張り始める（すでに見張っていれば、状態だけ新しくする）。 */
    private observe(job: Job, slot?: JobSlot): void {
        if (isFinished(job)) return;
        if (!this.watching || this.watching.id !== job.id || slot) {
            const where = slot ?? slotOf(job);
            const bySlot: Partial<Record<JobSlot, Job>> = {};
            if (where) bySlot[where] = job;
            this.watching = job;
            this.publish({ ...this.snapshot, active: job, bySlot });
            this.schedule(this.intervals.poll);
            return;
        }
        this.update(job);
    }

    /** 見張っているジョブの新しい状態を受け取る。 */
    private update(job: Job): void {
        if (!this.watching || this.watching.id !== job.id) {
            if (!isFinished(job)) this.observe(job);
            return;
        }
        if (!isFinished(job)) {
            this.watching = job;
            const bySlot: Partial<Record<JobSlot, Job>> = {};
            for (const key of Object.keys(this.snapshot.bySlot) as JobSlot[]) bySlot[key] = job;
            const busy = { ...this.snapshot.busy };
            for (const key of Object.keys(busy) as JobSlot[]) if (busy[key]?.id === job.id) busy[key] = job;
            this.publish({ active: job, bySlot, busy });
            return;
        }
        // 終わった
        this.watching = null;
        const busy = { ...this.snapshot.busy };
        for (const key of Object.keys(busy) as JobSlot[]) if (busy[key]?.id === job.id) delete busy[key];
        const slot = (Object.keys(this.snapshot.bySlot)[0] as JobSlot | undefined) ?? slotOf(job);
        this.publish({ active: null, bySlot: {}, busy });

        const waiters = this.waiters.get(job.id) ?? [];
        this.waiters.delete(job.id);
        for (const resolve of waiters) resolve(job);
        if (!this.owned.has(job.id) && slot) {
            const handler = this.endHandlers.get(slot);
            if (handler) handler(job);
            else this.pendingEnds.set(slot, job);
        }
        this.owned.delete(job.id);
        // 順番待ちの次のジョブ（待つ呼び方で始めたもの）が在るかもしれないので、すぐ探す
        if (this.discovering > 0) this.schedule(300);
    }

    private schedule(ms: number): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, ms);
    }

    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const watching = this.watching;
            if (watching) {
                try {
                    const job = await fetchJob(watching.id);
                    if (job === null) {
                        // 記録が消えた（API サーバが起動し直された、など）
                        this.update({
                            ...watching, state: 'error',
                            error: { status: 404, detail: '処理の記録が見つかりませんでした。もう一度実行してください' },
                        });
                    } else {
                        this.update(job);
                    }
                } catch {
                    // つながらない。止まったかどうかの判断は見張り（lib/health.ts）に任せ、聞き続ける
                }
            } else if (this.discovering > 0) {
                try {
                    const active = await fetchActiveJob();
                    if (active && !isFinished(active)) this.observe(active);
                } catch {
                    // つながらない。次の回にまた探す
                }
            }
        } finally {
            this.ticking = false;
        }
        if (this.timer) return;
        if (this.watching) this.schedule(this.hidden() ? this.intervals.hiddenPoll : this.intervals.poll);
        else if (this.discovering > 0) this.schedule(this.hidden() ? this.intervals.hiddenDiscover : this.intervals.discover);
    }
}

/** 画面に 1 つの、ジョブの見張り。 */
export const jobTracker = new JobTracker();
