/**
 * 左パネルの AI のタブ (既存の AI アシスタント)。
 *
 * このタブは LLM を呼ぶ。テストでは API の応答を差し替えて、画面の動きだけを確かめる
 * (LLM は実際には呼ばない)。差し替えは画面を開く前に仕掛ける。
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { openDaw, openTab, statusText } from './helpers';

const REPLY = {
    notes: [
        { note: 'C', octave: 4, step: 0, length: 4 },
        { note: 'E', octave: 4, step: 4, length: 4 },
    ],
    explanation: 'C と E を並べました',
    backend: 'cloud',
};

/** アシスタントの API を差し替える。chat に届いた入力欄の中身を `sent` に溜める。 */
async function stubAssistant(
    page: Page,
    options: { status?: object; chat?: (route: Route) => Promise<void> | void } = {},
): Promise<Record<string, string>[]> {
    const sent: Record<string, string>[] = [];
    await page.route('**/api/assistant/status', (route) => route.fulfill({
        json: options.status ?? { local: false, cloud: true, local_models: [] },
    }));
    await page.route('**/api/assistant/chat', async (route) => {
        // 送られたフォームの各欄を読む (multipart の本文から name と値を取り出す)
        const body = route.request().postData() ?? '';
        const fields: Record<string, string> = {};
        for (const m of body.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)) fields[m[1]] = m[2];
        sent.push(fields);
        if (options.chat) await options.chat(route);
        else await route.fulfill({ json: REPLY });
    });
    return sent;
}

test('使える LLM の状態が出る', async ({ page }) => {
    await stubAssistant(page, { status: { local: true, cloud: false, local_models: ['gemma3:4b'] } });
    await openDaw(page);
    await openTab(page, 'AI');
    const panel = page.locator('#assistant-panel');
    await expect(panel).toContainText('接続済み (gemma3:4b)');
    await expect(panel).toContainText('未設定 (ANTHROPIC_API_KEY)');
});

test('例を選んで送ると、入力と文脈が API に渡り、提案が表示される', async ({ page }) => {
    const sent = await stubAssistant(page);
    await openDaw(page);
    // 文脈として渡るよう、先にノートを 1 つ置いておく
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 200 } });
    await openTab(page, 'AI');
    const panel = page.locator('#assistant-panel');

    // 何も入れていない間は送れない
    await expect(panel.getByRole('button', { name: '送信' })).toBeDisabled();
    await panel.getByText('2小節のシンプルなベースライン（Am）').click();
    await expect(panel.locator('textarea')).toHaveValue('2小節のシンプルなベースライン（Am）');
    await panel.locator('input[type="number"]').fill('2');
    await panel.locator('select').selectOption('cloud');
    await panel.getByRole('button', { name: '送信' }).click();

    await expect(panel.getByText('C と E を並べました')).toBeVisible();
    await expect(panel.getByText('CLOUD', { exact: true })).toBeVisible();
    await expect(panel.getByText('2ノート')).toBeVisible();
    // 送ったあと、入力欄は空に戻る
    await expect(panel.locator('textarea')).toHaveValue('');

    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toBe('2小節のシンプルなベースライン（Am）');
    expect(sent[0].bpm).toBe('120');
    expect(sent[0].bars).toBe('2');
    expect(sent[0].mode).toBe('cloud');
    expect(JSON.parse(sent[0].context_notes)).toHaveLength(1);
});

test('提案は、トラックを開いていれば、ピアノロールに置き換え・追記できる', async ({ page }) => {
    await stubAssistant(page);
    await openDaw(page);
    await openTab(page, 'AI');
    const panel = page.locator('#assistant-panel');
    await panel.locator('textarea').fill('C と E');
    // Ctrl+Enter でも送れる
    await panel.locator('textarea').press('Control+Enter');
    await expect(panel.getByText('C と E を並べました')).toBeVisible();

    // トラックを開いていないときは、置かずに理由を出す
    await panel.getByRole('button', { name: 'ピアノロールに適用' }).click();
    await expect(statusText(page)).toHaveText('先にトラックを選択してピアノロールを開いてください');

    await page.locator('#tracks-container .track-name').first().click();
    await panel.getByRole('button', { name: 'ピアノロールに適用' }).click();
    await expect(statusText(page)).toHaveText('2ノートを置換しました');
    const titles = () => page.locator('#note-layer .note-block').evaluateAll((els) => els.map((el) => (el as HTMLElement).title));
    expect(await titles()).toEqual(['C4 step:0 len:4', 'E4 step:4 len:4']);
    await expect(page.locator('#tracks-container .notes-badge').first()).toHaveText('2');

    // 追記は、いま在るノートの後ろに続ける
    await panel.getByRole('button', { name: '末尾に追加' }).click();
    await expect(statusText(page)).toHaveText('2ノートを追加しました');
    expect(await titles()).toEqual(['C4 step:0 len:4', 'E4 step:4 len:4', 'C4 step:8 len:4', 'E4 step:12 len:4']);
});

test('API が失敗を返すと、理由が赤い枠で出て、もう一度送れる', async ({ page }) => {
    let fail = true;
    await stubAssistant(page, {
        chat: (route) => fail
            ? route.fulfill({ status: 400, json: { detail: 'LLM に接続できません' } })
            : route.fulfill({ json: REPLY }),
    });
    await openDaw(page);
    await openTab(page, 'AI');
    const panel = page.locator('#assistant-panel');
    await panel.locator('textarea').fill('何か');
    await panel.getByRole('button', { name: '送信' }).click();
    await expect(panel.getByText('LLM に接続できません')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'ピアノロールに適用' })).toHaveCount(0);

    fail = false;
    await panel.locator('textarea').fill('もう一度');
    await panel.getByRole('button', { name: '送信' }).click();
    await expect(panel.getByText('C と E を並べました')).toBeVisible();
});
