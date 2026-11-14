/**
 * ツールの画面 (/tools) と使い方の画面 (/help)。
 */
import { expect, test } from '@playwright/test';
import { fakeJob, makeWav } from './helpers';

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
    await expect(page.getByText('曲を教材にして学ぶ（5 つの段階）').first()).toBeVisible();
});

test('「さらに細かく分ける」では「ドラムをさらに分ける」を選べて、その指定が API に渡る', async ({ page }) => {
    // 本物の分離は数分かかるので、ジョブの応答だけを差し替える。見るのは画面から API までのつなぎ
    const bodies: string[] = [];
    await fakeJob(page, '/api/deep-separate', () => ({
        drums: { url: '/api/download/none-drums.wav', label: 'ドラム・パーカッション' },
        drums_kick: { url: '/api/download/none-kick.wav', label: 'ドラム → キック' },
    }), (request) => { bodies.push(request.postDataBuffer()?.toString('latin1') ?? ''); });
    await page.goto('/tools');
    await page.getByRole('button', { name: 'パート分離', exact: true }).click();

    // 2 つに分ける・すべてのパートに分ける、では出ない。さらに細かく分けるを選ぶと、チェックの入った状態で出る
    await expect(page.locator('#sep-split-drums')).toHaveCount(0);
    await page.locator('#sep-mode').selectOption('deep');
    const splitDrums = page.getByLabel(/ドラムをさらに分ける/);
    await expect(splitDrums).toBeChecked();
    // 何が起きるかは、マウスを載せたときの説明で分かる (title 属性は使わない)
    const row = page.locator('label.check-row');
    await expect(row).toHaveAttribute('data-tip', /キック・スネア・タム・シンバル/);
    await expect(row).not.toHaveAttribute('title');

    await page.locator('#sep-file').setInputFiles({ name: 'e2e-deep.wav', mimeType: 'audio/wav', buffer: makeWav(0.5) });
    await page.getByRole('button', { name: 'パート分離を始める' }).click();
    await expect(page.getByText('2 個のパートに分けました')).toBeVisible();
    await expect(page.getByText('ドラム → キック')).toBeVisible();
    expect(bodies[0]).toMatch(/name="split_drums"\r\n\r\ntrue\r\n/);

    // チェックを外すと、分けない指定で送られる
    await splitDrums.uncheck();
    await page.getByRole('button', { name: 'パート分離を始める' }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatch(/name="split_drums"\r\n\r\nfalse\r\n/);

    // ほかの分け方に戻すと、選択は消える
    await page.locator('#sep-mode').selectOption('false');
    await expect(page.locator('#sep-split-drums')).toHaveCount(0);
});
