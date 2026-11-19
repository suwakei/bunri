/**
 * bunri DAW — 自動保存と、落ちたときの復旧。
 *
 * 保存していない変更が在るあいだ、変更が落ち着いてから、いまのプロジェクトを「復旧用の写し」として残す。
 * アプリや処理を担当する部分が落ちても、次の起動で「続きを開きますか」と尋ねて、そこから続けられる。
 *
 * - **利用者のファイルは、自動では書き換えない。** 書くのは、データ置き場の中の復旧用の写し（`recovery/`）だけ。
 *   置き場と目印は処理を担当する部分が持つ（backend/project_store.py「落ちたときの復旧」）
 * - 自動保存は、保存済みの印（`markSaved`）にも、いま開いているプロジェクトの情報（`project`）にも触らない。
 *   題名の「●」は、利用者が保存するまで消えない。元に戻す履歴にも載らない
 * - 復旧用の写しが在るのは「保存していない変更が在るあいだ」だけ。保存できた・元に戻して保存したときと同じに
 *   なった・保存しないと決めて別のプロジェクトを開いた（新しくした・窓を閉じた）ときは消す（次の起動で尋ねない）
 * - 利用者の保存・開く操作とは、同時に走らせない（`hold`）。途中の自動保存はそこでやめて、
 *   利用者の操作を先に通す
 * - 再生中は、書かずに少し後でもう一度試す（音の途切れを避ける）。ただし、止めるまで何も残らないのは困る
 *   （練習画面で区間ループを回しながら打ち込むのが、いちばん長い使い方）ので、まだ書いていない最初の変更から
 *   5 分経ったら、再生中でも書く。MIDI のリアルタイム録音で弾いている最中は、弾く手が止まった合間を待ち、
 *   それでも 10 分経ったら書く
 * - ドラッグの途中・時間のかかる処理の最中・処理を担当する部分に届かないあいだは、書かない
 *   （どの状況かは、画面の側が `busy` で答える。どれだけ待つかは、ここで決める）
 * - ステータスバーには何も出さない。失敗が続いたときだけ、1 度知らせる
 * - 捨てる（保存しないと決めた・窓を閉じる）ときは、書き途中を待たずに世代を進めて消す。書き途中だった自動保存は、
 *   置く前に世代を確かめてやめ、置く要求が消したあとに届いても、処理を担当する部分が古い世代として断る
 * - 起動したときに前回の写しが在るかを確かめられなかった（失敗の応答が続いた）・問いに答えが出なかったときは、
 *   前回の写しを上書きしないよう、その回は書かない（変更が在れば、保存してもらうよう 1 度だけ知らせる）
 *
 * 画面とのつなぎ（何を書くか・いつ変わったか・起動したときに尋ねる窓）は lib/project-actions.ts。
 *
 * ## テストから間隔を変える
 *
 * ブラウザの保存領域の `bunri-autosave` に、`off`（自動保存をしない）か、`{"idleMs": 300, "maxWaitMs": 2000}` の
 * ような JSON（ほかに `retryMs` `playingMaxWaitMs` `recordingMaxWaitMs`）を入れると、間隔が変わる（ブラウザのテストが `e2e/helpers.ts` の `openDaw` で入れる）。
 * 単体テストは `autosave.configure()` を使う。
 */
import { apiFetch, describeError, errorDetail } from './api';
import { projectsEqual } from './project-snapshot';
import { readStored } from './storage';
import type { SavedBaseline } from './store';

/** 最後の変更から、これだけ変更が無ければ書く（ミリ秒）。 */
export const AUTOSAVE_IDLE_MS = 30_000;
/** 変更が続いていても、まだ書いていない最初の変更からこれだけ経ったら書く（ミリ秒）。 */
export const AUTOSAVE_MAX_WAIT_MS = 120_000;
/**
 * 再生中でも、まだ書いていない最初の変更からこれだけ経ったら書く（ミリ秒）。
 * 練習画面で区間ループを回し続けているあいだも、これより長くは溜めない。
 */
export const AUTOSAVE_PLAYING_MAX_WAIT_MS = 300_000;
/**
 * MIDI のリアルタイム録音で弾いている最中でも、まだ書いていない最初の変更からこれだけ経ったら書く（ミリ秒）。
 * ふつうは、弾く手が止まった合間（再生中の扱い）に書けるので、ここまで待つのは、弾き続けているときだけ。
 */
export const AUTOSAVE_RECORDING_MAX_WAIT_MS = 600_000;
/** いまは書かない状況（再生中・保存中など）だったときに、もう一度試すまでの間（ミリ秒）。 */
export const AUTOSAVE_RETRY_MS = 5_000;
/** 続けてこの回数失敗したら、1 度だけ知らせる。 */
export const AUTOSAVE_FAILURES_BEFORE_NOTICE = 3;
/** 起動したときの確かめが届かなかったときに、もう一度確かめるまでの間（ミリ秒）。 */
export const RECOVERY_CHECK_RETRY_MS = 3_000;
/** 届かないままのときに、確かめる間を空けていく上限（ミリ秒）。 */
export const RECOVERY_CHECK_RETRY_MAX_MS = 30_000;
/** 起動したときの確かめに、失敗の応答が続いたら諦める回数（届かないあいだは、数えずに待つ）。 */
export const RECOVERY_CHECK_TRIES = 5;
/** 間隔を変える設定の置き場（ブラウザの保存領域。テスト用）。 */
export const AUTOSAVE_SETTING_KEY = 'bunri-autosave';
/** 前回の写しを守っていて、この回は自動保存をしないときに知らせる理由。 */
export const PRESERVING_REASON = '前回の続きが残っているかを確かめられなかったので、前回の続きを上書きしないよう、今回は自動保存を止めています';

/** 復旧用の写しの目印（backend/project_store.py の `recovery_info`）。 */
export interface RecoveryInfo {
    /** プロジェクトの名前（まだ無ければ null） */
    name: string | null;
    /** デスクトップ版の、利用者のファイルの場所（まだ保存していなければ null） */
    path: string | null;
    /** 開発用のブラウザ起動の、projects/ の中の名前 */
    file: string | null;
    /** 書いた時刻（UNIX 秒） */
    saved_at: number;
    size_bytes: number;
}

/** 復旧用の写しにする、作業用の写しと、その目印に入れるもの。 */
export interface RecoveryCopy {
    /** 作業用の写しの名前（`/api/project/document` が返したもの） */
    token: string;
    name: string | null;
    path: string | null;
    file: string | null;
}

/**
 * いまは書かないほうがよい状況。
 * - `playing`: 再生中。`AUTOSAVE_PLAYING_MAX_WAIT_MS` を過ぎたら書く
 * - `recording`: MIDI のリアルタイム録音で弾いている最中（録音前のカウントを含む）。`AUTOSAVE_RECORDING_MAX_WAIT_MS` を過ぎたら書く
 * - `blocked`: ドラッグの途中・時間のかかる処理の最中・処理を担当する部分に届かない。どれだけ経っても書かない
 */
export type AutosaveBusy = 'playing' | 'recording' | 'blocked';

/** 自動保存が、画面に聞くこと・頼むこと。 */
export interface AutosaveHost {
    /** 保存していない変更が在るか */
    isDirty: () => boolean;
    /** いまは書かないほうがよい状況（無ければ null） */
    busy: () => AutosaveBusy | null;
    /** いまの状態の控え（前に書いたときと同じなら、書かない） */
    capture: () => SavedBaseline;
    /**
     * いまのプロジェクトの文書と音声を送り、作業用の写しに書く。
     * @param cancelled - やめるよう言われたか（区切りごとに確かめる）
     * @returns 書いた写し。途中でやめたら null
     */
    writeCopy: (cancelled: () => boolean) => Promise<RecoveryCopy | null>;
    /** 失敗が続いたとき（1 度だけ呼ぶ） */
    onFailing: (reason: string) => void;
}

/** 間隔（ミリ秒）と回数。 */
interface Settings {
    idle: number;
    maxWait: number;
    /** 再生中でも書くまでの上限 */
    playingMaxWait: number;
    /** リアルタイム録音で弾いている最中でも書くまでの上限 */
    recordingMaxWait: number;
    retry: number;
    failuresBeforeNotice: number;
    startupRetry: number;
}

const DEFAULT_SETTINGS: Settings = {
    idle: AUTOSAVE_IDLE_MS, maxWait: AUTOSAVE_MAX_WAIT_MS, retry: AUTOSAVE_RETRY_MS,
    playingMaxWait: AUTOSAVE_PLAYING_MAX_WAIT_MS, recordingMaxWait: AUTOSAVE_RECORDING_MAX_WAIT_MS,
    failuresBeforeNotice: AUTOSAVE_FAILURES_BEFORE_NOTICE, startupRetry: RECOVERY_CHECK_RETRY_MS,
};

/** 控えが同じか（同じなら、前に書いた復旧用の写しのままでよい）。 */
export function sameBaseline(a: SavedBaseline, b: SavedBaseline): boolean {
    return a.chartId === b.chartId && a.history === b.history && a.touch === b.touch && projectsEqual(a.snapshot, b.snapshot);
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * 自動保存の書き手の目印（backend/project_store.py の `recovery_put` / `recovery_clear`）。
 * 捨てたあとに届いた、書き途中だった自動保存を、処理を担当する部分が古い世代として断るのに使う。
 */
interface RecoveryWriter {
    /** 画面ごとの名前（開くたびに作る） */
    session: string;
    /** 世代（捨てる・止めるたびに進む `epoch`） */
    generation: number;
}

/** 画面ごとの名前を作る。 */
function newSession(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
}

/** 作業用の写しを、復旧用の写しにしてもらう。 */
async function putRecovery(copy: RecoveryCopy, writer: RecoveryWriter): Promise<void> {
    const resp = await apiFetch('/api/project/recovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...copy, writer }),
    });
    if (!resp.ok) throw new Error(await errorDetail(resp));
}

/**
 * 復旧用の写しを、新しい作業用の写しにしてもらう（あとは `/api/project/open/{token}` で開く）。
 * 復旧用の写しは残る（保存するか、捨てると決めるまで）。
 */
export async function openRecoveryCopy(): Promise<RecoveryCopy> {
    const resp = await apiFetch('/api/project/recovery/open', { method: 'POST' });
    if (!resp.ok) throw new Error(await errorDetail(resp));
    return (await resp.json()) as RecoveryCopy;
}

/** 自動保存（画面に 1 つ）。 */
class Autosaver {
    private host: AutosaveHost | null = null;
    private settings: Settings = DEFAULT_SETTINGS;
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** まだ書いていない変更のうち、いちばん古いものの時刻 */
    private pendingSince: number | null = null;
    /** 変更を知らされるたびに進める番号（書いている途中の変更を見分ける） */
    private changes = 0;
    /** 書いている途中の自動保存 */
    private running: Promise<void> | null = null;
    /** 進めると、書いている途中の自動保存は次の区切りでやめる（処理を担当する部分にも、世代として送る） */
    private epoch = 0;
    /** 画面ごとの名前（世代と組で、処理を担当する部分に送る） */
    private session = newSession();
    /** 捨てた回数（書いている途中に捨てられたかを見分ける） */
    private discards = 0;
    /**
     * 前回の写しを守っている（起動したときに尋ねられなかった）。この回は書かない・消さない。
     * 失敗が続いて確かめられなかった、または問いに答えが出ないまま終わったとき
     */
    private preserving = false;
    /** 窓を閉じると決めた。もう書かない */
    private closed = false;
    /** 止めている数（利用者の保存・開く操作の最中） */
    private holds = 0;
    /** 起動したときの確かめ（前回の復旧用の写しが在るか）。画面を開き直すまで 1 回だけ */
    private startup: Promise<RecoveryInfo | null> | null = null;
    /** 起動したときの問いに答えが出たか。出るまでは書かない・消さない（前回の復旧用の写しを失わないため） */
    private startupDone = false;
    /** 起動したときの問いを、もう出したか */
    private offered = false;
    /** 最後に書いた復旧用の写しの名前（音声を写してくる元にする）と、そのときの控え */
    private lastToken: string | null = null;
    private lastBaseline: SavedBaseline | null = null;
    /** 復旧用の写しが、置き場に在るかもしれない */
    private mayExist = false;
    /** 復旧用の写しを消している途中（終わるまで、次の自動保存を始めない。消すのと置くのが前後しないように） */
    private clearing: Promise<void> | null = null;
    private failures = 0;
    private noticed = false;

    // ---- 画面から ----

    /**
     * 画面とつなぐ（DAW の画面に 1 つ）。
     * @returns 外す関数
     */
    attach(host: AutosaveHost): () => void {
        this.host = host;
        return () => {
            if (this.host !== host) return;
            this.host = null;
            this.clearTimer();
        };
    }

    /** 保存に入る中身が変わった（保存していない変更が在る）。落ち着くのを待って書く。 */
    touched(): void {
        const settings = this.effective();
        if (!settings) return;
        const now = Date.now();
        this.changes += 1;
        if (this.pendingSince === null) this.pendingSince = now;
        this.arm(Math.max(0, Math.min(now + settings.idle, this.pendingSince + settings.maxWait) - now));
    }

    /** 保存していない変更が無くなった（保存した・元に戻して保存したときと同じになった・開いた・新しくした）。 */
    async settled(): Promise<void> {
        this.clearTimer();
        this.pendingSince = null;
        await this.discard();
    }

    /**
     * 自動保存を止める（利用者の保存・開く操作の前に呼ぶ）。途中の自動保存はやめさせ、止まるのを待つ。
     * @returns 止めるのをやめる関数（操作が終わったら、成功でも失敗でも呼ぶ）
     */
    async hold(): Promise<() => void> {
        this.holds += 1;
        this.epoch += 1;
        await this.running;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.holds -= 1;
        };
    }

    /**
     * 保存のときに、音声を写してくる元にする写し。自動保存で送った音声を、もう一度送らずに済ませる。
     * @param projectToken - いま開いているプロジェクトの作業用の写し
     */
    baseFor(projectToken: string | null): string | null {
        return this.lastToken ?? projectToken;
    }

    /**
     * 復旧用の写しを消す（保存できた・保存しないと決めた）。
     * 起動したときの問いに答えが出る前・前回の写しを守っているあいだは、何もしない（前回の復旧用の写しを、尋ねる前に消さない）。
     *
     * 書いている途中の自動保存は待たない（大きな音声を送っている途中だと、窓を閉じるのを長く待たせてしまう）。
     * 世代を進めてすぐ消す。途中の自動保存は、置く前に世代を確かめてやめる。置く要求がこのあとに届いても、
     * 処理を担当する部分が古い世代として断る（消した写しを、置き直させない）。
     */
    async discard(): Promise<void> {
        if (!this.startupDone || this.preserving) return;
        this.epoch += 1;
        this.discards += 1;
        this.lastToken = null;
        this.lastBaseline = null;
        this.failures = 0;
        if (!this.mayExist) return;
        // 消している途中にもう一度頼まれたら、同じ 1 回を待つ
        this.clearing ??= this.remove();
        await this.clearing;
    }

    /**
     * 窓を閉じると決めた（保存した・保存しないと決めた）。もう書かず、復旧用の写しを消す（`discard`）。
     * 閉じられなかったときは `closeAborted` で戻す。
     */
    async closing(): Promise<void> {
        this.closed = true;
        this.clearTimer();
        await this.discard();
    }

    /** 窓を閉じられなかった。自動保存を続ける。 */
    closeAborted(): void {
        this.closed = false;
    }

    // ---- 起動したとき ----

    /**
     * 前回の復旧用の写しが在るかを確かめる。処理を担当する部分に届かないあいだは、届くまで待つ。
     * 画面を開き直すまで 1 回だけ確かめ、同じ結果を返す。
     */
    checkStartup(): Promise<RecoveryInfo | null> {
        this.startup ??= this.lookForRecovery();
        return this.startup;
    }

    /** 起動したときの問いを出してよいか（1 回だけ true）。 */
    claimOffer(): boolean {
        if (this.offered) return false;
        this.offered = true;
        return true;
    }

    /**
     * 起動したときの問いに答えが出た（続きを開いた・捨てると決めた）。ここから、自動保存を始める。
     * @param keep - 復旧用の写しを残したか（続きを開いた。保存するまで残す）
     */
    async startupAnswered(keep: boolean): Promise<void> {
        this.startupDone = true;
        if (!keep) await this.discard();
    }

    /**
     * 起動したときの問いに、答えが出ないまま終わった。前回の写しは残したまま、この回は書かない
     * （置き場は 1 つなので、書くと前回の写しを上書きしてしまう）。変更が在れば、1 度だけ知らせる。
     */
    startupUnanswered(): void {
        this.preserving = true;
        this.startupDone = true;
    }

    // ---- テスト用 ----

    /** テスト用: 間隔と回数を変える。 */
    configure(settings: Partial<Settings>): void {
        this.settings = { ...this.settings, ...settings };
    }

    /** テスト用: 初めの状態に戻す。 */
    resetForTest(): void {
        this.clearTimer();
        this.host = null;
        this.settings = DEFAULT_SETTINGS;
        this.pendingSince = null;
        this.changes = 0;
        this.running = null;
        this.epoch += 1;
        this.session = newSession();
        this.discards = 0;
        this.preserving = false;
        this.closed = false;
        this.holds = 0;
        this.startup = null;
        this.startupDone = false;
        this.offered = false;
        this.lastToken = null;
        this.lastBaseline = null;
        this.mayExist = false;
        this.clearing = null;
        this.failures = 0;
        this.noticed = false;
    }

    // ---- 中 ----

    /** いまの間隔。自動保存をしない設定なら null。 */
    private effective(): Settings | null {
        const stored = readStored(AUTOSAVE_SETTING_KEY);
        if (stored === null || stored === '') return this.settings;
        if (stored === 'off') return null;
        try {
            const value = JSON.parse(stored) as {
                idleMs?: unknown; maxWaitMs?: unknown; retryMs?: unknown; playingMaxWaitMs?: unknown; recordingMaxWaitMs?: unknown;
            };
            return {
                ...this.settings,
                ...(positive(value.idleMs) ? { idle: value.idleMs } : {}),
                ...(positive(value.maxWaitMs) ? { maxWait: value.maxWaitMs } : {}),
                ...(positive(value.retryMs) ? { retry: value.retryMs } : {}),
                ...(positive(value.playingMaxWaitMs) ? { playingMaxWait: value.playingMaxWaitMs } : {}),
                ...(positive(value.recordingMaxWaitMs) ? { recordingMaxWait: value.recordingMaxWaitMs } : {}),
            };
        } catch {
            return this.settings;
        }
    }

    /** 置き場の復旧用の写しを消してもらう。 */
    private async remove(): Promise<void> {
        try {
            // いまの世代を送る。これより前の世代の自動保存 (書き途中だったもの) が、このあとに届いても断ってもらう
            const writer: RecoveryWriter = { session: this.session, generation: this.epoch };
            const resp = await apiFetch('/api/project/recovery', {
                method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writer }),
            });
            if (resp.ok) this.mayExist = false;
        } catch (e) {
            // 消せなくても操作は続ける (次の起動で、要らない続きを尋ねることになるだけ)
            console.warn('復旧用の写しを消せませんでした:', e);
        } finally {
            this.clearing = null;
        }
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private arm(ms: number): void {
        this.clearTimer();
        this.timer = setTimeout(() => { this.timer = null; void this.attempt(); }, ms);
    }

    private async lookForRecovery(): Promise<RecoveryInfo | null> {
        let wait = this.settings.startupRetry;
        for (let refused = 0; refused < RECOVERY_CHECK_TRIES;) {
            try {
                const resp = await apiFetch('/api/project/recovery');
                if (resp.ok) {
                    const found = ((await resp.json()) as { recovery?: RecoveryInfo | null }).recovery ?? null;
                    if (found) this.mayExist = true;
                    else this.startupDone = true;
                    return found;
                }
                refused += 1;
            } catch {
                // 届かない: 処理を担当する部分が応えるようになるまで待つ (知らせは lib/health.ts が出す)
            }
            await new Promise((resolve) => setTimeout(resolve, wait));
            // 止まったままのあいだ、動きの記録を確かめの行で埋めないよう、間を空けていく
            wait = Math.min(wait * 2, RECOVERY_CHECK_RETRY_MAX_MS);
        }
        // 確かめられなかった。前回の写しが残っているかもしれないので、この回は書かない (尋ねずに上書きしない)。
        // 変更が在れば、1 度だけ知らせる (attempt)
        console.warn('前回の続きが残っているかを確かめられませんでした');
        this.startupUnanswered();
        return null;
    }

    /** 書いてよければ、いまのプロジェクトを復旧用の写しにする。 */
    private async attempt(): Promise<void> {
        const host = this.host;
        const settings = this.effective();
        if (!host || !settings || this.closed) return;
        if (!host.isDirty()) { this.pendingSince = null; return; }
        if (this.running || this.clearing || this.holds > 0 || !this.startupDone) { this.arm(settings.retry); return; }
        if (this.preserving) {
            // 前回の写しを守っている。書かずに、保存してもらうよう 1 度だけ知らせる
            this.pendingSince = null;
            if (!this.noticed) {
                this.noticed = true;
                host.onFailing(PRESERVING_REASON);
            }
            return;
        }
        if (this.pendingSince === null) this.pendingSince = Date.now();
        const busy = host.busy();
        if (busy) {
            // 再生中・録音中は、まだ書いていない最初の変更から決めた時間が過ぎるまで待つ。それ以外は、いつまでも待つ
            const limit = busy === 'playing' ? settings.playingMaxWait : busy === 'recording' ? settings.recordingMaxWait : Infinity;
            if (Date.now() - this.pendingSince < limit) { this.arm(settings.retry); return; }
        }
        const baseline = host.capture();
        // 中身は前に書いたときのまま (再生しただけ、など)
        if (this.lastBaseline && sameBaseline(baseline, this.lastBaseline)) { this.pendingSince = null; return; }

        const epoch = this.epoch;
        const discards = this.discards;
        const cancelled = () => epoch !== this.epoch;
        const changes = this.changes;
        this.running = (async () => {
            try {
                const copy = await host.writeCopy(cancelled);
                // 置く直前に、世代を確かめる (捨てると決めたあとに、消した写しを置き直さない)
                if (copy === null || cancelled()) {
                    // 途中でやめた (利用者の保存が始まった、など)。まだ変更が残っていれば、あとで書き直す
                    this.arm(settings.retry);
                    return;
                }
                // ここから先は、置き場に写しが在るかもしれない (途中でやめても、消すときに消せるように)
                this.mayExist = true;
                await putRecovery(copy, { session: this.session, generation: epoch });
                // 送っているあいだに捨てると決めた。置けていても消す要求が後から通るので、この写しは覚えない
                if (this.discards !== discards) return;
                // 書けた。途中でやめるよう言われていても (利用者の保存が始まった)、置き場の写しはこれになっている
                // (利用者の保存が、ここに在る音声を送り直さずに済む)
                this.lastToken = copy.token;
                this.lastBaseline = baseline;
                this.failures = 0;
                this.noticed = false;
                // 書いている途中に変わっていたら、そのぶんはまだ書いていない (次の回は、もう仕掛けてある)
                this.pendingSince = this.changes === changes ? null : Date.now();
            } catch (e) {
                if (cancelled()) return;
                console.warn('自動保存に失敗しました:', e);
                this.failures += 1;
                if (this.failures >= settings.failuresBeforeNotice && !this.noticed) {
                    this.noticed = true;
                    host.onFailing(describeError(e));
                }
                this.arm(settings.idle);
            }
        })();
        try {
            await this.running;
        } finally {
            this.running = null;
        }
    }
}

/** 画面に 1 つの自動保存。 */
export const autosave = new Autosaver();
