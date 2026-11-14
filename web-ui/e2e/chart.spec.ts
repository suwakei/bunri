/**
 * 楽曲カルテ (第1層) を、ファイルの読み込みから表示まで通す。
 * 解析は API サーバ側で実際に走る (数秒)。
 * テンポが倍・半分かもしれないことの案内 (BPM の下の候補と、グリッドの確認・補正の窓への導線)。
 */
import { expect, test } from '@playwright/test';
import { makeWav, openDaw, openTab, importSong, runJob, statusText, trackSummary } from './helpers';

test('曲を取り込むと、原曲のトラックに音声が置かれ、カルテにテンポとキーが出る。再現ガイドと差分チェックの段も出る', async ({ page }) => {
    await openDaw(page);

    // C4 E4 G4 C5 を 2 秒ずつ
    const wav = makeWav(8, [261.63, 329.63, 392.0, 523.25]);
    const analyzed = runJob(page, '/api/chart', async () => {
        await importSong(page, { name: 'e2e-song.wav', mimeType: 'audio/wav', buffer: wav });
        // 解析のあいだは、もう一度取り込めない (二重に始まらない)。進み具合のカードが出る
        await expect(page.locator('#song-panel').getByRole('button', { name: /曲を取り込む/ })).toBeDisabled();
        await expect(page.locator('#song-panel').getByRole('group', { name: '楽曲カルテの作成の進み具合' })).toBeVisible();
    });
    expect((await analyzed).state).toBe('done');

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

test('BPM の下に倍・半分の候補が出て、「波形で確かめる」でグリッドの確認・補正の窓が開く。グリッドを確定した後は出ない', async ({ page }) => {
    await openDaw(page);
    const analyzed = await runJob(page, '/api/chart', () => importSong(page, {
        name: 'e2e-tempo.wav', mimeType: 'audio/wav', buffer: makeWav(8, [261.63, 329.63, 392.0, 523.25]),
    }));
    expect(analyzed.state).toBe('done');
    const chart = page.locator('#chart-panel');
    await expect(chart).toBeVisible();

    // 候補は、カルテの BPM から計算した値 (40〜250 BPM の外は出さない)
    const bpm = (analyzed.result as { chart: { grid: { bpm: number } } }).chart.grid.bpm;
    const half = Math.round(bpm / 2), double = Math.round(bpm * 2);
    const hint = chart.locator('#tempo-hint');
    await expect(hint).toBeVisible();
    if (half >= 40) await expect(hint).toContainText(`速すぎると感じたら${double <= 250 ? ' ' : '、'}${half}`);
    else await expect(hint).not.toContainText('速すぎる');
    if (double <= 250) await expect(hint).toContainText(`遅すぎると感じたら${half >= 40 ? ' ' : '、'}${double}`);
    else await expect(hint).not.toContainText('遅すぎる');
    // BPM の行のすぐ下、拍子の行より上に在る
    const hintBox = (await hint.boundingBox())!;
    const bpmRow = (await chart.getByText(bpm.toFixed(1), { exact: true }).boundingBox())!;
    const meterRow = (await chart.getByText('拍子', { exact: true }).boundingBox())!;
    expect(hintBox.y).toBeGreaterThanOrEqual(bpmRow.y + bpmRow.height - 1);
    expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(meterRow.y + 1);
    // 補足の文字 (11px) で、パネルの幅からはみ出さない
    expect(await hint.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(11);
    const panelBox = (await chart.boundingBox())!;
    expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
    await test.info().attach('tempo-hint', { body: await chart.screenshot(), contentType: 'image/png' });

    // マウスを載せると、押すと何が起きるかの説明が出る (title は使わない)
    const open = hint.getByRole('button', { name: '波形で確かめる' });
    await expect(open).not.toHaveAttribute('title');
    await open.hover();
    await expect(page.locator('#bunri-tooltip')).toContainText('波形と拍の線を見比べる窓が開き');

    // キーボードで: フォーカスして Enter で窓が開き、Esc で閉じる
    const dialog = page.getByRole('dialog', { name: 'グリッドの確認・補正' });
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('BPM')).toHaveValue(bpm.toFixed(1));
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // 何も確定していないので、案内は出たまま
    await expect(hint).toBeVisible();

    // マウスで: 窓を開き、半分か倍にして確定する
    await open.click();
    await expect(dialog).toBeVisible();
    const target = half >= 40 ? bpm / 2 : bpm * 2;
    await dialog.getByRole('button', { name: half >= 40 ? '÷2（遅く）' : '×2（速く）' }).click();
    await expect(dialog.getByLabel('BPM')).toHaveValue(target.toFixed(1));
    const regrid = await runJob(page, '/api/chart/regrid', () => dialog.getByRole('button', { name: 'この設定で確定して再計算' }).click());
    expect(regrid.state).toBe('done');
    await expect(dialog).toBeHidden();
    await expect(statusText(page)).toContainText(`グリッドを確定しました（BPM ${target.toFixed(1)}）`);
    // 利用者が自分で確かめて決めた後は、倍・半分の案内を出さない。確かめる窓への入口は残る
    await expect(chart).toContainText(target.toFixed(1));
    await expect(hint).toHaveCount(0);
    await expect(chart.getByRole('button', { name: 'グリッドを確認・補正する' })).toBeVisible();
});
