/**
 * ツールの画面 (/tools) と使い方の画面 (/help)。
 */
import { expect, test } from '@playwright/test';
import { makeWav } from './helpers';

test('ツールの画面で WAV を選ぶと、API が読み取った情報が出る', async ({ page }) => {
    await page.goto('/tools');
    await page.getByText('WAV 最適化', { exact: true }).click();
    const info = page.waitForResponse((r) => r.url().endsWith('/api/wav/info'));
    await page.locator('#opt-file').setInputFiles({ name: 'e2e-info.wav', mimeType: 'audio/wav', buffer: makeWav(1) });
    expect((await info).status()).toBe(200);
    await expect(page.getByText('22050Hz')).toBeVisible();
    await expect(page.getByText('1ch')).toBeVisible();
});

test('ファイル名に ../ を含むアップロードは、API が拒否する', async ({ request }) => {
    const resp = await request.post('/api/wav/info', {
        multipart: { file: { name: '../evil.wav', mimeType: 'audio/wav', buffer: makeWav(0.2) } },
    });
    expect(resp.status()).toBe(400);
});

test('使い方の画面が開く', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByText('クイックスタート').first()).toBeVisible();
});
