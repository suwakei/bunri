/**
 * 再現ガイド (第2層) を、本物の Claude で通す (アシスタントのドックから。ルーター・アシスタント・ガイドの 3 種類を呼ぶ)。
 *
 * Claude の API を実際に呼ぶので、費用がかかる (1 回あたり 10〜20 円前後、数十秒)。
 * 普段は走らせず、環境変数 BUNRI_E2E_LLM=1 を付けたときだけ走る:
 *
 *   BUNRI_E2E_LLM=1 npx playwright test e2e/guide.spec.ts --project=chromium
 *
 * API キーは、API サーバが環境変数 (ANTHROPIC_API_KEY / CLAUDE_API_KEY) かリポジトリ直下の .env から読む。
 */
import { expect, test } from '@playwright/test';
import { assistantChat, assistantDock, importSong, makeWav, openDaw, openTab, runJob, waitAssistantTurns } from './helpers';

test.skip(!process.env.BUNRI_E2E_LLM, 'Claude の API を実際に呼ぶテスト。BUNRI_E2E_LLM=1 で有効にする');

test('「学ぶ」→「ガイド」のボタンで頼むと、アシスタントがガイドを作り、手順とカルテ上の場所がチャットのカードに出る', async ({ page }) => {
    test.setTimeout(300_000);
    await openDaw(page);
    const wav = makeWav(16, [261.63, 196.0, 220.0, 174.61, 261.63, 196.0, 220.0, 174.61]);
    const analyzed = await runJob(page, '/api/chart', () => importSong(page, { name: 'e2e-guide.wav', mimeType: 'audio/wav', buffer: wav }));
    expect(analyzed.state).toBe('done');

    await openTab(page, 'ガイド');
    const guide = page.waitForResponse((r) => /\/api\/chart\/[^/]+\/guide$/.test(r.url()) && r.request().method() === 'POST', { timeout: 240_000 });
    await page.locator('#guide-panel').getByRole('button', { name: 'アシスタントにガイドを頼む' }).click();
    await expect(assistantDock(page)).toBeVisible();
    const response = await guide;
    expect(response.status(), await response.text()).toBe(200);
    await waitAssistantTurns(page, 1, 'ガイドの依頼', 120_000);

    // 手順が並び、カルテ上の場所 (小節やセクション) が 1 つは添えられている
    const card = assistantChat(page).locator('.assistant-card.guide-card');
    await expect(card).toHaveCount(1);
    expect(await card.getByRole('list', { name: '再現の手順' }).locator(':scope > li').count()).toBeGreaterThanOrEqual(3);
    expect(await card.locator('.guide-ref').count()).toBeGreaterThan(0);
    await expect(card.getByText(/^作成: (Haiku|Sonnet|Opus)/)).toBeVisible();
    // 依頼の終わりの行に、答えたモデル
    await expect(assistantChat(page).locator('.assistant-turn-model')).toHaveText(/Haiku|Sonnet|Opus/);
    // 出来上がりを目で確かめられるよう、ドックの画像を結果に添える
    await test.info().attach('guide-card', { body: await assistantDock(page).screenshot(), contentType: 'image/png' });
});
