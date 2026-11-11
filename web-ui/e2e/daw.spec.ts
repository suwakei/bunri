/**
 * DAW の画面 (/) の基本操作。
 */
import { expect, test } from '@playwright/test';
import { openDaw } from './helpers';

test('初めて開くと案内が出て、閉じると次からは出ない', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#guide-overlay')).toBeVisible();
    await page.getByRole('button', { name: 'はじめる' }).click();
    await expect(page.locator('#guide-overlay')).toHaveCount(0);
    await page.reload();
    await page.getByText('準備完了').waitFor();
    await expect(page.locator('#guide-overlay')).toHaveCount(0);
});

test('画面が出て、トラックが 2 本在り、API とつながっている', async ({ page }) => {
    const gm = page.waitForResponse((r) => r.url().endsWith('/api/gm-instruments') && r.ok());
    await openDaw(page);
    await gm;
    await expect(page.locator('#tracks-container .track-name')).toHaveCount(2);
    for (const label of ['保存', '読込', '書出', 'MIDI']) {
        await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
});

test('トラックを選んでピアノロールをダブルクリックすると、ノートが入る', async ({ page }) => {
    await openDaw(page);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);
    await page.locator('#note-layer').dblclick({ position: { x: 90, y: 200 } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
    // トラックの見出しにも、ノートの数が出る
    await expect(page.locator('#tracks-container .track-name').first()).toContainText('1');
});

test('トラックを追加できる', async ({ page }) => {
    await openDaw(page);
    await page.getByRole('button', { name: '+ トラック追加' }).click();
    await expect(page.locator('#tracks-container .track-name')).toHaveCount(3);
});

test('ノートを置いて MIDI を書き出すと、標準 MIDI ファイルが落ちてくる', async ({ page }) => {
    await openDaw(page);
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 200 } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'MIDI', exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('bunri.mid');
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).subarray(0, 4).toString('latin1')).toBe('MThd');
});

test('ノートが無いときに MIDI を押すと、書き出さずに理由を出す', async ({ page }) => {
    await openDaw(page);
    await page.getByRole('button', { name: 'MIDI', exact: true }).click();
    await expect(page.getByText('書き出すノートがありません')).toBeVisible();
});

test('カルテのタブは、解析前なら案内を出す', async ({ page }) => {
    await openDaw(page);
    await page.locator('#panel-tabs').getByText('カルテ').click();
    await expect(page.getByText('まだ解析していません')).toBeVisible();
    await expect(page.getByText('お手本になるトラックがまだありません')).toBeVisible();
});
