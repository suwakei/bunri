/**
 * 学ぶ流れ: 曲を取り込む → カルテを見る → パートに分ける → 打ち込む → 差分で直す。
 *
 * 取り込みは本物の MP3 (e2e/fixtures/song.mp3) をブラウザでデコードする。カルテとパート分離は、
 * 1 拍目の位置などを決めて確かめたいので、API の応答を差し替える (パート分離は数分かかり、モデルも要る)。
 * 差し替えたカルテは、1 拍目が 0.75 秒に在る 120 BPM・4/4 の曲 (1 小節 = 2 秒)。
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from '@playwright/test';
import { importSong, makeWav, openDaw, openTab, SONG_MP3, startFree, statusText, trackSummary } from './helpers';

const DOWNBEAT = 0.75;
const PX_PER_SEC = 80;
const HEADER_WIDTH = 200;
const STEP_WIDTH = 20;

const mp3 = () => ({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(SONG_MP3) });

/** 1 拍目が 0.75 秒の、8 小節のカルテ (API の応答の形)。 */
function fakeChart() {
    const beats = Array.from({ length: 33 }, (_, i) => DOWNBEAT + i * 0.5);
    const symbols = ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'C'];
    const roots = ['C', 'G', 'A', 'F', 'C', 'G', 'F', 'C'];
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
            sections: [
                { id: 'S1', label: null, suggested_label: 'verse', suggested_confidence: 0.5, start_bar: 1, end_bar: 4,
                    start_sec: DOWNBEAT, end_sec: DOWNBEAT + 8, repeat_group: 'A', features: { rms_db: -12, onset_density: 2 } },
                { id: 'S2', label: null, suggested_label: 'chorus', suggested_confidence: 0.5, start_bar: 5, end_bar: 8,
                    start_sec: DOWNBEAT + 8, end_sec: DOWNBEAT + 16, repeat_group: 'B', features: { rms_db: -10, onset_density: 3 } },
            ],
            chords: symbols.map((symbol, i) => ({
                bar: i + 1, beat: 1, beat_index: i * 4, beat_count: 4, start_sec: beats[i * 4], end_sec: beats[i * 4 + 4],
                root: roots[i], quality: symbol === 'Am' ? 'min' : 'maj', symbol, degree: null, confidence: 0.9,
            })),
            mix: { loudness_lufs: -10, peak_dbfs: -1, dynamic_range_db: 6, stereo_width: null, bass_mono: null, reverb_tail_sec: null, spectrum_bands: [] },
            unavailable: {},
        },
        peaks: { points: 0, duration_sec: 8, min: [], max: [] },
        glossary: {},
    };
}

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length, velocity: 90 });
const BASS = [note('C', 2, 0), note('E', 2, 4), note('G', 2, 8)];
const VOCALS = [note('E', 4, 0, 8), note('G', 4, 8, 8)];

/** パート分離の応答 (ボーカル・ドラム・ベース)。音声は 8 秒の WAV を返す。 */
function fakeDecompose() {
    const stem = (extra: object) => ({ gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [], drum_events: [], ...extra });
    return {
        bpm: 120,
        grid_offset_sec: DOWNBEAT,
        stems: {
            vocals: stem({ audio_url: '/api/download/decompose_vocals_song.mp3', notes: VOCALS }),
            drums: stem({ audio_url: '/api/download/decompose_drums_song.mp3', drum_events: [
                { type: 'kick', step: 0, velocity: 100 }, { type: 'snare', step: 4, velocity: 90 }, { type: 'hihat', step: 2, velocity: 60 }] }),
            bass: stem({ audio_url: '/api/download/decompose_bass_song.mp3', notes: BASS }),
        },
    };
}

/** カルテとパート分離の API を差し替える。パート分離に送られたリクエストを返す。 */
async function fakeBackend(page: Page) {
    const sent: { decompose?: Request } = {};
    await page.route('**/api/chart', (route) => route.fulfill({ json: fakeChart() }));
    await page.route('**/api/chart/song/guide*', (route) => route.fulfill({ json: { saved: false } }));
    await page.route('**/api/decompose', (route) => { sent.decompose = route.request(); return route.fulfill({ json: fakeDecompose() }); });
    await page.route('**/api/download/decompose_*', (route) => route.fulfill({ contentType: 'audio/wav', body: makeWav(8, [130.81]) }));
    return sent;
}

/** 進み具合の段階の状態 (done / current / todo)。 */
const stepState = (page: Page, key: string) => page.locator(`#learn-progress [data-step="${key}"]`).getAttribute('data-state');

/** タイムラインの小節番号の段の、小節の線の位置 (段の左端からの px)。timeline.spec.ts と同じ見分け方。 */
const barLines = (page: Page) => page.locator('#timeline-header-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const row = canvas.getContext('2d')!.getImageData(0, 22, canvas.width, 1).data;
    const xs: number[] = [];
    for (let x = 1; x < canvas.width; x++) if (row[x * 4] > 46 && row[(x - 1) * 4] > 46) xs.push(x);
    return xs;
});

/** 要素が、ピアノロールの見えている範囲の中 (縦) に在るか。 */
async function inPianoView(page: Page, selector: string) {
    const wrap = (await page.locator('#piano-grid-wrap').boundingBox())!;
    const box = (await page.locator(selector).first().boundingBox())!;
    return box.y >= wrap.y && box.y + box.height <= wrap.y + wrap.height;
}

test('MP3 の曲を取り込むと、原曲のトラックに音声が置かれ、カルテができる。進み具合が ③ に進む', async ({ page }) => {
    await fakeBackend(page);
    await openDaw(page);
    expect(await stepState(page, 'import')).toBe('current');
    expect(await stepState(page, 'chart')).toBe('todo');

    await importSong(page, mp3());
    await expect(statusText(page)).toContainText('カルテを作りました');
    // MP3 をブラウザでデコードして、原曲のトラックに置く (8 秒 = 640px)
    expect(await trackSummary(page)).toEqual([{ name: '原曲', clips: ['song.mp3'] }]);
    const width = await page.locator('#tracks-container .clip').evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(width - 8 * PX_PER_SEC)).toBeLessThan(8);
    // カルテのテンポと 1 拍目の位置が、プロジェクトに入る
    await expect(page.locator('#transport-bpm')).toHaveValue('120');
    await expect(page.getByRole('tab', { name: 'カルテ' })).toHaveAttribute('aria-selected', 'true');

    expect(await stepState(page, 'import')).toBe('done');
    expect(await stepState(page, 'chart')).toBe('done');
    expect(await stepState(page, 'separate')).toBe('current');
    await expect(page.getByRole('button', { name: '③ パートに分ける（いまの段階）' })).toHaveAttribute('aria-current', 'step');

    // 段階を押すと、その場所が開く
    await page.getByRole('button', { name: /① 曲を取り込む/ }).click();
    await expect(page.getByRole('tab', { name: '曲とパート' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#song-current')).toContainText('song.mp3');
    await page.getByRole('button', { name: /② カルテを見る/ }).click();
    await expect(page.locator('#chart-panel')).toBeVisible();
    await page.getByRole('button', { name: /⑤ 差分で直す/ }).click();
    await expect(page.locator('#coach-panel')).toBeVisible();
});

test('取り込んだ曲をブラウザで読めないときは、API で変換を試み、それもだめならそう知らせる (カルテは作る)', async ({ page }) => {
    await fakeBackend(page);
    let converted = false;
    await page.route('**/api/convert/wav', (route) => { converted = true; return route.fulfill({ status: 400, json: { detail: 'ffmpeg が見つかりません' } }); });
    await openDaw(page);
    await importSong(page, { name: 'broken.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('not audio at all') });
    await expect(statusText(page)).toContainText('カルテを作りました');
    await expect(statusText(page)).toContainText('タイムラインには置いていません');
    await expect(statusText(page)).toHaveAttribute('role', 'alert');
    expect(converted).toBe(true);
    // 原曲のトラックは在る (クリップは無い)
    expect(await trackSummary(page)).toEqual([{ name: '原曲', clips: [] }]);
});

test('パートに分けると、お手本は重ねて見せるだけで、打ち込みは空。「このパートを練習する」で練習の準備がそろい、差分は 100% にならない', async ({ page }) => {
    const sent = await fakeBackend(page);
    await openDaw(page);
    await importSong(page, mp3());
    await expect(statusText(page)).toContainText('カルテを作りました');

    await openTab(page, '曲とパート');
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました');
    // カルテのテンポと 1 拍目の位置で採譜するよう、API に送っている
    const body = sent.decompose!.postData() ?? '';
    expect(body).toMatch(/name="bpm"\r\n\r\n120\r\n/);
    expect(body).toMatch(/name="grid_offset"\r\n\r\n0\.75\r\n/);

    expect((await trackSummary(page)).map((t) => t.name)).toEqual(['原曲', 'ボーカル', 'ドラム', 'ベース']);
    // パートは、原曲と重ならないようミュートしてある
    await expect(page.getByRole('button', { name: '「ベース」をミュート' })).toHaveAttribute('aria-pressed', 'true');
    // お手本は打ち込みに入れない (ノートの数の印が出ない)。ドラムは以前どおり、採譜したリズムを置く
    const row = (name: string) => page.locator('#tracks-container .track-row')
        .filter({ has: page.locator('.track-name', { hasText: new RegExp(`^${name}\\s*\\d*$`) }) });
    await expect(row('ベース').locator('.notes-badge')).toHaveCount(0);
    await expect(row('ドラム').locator('.notes-badge')).toHaveText('3');
    // お手本を持つパートには「練習する」が出る (ドラムには出ない)
    await expect(page.getByRole('button', { name: '「ベース」を練習する' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: '「ドラム」を練習する' })).toHaveCount(0);
    await expect(page.locator('#part-list')).toContainText('ドラム（差分チェックの対象外）');
    expect(await stepState(page, 'separate')).toBe('done');
    expect(await stepState(page, 'practice')).toBe('current');

    // パートのトラックを開くと、お手本が水色で重なり、自分のノートは無い
    await row('ベース').locator('.track-name').click();
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);

    // 「このパートを練習する」(パートの一覧から)
    await page.locator('#part-list').getByRole('button', { name: '「ベース」を練習する' }).click();
    expect((await trackSummary(page)).map((t) => t.name)).toEqual(['原曲', 'ボーカル', 'ドラム', 'ベース', 'ベースの練習']);
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('ベースの練習');
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);
    // お手本の在る高さ (C2〜G2) まで縦にスクロールしてある
    expect(await inPianoView(page, '#note-layer .note-ghost')).toBe(true);
    // パートの音が鳴るようになる (原曲はそのまま)
    await expect(page.getByRole('button', { name: '「ベース」をミュート' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: '「原曲」をミュート' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: '「ボーカル」をミュート' })).toHaveAttribute('aria-pressed', 'true');

    // お手本の 1 つ目をなぞって置く
    const ghost = (await page.locator('#note-layer .note-ghost').first().boundingBox())!;
    await page.mouse.dblclick(ghost.x + 10, ghost.y + 6);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
    expect(await stepState(page, 'practice')).toBe('done');
    expect(await stepState(page, 'diff')).toBe('current');

    // 差分で直す: 比べる組は「お手本 = ベース、打ち込み = ベースの練習」になっている
    await page.getByRole('button', { name: /⑤ 差分で直す/ }).click();
    const coach = page.locator('#coach-panel');
    await expect(coach.getByLabel('お手本')).toHaveValue(await row('ベース').locator('.track-header').getAttribute('data-track-id') ?? '');
    await expect(coach.getByLabel('比べる打ち込み')).toHaveValue(await row('ベースの練習').locator('.track-header').getAttribute('data-track-id') ?? '');
    await coach.getByRole('button', { name: 'お手本と比べる' }).click();
    // 3 ノートのうち 1 つだけ置いたので 33% (最初から 100% にはならない)
    await expect(coach.getByText('33%')).toBeVisible();
    await expect(coach.getByText(/E2 が抜けています/)).toBeVisible();
    expect(await stepState(page, 'diff')).toBe('done');

    // 指摘を押すと、その場所 (小節と高さ) へ移る
    await coach.getByRole('button', { name: /G2 が抜けています/ }).click();
    await expect(page.locator('#time-display')).toHaveText(/0:01\.[78]/);
});

test('カルテのコードを押すと、その小節へ移る。カルテの小節とタイムライン・ピアノロールの小節が同じ時刻を指す (1 拍目が 0 秒に無い曲)', async ({ page }) => {
    await fakeBackend(page);
    await openDaw(page);
    await importSong(page, mp3());
    await expect(statusText(page)).toContainText('カルテを作りました');

    // タイムラインの小節番号の段: 1 小節目の線は 1 拍目 (0.75 秒) の位置。1 小節 = 2 秒 = 160px
    const lines = await barLines(page);
    expect(Math.abs(lines[0] - (HEADER_WIDTH + DOWNBEAT * PX_PER_SEC))).toBeLessThanOrEqual(1);
    expect(lines[1] - lines[0]).toBe(2 * PX_PER_SEC);

    // 原曲のトラックをピアノロールで開いておく
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#chart-panel').getByRole('button', { name: /^3 小節: Am/ }).click();
    // 再生位置は、カルテの 3 小節目の頭 (0.75 + 4 = 4.75 秒)
    await expect(page.locator('#time-display')).toHaveText(/0:04\.[78]/);
    await expect(statusText(page)).toHaveText('3 小節（Am）へ移動しました');
    // ピアノロールの再生位置の線は、ピアノロールの 3 小節目の頭 (ステップ 32 = 640px)
    await expect(page.locator('#piano-playhead')).toBeVisible();
    const transform = await page.locator('#piano-playhead').evaluate((el) => (el as HTMLElement).style.transform);
    expect(transform).toBe(`translateX(${32 * STEP_WIDTH}px)`);
    // ピアノロールもタイムラインも、そこが見えるところまでスクロールしてある
    const wrap = page.locator('#piano-grid-wrap');
    const [left, view] = await wrap.evaluate((el) => [el.scrollLeft, el.clientWidth]);
    expect(left).toBeLessThanOrEqual(32 * STEP_WIDTH);
    expect(left + view).toBeGreaterThan(32 * STEP_WIDTH);
    const timeline = await page.locator('#timeline-playhead').evaluate((el) => (el as HTMLElement).style.transform);
    expect(timeline).toBe(`translateX(${Math.round(HEADER_WIDTH + 4.75 * PX_PER_SEC)}px)`);

    // 構成の行を押すと、区間の頭へ (5 小節目 = 8.75 秒)
    await page.locator('#chart-panel').getByRole('button', { name: /5〜8 小節の区間/ }).click();
    await expect(page.locator('#time-display')).toHaveText(/0:08\.[78]/);
});

test('再生すると、タイムラインとピアノロールの再生位置の線が動き、見えなくなる前にスクロールする (止めることもできる)', async ({ page }) => {
    await openDaw(page);
    await startFree(page, 1);
    // 60 秒のクリップを置く
    await openTab(page, 'ファイル');
    await page.locator('#file-import').setInputFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: makeWav(60, [440], 8000) });
    await page.getByRole('button', { name: '選択したトラックに追加' }).click();
    await expect(page.locator('#tracks-container .clip')).toHaveCount(1, { timeout: 60_000 });

    const x = (selector: string) => page.locator(selector).evaluate((el) => {
        const m = /translateX\((-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
        return m ? Number(m[1]) : NaN;
    });
    expect(await x('#timeline-playhead')).toBe(HEADER_WIDTH);
    await page.locator('#btn-play').click();
    await expect.poll(() => x('#timeline-playhead')).toBeGreaterThan(HEADER_WIDTH + 20);
    await expect.poll(() => x('#piano-playhead')).toBeGreaterThan(20);
    await expect(page.locator('#piano-playhead')).toBeVisible();

    // 見えている範囲の外へ移ると、そこまでスクロールする
    const area = page.locator('#timeline-area');
    expect(await area.evaluate((el) => el.scrollLeft)).toBe(0);
    const bar = (await page.locator('#seek-bar').boundingBox())!;
    await page.mouse.click(bar.x + bar.width * 0.9, bar.y + bar.height / 2);
    await expect.poll(() => area.evaluate((el) => el.scrollLeft)).toBeGreaterThan(2000);

    // 「再生位置を追う」を外すと、スクロールしない
    await page.getByLabel('再生位置を追う').uncheck();
    await area.evaluate((el) => { el.scrollLeft = 0; });
    await page.waitForTimeout(500);
    expect(await area.evaluate((el) => el.scrollLeft)).toBe(0);
    await page.locator('#transport button[title="停止"]').click();
});

test('進み具合は畳めて、畳んだことを覚えている', async ({ page }) => {
    await openDaw(page);
    const steps = page.locator('#learn-progress-steps');
    await expect(steps).toBeVisible();
    const height = await page.locator('#learn-progress').evaluate((el) => el.getBoundingClientRect().height);
    // 縦の場所をほとんど取らない
    expect(height).toBeLessThanOrEqual(32);
    await page.getByRole('button', { name: /進み具合/ }).click();
    await expect(steps).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'いま: ① 曲を取り込む' })).toBeVisible();
    await page.reload();
    await page.getByText('準備完了').waitFor();
    await expect(steps).toHaveCount(0);
    await page.getByRole('button', { name: /進み具合/ }).click();
    await expect(steps).toBeVisible();
});

test('お手本をノートとして取り込む・練習する・パートに分けるは、どれも元に戻せる。お手本のノートは選べない', async ({ page }) => {
    await fakeBackend(page);
    await openDaw(page);
    await importSong(page, mp3());
    await expect(statusText(page)).toContainText('カルテを作りました');
    await openTab(page, '曲とパート');
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました');
    const names = async () => (await trackSummary(page)).map((t) => t.name);
    const badge = (name: string) => page.locator('#tracks-container .track-row')
        .filter({ has: page.locator('.track-name', { hasText: new RegExp(`^${name}\\s*\\d*$`) }) }).locator('.notes-badge');

    await page.locator('#part-list').getByRole('button', { name: '「ベース」を練習する' }).click();
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    // お手本 (水色) は、全部選んでも選ばれず、Delete でも消えない
    await page.locator('#piano-grid-wrap').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.locator('#note-layer .note-block.selected')).toHaveCount(0);
    await expect(statusText(page)).toHaveText('0 ノートを選びました');
    await page.keyboard.press('Delete');
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);

    // お手本をノートとして取り込む (確かめてから写す) → 元に戻すと、それまでの打ち込み (空) に戻る
    await page.getByRole('button', { name: '「ベース」のお手本をノートとして取り込む' }).click();
    await page.getByRole('button', { name: '写す' }).click();
    await expect(badge('ベース')).toHaveText(String(BASS.length));
    await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toHaveAttribute('title', /「ベース」のお手本をノートとして取り込む/);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(badge('ベース')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(badge('ベース')).toHaveText(String(BASS.length));

    // 取り込み → 練習 → パート分離の順に戻すと、原曲だけに戻る
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    expect(await names()).toEqual(['原曲', 'ボーカル', 'ドラム', 'ベース']);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await names()).toEqual(['原曲']);
    // やり直すと、パートのトラックが (音声とお手本ごと) 戻る
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await trackSummary(page)).toEqual([
        { name: '原曲', clips: ['song.mp3'] }, { name: 'ボーカル', clips: ['ボーカル'] },
        { name: 'ドラム', clips: ['ドラム'] }, { name: 'ベース', clips: ['ベース'] },
    ]);
    await expect(page.getByRole('button', { name: '「ベース」を練習する' })).toHaveCount(2);
});
