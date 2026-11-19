/**
 * アシスタント (画面の右側のチャット): 頼むと、操作ログの行が出て、プロジェクトが変わる。行を開くと、その操作の
 * あいだの動きの記録が出る。1 回の依頼で変えたことは「元に戻す」1 回で戻る。ツールの失敗は ✕ の行で出る。
 * 練習画面でもドックが見える。ドックを開いても、画面が窓からはみ出さない。
 *
 * ノートの変形・差分チェック・練習の設定・場所を示す・書き出しも、頼むと画面がそのとおりに変わる。
 * 会話は、プロジェクトを保存して開き直すと戻る。「新しい会話」の前の会話は履歴に残り、開き直して続きを頼める。
 *
 * 本物の Claude は呼ばない。API サーバは、偽の Claude サーバ (fake-anthropic.mjs) を呼ぶ。偽のサーバは、依頼の文に
 * 含まれることば (「トラック」「ノート」「失敗」) で決まった筋書きのツールを呼ぶ。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { FAKE_LLM_URL, openDaw, openProject, saveProject, startFree, statusText, trackSummary } from './helpers';
import { LANDMARKS } from '../src/lib/assistant-landmarks';
import { fakePracticeBackend, openBassPractice } from './practice-fixtures';

test.skip(Boolean(process.env.BUNRI_E2E_LLM), '偽の Claude サーバを相手にするテスト。本物を呼ぶ BUNRI_E2E_LLM=1 のときは走らせない');

/*
 * アシスタントの依頼は、再現ガイド・差分の説明と同じ「1 日の上限」(既定 20 回) に数える (依頼 1 つを 1 回)。
 * API サーバとデータ置き場は、ほかのテスト・もう 1 つのブラウザと共用なので、
 *
 * - 始める前に、上限を十分に上げておく (このファイルの途中で上限に届くと、依頼が断られて、どのテストも進まなくなる。
 *   全体を通しで回すと、2 つ目のブラウザの途中で届いていた)
 * - 終わったら、上げたぶんを戻し、このファイルで使った回数のぶんだけ上げたままにする
 *   (ほかのテストに残る回数を、このファイルが在っても無くても同じにする)
 *
 * 上限は、差で動かす (ほかのファイルが同じ時に上限を動かしていても、打ち消さない)。
 */
const HEADROOM = 500;
let callsBefore = 0;
let raised = false;
const guideSettings = async (request: APIRequestContext) => (await request.get('/api/settings/guide')).json();
test.beforeAll(async ({ request }) => {
    const now = await guideSettings(request);
    callsBefore = now.today.calls;
    const limit = now.settings.daily_limit_calls;
    raised = limit !== null;
    if (raised) await request.post('/api/settings/guide', { data: { daily_limit_calls: limit + HEADROOM } });
});
test.afterAll(async ({ request }) => {
    if (!raised) return;
    const now = await guideSettings(request);
    const used = now.today.calls - callsBefore;
    const limit = now.settings.daily_limit_calls;
    if (limit !== null) await request.post('/api/settings/guide', { data: { daily_limit_calls: limit - HEADROOM + used } });
});

const toggle = (page: Page) => page.getByRole('button', { name: 'アシスタント', exact: true });
const dock = (page: Page) => page.getByRole('complementary', { name: 'アシスタント' });
const chat = (page: Page) => dock(page).getByRole('log', { name: '会話と操作ログ' });
const input = (page: Page) => dock(page).getByRole('textbox', { name: 'アシスタントに頼むこと' });
const toolRows = (page: Page) => chat(page).locator('.assistant-tool');
const noteBlocks = (page: Page) => page.locator('#note-layer .note-block');

/** アシスタントを呼んだ回数 (偽の Claude サーバが数えている)。 */
async function assistantCalls(page: Page): Promise<number> {
    return (await (await page.request.get(`${FAKE_LLM_URL}/__calls`)).json()).assistant;
}

/** ドックを開く。 */
async function openDock(page: Page) {
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(dock(page)).toBeVisible();
}

/**
 * 頼んで、アシスタントが答え終わるまで待つ (依頼の終わりの行が `turns` 個になるまで)。
 *
 * Claude を 1 回も呼べずに断られた依頼 (1 日の上限、API キーが無い、など) には、依頼の終わりの行が出ない。
 * そのまま待つと、理由の分からない時間切れになるので、断られた知らせが出たら、その文を付けてすぐ失敗させる。
 */
async function ask(page: Page, request: string, turns: number) {
    const turnRows = chat(page).locator('.assistant-turn');
    const errors = chat(page).locator('.assistant-notice.error');
    const errorsBefore = await errors.count();
    await input(page).fill(request);
    await input(page).press('Enter');
    const deadline = Date.now() + 30_000;
    for (;;) {
        if (await turnRows.count() >= turns) break;
        const idle = (await dock(page).getByRole('button', { name: '中止' }).count()) === 0;
        if (idle && (await errors.count()) > errorsBefore) {
            throw new Error(`依頼「${request}」は、断られました: ${await errors.last().innerText()}`);
        }
        if (Date.now() > deadline) {
            throw new Error(`依頼「${request}」が、30 秒たっても終わりません。ドックの中身（末尾）: ${(await dock(page).innerText()).slice(-500)}`);
        }
        await page.waitForTimeout(100);
    }
    await expect(turnRows).toHaveCount(turns);
    await expect(dock(page).getByRole('button', { name: '中止' })).toHaveCount(0);
}

/**
 * 画面全体が、窓からはみ出していないか。縦は、ステータスバーが窓の中に在ること。横は、本体 (#main) が窓の幅に収まっていること。
 *
 * @param header - true なら、ヘッダのボタンも窓の幅に収まっていること (ページ全体の幅) まで見る。
 *   窓の幅の下限に近い狭い窓では、ヘッダのボタンは、アシスタントのボタンを足す前から収まっていないので見ない
 */
async function expectFitsWindow(page: Page, header = true) {
    const layout = await page.evaluate(() => {
        const bar = document.querySelector('#status-bar')!.getBoundingClientRect();
        const main = document.querySelector('#main')!.getBoundingClientRect();
        const root = document.documentElement;
        return {
            barBottom: bar.bottom, mainRight: main.right, height: window.innerHeight, width: window.innerWidth,
            pageHeight: root.scrollHeight, pageWidth: root.scrollWidth,
        };
    });
    expect(layout.barBottom).toBeLessThanOrEqual(layout.height);
    expect(layout.pageHeight).toBeLessThanOrEqual(layout.height);
    expect(layout.mainRight).toBeLessThanOrEqual(layout.width);
    if (header) expect(layout.pageWidth).toBeLessThanOrEqual(layout.width);
}

test('頼むと操作ログの行が出て、ノートが置かれる。行を開くと動きの記録が出て、「元に戻す」1 回で依頼の変更が全部戻る', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    const before = await assistantCalls(page);
    await openDock(page);
    // 開いたら、すぐ打てる。何も無いときは、頼み方の例が出ている
    await expect(input(page)).toBeFocused();
    await expect(chat(page).getByRole('button')).toHaveCount(3);

    // 1 回の依頼で、トラックを足し、ノートを置き、音量を変える (偽の Claude の筋書き)
    await ask(page, 'トラックを足して、ノートを置いて', 1);
    expect(await assistantCalls(page)).toBe(before + 3);

    // 操作ログ: ツール 1 つが 1 行。成功は ✓ と、何をしたかの 1 行
    await expect(toolRows(page)).toHaveCount(3);
    await expect(toolRows(page).nth(0)).toContainText('「アシスタントのベース」を追加しました');
    await expect(toolRows(page).nth(1)).toContainText('ノートを 8 個置きました（アシスタントのベース、1〜2 小節）');
    await expect(toolRows(page).nth(2)).toContainText('「アシスタントのベース」の音量を −6.0 dB にしました');
    await expect(chat(page).locator('.assistant-tool.ok .assistant-tool-mark')).toHaveText(['✓', '✓', '✓']);
    // 利用者の文、アシスタントの文、依頼の終わり (呼んだ回数と概算の費用)
    await expect(chat(page).locator('.assistant-msg.user')).toHaveText('あなた: トラックを足して、ノートを置いて');
    await expect(chat(page).locator('.assistant-msg.assistant').last()).toContainText('トラックを足して、1〜2 小節にベースを置き、音量を下げました。');
    await expect(chat(page).locator('.assistant-turn')).toContainText(/Claude を 3 回呼びました（概算 \$/);
    // 新しい行が見えるところまで、付いていく
    await expect(chat(page).locator('.assistant-turn')).toBeInViewport();
    await expect(dock(page).locator('.assistant-today')).toContainText(/今日 \d+ 回/);

    // プロジェクト: 足したトラックがピアノロールで開いていて、ノートが 8 個置かれている
    expect((await trackSummary(page)).map((t) => t.name)).toEqual(['Track 1', 'Track 2', 'アシスタントのベース']);
    await expect(noteBlocks(page)).toHaveCount(8);
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('アシスタントのベース');
    // フラットで頼まれた高さ (Eb2) は、シャープ (D#2) で置かれる
    await expect(page.locator('#note-layer .note-block[data-note="D#2 step:4 len:4"]')).toHaveCount(1);
    await expect(page.locator('#note-layer .note-block[data-note="C2 step:0 len:4"]')).toHaveCount(1);
    await expect(page.getByRole('slider', { name: '「アシスタントのベース」の音量' })).toHaveValue('-6');

    // 行を開くと、その操作のあいだに起きたこと (ステータスバーの文) が、時刻つきで出る
    await toolRows(page).nth(0).locator('summary').click();
    const during = toolRows(page).nth(0).getByRole('list', { name: 'この操作のあいだに起きたこと' });
    await expect(during).toBeVisible();
    await expect(during.getByRole('listitem').first()).toContainText(/^\d\d:\d\d:\d\d\.\d{3}/);
    await expect(during).toContainText('状態');
    await expect(during).toContainText('「アシスタントのベース」を追加しました');
    await expect(during).toContainText('ピアノロール: アシスタントのベース');
    // ステータスバーに何も出さない操作 (ノートを置く) の行
    await toolRows(page).nth(1).locator('summary').click();
    await expect(toolRows(page).nth(1)).toContainText('この操作のあいだに、ほかに起きたことはありません');

    // 動きの記録には、操作の結果が「アシスタント」の行で残る。利用者が打った文は残らない
    await page.getByRole('button', { name: '記録', exact: true }).click();
    const activity = page.getByRole('region', { name: '動きの記録' });
    await expect(activity.locator('li.activity-agent')).toHaveText([
        /アシスタント「アシスタントのベース」を追加しました$/,
        /アシスタントノートを 8 個置きました（アシスタントのベース、1〜2 小節）$/,
        /アシスタント「アシスタントのベース」の音量を −6\.0 dB にしました$/,
    ]);
    await expect(activity).not.toContainText('トラックを足して');
    // 動きの記録の一覧は、ドックに重ならない (入力欄と「元に戻す」を隠さない)
    const [activityBox, dockBox] = [(await activity.boundingBox())!, (await dock(page).boundingBox())!];
    expect(activityBox.x).toBeGreaterThanOrEqual(0);
    expect(activityBox.x + activityBox.width).toBeLessThanOrEqual(dockBox.x);
    await activity.getByRole('button', { name: '動きの記録を閉じる' }).click();

    // 元に戻す: ヘッダの ↶ の説明に、依頼の名前が出る。チャットの「元に戻す」1 回で、この依頼の変更が全部戻る
    expect(await page.locator('#btn-undo').getAttribute('data-tip')).toContain('アシスタント: トラックを足して、ノートを置いて');
    const undo = chat(page).getByRole('button', { name: 'この依頼の変更を元に戻す' });
    await expect(undo).toBeEnabled();
    await undo.click();
    expect((await trackSummary(page)).map((t) => t.name)).toEqual(['Track 1', 'Track 2']);
    await expect(noteBlocks(page)).toHaveCount(0);
    await expect(statusText(page)).toHaveText('元に戻しました（アシスタント: トラックを足して、ノートを置いて）');
    await expect(undo).toBeDisabled();
    // その前の操作 (トラックの追加) は、戻っていない
    expect(await page.locator('#btn-undo').getAttribute('data-tip')).toContain('トラックを追加');
    // やり直すと、依頼の変更がまとめて戻ってくる
    await page.locator('#btn-redo').click();
    expect((await trackSummary(page)).map((t) => t.name)).toEqual(['Track 1', 'Track 2', 'アシスタントのベース']);
    await expect(page.getByRole('slider', { name: '「アシスタントのベース」の音量' })).toHaveValue('-6');
    await expect(undo).toBeEnabled();
});

test('応答は少しずつ届く形 (NDJSON) で読む。流れている文は 1 つの吹き出しに出て、答え終わると確定した吹き出しだけが残る', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await openDock(page);

    // 画面が送った本文と、API サーバが返した応答の形を控える
    const steps: { stream: unknown; contentType: string }[] = [];
    page.on('response', (response) => {
        if (new URL(response.url()).pathname !== '/api/assistant/step') return;
        steps.push({ stream: response.request().postDataJSON()?.stream, contentType: response.headers()['content-type'] ?? '' });
    });
    // 流れている途中の吹き出し (.streaming) が画面に出たら、そのときの aria-busy と文を控える
    await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { __flowing: string[] }).__flowing = seen;
        const panel = document.querySelector('#assistant-panel')!;
        new MutationObserver(() => {
            for (const el of panel.querySelectorAll('.assistant-msg.streaming')) seen.push(`${el.getAttribute('aria-busy')}|${el.textContent}`);
        }).observe(panel, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-busy'] });
    });

    await ask(page, 'ノートを置いて', 1);

    // どの呼び出しも、"stream": true を付けて送り、1 行に JSON 1 つの形で受け取っている
    expect(steps.length).toBeGreaterThan(0);
    for (const call of steps) {
        expect(call.stream).toBe(true);
        expect(call.contentType).toContain('application/x-ndjson');
    }
    // 流れているあいだは、吹き出しに文が出ていて、読み上げは待たせてある (aria-busy)
    const seen = await page.evaluate(() => (window as unknown as { __flowing: string[] }).__flowing);
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) expect(entry).toMatch(/^true\|アシスタント: ./);

    // 答え終わったら、流れている途中の吹き出しは残らず、確定した文と操作ログが出ている
    await expect(chat(page).locator('.assistant-msg.streaming')).toHaveCount(0);
    await expect(chat(page).locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(chat(page).locator('.assistant-msg.assistant').last()).toContainText('ノートを 8 個置きました');
    await expect(toolRows(page)).toHaveCount(2);
    await expect(toolRows(page).nth(1)).toContainText('ノートを 8 個置きました（Track 1、1〜2 小節）');
    // 流れているあいだも、新しい行が見えるところまで付いていっている
    await expect(chat(page).locator('.assistant-turn')).toBeInViewport();
});

test('開いているトラックにも、開いていないトラックにも、ノートを置ける。ツールの失敗は ✕ の行で出て、「新しい会話」で空になる', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    // Track 1 を開いて、手でノートを 1 つ置いておく (アシスタントが足しても、消えないこと)
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 330, y: 200 } });
    await expect(noteBlocks(page)).toHaveCount(1);
    await openDock(page);

    // 「ノート」: まずプロジェクトの様子を見て、開いているトラック (Track 1) に置く
    await ask(page, 'ノートを置いて', 1);
    await expect(toolRows(page)).toHaveCount(2);
    await expect(toolRows(page).nth(0)).toContainText('プロジェクトの様子を見ました（トラック 2 本、120 BPM、4/4）');
    await expect(toolRows(page).nth(1)).toContainText('ノートを 8 個置きました（Track 1、1〜2 小節）');
    await expect(noteBlocks(page)).toHaveCount(9);
    await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveText('9');

    // 開いていないトラック (Track 2) にも、id で置ける。ピアノロールに開いている Track 1 のノートは、そのまま
    const badge = (index: number) => page.locator('#tracks-container .track-row').nth(index).locator('.notes-badge');
    await ask(page, 'ほかにもノートを置いて', 2);
    await expect(toolRows(page).nth(3)).toContainText('ノートを 8 個置きました（Track 2、1〜2 小節）');
    await expect(badge(1)).toHaveText('8');
    await expect(badge(0)).toHaveText('9');
    await expect(noteBlocks(page)).toHaveCount(9);
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');

    // 失敗: 在りえないトラックにノートを置こうとする。✕ の行に、利用者向けの理由が出る (ツールや引数の名前は出さない)
    await ask(page, 'わざと失敗して', 3);
    const failed = chat(page).locator('.assistant-tool.error');
    await expect(failed).toHaveCount(1);
    await expect(failed.locator('.assistant-tool-mark')).toHaveText('✕');
    await expect(failed).toContainText('ノートを置く: そのトラックが見つかりませんでした');
    // いま在るトラックの番号の一覧 (Claude が直して呼び直すための材料) も、操作ログには出さない
    await expect(failed).not.toContainText('track_id');
    await expect(failed).not.toContainText('1（Track 1）');
    // 失敗の結果を受けて、アシスタントが文で答える
    await expect(chat(page).locator('.assistant-msg.assistant').last()).toContainText('ノートを置けませんでした');
    // 何も変えなかった依頼には、「元に戻す」を出さない。押せるのは、いちばん新しい変更 (2 つ目の依頼) のぶんだけ
    const undoButtons = chat(page).getByRole('button', { name: 'この依頼の変更を元に戻す' });
    await expect(undoButtons).toHaveCount(2);
    await expect(undoButtons.nth(0)).toBeDisabled();
    await expect(undoButtons.nth(1)).toBeEnabled();
    await expect(noteBlocks(page)).toHaveCount(9);

    // ドックを閉じて開き直しても、会話と操作ログは残る
    await dock(page).getByRole('button', { name: 'アシスタントを閉じる' }).click();
    await expect(dock(page)).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await openDock(page);
    await expect(toolRows(page)).toHaveCount(5);

    // 元に戻す (ヘッダの ↶): 依頼ごとに 1 つずつ戻る。開いていないトラックのぶん → 開いているトラックのぶん
    await page.locator('#btn-undo').click();
    await expect(statusText(page)).toHaveText('元に戻しました（アシスタント: ほかにもノートを置いて）');
    await expect(badge(1)).toHaveCount(0);
    await expect(noteBlocks(page)).toHaveCount(9);
    // アシスタントが置いた 8 個だけが消える (手で置いた 1 個は残る)
    await page.locator('#btn-undo').click();
    await expect(noteBlocks(page)).toHaveCount(1);
    await expect(badge(0)).toHaveText('1');
    await expect(statusText(page)).toHaveText('元に戻しました（アシスタント: ノートを置いて）');

    // 新しい会話: 会話と操作ログが空になり、頼み方の例に戻る
    await dock(page).getByRole('button', { name: '新しい会話' }).click();
    await expect(toolRows(page)).toHaveCount(0);
    await expect(chat(page).locator('.assistant-msg')).toHaveCount(0);
    await expect(chat(page).getByRole('button')).toHaveCount(3);
    // 例を押すと、入力欄に入る (送るのは自分で)
    await chat(page).getByRole('button').first().click();
    await expect(input(page)).not.toHaveValue('');
    await expect(chat(page).locator('.assistant-msg')).toHaveCount(0);
});

test('日本語の変換中の Enter では送らず、Shift+Enter は改行になる。空の文は送れない', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    const before = await assistantCalls(page);
    await openDock(page);
    const send = dock(page).getByRole('button', { name: '送る' });
    await expect(send).toBeDisabled();
    await input(page).press('Enter');
    await input(page).fill('こんにちは');
    await expect(send).toBeEnabled();
    // 変換を確定する Enter (isComposing が立っている)
    await input(page).evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
    });
    await input(page).press('Shift+Enter');
    await expect(input(page)).toHaveValue('こんにちは\n');
    await expect(chat(page).locator('.assistant-msg')).toHaveCount(0);
    expect(await assistantCalls(page)).toBe(before);
    // 入力欄の中の Space は、再生を切り替えない
    await input(page).press('Space');
    await expect(page.locator('#btn-play')).toHaveAttribute('aria-label', '再生');
});

test('再生を頼むと、ヘッダの ▶ を押したときと同じように再生が始まる。何も変えない依頼には「元に戻す」が出ない', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    // 再生の仕組み (AudioContext) を、本物のクリックの中で作っておく (practice-fixtures.ts の openBassPractice と同じ理由)
    await page.getByRole('button', { name: 'メトロノーム' }).click();
    await page.getByRole('button', { name: 'メトロノーム' }).click();
    // 2 小節目まで鳴るものを置く (Track 1 の 2 小節目の頭)
    await page.locator('#note-layer').dblclick({ position: { x: 330, y: 200 } });
    await openDock(page);
    const undoTip = await page.locator('#btn-undo').getAttribute('data-tip');

    await ask(page, '2 小節目から再生して', 1);
    await expect(toolRows(page)).toHaveCount(1);
    await expect(toolRows(page).first()).toContainText('2 小節目から再生しました');
    // ヘッダの ▶ は「一時停止」になり、ステータスバーに「再生中…」が出て、再生位置が 2 小節目 (120 BPM で 2 秒) から進む
    await expect(page.locator('#btn-play')).toHaveAttribute('aria-label', '一時停止');
    await toolRows(page).first().locator('summary').click();
    await expect(toolRows(page).first().getByRole('list', { name: 'この操作のあいだに起きたこと' })).toContainText('再生中…');
    const seconds = async () => {
        const [min, sec] = ((await page.locator('#time-display').textContent()) ?? '0:00.0').split(':');
        return Number(min) * 60 + Number(sec);
    };
    await expect.poll(seconds).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.locator('#btn-play')).toHaveAttribute('aria-label', '再生');

    // 何も変えていないので、「元に戻す」は出ず、元に戻す履歴も増えていない
    await expect(chat(page).locator('.assistant-turn')).toContainText('Claude を 2 回呼びました');
    await expect(chat(page).getByRole('button', { name: 'この依頼の変更を元に戻す' })).toHaveCount(0);
    expect(await page.locator('#btn-undo').getAttribute('data-tip')).toBe(undoTip);
});

test('ドックを開いても、画面が窓からはみ出さない (ふつうの窓・狭い窓)。閉じると、中央の幅が戻る', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await expectFitsWindow(page);
    const centerWidth = () => page.locator('#center').evaluate((el) => el.getBoundingClientRect().width);
    const closed = await centerWidth();

    await openDock(page);
    await expectFitsWindow(page);
    const viewport = page.viewportSize()!;
    const box = (await dock(page).boundingBox())!;
    // 本体の右端に、ヘッダの下からステータスバーの上まで
    expect(Math.round(box.x + box.width)).toBe(viewport.width);
    expect(box.width).toBeGreaterThanOrEqual(300);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 28);
    expect(await centerWidth()).toBeCloseTo(closed - box.width, 0);
    // ヘッダのボタンは、窓の中に収まっている
    const helpLink = (await page.getByRole('link', { name: '使い方' }).boundingBox())!;
    expect(helpLink.x + helpLink.width).toBeLessThanOrEqual(viewport.width);
    // 入力欄と「送る」が、ドックの中に見えている
    await expect(input(page)).toBeInViewport();
    await expect(dock(page).getByRole('button', { name: '送る' })).toBeInViewport();

    // 狭い窓: ドックは縮み、画面は窓の中に収まる
    await page.setViewportSize({ width: 760, height: 560 });
    await expectFitsWindow(page, false);
    const narrow = (await dock(page).boundingBox())!;
    expect(narrow.x).toBeGreaterThanOrEqual(0);
    expect(Math.round(narrow.x + narrow.width)).toBeLessThanOrEqual(760);
    await expect(input(page)).toBeInViewport();

    await page.setViewportSize(viewport);
    await dock(page).getByRole('button', { name: 'アシスタントを閉じる' }).click();
    await expect(dock(page)).toHaveCount(0);
    expect(await centerWidth()).toBeCloseTo(closed, 0);
    await expectFitsWindow(page);
});

test('練習画面のあいだも、ドックが見えて使える (左パネルは隠れている)', async ({ page }) => {
    await fakePracticeBackend(page);
    await openDaw(page);
    await openBassPractice(page);
    await expect(page.locator('#left-panel')).toBeHidden();
    await openDock(page);
    await expect(input(page)).toBeInViewport();
    await expectFitsWindow(page);
    // ピアノロールと右の一覧は、ドックの左に収まっている
    const [dockBox, pianoBox] = [(await dock(page).boundingBox())!, (await page.locator('#piano-roll-area').boundingBox())!];
    expect(pianoBox.x + pianoBox.width).toBeLessThanOrEqual(dockBox.x);
    expect(pianoBox.width).toBeGreaterThan(300);

    // 入力欄で Esc を押しても、練習画面は閉じない (変換をやめる操作などに使うため)
    await input(page).press('Escape');
    await expect(page.getByRole('region', { name: '練習画面' })).toBeVisible();

    // 練習のトラック (開いているトラック) に、ノートを置ける
    await ask(page, 'ノートを置いて', 1);
    await expect(toolRows(page).nth(1)).toContainText('ノートを 8 個置きました（ベースの練習、1〜2 小節）');
    await expect(noteBlocks(page)).toHaveCount(8);

    // アレンジに戻っても、ドックと会話は残る
    await page.getByRole('button', { name: /アレンジに戻る/ }).click();
    await expect(page.getByRole('region', { name: '練習画面' })).toHaveCount(0);
    await expect(dock(page)).toBeVisible();
    await expect(toolRows(page)).toHaveCount(2);
    await expect(page.locator('#left-panel')).toBeVisible();
});

test('ノートの変形: 1 オクターブ上げる・くり返す。変えたノートが選ばれて光り、依頼ごとに元に戻せる', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await openDock(page);
    await ask(page, 'ノートを置いて', 1);
    await expect(noteBlocks(page)).toHaveCount(8);
    const tops = async () => noteBlocks(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).offsetTop));
    const before = await tops();

    await ask(page, '1 オクターブ上げて', 2);
    await expect(toolRows(page).last()).toContainText('ノートを 8 個、+12 半音（1 オクターブ上）に移しました（Track 1、全部）');
    // 12 半音ぶん上へ動き、変えたノートが選ばれている (どこが変わったかが見える)
    const after = await tops();
    expect(after).toHaveLength(8);
    const rowHeight = await page.evaluate(() => (document.querySelector('#note-layer .note-block') as HTMLElement).offsetHeight);
    for (let i = 0; i < 8; i++) expect(before[i] - after[i]).toBeGreaterThanOrEqual(12 * rowHeight);
    await expect(page.locator('#note-layer .note-block.selected')).toHaveCount(8);

    await ask(page, 'もう 1 回くり返して', 3);
    await expect(toolRows(page).last()).toContainText('置いた先は 3〜4 小節、8 個');
    await expect(noteBlocks(page)).toHaveCount(16);

    // くり返しだけを戻す → 8 個。もう 1 回戻すと、移調が戻る
    await chat(page).getByRole('button', { name: 'この依頼の変更を元に戻す' }).last().click();
    await expect(noteBlocks(page)).toHaveCount(8);
    await page.locator('#btn-undo').click();
    await expect.poll(tops).toEqual(before);
});

test('場所を示す: 「どこ？」と聞くと、そのタブが開いて、部品が光る。メトロノームと MIDI の書き出しも頼める', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.locator('#note-layer').dblclick({ position: { x: 30, y: 200 } });
    await openDock(page);
    // 「音作り」を開いておく (示すと、「学ぶ」→「曲とパート」に切り替わる)
    await expect(page.locator('#btn-import-song')).toBeHidden();

    // 光るのは数秒なので、依頼が終わるのを待たずに見る
    await input(page).fill('曲を取り込むのはどこ？');
    await input(page).press('Enter');
    await expect(page.locator('#btn-import-song')).toHaveClass(/assistant-pointer/);
    await expect(page.locator('#btn-import-song')).toBeVisible();
    await expect(chat(page).locator('.assistant-turn')).toHaveCount(1, { timeout: 30_000 });
    await expect(toolRows(page).first()).toContainText('「曲を取り込む」の場所を示しました');
    await expect(chat(page).locator('.assistant-msg.assistant').last()).toContainText('「学ぶ」→「曲とパート」に在る「曲を取り込む」ボタン');
    // 読むだけの依頼なので、「元に戻す」は出ない
    await expect(chat(page).getByRole('button', { name: 'この依頼の変更を元に戻す' })).toHaveCount(0);

    await ask(page, 'メトロノームを入れて', 2);
    await expect(page.getByRole('button', { name: 'メトロノーム' })).toHaveAttribute('aria-pressed', 'true');

    const download = page.waitForEvent('download');
    await ask(page, 'MIDI に書き出して', 3);
    expect((await download).suggestedFilename()).toBe('bunri.mid');
    await expect(toolRows(page).last()).toContainText('MIDI ファイルを書き出しました（bunri.mid');
});

test('練習画面: 「比べて」と頼むと、画面の「比べる」と同じように違うノートに色が付く。区間と速度も頼める', async ({ page }) => {
    await fakePracticeBackend(page);
    await openDaw(page);
    await openBassPractice(page);
    await openDock(page);
    await ask(page, 'ノートを置いて', 1);
    await expect(noteBlocks(page)).toHaveCount(8);

    // 比べる: 練習画面の区間で比べ、ノートに印が付き、一致が画面にも出る (差分は Python が出す事実。Claude は呼んでいない)
    await ask(page, 'お手本と比べて', 2);
    await expect(toolRows(page).last()).toContainText(/お手本と比べました（ベースの練習、.*一致 \d+%、違い \d+ 件）。違うノートに色を付けました/);
    await expect(page.getByTestId('match-rate')).toHaveText(/\d+%/);
    await expect(chat(page).locator('.assistant-msg.assistant').last()).toContainText(/一致は \d+% で、違いは \d+ 件です/);
    // 読むだけの依頼なので、「元に戻す」は増えない (ノートを置いた依頼の 1 つだけ)
    await expect(chat(page).getByRole('button', { name: 'この依頼の変更を元に戻す' })).toHaveCount(1);

    // 区間と速度
    await ask(page, '区間を変えて', 3);
    await expect(toolRows(page).last()).toContainText('練習の設定を変えました（区間ループ 2〜2 小節、速度 75%）');
    await expect(page.locator('#practice-speed')).toHaveValue('0.75');
    await expect(page.getByRole('spinbutton', { name: '区間の始まりの小節' })).toHaveValue('2');
});

test('頼み方の例は、状況に合わせて変わる', async ({ page }) => {
    await openDaw(page);
    await openDock(page);
    // 何も無いとき: まず、曲の取り込みの場所
    await expect(chat(page).getByRole('button').first()).toHaveText('曲を取り込むのは、どこから？');
    await page.getByRole('button', { name: 'アシスタントを閉じる' }).click();
    await startFree(page);
    await page.locator('#note-layer').dblclick({ position: { x: 30, y: 200 } });
    await openDock(page);
    // ノートの在るトラックを開いているとき: ノートの変形
    await expect(chat(page).getByRole('button').first()).toHaveText('いまのトラックの 1 小節目を、あと 3 回くり返して');
});

test('会話は、プロジェクトを保存すると一緒に入り、開き直すと戻る。新しいプロジェクトでは空になる', async ({ page }, testInfo) => {
    await openDaw(page);
    await startFree(page);
    await openDock(page);
    await ask(page, 'ノートを置いて', 1);
    await expect(toolRows(page)).toHaveCount(2);
    const name = await saveProject(page, `会話 ${testInfo.project.name} ${Date.now()}`);

    // 新しいプロジェクト: 会話は空になる (会話は、プロジェクトごと)
    await page.getByRole('button', { name: 'プロジェクトのメニュー' }).click();
    await page.getByRole('menuitem', { name: '新しいプロジェクト' }).click();
    await expect(toolRows(page)).toHaveCount(0);
    await expect(chat(page).locator('.assistant-msg')).toHaveCount(0);

    // 開く: 文と操作ログの行が戻り、その後ろに区切りが出る。「元に戻す」は出ない (元に戻す履歴は無い)
    await openProject(page, name);
    await expect(toolRows(page)).toHaveCount(2);
    await expect(toolRows(page).nth(1)).toContainText('ノートを 8 個置きました');
    await expect(chat(page).locator('.assistant-msg.user')).toHaveText('あなた: ノートを置いて');
    await expect(chat(page).getByRole('separator')).toContainText('ここまでは、プロジェクトに保存してあった会話です');
    await expect(chat(page).getByRole('button', { name: 'この依頼の変更を元に戻す' })).toHaveCount(0);
    await expect(noteBlocks(page)).toHaveCount(8);

    // 続きを頼める (前の会話は、記録として渡る。トラックは読み直すので、開き直した後の ID で置ける)
    await ask(page, 'もう 1 回くり返して', 2);
    await expect(toolRows(page).last()).toContainText('置いた先は 3〜4 小節、8 個');
    await expect(noteBlocks(page)).toHaveCount(16);
});

test('「新しい会話」の前の会話は履歴に残る。保存して開き直しても残り、履歴から開いて続きを頼める', async ({ page }, testInfo) => {
    await openDaw(page);
    await startFree(page);
    await openDock(page);
    const history = dock(page).getByRole('button', { name: /^履歴/ });
    await expect(history).toBeDisabled();
    await ask(page, 'ノートを置いて', 1);
    await dock(page).getByRole('button', { name: '新しい会話' }).click();
    await expect(toolRows(page)).toHaveCount(0);
    await expect(history).toHaveText('履歴 1');

    // 保存して、新しいプロジェクトにして、開き直す: 履歴も戻る
    const name = await saveProject(page, `履歴 ${testInfo.project.name} ${Date.now()}`);
    await page.getByRole('button', { name: 'プロジェクトのメニュー' }).click();
    await page.getByRole('menuitem', { name: '新しいプロジェクト' }).click();
    await expect(history).toBeDisabled();
    await openProject(page, name);
    await expect(history).toHaveText('履歴 1');

    // 履歴から開く: 前の会話が並び、区切りの後ろで続きを頼める
    await history.click();
    const list = dock(page).getByRole('region', { name: '前の会話' });
    await list.getByRole('button', { name: '「ノートを置いて」の会話を開く' }).click();
    await expect(list).toHaveCount(0);
    await expect(toolRows(page)).toHaveCount(2);
    await expect(chat(page).getByRole('separator')).toContainText('ここまでは、履歴から開き直した会話です');
    await expect(noteBlocks(page)).toHaveCount(8);
    await ask(page, 'もう 1 回くり返して', 2);
    await expect(toolRows(page).last()).toContainText('置いた先は 3〜4 小節、8 個');
    await expect(noteBlocks(page)).toHaveCount(16);
    await expectFitsWindow(page);
});

test('示せる場所のセレクタは、実際の画面に在る（いつも出ているものと、左のパネルのタブ）', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    // 出る条件の無い場所は、そのタブを開けば、画面に 1 つ以上在る
    const tabs = { learn: '学ぶ', sound: '音作り', file: 'ファイル' } as const;
    const learnTabs = { song: '曲とパート', chart: 'カルテ', guide: 'ガイド', coach: '差分' } as const;
    for (const [key, landmark] of Object.entries(LANDMARKS)) {
        if (landmark.when) continue;
        if (landmark.open) {
            await page.locator('#panel-tabs').getByRole('tab', { name: tabs[landmark.open.leftTab] }).click();
            if (landmark.open.leftTab === 'learn') await page.locator('#learn-tabs').getByRole('tab', { name: learnTabs[landmark.open.learnTab] }).click();
        }
        await expect(page.locator(landmark.selector).first(), key).toBeVisible();
    }
});
