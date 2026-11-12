/**
 * 楽曲カルテ (第1層) を、ファイルの読み込みから表示まで通す。
 * 解析は API サーバ側で実際に走る (数秒)。
 */
import { expect, test } from '@playwright/test';
import { makeWav, openDaw, openTab, importSong, statusText, trackSummary } from './helpers';

test('曲を取り込むと、原曲のトラックに音声が置かれ、カルテにテンポとキーが出る。再現ガイドと差分チェックの段も出る', async ({ page }) => {
    await openDaw(page);

    // C4 E4 G4 C5 を 2 秒ずつ
    const wav = makeWav(8, [261.63, 329.63, 392.0, 523.25]);
    const analyzed = page.waitForResponse((r) => r.url().endsWith('/api/chart'), { timeout: 60_000 });
    await importSong(page, { name: 'e2e-song.wav', mimeType: 'audio/wav', buffer: wav });
    // 解析のあいだは、もう一度取り込めない (二重に始まらない)
    await expect(page.locator('#song-panel').getByRole('button', { name: /曲を取り込む/ })).toBeDisabled();
    expect((await analyzed).status()).toBe(200);

    // 解析が終わると、カルテの段が自分で開く (結果がどこに出たかを探させない)
    await expect(page.getByRole('tab', { name: 'カルテ' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#song-panel')).toBeHidden();
    const chart = page.locator('#chart-panel');
    await expect(chart).toBeVisible();
    await expect(statusText(page)).toContainText('カルテを作りました');
    await expect(chart).toContainText('e2e-song.wav');
    await expect(chart).toContainText('BPM');
    await expect(chart.getByText('グリッド', { exact: true })).toBeVisible();
    // 原曲の音声が、原曲のトラックに置かれる (空の状態の案内は消える)
    expect(await trackSummary(page)).toEqual([{ name: '原曲', clips: ['e2e-song.wav'] }]);
    await expect(page.locator('#empty-state')).toHaveCount(0);

    // 第2層と第3層の段
    await openTab(page, 'ガイド');
    await expect(page.locator('#guide-panel')).toContainText('再現ガイド');
    await expect(page.locator('#guide-panel')).toContainText('Anthropic の Claude に送ります。音声は送りません');
    await openTab(page, '差分');
    await expect(page.locator('#coach-panel')).toContainText('差分チェック');

    // カルテ・再現ガイド・差分チェックの見出しが、同じ左端にそろっている
    const lefts: number[] = [];
    for (const [tab, selector] of [['カルテ', '#chart-panel > h3'], ['ガイド', '#guide-panel > h3'], ['差分', '#coach-panel > h3']]) {
        await openTab(page, tab);
        lefts.push(Math.round((await page.locator(selector).first().boundingBox())!.x));
    }
    expect(new Set(lefts).size).toBe(1);
    // パネルの本文は 12px 以上、補足は 11px 以上
    await openTab(page, 'カルテ');
    const sizes = await page.locator('#chart-panel').evaluateAll((panels) => {
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
