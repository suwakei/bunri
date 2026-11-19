/**
 * lib/models.ts のテスト。モデルが手元に無いときだけ案内を返すこと。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { modelDownloadNotice, MODEL_DOWNLOAD_NOTICE } from '../lib/models';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: () => Promise<Response>) {
    const mock = vi.fn(impl);
    vi.stubGlobal('fetch', mock);
    return mock;
}

describe('modelDownloadNotice', () => {
    it('モデルが無ければ案内を返す', async () => {
        const mock = stubFetch(async () => Response.json({ model: 'htdemucs_6s', cached: false, missing: 1 }));
        expect(await modelDownloadNotice('htdemucs_6s')).toBe(MODEL_DOWNLOAD_NOTICE);
        expect(mock).toHaveBeenCalledWith('/api/models/htdemucs_6s/status');
    });

    it('モデルが在れば空文字', async () => {
        stubFetch(async () => Response.json({ model: 'htdemucs', cached: true, missing: 0 }));
        expect(await modelDownloadNotice('htdemucs')).toBe('');
    });

    it.each([['subroformer', 207349784, '207'], ['scnet', 12900000, '13']])('新モデル %s の初回容量を知らせる', async (model, bytes, shown) => {
        const mock = stubFetch(async () => Response.json({ model, cached: false, missing: 1, download_bytes: bytes }));
        expect(await modelDownloadNotice(String(model))).toContain(`約 ${shown} MB`);
        expect(mock).toHaveBeenCalledWith(`/api/models/${model}/status`);
    });

    it('取得済みの新モデルは容量が返っても初回案内を出さない', async () => {
        stubFetch(async () => Response.json({ model: 'subroformer', cached: true, missing: 0, download_bytes: 207349784 }));
        expect(await modelDownloadNotice('subroformer')).toBe('');
    });

    it('問い合わせに失敗しても処理を止めない（空文字）', async () => {
        stubFetch(async () => new Response('not found', { status: 404 }));
        expect(await modelDownloadNotice('nope')).toBe('');
        stubFetch(async () => { throw new TypeError('Load failed'); });
        expect(await modelDownloadNotice('htdemucs')).toBe('');
    });
});
