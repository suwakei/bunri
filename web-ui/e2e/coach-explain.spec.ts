/**
 * 差分の説明 (第3層の言語化) を、画面から通す。「差分」の段の「Claude に説明してもらう」は、アシスタント (右のドック) に
 * 依頼を送るだけで、アシスタントがツール `explain_diff` で説明を作り、チャットにカードとして出す。
 *
 * 本物の Claude は呼ばない。API サーバは偽の Claude サーバ (fake-anthropic.mjs) を呼び、偽のサーバは、
 * 送られてきた事実の指摘の ID と小節を指す説明を返す。偽のサーバは呼ばれた回数を数えているので、
 * 「Claude を呼んだか」を直接確かめられる (保存済みの説明は呼ばずに出る、など)。
 *
 * 説明の保存の鍵はノートなので、ブラウザ (chromium / webkit) ごとにノートを 1 つ変えて、
 * 片方のテストで保存した説明が、もう片方で使われないようにしてある。
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import {
    askAssistantInDock, assistantChat, assistantDock, fakeLlmCalls, openDaw, openNewestLegacy, openTab, raiseDailyLimitDuringFile, waitAssistantTurns,
} from './helpers';

test.skip(Boolean(process.env.BUNRI_E2E_LLM), '偽の Claude サーバを相手にするテスト。本物を呼ぶ BUNRI_E2E_LLM=1 のときは走らせない');

// アシスタントの依頼も 1 日の上限に数えるので、このファイルのあいだだけ上げる
raiseDailyLimitDuringFile(test);

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });

// お手本: 1〜2 小節目に 4 ノート、3 小節目に 2 ノート
const REFERENCE = [note('C', 4, 0), note('E', 4, 4), note('G', 4, 8), note('C', 5, 16), note('E', 4, 32), note('G', 4, 36)];

/**
 * 違いが 4 か所ある打ち込み (抜け・高さの違い 2・余分なノート)。`variant` で余分なノートの高さを変える
 * (説明の材料に入るのは小節・拍・音名なので、位置ではなく高さで変える)。
 */
function attemptWithManyIssues(variant: number) {
    return [note('C', 4, 0), note('G', 4, 8), note('D', 5, 16), note('F', 4, 32), note('G', 4, 36), note('ABFD'[variant], 3, 48)];
}

/** お手本を持つトラック (Track 1。打ち込みもこのトラック) のプロジェクトを以前の形式で保存して、開く。 */
async function loadProject(page: Page, request: APIRequestContext, attempt: ReturnType<typeof note>[]) {
    const project = {
        bpm: 120, beatsPerBar: 4,
        tracks: [{ name: 'Track 1', pianoNotes: attempt, referenceNotes: REFERENCE }],
        automation: {},
    };
    expect((await request.post('/api/project/save', { form: { data: JSON.stringify(project) } })).ok()).toBe(true);
    await openDaw(page);
    // 以前の形式 (API で用意した projects/*.json) として開く
    await openNewestLegacy(page);
}

/** 差分の説明を Claude (偽) に作らせた回数。 */
async function explainCalls(page: Page): Promise<number> {
    return (await fakeLlmCalls(page)).explain;
}

/** 差分の段を開いて比べる。差分のパネルを返す。パネルは、説明の API を呼ばない。 */
async function compare(page: Page) {
    await openTab(page, '差分');
    const coach = page.locator('#coach-panel');
    const diffed = page.waitForResponse((r) => r.url().endsWith('/api/coach/diff'));
    await coach.getByRole('button', { name: 'お手本と比べる' }).click();
    expect((await diffed).ok()).toBe(true);
    return coach;
}

/** 差分の段の「Claude に説明してもらう」で頼み、答え終わるまで待つ。説明のカードを返す。 */
async function askExplain(page: Page, coach: ReturnType<Page['locator']>, turns: number) {
    await coach.getByRole('button', { name: 'Claude に説明してもらう' }).click();
    await expect(assistantDock(page)).toBeVisible();
    await waitAssistantTurns(page, turns, '説明の依頼');
    return assistantChat(page).getByRole('region', { name: '差分の説明（Track 1）' }).last();
}

/** ブラウザごとに違う数 (説明の保存がブラウザをまたいで使われないように)。 */
const variantOf = (testInfo: TestInfo, salt: number) => (testInfo.project.name === 'webkit' ? 2 : 0) + salt;

/** 小節と拍から、再生位置の表示 (120 BPM・4/4) を作る。 */
function timeAt(bar: number, beat: number) {
    const sec = (bar - 1) * 2 + (beat - 1) * 0.5;
    return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
}

test('「Claude に説明してもらう」でドックが開き、選んだモデルの説明がカードに出る。札を押すとその小節へ移り、差分の段の一覧で示す', async ({ page, request }, testInfo) => {
    await loadProject(page, request, attemptWithManyIssues(variantOf(testInfo, 0)));
    const before = await fakeLlmCalls(page);
    const savedLookups: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/coach/explain')) savedLookups.push(r.url()); });
    const coach = await compare(page);
    await expect(coach.getByText('抜け 1 / 高さの違い 2 / 余分なノート 1')).toBeVisible();
    // 比べただけでは、説明の API を呼ばない (保存済みも探さない)。設定の欄はドックにだけ在る
    await expect(coach.getByRole('button', { name: 'Claude に説明してもらう' })).toBeVisible();
    await expect(coach.getByText(/差分チェックの結果）を\s*Anthropic の Claude に送ります/)).toBeVisible();
    await expect(coach.getByRole('button', { name: 'API キーと上限の設定' })).toHaveCount(0);
    expect(savedLookups).toEqual([]);

    const card = await askExplain(page, coach, 1);
    await expect(assistantChat(page).locator('.assistant-msg.user')).toHaveText('あなた: 差分を説明して（Track 1）');
    const points = card.getByRole('list', { name: '見直すとよい点' }).locator(':scope > li');
    await expect(points).toHaveCount(2);
    const after = await fakeLlmCalls(page);
    expect(after.explain).toBe(before.explain + 1);
    // 依頼ごとにルーターが 1 回だけ選び (偽のルーターは「説明」で Sonnet)、説明もそのモデルで作る
    expect(after.router).toBe(before.router + 1);
    expect(after.models.explain.at(-1)).toBe('claude-sonnet-5-5');
    await expect(card).toContainText('これはテスト用の偽の説明です。お手本との違いが');
    await expect(points.first()).toContainText('考えられる理由');
    await expect(card).toContainText('この説明を作ったときの使用量: 入力 3,020 トークン');
    await expect(assistantChat(page).locator('.assistant-turn-model')).toHaveText('Sonnet');
    await test.info().attach('coach-explanation-card', { body: await assistantDock(page).screenshot(), contentType: 'image/png' });

    // 1 つ目の点の札 (指摘を指す) を押すと、その拍へ移り、差分の段の指摘の一覧の行が示される
    const chip = points.first().locator('.coach-refs button').first();
    const [, bar, beat] = (await chip.textContent())!.match(/(\d+) 小節 (\d+) 拍目/)!.map(Number);
    await chip.click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');
    await expect(page.locator('#time-display')).toHaveText(timeAt(bar, beat));
    const highlighted = coach.locator('li.coach-issue[aria-current="true"]');
    await expect(highlighted).toHaveCount(1);
    await expect(highlighted).toContainText(`${bar} 小節 ${beat} 拍目`);

    // 2 つ目の点の札は小節だけを指す。押すと、その小節の頭へ移る (一覧の行は示さない)
    const barChip = points.nth(1).locator('.coach-refs button').first();
    const barOnly = Number((await barChip.textContent())!.match(/(\d+) 小節/)![1]);
    await barChip.click();
    await expect(page.locator('#time-display')).toHaveText(timeAt(barOnly, 1));
    await expect(highlighted).toHaveCount(0);

    // 「最初にやること」の札でも移れる。キーボードでも押せる
    const nextChip = card.getByRole('button', { name: `${bar} 小節へ` });
    await nextChip.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#time-display')).toHaveText(timeAt(bar, 1));
});

test('同じ打ち込みで比べ直して頼むと、保存済みの説明が出て、説明は作り直さない。作り直してと頼んだときだけ作る', async ({ page, request }, testInfo) => {
    const attempt = attemptWithManyIssues(variantOf(testInfo, 1));
    await loadProject(page, request, attempt);
    let coach = await compare(page);
    await askExplain(page, coach, 1);
    const afterFirst = await explainCalls(page);

    // 開き直して、同じ打ち込みで比べ直し、もう一度頼む。保存済みが出て、説明の Claude は呼ばれない
    await loadProject(page, request, attempt);
    coach = await compare(page);
    const card = await askExplain(page, coach, 1);
    await expect(card.getByRole('list', { name: '見直すとよい点' }).locator(':scope > li')).toHaveCount(2);
    await expect(card).toContainText('保存済みの説明を出しました（Claude は呼んでいません');
    expect(await explainCalls(page)).toBe(afterFirst);

    // 作り直してと頼んだときだけ、もう一度呼ぶ
    await askAssistantInDock(page, '説明を作り直して', 2);
    await expect.poll(() => explainCalls(page)).toBe(afterFirst + 1);
    await expect(assistantChat(page).locator('.assistant-card')).toHaveCount(2);
});

test('違いがごく少ないときは、説明の Claude を呼ばずに、決まった文の案内がカードに出る', async ({ page, request }) => {
    // 違いは 1 か所だけ (E4 の抜け)
    await loadProject(page, request, REFERENCE.filter((_, i) => i !== 1));
    const before = await explainCalls(page);
    const coach = await compare(page);
    const card = await askExplain(page, coach, 1);
    await expect(card).toContainText('違いは 1 か所だけです。');
    await expect(card).toContainText('違いが少なく一覧を読めば足りるので、Claude は呼んでいません');
    // 費用はかからないので、使用量は出さない
    await expect(card).not.toContainText('使用量');
    expect(await explainCalls(page)).toBe(before);
    // 案内の小節へも移れる
    await card.getByRole('button', { name: '1 小節へ' }).click();
    await expect(page.locator('#time-display')).toHaveText('0:00.0');
});
