/**
 * ピアノロール: スクロールしても正しい位置に入ること、曲の長さに合わせて伸びること、
 * 音域 (C0〜B8) の端の音も扱えること。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { openDaw } from './helpers';

const STEP_WIDTH = 20;
const NOTE_HEIGHT = 14;
/** 音域は C0〜B8 の 9 オクターブ。一番上の行が B8 で、12 行で 1 オクターブ下がる。 */
const TOTAL_ROWS = 9 * 12;
const NOTE_NAMES = ['B', 'A#', 'A', 'G#', 'G', 'F#', 'F', 'E', 'D#', 'D', 'C#', 'C'];
/** 音の名前とオクターブから、行 (0 が一番上) を出す。 */
const rowOf = (name: string, octave: number) => (8 - octave) * 12 + NOTE_NAMES.indexOf(name);

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });

/** ノート入りのプロジェクトを API で保存し、画面の「読込」で読み込む。 */
async function loadProjectWithNotes(page: Page, request: APIRequestContext, tracks: ReturnType<typeof note>[][]) {
    const project = {
        bpm: 120, beatsPerBar: 4,
        tracks: tracks.map((pianoNotes, i) => ({ name: `Track ${i + 1}`, pianoNotes })),
        automation: {},
    };
    expect((await request.post('/api/project/save', { form: { data: JSON.stringify(project) } })).ok()).toBe(true);
    await openDaw(page);
    await page.getByRole('button', { name: '読込', exact: true }).click();
    await expect(page.getByText(/を読み込みました/)).toBeVisible();
}

/** ノートが、ピアノロールの見えている範囲の中に在るか。 */
async function isInView(page: Page, selector: string) {
    const wrap = (await page.locator('#piano-grid-wrap').boundingBox())!;
    const box = (await page.locator(selector).first().boundingBox())!;
    return box.y >= wrap.y && box.y + box.height <= wrap.y + wrap.height;
}

async function openPianoRoll(page: Page) {
    await openDaw(page);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');
}

/** 置かれたノートの説明 (例: "C4 step:8 len:4") を全部返す。 */
const noteTitles = (page: Page) => page.locator('#note-layer .note-block').evaluateAll((els) => els.map((el) => (el as HTMLElement).title));

/** ピアノロールのスクロール位置を変える。 */
async function scrollTo(page: Page, left: number, top: number) {
    await page.locator('#piano-grid-wrap').evaluate((el, [l, t]) => { el.scrollLeft = l; el.scrollTop = t; }, [left, top]);
}

test('最初は 8 小節ぶんで、グリッドの下に空の領域が無い', async ({ page }) => {
    await openPianoRoll(page);
    const size = await page.locator('#piano-grid-wrap').evaluate((el) => ({ w: el.scrollWidth, h: el.scrollHeight }));
    expect(size.w).toBe(128 * STEP_WIDTH);
    // 9 オクターブ × 12 音。ノートを置く層の高さと同じで、余分な領域が無い
    expect(size.h).toBe(TOTAL_ROWS * NOTE_HEIGHT);
});

test('最初は、真ん中のド (C4) のあたりが見えている', async ({ page }) => {
    await openPianoRoll(page);
    // 鍵盤の列の中で、C4 の鍵盤が見えている範囲に入っている
    const visible = await page.evaluate(() => {
        const keys = document.querySelector('#piano-keys')!;
        const area = keys.getBoundingClientRect();
        const c4 = [...keys.querySelectorAll('.piano-key')].find((k) => k.textContent === 'C4')!.getBoundingClientRect();
        return c4.top >= area.top && c4.bottom <= area.bottom;
    });
    expect(visible).toBe(true);
    // 鍵盤の列とグリッドの縦の位置がそろっている
    const [keysTop, gridTop] = await Promise.all([
        page.locator('#piano-keys').evaluate((el) => el.scrollTop),
        page.locator('#piano-grid-wrap').evaluate((el) => el.scrollTop),
    ]);
    expect(keysTop).toBe(gridTop);
    expect(gridTop).toBeGreaterThan(0);
});

test('縦横にスクロールしてからダブルクリックしても、押した場所にノートが入る', async ({ page }) => {
    await openPianoRoll(page);
    await scrollTo(page, 400, 210);
    const box = (await page.locator('#piano-grid-wrap').boundingBox())!;
    // 見えている範囲の (105, 49) = 曲の中では横 505px (25 ステップ目 → 4 つ刻みで 24)、縦 259px (18 行目)
    await page.mouse.dblclick(box.x + 105, box.y + 49);
    const [title] = await noteTitles(page);
    expect(title).toContain('step:24 ');
    // 18 行目: 一番上が B8 で、12 行で 1 オクターブ下がる → 18 行目は F7
    expect(title.startsWith('F7 ')).toBe(true);
});

test('音域の下の端 (ベースの E1、いちばん下の C0) にもノートを置ける', async ({ page }) => {
    await openPianoRoll(page);
    const box = (await page.locator('#piano-grid-wrap').boundingBox())!;

    // E1 の行が、見えている範囲の上から 50px のところに来るようにして、その行を押す
    await scrollTo(page, 0, rowOf('E', 1) * NOTE_HEIGHT - 50);
    await page.mouse.dblclick(box.x + 30, box.y + 50 + NOTE_HEIGHT / 2);
    expect((await noteTitles(page))[0].startsWith('E1 ')).toBe(true);

    // 一番下までスクロールして、最後の行 (C0) を押す
    await scrollTo(page, 0, TOTAL_ROWS * NOTE_HEIGHT);
    const top = await page.locator('#piano-grid-wrap').evaluate((el) => el.scrollTop);
    await page.mouse.dblclick(box.x + 130, box.y + (TOTAL_ROWS - 0.5) * NOTE_HEIGHT - top);
    expect((await noteTitles(page)).some((t) => t.startsWith('C0 '))).toBe(true);
});

test('低い音だけのトラックを開くと、ノートの在る高さへ移動する', async ({ page, request }) => {
    // Track 1: ベースの低い音だけ。Track 2: 真ん中のあたりと、ずっと高い音
    await loadProjectWithNotes(page, request, [
        [note('E', 1, 0), note('G', 1, 4), note('A', 1, 8)],
        [note('C', 4, 0), note('C', 8, 4)],
    ]);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(3);
    expect(await isInView(page, '#note-layer .note-block')).toBe(true);
    // 鍵盤の列も一緒に動いている
    expect(await page.locator('#piano-keys').evaluate((el) => el.scrollTop))
        .toBe(await page.locator('#piano-grid-wrap').evaluate((el) => el.scrollTop));

    // 別のトラックへ移ると、そのトラックのノートの在る高さへ移動する (真ん中の値の C4)
    await page.locator('#tracks-container .track-name').nth(1).click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(2);
    expect(await isInView(page, '#note-layer .note-block[title^="C4 "]')).toBe(true);

    // ノートが 1 つでも見えていれば、見ている場所は動かさない (同じトラックを開き直す)
    await scrollTo(page, 0, rowOf('C', 4) * NOTE_HEIGHT - 40);
    await page.locator('#tracks-container .track-name').nth(1).click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(2);
    expect(await page.locator('#piano-grid-wrap').evaluate((el) => el.scrollTop)).toBe(rowOf('C', 4) * NOTE_HEIGHT - 40);
});

test('一番下までスクロールしても、鍵盤の列とグリッドの行がそろっている', async ({ page }) => {
    await openPianoRoll(page);
    await scrollTo(page, 0, TOTAL_ROWS * NOTE_HEIGHT);
    const top = await page.locator('#piano-grid-wrap').evaluate((el) => el.scrollTop);
    await expect.poll(() => page.locator('#piano-keys').evaluate((el) => el.scrollTop)).toBe(top);
    // 一番下の鍵盤 (C0) の下端が、グリッドの最後の行の下端と同じ高さに在る
    const offset = await page.evaluate(() => {
        const keys = [...document.querySelectorAll('#piano-keys .piano-key')];
        const layer = document.querySelector('#note-layer')!.getBoundingClientRect();
        return Math.abs(keys[keys.length - 1].getBoundingClientRect().bottom - layer.bottom);
    });
    expect(offset).toBeLessThanOrEqual(1);
});

test('表示できる音域の外のノートは描かず、在ることを知らせる', async ({ page, request }) => {
    await loadProjectWithNotes(page, request, [[note('C', 4, 0), note('C', -1, 4), note('C', 9, 8)]]);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
    await expect(page.locator('#note-layer .note-out-of-range')).toHaveText('表示できる音域 (C0〜B8) の外に、ノートが 2 個あります');
    // 描かれたノートは、押して消せる (音域の外のノートが在っても、番号がずれない)
    await page.locator('#note-layer .note-block').click();
    await page.keyboard.press('Delete');
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);
    await expect(page.locator('#note-layer .note-out-of-range')).toContainText('2 個');
});

test('鍵盤の列が、グリッドと一緒に縦にスクロールする', async ({ page }) => {
    await openPianoRoll(page);
    await scrollTo(page, 0, 280);
    await expect.poll(() => page.locator('#piano-keys').evaluate((el) => el.scrollTop)).toBe(280);
    // 見えている一番上の鍵盤と、同じ高さのグリッドの行が一致する (280px ÷ 14px = 20 行目 = D#7)
    const topKey = await page.evaluate(() => {
        const keys = document.querySelector('#piano-keys')!;
        const top = keys.getBoundingClientRect().top;
        return [...keys.querySelectorAll('.piano-key')].find((k) => k.getBoundingClientRect().bottom > top + 1)!.textContent;
    });
    expect(topKey).toBe('D#7');
});

test('末尾の近くにノートを置くと、続きを打ち込めるよう先へ伸びる', async ({ page }) => {
    await openPianoRoll(page);
    const width = () => page.locator('#piano-grid-wrap').evaluate((el) => el.scrollWidth);
    expect(await width()).toBe(128 * STEP_WIDTH);

    // 8 小節目 (112〜127 ステップ) に置く
    await scrollTo(page, 128 * STEP_WIDTH, 0);
    const box = (await page.locator('#piano-grid-wrap').boundingBox())!;
    await page.mouse.dblclick(box.x + box.width - 30, box.y + 60);
    const [first] = await noteTitles(page);
    const step = Number(first.match(/step:(\d+)/)![1]);
    expect(step).toBeGreaterThanOrEqual(112);

    // 最後のノートの後ろに 4 小節ぶんの余白が出来る (8 小節 → 12 小節)
    await expect.poll(width).toBe(192 * STEP_WIDTH);

    // 伸びた先 (9 小節目以降) にも置ける
    await scrollTo(page, 192 * STEP_WIDTH, 0);
    await page.mouse.dblclick(box.x + box.width - 30, box.y + 100);
    const steps = (await noteTitles(page)).map((t) => Number(t.match(/step:(\d+)/)![1]));
    expect(Math.max(...steps)).toBeGreaterThanOrEqual(128);
    await expect.poll(width).toBeGreaterThan(192 * STEP_WIDTH);
});

test('ノートを消すと、長さが元に戻る', async ({ page }) => {
    await openPianoRoll(page);
    const width = () => page.locator('#piano-grid-wrap').evaluate((el) => el.scrollWidth);
    await scrollTo(page, 128 * STEP_WIDTH, 0);
    const box = (await page.locator('#piano-grid-wrap').boundingBox())!;
    await page.mouse.dblclick(box.x + box.width - 30, box.y + 60);
    await expect.poll(width).toBe(192 * STEP_WIDTH);
    await page.locator('#note-layer .note-block').click();
    await page.keyboard.press('Delete');
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);
    await expect.poll(width).toBe(128 * STEP_WIDTH);
});

test('グリッドが、スクロールした先でも描かれている', async ({ page }) => {
    await openPianoRoll(page);
    // 小節の線が描かれていれば、canvas のどこかに透明でない点が在る
    const painted = () => page.locator('#piano-grid-canvas').evaluate((canvas: HTMLCanvasElement) => {
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
        return count;
    });
    expect(await painted()).toBeGreaterThan(1000);
    await scrollTo(page, 1500, 300);
    await expect.poll(painted).toBeGreaterThan(1000);
    // canvas は見えている範囲の大きさで、曲全体の大きさではない
    const size = await page.locator('#piano-grid-canvas').evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
    expect(size.w).toBeLessThan(128 * STEP_WIDTH);
});
