/**
 * 再現ガイド (第2層) を、アシスタント (右のドックのチャット) から通す。費用を無駄にしないための仕組みも確かめる。
 *
 * 「学ぶ」→「ガイド」のボタンは、ドックを開いて依頼を送るだけ。アシスタントは、ルーターが選んだモデルで
 * ツール `make_guide` を呼び、ガイドはチャットにカードとして出る。
 *
 * 本物の Claude は呼ばない。API サーバは、偽の Claude サーバ (fake-anthropic.mjs) を呼ぶ
 * (playwright.config.ts)。偽のサーバは呼ばれた回数と、送られてきたモデルを控えているので、「Claude にガイドを作らせたか」
 * 「選んだモデルで作ったか」を、画面の見た目からではなく、直接確かめられる。偽のルーターは、依頼に「ガイド」が在れば
 * Sonnet を選ぶ。
 */
import { expect, test, type Page } from '@playwright/test';
import {
    askAssistantInDock, assistantChat, assistantDock, fakeLlmCalls, importSong, makeWav, openDaw, openTab, raiseDailyLimitDuringFile,
    runJob, statusText, waitAssistantTurns,
} from './helpers';

test.skip(Boolean(process.env.BUNRI_E2E_LLM), '偽の Claude サーバを相手にするテスト。本物を呼ぶ BUNRI_E2E_LLM=1 のときは走らせない');

// アシスタントの依頼も 1 日の上限に数えるので、このファイルのあいだだけ上げる (1 つ目のテスト)
raiseDailyLimitDuringFile(test);

/** 曲を取り込んでカルテを作り、再現ガイドの段を開いて、そのパネルを返す。 */
async function openChart(page: Page, filename: string) {
    await openDaw(page);
    const wav = makeWav(16, [261.63, 196.0, 220.0, 174.61, 261.63, 196.0, 220.0, 174.61]);
    const analyzed = await runJob(page, '/api/chart', () => importSong(page, { name: filename, mimeType: 'audio/wav', buffer: wav }));
    expect(analyzed.state).toBe('done');
    await openTab(page, 'ガイド');
    return page.locator('#guide-panel');
}

/** ガイドの段のボタンで頼み、答え終わるまで待つ。 */
async function askFromPanel(page: Page, panel: ReturnType<Page['locator']>, turns: number) {
    await panel.getByRole('button', { name: 'アシスタントにガイドを頼む' }).click();
    await expect(assistantDock(page)).toBeVisible();
    await waitAssistantTurns(page, turns, 'ガイドの依頼');
}

test('ガイドの段のボタンで頼むと、ドックが開き、選んだモデルで作ったガイドがカードに出る。保存済みなら作り直さず、作り直しは頼んだときだけ', async ({ page }, testInfo) => {
    const filename = `e2e-saved-${testInfo.project.name}.wav`;
    const before = await fakeLlmCalls(page);

    // 1 回目: まだ無いので、Claude にガイドを作らせる
    let panel = await openChart(page, filename);
    // パネルには、Claude の設定の欄は無い (ドックにだけ在る)
    await expect(panel.getByRole('button', { name: 'API キーと上限の設定' })).toHaveCount(0);
    await askFromPanel(page, panel, 1);
    await expect(assistantChat(page).locator('.assistant-msg.user')).toHaveText('あなた: 再現ガイドを作って');
    const card = assistantChat(page).getByRole('region', { name: '再現ガイド（曲全体）' });
    await expect(card.getByRole('list', { name: '再現の手順' }).locator(':scope > li')).toHaveCount(3);
    await expect(card).toContainText('テンポを合わせる');
    let calls = await fakeLlmCalls(page);
    expect(calls.messages).toBe(before.messages + 1);
    // 依頼ごとにルーターが 1 回だけ選び、アシスタントの続きの呼び出しと、ガイドを、選んだモデル (Sonnet) で作る
    expect(calls.router).toBe(before.router + 1);
    expect(calls.models.guide.at(-1)).toBe('claude-sonnet-5-5');
    expect(calls.models.assistant.slice(-2)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5']);
    // 使った量と概算の費用 (カードの中)。依頼の終わりの行に、答えたモデルと、選んだ理由 (説明の吹き出し)
    await expect(card).toContainText('このガイドを作ったときの使用量: 入力 3,020 トークン');
    await expect(card).toContainText('出力 400 トークン');
    await expect(card).toContainText('作成: Sonnet');
    const model = assistantChat(page).locator('.assistant-turn-model');
    await expect(model).toHaveText('Sonnet');
    await expect(model).toHaveAttribute('data-tip', 'Sonnet で答えました。選んだ理由: テスト用: 説明を書くので');
    await expect(assistantChat(page).locator('.assistant-turn')).toContainText(/Claude を 2 回呼びました（概算 \$/);
    await testInfo.attach('guide-card', { body: await assistantDock(page).screenshot(), contentType: 'image/png' });

    // 手順の場所を押すと、そこへ移動する
    await card.getByRole('button', { name: '1 小節 1 拍目' }).click();
    await expect(statusText(page)).toHaveText('1 小節 1 拍目 へ移動しました');

    // 2 回目: 画面を開き直して同じ曲のカルテを開き、もう一度頼む。保存済みが出て、ガイドは作り直さない
    panel = await openChart(page, filename);
    await askFromPanel(page, panel, 1);
    const again = assistantChat(page).getByRole('region', { name: '再現ガイド（曲全体）' });
    await expect(again.getByRole('list', { name: '再現の手順' }).locator(':scope > li')).toHaveCount(3);
    await expect(again).toContainText('保存済みのガイドを出しました（Claude は呼んでいません');
    calls = await fakeLlmCalls(page);
    expect(calls.messages).toBe(before.messages + 1);

    // 作り直してと頼んだときだけ、もう一度作る
    await askAssistantInDock(page, 'ガイドを作り直して', 2);
    await expect.poll(async () => (await fakeLlmCalls(page)).messages).toBe(before.messages + 2);
    await expect(assistantChat(page).locator('.assistant-card')).toHaveCount(2);

    // 区間を選んで頼むと、その区間のガイド (まだ無いので作る)
    const focus = panel.getByLabel('対象');
    if (await focus.locator('option').count() > 1) {
        await focus.selectOption({ index: 1 });
        const label = (await focus.locator('option').nth(1).textContent())!;
        await askFromPanel(page, panel, 3);
        await expect(assistantChat(page).locator('.assistant-msg.user').last()).toContainText('の再現ガイドを作って');
        await expect(assistantChat(page).locator('.assistant-card').last()).toHaveAttribute('aria-label', `再現ガイド（${label}）`);
        await expect.poll(async () => (await fakeLlmCalls(page)).messages).toBe(before.messages + 3);
    }
});

test('1 日の上限に達していると、ルーターもガイドも呼ばずに、理由がチャットに出る', async ({ page }, testInfo) => {
    const current = await (await page.request.get('/api/settings/guide')).json();
    const previous = current.settings.daily_limit_calls;
    // 上限を「今日すでに呼んだ回数」に合わせる (= ちょうど上限に達した状態にする)
    const limit = current.today.calls;
    expect((await page.request.post('/api/settings/guide', { data: { daily_limit_calls: limit } })).ok()).toBe(true);
    try {
        const before = await fakeLlmCalls(page);
        const panel = await openChart(page, `e2e-limit-${testInfo.project.name}.wav`);
        await panel.getByRole('button', { name: 'アシスタントにガイドを頼む' }).click();
        await expect(assistantChat(page).locator('.assistant-notice.error')).toContainText(`1 日の上限（${limit} 回）に達した`);
        await expect(assistantChat(page).locator('.assistant-card')).toHaveCount(0);
        const after = await fakeLlmCalls(page);
        expect(after.messages).toBe(before.messages);
        expect(after.router).toBe(before.router);
        expect(after.assistant).toBe(before.assistant);
    } finally {
        // API サーバはほかのテストと共用なので、上限を元に戻す
        await page.request.post('/api/settings/guide', { data: { daily_limit_calls: previous } });
    }
});
