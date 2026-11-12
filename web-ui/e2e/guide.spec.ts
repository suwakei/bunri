/**
 * 再現ガイド (第2層) を、本物の Claude で通す。
 *
 * Claude の API を実際に呼ぶので、費用がかかる (1 回あたり 10 円前後、数十秒)。
 * 普段は走らせず、環境変数 BUNRI_E2E_LLM=1 を付けたときだけ走る:
 *
 *   BUNRI_E2E_LLM=1 npx playwright test e2e/guide.spec.ts --project=chromium
 *
 * API キーは、API サーバが環境変数 (ANTHROPIC_API_KEY / CLAUDE_API_KEY) かリポジトリ直下の .env から読む。
 */
import { expect, test } from '@playwright/test';
import { importSong, makeWav, openDaw, openTab } from './helpers';

test.skip(!process.env.BUNRI_E2E_LLM, 'Claude の API を実際に呼ぶテスト。BUNRI_E2E_LLM=1 で有効にする');

test('カルテから再現ガイドを作ると、手順とカルテ上の場所が出る', async ({ page }) => {
    test.setTimeout(240_000);
    await openDaw(page);
    const wav = makeWav(16, [261.63, 196.0, 220.0, 174.61, 261.63, 196.0, 220.0, 174.61]);
    const analyzed = page.waitForResponse((r) => r.url().endsWith('/api/chart'), { timeout: 60_000 });
    await importSong(page, { name: 'e2e-guide.wav', mimeType: 'audio/wav', buffer: wav });
    expect((await analyzed).status()).toBe(200);

    await openTab(page, 'ガイド');
    const panel = page.locator('#guide-panel');
    const guide = page.waitForResponse((r) => /\/api\/chart\/[^/]+\/guide$/.test(r.url()), { timeout: 180_000 });
    await panel.getByRole('button', { name: 'ガイドを作る' }).click();
    await expect(panel.getByRole('button', { name: /作成中/ })).toBeDisabled();
    const response = await guide;
    expect(response.status(), await response.text()).toBe(200);

    // 手順が並び、作り直しのボタンに変わる
    await expect(panel.getByRole('button', { name: 'ガイドを作り直す' })).toBeVisible();
    expect(await panel.locator('ol > li').count()).toBeGreaterThanOrEqual(3);
    // カルテ上の場所 (小節やセクション) が 1 つは添えられている
    expect(await panel.locator('.guide-ref').count()).toBeGreaterThan(0);
    await expect(panel.getByText(/^作成: claude-/)).toBeVisible();
    // 出来上がりを目で確かめられるよう、パネルの画像を結果に添える
    await test.info().attach('guide-panel', { body: await panel.screenshot(), contentType: 'image/png' });
});
