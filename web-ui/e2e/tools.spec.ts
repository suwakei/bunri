/**
 * ツールの画面 (/tools) と使い方の画面 (/help)。
 */
import { expect, test } from '@playwright/test';
import { makeWav } from './helpers';

test('ツールの画面で WAV を選ぶと、API が読み取った情報が出る', async ({ page }) => {
    await page.goto('/tools');
    await page.getByText('WAV最適化', { exact: true }).click();
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

test('深層分離では「ドラムをさらに分ける」を選べて、その指定が API に渡る', async ({ page }) => {
    // 本物の分離は数分かかるので、API の応答だけを差し替える。見るのは画面から API までのつなぎ
    const bodies: string[] = [];
    await page.route('**/api/deep-separate', async (route) => {
        bodies.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
        await route.fulfill({
            json: {
                drums: { url: '/api/download/none-drums.wav', label: 'ドラム・パーカッション' },
                drums_kick: { url: '/api/download/none-kick.wav', label: 'ドラム → キック' },
            },
        });
    });
    await page.goto('/tools');
    await page.getByRole('button', { name: '音源分離', exact: true }).click();

    // 2 分割やフル分割では出ない。深層分離を選ぶと、チェックの入った状態で出る
    await expect(page.locator('#sep-split-drums')).toHaveCount(0);
    await page.locator('#sep-mode').selectOption('deep');
    const splitDrums = page.getByLabel(/ドラムをさらに分ける/);
    await expect(splitDrums).toBeChecked();

    await page.locator('#sep-file').setInputFiles({ name: 'e2e-deep.wav', mimeType: 'audio/wav', buffer: makeWav(0.5) });
    await page.getByRole('button', { name: '音源分離を開始' }).click();
    await expect(page.getByText('分離完了！2個のレイヤーに分割されました')).toBeVisible();
    await expect(page.getByText('ドラム → キック')).toBeVisible();
    expect(bodies[0]).toMatch(/name="split_drums"\r\n\r\ntrue\r\n/);

    // チェックを外すと、分けない指定で送られる
    await splitDrums.uncheck();
    await page.getByRole('button', { name: '音源分離を開始' }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatch(/name="split_drums"\r\n\r\nfalse\r\n/);
});
