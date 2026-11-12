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
        'ファイル': '#file-panel', 'カルテ': '#chart-panel',
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

test('タブはタブとして組んであり、左右の矢印キーで移れる', async ({ page }) => {
    await openDaw(page);
    const tabs = page.getByRole('tablist', { name: '左パネルのタブ' }).getByRole('tab');
    await expect(tabs).toHaveCount(5);
    await expect(page.getByRole('tab', { name: 'シンセ' })).toHaveAttribute('aria-selected', 'true');
    // 開いているタブの中身は、そのタブの名前が付いた枠 (tabpanel) に入っている
    await expect(page.getByRole('tabpanel', { name: 'シンセ' })).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'シンセ' }).locator('#synth-panel')).toBeVisible();

    await page.getByRole('tab', { name: 'シンセ' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'ドラム' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'ドラム' })).toBeFocused();
    await expect(page.locator('#drum-panel')).toBeVisible();
    await expect(page.locator('#synth-panel')).toBeHidden();
    // 左端から左へ行くと、右端 (カルテ) に回る。End / Home で端へ移る
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'カルテ' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#chart-panel')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'シンセ' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'カルテ' })).toHaveAttribute('aria-selected', 'true');
});

test('パネルの余白は 16px で、どのタブも同じ左端にそろう (二重に付いていない)', async ({ page }) => {
    await openDaw(page);
    const panelBox = (await page.locator('#left-panel').boundingBox())!;
    const lefts: Record<string, number> = {};
    for (const [label, selector] of [['シンセ', '#synth-panel'], ['ドラム', '#drum-panel'], ['FX', '#fx-panel'], ['ファイル', '#file-panel'], ['カルテ', '#chart-panel']]) {
        await openTab(page, label);
        const heading = (await page.locator(`${selector} h3`).first().boundingBox())!;
        lefts[label] = heading.x - panelBox.x;
        // 見出しの幅 = パネルの幅 (280px、右の線 1px) から、左右の余白 16px ずつを引いた残り。以前は 216px しか無かった
        expect(heading.width, label).toBeGreaterThanOrEqual(240);
    }
    expect(Object.values(lefts)).toEqual([16, 16, 16, 16, 16]);
    // カルテのタブの中の「楽曲カルテ」と「差分チェック」も、同じ左端
    const chart = (await page.locator('#chart-panel h3').first().boundingBox())!;
    const coach = (await page.locator('#coach-panel h3').first().boundingBox())!;
    expect(coach.x).toBe(chart.x);
    expect(coach.width).toBe(chart.width);
});

test('見出しが入力欄と結び付いていて、見出しの文で入力欄を引ける', async ({ page }) => {
    await openDaw(page);
    await expect(page.getByLabel('楽器（GM 音源）')).toBeVisible();
    await expect(page.getByLabel('アタック')).toHaveAttribute('type', 'range');
    await expect(page.locator('#synth-panel').getByLabel('追加先トラック')).toBeVisible();
    await openTab(page, 'ドラム');
    await page.getByLabel('小節数').fill('2');
    await expect(page.locator('#drum-panel input[type="number"]')).toHaveValue('2');
    await expect(page.getByLabel('パターン')).toHaveValue('8ビート');
    await openTab(page, 'FX');
    await expect(page.getByLabel('対象トラック')).toBeVisible();
    // つまみの名前は日本語で、いまの値が添えてある
    await expect(page.getByLabel('低域 (dB)（0）')).toHaveAttribute('type', 'range');
    await openTab(page, 'ファイル');
    await expect(page.getByLabel('原曲のファイル')).toHaveAttribute('type', 'file');
    await expect(page.getByLabel('BPM を自動で検出する')).toBeChecked();
});

test('時間のかかる処理が走っているあいだは、処理を始めるボタンを押せない (二重に始まらない)', async ({ page }) => {
    await openDaw(page);
    await openTab(page, 'ドラム');
    await page.getByLabel('小節数').fill('1');
    // API の応答を遅らせて、処理中の状態を作る
    let calls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/synth/drum', async (route) => {
        calls += 1;
        await held;
        await route.continue();
    });
    const button = page.getByRole('button', { name: /ドラム生成/ });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(statusText(page)).toHaveText('ドラムを作っています…');
    // 押せないボタンは、無理に押しても何も起きない
    await button.click({ force: true });
    // ほかのタブの、処理を始めるボタンも押せない。処理に関係しないボタンは押せる
    await openTab(page, 'シンセ');
    await expect(page.getByRole('button', { name: 'シーケンスをレンダリング' })).toBeDisabled();
    await openTab(page, 'ファイル');
    await expect(page.locator('#file-panel').getByRole('button', { name: /カルテ/ })).toBeDisabled();
    await page.locator('#file-panel summary').click();
    await expect(page.getByRole('button', { name: /パートに分けて採譜する/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: '+ トラック追加' })).toBeEnabled();

    release();
    await expect(statusText(page)).toHaveText('ドラムを「Drum」に追加しました');
    await openTab(page, 'ドラム');
    await expect(button).toBeEnabled();
    expect(calls).toBe(1);
    await expect(page.locator('#tracks-container .clip')).toHaveCount(1);
});

test('API が理由を返さずに失敗しても、番号や生の JSON ではなく、次にどうすればよいかが出る', async ({ page }) => {
    await openDaw(page);
    await openTab(page, 'ドラム');
    await page.route('**/api/synth/drum', (route) => route.fulfill({
        status: 500, contentType: 'application/json', body: JSON.stringify({ detail: [{ loc: ['body', 'x'], msg: 'boom', type: 'server' }] }),
    }));
    await page.getByRole('button', { name: /ドラム生成/ }).click();
    await expect(statusText(page)).toContainText('処理の途中で問題が起きました。もう一度試してください');
    await expect(statusText(page)).not.toContainText('{');
    await expect(statusText(page)).not.toContainText('HTTP');
    await expect(statusText(page)).not.toContainText('boom');
    // 失敗の知らせは、色が変わり、読み上げの対象になる
    await expect(statusText(page)).toHaveAttribute('role', 'alert');
    await expect(statusText(page)).toHaveCSS('color', 'rgb(232, 120, 120)');
    // 失敗した後は、もう一度押せる
    await expect(page.getByRole('button', { name: /ドラム生成/ })).toBeEnabled();
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
        await expect(statusText(page)).toHaveText('「EQ（3 バンド）」を適用しました');
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
        // エフェクト名と、つまみの数、画面に出る名前
        const sliders: Record<string, [number, string]> = {
            eq: [3, 'EQ（3 バンド）'], compressor: [2, 'コンプレッサー'], reverb: [2, 'リバーブ'], delay: [3, 'ディレイ'],
            normalize: [0, 'ノーマライズ'], pitch_shift: [1, 'ピッチシフト'], time_stretch: [1, 'タイムストレッチ'],
        };
        for (const [fx, [count, label]] of Object.entries(sliders)) {
            await page.locator('#fx-panel select').nth(1).selectOption(fx);
            // エフェクトごとのつまみが出る
            await expect(page.locator('#fx-params input[type="range"]')).toHaveCount(count);
            const wav = await wavResponse(page, `/api/effects/${fx}`, () => page.getByRole('button', { name: 'エフェクト適用' }).click());
            expect(wav.peak, fx).toBeGreaterThan(0.01);
            name += `[${fx}]`;
            // 知らせは、識別子 (pitch_shift など) ではなく日本語の名前で出る
            await expect(statusText(page)).toHaveText(`「${label}」を適用しました`);
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
        // タイムラインのクリップも短くなる (1 秒 = 80px)。応答が返ってから描き直されるまでに間が在るので、待って読む
        await expect.poll(() => page.locator('#tracks-container .clip').evaluate((el) => el.getBoundingClientRect().width))
            .toBeLessThan(before.seconds * 80 * 0.6);
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
