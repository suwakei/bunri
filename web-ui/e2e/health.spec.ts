/**
 * 処理を担当する部分 (API サーバ) が止まったときの知らせ (lib/health.ts、components/HealthBanner.tsx)。
 *
 * API サーバはほかのテストと共用なので、本当には止めない。画面からの API の呼び出しを `page.route` で
 * 届かなくして、止まった状態を作る。デスクトップ版の「再起動」は本物の窓のテスト (e2e-desktop) で見る。
 */
import { expect, test } from '@playwright/test';
import { openDaw, statusText } from './helpers';

test('API に届かなくなると、止まったことと起動し直し方が出て、戻ると消える (開発用のブラウザ起動)', async ({ page }) => {
    await openDaw(page);
    const banner = page.locator('#health-banner');
    await expect(banner).toHaveCount(0);

    await page.route('**/api/**', (route) => route.abort('connectionrefused'));
    // 画面の操作が API に届かなかったことをきっかけに、次の見張りの回を待たずに確かめる
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('処理を担当する部分が止まりました');
    // 開発用のブラウザ起動では、画面から起動し直せないので、起動し直し方を案内する (再起動のボタンは無い)
    await expect(banner).toContainText('make dev-web');
    await expect(banner.getByRole('button', { name: '再起動' })).toHaveCount(0);
    // 知らせは操作を止めない (モーダルではない)。止まっている間も画面は使える
    await page.getByRole('button', { name: '自由に作る' }).click();
    await expect(statusText(page)).toContainText('「Track 1」を作りました');
    await test.info().attach('health-banner', { body: await banner.screenshot(), contentType: 'image/png' });

    await page.unroute('**/api/**');
    await banner.getByRole('button', { name: 'もう一度確かめる' }).click();
    await expect(banner).toHaveCount(0, { timeout: 10_000 });
});
