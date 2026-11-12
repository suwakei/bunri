/**
 * 時間のかかる処理 (ジョブ) の、進み具合のカード・中止・2 つ目を断る (409)・開き直したときのつなぎ直し。
 *
 * 本物の音源分離は数分かかりモデルも要るので、API サーバのテスト用の遅いジョブ (backend/web/e2e_routes.py。
 * playwright.config.ts が BUNRI_E2E_HOOKS=1 を付けたときだけ在る) を使う。名前とステージは本物と同じ。
 * 画面のボタンから始める流れを確かめるときは、始めるリクエストを遅いジョブへ付け替える (`slowRoute`)。
 */
import { expect, test, type Page } from '@playwright/test';
import { cancelActiveJobs, importSong, makeWav, openDaw, openTab, runJob, startSlowJob, statusText } from './helpers';

const wav = (name: string) => ({ name, mimeType: 'audio/wav', buffer: makeWav(4, [261.63, 329.63, 392.0, 523.25]) });

/** 画面が `path?async=1` で始めるジョブを、同じ種類の遅いジョブへ付け替える。 */
async function slowRoute(page: Page, path: string, kind: string, seconds: number, filename: string) {
    await page.route((url) => url.pathname === path && url.searchParams.get('async') === '1', (route) =>
        route.continue({ url: new URL(`/api/e2e/slow-job?kind=${kind}&seconds=${seconds}&filename=${encodeURIComponent(filename)}`, route.request().url()).toString() }));
}

/** ジョブの状態を API で聞く。 */
async function jobState(page: Page, id: string): Promise<string> {
    return (await (await page.request.get(`/api/jobs/${id}`)).json()).state;
}

test.afterEach(async ({ page }) => {
    // API サーバはほかのテストと共用なので、動いているジョブを残さない
    await cancelActiveJobs(page);
});

test('曲を取り込むと、進み具合のカードに処理の名前・段階・経過時間が出て、中止できる', async ({ page }) => {
    await openDaw(page);
    await slowRoute(page, '/api/chart', 'chart', 30, 'e2e-card.wav');
    const started = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/e2e/slow-job');
    await importSong(page, wav('e2e-card.wav'));
    const { id } = await (await started).json();

    const card = page.locator('#song-panel').getByRole('group', { name: '楽曲カルテの作成の進み具合' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('e2e-card.wav');
    await expect(card).toContainText(/テンポと拍を調べています|キーを調べています/);
    await expect(card).toContainText(/段階 [12]\/6/);
    // カルテの段階は割合が分からないので、動き続けるバー
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '割合は分かりません');
    await expect(card).toContainText(/経過 [1-9]\d*秒/, { timeout: 5_000 });
    // 待っている間に何ができるか
    await expect(card).toContainText('待っている間も');
    // ステータスバーにも小さく出る。動いている間は、始めるボタンを押せない
    await expect(page.locator('#job-indicator')).toContainText('楽曲カルテの作成');
    await expect(page.locator('#song-panel').getByRole('button', { name: /曲を取り込む/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /パートに分けて採譜する/ })).toBeDisabled();
    await testInfoAttach(page, card, 'job-card');

    await card.getByRole('button', { name: '中止' }).click();
    await expect(card).toBeHidden({ timeout: 5_000 });
    await expect(statusText(page)).toContainText('カルテの作成を中止しました');
    expect(await jobState(page, id)).toBe('cancelled');
    await expect(page.locator('#job-indicator')).toHaveCount(0);
    await expect(page.locator('#song-panel').getByRole('button', { name: /曲を取り込む/ })).toBeEnabled();
});

test('割合の分かる段階では数字のバーになり、初回のモデルのダウンロードは段階の名前で分かる', async ({ page }) => {
    await page.goto('/tools');
    await startSlowJob(page, 'separate', 6, 'e2e-model.wav');
    // ツールの画面では、いま開いているタブの外で動いている処理をページの上に出す
    const card = page.getByRole('group', { name: 'パート分離の進み具合' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('モデルをダウンロードしています（初回のみ）');
    await expect(card).toContainText('段階 1/2');
    await expect(card).toContainText('初めて使うときだけ');
    await testInfoAttach(page, card, 'job-card-model');
    // 分離の段階は、処理した区間の割合が出る
    await expect(card).toContainText('パートに分けています', { timeout: 10_000 });
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /\d+/);
    await expect(card).toContainText(/段階 2\/2/);
    await expect(card).toContainText(/\d+%/);
    // 始めるボタンは、終わるまで押せない
    await page.getByRole('button', { name: 'パート分離', exact: true }).click();
    await expect(page.getByRole('button', { name: 'パート分離を始める' })).toBeDisabled();
    await expect(card).toBeHidden({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'パート分離を始める' })).toBeEnabled();
});

test('ほかの処理が動いているときに始めると断られ、何が動いているかと、それを止める場所が出る', async ({ page }) => {
    const slow = await startSlowJob(page, 'separate', 60, 'e2e-busy.wav');
    await openDaw(page);
    // ステータスバーに、動いている処理が出る (ツールの画面で始めた処理なので、ここで中止できる)
    await expect(page.locator('#job-indicator')).toContainText('パート分離');
    // 画面がまだ気づいていない瞬間に始めた、という状況を作る (ファイルの欄に直接渡す)
    const refused = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/chart' && r.request().method() === 'POST');
    await importSong(page, wav('e2e-refused.wav'));
    expect((await refused).status()).toBe(409);

    const notice = page.locator('#song-panel .job-busy');
    await expect(notice).toContainText('「e2e-busy.wav」のパート分離を実行中です。終わるか、中止してから始めてください');
    await expect(statusText(page)).toContainText('パート分離を実行中です');
    // 断られたので、原曲のトラックは作らない
    await expect(page.locator('#tracks-container .track-row')).toHaveCount(0);
    // 「実行中の処理を見る」で、止められる場所 (ステータスバーの中止) へ移る
    await notice.getByRole('button', { name: '実行中の処理を見る' }).click();
    const cancel = page.locator('#job-indicator').getByRole('button', { name: '中止' });
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect.poll(() => jobState(page, slow.id)).toBe('cancelled');
    await expect(notice).toBeHidden();
    await expect(page.locator('#job-indicator')).toHaveCount(0);
});

test('画面を開き直しても、動いている処理のカードに戻れる', async ({ page }) => {
    await openDaw(page);
    await slowRoute(page, '/api/chart', 'chart', 30, 'e2e-reload.wav');
    const started = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/e2e/slow-job');
    await importSong(page, wav('e2e-reload.wav'));
    const { id } = await (await started).json();
    const card = () => page.locator('#song-panel').getByRole('group', { name: '楽曲カルテの作成の進み具合' });
    await expect(card()).toBeVisible();

    await page.reload();
    await page.getByText('準備完了').waitFor();
    // 始めた場所 (曲とパート) のカードに、同じ処理がつなぎ直される
    await expect(card()).toBeVisible();
    await expect(card()).toContainText('e2e-reload.wav');
    await expect(page.locator('#job-indicator')).toContainText('楽曲カルテの作成');
    // ステータスバーの表示を押すと、カードの在る場所が開く
    await openTab(page, 'シンセ');
    await page.locator('#job-indicator').getByRole('button', { name: /実行中: 楽曲カルテの作成/ }).click();
    await expect(page.getByRole('tab', { name: '曲とパート' })).toHaveAttribute('aria-selected', 'true');
    await expect(card()).toBeFocused();

    await card().getByRole('button', { name: '中止' }).click();
    await expect.poll(() => jobState(page, id)).toBe('cancelled');
    await expect(card()).toBeHidden();
    await expect(statusText(page)).toContainText('カルテの作成を中止しました');
});

test('グリッドを補正して確定すると、カルテの再計算がジョブとして走り、終わるとモーダルが閉じる', async ({ page }) => {
    await openDaw(page);
    const analyzed = await runJob(page, '/api/chart', () => importSong(page, wav('e2e-regrid.wav')));
    expect(analyzed.state).toBe('done');
    await page.getByRole('button', { name: 'グリッドを確認・補正する' }).click();
    const dialog = page.getByRole('dialog', { name: 'グリッドの確認・補正' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('BPM').fill('100');
    const regrid = await runJob(page, '/api/chart/regrid', () => dialog.getByRole('button', { name: 'この設定で確定して再計算' }).click());
    expect(regrid.state).toBe('done');
    await expect(dialog).toBeHidden();
    await expect(statusText(page)).toContainText('グリッドを確定しました（BPM 100.0）');
});

/** カードの画像を結果に添える (見た目を目で確かめられるように)。 */
async function testInfoAttach(page: Page, locator: ReturnType<Page['locator']>, name: string) {
    await test.info().attach(name, { body: await locator.screenshot(), contentType: 'image/png' });
}
