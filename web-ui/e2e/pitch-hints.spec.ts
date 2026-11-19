/**
 * ピアノロールの「キーの音」「コードの音」: カルテのキーの音階と、コードの構成音の高さの行に色が付くこと、
 * 切り替えで消えること、選んだ状態を覚えていること、カルテが無い・キーが取れていない・ドラムのトラックでは押せないこと、
 * 練習画面でも同じものが出て、コードの段と行の色の左端がそろうこと。
 *
 * 行の色は canvas (グリッドの背景) に描く。出しているものは `#piano-grid-wrap` の `data-key-hint` / `data-chord-hint` と
 * 鍵盤の列のしるしで読み、実際に描かれた色は canvas の画素を読んで確かめる。
 *
 * カルテとパート分離の応答は差し替える (e2e/practice-fixtures.ts)。キーは C メジャー、コードは 1 小節ごとに
 * C / Am / F / G / C / G / F / C。1 小節 = 2 秒 = 16 ステップ。
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fakeJob, importSong, makeWav, openDaw, openTab, SONG_MP3, startFree, statusText } from './helpers';
import { BASS, DOWNBEAT, fakeChart, fakePracticeBackend, openBassPractice } from './practice-fixtures';

/** 1 ステップの幅 (px)。表示の大きさを変えていないときの値 */
const STEP_WIDTH = 20;
const NOTE_NAMES = ['B', 'A#', 'A', 'G#', 'G', 'F#', 'F', 'E', 'D#', 'D', 'C#', 'C'];
/** 音の名前とオクターブから、行 (0 が一番上。C0〜B8) を出す。 */
const rowOf = (name: string, octave: number) => (8 - octave) * 12 + NOTE_NAMES.indexOf(name);
/** 音の名前とオクターブから、MIDI ノート番号 (C4 = 60) を出す。 */
const pitchOf = (name: string, octave: number) => (octave + 1) * 12 + (11 - NOTE_NAMES.indexOf(name));

const wrap = (page: Page) => page.locator('#piano-grid-wrap');
const keyToggle = (page: Page) => page.getByRole('button', { name: 'キーの音', exact: true });
const chordToggle = (page: Page) => page.getByRole('button', { name: 'コードの音', exact: true });
const pianoKey = (page: Page, name: string, octave: number) => page.locator(`#piano-keys .piano-key[data-pitch="${pitchOf(name, octave)}"]`);
const tooltip = (page: Page) => page.locator('#bunri-tooltip');

type Rgba = { r: number; g: number; b: number; a: number };

/**
 * グリッドの canvas の、その行の画素を読む (行の真ん中の高さ。線の上を避ける)。行が見えていなければ、見えるところまで
 * 縦にスクロールしてから読む。横の位置は、ステップ (その刻みの真ん中。表示の大きさを変えていないときだけ使う) か、
 * 画面の x 座標で指す。
 */
async function hintPixel(page: Page, at: { step?: number; clientX?: number; note: string; octave: number }): Promise<Rgba> {
    return wrap(page).evaluate(async (el, { step, clientX, row, stepWidth }) => {
        const canvas = el.querySelector('canvas')!;
        const layer = el.querySelector('#note-layer') as HTMLElement;
        const noteHeight = layer.getBoundingClientRect().height / (9 * 12);
        const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let y = (row + 0.5) * noteHeight - el.scrollTop;
        if (y < 2 || y > canvas.height - 2) {
            el.scrollTop = Math.max(0, (row + 0.5) * noteHeight - el.clientHeight / 2);
            // スクロールすると描き直す。描き直しが済むまで待つ
            await frame();
            y = (row + 0.5) * noteHeight - el.scrollTop;
        }
        const x = clientX !== undefined
            ? clientX - canvas.getBoundingClientRect().left
            : ((step ?? 0) + 0.5) * stepWidth - el.scrollLeft;
        if (x < 0 || x >= canvas.width) throw new Error(`見えている範囲の外の位置です (x = ${x})`);
        const [r, g, b, a] = canvas.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return { r, g, b, a };
    }, { step: at.step, clientX: at.clientX, row: rowOf(at.note, at.octave), stepWidth: STEP_WIDTH });
}

/** 青緑 (コードの音の色) の画素か。 */
const isTeal = (p: Rgba) => p.a > 0 && p.g > p.r + 40 && p.b > p.r + 40;
/** 金色 (キーの音の色) の画素か。 */
const isGold = (p: Rgba) => p.a > 0 && p.r > p.b + 40 && p.g > p.b + 20;

/** 曲を取り込み、パートに分けて、アレンジの画面で「ベース」のトラックをピアノロールで開く。 */
async function openBassInArrange(page: Page): Promise<void> {
    await importSong(page, { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(SONG_MP3) });
    await expect(statusText(page)).toContainText('カルテを作りました');
    await openTab(page, '曲とパート');
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました');
    await page.locator('#tracks-container .track-name', { hasText: 'ベース' }).click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('ベース');
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
}

test('カルテの在る曲でピアノロールを開くと、キーの音とコードの音の行に色が付く。切り替えで消え、選んだ状態は再読み込みしても残る', async ({ page }) => {
    await fakePracticeBackend(page);
    await openDaw(page);
    await openBassInArrange(page);

    // 既定は、どちらも出す。出しているものは、グリッドの枠から読める
    await expect(keyToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(chordToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(wrap(page)).toHaveAttribute('data-key-hint', 'C major');
    await expect(wrap(page)).toHaveAttribute('data-chord-hint', '8');
    // 説明に、どのキーで塗っているかと、カルテの確信度が出る (どの色が何かも、ここで分かる)
    await expect(keyToggle(page)).toHaveAttribute('data-tip', /カルテのキー（C メジャー。確信度は「確実」）.*金色.*押すと消します/);
    await expect(chordToggle(page)).toHaveAttribute('data-tip', /青緑.*押すと消します/);

    // 鍵盤の列: C は主音、D は音階の音、C# は音階の外。説明にも出る
    await expect(pianoKey(page, 'C', 2)).toHaveClass(/key-tonic/);
    await expect(pianoKey(page, 'C', 2)).toHaveAttribute('data-tip', /キー（C メジャー）の主音です/);
    await expect(pianoKey(page, 'D', 2)).toHaveClass(/in-key/);
    await expect(pianoKey(page, 'D', 2)).not.toHaveClass(/key-tonic/);
    await expect(pianoKey(page, 'D', 2)).toHaveAttribute('data-tip', /音階に入る音です/);
    await expect(pianoKey(page, 'C#', 2)).not.toHaveClass(/in-key/);
    await expect(page.locator('#piano-keys .piano-key.in-key')).toHaveCount(9 * 7);
    await expect(page.locator('#piano-keys .piano-key.key-tonic')).toHaveCount(9);

    // グリッド: 1 小節目は C (C・E・G)。D は音階の音 (金色) で、コードの音ではない。C# は、どちらでもない (黒鍵の行の暗さだけ)
    expect(isGold(await hintPixel(page, { step: 2, note: 'D', octave: 2 }))).toBe(true);
    const sharp = await hintPixel(page, { step: 2, note: 'C#', octave: 2 });
    expect([sharp.r, sharp.g, sharp.b]).toEqual([0, 0, 0]);

    // いちばん濃く重なる行 (主音で、コードのルートでもある C。1 小節目) の上でも、ノートとお手本の縁が読める (4.5:1 以上)
    const strongest = await hintPixel(page, { step: 2, note: 'C', octave: 2 });
    const contrast = await page.evaluate((p) => {
        const parse = (text: string) => {
            const hex = /^#([0-9a-f]{6})$/i.exec(text.trim());
            if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
            return (text.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        };
        const luminance = (rgb: number[]) => {
            const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (x: number[], y: number[]) => {
            const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m);
            return (hi + 0.05) / (lo + 0.05);
        };
        const root = getComputedStyle(document.documentElement);
        const base = parse(getComputedStyle(document.querySelector('#piano-roll-area')!).backgroundColor);
        const alpha = p.a / 255;
        const row = [p.r, p.g, p.b].map((v, i) => v * alpha + base[i] * (1 - alpha));
        return {
            note: ratio(parse(root.getPropertyValue('--accent')), row),
            ghost: ratio(parse(root.getPropertyValue('--ghost')), row),
        };
    }, strongest);
    expect(contrast.note).toBeGreaterThanOrEqual(4.5);
    expect(contrast.ghost).toBeGreaterThanOrEqual(4.5);

    // 「キーの音」を消すと、音階の行の色と鍵盤のしるしが消える。コードの音は残る
    await keyToggle(page).click();
    await expect(keyToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(wrap(page)).not.toHaveAttribute('data-key-hint');
    await expect(page.locator('#piano-keys .piano-key.in-key')).toHaveCount(0);
    expect((await hintPixel(page, { step: 2, note: 'D', octave: 2 })).a).toBe(0);
    // 1 小節目 (C) の E と G は青緑。2 小節目 (Am) では G は塗らず、A (ルート) は C (コードの音) より濃い
    expect(isTeal(await hintPixel(page, { step: 2, note: 'E', octave: 2 }))).toBe(true);
    expect(isTeal(await hintPixel(page, { step: 2, note: 'G', octave: 2 }))).toBe(true);
    expect((await hintPixel(page, { step: 2, note: 'A', octave: 2 })).a).toBe(0);
    expect((await hintPixel(page, { step: 18, note: 'G', octave: 2 })).a).toBe(0);
    const root = await hintPixel(page, { step: 18, note: 'A', octave: 2 });
    const tone = await hintPixel(page, { step: 18, note: 'C', octave: 3 });
    expect(isTeal(root)).toBe(true);
    expect(isTeal(tone)).toBe(true);
    expect(root.a).toBeGreaterThan(tone.a);
    // 高さは、どのオクターブでも同じ (行ごとに塗る)
    expect(isTeal(await hintPixel(page, { step: 2, note: 'E', octave: 5 }))).toBe(true);

    // 「コードの音」も消すと、何も塗らない。ノートとお手本は、そのまま
    await chordToggle(page).click();
    await expect(chordToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(wrap(page)).not.toHaveAttribute('data-chord-hint');
    expect((await hintPixel(page, { step: 2, note: 'E', octave: 2 })).a).toBe(0);
    expect((await hintPixel(page, { step: 18, note: 'A', octave: 2 })).a).toBe(0);
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);

    // 再読み込みしても、選んだ状態 (どちらも出さない) を覚えている
    await page.reload();
    await page.getByText('準備完了').waitFor();
    await openBassInArrange(page);
    await expect(keyToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(chordToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(wrap(page)).not.toHaveAttribute('data-key-hint');
    await expect(wrap(page)).not.toHaveAttribute('data-chord-hint');
    expect((await hintPixel(page, { step: 2, note: 'E', octave: 2 })).a).toBe(0);

    // もう一度押すと、また出る
    await keyToggle(page).click();
    await expect(wrap(page)).toHaveAttribute('data-key-hint', 'C major');
    const scaleRow = await hintPixel(page, { step: 2, note: 'D', octave: 2 });
    const tonicRow = await hintPixel(page, { step: 2, note: 'C', octave: 2 });
    expect(isGold(scaleRow)).toBe(true);
    expect(isGold(tonicRow)).toBe(true);
    // 主音の行は、音階のほかの行より濃い
    expect(tonicRow.a).toBeGreaterThan(scaleRow.a);
    // キーボードでも切り替えられる (「コードの音」にフォーカスを置いて、Enter で押す)。
    // Tab で隣へ移る形にはしない: WebKit は、ボタンを押してもフォーカスが移らず、Tab もボタンを飛ばす。
    // Space にしない: 直前の操作がマウスだと、Space は再生の切り替えになる (lib/keys.ts。Tab で来たときだけボタンに届く)
    await chordToggle(page).focus();
    await expect(chordToggle(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(chordToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(wrap(page)).toHaveAttribute('data-chord-hint', '8');
    expect(isTeal(await hintPixel(page, { step: 18, note: 'A', octave: 2 }))).toBe(true);
});

test('練習画面でも同じ切り替えが出る。行の色の左端は「コード」の段のコードとそろい、広げても、スクロールしても、ずれない', async ({ page }) => {
    await fakePracticeBackend(page);
    await openDaw(page);
    await openBassPractice(page);

    const region = page.getByRole('region', { name: '練習画面' });
    await expect(region).toBeVisible();
    await expect(keyToggle(page)).toBeVisible();
    await expect(chordToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(wrap(page)).toHaveAttribute('data-key-hint', 'C major');
    await expect(wrap(page)).toHaveAttribute('data-chord-hint', '8');

    // コードの音だけにして、2 小節目 (Am) の始まりを見る。A は Am のルートで、1 小節目 (C) の音ではない
    await keyToggle(page).click();
    await expect(wrap(page)).not.toHaveAttribute('data-key-hint');
    const edge = async () => {
        const x = await page.locator('.band-chord[data-bar="2"]').evaluate((el) => el.getBoundingClientRect().left);
        const before = await hintPixel(page, { clientX: x - 4, note: 'A', octave: 2 });
        const after = await hintPixel(page, { clientX: x + 4, note: 'A', octave: 2 });
        return `${before.a === 0 ? '手前は塗らない' : '手前も塗っている'} / ${isTeal(after) ? '先は青緑' : '先を塗っていない'}`;
    };
    await expect(page.locator('.band-chord[data-bar="2"]')).toHaveText('Am');
    await expect.poll(edge).toBe('手前は塗らない / 先は青緑');
    await page.getByRole('button', { name: '横に広げる' }).click();
    await expect.poll(edge).toBe('手前は塗らない / 先は青緑');
    await wrap(page).evaluate((el) => { el.scrollLeft = 120; });
    await expect.poll(edge).toBe('手前は塗らない / 先は青緑');
    await page.getByRole('button', { name: '縦に広げる' }).click();
    await expect.poll(edge).toBe('手前は塗らない / 先は青緑');

    // お手本と、置いたノートは、色の層の上にそのまま見える (選べる・比べられる)
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    // 2 小節目の頭のお手本 (A2。横にスクロールした後も見えている) と同じ位置に置く
    const ghost = (await page.locator('#note-layer .note-ghost').nth(4).boundingBox())!;
    await page.mouse.dblclick(ghost.x + 4, ghost.y + ghost.height / 2);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
    await page.locator('#note-layer .note-block').click();
    await expect(page.locator('#note-layer .note-block')).toHaveClass(/selected/);

    // アレンジに戻っても、選んだ状態 (キーの音は出さない) のまま
    await page.getByRole('button', { name: '← アレンジに戻る' }).click();
    await expect(region).toHaveCount(0);
    await expect(keyToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(wrap(page)).toHaveAttribute('data-chord-hint', '8');
});

test('カルテが無い (自由に作る) と、切り替えは押せず、どうすれば使えるかが説明に出る', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');

    await expect(keyToggle(page)).toBeDisabled();
    await expect(chordToggle(page)).toBeDisabled();
    await expect(wrap(page)).not.toHaveAttribute('data-key-hint');
    await expect(wrap(page)).not.toHaveAttribute('data-chord-hint');
    await expect(page.locator('#piano-keys .piano-key.in-key')).toHaveCount(0);
    expect((await hintPixel(page, { step: 2, note: 'E', octave: 4 })).a).toBe(0);

    await keyToggle(page).hover({ force: true });
    await expect(tooltip(page)).toContainText('曲を取り込んでカルテを作ると');
    await chordToggle(page).hover({ force: true });
    await expect(tooltip(page)).toContainText('曲を取り込んでカルテを作ると');
    // 見出しの行に収まっている (ピアノロールの外へはみ出さない)
    const area = (await page.locator('#piano-roll-area').boundingBox())!;
    const group = (await page.getByRole('group', { name: 'キーの音とコードの音の色分け' }).boundingBox())!;
    expect(group.x + group.width).toBeLessThanOrEqual(area.x + area.width);
});

test('キーを判定できなかった曲では「キーの音」だけ押せず、コードの音は出る', async ({ page }) => {
    await fakeJob(page, '/api/chart', () => {
        const response = fakeChart();
        return { ...response, chart: { ...response.chart, key: { tonic: null, mode: null, confidence: 0, alternatives: [] }, unavailable: { key: 'キーを判定できませんでした' } } };
    });
    await page.route('**/api/chart/song/guide*', (route) => route.fulfill({ json: { saved: false } }));
    await openDaw(page);
    await importSong(page, { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(SONG_MP3) });
    await expect(statusText(page)).toContainText('カルテを作りました');
    await page.locator('#tracks-container .track-name', { hasText: '原曲' }).click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('原曲');

    await expect(keyToggle(page)).toBeDisabled();
    await expect(keyToggle(page)).toHaveAttribute('data-tip', /キーを判定できなかった/);
    await expect(chordToggle(page)).toBeEnabled();
    await expect(wrap(page)).not.toHaveAttribute('data-key-hint');
    await expect(wrap(page)).toHaveAttribute('data-chord-hint', '8');
    // 取り込んだ曲のグリッド (1 小節目が 0.75 秒) で、1 小節目の C の音 (E) が塗られる
    expect(DOWNBEAT).toBeGreaterThan(0);
    expect(isTeal(await hintPixel(page, { step: 2, note: 'E', octave: 4 }))).toBe(true);
    expect((await hintPixel(page, { step: 2, note: 'D', octave: 4 })).a).toBe(0);
});

test('ドラムのトラックでは色を付けず、切り替えは押せない。ほかのトラックに移ると、また出る', async ({ page }) => {
    await fakePracticeBackend(page);
    // パート分離の応答に、ドラムを足す (あとから仕掛けた差し替えが先に使われる)
    const stem = (extra: object) => ({ gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [], drum_events: [], ...extra });
    await fakeJob(page, '/api/decompose', () => ({
        bpm: 120,
        grid_offset_sec: DOWNBEAT,
        stems: {
            bass: stem({ audio_url: '/api/download/decompose_bass_song.mp3', notes: BASS }),
            drums: stem({
                audio_url: '/api/download/decompose_drums_song.mp3',
                drum_events: [{ type: 'kick', step: 0, velocity: 100 }, { type: 'snare', step: 4, velocity: 100 }, { type: 'hihat', step: 8, velocity: 80 }],
            }),
        },
    }));
    await page.route('**/api/download/decompose_drums_*', (route) => route.fulfill({ contentType: 'audio/wav', body: makeWav(10, [80], 22050) }));
    await openDaw(page);
    await openBassInArrange(page);
    await expect(wrap(page)).toHaveAttribute('data-key-hint', 'C major');

    await page.locator('#tracks-container .track-name', { hasText: 'ドラム' }).click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('ドラム');
    // ドラムの打音は、お手本になる (打ち込みは空)
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(3);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);
    await expect(keyToggle(page)).toBeDisabled();
    await expect(chordToggle(page)).toBeDisabled();
    await expect(keyToggle(page)).toHaveAttribute('data-tip', /ドラムのトラックでは/);
    await expect(wrap(page)).not.toHaveAttribute('data-key-hint');
    await expect(wrap(page)).not.toHaveAttribute('data-chord-hint');
    await expect(page.locator('#piano-keys .piano-key.in-key')).toHaveCount(0);
    // キック (C2) の行にも、色は付かない
    expect((await hintPixel(page, { step: 2, note: 'C', octave: 2 })).a).toBe(0);
    // 押せないあいだも、選んだ状態 (出す) は変わらない
    await expect(keyToggle(page)).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#tracks-container .track-name', { hasText: 'ベース' }).click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('ベース');
    await expect(keyToggle(page)).toBeEnabled();
    await expect(wrap(page)).toHaveAttribute('data-key-hint', 'C major');
    await expect(wrap(page)).toHaveAttribute('data-chord-hint', '8');
});
