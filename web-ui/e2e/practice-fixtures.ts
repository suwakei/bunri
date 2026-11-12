/**
 * 練習画面のテストで使う、差し替えたカルテとパート分離の応答。
 *
 * 1 拍目が 0.75 秒に在る 120 BPM・4/4 の曲 (1 小節 = 2 秒 = 16 ステップ × 20px = 320px)。
 * 構成は「Aメロ」1〜2 小節、「サビ」3〜4 小節。ベースのお手本は 1〜2 小節に 8 ノート。
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { fakeJob, importSong, makeWav, openTab, SONG_MP3, statusText } from './helpers';
import { expect } from '@playwright/test';

export const DOWNBEAT = 0.75;
export const BAR_SEC = 2;

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length, velocity: 90 });
/** ベースのお手本 (1〜2 小節)。 */
export const BASS = [
    note('C', 2, 0), note('E', 2, 4), note('G', 2, 8), note('C', 3, 12),
    note('A', 2, 16), note('E', 2, 20), note('A', 2, 24), note('G', 2, 28),
];

/** カルテ (API の応答の形)。 */
export function fakeChart() {
    const beats = Array.from({ length: 33 }, (_, i) => DOWNBEAT + i * 0.5);
    const symbols = ['C', 'Am', 'F', 'G', 'C', 'G', 'F', 'C'];
    const roots = ['C', 'A', 'F', 'G', 'C', 'G', 'F', 'C'];
    const section = (id: string, label: string, start: number, end: number) => ({
        id, label: null, suggested_label: label, suggested_confidence: 0.5, start_bar: start, end_bar: end,
        start_sec: DOWNBEAT + (start - 1) * BAR_SEC, end_sec: DOWNBEAT + end * BAR_SEC, repeat_group: id === 'S1' ? 'A' : 'B',
        features: { rms_db: -12, onset_density: 2 },
    });
    return {
        chart_id: 'song',
        chart: {
            version: 1,
            source: { filename: 'song.mp3', duration_sec: 8 },
            grid: {
                bpm: 120, bpm_confidence: 0.9, bpm_source: 'auto', downbeat_offset_sec: DOWNBEAT,
                time_signature: [4, 4], beat_times_sec: beats, user_confirmed: false,
            },
            key: { tonic: 'C', mode: 'major', confidence: 0.8, alternatives: [] },
            sections: [section('S1', 'verse', 1, 2), section('S2', 'chorus', 3, 4)],
            chords: symbols.map((symbol, i) => ({
                bar: i + 1, beat: 1, beat_index: i * 4, beat_count: 4, start_sec: beats[i * 4], end_sec: beats[i * 4 + 4] ?? beats[i * 4] + 2,
                root: roots[i], quality: symbol === 'Am' ? 'min' : 'maj', symbol, degree: null, confidence: 0.9,
            })),
            mix: { loudness_lufs: -10, peak_dbfs: -1, dynamic_range_db: 6, stereo_width: null, bass_mono: null, reverb_tail_sec: null, spectrum_bands: [] },
            unavailable: {},
        },
        peaks: { points: 0, duration_sec: 8, min: [], max: [] },
        glossary: {},
    };
}

/** パート分離の応答 (ボーカルとベース)。音声は 10 秒の WAV。 */
function fakeDecompose() {
    const stem = (extra: object) => ({ gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [], drum_events: [], ...extra });
    return {
        bpm: 120,
        grid_offset_sec: DOWNBEAT,
        stems: {
            vocals: stem({ audio_url: '/api/download/decompose_vocals_song.mp3', notes: [note('E', 4, 0, 8)] }),
            bass: stem({ audio_url: '/api/download/decompose_bass_song.mp3', notes: BASS }),
        },
    };
}

/** カルテとパート分離の API を差し替える。画面を開く前に呼ぶ。 */
export async function fakePracticeBackend(page: Page): Promise<void> {
    await fakeJob(page, '/api/chart', fakeChart);
    await page.route('**/api/chart/song/guide*', (route) => route.fulfill({ json: { saved: false } }));
    await fakeJob(page, '/api/decompose', fakeDecompose);
    await page.route('**/api/download/decompose_*', (route) => route.fulfill({ contentType: 'audio/wav', body: makeWav(10, [110], 22050) }));
}

/** 曲を取り込み、パートに分け、「ベース」の「このパートを練習する」で練習画面を開く。 */
export async function openBassPractice(page: Page): Promise<void> {
    // 再生の仕組み (AudioContext) を、本物のクリックの中で作っておく。テストのファイルの欄への入力は利用者の操作に
    // 数えられず、その中で作ると、ブラウザによっては時計が進まないまま (再生位置が動かない) になる
    await page.getByRole('button', { name: 'メトロノーム' }).click();
    await page.getByRole('button', { name: 'メトロノーム' }).click();
    await importSong(page, { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(SONG_MP3) });
    await expect(statusText(page)).toContainText('カルテを作りました');
    await openTab(page, '曲とパート');
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました');
    await page.locator('#part-list').getByRole('button', { name: '「ベース」を練習する' }).click();
    await expect(page.getByRole('region', { name: '練習画面' })).toBeVisible();
}
