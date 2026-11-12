/**
 * 時間のかかる処理 (ジョブ) の見張り (lib/jobs.ts) と、進み具合のカード (components/JobCard.tsx) のテスト。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
import {
    JobBusyError, JobCancelledError, JobFailedError, busyMessage, jobErrorMessage, jobTracker, slotOf, stageCount, stageText,
    type Job,
} from '../lib/jobs';
import JobCard from '../components/JobCard';

expect.extend(matchers);

function job(overrides: Partial<Job> = {}): Job {
    return {
        id: 'j1', kind: 'decompose', title: 'パート分離と採譜', filename: 'song.wav', state: 'running', cancel_requested: false,
        stage: 'パートに分けています', stage_key: 'separate', stage_index: 1, stage_count: 5, progress: null,
        elapsed_sec: 65, error: null, result: null, ...overrides,
    };
}

/** URL ごとの応答を決める偽の fetch。呼ばれた URL を記録する。 */
function stubApi(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push(url); return handler(url, init); }));
    return calls;
}

/** 見張りの様子を、変わるたびに記録する (間隔が短いので、途中の様子は待たずに記録で確かめる)。 */
function record() {
    const seen: ReturnType<typeof jobTracker.getSnapshot>[] = [];
    jobTracker.subscribe(() => seen.push(jobTracker.getSnapshot()));
    return seen;
}

beforeEach(() => {
    jobTracker.resetForTest();
    jobTracker.configure({ poll: 5, hiddenPoll: 5, discover: 5, hiddenDiscover: 5 });
    localStorage.clear();
});

afterEach(() => {
    jobTracker.resetForTest();
    vi.unstubAllGlobals();
    cleanup();
});

describe('jobTracker.run', () => {
    it('?async=1 で始め、状態を聞き続けて、終わったら結果を返す。動いている間は置き場所に出る', async () => {
        let polls = 0;
        const calls = stubApi((url, init) => {
            if (url === '/api/decompose?async=1') {
                expect(init?.method).toBe('POST');
                return Response.json(job(), { status: 202 });
            }
            if (url === '/api/jobs/j1') {
                polls += 1;
                return Response.json(polls < 3 ? job({ progress: polls / 3 }) : job({ state: 'done', result: { bpm: 120 } }));
            }
            throw new Error(`想定外: ${url}`);
        });
        const seen = record();
        const running = jobTracker.run<{ bpm: number }>('learn-parts', '/api/decompose', new FormData());
        expect(await running).toEqual({ bpm: 120 });
        expect(seen.some((s) => s.bySlot['learn-parts']?.id === 'j1' && s.active?.id === 'j1')).toBe(true);
        expect(seen.some((s) => s.bySlot['learn-parts']?.progress === 2 / 3)).toBe(true);
        expect(calls.filter((u) => u === '/api/jobs/j1').length).toBe(3);
        // 終わったら、どこにも出さない
        expect(jobTracker.getSnapshot()).toMatchObject({ active: null, bySlot: {} });
        // 始めた場所を覚えている (開き直したときに、同じ場所へカードを出すため)
        expect(slotOf(job())).toBe('learn-parts');
    });

    it('中止で終われば JobCancelledError、失敗で終われば理由つきの JobFailedError', async () => {
        stubApi((url) => {
            if (url.startsWith('/api/chart')) return Response.json(job({ id: 'c1', kind: 'chart' }), { status: 202 });
            return Response.json(job({ id: 'c1', kind: 'chart', state: 'cancelled', cancel_requested: true }));
        });
        await expect(jobTracker.run('learn-song', '/api/chart', new FormData())).rejects.toBeInstanceOf(JobCancelledError);

        stubApi((url) => {
            if (url.startsWith('/api/chart')) return Response.json(job({ id: 'c2', kind: 'chart' }), { status: 202 });
            return Response.json(job({ id: 'c2', kind: 'chart', state: 'error', error: { status: 400, detail: 'ファイル名が不正です' } }));
        });
        const failed = jobTracker.run('learn-song', '/api/chart', new FormData());
        await expect(failed).rejects.toBeInstanceOf(JobFailedError);
        await expect(failed).rejects.toThrow('ファイル名が不正です');
    });

    it('ほかが動いていて 409 なら JobBusyError。その置き場所に、動いているジョブを知らせる', async () => {
        const running = job({ id: 'other', kind: 'separate', title: 'パート分離', filename: 'a.wav' });
        stubApi((url) => {
            if (url.startsWith('/api/chart')) {
                return Response.json({ detail: '…', code: 'job_busy', job: running }, { status: 409 });
            }
            return Response.json(running);
        });
        const refused = jobTracker.run('learn-song', '/api/chart', new FormData());
        await expect(refused).rejects.toBeInstanceOf(JobBusyError);
        await expect(refused).rejects.toThrow('「a.wav」のパート分離を実行中です。終わるか、中止してから始めてください');
        expect(jobTracker.getSnapshot().busy['learn-song']?.id).toBe('other');
        expect(jobTracker.getSnapshot().active?.id).toBe('other');
    });

    it('入力の誤り (400) は、ジョブを作らずにその理由で失敗する', async () => {
        stubApi(() => Response.json({ detail: 'ファイル名が不正です' }, { status: 400 }));
        await expect(jobTracker.run('learn-song', '/api/chart', new FormData())).rejects.toThrow('ファイル名が不正です');
        expect(jobTracker.getSnapshot().active).toBeNull();
    });

    it('状態を聞いて記録が無かったら (起動し直された)、失敗として終わる', async () => {
        stubApi((url) => (url.startsWith('/api/chart')
            ? Response.json(job({ id: 'gone', kind: 'chart' }), { status: 202 })
            : Response.json({ detail: 'ジョブが見つかりません' }, { status: 404 })));
        await expect(jobTracker.run('learn-song', '/api/chart', new FormData())).rejects.toThrow('処理の記録が見つかりませんでした');
    });
});

describe('つなぎ直し', () => {
    it('ほかで始まったジョブを見つけて見張り、終わったら置き場所の受け手に結果を渡す', async () => {
        let polls = 0;
        stubApi((url) => {
            if (url === '/api/jobs') return Response.json({ active: polls === 0 ? job({ id: 'r1', kind: 'chart' }) : null, jobs: [] });
            polls += 1;
            return Response.json(job({ id: 'r1', kind: 'chart', state: polls < 2 ? 'running' : 'done', result: { chart_id: 'x' } }));
        });
        const ended: Job[] = [];
        jobTracker.onAttachedEnd('learn-song', (j) => ended.push(j));
        const seen = record();
        const stop = jobTracker.startDiscovery();
        await waitFor(() => expect(ended).toHaveLength(1));
        // カルテの作成は、始めた場所を覚えていなくても「曲とパート」に出す
        expect(seen.some((s) => s.bySlot['learn-song']?.id === 'r1')).toBe(true);
        expect(ended[0].result).toEqual({ chart_id: 'x' });
        stop();
    });

    it('受け手がまだ居ないうちに終わったら、登録したときに渡す', async () => {
        stubApi((url) => (url === '/api/jobs'
            ? Response.json({ active: job({ id: 'r2', kind: 'chart_regrid' }), jobs: [] })
            : Response.json(job({ id: 'r2', kind: 'chart_regrid', state: 'done', result: 1 }))));
        const seen = record();
        const stop = jobTracker.startDiscovery();
        await waitFor(() => expect(seen.some((s) => s.active?.id === 'r2') && jobTracker.getSnapshot().active === null).toBe(true));
        stop();
        const handler = vi.fn();
        jobTracker.onAttachedEnd('grid', handler);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'r2', state: 'done' }));
    });

    it('この画面で始めたジョブの結果は、受け手には渡さない (run の戻り値で受け取る)', async () => {
        stubApi((url) => (url.startsWith('/api/chart')
            ? Response.json(job({ id: 'own', kind: 'chart' }), { status: 202 })
            : Response.json(job({ id: 'own', kind: 'chart', state: 'done', result: 2 }))));
        const handler = vi.fn();
        jobTracker.onAttachedEnd('learn-song', handler);
        expect(await jobTracker.run('learn-song', '/api/chart', new FormData())).toBe(2);
        expect(handler).not.toHaveBeenCalled();
    });

    it('中止は、止まるまで「キャンセル中」のまま見張る', async () => {
        let cancelled = false;
        stubApi((url, init) => {
            if (url.startsWith('/api/decompose')) return Response.json(job({ id: 'k1' }), { status: 202 });
            if (url === '/api/jobs/k1/cancel') { expect(init?.method).toBe('POST'); cancelled = true; return Response.json(job({ id: 'k1', cancel_requested: true })); }
            return Response.json(job({ id: 'k1', cancel_requested: cancelled }));
        });
        const running = jobTracker.run('learn-parts', '/api/decompose', new FormData()).catch((e) => e);
        await waitFor(() => expect(jobTracker.getSnapshot().active?.id).toBe('k1'));
        await jobTracker.cancel('k1');
        expect(jobTracker.getSnapshot().active?.cancel_requested).toBe(true);
        jobTracker.serverRestarted();
        expect(await running).toBeInstanceOf(JobFailedError);
    });
});

describe('画面に出す文', () => {
    it('段階と、段階の数', () => {
        expect(stageText(job())).toBe('パートに分けています');
        expect(stageCount(job())).toBe('段階 2/5');
        expect(stageCount(job({ stage_count: 1, stage_index: 0 }))).toBe('');
        expect(stageText(job({ state: 'queued', stage: null }))).toBe('順番を待っています…');
        expect(stageText(job({ stage: null, stage_index: null }))).toBe('準備しています…');
        expect(stageText(job({ cancel_requested: true }))).toMatch(/^キャンセル中…/);
    });

    it('失敗の理由。処理の側の失敗 (5xx) には、次にどうすればよいかを添える', () => {
        expect(jobErrorMessage(job({ state: 'error', error: { status: 400, detail: '入力が違います' } }))).toBe('入力が違います');
        expect(jobErrorMessage(job({ state: 'error', error: { status: 500, detail: 'boom' } }))).toMatch(/もう一度試してください.*（理由: boom）/);
        expect(busyMessage(job({ filename: null }))).toBe('パート分離と採譜を実行中です。終わるか、中止してから始めてください');
    });
});

describe('JobCard', () => {
    it('処理の名前・段階・経過時間・中止を出す。割合が分からなければ動き続けるバー', () => {
        const onCancel = vi.fn();
        render(<JobCard slot="learn-parts" job={job()} onCancel={onCancel} hint="待っている間も、カルテは読めます。" />);
        const card = screen.getByRole('group', { name: 'パート分離と採譜の進み具合' });
        expect(card).toHaveTextContent('song.wav');
        expect(card).toHaveTextContent('パートに分けています');
        expect(card).toHaveTextContent('段階 2/5');
        expect(card).toHaveTextContent('経過 1分05秒');
        expect(card).toHaveTextContent('待っている間も、カルテは読めます。');
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '割合は分かりません');
        fireEvent.click(screen.getByRole('button', { name: '中止' }));
        expect(onCancel).toHaveBeenCalled();
    });

    it('割合が分かるときは数字のバー。中止を頼んだあとは「キャンセル中…」で押せない', () => {
        render(<JobCard slot="learn-parts" job={job({ progress: 0.42, cancel_requested: true })} onCancel={() => {}} />);
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
        expect(screen.getByText(/42%/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'キャンセル中…' })).toBeDisabled();
    });

    it('初回のモデルのダウンロードの段階では、時間がかかる理由を添える', () => {
        render(<JobCard slot="learn-parts" job={job({ stage_key: 'model', stage: 'モデルをダウンロードしています（初回のみ）', stage_index: 0 })} onCancel={() => {}} />);
        expect(screen.getByText(/初めて使うときだけ、分離に使うモデル/)).toBeInTheDocument();
    });

    it('断られたときは、何が動いているかと、それを見るボタンを出す', () => {
        const onShow = vi.fn();
        const other = job({ id: 'x', title: 'パート分離', filename: 'a.wav' });
        render(<JobCard slot="learn-song" job={null} busyJob={other} onCancel={() => {}} onShowBusy={onShow} />);
        expect(screen.getByRole('alert')).toHaveTextContent('「a.wav」のパート分離を実行中です');
        fireEvent.click(screen.getByRole('button', { name: '実行中の処理を見る' }));
        expect(onShow).toHaveBeenCalledWith(other);
    });

    it('どちらも無ければ何も出さない', () => {
        const { container } = render(<JobCard slot="learn-song" job={null} onCancel={() => {}} />);
        expect(container).toBeEmptyDOMElement();
    });
});
