/**
 * bunri DAW — 処理を担当する部分（API サーバ。デスクトップ版では Python sidecar）の見張り。
 *
 * 起動したあとに sidecar が落ちると、画面の操作は黙って失敗し続ける。そこで、起動したあとも数秒おきに
 * 軽い問い合わせ（`GET /api/health`）をして、応答が無くなったら知らせる（components/HealthBanner.tsx）。
 * API の呼び出しが届かなかったとき（`apiFetch` の失敗）は、次の回を待たずにすぐ確かめる。
 *
 * - デスクトップ版: Rust に起動の様子（`boot_status`）も聞く。止まっていれば「再起動」で Rust に
 *   起動し直してもらい、新しいポートとトークンに差し替える（`restartBackend`）。ほかの窓（ツールの画面）が
 *   起動し直していたら、新しい接続情報を受け取り直すだけにする（2 回起動し直さない）
 * - 開発用のブラウザ起動: 画面からは起動し直せないので、起動し直し方を案内する。戻れば知らせは消える
 */
import {
    apiFetch, backendStatus, describeError, isDesktop, refreshBackend, restartBackend, setNetworkErrorListener,
} from './api';
import { jobTracker } from './jobs';

/** 見張りの状態。 */
export type HealthState =
    | { kind: 'ok' }
    | { kind: 'down'; detail: string | null }
    | { kind: 'restarting' }
    | { kind: 'restart-failed'; message: string };

/** 確かめる間隔（ミリ秒）。 */
interface Intervals {
    /** 応答しているとき */
    ok: number;
    /** 止まっているとき（戻ったことに早く気づくため、短くする） */
    down: number;
    /** 画面が隠れている間 */
    hidden: number;
    /** 1 回の問い合わせを待つ上限 */
    timeout: number;
    /** 応答が無かったときに、もう 1 回だけ確かめるまでの間（一瞬の取りこぼしで知らせないため） */
    retry: number;
}

const DEFAULT_INTERVALS: Intervals = { ok: 5000, down: 3000, hidden: 15000, timeout: 4000, retry: 800 };

const OK: HealthState = { kind: 'ok' };

/** 見張り（画面に 1 つ）。 */
class HealthMonitor {
    private state: HealthState = OK;
    private listeners = new Set<() => void>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private checking = false;
    private intervals: Intervals = DEFAULT_INTERVALS;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    getState = (): HealthState => this.state;

    /**
     * 見張りを始める（起動が済んで、画面を描いたあとに 1 回呼ぶ）。
     *
     * @returns やめる関数
     */
    start(): () => void {
        if (this.running) return () => this.stop();
        this.running = true;
        setNetworkErrorListener(() => this.checkSoon());
        this.schedule(this.intervals.ok);
        return () => this.stop();
    }

    /** 次の回を待たずに確かめる（API に届かなかったとき・「もう一度確かめる」）。 */
    checkSoon(): void {
        if (!this.running || this.checking || this.state.kind === 'restarting') return;
        this.schedule(0);
    }

    /**
     * 処理を担当する部分を起動し直す（デスクトップ版のみ）。ポートとトークンは新しくなる。
     * 動いていたジョブは消えるので、ジョブの見張りにも知らせる。
     */
    async restart(): Promise<void> {
        if (this.state.kind === 'restarting') return;
        this.set({ kind: 'restarting' });
        try {
            await restartBackend();
            jobTracker.serverRestarted();
            this.set(OK);
        } catch (e) {
            this.set({ kind: 'restart-failed', message: describeError(e) });
        }
        this.schedule(this.intervals.ok);
    }

    /** テスト用: 間隔を変える。 */
    configure(intervals: Partial<Intervals>): void {
        this.intervals = { ...this.intervals, ...intervals };
    }

    /** テスト用: 初めの状態に戻す。 */
    resetForTest(): void {
        this.stop();
        this.state = OK;
        this.intervals = DEFAULT_INTERVALS;
        this.listeners.clear();
    }

    private stop(): void {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        setNetworkErrorListener(null);
    }

    private set(next: HealthState): void {
        this.state = next;
        for (const listener of this.listeners) listener();
    }

    private schedule(ms: number): void {
        if (!this.running) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.check(); }, ms);
    }

    private nextDelay(): number {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return this.intervals.hidden;
        return this.state.kind === 'ok' ? this.intervals.ok : this.intervals.down;
    }

    /** 1 回の軽い問い合わせ。応答が返れば true。 */
    private async ping(): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.intervals.timeout);
        try {
            const resp = await apiFetch('/api/health', { cache: 'no-store', signal: controller.signal });
            return resp.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    /** 応答しているかを確かめ、状態を決める。 */
    private async check(): Promise<void> {
        if (this.checking || this.state.kind === 'restarting') return;
        this.checking = true;
        try {
            const next = await this.diagnose();
            // 確かめている間に「再起動」が押されていたら、そちらに任せる (状態は await の間に変わりうる)
            const now = this.getState();
            if (now.kind !== 'restarting') {
                // 自然に戻ったとき (開発用の起動を利用者が起動し直した、など) は、ジョブの見張りには知らせない。
                // 本当に起動し直されていれば、ジョブの記録が無くなっていることにジョブの見張りが自分で気づく
                if (next.kind !== 'ok' || now.kind !== 'ok') this.set(next);
            }
        } finally {
            this.checking = false;
        }
        if (this.getState().kind !== 'restarting') this.schedule(this.nextDelay());
    }

    private async diagnose(): Promise<HealthState> {
        let detail: string | null = null;
        if (isDesktop()) {
            const status = await backendStatus().catch(() => null);
            if (status?.phase === 'setup' || status?.phase === 'starting') {
                // ほかの窓が起動し直している。終わったら、新しい接続情報を受け取る
                try {
                    await refreshBackend();
                    return (await this.ping()) ? OK : { kind: 'down', detail: null };
                } catch (e) {
                    return { kind: 'down', detail: describeError(e) };
                }
            }
            if (status?.phase === 'failed') return { kind: 'down', detail: status.message };
        }
        if (await this.ping()) return OK;
        // 一瞬の取りこぼし (重い処理の切り替わりなど) で知らせないよう、少し待ってもう 1 回だけ確かめる
        await new Promise((resolve) => setTimeout(resolve, this.intervals.retry));
        if (await this.ping()) return OK;
        if (isDesktop()) {
            // ほかの窓が起動し直して、ポートとトークンが変わっていたら、受け取り直して確かめる
            try {
                if (await refreshBackend() && await this.ping()) return OK;
            } catch (e) {
                detail = describeError(e);
            }
        }
        return { kind: 'down', detail };
    }
}

/** 画面に 1 つの見張り。 */
export const health = new HealthMonitor();
