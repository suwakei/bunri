/**
 * 楽曲カルテ (第1層) を、ファイルの読み込みから表示まで通す。
 * 解析は API サーバ側で実際に走る (数秒)。
 */
import { expect, test } from '@playwright/test';
import { makeWav, openDaw } from './helpers';

test('音声ファイルを解析すると、カルテにテンポとキーが出て、再現ガイドと差分チェックの欄が出る', async ({ page }) => {
    await openDaw(page);
    await page.locator('#panel-tabs').getByText('ファイル').click();

    // C4 E4 G4 C5 を 2 秒ずつ
    const wav = makeWav(8, [261.63, 329.63, 392.0, 523.25]);
    await page.locator('#file-panel input[type="file"]').first().setInputFiles({ name: 'e2e-song.wav', mimeType: 'audio/wav', buffer: wav });
    const analyzed = page.waitForResponse((r) => r.url().endsWith('/api/chart'), { timeout: 60_000 });
    await page.locator('#file-panel').getByRole('button', { name: /カルテ/ }).click();
    expect((await analyzed).status()).toBe(200);

    await page.locator('#panel-tabs').getByText('カルテ').click();
    const chart = page.locator('#chart-panel');
    await expect(chart).toContainText('e2e-song.wav');
    await expect(chart).toContainText('BPM');
    await expect(chart.getByText('グリッド', { exact: true })).toBeVisible();

    // 第2層と第3層の欄
    await expect(page.locator('#guide-panel')).toContainText('再現ガイド');
    await expect(page.locator('#guide-panel')).toContainText('Anthropic の Claude に送ります。音声は送りません');
    await expect(page.locator('#coach-panel')).toContainText('差分チェック');
});
