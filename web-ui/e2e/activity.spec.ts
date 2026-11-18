/**
 * 動きの記録 (ステータスバーの「記録」): 押したボタンと、その結果が、起きた順に並ぶこと。
 * ブラウザでは画面の中にだけ残る (ファイルに残すのはデスクトップ版。e2e-desktop/smoke.test.ts)。
 */
import { expect, test } from '@playwright/test';
import { openDaw, startFree, statusText } from './helpers';

test('「記録」を開くと、押したボタンと、その結果 (ステータスバーの文) が、起きた順に並ぶ', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.getByRole('button', { name: 'MIDI 書き出し', exact: true }).click();
    const result = (await statusText(page).textContent()) ?? '';
    expect(result).not.toBe('');

    const toggle = page.getByRole('button', { name: '記録', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByRole('region', { name: '動きの記録' });
    await expect(panel).toBeVisible();

    // 押したボタンのあとに、その結果 (ステータスバーの文) が並ぶ
    const rows = panel.locator('li');
    const texts = await rows.allTextContents();
    const clicked = texts.findIndex((t) => t.includes('操作') && t.includes('ボタン「MIDI 書き出し」'));
    const shown = texts.findIndex((t, i) => i > clicked && t.includes('状態') && t.includes(result));
    expect(clicked, texts.join('\n')).toBeGreaterThanOrEqual(0);
    expect(shown, texts.join('\n')).toBeGreaterThan(clicked);
    // 行の頭は時刻
    expect(texts[clicked]).toMatch(/^\d\d:\d\d:\d\d\.\d{3}/);
    // ブラウザでは、ファイルには残らない
    await expect(panel).toContainText('画面の中にだけ残ります');

    // 一覧は、窓の中に収まっている (ステータスバーの上)
    const box = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 28);
});

test('開いているあいだに起きたことも、すぐ下に増える。一覧の中の操作は記録しない', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.getByRole('button', { name: '記録', exact: true }).click();
    const panel = page.getByRole('region', { name: '動きの記録' });
    const rows = panel.locator('li');
    const before = await rows.count();

    // 一覧の中を押しても、行は増えない
    await panel.getByRole('heading', { name: '動きの記録' }).click();
    await expect(rows).toHaveCount(before);

    await page.getByRole('button', { name: 'MIDI 書き出し', exact: true }).click();
    await expect(rows.filter({ hasText: 'ボタン「MIDI 書き出し」' })).toHaveCount(1);
    // 新しい行が見えるところまで、付いていく
    await expect(rows.last()).toBeInViewport();

    await panel.getByRole('button', { name: '動きの記録を閉じる' }).click();
    await expect(panel).toBeHidden();
    // 閉じているあいだも、記録は続いている
    await page.getByRole('button', { name: 'MIDI 書き出し', exact: true }).click();
    await page.getByRole('button', { name: '記録', exact: true }).click();
    await expect(rows.filter({ hasText: 'ボタン「MIDI 書き出し」' })).toHaveCount(2);
});
