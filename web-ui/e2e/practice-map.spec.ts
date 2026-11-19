/**
 * 練習の地図 (学ぶ → 差分 の段のいちばん上): 比べると、パートと構成の区間の升に一致率が出る。まだ比べていない区間は空の升。
 * 升を押すと、そのパートの練習画面が、その区間の区間ループで開く。キーボードで升を辿って押せる。
 * 練習画面の「構成」の段にも、いま練習しているパートの一致率が出て、比べた直後に変わる。保存して開き直しても残る。
 *
 * カルテとパート分離の応答は差し替える (e2e/practice-fixtures.ts)。構成は「Aメロ？」1〜2 小節、「サビ？」3〜4 小節。
 * ここでは、ベースのお手本を 3〜4 小節にも置く (1〜2 小節に 8 ノート、3 小節と 4 小節に 2 ノートずつ)。
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeJob, openDaw, openProject, openTab, saveProject, statusText } from './helpers';
import { BASS, DOWNBEAT, BAR_SEC, fakeChart, fakePracticeBackend, openBassPractice } from './practice-fixtures';

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length, velocity: 90 });
/** ベースのお手本: 1〜2 小節 (8 ノート) と、3 小節・4 小節 (2 ノートずつ)。 */
const BASS_LONG = [...BASS, note('C', 2, 32), note('E', 2, 40), note('G', 2, 48), note('C', 3, 56)];

/** パート分離の応答 (ボーカルは 1 小節に 1 ノートだけ。ベースは 1〜4 小節)。 */
function decompose() {
    const stem = (extra: object) => ({ gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [], drum_events: [], ...extra });
    return {
        bpm: 120, grid_offset_sec: DOWNBEAT,
        stems: {
            vocals: stem({ audio_url: '/api/download/decompose_vocals_song.mp3', notes: [note('E', 4, 0, 8)] }),
            bass: stem({ audio_url: '/api/download/decompose_bass_song.mp3', notes: BASS_LONG }),
        },
    };
}

const region = (page: Page) => page.getByRole('region', { name: '練習画面' });
const map = (page: Page) => page.locator('#practice-map');
const cell = (page: Page, name: string | RegExp) => map(page).getByRole('button', { name });
const badges = (page: Page) => page.getByTestId('band-progress');
const mark = (page: Page) => page.locator('#project-title .unsaved-mark');

/** お手本の i 番目と同じ位置に、ノートを置く。 */
async function placeAt(page: Page, ghostIndex: number) {
    const ghost = page.locator('#note-layer .note-ghost').nth(ghostIndex);
    await ghost.scrollIntoViewIfNeeded();
    const g = (await ghost.boundingBox())!;
    await page.mouse.dblclick(g.x + 4, g.y + (g.height + 1) / 2);
}

async function compare(page: Page, percent: string) {
    await page.getByRole('button', { name: '比べる', exact: true }).click();
    await expect(page.getByTestId('match-rate')).toHaveText(percent);
}

test.beforeEach(async ({ page }) => {
    await fakePracticeBackend(page);
    // 後から仕掛けたほうが先に当たる (ベースのお手本を 3〜4 小節にも置いた応答に差し替える)
    await fakeJob(page, '/api/decompose', decompose);
});

test('比べると升に一致率が出て、別の区間は空のまま。升を押すと、その区間で練習画面が開く。「構成」の段にも出る', async ({ page }) => {
    await openDaw(page);
    await openBassPractice(page);
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS_LONG.length);

    // 練習画面の「構成」の段: まだ比べていないので、どちらの区間も空の枠
    await expect(badges(page)).toHaveCount(2);
    await expect(badges(page).nth(0)).toHaveAttribute('data-state', 'untouched');
    await expect(badges(page).nth(0)).toHaveText('');
    const verse = page.getByRole('button', { name: '「Aメロ？」（1〜2 小節）を区間にする' });
    await expect(verse).toHaveAccessibleDescription('まだ比べていません');

    // 1〜2 小節 (Aメロ？) の 8 ノートのうち、1 つだけ置いて比べる: 一致 13%
    await placeAt(page, 0);
    await compare(page, '13%');
    // 比べた直後に、「構成」の段の Aメロ？ に同じ一致率が出る。サビ？ は空のまま
    await expect(badges(page).nth(0)).toHaveText('13%');
    await expect(badges(page).nth(0)).toHaveAttribute('data-level', 'low');
    await expect(verse).toHaveAccessibleDescription('一致 13%');
    await expect(badges(page).nth(1)).toHaveAttribute('data-state', 'untouched');
    // 区間を押す操作は、そのまま (名前も変えていない)
    await page.getByRole('button', { name: '「サビ？」（3〜4 小節）を区間にする' }).click();
    await expect(page.getByLabel('区間の始まりの小節')).toHaveValue('3');
    await page.getByRole('button', { name: '「Aメロ？」（1〜2 小節）を区間にする' }).click();
    await expect(page.getByLabel('区間の始まりの小節')).toHaveValue('1');

    // アレンジに戻って、差分の段の地図を見る (進み具合の ⑤ 差分で直す から辿れる)
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /⑤ 差分で直す/ }).click();
    await expect(map(page).getByRole('heading', { name: '練習の地図' })).toBeVisible();
    const grid = map(page).getByRole('grid', { name: '練習の地図' });
    await expect(grid.getByRole('columnheader')).toHaveText(['パート', 'Aメロ？1–2', 'サビ？3–4']);
    await expect(grid.getByRole('rowheader')).toHaveText(['ボーカル', 'ベース']);

    const bassVerse = cell(page, 'ベース・Aメロ？（1〜2 小節）: 一致 13%');
    await expect(bassVerse).toHaveText('13%');
    await expect(bassVerse).toHaveAttribute('data-level', 'low');
    // 学習の記録の値 (同じ区間の記録) と食い違わない
    await expect(page.locator('#learn-history')).toContainText('1〜2 小節 13%');
    // まだ比べていない区間は、空の升。練習のトラックが無いパートも空。お手本のノートが無い区間は「–」で、押せない
    const bassChorus = cell(page, 'ベース・サビ？（3〜4 小節）: まだ比べていません');
    await expect(bassChorus).toHaveText('');
    await expect(bassChorus).toHaveAttribute('data-state', 'untouched');
    await expect(cell(page, 'ボーカル・Aメロ？（1〜2 小節）: まだ比べていません')).toBeVisible();
    const empty = cell(page, 'ボーカル・サビ？（3〜4 小節）: お手本のノートがありません');
    await expect(empty).toHaveText('–');
    await expect(empty).toHaveAttribute('aria-disabled', 'true');
    // 押しても練習画面は開かず、理由が出る (Playwright は aria-disabled の要素を「押せない」として待つので、待たずに押す)
    await empty.click({ force: true });
    await expect(statusText(page)).toContainText('「ボーカル」の「サビ？」（3〜4 小節）には、お手本のノートがありません');
    await expect(region(page)).toHaveCount(0);

    // ツールチップに、状態と、押すと何が起きるかが出る
    await bassChorus.hover();
    await expect(page.getByRole('tooltip')).toContainText('ベース・サビ？（3〜4 小節）: まだ比べていません');
    await expect(page.getByRole('tooltip')).toContainText('押すと、この区間をくり返し練習できる練習画面を開きます');

    // キーボード: 表の中で Tab の順に入る升は 1 つだけ。矢印キーで辿り、Enter で押す
    await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
    await bassVerse.focus();
    await page.keyboard.press('ArrowRight');
    await expect(bassChorus).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(empty).toBeFocused();
    await page.keyboard.press('Home');
    await expect(cell(page, /^ボーカル・Aメロ？/)).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await expect(bassChorus).toBeFocused();
    await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('Enter');

    // 練習画面が、サビ？ (3〜4 小節) の区間ループで開く
    await expect(region(page)).toBeVisible();
    await expect(region(page)).toContainText('練習: ベース');
    await expect(page.getByLabel('区間の始まりの小節')).toHaveValue('3');
    await expect(page.getByLabel('区間の終わりの小節')).toHaveValue('4');
    await expect(page.getByRole('checkbox', { name: '区間ループ' })).toBeChecked();
    await expect(statusText(page)).toContainText('「ベース」の「サビ？」（3〜4 小節）を練習します');
    // その区間のお手本が見えている
    await expect(page.locator('#note-layer .note-ghost').nth(8)).toBeInViewport();

    // 区間の一部 (3 小節だけ) を比べる: 3 小節の 2 ノートのうち 1 つ → 50%。区間は「途中」
    await page.getByLabel('区間の終わりの小節').fill('3');
    await page.getByLabel('区間の終わりの小節').press('Enter');
    await placeAt(page, 8);
    await compare(page, '50%');
    await expect(badges(page).nth(1)).toHaveAttribute('data-state', 'partial');
    await expect(badges(page).nth(1)).toHaveText('50%途中');
    await expect(badges(page).nth(0)).toHaveText('13%');

    await page.keyboard.press('Escape');
    const partial = cell(page, 'ベース・サビ？（3〜4 小節）: 一致 50%（お手本のノートが在る 2 小節のうち、1 小節を比べました）');
    await expect(partial).toHaveAttribute('data-state', 'partial');
    await expect(partial).toHaveText('50%途中');
    await expect(bassVerse).toHaveText('13%');
});

test('地図の一致率は、保存して開き直しても残る。升を辿るだけでは、保存していない変更にならない', async ({ page }, testInfo) => {
    await openDaw(page);
    await openBassPractice(page);
    await placeAt(page, 0);
    await placeAt(page, 4);
    await compare(page, '25%');
    await page.keyboard.press('Escape');
    const name = await saveProject(page, `練習の地図-${testInfo.project.name}-${Date.now()}`);
    await expect(mark(page)).toHaveCount(0);

    await page.reload();
    await page.getByText('準備完了').waitFor();
    await openProject(page, name);
    await openTab(page, '差分');
    const bassVerse = cell(page, 'ベース・Aメロ？（1〜2 小節）: 一致 25%');
    await expect(bassVerse).toHaveText('25%');
    await expect(cell(page, 'ベース・サビ？（3〜4 小節）: まだ比べていません')).toHaveText('');
    // 小節ごとの結果が残っているので、以前の記録の扱い (内訳が無い) にはならない
    await expect(bassVerse).not.toHaveAttribute('data-estimated', '');

    // 升を辿る (見た目だけの状態) では、保存していない変更の印は付かない
    await bassVerse.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await expect(mark(page)).toHaveCount(0);

    // 開き直したあとも、練習画面の「構成」の段に出る
    await page.getByRole('button', { name: '「ベースの練習」を練習画面で開く' }).click();
    await expect(region(page)).toBeVisible();
    await expect(badges(page).nth(0)).toHaveText('25%');
    await expect(badges(page).nth(1)).toHaveAttribute('data-state', 'untouched');
});

test('区間が 12 個在っても、左パネルの中で崩れない (表だけが横にスクロールし、パートの名前は残る)', async ({ page }) => {
    // 1 小節ごとに 12 個の区間
    await fakeJob(page, '/api/chart', () => {
        const chart = fakeChart();
        const first = chart.chart.sections[0];
        chart.chart.sections = Array.from({ length: 12 }, (_, i) => ({
            ...first, id: `S${i + 1}`, suggested_label: i % 2 ? 'chorus' : 'verse', start_bar: i + 1, end_bar: i + 1,
            start_sec: DOWNBEAT + i * BAR_SEC, end_sec: DOWNBEAT + (i + 1) * BAR_SEC,
        }));
        return chart;
    });
    await openDaw(page);
    await openBassPractice(page);
    await page.keyboard.press('Escape');
    await openTab(page, '差分');

    const grid = map(page).getByRole('grid', { name: '練習の地図' });
    await expect(grid.getByRole('columnheader')).toHaveCount(13);
    for (const width of [280, 520]) {
        // 左パネルの幅を、いちばん狭く・いちばん広くする (境目のつまみを、矢印キーと Home / End で動かす)
        const handle = page.locator('#resize-left');
        await handle.focus();
        await page.keyboard.press(width === 280 ? 'Home' : 'End');
        await expect.poll(() => page.locator('#left-panel').evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(width);

        const box = await page.evaluate(() => {
            const panel = document.querySelector('#left-panel')!.getBoundingClientRect();
            const section = document.querySelector('#practice-map')!;
            const scroll = section.querySelector('.practice-map-scroll')!;
            const sub = section.closest('.sub-panel')!;
            return {
                panelRight: panel.right, mapRight: section.getBoundingClientRect().right,
                // 段そのものは、横にはみ出さない (横スクロールは表の枠だけ)
                subOverflow: sub.scrollWidth - sub.clientWidth,
                scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
            };
        });
        expect(box.mapRight).toBeLessThanOrEqual(box.panelRight);
        expect(box.subOverflow).toBeLessThanOrEqual(0);
        expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);

        // 最後の升へキーボードで移ると、見える位置までスクロールする。パートの名前の列は、左に残ったまま
        await cell(page, /^ベース・Aメロ？（1 小節）/).focus();
        await page.keyboard.press('End');
        const last = cell(page, /^ベース・サビ？（12 小節）/);
        await expect(last).toBeFocused();
        const seen = await page.evaluate(() => {
            const scroll = document.querySelector('#practice-map .practice-map-scroll')!.getBoundingClientRect();
            const focused = document.activeElement!.getBoundingClientRect();
            const rows = [...document.querySelectorAll('#practice-map .pm-row')].map((el) => el.getBoundingClientRect());
            return {
                inside: focused.left >= scroll.left - 1 && focused.right <= scroll.right + 1,
                rowLeft: rows.map((r) => Math.round(r.left - scroll.left)),
                rowRight: Math.max(...rows.map((r) => r.right)), focusedLeft: focused.left,
            };
        });
        expect(seen.inside).toBe(true);
        expect(seen.rowLeft).toEqual([0, 0]);
        // 升は、名前の列の下に隠れていない
        expect(seen.focusedLeft).toBeGreaterThanOrEqual(seen.rowRight - 1);
        await page.keyboard.press('Home');
    }
});
