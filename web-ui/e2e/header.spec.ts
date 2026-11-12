/**
 * ヘッダの保存・読み込む・WAV 書き出し・再生 (ボタンと Space キー) と、画面の下端のステータスバー。
 */
import { expect, test, type Download, type Page } from '@playwright/test';
import { openDaw, startFree, openTab, readWav, statusText, trackSummary } from './helpers';

/** ダウンロードされたファイルの中身を読む。 */
async function downloadBytes(file: Download): Promise<Buffer> {
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
}

/** Track 1 を開いて、1 拍目と 3 拍目にノートを置く (曲の長さは 120 BPM で 1.5 秒)。 */
async function placeNotes(page: Page) {
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 200 } });
    await page.locator('#note-layer').dblclick({ position: { x: 170, y: 228 } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(2);
}

const timeDisplay = (page: Page) => page.locator('#time-display');

test('ステータスバーが画面の中に見えていて、画面全体が窓からはみ出していない', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    const layout = await page.evaluate(() => {
        const bar = document.querySelector('#status-bar')!.getBoundingClientRect();
        return { top: bar.top, bottom: bar.bottom, viewport: window.innerHeight, page: document.documentElement.scrollHeight };
    });
    expect(layout.bottom).toBeLessThanOrEqual(layout.viewport);
    expect(layout.top).toBeGreaterThan(layout.viewport - 60);
    expect(layout.page).toBeLessThanOrEqual(layout.viewport);
    // 操作の結果は、ここに出る
    await page.getByRole('button', { name: 'MIDI 書き出し', exact: true }).click();
    await expect(statusText(page)).toBeInViewport();
    await expect(statusText(page)).toContainText('書き出すノートがありません');
});

test('ボタンにマウスを載せると、ステータスバーの右に説明が出る', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.getByRole('button', { name: '保存', exact: true }).hover();
    await expect(page.locator('#hint-text')).toHaveText('プロジェクト（テンポ・トラック・ノート）を保存します');
    await expect(page.locator('#hint-text')).toBeInViewport();
});

test('保存して開き直し、読み込むと、テンポ・トラック・ノートが戻る', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.locator('#transport input[type="number"]').fill('96');
    await placeNotes(page);
    // 3 本目のトラックを足して、そこにもノートを置く
    await page.getByRole('button', { name: '+ トラック追加' }).click();
    await page.locator('#tracks-container .track-name').nth(2).click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 100 } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);

    const saved = page.waitForResponse((r) => r.url().endsWith('/api/project/save'));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(statusText(page)).toHaveText('プロジェクトを保存しました');

    await page.reload();
    await page.getByText('準備完了').waitFor();
    // 開き直したときはトラックが無く、空の状態の案内が出る
    await expect(page.locator('#tracks-container .track-row')).toHaveCount(0);
    await expect(page.locator('#empty-state')).toBeVisible();
    await page.getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toContainText('を読み込みました');

    await expect(page.locator('#transport input[type="number"]')).toHaveValue('96');
    // 保存したときの 3 本が戻り、それぞれのノートの数が見出しに出る
    await expect(page.locator('#tracks-container .track-row')).toHaveCount(3);
    expect((await trackSummary(page)).map((t) => t.name)).toEqual(['Track 1', 'Track 2', 'Track 3']);
    await expect(page.locator('#tracks-container .track-row').nth(0).locator('.notes-badge')).toHaveText('2');
    await expect(page.locator('#tracks-container .track-row').nth(1).locator('.notes-badge')).toHaveCount(0);
    await expect(page.locator('#tracks-container .track-row').nth(2).locator('.notes-badge')).toHaveText('1');
    // トラックを開くと、ノートがピアノロールに出る
    await page.locator('#tracks-container .track-name').first().click();
    const titles = await page.locator('#note-layer .note-block').evaluateAll((els) => els.map((el) => (el as HTMLElement).title));
    expect(titles.map((t) => t.match(/step:(\d+)/)![1])).toEqual(['0', '8']);
});

test('トラックをピアノロールで開いたまま読み込んでも、そのトラックのノートが読み込んだ内容になる', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await placeNotes(page);
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/project/save'));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    expect((await saved).status()).toBe(200);

    // 保存した後で、開いているトラックのノートを全部消す (保存した内容とは違う状態にする)
    for (let remaining = 2; remaining > 0; remaining--) {
        await page.locator('#note-layer .note-block').first().click();
        await page.keyboard.press('Delete');
        await expect(page.locator('#note-layer .note-block')).toHaveCount(remaining - 1);
    }
    await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveCount(0);

    // トラックを開いたまま読み込む。以前は、開いていたトラックだけ、画面に出ていた内容 (空) に戻った
    await page.getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toContainText('を読み込みました');
    await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveText('2');
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(2);
});

test.describe('WAV 書き出し', () => {
    test('何も無いときは、書き出さずに理由を出す', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        await expect(statusText(page)).toContainText('書き出すものがありません');
    });

    test('ノートだけでも、再生で鳴るとおりの WAV が落ちてくる', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        const file = await download;
        expect(file.suggestedFilename()).toBe('bunri_mix.wav');
        const wav = readWav(await downloadBytes(file));
        // 2 つ目のノートは 8〜12 ステップ目 → 曲の長さは 1.5 秒
        expect(wav.seconds).toBeCloseTo(1.5, 1);
        expect(wav.channels).toBe(2);
        expect(wav.peak).toBeGreaterThan(0.05);
        await expect(statusText(page)).toHaveText('WAV ファイルを書き出しました');
    });

    test('クリップの在るトラックをミックスした WAV が落ちてくる', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await openTab(page, 'ドラム');
        await page.locator('#drum-panel input[type="number"]').fill('1');
        await page.getByRole('button', { name: /ドラム生成/ }).click();
        await expect(page.locator('#tracks-container .clip')).toHaveCount(1);
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        const wav = readWav(await downloadBytes(await download));
        expect(wav.seconds).toBeGreaterThan(1.9);
        expect(wav.peak).toBeGreaterThan(0.05);
    });
});

test.describe('再生', () => {
    test('再生すると時間が進み、一時停止で止まり、もう一度押すと続きから進む', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        await expect(timeDisplay(page)).toHaveText('0:00.0');
        await page.locator('#btn-play').click();
        await expect(statusText(page)).toHaveText('再生中…');
        await expect(page.locator('#btn-play')).toHaveText('⏸');
        await expect(timeDisplay(page)).not.toHaveText('0:00.0');
        // 下のシークバーも、曲の長さ (1.5 秒) に対して進む
        await expect(page.locator('#seek-time-total')).toHaveText('0:01.5');
        await expect.poll(() => page.locator('#seek-bar').inputValue().then(Number)).toBeGreaterThan(0);

        await page.locator('#btn-play').click();
        await expect(statusText(page)).toHaveText('一時停止');
        await expect(page.locator('#btn-play')).toHaveText('▶');
        // 表示は 0.1 秒おきに更新されるので、止めた位置が表示に出るのを待ってから読む
        await page.waitForTimeout(300);
        const paused = await timeDisplay(page).innerText();
        expect(paused).not.toBe('0:00.0');
        await page.waitForTimeout(400);
        await expect(timeDisplay(page)).toHaveText(paused);

        await page.locator('#btn-play').click();
        await expect(timeDisplay(page)).not.toHaveText(paused);
    });

    test('停止すると先頭に戻る', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        await page.locator('#btn-play').click();
        await expect(timeDisplay(page)).not.toHaveText('0:00.0');
        await page.getByTitle('停止', { exact: true }).click();
        await expect(statusText(page)).toHaveText('停止');
        await expect(page.locator('#btn-play')).toHaveText('▶');
        await expect(timeDisplay(page)).toHaveText('0:00.0');
        await expect(page.locator('#seek-time-current')).toHaveText('0:00.0');
    });

    test('メトロノームを入れると、ボタンが点いた状態になる', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        const button = page.getByTitle('メトロノーム', { exact: true });
        await button.click();
        await expect(statusText(page)).toHaveText('メトロノーム ON');
        await expect(button).toHaveClass(/active/);
        await button.click();
        await expect(statusText(page)).toHaveText('メトロノーム OFF');
        await expect(button).not.toHaveClass(/active/);
    });
});

test.describe('Space キー', () => {
    test('Space で再生と一時停止が切り替わる', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        await page.keyboard.press('Space');
        await expect(statusText(page)).toHaveText('再生中…');
        await expect(page.locator('#btn-play')).toHaveText('⏸');
        await expect(timeDisplay(page)).not.toHaveText('0:00.0');
        await page.keyboard.press('Space');
        await expect(statusText(page)).toHaveText('一時停止');
        await expect(page.locator('#btn-play')).toHaveText('▶');
    });

    test('入力欄で文字を打っているときは、Space で再生が始まらない', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        await page.getByLabel('BPM', { exact: true }).click();
        await page.keyboard.press('Space');
        await page.getByLabel('拍子').focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('Escape');
        await expect(page.locator('#btn-play')).toHaveText('▶');
        await expect(timeDisplay(page)).toHaveText('0:00.0');
    });

    test('ボタンをマウスで押した直後に Space を押しても、二重に切り替わらない', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        // ▶ をマウスで押す → 再生。ボタンにフォーカスが残っていても、Space は 1 回ぶんだけ効く
        await page.locator('#btn-play').click();
        await expect(page.locator('#btn-play')).toHaveText('⏸');
        await page.keyboard.press('Space');
        await expect(statusText(page)).toHaveText('一時停止');
        await expect(page.locator('#btn-play')).toHaveText('▶');
        // 少し待っても、勝手に再生へ戻らない (キーを離したときに、ボタンがもう一度押されていない)
        await page.waitForTimeout(300);
        await expect(page.locator('#btn-play')).toHaveText('▶');

        // メトロノームをマウスで押した後の Space も、メトロノームではなく再生に効く
        const metronome = page.getByTitle('メトロノーム', { exact: true });
        await metronome.click();
        await expect(metronome).toHaveClass(/active/);
        await page.keyboard.press('Space');
        await expect(page.locator('#btn-play')).toHaveText('⏸');
        await expect(metronome).toHaveClass(/active/);
    });

    test('キーボードで選んだボタンの上では、Space はそのボタンを押す (再生は切り替わらない)', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        // Tab キーで操作している状態にしてから、メトロノームのボタンへ移る
        await page.keyboard.press('Tab');
        const metronome = page.getByTitle('メトロノーム', { exact: true });
        await metronome.focus();
        await page.keyboard.press('Space');
        await expect(metronome).toHaveClass(/active/);
        await expect(statusText(page)).toHaveText('メトロノーム ON');
        await expect(page.locator('#btn-play')).toHaveText('▶');
    });
});

test.describe('ステータスバーの知らせ', () => {
    test('失敗の知らせは色が変わり、読み上げの対象になる。次の知らせで元に戻る', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await expect(statusText(page)).toHaveAttribute('role', 'status');
        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        await expect(statusText(page)).toContainText('書き出すものがありません');
        await expect(statusText(page)).toHaveAttribute('role', 'alert');
        await expect(statusText(page)).toHaveClass(/error/);
        // --error の色 (#e87878)
        await expect(statusText(page)).toHaveCSS('color', 'rgb(232, 120, 120)');
        await expect(page.getByRole('alert')).toContainText('書き出すものがありません');

        await page.getByRole('button', { name: '+ トラック追加' }).click();
        await expect(statusText(page)).toHaveText('「Track 3」を追加しました');
        await expect(statusText(page)).toHaveAttribute('role', 'status');
        await expect(statusText(page)).not.toHaveClass(/error/);
    });

    test('長い知らせは 1 行に収まり、はみ出すぶんは … になる (全文は title で読める)', async ({ page }) => {
        await page.setViewportSize({ width: 700, height: 720 });
        await openDaw(page);
        const saved = page.waitForResponse((r) => r.url().endsWith('/api/project/save'));
        await page.getByRole('button', { name: '保存', exact: true }).click();
        expect((await saved).status()).toBe(200);
        await page.getByRole('button', { name: '読み込む', exact: true }).click();
        await expect(statusText(page)).toContainText('を読み込みました');
        // マウスを載せたままだと右側に説明が出るので、ボタンから外す
        await page.mouse.move(350, 400);
        const layout = await statusText(page).evaluate((el) => {
            const style = getComputedStyle(el);
            const bar = document.querySelector('#status-bar')!.getBoundingClientRect();
            const rect = el.getBoundingClientRect();
            return {
                cut: el.scrollWidth > el.clientWidth, overflow: style.textOverflow, wrap: style.whiteSpace,
                barHeight: bar.height, inside: rect.right <= bar.right && rect.left >= bar.left,
                title: el.getAttribute('title'), text: el.textContent,
            };
        });
        expect(layout.cut).toBe(true);
        expect(layout.overflow).toBe('ellipsis');
        expect(layout.wrap).toBe('nowrap');
        expect(layout.barHeight).toBe(28);
        expect(layout.inside).toBe(true);
        expect(layout.title).toBe(layout.text);
    });
});

test.describe('ソロと WAV 書き出し', () => {
    /** WAV を書き出して、いちばん大きい振幅を返す。 */
    async function exportPeak(page: Page): Promise<number> {
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        return readWav(await downloadBytes(await download)).peak;
    }

    test('ソロにしたトラックだけが書き出される (再生と同じ)', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        // 何もソロにしていなければ、Track 1 のノートが鳴る
        expect(await exportPeak(page)).toBeGreaterThan(0.05);

        // ノートの無い Track 2 をソロにする → Track 1 は鳴らないので、無音になる。
        // 以前は、書き出しだけがソロを無視して、Track 1 の音が入っていた
        await page.getByRole('button', { name: '「Track 2」をソロ' }).click();
        expect(await exportPeak(page)).toBeLessThan(0.001);

        // Track 1 もソロにすると、また鳴る
        await page.getByRole('button', { name: '「Track 1」をソロ' }).click();
        expect(await exportPeak(page)).toBeGreaterThan(0.05);
    });

    test('ミュートしたトラックしか無いときは、書き出さずに理由を出す', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await placeNotes(page);
        await page.getByRole('button', { name: '「Track 1」をミュート' }).click();
        await page.getByRole('button', { name: '「Track 2」をミュート' }).click();
        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        await expect(statusText(page)).toContainText('鳴らすトラックがありません');
        await expect(statusText(page)).toHaveAttribute('role', 'alert');
    });
});
