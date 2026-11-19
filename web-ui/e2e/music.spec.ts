import { expect, test } from '@playwright/test';
import { makeWav, openDaw, openTab, runJob, startFree, trackSummary } from './helpers';

const name = '練習用の長い曲名 [Original Soundtrack] '.repeat(3) + '.wav';

test('普段の画面から曲の一覧を開き、曲名を押して原曲へ取り込める', async ({ page }) => {
    await page.route('**/__music', route => route.fulfill({ json: [{ name }] }));
    await page.route('**/__music/file?*', route => route.fulfill({ contentType: 'audio/wav', body: makeWav(8, [261.63, 329.63, 392, 523.25]) }));
    await openDaw(page);
    await startFree(page, 1);
    await openTab(page, '曲とパート');
    const toggle = page.getByRole('button', { name: '曲の一覧', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const song = page.locator('#song-music-library').getByRole('button', { name, exact: true });
    await expect(song).toBeVisible();
    expect(await song.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const job = await runJob(page, '/api/chart', () => song.click());
    expect(job.state).toBe('done');
    expect(await trackSummary(page)).toEqual([{ name: '原曲', clips: [name] }, { name: 'Track 1', clips: [] }]);
    await openTab(page, '曲とパート');
    await expect(page.getByRole('button', { name: '曲の一覧', exact: true })).toBeVisible();
});

test('起動後に曲の一覧を開き、曲名をキーボードで選ぶと原曲に取り込む', async ({ page }) => {
    await page.route('**/__music', route => route.fulfill({ json: [{ name }] }));
    await page.route('**/__music/file?*', route => route.fulfill({ contentType: 'audio/wav', body: makeWav(8, [261.63, 329.63, 392, 523.25]) }));
    await openDaw(page);
    await page.getByRole('button', { name: '曲の一覧', exact: true }).click();
    const song = page.getByRole('list', { name: 'music の曲' }).getByRole('button', { name, exact: true });
    await expect(song).toBeVisible();
    expect(await song.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const job = runJob(page, '/api/chart', async () => { await song.focus(); await page.keyboard.press('Enter'); });
    expect((await job).state).toBe('done');
    expect(await trackSummary(page)).toEqual([{ name: '原曲', clips: [name] }]);
    await expect(page.locator('#empty-state')).toHaveCount(0);
});

test('曲が無いときの案内と一覧の更新、ファイルが消えたときの知らせ', async ({ page }) => {
    let entries: { name: string }[] = [];
    await page.route('**/__music', route => route.fulfill({ json: entries }));
    await page.route('**/__music/file?*', route => route.fulfill({ status: 404 }));
    await openDaw(page);
    await page.getByRole('button', { name: '曲の一覧', exact: true }).click();
    await expect(page.getByText('music フォルダに曲がありません。', { exact: false })).toBeVisible();
    entries = [{ name: '練習.wav' }];
    await page.getByRole('button', { name: '一覧を更新', exact: true }).click();
    await page.getByRole('list', { name: 'music の曲' }).getByRole('button', { name: '練習.wav', exact: true }).click();
    await expect(page.getByText('music フォルダを読めませんでした。ファイルを確認して、一覧を更新してください', { exact: true }).first()).toBeVisible();
    expect(await trackSummary(page)).toEqual([]);
});
