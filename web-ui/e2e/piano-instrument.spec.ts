/** 開発用ブラウザでは、ピアノ音源を使わないことを音色の欄で伝える。 */
import { expect, test } from '@playwright/test';
import { openDaw, startFree } from './helpers';

test('打ち込みを開くと、開発用ブラウザの音色が電子音だと分かる', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.getByText('音色: 電子音（開発用のブラウザ）')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ピアノ音源をダウンロード' })).toHaveCount(0);
    await expect(page.locator('#piano-grid-wrap')).toBeVisible();
});
