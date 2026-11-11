/**
 * 左パネルのシンセ・ドラム・FX と、ファイルのタブの「ファイル読み込み」「単音メロディ解析」。
 *
 * 音は API サーバが実際に作る。この環境には libfluidsynth と SoundFont が無い前提で、
 * GM 音源を選んでも内蔵シンセで代替されることを確かめる。
 */
import { expect, test, type Page } from '@playwright/test';
import { openDaw, openTab, readWav, statusText, trackSummary, wavFile } from './helpers';

/** Track 1 を開いて、ピアノロールにノートを 2 つ置く。 */
async function placeTwoNotes(page: Page) {
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 200 } });
    await page.locator('#note-layer').dblclick({ position: { x: 90, y: 228 } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(2);
}

/** 指定した API の応答を待ち、WAV として読む。 */
async function wavResponse(page: Page, path: string, action: () => Promise<void>) {
    const waiting = page.waitForResponse((r) => r.url().includes(path));
    await action();
    const resp = await waiting;
    expect(resp.status()).toBe(200);
    return readWav(await resp.body());
}

test('タブを切り替えると、そのタブの中身だけが見える。タブの文字は 1 行に収まる', async ({ page }) => {
    await openDaw(page);
    const panels: Record<string, string> = {
        'シンセ': '#synth-panel', 'ドラム': '#drum-panel', 'FX': '#fx-panel',
        'ファイル': '#file-panel', 'カルテ': '#chart-panel', 'AI': '#assistant-panel',
    };
    for (const [label, selector] of Object.entries(panels)) {
        await openTab(page, label);
        for (const other of Object.values(panels)) {
            if (other === selector) await expect(page.locator(other)).toBeVisible();
            else await expect(page.locator(other)).toBeHidden();
        }
    }
    // 文字が折り返すと、タブの段が 2 行ぶんの高さになる
    const height = await page.locator('#panel-tabs').evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(44);
});

test.describe('シンセ', () => {
    test('ノートが無いときは、レンダリングせずに理由を出す', async ({ page }) => {
        await openDaw(page);
        let called = false;
        page.on('request', (r) => { if (r.url().includes('/api/synth/sequence')) called = true; });
        await page.getByRole('button', { name: 'シーケンスをレンダリング' }).click();
        await expect(statusText(page)).toHaveText('ピアノロールにノートを配置してください');
        expect(called).toBe(false);
    });

    test('カスタム波形でレンダリングすると、音の入ったクリップが、開いているトラックに入る', async ({ page }) => {
        await openDaw(page);
        await placeTwoNotes(page);
        const wav = await wavResponse(page, '/api/synth/sequence', () => page.getByRole('button', { name: 'シーケンスをレンダリング' }).click());
        // 2 つ目のノートは 4〜8 ステップ目 (120 BPM で 0.5〜1.0 秒)。余韻を含めて 1 秒以上
        expect(wav.seconds).toBeGreaterThanOrEqual(1);
        expect(wav.peak).toBeGreaterThan(0.05);
        await expect(statusText(page)).toHaveText('シーケンスを「Track 1」に追加しました');
        expect(await trackSummary(page)).toEqual([{ name: 'Track 1', clips: ['synth-seq'] }, { name: 'Track 2', clips: [] }]);
    });

    test('GM 音源の一覧が出て、選んでレンダリングしても音が出る (SoundFont が無ければ内蔵シンセで代替)', async ({ page }) => {
        await openDaw(page);
        const gm = page.locator('#synth-panel select').first();
        await expect(gm.locator('optgroup')).toHaveCount(12);
        // GM の 0 番 (ピアノ) が、ピアノの分類の先頭に在る
        await expect(gm.locator('optgroup[label="ピアノ"] option').first()).toHaveText('ピアノ');
        await placeTwoNotes(page);
        await gm.selectOption('0');
        const wav = await wavResponse(page, '/api/synth/sequence', () => page.getByRole('button', { name: 'シーケンスをレンダリング' }).click());
        expect(wav.peak).toBeGreaterThan(0.05);
        await expect(statusText(page)).toHaveText('シーケンスを「Track 1」に追加しました');
    });

    test('「追加先トラック」で選んだトラックにクリップが入る', async ({ page }) => {
        await openDaw(page);
        await placeTwoNotes(page);
        const target = page.locator('#synth-panel select').last();
        // 選ぶ前は「開いているトラック」で、実際にもそこへ入る (上のテスト)
        expect(await target.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex].textContent)).toBe('ピアノロールで開いているトラック');
        await target.selectOption({ label: 'Track 2' });
        await page.getByRole('button', { name: 'シーケンスをレンダリング' }).click();
        await expect(statusText(page)).toHaveText('シーケンスを「Track 2」に追加しました');
        expect(await trackSummary(page)).toEqual([{ name: 'Track 1', clips: [] }, { name: 'Track 2', clips: ['synth-seq'] }]);
    });
});

test.describe('ドラム', () => {
    test('生成すると、新しい Drum トラックに音の入ったクリップが入る。小節数が長さに効く', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'ドラム');
        await page.locator('#drum-panel input[type="number"]').fill('1');
        const wav = await wavResponse(page, '/api/synth/drum', () => page.getByRole('button', { name: /ドラム生成/ }).click());
        // 120 BPM・4/4 の 1 小節 = 2 秒
        expect(wav.seconds).toBeGreaterThan(1.9);
        expect(wav.seconds).toBeLessThan(2.6);
        expect(wav.peak).toBeGreaterThan(0.05);
        await expect(statusText(page)).toHaveText('ドラムを「Drum」に追加しました');
        expect(await trackSummary(page)).toEqual([
            { name: 'Track 1', clips: [] }, { name: 'Track 2', clips: [] }, { name: 'Drum', clips: ['drum-8ビート'] },
        ]);
    });

    test('どのパターンも生成でき、既存のトラックを選ぶとそこに入る', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'ドラム');
        await page.locator('#drum-panel input[type="number"]').fill('1');
        await page.locator('#drum-panel select').last().selectOption({ label: 'Track 2' });
        const patterns = ['8ビート', '4つ打ち', 'ボサノバ', 'レゲエ'];
        for (const [i, pattern] of patterns.entries()) {
            await page.locator('#drum-panel select').first().selectOption(pattern);
            const wav = await wavResponse(page, '/api/synth/drum', () => page.getByRole('button', { name: /ドラム生成/ }).click());
            expect(wav.peak, pattern).toBeGreaterThan(0.05);
            await expect(page.locator('#tracks-container .clip')).toHaveCount(i + 1);
        }
        expect(await trackSummary(page)).toEqual([
            { name: 'Track 1', clips: [] }, { name: 'Track 2', clips: patterns.map((p) => `drum-${p}`) },
        ]);
    });
});

test.describe('FX', () => {
    test('クリップの無いトラックには適用せず、理由を出す', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'FX');
        await page.getByRole('button', { name: 'エフェクト適用' }).click();
        await expect(statusText(page)).toHaveText('エフェクト対象のトラックにクリップがありません');
    });

    test('表示されているトラック (選び直していない先頭のトラック) に、そのまま適用できる', async ({ page }) => {
        await openDaw(page);
        // Track 1 にクリップを入れる
        await placeTwoNotes(page);
        await page.getByRole('button', { name: 'シーケンスをレンダリング' }).click();
        await expect(page.locator('#tracks-container .clip')).toHaveCount(1);

        await openTab(page, 'FX');
        // 対象トラックの欄には、先頭の Track 1 が表示されている
        expect(await page.locator('#fx-panel select').first().evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex].textContent)).toBe('Track 1');
        await page.getByRole('button', { name: 'エフェクト適用' }).click();
        await expect(statusText(page)).toHaveText('eq を適用しました');
        await expect(page.locator('#tracks-container .clip')).toHaveText('synth-seq[eq]');
    });

    test('どのエフェクトも適用でき、クリップが処理後の音に置き換わる', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'ドラム');
        await page.locator('#drum-panel input[type="number"]').fill('1');
        await page.getByRole('button', { name: /ドラム生成/ }).click();
        await expect(page.locator('#tracks-container .clip')).toHaveCount(1);

        await openTab(page, 'FX');
        await page.locator('#fx-panel select').first().selectOption({ label: 'Drum' });
        let name = 'drum-8ビート';
        const sliders: Record<string, number> = { eq: 3, compressor: 2, reverb: 2, delay: 3, normalize: 0, pitch_shift: 1, time_stretch: 1 };
        for (const [fx, count] of Object.entries(sliders)) {
            await page.locator('#fx-panel select').nth(1).selectOption(fx);
            // エフェクトごとのつまみが出る
            await expect(page.locator('#fx-params input[type="range"]')).toHaveCount(count);
            const wav = await wavResponse(page, `/api/effects/${fx}`, () => page.getByRole('button', { name: 'エフェクト適用' }).click());
            expect(wav.peak, fx).toBeGreaterThan(0.01);
            name += `[${fx}]`;
            await expect(statusText(page)).toHaveText(`${fx} を適用しました`);
            await expect(page.locator('#tracks-container .clip')).toHaveText(name);
        }
    });

    test('つまみの値が API に渡り、音が変わる (タイムストレッチで長さが変わる)', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'ドラム');
        await page.locator('#drum-panel input[type="number"]').fill('1');
        const before = await wavResponse(page, '/api/synth/drum', () => page.getByRole('button', { name: /ドラム生成/ }).click());

        await openTab(page, 'FX');
        await page.locator('#fx-panel select').first().selectOption({ label: 'Drum' });
        await page.locator('#fx-panel select').nth(1).selectOption('time_stretch');
        await page.locator('#fx-params input[type="range"]').fill('2');
        const after = await wavResponse(page, '/api/effects/time_stretch', () => page.getByRole('button', { name: 'エフェクト適用' }).click());
        // 速度 2 倍 → 長さは半分
        expect(after.seconds).toBeGreaterThan(before.seconds * 0.4);
        expect(after.seconds).toBeLessThan(before.seconds * 0.6);
        // タイムラインのクリップも短くなる (1 秒 = 80px)
        const width = await page.locator('#tracks-container .clip').evaluate((el) => el.getBoundingClientRect().width);
        expect(width).toBeLessThan(before.seconds * 80 * 0.6);
    });
});

test.describe('ファイル読み込み', () => {
    test('選び直さなければ、表示されている先頭のトラックに入る', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'ファイル');
        const select = page.locator('#file-panel select').first();
        expect(await select.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex].textContent)).toBe('Track 1');
        await page.locator('#file-panel input[type="file"]').nth(1).setInputFiles(wavFile('e2e-import.wav'));
        await page.getByRole('button', { name: '選択したトラックに追加' }).click();
        await expect(statusText(page)).toHaveText('e2e-import.wav を「Track 1」に追加しました');
        expect(await trackSummary(page)).toEqual([{ name: 'Track 1', clips: ['e2e-import.wav'] }, { name: 'Track 2', clips: [] }]);
        // クリップの長さは 2 秒 (1 秒 = 80px)
        const width = await page.locator('#tracks-container .clip').evaluate((el) => el.getBoundingClientRect().width);
        expect(Math.round(width)).toBe(160);
    });

    test('トラックを選ぶとそこに入り、複数のファイルをまとめて入れられる', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'ファイル');
        await page.locator('#file-panel select').first().selectOption({ label: 'Track 2' });
        await page.locator('#file-panel input[type="file"]').nth(1).setInputFiles([wavFile('e2e-a.wav', 1), wavFile('e2e-b.wav', 1)]);
        await page.getByRole('button', { name: '選択したトラックに追加' }).click();
        await expect(page.locator('#tracks-container .clip')).toHaveCount(2);
        expect(await trackSummary(page)).toEqual([{ name: 'Track 1', clips: [] }, { name: 'Track 2', clips: ['e2e-a.wav', 'e2e-b.wav'] }]);
    });
});

test.describe('単音メロディ解析', () => {
    test('ファイルやトラックを選んでいないときは、理由を出す', async ({ page }) => {
        await openDaw(page);
        await openTab(page, 'ファイル');
        await page.getByRole('button', { name: '解析してピアノロールに配置' }).click();
        await expect(statusText(page)).toHaveText('解析するWAVファイルを選択してください');
        await page.locator('#file-panel input[type="file"]').nth(2).setInputFiles(wavFile('e2e-melody.wav', 1));
        await page.getByRole('button', { name: '解析してピアノロールに配置' }).click();
        await expect(statusText(page)).toHaveText('先にトラックをクリックしてピアノロールを開いてください');
    });

    test('単音の WAV を解析すると、その高さのノートがピアノロールに並ぶ', async ({ page }) => {
        await openDaw(page);
        await page.locator('#tracks-container .track-name').first().click();
        await openTab(page, 'ファイル');
        // C4 E4 G4 C5 を 1 秒ずつ (120 BPM なら 8 ステップずつ)
        await page.locator('#file-panel input[type="file"]').nth(2).setInputFiles(wavFile('e2e-melody.wav', 4, [261.63, 329.63, 392.0, 523.25]));
        const analyzed = page.waitForResponse((r) => r.url().endsWith('/api/analyze'), { timeout: 80_000 });
        await page.getByRole('button', { name: '解析してピアノロールに配置' }).click();
        expect((await analyzed).status()).toBe(200);
        await expect(statusText(page)).toHaveText('4個のノートを検出しました');
        const titles = await page.locator('#note-layer .note-block').evaluateAll((els) => els.map((el) => (el as HTMLElement).title));
        expect(titles.map((t) => t.split(' ')[0])).toEqual(['C4', 'E4', 'G4', 'C5']);
        expect(titles.map((t) => Number(t.match(/step:(\d+)/)![1]))).toEqual([0, 8, 16, 24]);
        // トラックの見出しにノートの数が出る
        await expect(page.locator('#tracks-container .notes-badge').first()).toHaveText('4');
    });
});
