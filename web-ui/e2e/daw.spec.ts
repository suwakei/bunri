/**
 * DAW の画面 (/) の基本操作。
 */
import { expect, test } from '@playwright/test';
import { openDaw, openTab, startFree } from './helpers';

test('初めて開くと案内が出て、閉じると次からは出ない', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#guide-overlay')).toBeVisible();
    await page.getByRole('button', { name: 'はじめる' }).click();
    await expect(page.locator('#guide-overlay')).toHaveCount(0);
    await page.reload();
    await page.getByText('準備完了').waitFor();
    await expect(page.locator('#guide-overlay')).toHaveCount(0);
});

test('初回の案内は、画面を覆う窓として組んであり、Esc キーで閉じられる', async ({ page }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'bunri DAW へようこそ' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // 開いたとき、フォーカスは窓の中 (「はじめる」) に入る
    await expect(page.getByRole('button', { name: 'はじめる' })).toBeFocused();
    // Tab を押しても、フォーカスは窓の外 (下に隠れている画面) へ出ない
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'はじめる' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await page.getByText('準備完了').waitFor();
    await expect(page.locator('#guide-overlay')).toHaveCount(0);
});

test('使い方の画面から、初回の案内をもう一度出せる', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('bunri-guide-seen', '1'));
    await page.goto('/help');
    await page.getByRole('link', { name: 'はじめの案内をもう一度見る' }).click();
    await expect(page.getByRole('dialog', { name: 'bunri DAW へようこそ' })).toBeVisible();
});

test('外した機能 (AI のタブ、オートメーションの欄、重複していた案内のボタン) が画面に無い', async ({ page }) => {
    await openDaw(page);
    // 左パネルのタブは 3 つ。AI のタブ (ノートを生成する機能) は無い
    await expect(page.locator('#panel-tabs').getByRole('tab')).toHaveText(['学ぶ', '音作り', 'ファイル']);
    await expect(page.locator('#assistant-panel')).toHaveCount(0);
    // オートメーションの欄と、その上の境目は無い。境目は、タイムラインとピアノロールのあいだの 1 本だけ
    await expect(page.locator('#automation-area')).toHaveCount(0);
    await expect(page.locator('#resize-auto')).toHaveCount(0);
    // (縦の境目は、左パネルの幅を変える 1 本)
    await expect(page.locator('.resize-handle:not(.vertical)')).toHaveCount(1);
    await expect(page.locator('#center')).not.toContainText('オートメーション');
    // 案内の入口は「使い方」の 1 つだけ
    await expect(page.locator('#header').getByText('❓')).toHaveCount(0);
    await expect(page.locator('#header').getByRole('link', { name: '使い方' })).toHaveCount(1);
    // ピアノロールは、中央の下端まで使う
    const center = (await page.locator('#center').boundingBox())!;
    const piano = (await page.locator('#piano-roll-area').boundingBox())!;
    expect(Math.round(piano.y + piano.height)).toBe(Math.round(center.y + center.height));
});

test('起動したときは、空のトラックを作らず、曲を取り込むところから始める案内が出る。API とつながっている', async ({ page }) => {
    const gm = page.waitForResponse((r) => r.url().endsWith('/api/gm-instruments') && r.ok());
    await openDaw(page);
    await gm;
    await expect(page.locator('#tracks-container .track-name')).toHaveCount(0);
    const empty = page.getByRole('region', { name: 'はじめに' });
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('button', { name: '曲を取り込んで始める' })).toBeVisible();
    await expect(empty.getByRole('button', { name: '自由に作る' })).toBeVisible();
    // 「+ トラック追加」は、案内の「自由に作る」と同じなので出さない
    await expect(page.getByRole('button', { name: '+ トラック追加' })).toBeHidden();
    // 左パネルは「学ぶ」の「曲とパート」
    await expect(page.getByRole('tab', { name: '学ぶ', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '曲とパート' })).toHaveAttribute('aria-selected', 'true');
    for (const label of ['保存', '開く', 'WAV 書き出し', 'MIDI 書き出し']) {
        await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
});

test('「曲を取り込んで始める」は、原曲のファイルの選択を開く', async ({ page }) => {
    await openDaw(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '曲を取り込んで始める' }).click();
    const picked = await chooser;
    expect(picked.isMultiple()).toBe(false);
    expect(await picked.element().getAttribute('accept')).toContain('.mp3');
});

test('「自由に作る」で空のトラックが 1 本でき、ピアノロールで開く', async ({ page }) => {
    await openDaw(page);
    await page.getByRole('button', { name: '自由に作る' }).click();
    await expect(page.locator('#tracks-container .track-name')).toHaveText(['Track 1']);
    await expect(page.locator('#empty-state')).toHaveCount(0);
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');
    // 音を作るタブが開く
    await expect(page.getByRole('tab', { name: '音作り' })).toHaveAttribute('aria-selected', 'true');
});

test('トラックを選んでピアノロールをダブルクリックすると、ノートが入る', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);
    await page.locator('#note-layer').dblclick({ position: { x: 90, y: 200 } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
    // トラックの見出しにも、ノートの数が出る
    await expect(page.locator('#tracks-container .track-name').first()).toContainText('1');
});

test('トラックを追加できる', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.getByRole('button', { name: '+ トラック追加' }).click();
    await expect(page.locator('#tracks-container .track-name')).toHaveCount(3);
});

test('ノートを置いて MIDI を書き出すと、標準 MIDI ファイルが落ちてくる', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 200 } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'MIDI 書き出し', exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('bunri.mid');
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).subarray(0, 4).toString('latin1')).toBe('MThd');
});

test('ノートが無いときに MIDI を押すと、書き出さずに理由を出す', async ({ page }) => {
    await openDaw(page);
    await page.getByRole('button', { name: 'MIDI 書き出し', exact: true }).click();
    await expect(page.getByText('書き出すノートがありません')).toBeVisible();
});

test('カルテ・ガイド・差分の段は、取り込む前なら案内を出す', async ({ page }) => {
    await openDaw(page);
    await openTab(page, 'カルテ');
    await expect(page.getByText('まだ解析していません')).toBeVisible();
    await openTab(page, 'ガイド');
    await expect(page.locator('#guide-panel')).toContainText('先に曲を取り込んでください');
    await openTab(page, '差分');
    await expect(page.getByText('お手本になるトラックがまだありません')).toBeVisible();
});
