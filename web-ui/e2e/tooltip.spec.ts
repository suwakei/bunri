/**
 * ツールチップ（マウスを載せた要素のそばに出す説明）。
 * すぐ出ること、出る場所（画面の外に出ない・操作する場所を隠さない）、押したら消えること。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openDaw, startFree, openTab, statusText } from './helpers';

const tooltip = (page: Page) => page.locator('#bunri-tooltip');

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
    const b = await locator.boundingBox();
    if (!b) throw new Error('要素が見えていません');
    return b;
}

/** 2 つの四角が重なっているか。 */
function overlaps(a: Box, b: Box): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** ツールチップが、画面の端から 8px 以上内側に収まっているか。 */
async function expectInsideViewport(page: Page) {
    const tip = await box(tooltip(page));
    const view = page.viewportSize()!;
    expect(tip.x).toBeGreaterThanOrEqual(8);
    expect(tip.y).toBeGreaterThanOrEqual(8);
    expect(tip.x + tip.width).toBeLessThanOrEqual(view.width - 8 + 0.5);
    expect(tip.y + tip.height).toBeLessThanOrEqual(view.height - 8 + 0.5);
}

test('ヘッダのボタンに載せると、すぐ下に説明が出る (ボタンは隠さない)', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    const save = page.getByRole('button', { name: '保存', exact: true });
    await save.hover();
    // 0.15 秒ほどで出る (標準の title のように 1 秒待たせない)
    await expect(tooltip(page)).toBeVisible({ timeout: 1000 });
    await expect(tooltip(page)).toContainText('テンポ・トラック・ノートを保存します');
    const tip = await box(tooltip(page));
    const button = await box(save);
    expect(tip.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(overlaps(tip, button)).toBe(false);
    await expectInsideViewport(page);
    // 読み上げでも説明として読まれる
    await expect(save).toHaveAttribute('aria-describedby', /bunri-tooltip/);
});

test('画面の右端のリンクでも、説明は画面の中に収まる', async ({ page }) => {
    await openDaw(page);
    await page.getByRole('link', { name: '使い方', exact: true }).hover();
    await expect(tooltip(page)).toBeVisible();
    await expectInsideViewport(page);
});

test('左パネルの欄の説明は、パネルの外 (右) に出て、パネルの中を隠さない', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await openTab(page, 'ドラム');
    await page.locator('#drum-pattern').hover();
    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toContainText('叩き方の型');
    const panel = await box(page.locator('#left-panel'));
    const tip = await box(tooltip(page));
    expect(tip.x).toBeGreaterThanOrEqual(panel.x + panel.width);
    await expectInsideViewport(page);
});

test('ラベルに載せても、その欄の説明が出る', async ({ page }) => {
    await openDaw(page);
    await page.locator('label[for="transport-bpm"]').hover();
    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toContainText('曲の速さ');
});

test('トラックの M・S の説明は、見出しの外に出て、隣のボタンを隠さない', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    const header = page.locator('#tracks-container .track-header').first();
    await header.locator('.btn-mute').hover();
    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toContainText('ミュート');
    const tip = await box(tooltip(page));
    const head = await box(header);
    expect(tip.x).toBeGreaterThanOrEqual(head.x + head.width);
    // 隣の要素へ移ると、待たずに切り替わる
    await header.locator('.btn-solo').hover();
    await expect(tooltip(page)).toContainText('ソロ');
});

test('押すと消え、同じボタンの上に居るあいだは出し直さない', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    const metronome = page.getByRole('button', { name: 'メトロノーム', exact: true });
    await metronome.hover();
    await expect(tooltip(page)).toBeVisible();
    await metronome.click();
    await expect(tooltip(page)).toBeHidden();
    // 少し動かしても出ない
    const b = await box(metronome);
    await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 1);
    await page.waitForTimeout(400);
    await expect(tooltip(page)).toBeHidden();
    // 一度外へ出て戻ると、また出る (押した後の状態の説明になっている)
    await page.mouse.move(b.x + b.width / 2, b.y + 200);
    await metronome.hover();
    await expect(tooltip(page)).toContainText('クリック音を止めます');
});

test('Esc で消える', async ({ page }) => {
    await openDaw(page);
    await page.getByRole('button', { name: '停止', exact: true }).hover();
    await expect(tooltip(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip(page)).toBeHidden();
});

test('画面の下のほうの要素では、説明は上に出る', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await openDaw(page);
    await startFree(page);
    const follow = page.locator('#follow-playhead input');
    await follow.hover();
    await expect(tooltip(page)).toBeVisible();
    const tip = await box(tooltip(page));
    const el = await box(follow);
    expect(tip.y + tip.height).toBeLessThanOrEqual(el.y);
    await expectInsideViewport(page);
});

test('キーボードで選んだときにも出て、次へ移ると切り替わる', async ({ page, browserName }) => {
    await openDaw(page);
    await page.locator('#transport-bpm').focus();
    await expect(tooltip(page)).toContainText('曲の速さ');
    // Tab で次へ移ると、移った先の説明になる
    // (Safari / WebKit の Tab は文字の欄にしか移らない。ボタンや選択の欄へは Option+Tab で移る)
    const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(next);
    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toContainText('1 小節に入る拍の数');
    await page.keyboard.press(next);
    await expect(tooltip(page)).toContainText('いまの再生位置から鳴らします');
});

test('ステータスバーの短い知らせには、説明を出さない (切れていないので)', async ({ page }) => {
    await openDaw(page);
    expect(await statusText(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
    await statusText(page).hover();
    await page.waitForTimeout(400);
    await expect(tooltip(page)).toBeHidden();
});
