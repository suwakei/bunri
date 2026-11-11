/**
 * 再現ガイド (第2層) の、費用を無駄にしないための仕組みを通す。
 *
 * 本物の Claude は呼ばない。API サーバは、偽の Claude サーバ (fake-anthropic.mjs) を呼ぶ
 * (playwright.config.ts)。偽のサーバは呼ばれた回数を数えているので、「Claude を呼んだか」を
 * 画面の見た目からではなく、直接確かめられる。
 */
import { expect, test, type Page } from '@playwright/test';
import { FAKE_LLM_URL, makeWav, openDaw } from './helpers';

test.skip(Boolean(process.env.BUNRI_E2E_LLM), '偽の Claude サーバを相手にするテスト。本物を呼ぶ BUNRI_E2E_LLM=1 のときは走らせない');

/** Claude (偽) を呼んでガイドを作らせた回数。 */
async function llmCalls(page: Page): Promise<number> {
    const response = await page.request.get(`${FAKE_LLM_URL}/__calls`);
    return (await response.json()).messages;
}

/** 音声ファイルを読み込んでカルテを作り、再現ガイドのパネルを返す。 */
async function openChart(page: Page, filename: string) {
    await openDaw(page);
    await page.locator('#panel-tabs').getByText('ファイル').click();
    const wav = makeWav(16, [261.63, 196.0, 220.0, 174.61, 261.63, 196.0, 220.0, 174.61]);
    await page.locator('#file-panel input[type="file"]').first().setInputFiles({ name: filename, mimeType: 'audio/wav', buffer: wav });
    const analyzed = page.waitForResponse((r) => r.url().endsWith('/api/chart'), { timeout: 60_000 });
    await page.locator('#file-panel').getByRole('button', { name: /カルテ/ }).click();
    expect((await analyzed).status()).toBe(200);
    await page.locator('#panel-tabs').getByText('カルテ').click();
    return page.locator('#guide-panel');
}

test('作ったガイドは保存され、開き直しても Claude を呼ばない。作り直したときだけ呼ぶ', async ({ page }, testInfo) => {
    const filename = `e2e-saved-${testInfo.project.name}.wav`;
    const before = await llmCalls(page);

    // 1 回目: まだ無いので、押すと Claude を呼ぶ
    let panel = await openChart(page, filename);
    await expect(panel.getByRole('button', { name: 'ガイドを作る' })).toBeVisible();
    await expect(panel.locator('ol > li')).toHaveCount(0);
    await panel.getByRole('button', { name: 'ガイドを作る' }).click();
    await expect(panel.locator('ol > li')).toHaveCount(3);
    expect(await llmCalls(page)).toBe(before + 1);
    // 使った量と概算の費用、今日の累計が出る
    await expect(panel.locator('#guide-usage')).toContainText('入力 3,020 トークン');
    await expect(panel.locator('#guide-usage')).toContainText('出力 400 トークン');
    await expect(panel.locator('#guide-usage')).toContainText('概算 $');
    await expect(panel.locator('#guide-today')).toContainText(/今日 Claude を呼んだ回数: \d+ 回、概算 \$/);

    // 2 回目: 画面を開き直して同じ曲のカルテを開く。何も押さなくても表示され、Claude は呼ばれない
    panel = await openChart(page, filename);
    await expect(panel.locator('ol > li')).toHaveCount(3);
    await expect(panel.getByText('テンポを合わせる')).toBeVisible();
    await expect(panel.getByText(/このガイドは保存済みです/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'ガイドを作り直す（費用がかかります）' })).toBeVisible();
    expect(await llmCalls(page)).toBe(before + 1);
    // 出来上がりを目で確かめられるよう、パネルの画像を結果に添える
    await testInfo.attach('guide-panel-saved', { body: await panel.screenshot(), contentType: 'image/png' });

    // 対象を変えると、その対象のガイドはまだ無い。戻すと、保存済みがまた出る。どちらも Claude は呼ばない
    const focus = panel.getByLabel('対象');
    if (await focus.locator('option').count() > 1) {
        await focus.selectOption({ index: 1 });
        await expect(panel.locator('ol > li')).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'ガイドを作る' })).toBeVisible();
        await focus.selectOption({ index: 0 });
        await expect(panel.locator('ol > li')).toHaveCount(3);
        expect(await llmCalls(page)).toBe(before + 1);
    }

    // 作り直すと明示的に押したときだけ、もう一度呼ぶ
    await panel.getByRole('button', { name: /ガイドを作り直す/ }).click();
    await expect.poll(() => llmCalls(page)).toBe(before + 2);
    await expect(panel.locator('ol > li')).toHaveCount(3);
});

test('1 日の上限に達していると、Claude を呼ばずに理由が画面に出る', async ({ page }, testInfo) => {
    const current = await (await page.request.get('/api/settings/guide')).json();
    const previous = current.settings.daily_limit_calls;
    // 上限を「今日すでに呼んだ回数」に合わせる (= ちょうど上限に達した状態にする)
    const limit = current.today.calls;
    expect((await page.request.post('/api/settings/guide', { data: { daily_limit_calls: limit } })).ok()).toBe(true);
    try {
        const before = await llmCalls(page);
        const panel = await openChart(page, `e2e-limit-${testInfo.project.name}.wav`);
        await panel.getByRole('button', { name: 'ガイドを作る' }).click();
        await expect(panel.getByRole('alert')).toContainText(`1 日の上限（${limit} 回）に達したので、Claude を呼びません`);
        await expect(panel.locator('ol > li')).toHaveCount(0);
        expect(await llmCalls(page)).toBe(before);
        await expect(panel.locator('#guide-today')).toContainText(`上限 ${limit} 回`);
    } finally {
        // API サーバはほかのテストと共用なので、上限を元に戻す
        await page.request.post('/api/settings/guide', { data: { daily_limit_calls: previous } });
    }
});
