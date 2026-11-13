/**
 * お手本の重ね表示と、差分チェック (第3層の土台) を、画面から通す。
 *
 * お手本は本来、楽曲の解析 (採譜) で出来る。採譜は数分かかるので、ここではお手本入りの
 * プロジェクトを API で保存しておき、画面の「開く」で以前の形式として開く。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { openDaw, openTab, openNewestLegacy } from './helpers';

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });

// お手本: 1〜2 小節目に C4 E4 G4 C5、12 小節目に E4 (遠くの小節への移動を確かめるため)
const REFERENCE = [note('C', 4, 0), note('E', 4, 4), note('G', 4, 8), note('C', 5, 16), note('E', 4, 176)];

/** お手本を持つトラック (Track 1) と、自分で打ち込むトラック (Track 2) のプロジェクトを保存する。 */
async function saveProject(request: APIRequestContext, attempt = REFERENCE) {
    const project = {
        bpm: 120, beatsPerBar: 4,
        tracks: [
            { name: 'Track 1', pianoNotes: attempt, referenceNotes: REFERENCE },
            { name: 'Track 2', pianoNotes: [] },
        ],
        automation: {},
    };
    const resp = await request.post('/api/project/save', { form: { data: JSON.stringify(project) } });
    expect(resp.ok()).toBe(true);
}

async function loadProject(page: Page) {
    await openDaw(page);
    // 以前の形式 (API で用意した projects/*.json) として開く
    await openNewestLegacy(page);
}

test('お手本を持つトラックを開くと、お手本が薄く重なり、長さもお手本に合わせて伸びる', async ({ page, request }) => {
    await saveProject(request);
    await loadProject(page);
    await page.locator('#tracks-container .track-name').first().click();

    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(REFERENCE.length);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(REFERENCE.length);
    // 12 小節目のお手本まで見えるよう、8 小節より長くなっている
    expect(await page.locator('#piano-grid-wrap').evaluate((el) => el.scrollWidth)).toBeGreaterThan(128 * 20);

    // お手本は押しても反応しない (下のグリッドに届く)。重ねるのをやめると消える
    await page.getByLabel('お手本を重ねる').selectOption('off');
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(0);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(REFERENCE.length);
});

test('お手本を持たないトラックでは、お手本にするトラックを選んで重ねられる', async ({ page, request }) => {
    await saveProject(request);
    await loadProject(page);
    await page.locator('#tracks-container .track-name').nth(1).click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 2');
    // 自分のお手本は無いので、既定では何も重ならない
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(0);

    await page.getByLabel('お手本を重ねる').selectOption({ label: 'Track 1 のお手本' });
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(REFERENCE.length);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);

    // お手本をなぞってダブルクリックすると、自分のノートとして入る
    // (お手本の C4 は 1 小節目の頭。一番上の行が B8 なので、C4 は 59 行目)
    await page.locator('#piano-grid-wrap').evaluate((el) => { el.scrollTop = 59 * 14 - 100; });
    const ghost = (await page.locator('#note-layer .note-ghost').first().boundingBox())!;
    await page.mouse.dblclick(ghost.x + 10, ghost.y + 6);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
    await expect(page.locator('#note-layer .note-block')).toHaveAttribute('data-note', /^C4 step:0 /);
});

test('差分チェックで違いが出て、指摘を押すとその小節がピアノロールに出る', async ({ page, request }) => {
    // 打ち込み: E4 を抜かし、12 小節目の E4 を F4 に間違えている
    await saveProject(request, [note('C', 4, 0), note('G', 4, 8), note('C', 5, 16), note('F', 4, 176)]);
    await loadProject(page);
    await openTab(page, '差分');

    const coach = page.locator('#coach-panel');
    await coach.getByRole('button', { name: 'お手本と比べる' }).click();
    await expect(coach.getByText('60%', { exact: true })).toBeVisible();
    await expect(coach.getByText('抜け 1 / 高さの違い 1')).toBeVisible();
    await expect(coach.getByText('1 小節 2 拍目: E4 が抜けています')).toBeVisible();

    // 12 小節目の指摘を押す → 比べたトラックがピアノロールに開き、12 小節目まで横に移動する
    await coach.getByRole('button', { name: '12 小節 1 拍目: F4 → お手本は E4' }).click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');
    const scrollLeft = await page.locator('#piano-grid-wrap').evaluate((el) => el.scrollLeft);
    const view = await page.locator('#piano-grid-wrap').evaluate((el) => el.clientWidth);
    // 176 ステップ目 (= 3520px) が、見えている範囲に入っている
    expect(scrollLeft).toBeLessThanOrEqual(176 * 20);
    expect(scrollLeft + view).toBeGreaterThan(176 * 20);
    expect(scrollLeft).toBeGreaterThan(0);
    // 縦も、その音の高さ (F4) まで動いている
    const wrap = (await page.locator('#piano-grid-wrap').boundingBox())!;
    const f4 = (await page.locator('#note-layer .note-block[data-note^="F4 "]').boundingBox())!;
    expect(f4.y).toBeGreaterThanOrEqual(wrap.y);
    expect(f4.y + f4.height).toBeLessThanOrEqual(wrap.y + wrap.height);
    // 再生位置も、その小節 (12 小節目の頭 = 22 秒) へ移る
    await expect(page.locator('#time-display')).toHaveText('0:22.0');
});

test('以前の版が保存した、オートメーションのデータを含むプロジェクトも、そのまま読み込める', async ({ page, request }) => {
    // オートメーションの欄は外したので、データが在っても無視する (読み込みは失敗しない)
    const project = {
        bpm: 100, beatsPerBar: 4,
        tracks: [{ name: 'Lead', pianoNotes: REFERENCE, referenceNotes: REFERENCE }],
        automation: { '1_volume': [{ time: 0.5, value: 0.8 }, { time: 2, value: 0.2 }], '2_pan': [{ time: 1, value: 0.5 }] },
    };
    expect((await request.post('/api/project/save', { form: { data: JSON.stringify(project) } })).ok()).toBe(true);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await loadProject(page);
    await expect(page.locator('#transport input[type="number"]')).toHaveValue('100');
    await expect(page.locator('#tracks-container .track-name').first()).toContainText('Lead');
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(REFERENCE.length);
    await expect(page.locator('#automation-area')).toHaveCount(0);
    expect(errors).toEqual([]);

    // 保存し直すと (.bunri になる。以前の形式から開いたので名前を尋ねられる)、オートメーションのデータは残らない
    const saved = page.waitForRequest((r) => r.url().endsWith('/api/project/document'));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'プロジェクトを保存' });
    await dialog.getByLabel('プロジェクトの名前').fill(`coach-legacy-resave-${Date.now()}`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    const body = (await saved).postData() ?? '';
    expect(body).toContain('Lead');
    expect(body).not.toContain('automation');
});
