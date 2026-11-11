/**
 * ヘッダの保存・読込・書出・再生と、画面の下端のステータスバー。
 */
import { expect, test, type Download, type Page } from '@playwright/test';
import { openDaw, openTab, readWav, statusText, trackSummary } from './helpers';

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
    const layout = await page.evaluate(() => {
        const bar = document.querySelector('#status-bar')!.getBoundingClientRect();
        return { top: bar.top, bottom: bar.bottom, viewport: window.innerHeight, page: document.documentElement.scrollHeight };
    });
    expect(layout.bottom).toBeLessThanOrEqual(layout.viewport);
    expect(layout.top).toBeGreaterThan(layout.viewport - 60);
    expect(layout.page).toBeLessThanOrEqual(layout.viewport);
    // 操作の結果は、ここに出る
    await page.getByRole('button', { name: 'MIDI', exact: true }).click();
    await expect(statusText(page)).toBeInViewport();
    await expect(statusText(page)).toContainText('書き出すノートがありません');
});

test('ボタンにマウスを載せると、ステータスバーの右に説明が出る', async ({ page }) => {
    await openDaw(page);
    await page.getByRole('button', { name: '保存', exact: true }).hover();
    await expect(page.locator('#hint-text')).toHaveText('プロジェクト保存');
    await expect(page.locator('#hint-text')).toBeInViewport();
});

test('保存して開き直し、読み込むと、テンポ・トラック・ノートが戻る', async ({ page }) => {
    await openDaw(page);
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
    await expect(page.locator('#tracks-container .track-row')).toHaveCount(2);
    await page.getByRole('button', { name: '読込', exact: true }).click();
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
    await page.getByRole('button', { name: '読込', exact: true }).click();
    await expect(statusText(page)).toContainText('を読み込みました');
    await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveText('2');
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(2);
});

test.describe('書出', () => {
    test('何も無いときは、書き出さずに理由を出す', async ({ page }) => {
        await openDaw(page);
        await page.getByRole('button', { name: '書出', exact: true }).click();
        await expect(statusText(page)).toContainText('書き出すものがありません');
    });

    test('ノートだけでも、再生で鳴るとおりの WAV が落ちてくる', async ({ page }) => {
        await openDaw(page);
        await placeNotes(page);
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: '書出', exact: true }).click();
        const file = await download;
        expect(file.suggestedFilename()).toBe('bunri_mix.wav');
        const wav = readWav(await downloadBytes(file));
        // 2 つ目のノートは 8〜12 ステップ目 → 曲の長さは 1.5 秒
        expect(wav.seconds).toBeCloseTo(1.5, 1);
        expect(wav.channels).toBe(2);
        expect(wav.peak).toBeGreaterThan(0.05);
        await expect(statusText(page)).toHaveText('WAVファイルを書き出しました');
    });

    test('クリップの在るトラックをミックスした WAV が落ちてくる', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'ドラム');
        await page.locator('#drum-panel input[type="number"]').fill('1');
        await page.getByRole('button', { name: /ドラム生成/ }).click();
        await expect(page.locator('#tracks-container .clip')).toHaveCount(1);
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: '書出', exact: true }).click();
        const wav = readWav(await downloadBytes(await download));
        expect(wav.seconds).toBeGreaterThan(1.9);
        expect(wav.peak).toBeGreaterThan(0.05);
    });
});

test.describe('再生', () => {
    test('再生すると時間が進み、一時停止で止まり、もう一度押すと続きから進む', async ({ page }) => {
        await openDaw(page);
        await placeNotes(page);
        await expect(timeDisplay(page)).toHaveText('0:00.0');
        await page.locator('#btn-play').click();
        await expect(statusText(page)).toHaveText('再生中...');
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
        const button = page.getByTitle('メトロノーム', { exact: true });
        await button.click();
        await expect(statusText(page)).toHaveText('メトロノーム ON');
        await expect(button).toHaveClass(/active/);
        await button.click();
        await expect(statusText(page)).toHaveText('メトロノーム OFF');
        await expect(button).not.toHaveClass(/active/);
    });
});
