/**
 * 差分の説明 (第3層の言語化) を、画面から通す。
 *
 * 本物の Claude は呼ばない。API サーバは偽の Claude サーバ (fake-anthropic.mjs) を呼び、偽のサーバは、
 * 送られてきた事実の指摘の ID と小節を指す説明を返す。偽のサーバは呼ばれた回数を数えているので、
 * 「Claude を呼んだか」を直接確かめられる (保存済みの説明は呼ばずに出る、など)。
 *
 * 説明の保存の鍵はノートなので、ブラウザ (chromium / webkit) ごとにノートを 1 つ変えて、
 * 片方のテストで保存した説明が、もう片方で使われないようにしてある。
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { FAKE_LLM_URL, openDaw, openTab, openNewestLegacy } from './helpers';

test.skip(Boolean(process.env.BUNRI_E2E_LLM), '偽の Claude サーバを相手にするテスト。本物を呼ぶ BUNRI_E2E_LLM=1 のときは走らせない');

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
    return (await (await page.request.get(`${FAKE_LLM_URL}/__calls`)).json()).explain;
}

/** 差分の段を開いて比べ、説明を探し終わるまで待つ。差分のパネルを返す。 */
async function compare(page: Page) {
    await openTab(page, '差分');
    const coach = page.locator('#coach-panel');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/coach/explain/saved'));
    await coach.getByRole('button', { name: 'お手本と比べる' }).click();
    expect((await saved).ok()).toBe(true);
    return coach;
}

/** ブラウザごとに違う数 (説明の保存がブラウザをまたいで使われないように)。 */
const variantOf = (testInfo: TestInfo, salt: number) => (testInfo.project.name === 'webkit' ? 2 : 0) + salt;

/** 小節と拍から、再生位置の表示 (120 BPM・4/4) を作る。 */
function timeAt(bar: number, beat: number) {
    const sec = (bar - 1) * 2 + (beat - 1) * 0.5;
    return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
}

test('Claude に説明してもらうと、点と場所の札が出て、札を押すとその小節へ移り、指摘の一覧で示す', async ({ page, request }, testInfo) => {
    await loadProject(page, request, attemptWithManyIssues(variantOf(testInfo, 0)));
    const before = await explainCalls(page);
    const coach = await compare(page);
    await expect(coach.getByText('抜け 1 / 高さの違い 2 / 余分なノート 1')).toBeVisible();
    // まだ保存済みの説明は無い。比べただけでは Claude を呼ばない
    const ask = coach.getByRole('button', { name: 'Claude に説明してもらう' });
    await expect(ask).toBeVisible();
    await expect(coach.getByText(/差分チェックの結果）を Anthropic の Claude に送ります/)).toBeVisible();
    expect(await explainCalls(page)).toBe(before);

    await ask.click();
    const points = coach.getByRole('list', { name: '見直すとよい点' }).locator(':scope > li');
    await expect(points).toHaveCount(2);
    expect(await explainCalls(page)).toBe(before + 1);
    await expect(coach).toContainText('これはテスト用の偽の説明です。お手本との違いが');
    await expect(points.first()).toContainText('考えられる理由');
    // 使った量と今日の累計 (再現ガイドと同じ出し方)
    await expect(coach.locator('#coach-usage')).toContainText('入力 3,020 トークン');
    await expect(coach.locator('#coach-today')).toContainText(/今日 Claude を呼んだ回数: \d+ 回/);
    await expect(coach.getByRole('button', { name: '説明を作り直す（費用がかかります）' })).toBeVisible();
    await test.info().attach('coach-explanation', { body: await coach.screenshot(), contentType: 'image/png' });

    // 1 つ目の点の札 (指摘を指す) を押すと、その拍へ移り、指摘の一覧の行が示される
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

    // 「最初にやること」の札でも移れる
    await coach.getByRole('button', { name: `${bar} 小節へ` }).click();
    await expect(page.locator('#time-display')).toHaveText(timeAt(bar, 1));
});

test('同じ打ち込みで比べ直すと、保存済みの説明が Claude を呼ばずに出る。作り直したときだけ呼ぶ', async ({ page, request }, testInfo) => {
    const attempt = attemptWithManyIssues(variantOf(testInfo, 1));
    await loadProject(page, request, attempt);
    let coach = await compare(page);
    await coach.getByRole('button', { name: 'Claude に説明してもらう' }).click();
    await expect(coach.getByRole('list', { name: '見直すとよい点' })).toBeVisible();
    const afterFirst = await explainCalls(page);

    // 開き直して、同じ打ち込みで比べ直す。押さなくても説明が出て、Claude は呼ばれない
    await loadProject(page, request, attempt);
    coach = await compare(page);
    await expect(coach.getByRole('list', { name: '見直すとよい点' }).locator(':scope > li')).toHaveCount(2);
    await expect(coach.getByText(/この説明は保存済みです/)).toBeVisible();
    expect(await explainCalls(page)).toBe(afterFirst);

    // 作り直すと明示的に押したときだけ、もう一度呼ぶ
    await coach.getByRole('button', { name: '説明を作り直す（費用がかかります）' }).click();
    await expect.poll(() => explainCalls(page)).toBe(afterFirst + 1);
    await expect(coach.getByRole('list', { name: '見直すとよい点' }).locator(':scope > li')).toHaveCount(2);
});

test('違いがごく少ないときは、Claude を呼ばずに決まった文の案内が出る', async ({ page, request }) => {
    // 違いは 1 か所だけ (E4 の抜け)
    await loadProject(page, request, REFERENCE.filter((_, i) => i !== 1));
    const before = await explainCalls(page);
    const coach = await compare(page);
    await expect(coach.getByText('違いは 1 か所だけです。', { exact: false })).toBeVisible();
    await expect(coach.getByText(/違いが少なく一覧を読めば足りるので、Claude は呼んでいません/)).toBeVisible();
    // 費用はかからないので、頼むボタンも費用の表示も出さない
    await expect(coach.getByRole('button', { name: 'Claude に説明してもらう' })).toHaveCount(0);
    await expect(coach.locator('#coach-usage')).toHaveCount(0);
    expect(await explainCalls(page)).toBe(before);
    // 案内の小節へも移れる
    await coach.getByRole('button', { name: '1 小節へ' }).click();
    await expect(page.locator('#time-display')).toHaveText('0:00.0');
});
