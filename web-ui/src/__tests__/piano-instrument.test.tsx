/**
 * ピアノ音源の導入と、実際の音色・失敗の表示。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
    desktop: true,
    installed: false,
    sound: 'unprepared',
    setStatus: vi.fn(),
    prepare: vi.fn(async () => true),
    run: vi.fn(async () => { state.installed = true; }),
}));
vi.mock('../lib/api', async (original) => ({
    ...await original<typeof import('../lib/api')>(),
    isDesktop: () => state.desktop,
    apiFetch: vi.fn(async () => Response.json({
        installed: state.installed, downloadBytes: 748522601, author: 'Alexander Holm',
        license: 'CC-BY-3.0', sourceUrl: 'https://github.com/sfzinstruments/SalamanderGrandPiano',
    })),
}));
vi.mock('../lib/store', () => ({ useDaw: () => ({ setStatus: state.setStatus }) }));
vi.mock('../lib/engine', () => ({ default: {
    getTrack: () => ({ id: 1, part: null }),
    preparePiano: state.prepare,
    instrumentSnapshot: () => state.sound,
    subscribeInstrument: () => () => {},
} }));
vi.mock('../lib/job-focus', () => ({ useShowJob: () => vi.fn() }));
vi.mock('../lib/useJob', () => ({ useJob: () => ({
    job: null, busyJob: null, heavyBusy: false, active: null, run: state.run, cancel: vi.fn(),
}) }));

import PianoInstrument from '../components/PianoInstrument';

beforeEach(() => {
    state.desktop = true;
    state.installed = false;
    state.sound = 'unprepared';
    state.setStatus.mockClear();
    state.prepare.mockReset().mockResolvedValue(true);
    state.run.mockClear();
});
afterEach(cleanup);

it('録音素材のサイズと出典を示し、クリックしたときだけダウンロードして再生に反映する', async () => {
    render(<PianoInstrument activeTrackId={1} />);
    const download = await screen.findByRole('button', { name: 'ピアノ音源をダウンロード', hidden: true });
    expect(screen.getByText(/約 749 MB/)).toBeTruthy();
    expect(screen.getByText(/Alexander Holm/)).toBeTruthy();
    expect(state.run).not.toHaveBeenCalled();
    fireEvent.click(download);
    await waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
    expect(state.run).toHaveBeenCalledWith('/api/instruments/piano/install', expect.any(FormData));
    await waitFor(() => expect(state.setStatus).toHaveBeenCalledWith(expect.stringContaining('グランドピアノを用意しました')));
});

it('導入できても読み込みに失敗したら、成功として扱わず理由を表示する', async () => {
    state.prepare.mockRejectedValue(new Error('音源を読み込めません'));
    render(<PianoInstrument activeTrackId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'ピアノ音源をダウンロード', hidden: true }));
    await waitFor(() => expect(state.setStatus).toHaveBeenCalledWith(expect.stringContaining('音源を読み込めません'), 'error'));
    expect(screen.getByRole('alert', { hidden: true }).textContent).toContain('音源を読み込めません');
});

it('電子音へ切り替わったら、ピアノの準備済み状態より実際の再生状態を優先する', async () => {
    state.installed = true;
    state.sound = 'failed';
    render(<PianoInstrument activeTrackId={1} />);
    await screen.findByText('音色: 電子音（ピアノの再生に失敗）');
    expect(screen.getByRole('alert', { hidden: true }).textContent).toContain('アプリを開き直してください');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ピアノ音源をダウンロード', hidden: true })).toBeNull());
});

it('開発用ブラウザは電子音と表示し、ダウンロードを提供しない', () => {
    state.desktop = false;
    render(<PianoInstrument activeTrackId={1} />);
    expect(screen.getByText('音色: 電子音（開発用のブラウザ）')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
});
