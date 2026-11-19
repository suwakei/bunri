/**
 * 音色の選択・必要な素材だけの準備と、開発用ブラウザの案内。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
    desktop: true, sound: 'unprepared', setStatus: vi.fn(),
    track: { id: 1, name: 'Track 1', part: null as string | null, instrumentId: undefined as string | undefined },
    items: [
        { id: 'salamander', name: 'グランドピアノ', category: 'ピアノ', kind: 'sampler', packId: 'piano', installed: false, downloadBytes: 748522601, author: 'Alexander Holm', license: 'CC-BY-3.0', sourceUrl: 'https://example.com/piano' },
        { id: 'choir-a', name: 'コーラス あー', category: '声', kind: 'sampler', packId: 'choir', installed: false, downloadBytes: 10000000, author: 'Singer', license: 'CC0', sourceUrl: 'https://example.com/choir' },
        { id: 'choir-o', name: 'コーラス おー', category: '声', kind: 'sampler', packId: 'choir', installed: false, downloadBytes: 10000000, author: 'Singer', license: 'CC0', sourceUrl: 'https://example.com/choir' },
        { id: 'game-pad', name: 'ゲーム風パッド', category: 'スーパーファミコン風', kind: 'sampler', packId: 'game', installed: false, downloadBytes: 0, author: 'bunri', license: 'CC0', sourceUrl: 'bunri' },
    ],
    prepare: vi.fn(async (id: string) => state.items.find((item) => item.id === id)?.installed ?? false),
    run: vi.fn(async (path: string) => {
        const id = path.split('/')[3];
        const selected = state.items.find((item) => item.id === id)!;
        for (const item of state.items) if (item.packId === selected.packId) item.installed = true;
        return { ...selected };
    }),
}));
vi.mock('../lib/api', async (original) => ({
    ...await original<typeof import('../lib/api')>(),
    isDesktop: () => state.desktop,
    apiFetch: vi.fn(async () => Response.json({ instruments: state.items })),
}));
vi.mock('../lib/store', () => ({ useDaw: () => ({
    setStatus: state.setStatus, record: (_label: string, change: () => void) => change(), bumpTracks: vi.fn(),
}) }));
vi.mock('../lib/engine', () => ({ default: {
    getTrack: () => state.track,
    prepareInstrument: state.prepare,
    setTrackInstrument: (_trackId: number, id: string | undefined) => { state.track.instrumentId = id; },
    instrumentSnapshot: () => state.sound,
    subscribeInstrument: () => () => {},
} }));
vi.mock('../lib/job-focus', () => ({ useShowJob: () => vi.fn() }));
vi.mock('../lib/useJob', () => ({ useJob: () => ({
    job: null, busyJob: null, heavyBusy: false, active: null, run: state.run, cancel: vi.fn(),
}) }));

import PianoInstrument from '../components/PianoInstrument';

beforeEach(() => {
    state.desktop = true; state.sound = 'unprepared'; state.track.instrumentId = undefined; state.track.part = null;
    for (const item of state.items) item.installed = false;
    state.setStatus.mockClear(); state.prepare.mockClear(); state.run.mockClear();
});
afterEach(cleanup);

it('素材のサイズと出典を示し、クリックした音色の素材だけを用意する', async () => {
    render(<PianoInstrument activeTrackId={1} />);
    const download = await screen.findByRole('button', { name: '音源をダウンロード', hidden: true });
    expect(screen.getByText(/約 749 MB/)).toBeTruthy();
    expect(screen.getByText(/Alexander Holm/)).toBeTruthy();
    expect(state.run).not.toHaveBeenCalled();
    fireEvent.click(download);
    await waitFor(() => expect(state.run).toHaveBeenCalledWith('/api/instruments/salamander/install', expect.any(FormData)));
    await waitFor(() => expect(state.setStatus).toHaveBeenCalledWith(expect.stringContaining('を用意しました')));
    expect(state.items.find((item) => item.id === 'choir-a')?.installed).toBe(false);
});

it('ゲーム風の音色は選ぶだけでは素材を作らず、用意する操作で生成する', async () => {
    const view = render(<PianoInstrument activeTrackId={1} />);
    const selector = await screen.findByLabelText('このトラックの音色');
    await screen.findByRole('option', { name: 'ゲーム風パッド（素材が必要）', hidden: true });
    fireEvent.click(screen.getByText(/音色: グランドピアノ/));
    expect(screen.getByRole('combobox', { name: 'このトラックの音色' })).toBe(selector);
    fireEvent.change(selector, { target: { value: 'game-pad' } });
    view.rerender(<PianoInstrument activeTrackId={1} />);
    expect(state.track.instrumentId).toBe('game-pad');
    expect(state.run).not.toHaveBeenCalled();
    const prepare = await screen.findByRole('button', { name: '音色を用意する', hidden: true });
    expect(screen.getByText(/外部からのダウンロードはありません/)).toBeTruthy();
    fireEvent.click(prepare);
    await waitFor(() => expect(state.run).toHaveBeenCalledWith('/api/instruments/game-pad/install', expect.any(FormData)));
});

it('検索はカテゴリーや音色名で絞り、現在の音色は一覧に残す', async () => {
    render(<PianoInstrument activeTrackId={1} />);
    await screen.findByRole('option', { name: 'ゲーム風パッド（素材が必要）', hidden: true });
    fireEvent.change(screen.getByLabelText('音色を探す'), { target: { value: '声' } });
    expect(screen.queryByRole('option', { name: 'ゲーム風パッド（素材が必要）', hidden: true })).toBeNull();
    expect(screen.getByRole('option', { name: 'コーラス あー（素材が必要）', hidden: true })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'グランドピアノ（素材が必要）', hidden: true })).toBeTruthy();
});

it('一覧にない音色は勝手に置き換えず、IDを保持して案内する', async () => {
    state.track.instrumentId = 'future-voice';
    render(<PianoInstrument activeTrackId={1} />);
    await screen.findByText(/この音色は現在の一覧にありません/);
    expect(state.track.instrumentId).toBe('future-voice');
    expect(state.run).not.toHaveBeenCalled();
});

it('出力に失敗したあとは、電子音へ切り替わったことと開き直しを示す', async () => {
    state.sound = 'failed';
    render(<PianoInstrument activeTrackId={1} />);
    await screen.findByRole('option', { name: 'グランドピアノ（素材が必要）', hidden: true });
    expect(screen.getByText(/電子音（音の再生に失敗）/)).toBeTruthy();
    expect(screen.getByRole('alert', { hidden: true }).textContent).toContain('アプリを開き直してください');
});

it('ブラウザでも声の音色を選べるが、試聴は電子音で素材はダウンロードしない', async () => {
    state.desktop = false;
    const view = render(<PianoInstrument activeTrackId={1} />);
    await screen.findByRole('option', { name: 'コーラス あー（素材が必要）', hidden: true });
    fireEvent.change(screen.getByLabelText('このトラックの音色'), { target: { value: 'choir-a' } });
    view.rerender(<PianoInstrument activeTrackId={1} />);
    expect(state.track.instrumentId).toBe('choir-a');
    expect(screen.getByText(/電子音（開発用のブラウザ）/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '音源をダウンロード', hidden: true })).toBeNull();
    expect(state.prepare).not.toHaveBeenCalled();
});
