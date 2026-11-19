/** 開発用ブラウザでは、ピアノ音源を使わないことを音色の欄で伝える。 */
import { expect, test } from '@playwright/test';
import { openDaw, startFree, openProject, saveProject, openTab, statusText } from './helpers';

const catalog = [
    { id: 'salamander', name: 'グランドピアノ', category: 'ピアノ', kind: 'sampler', packId: 'piano', installed: false, downloadBytes: 748522601, author: 'Alexander Holm', license: 'CC-BY-3.0', sourceUrl: 'https://example.com/piano' },
    { id: 'choir-a', name: 'コーラス あー', category: '声', kind: 'sampler', packId: 'choir', installed: false, downloadBytes: 10000000, author: 'Singer', license: 'CC0', sourceUrl: 'https://example.com/choir' },
    { id: 'game-pad', name: 'ゲーム風パッド', category: 'スーパーファミコン風', kind: 'sampler', packId: 'game', installed: false, downloadBytes: 0, author: 'bunri', license: 'CC0', sourceUrl: 'bunri' },
];

test.beforeEach(async ({ page }) => {
    await page.route('**/api/instruments', (route) => route.fulfill({ json: { instruments: catalog } }));
});

test('打ち込みを開くと、開発用ブラウザの音色が電子音だと分かる', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.getByText(/電子音（開発用のブラウザ）/)).toBeVisible();
    await expect(page.getByRole('button', { name: '音源をダウンロード' })).toHaveCount(0);
    await expect(page.locator('#piano-grid-wrap')).toBeVisible();
});

test('音色を検索して選ぶ操作を元に戻し・やり直し、保存と開き直しでも音色が残る', async ({ page }) => {
    let downloads = 0;
    await page.route('**/api/instruments/*/install*', (route) => { downloads++; return route.abort(); });
    await openDaw(page);
    await openTab(page, 'シンセ');
    const openPicker = page.getByRole('button', { name: '再生する音色を選ぶ' });
    await openPicker.click();
    await expect(statusText(page)).toContainText('タイムラインでトラック名を選んでから');
    await startFree(page);
    await page.locator('#tracks-container .track-name').first().click();
    const instrument = page.locator('.piano-instrument');
    await openPicker.press('Enter');
    await expect(page.getByLabel('音色を探す')).toBeFocused();
    const select = page.getByLabel('このトラックの音色');
    await expect(select).toHaveAccessibleName('このトラックの音色');
    await expect(select).toHaveValue('salamander');
    await page.getByLabel('音色を探す').fill('声');
    await expect(select.locator('option')).toHaveCount(2);
    await select.selectOption('choir-a');
    await expect(instrument.locator('summary')).toContainText('コーラス あー');
    await page.getByLabel('音色を探す').blur();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(select).toHaveValue('salamander');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(select).toHaveValue('choir-a');
    const file = await saveProject(page, '音色の保存');
    await openProject(page, file);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(instrument.locator('summary')).toContainText('コーラス あー');
    expect(downloads).toBe(0);
});
