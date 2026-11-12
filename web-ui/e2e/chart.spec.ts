/**
 * 楽曲カルテ (第1層) を、ファイルの読み込みから表示まで通す。
 * 解析は API サーバ側で実際に走る (数秒)。
 */
import { expect, test } from '@playwright/test';
import { makeWav, openDaw, statusText } from './helpers';

test('音声ファイルを解析すると、カルテにテンポとキーが出て、再現ガイドと差分チェックの欄が出る', async ({ page }) => {
    await openDaw(page);
    await page.locator('#panel-tabs').getByText('ファイル').click();

    // C4 E4 G4 C5 を 2 秒ずつ
    const wav = makeWav(8, [261.63, 329.63, 392.0, 523.25]);
    await page.locator('#file-panel input[type="file"]').first().setInputFiles({ name: 'e2e-song.wav', mimeType: 'audio/wav', buffer: wav });
    const analyzed = page.waitForResponse((r) => r.url().endsWith('/api/chart'), { timeout: 60_000 });
    const button = page.locator('#file-panel').getByRole('button', { name: /カルテ/ });
    await button.click();
    // 解析のあいだは、もう一度押せない (二重に始まらない)
    await expect(button).toBeDisabled();
    expect((await analyzed).status()).toBe(200);

    // 解析が終わると、カルテのタブが自分で開く (結果がどこに出たかを探させない)
    await expect(page.locator('#panel-tabs').getByRole('tab', { name: 'カルテ' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-tabs').getByRole('tab', { name: 'ファイル' })).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#file-panel')).toBeHidden();
    const chart = page.locator('#chart-panel');
    await expect(chart).toBeVisible();
    await expect(statusText(page)).toContainText('カルテを作りました');
    await expect(chart).toContainText('e2e-song.wav');
    await expect(chart).toContainText('BPM');
    await expect(chart.getByText('グリッド', { exact: true })).toBeVisible();

    // 第2層と第3層の欄
    await expect(page.locator('#guide-panel')).toContainText('再現ガイド');
    await expect(page.locator('#guide-panel')).toContainText('Anthropic の Claude に送ります。音声は送りません');
    await expect(page.locator('#coach-panel')).toContainText('差分チェック');

    // カルテ・再現ガイド・差分チェックの見出しが、同じ左端にそろっている
    const lefts = await Promise.all(['#chart-panel > h3', '#guide-panel > h3', '#coach-panel h3'].map(
        async (selector) => Math.round((await page.locator(selector).first().boundingBox())!.x),
    ));
    expect(new Set(lefts).size).toBe(1);
    // パネルの本文は 12px 以上、補足は 11px 以上
    const sizes = await page.locator('#chart-panel, #coach-panel').evaluateAll((panels) => {
        const found: number[] = [];
        for (const panel of panels) {
            for (const el of panel.querySelectorAll('*')) {
                const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
                if (hasText) found.push(parseFloat(getComputedStyle(el).fontSize));
            }
        }
        return found;
    });
    // 例外は、コードの升目の小節番号 (10px。詰まった表示)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
    expect(sizes.filter((size) => size < 11).length).toBeLessThanOrEqual(await page.locator('#chart-panel [style*="font-size: 10px"]').count());
});
