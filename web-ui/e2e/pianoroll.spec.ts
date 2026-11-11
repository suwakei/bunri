/**
 * ピアノロール: スクロールしても正しい位置に入ること、曲の長さに合わせて伸びること。
 */
import { expect, test, type Page } from '@playwright/test';
import { openDaw } from './helpers';

const STEP_WIDTH = 20;
const NOTE_HEIGHT = 14;

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
    // 5 オクターブ × 12 音。ノートを置く層の高さと同じで、余分な領域が無い
    expect(size.h).toBe(60 * NOTE_HEIGHT);
});

test('縦横にスクロールしてからダブルクリックしても、押した場所にノートが入る', async ({ page }) => {
    await openPianoRoll(page);
    await scrollTo(page, 400, 210);
    const box = (await page.locator('#piano-grid-wrap').boundingBox())!;
    // 見えている範囲の (105, 49) = 曲の中では横 505px (25 ステップ目 → 4 つ刻みで 24)、縦 259px (18 行目)
    await page.mouse.dblclick(box.x + 105, box.y + 49);
    const [title] = await noteTitles(page);
    expect(title).toContain('step:24 ');
    // 18 行目: 一番上が B6 で、12 行で 1 オクターブ下がる → 18 行目は F5
    expect(title.startsWith('F5 ')).toBe(true);
});

test('鍵盤の列が、グリッドと一緒に縦にスクロールする', async ({ page }) => {
    await openPianoRoll(page);
    await scrollTo(page, 0, 280);
    await expect.poll(() => page.locator('#piano-keys').evaluate((el) => el.scrollTop)).toBe(280);
    // 見えている一番上の鍵盤と、同じ高さのグリッドの行が一致する (280px ÷ 14px = 20 行目 = D#5)
    const topKey = await page.evaluate(() => {
        const keys = document.querySelector('#piano-keys')!;
        const top = keys.getBoundingClientRect().top;
        return [...keys.querySelectorAll('.piano-key')].find((k) => k.getBoundingClientRect().bottom > top + 1)!.textContent;
    });
    expect(topKey).toBe('D#5');
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
