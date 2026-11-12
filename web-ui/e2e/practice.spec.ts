/**
 * 練習画面: 入る・戻る (状態を戻す)、構成・コード・小節の段とピアノロールの位置、比べると色が付く、
 * 区間ループ (再生位置が頭に戻る)、速度 (高さを変えずに伸ばした音声を使う)、聴く・お手本は元に戻す履歴に残らない。
 *
 * カルテとパート分離の応答は差し替える (e2e/practice-fixtures.ts)。1 小節 = 2 秒 = 16 ステップ。
 */
import { expect, test, type Page } from '@playwright/test';
import { openDaw, statusText } from './helpers';
import { BASS, fakePracticeBackend, openBassPractice } from './practice-fixtures';

const region = (page: Page) => page.getByRole('region', { name: '練習画面' });
const startBar = (page: Page) => page.getByLabel('区間の始まりの小節');
const endBar = (page: Page) => page.getByLabel('区間の終わりの小節');
const undoTitle = (page: Page) => page.locator('#btn-undo').getAttribute('title');

/** ピアノロールの 1 ステップの幅と、横のスクロール位置。 */
const pianoView = (page: Page) => page.locator('#piano-grid-wrap').evaluate((el) => ({
    left: el.getBoundingClientRect().left, scrollLeft: el.scrollLeft,
    stepWidth: (document.querySelector('#note-layer .note-ghost') as HTMLElement).getBoundingClientRect().width / 4 + 0.25,
}));
const xOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().left);

/** お手本の i 番目と同じ位置に、高さを rows 行ずらしてノートを置く (負なら高い音)。 */
async function placeAt(page: Page, ghostIndex: number, rows = 0, steps = 0) {
    const g = (await page.locator('#note-layer .note-ghost').nth(ghostIndex).boundingBox())!;
    const row = g.height + 1;
    await page.mouse.dblclick(g.x + 4 + steps * (g.width + 1) / 4, g.y + row / 2 + rows * row);
}

test.beforeEach(async ({ page }) => {
    await fakePracticeBackend(page);
    await openDaw(page);
    await openBassPractice(page);
});

test('練習画面に入るとタイムラインと左パネルが隠れ、Esc か「アレンジに戻る」で戻る。表示の大きさ・スクロール・区間は保たれる', async ({ page }) => {
    await expect(page.locator('#timeline-area')).toBeHidden();
    await expect(page.locator('#left-panel')).toBeHidden();
    await expect(page.locator('#learn-progress')).toBeHidden();
    await expect(region(page)).toContainText('練習: ベース');
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    // 最初の区間は、お手本の最初のノートが在る構成の区間 (Aメロ: 1〜2 小節)
    await expect(startBar(page)).toHaveValue('1');
    await expect(endBar(page)).toHaveValue('2');

    await page.keyboard.press('Escape');
    await expect(region(page)).toHaveCount(0);
    await expect(page.locator('#timeline-area')).toBeVisible();
    await expect(statusText(page)).toHaveText('アレンジに戻りました');

    // アレンジで表示を広げてスクロールしておく
    await page.getByRole('button', { name: '横に広げる' }).click();
    await page.locator('#piano-grid-wrap').evaluate((el) => { el.scrollLeft = 200; });
    const before = await pianoView(page);

    // 練習のトラックの見出しから、もう一度練習画面へ。中で表示を変え、区間も変える
    await page.getByRole('button', { name: '「ベースの練習」を練習画面で開く' }).click();
    await expect(region(page)).toBeVisible();
    await expect(startBar(page)).toHaveValue('1');
    await page.getByRole('button', { name: '横に広げる' }).click();
    await page.getByRole('button', { name: '区間を 1 小節後ろへ' }).click();
    await expect(startBar(page)).toHaveValue('2');

    await page.getByRole('button', { name: '← アレンジに戻る' }).click();
    await expect(page.locator('#timeline-area')).toBeVisible();
    await expect.poll(async () => (await pianoView(page)).scrollLeft).toBe(before.scrollLeft);
    expect(Math.abs((await pianoView(page)).stepWidth - before.stepWidth)).toBeLessThan(0.5);
    // 練習の区間は、タイムラインの小節番号の段にも描く (上の端の金色の帯)
    const band = await page.locator('#timeline-header-canvas').evaluate((c: HTMLCanvasElement) => {
        const row = c.getContext('2d')!.getImageData(0, 1, c.width, 1).data;
        let count = 0;
        for (let x = 0; x < c.width; x++) if (row[x * 4] > 180 && row[x * 4 + 1] > 130) count++;
        return count;
    });
    expect(band).toBeGreaterThan(100);

    // もう一度入ると、区間はそのまま
    await page.getByRole('button', { name: '「ベースの練習」のメニュー' }).click();
    await page.getByRole('menuitem', { name: '練習画面で開く' }).click();
    await expect(startBar(page)).toHaveValue('2');
    await expect(endBar(page)).toHaveValue('3');
});

test('構成・コード・小節の段は、ピアノロールと同じ横の位置に並び、一緒にスクロールする', async ({ page }) => {
    // 段の位置は、ピアノロールのスクロールの知らせ (次の描画のとき) で動くので、そろうまで待つ
    const offsets = async () => {
        const view = await pianoView(page);
        const barX = view.left + 16 * view.stepWidth - view.scrollLeft;
        // 1.5px 以内なら、そろっている (枠線と小数の丸めのぶん)
        return [
            Math.abs(await xOf(page, '.band-bar[data-bar="2"]') - barX),
            Math.abs(await xOf(page, '.band-chord[data-bar="2"]') - barX),
            Math.abs(await xOf(page, '.band-section') - view.left + view.scrollLeft),
        ].map((d) => (d <= 1.5 ? 'そろっている' : `${Math.round(d)}px ずれている`));
    };
    const check = () => expect.poll(offsets).toEqual(['そろっている', 'そろっている', 'そろっている']);
    await expect(page.locator('.band-chord[data-bar="2"]')).toHaveText('Am');
    await check();
    await page.getByRole('button', { name: '横に縮める' }).click();
    await check();
    await page.locator('#piano-grid-wrap').evaluate((el) => { el.scrollLeft = 150; });
    await expect.poll(async () => (await pianoView(page)).scrollLeft).toBe(150);
    await check();
});

test('比べると、ノートに色と名前が付き、指摘の一覧とノートがつながる。ノートを変えると「もう一度比べて」になる', async ({ page }) => {
    await placeAt(page, 0);            // C2 (合っている)
    // ほかのノートの下に隠れないよう、横に広げておく
    await page.getByRole('button', { name: '横に広げる' }).click();
    await placeAt(page, 1, -1);        // F2 (お手本は E2: 高さの違い)
    await placeAt(page, 2);            // G2 (後で長さを変える)
    await expect(page.locator('#note-layer .note-block')).toHaveCount(3);
    // G2 の右端をドラッグして、長さを 2 倍にする (長さの違い)
    const g2 = (await page.locator('#note-layer .note-block').nth(2).boundingBox())!;
    await page.mouse.move(g2.x + g2.width - 3, g2.y + g2.height / 2);
    await page.mouse.down();
    await page.mouse.move(g2.x + g2.width * 2, g2.y + g2.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.getByRole('button', { name: '比べる', exact: true }).click();

    // 一致: 区間 (1〜2 小節) のお手本 8 ノートのうち、高さと位置が合ったのは C2 と G2 の 2 つ
    await expect(page.getByTestId('match-rate')).toHaveText('25%');
    const notes = page.locator('#note-layer');
    await expect(notes.getByRole('img', { name: /^C2: 合っている$/ })).toHaveClass(/diff-ok/);
    await expect(notes.getByRole('img', { name: /^F2: 高さが違う。1 小節 2 拍目: F2 → お手本は E2/ })).toHaveClass(/diff-pitch/);
    const late = notes.getByRole('img', { name: /^G2: 位置か長さがずれている/ });
    await expect(late).toHaveClass(/diff-rhythm/);
    await expect(notes.getByRole('img', { name: /^お手本 C3: お手本の抜け/ })).toHaveClass(/ghost-missing/);
    // 凡例 (色だけに頼らない)
    await expect(page.getByRole('list', { name: '色の見方' })).toContainText('斜線');

    // 指摘を押すと、そのノートを選んで光らせる
    const side = page.getByRole('complementary', { name: 'この区間の指摘' });
    await side.getByRole('button', { name: /F2 → お手本は E2/ }).click();
    const f2 = notes.locator('.note-block.diff-pitch');
    await expect(f2).toHaveClass(/selected/);
    await expect(f2).toHaveClass(/flash/);
    await expect(notes.locator('.note-ghost.flash')).toHaveCount(1);
    // 色の付いたノートを押すと、その指摘を出す
    await late.click();
    await expect(side.getByRole('status').filter({ hasText: '選んだノート' })).toContainText('G2 が1 拍ぶん長い');
    await expect(side.getByRole('button', { name: /G2 が1 拍ぶん長い/ })).toHaveAttribute('aria-current', 'true');

    // ノートを変えると色が消え、もう一度比べるよう知らせる
    await page.keyboard.press('Delete');
    await expect(notes.getByRole('img')).toHaveCount(0);
    await expect(side).toContainText('ノートを変えたので、もう一度比べてください');
    await side.getByRole('button', { name: 'もう一度比べる' }).click();
    await expect(page.getByTestId('match-rate')).toHaveText('13%');
    await expect(notes.getByRole('img', { name: /^C2: 合っている$/ })).toBeVisible();
});

test('区間ループ: 小節の段のドラッグ・キーで区間を決め、再生すると区間の終わりで頭に戻る', async ({ page }) => {
    // 小節の段の 2 小節目の中をドラッグ → 2〜2 小節
    const bar2 = (await page.locator('.band-bar[data-bar="2"]').boundingBox())!;
    await page.mouse.move(bar2.x + 40, bar2.y + 8);
    await page.mouse.down();
    await page.mouse.move(bar2.x + 200, bar2.y + 8, { steps: 4 });
    await page.mouse.up();
    await expect(startBar(page)).toHaveValue('2');
    await expect(endBar(page)).toHaveValue('2');
    // ] / [ で 1 小節ずつ動かす。L で入れたり止めたり
    await page.keyboard.press(']');
    await expect(startBar(page)).toHaveValue('3');
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    await expect(startBar(page)).toHaveValue('1');
    await expect(endBar(page)).toHaveValue('1');
    const loopBox = page.getByRole('checkbox', { name: '区間ループ' });
    await page.keyboard.press('l');
    await expect(loopBox).not.toBeChecked();
    await page.keyboard.press('l');
    await expect(loopBox).toBeChecked();

    // 1 小節目 (0.75〜2.75 秒) を繰り返す。再生位置が頭に戻ることを、時刻の表示で確かめる
    await page.locator('#practice-controls').getByRole('button', { name: '再生', exact: true }).click();
    const seen: number[] = [];
    for (let i = 0; i < 32; i++) {
        const text = await page.locator('#time-display').textContent();
        const m = /(\d+):(\d+\.\d)/.exec(text ?? '');
        if (m) seen.push(Number(m[1]) * 60 + Number(m[2]));
        await page.waitForTimeout(100);
    }
    await page.locator('#practice-controls').getByRole('button', { name: '停止', exact: true }).click();
    expect(Math.max(...seen)).toBeLessThan(2.85);
    expect(seen.some((t, i) => i > 0 && t < seen[i - 1] - 1)).toBe(true);
    // ピアノロールの再生位置の線も区間の中 (ステップ 0〜16)
    const x = await page.locator('#piano-playhead').evaluate((el) => Number(/translateX\((-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform)?.[1]));
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(16 * 20);
    // 構成の区間を押すと、その区間になる
    await page.getByRole('button', { name: '「Aメロ？」（1〜2 小節）を区間にする' }).click();
    await expect(endBar(page)).toHaveValue('2');
});

test('速度を変えると、音の高さを変えずに伸ばした区間の音声を使う。聴く・お手本・速度は元に戻す履歴に残らず、戻ると元に戻る', async ({ page }) => {
    const undoBefore = await undoTitle(page);
    await page.getByRole('radio', { name: 'パート' }).check();
    const speed = page.getByLabel('速度');
    await speed.selectOption('0.75');
    const status = page.locator('.practice-speed-status');
    await expect(status).toHaveText('75%（音の高さはそのまま）');
    // 区間 1〜2 小節 = 4 秒。75% なら 5.333 秒の音声
    await expect(speed).toHaveAttribute('data-stretched-sec', '5.333');
    // 区間ループを止めると、速度は効かない (100% で鳴らす)
    await page.getByRole('checkbox', { name: '区間ループ' }).uncheck();
    await expect(status).toContainText('速度は区間ループの中で効きます');
    await page.getByRole('checkbox', { name: '区間ループ' }).check();
    await expect(speed).toHaveAttribute('data-stretched-sec', '5.333');

    await page.getByRole('radio', { name: '自分' }).check();
    await page.getByRole('radio', { name: '隠す' }).check();
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(0);
    await page.getByRole('radio', { name: '見せる' }).check();
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    expect(await undoTitle(page)).toBe(undoBefore);

    await page.getByRole('radio', { name: '隠す' }).check();
    await page.getByRole('button', { name: '← アレンジに戻る' }).click();
    // ミュートとソロはプロジェクトのまま (練習する で鳴らしたベースと、原曲)。お手本の重ね方も戻る
    await expect(page.getByRole('button', { name: '「ベース」をミュート' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: '「原曲」をミュート' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: '「ボーカル」をミュート' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '「ベース」をソロ' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#ghost-source')).toHaveValue('auto');
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    expect(await undoTitle(page)).toBe(undoBefore);
});
