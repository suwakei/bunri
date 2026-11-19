/**
 * 知らせ（失敗と「いまはできない理由」を、画面に浮かせて出す）。components/NoticeToast.tsx、lib/notice.ts。
 *
 * 「押したのに何も起きない」をなくすためのもの。ステータスバー（下の 1 行）に加えて、画面に浮かぶ知らせとして出ること、
 * 押せないボタンを押したときに理由が出ることを、ブラウザで実際に押して確かめる
 * （押せないボタンにイベントが届くかどうかは、ブラウザごとに違う。単体テストでは分からない）。
 */
import { expect, test, type Page } from '@playwright/test';
import { openDaw, startFree, statusText } from './helpers';

const toasts = (page: Page) => page.locator('#notice-region .notice-toast');

test.describe('知らせ', () => {
    test('失敗は、ステータスバーに加えて、知らせとしても出る。✕ で閉じられる。うまくいった結果は出ない', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        // うまくいった結果 (トラックを作った) は、ステータスバーだけ
        await expect(toasts(page)).toHaveCount(0);

        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        await expect(statusText(page)).toContainText('書き出すものがありません');
        await expect(toasts(page)).toHaveCount(1);
        const toast = toasts(page).first();
        await expect(toast).toContainText('書き出すものがありません');
        await expect(toast).toHaveAttribute('data-notice-kind', 'error');
        // 読み上げの対象は、ステータスバーの側だけ (2 回読まれないように)
        await expect(page.getByRole('alert')).toHaveCount(1);

        // 画面の中に収まっていて、ステータスバーを隠していない
        const box = (await toast.boundingBox())!;
        const bar = (await page.locator('#status-bar').boundingBox())!;
        const view = page.viewportSize()!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(view.width);
        expect(box.y + box.height).toBeLessThanOrEqual(bar.y);

        await toast.getByRole('button', { name: '知らせを閉じる' }).click();
        await expect(toasts(page)).toHaveCount(0);
    });

    test('知らせの文の上を押しても、下のピアノロールに届く (ノートを置ける)', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        const toast = toasts(page).first();
        await expect(toast).toBeVisible();
        // 知らせは、ピアノロールのグリッドの上に重なっている。その文の真ん中をダブルクリックする
        const text = (await toast.locator('.notice-toast-text').boundingBox())!;
        const grid = (await page.locator('#piano-grid-wrap').boundingBox())!;
        const x = text.x + text.width / 2, y = text.y + text.height / 2;
        expect(y).toBeGreaterThan(grid.y);
        expect(y).toBeLessThan(grid.y + grid.height);
        await page.mouse.dblclick(x, y);
        await expect(page.locator('#note-layer .note-block')).toHaveCount(1);
        // 知らせは、そのまま出ている
        await expect(toast).toBeVisible();
    });

    test('鳴らすものが無いまま再生すると、音が鳴らない理由が出る。同じ知らせは並ばない', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await page.locator('#btn-play').click();
        await expect(toasts(page)).toHaveCount(1);
        await expect(toasts(page).first()).toContainText('鳴らすものがまだありません');
        await expect(toasts(page).first()).toHaveAttribute('data-notice-kind', 'hint');
        // 失敗ではないので、ステータスバーは失敗の色にしない
        await expect(statusText(page)).not.toHaveClass(/error/);
        await expect(statusText(page)).toHaveAttribute('role', 'status');

        // 止めて、もう一度再生しても、知らせは 1 つのまま
        await page.locator('#btn-play').click();
        await page.locator('#btn-play').click();
        await expect(toasts(page)).toHaveCount(1);
        await page.getByRole('button', { name: '停止', exact: true }).click();
    });

    test('ノートを選ばずにコピー・コピーせずに貼り付けると、何も起きない理由が出る', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        // ピアノロールを触っている状態にする (キー操作は、ピアノロールにフォーカスが在るときだけ効く)
        await page.locator('#piano-grid-wrap').focus();
        await page.keyboard.press('ControlOrMeta+v');
        await expect(toasts(page).filter({ hasText: '貼り付けるノートが、まだありません' })).toHaveCount(1);
        await page.keyboard.press('ControlOrMeta+c');
        await expect(toasts(page).filter({ hasText: 'コピーするノートが選ばれていません' })).toHaveCount(1);
        await expect(statusText(page)).toContainText('コピーするノートが選ばれていません');
    });

    test('押せないボタンを押すと、どうすれば押せるかが出る', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        // まだ何も取り消していないので、「やり直す」は押せない
        const redo = page.locator('#btn-redo');
        await expect(redo).toBeDisabled();
        // 押せないボタンは、Playwright の click では押せない (待ち続ける) ので、その場所をマウスで押す
        const box = (await redo.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(toasts(page)).toHaveCount(1);
        await expect(toasts(page).first()).toContainText('いまは使えません。やり直せる操作はありません');
        // この文は、ほかのどこにも出ないので、いつも在る読み上げ用の欄に流す
        await expect(page.locator('#notice-live')).toHaveText('いまは使えません。やり直せる操作はありません');

        // キー操作 (ボタンは押せなくても、キーは届く) でも、理由が出る
        await page.locator('#piano-grid-wrap').focus();
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(statusText(page)).toHaveText('やり直せる操作はありません');
        await expect(toasts(page).filter({ hasText: /^.?やり直せる操作はありません/ })).toHaveCount(1);
    });

    test('ツールの画面でも、失敗は知らせとして出る。閉じたあとに同じ失敗をしても、もう一度出る', async ({ page }) => {
        await page.goto('/tools');
        await page.locator('.tool-tabs').getByRole('button', { name: '編集', exact: true }).click();
        await page.getByRole('button', { name: '編集を実行', exact: true }).click();
        await expect(page.locator('.tools-page .status')).toHaveClass(/error/);
        const text = (await page.locator('.tools-page .status').textContent())!;
        await expect(toasts(page)).toHaveCount(1);
        await expect(toasts(page).first()).toContainText(text);

        await toasts(page).first().getByRole('button', { name: '知らせを閉じる' }).click();
        await expect(toasts(page)).toHaveCount(0);
        await page.getByRole('button', { name: '編集を実行', exact: true }).click();
        await expect(toasts(page)).toHaveCount(1);
    });
});
