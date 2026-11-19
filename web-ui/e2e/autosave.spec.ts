/**
 * 自動保存と、落ちたときの復旧 (lib/autosave.ts): 保存していない変更は、復旧用の写しとして自動で残る。
 * 保存せずに画面を開き直す (落ちたのと同じ) と「続きを開きますか」と尋ねられ、続きを開くと、ノート・音声・名前が戻り、
 * 保存していない変更になる。捨てる・保存する・元に戻して保存したときと同じにすると、次は尋ねられない。
 *
 * 普段のテストは自動保存を止めている (`openDaw`)。ここだけ、短い間隔で動かす。データ置き場は全部のテストで共有なので、
 * 復旧用の写しは、テストの前後で必ず消す (残すと、ほかのテストの起動で窓が出る)。
 *
 * 開発用のブラウザ起動なので、保存先はデータ置き場の projects/。デスクトップ版の「元のファイルへ保存」は、復旧用の写しの
 * 目印が持つ場所を Rust に渡すだけ (Rust は変えていない)。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { openDaw, openProject, openTab, saveProject, statusText, trackSummary, wavFile } from './helpers';

/** 自動保存の間隔 (ミリ秒)。ふだんは、最後の変更から 30 秒・長くても 2 分。 */
const FAST = { idleMs: 400, maxWaitMs: 4000, retryMs: 200 };
const TITLE = '前回、保存していない変更が残っています';
const RECOVERY = '/api/project/recovery';

const pathOf = (url: string) => new URL(url).pathname;

/** 置き場に在る復旧用の写しの目印 (無ければ null)。 */
async function recovery(request: APIRequestContext): Promise<{ name: string | null; file: string | null; saved_at: number } | null> {
    return (await (await request.get(RECOVERY)).json()).recovery;
}

interface SentDocument { tracks: { name: string; notes: unknown[]; clips: { name: string; audio: string | null }[] }[] }

/**
 * `has` に合う文書を送った自動保存が、復旧用の写しを置き終わるのを待つ。変える操作の前に仕掛ける
 * (操作の途中の形を送った自動保存では、待ち終わらない)。
 */
function autosaved(page: Page, has: (doc: SentDocument) => boolean): Promise<unknown> {
    let matched = false;
    return page.waitForResponse((response) => {
        const request = response.request();
        if (request.method() !== 'POST') return false;
        if (pathOf(response.url()) === '/api/project/document') {
            matched = has((request.postDataJSON() as { document: SentDocument }).document);
            return false;
        }
        return matched && pathOf(response.url()) === RECOVERY && response.ok();
    }, { timeout: 30_000 });
}

/** 画面を開き直して、起動したときの確かめ (前回の続きが在るか) が終わるのを待つ。 */
async function reopen(page: Page): Promise<void> {
    const checked = page.waitForResponse((r) => r.request().method() === 'GET' && pathOf(r.url()) === RECOVERY);
    await page.reload();
    await checked;
    await page.getByText('準備完了').or(page.getByRole('alertdialog', { name: TITLE })).first().waitFor();
}

/** 先頭のトラックを開いて、ピアノロールにノートを 1 つ置く。 */
async function placeNote(page: Page, x: number, y: number): Promise<void> {
    const before = await page.locator('#note-layer .note-block').count();
    await page.locator('#note-layer').dblclick({ position: { x, y } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(before + 1);
}

test.beforeEach(async ({ request }) => { await request.delete(RECOVERY); });
test.afterEach(async ({ request }) => { await request.delete(RECOVERY); });

test('保存していない変更は自動で残り、開き直すと尋ねられる。続きを開くと、ノート・音声・名前が戻って保存していない変更になり、保存すると元のプロジェクトに入る', async ({ page, request }, testInfo) => {
    await openDaw(page, { autosave: FAST });
    await page.getByRole('button', { name: '自由に作る' }).click();
    const name = await saveProject(page, `自動保存-${testInfo.project.name}-${Date.now()}`);
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(0);
    // 保存した直後は、復旧用の写しは無い
    expect(await recovery(request)).toBeNull();

    // 音声のクリップを置き、ノートを 2 つ置く。保存はしない
    const written = autosaved(page, (doc) => doc.tracks[0]?.notes.length === 2 && doc.tracks[0].clips.length === 1);
    await openTab(page, 'ファイル');
    await page.locator('#file-import').setInputFiles(wavFile('autosave-take.wav'));
    await page.getByRole('button', { name: '選択したトラックに追加' }).click();
    await expect(statusText(page)).toHaveText('autosave-take.wav を「Track 1」に追加しました');
    await page.locator('#tracks-container .track-name').first().click();
    await placeNote(page, 10, 100);
    await placeNote(page, 90, 140);
    const status = await statusText(page).textContent();
    await written;

    // 自動保存しても、保存していない変更のしるしは消えない。ステータスバーにも何も出ない。保存した中身もそのまま
    await expect(page.locator('#project-title')).toHaveText(`${name}●`);
    expect(await page.title()).toBe(`${name} ● — bunri`);
    await expect(statusText(page)).toHaveText(status ?? '');
    await expect(page.locator('#btn-undo')).toBeEnabled();
    const mark = await recovery(request);
    expect(mark).toMatchObject({ name, file: `${name}.bunri` });
    expect(Date.now() / 1000 - mark!.saved_at).toBeLessThan(60);

    // 保存せずに画面を開き直す (落ちたのと同じ)。起動すると、続きを開くか尋ねられる
    await reopen(page);
    const dialog = page.getByRole('alertdialog', { name: TITLE });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#recovery-name')).toHaveText(name);
    await expect(dialog.locator('#recovery-time')).toHaveText(/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}/);
    await expect(dialog.getByRole('button', { name: '続きを開く' })).toBeFocused();
    // Esc では閉じない (どちらかを選ぶ)
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await testInfo.attach('recovery-dialog', { body: await page.screenshot(), contentType: 'image/png' });

    await dialog.getByRole('button', { name: '続きを開く' }).click();
    await expect(statusText(page)).toContainText(`前回の続き（「${name}」）を開きました`, { timeout: 30_000 });
    await expect(dialog).toHaveCount(0);
    // ノートと音声が戻り、名前も元のまま。保存していない変更のしるしが付く
    expect(await trackSummary(page)).toEqual([{ name: 'Track 1', clips: ['autosave-take.wav'] }]);
    await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveText('2');
    await expect(page.locator('#note-layer .note-block')).toHaveCount(2);
    await expect(page.locator('#project-title')).toHaveText(`${name}●`);
    await expect(page.getByRole('region', { name: '音声の無いクリップ' })).toHaveCount(0);
    await expect(page.locator('#btn-undo')).toBeDisabled();
    // 開いただけでは、復旧用の写しは残る (もう一度落ちても、続きを開ける)
    expect(await recovery(request)).not.toBeNull();
    await testInfo.attach('recovered', { body: await page.screenshot(), contentType: 'image/png' });

    // 保存すると、名前を尋ねられずに元のプロジェクトへ入る。音声は送り直さない (復旧用の写しに在る)
    const puts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/project/audio/')) puts.push(r.url()); });
    await saveProject(page);
    await expect(page.locator('#project-title')).toHaveText(name);
    expect(puts).toEqual([]);
    expect(await recovery(request)).toBeNull();
    const library = await (await request.get('/api/project/library')).json() as { projects: { name: string }[] };
    expect(library.projects.filter((p) => p.name === name)).toHaveLength(1);

    // 保存したあとは、開き直しても尋ねられない。保存した中身に、続きの変更が入っている
    await reopen(page);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('#empty-state')).toBeVisible();
    await openProject(page, name);
    expect(await trackSummary(page)).toEqual([{ name: 'Track 1', clips: ['autosave-take.wav'] }]);
    await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveText('2');
});

test('「捨てる」を選ぶと、前回の変更を消して、何も開かない。次に開き直しても尋ねられない', async ({ page, request }) => {
    await openDaw(page, { autosave: FAST });
    const written = autosaved(page, (doc) => doc.tracks[0]?.notes.length === 1);
    await page.getByRole('button', { name: '自由に作る' }).click();
    await page.locator('#tracks-container .track-name').first().click();
    await placeNote(page, 10, 100);
    await written;
    // まだ名前の無いプロジェクトでも残る
    expect(await recovery(request)).toMatchObject({ name: null, file: null });

    await reopen(page);
    const dialog = page.getByRole('alertdialog', { name: TITLE });
    await expect(dialog.locator('#recovery-name')).toHaveText('無題のプロジェクト');
    await dialog.getByRole('button', { name: '捨てる' }).click();
    await expect(statusText(page)).toHaveText('前回の、保存していない変更を捨てました');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#project-title')).toHaveText('無題のプロジェクト');
    expect(await recovery(request)).toBeNull();

    await reopen(page);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('#empty-state')).toBeVisible();
});

test('保存したあと・元に戻して保存したときと同じにしたあとは、開き直しても尋ねられない', async ({ page, request }, testInfo) => {
    await openDaw(page, { autosave: FAST });
    await page.getByRole('button', { name: '自由に作る' }).click();
    await page.locator('#tracks-container .track-name').first().click();

    // 変更 → 自動保存 → 保存: 復旧用の写しは消える
    let written = autosaved(page, (doc) => doc.tracks[0]?.notes.length === 1);
    await placeNote(page, 10, 100);
    await written;
    expect(await recovery(request)).not.toBeNull();
    const name = await saveProject(page, `自動保存のあと保存-${testInfo.project.name}-${Date.now()}`);
    expect(await recovery(request)).toBeNull();
    await reopen(page);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    // 開いて、変更 → 自動保存 → 元に戻す (保存したときと同じ): しるしが消え、復旧用の写しも消える
    await openProject(page, name);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
    written = autosaved(page, (doc) => doc.tracks[0]?.notes.length === 2);
    await placeNote(page, 90, 140);
    await written;
    expect(await recovery(request)).toMatchObject({ name });
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(0);
    await expect.poll(() => recovery(request)).toBeNull();
    await reopen(page);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    // 開いて、変更 → 自動保存 → 「保存しない」で新しいプロジェクトにする: 正しく手放した変更なので、次は尋ねられない
    await openProject(page, name);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
    written = autosaved(page, (doc) => doc.tracks[0]?.notes.length === 2);
    await placeNote(page, 90, 140);
    await written;
    await page.getByRole('button', { name: 'プロジェクトのメニュー' }).click();
    await page.getByRole('menuitem', { name: '新しいプロジェクト' }).click();
    await page.getByRole('alertdialog', { name: '保存していない変更があります' }).getByRole('button', { name: '保存しない' }).click();
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect.poll(() => recovery(request)).toBeNull();
    await reopen(page);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
