/**
 * ツールの画面 (/tools) の各タブ: 編集、エフェクト、一括編集、音源合成、変換、解析。
 *
 * 処理は API サーバが実際に行う。時間のかかるパート分離と採譜は入れていない。
 * 変換は ffmpeg が要る。無い環境では、その旨のエラーが画面に出ることを確かめる。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readWav, wavFile } from './helpers';

async function openTool(page: Page, tab: string) {
    await page.goto('/tools');
    await page.locator('.tool-tabs').getByRole('button', { name: tab, exact: true }).click();
}

const status = (page: Page) => page.locator('.tools-page .status');
/** 見出しの文で入力欄を引く (この画面の見出しは、入力欄と同じ枠の中に並んでいる)。 */
const field = (page: Page, label: string): Locator =>
    page.locator('.tool-panel .form-group').filter({ has: page.locator('label', { hasText: label }) }).locator('input, select');

/** ボタンを押して API の応答を待ち、状態と本文を返す。 */
async function run(page: Page, path: string, button: string) {
    const waiting = page.waitForResponse((r) => r.url().includes(path));
    await page.getByRole('button', { name: button, exact: true }).click();
    const resp = await waiting;
    return { status: resp.status(), body: await resp.body() };
}

/** 結果の欄のプレーヤーが、再生できる音声を読み込んでいること。長さ (秒) を返す。 */
async function playableSeconds(page: Page, index = 0): Promise<number> {
    const audio = page.locator('.result-area audio').nth(index);
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThan(0);
    return audio.evaluate((a: HTMLAudioElement) => (a.error ? -1 : a.duration));
}

test.describe('編集', () => {
    test('ファイルを選ばずに実行すると、理由を出す', async ({ page }) => {
        await openTool(page, '編集');
        await page.getByRole('button', { name: '編集を実行' }).click();
        await expect(status(page)).toHaveText('ファイルを選択してください');
        await expect(status(page)).toHaveClass(/error/);
    });

    test('トリム・カット・範囲コピー・無音挿入・ループが、指定どおりの長さの音声を返す', async ({ page }) => {
        await openTool(page, '編集');
        await page.locator('#edit-file').setInputFiles(wavFile('e2e-edit.wav', 3, [440, 660, 880]));
        const action = field(page, '編集操作');
        const seconds = async (name: string) => {
            const result = await run(page, `/api/edit/${name}`, '編集を実行');
            expect(result.status, name).toBe(200);
            await expect(status(page)).toHaveText('完了');
            return readWav(result.body).seconds;
        };

        // トリム: 0〜1 秒だけを残す
        await field(page, '終了位置（秒）').fill('1');
        expect(await seconds('trim')).toBeCloseTo(1, 2);
        expect(await playableSeconds(page)).toBeCloseTo(1, 1);

        // カット: 1〜2 秒を取り除く
        await action.selectOption('cut');
        await field(page, '開始位置（秒）').fill('1');
        await field(page, '終了位置（秒）').fill('2');
        expect(await seconds('cut')).toBeCloseTo(2, 2);

        // 範囲コピー: 0〜1 秒を、3 秒の位置 (末尾) に差し込む
        await action.selectOption('copy_range');
        await field(page, '開始位置（秒）').fill('0');
        await field(page, '終了位置（秒）').fill('1');
        await field(page, '挿入位置（秒）').fill('3');
        expect(await seconds('copy_range')).toBeCloseTo(4, 2);

        // 無音挿入: 1 秒の位置に 2 秒
        await action.selectOption('silence');
        await field(page, '開始位置（秒）').fill('1');
        await field(page, '無音の長さ（秒）').fill('2');
        expect(await seconds('silence')).toBeCloseTo(5, 2);

        // ループ: 0〜1 秒を 3 回 (元の 1 回ぶんが 3 回ぶんになる)
        await action.selectOption('loop');
        await field(page, '開始位置（秒）').fill('0');
        await field(page, '終了位置（秒）').fill('1');
        await field(page, 'ループ回数').fill('3');
        expect(await seconds('loop')).toBeCloseTo(5, 2);
        expect(await playableSeconds(page)).toBeCloseTo(5, 1);
    });

    test('操作を選んだ直後の値のままで、そのまま実行できる (ループの回数の初期値)', async ({ page }) => {
        await openTool(page, '編集');
        await page.locator('#edit-file').setInputFiles(wavFile('e2e-edit.wav', 3));
        await field(page, '編集操作').selectOption('loop');
        const result = await run(page, '/api/edit/loop', '編集を実行');
        expect(result.status).toBe(200);
        await expect(status(page)).toHaveText('完了');
    });

    test('API が断った理由が、そのままの文で出る', async ({ page }) => {
        await openTool(page, '編集');
        await page.locator('#edit-file').setInputFiles(wavFile('e2e-edit.wav', 3));
        await field(page, '開始位置（秒）').fill('2');
        await field(page, '終了位置（秒）').fill('1');
        const result = await run(page, '/api/edit/trim', '編集を実行');
        expect(result.status).toBe(400);
        // 理由の文がそのまま出る (「エラー: 」を頭に付けない)。失敗は色と role で伝える
        await expect(status(page)).toHaveText('開始が終了以降になっています');
        await expect(status(page)).toHaveClass(/error/);
        await expect(status(page)).toHaveAttribute('role', 'alert');
        await expect(status(page)).toHaveClass(/error/);
    });

    test('ファイルより長い範囲をカットしようとすると、空の音声を返さずに断る', async ({ page }) => {
        await openTool(page, '編集');
        await page.locator('#edit-file').setInputFiles(wavFile('e2e-edit.wav', 3));
        await field(page, '編集操作').selectOption('cut');
        // 初期値のまま (0〜10 秒)。3 秒のファイルでは全部が消える
        const result = await run(page, '/api/edit/cut', '編集を実行');
        expect(result.status).toBe(400);
        await expect(status(page)).toHaveClass(/error/);
        await expect(status(page)).toContainText('残りません');
        await expect(page.locator('.result-area')).toHaveCount(0);
    });

    test('結果は、分かる名前でダウンロードできる', async ({ page }) => {
        await openTool(page, '編集');
        await page.locator('#edit-file').setInputFiles(wavFile('e2e-edit.wav', 3));
        await field(page, '終了位置（秒）').fill('1');
        await run(page, '/api/edit/trim', '編集を実行');
        const download = page.waitForEvent('download');
        await page.locator('.result-area').getByText('ダウンロード').click();
        expect((await download).suggestedFilename()).toBe('e2e-edit_trim.wav');
    });
});

test.describe('エフェクト', () => {
    test('どのエフェクトも、再生できる音声を返す', async ({ page }) => {
        await openTool(page, 'エフェクト');
        await page.locator('#fx-file').setInputFiles(wavFile('e2e-fx.wav', 2, [440, 660]));
        // エフェクト名と、出てくる入力欄の数、画面に出る名前
        const effects: Record<string, [number, string]> = {
            eq: [3, 'EQ（3 バンド）'], compressor: [2, 'コンプレッサー'], reverb: [2, 'リバーブ'], delay: [3, 'ディレイ'],
            normalize: [0, 'ノーマライズ'], volume: [1, '音量変更'], fade_in: [1, 'フェードイン'], fade_out: [1, 'フェードアウト'],
            pan: [1, 'パン'], reverse: [0, 'リバース'], pitch_shift: [1, 'ピッチシフト'], time_stretch: [1, 'タイムストレッチ'],
            speed: [1, '速度変更'],
        };
        for (const [fx, [inputs, label]] of Object.entries(effects)) {
            await field(page, 'エフェクト').first().selectOption(fx);
            await expect(page.locator('.tool-panel .form-row input[type="number"]'), fx).toHaveCount(inputs);
            const result = await run(page, `/api/effects/${fx}`, 'エフェクト適用');
            expect(result.status, fx).toBe(200);
            const wav = readWav(result.body);
            expect(wav.seconds, fx).toBeGreaterThan(1.5);
            expect(wav.peak, fx).toBeGreaterThan(0.01);
            // 結果の見出しは、識別子 (pitch_shift など) ではなく日本語の名前で出る
            await expect(page.locator('.result-area .result-label')).toHaveText(`「${label}」をかけた結果`);
        }
        expect(await playableSeconds(page)).toBeGreaterThan(1.5);
    });

    test('入力した値が効く (速度 2 倍で長さが半分になる)', async ({ page }) => {
        await openTool(page, 'エフェクト');
        await page.locator('#fx-file').setInputFiles(wavFile('e2e-fx.wav', 2));
        await field(page, 'エフェクト').first().selectOption('speed');
        await field(page, '速度倍率').fill('2');
        const result = await run(page, '/api/effects/speed', 'エフェクト適用');
        expect(readWav(result.body).seconds).toBeCloseTo(1, 1);
        await expect(status(page)).toHaveText('完了');
    });
});

test.describe('一括編集', () => {
    test('複数のファイルに同じ操作をかけ、結果を聴いてダウンロードできる', async ({ page }) => {
        await openTool(page, '一括編集');
        await page.locator('#batch-files').setInputFiles([wavFile('e2e-b1.wav'), wavFile('e2e-b2.wav')]);
        await expect(page.getByText('2個のファイルを選択')).toBeVisible();
        const result = await run(page, '/api/batch/edit', '一括実行');
        expect(result.status).toBe(200);
        await expect(status(page)).toHaveText('完了: 2個成功');
        await expect(page.locator('.result-area .result-label')).toHaveText(['e2e-b1.wav', 'e2e-b2.wav']);
        expect(await playableSeconds(page, 0)).toBeCloseTo(2, 1);
        expect(await playableSeconds(page, 1)).toBeCloseTo(2, 1);

        const download = page.waitForEvent('download');
        await page.locator('.result-area').getByText('ダウンロード').first().click();
        const file = await download;
        expect(file.suggestedFilename()).toBe('batch_normalize_e2e-b1.wav');
    });

    test('カテゴリを変えると、操作の一覧が入れ替わる', async ({ page }) => {
        await openTool(page, '一括編集');
        const action = field(page, '操作');
        await expect(action.locator('option')).toHaveCount(10);
        await action.selectOption('silence');
        await field(page, 'カテゴリ').selectOption('effects');
        await expect(action.locator('option')).toHaveCount(13);
        // 前のカテゴリにしか無い操作が選ばれたままにならない
        await expect(action).toHaveValue('normalize');
        await page.locator('#batch-files').setInputFiles([wavFile('e2e-b1.wav')]);
        await action.selectOption('reverse');
        const result = await run(page, '/api/batch/effects', '一括実行');
        expect(result.status).toBe(200);
        await expect(status(page)).toHaveText('完了: 1個成功');
    });

    test('範囲の要る操作 (トリム) は入力欄が出て、その値で処理される', async ({ page }) => {
        await openTool(page, '一括編集');
        await page.locator('#batch-files').setInputFiles([wavFile('e2e-b1.wav', 3), wavFile('e2e-b2.wav', 3)]);
        // 範囲の要らない操作では、入力欄は出ない
        await expect(page.locator('.batch-params input')).toHaveCount(0);
        await field(page, '操作').selectOption({ label: 'トリム' });
        await expect(page.locator('.batch-params input')).toHaveCount(2);
        await field(page, '終了（秒）').fill('1');
        const result = await run(page, '/api/batch/edit', '一括実行');
        expect(result.status).toBe(200);
        await expect(status(page)).toHaveText('完了: 2個成功');
        expect(await playableSeconds(page, 0)).toBeCloseTo(1, 1);
        expect(await playableSeconds(page, 1)).toBeCloseTo(1, 1);
    });

    test('失敗したファイルは、理由と一緒に表示される', async ({ page }) => {
        await openTool(page, '一括編集');
        // 無音のファイルはノーマライズできない
        const silent = { name: 'e2e-silent.wav', mimeType: 'audio/wav', buffer: wavFile('x.wav', 1, [0]).buffer };
        await page.locator('#batch-files').setInputFiles([wavFile('e2e-b1.wav'), silent]);
        const result = await run(page, '/api/batch/edit', '一括実行');
        expect(result.status).toBe(200);
        await expect(status(page)).toHaveText('完了: 1個成功 / 1個失敗');
        await expect(status(page)).toHaveClass(/error/);
        await expect(page.locator('.result-area .result-label')).toHaveText(['e2e-b1.wav']);
        await expect(page.locator('.tool-panel .batch-failures')).toContainText('e2e-silent.wav');
        await expect(page.locator('.tool-panel .batch-failures')).toContainText('無音のファイルです');
    });
});

test.describe('音源合成', () => {
    test('2 つのファイルが揃っていないと、理由を出す', async ({ page }) => {
        await openTool(page, '音源合成');
        await page.locator('#ovl-base').setInputFiles(wavFile('e2e-base.wav', 3));
        await page.getByRole('button', { name: '合成を実行' }).click();
        await expect(status(page)).toHaveText('2つのファイルを選択してください');
    });

    test('ベースに、開始位置をずらして重ねた音声を返す', async ({ page }) => {
        await openTool(page, '音源合成');
        await page.locator('#ovl-base').setInputFiles(wavFile('e2e-base.wav', 3, [220]));
        await page.locator('#ovl-over').setInputFiles(wavFile('e2e-over.wav', 1, [880]));
        // 2.5 秒の位置から 1 秒ぶんを重ねる → 全体は 3.5 秒に伸びる
        await field(page, '開始位置（秒）').fill('2.5');
        const result = await run(page, '/api/overlay', '合成を実行');
        expect(result.status).toBe(200);
        const wav = readWav(result.body);
        expect(wav.seconds).toBeCloseTo(3.5, 1);
        expect(wav.peak).toBeGreaterThan(0.05);
        await expect(status(page)).toHaveText('完了');
        expect(await playableSeconds(page)).toBeCloseTo(3.5, 1);
    });
});

test.describe('変換', () => {
    test('WAV と MP3 を、変換元として選べる', async ({ page }) => {
        await openTool(page, '変換');
        const accept = (await page.locator('#conv-file').getAttribute('accept'))!.split(',');
        expect(accept).toContain('.wav');
        expect(accept).toContain('.mp3');
        expect(accept).toContain('.mp4');
    });

    test('WAV を MP3 に変換できる (ffmpeg が無ければ、その旨を出す)', async ({ page }) => {
        await openTool(page, '変換');
        await page.locator('#conv-file').setInputFiles(wavFile('e2e-conv.wav', 2));
        await field(page, '出力フォーマット').selectOption('mp3');
        await expect(field(page, 'ビットレート')).toHaveValue('192');
        const result = await run(page, '/api/convert/mp3', '変換を実行');
        if (result.status !== 200) {
            // ffmpeg が無い環境: 入れ方の案内を含むエラーが出る
            expect(result.status).toBe(400);
            await expect(status(page)).toHaveClass(/error/);
            await expect(status(page)).toContainText('ffmpeg が見つかりません');
            return;
        }
        await expect(status(page)).toHaveText('完了');
        await expect(page.locator('.result-area .result-label')).toHaveText('MP3 変換結果');
        // MP3 のフレーム同期 (0xFFEx) か ID3 タグで始まる
        const head = result.body.subarray(0, 3);
        expect(head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)).toBe(true);
        expect(await playableSeconds(page)).toBeGreaterThan(1.9);
        const download = page.waitForEvent('download');
        await page.locator('.result-area').getByText('ダウンロード').click();
        expect((await download).suggestedFilename()).toBe('e2e-conv.mp3');
    });

    test('WAV に変換すると、44.1kHz・ステレオの WAV になる (ffmpeg が無ければ、その旨を出す)', async ({ page }) => {
        await openTool(page, '変換');
        await page.locator('#conv-file').setInputFiles(wavFile('e2e-conv.wav', 2));
        // WAV のときは、ビットレートの欄は出ない
        await expect(field(page, 'ビットレート')).toHaveCount(0);
        const result = await run(page, '/api/convert/wav', '変換を実行');
        if (result.status !== 200) {
            expect(result.status).toBe(400);
            await expect(status(page)).toContainText('ffmpeg が見つかりません');
            return;
        }
        const wav = readWav(result.body);
        expect(wav.sampleRate).toBe(44100);
        expect(wav.channels).toBe(2);
        expect(wav.seconds).toBeCloseTo(2, 1);
    });
});

test.describe('解析', () => {
    test('音声ファイルを解析すると、基本情報と帯域の分布が見出し付きで出る', async ({ page }) => {
        await openTool(page, '解析');
        await page.getByRole('button', { name: '解析開始' }).click();
        await expect(status(page)).toHaveText('ファイルを選択してください');

        await page.locator('#da-file').setInputFiles(wavFile('e2e-analyze.wav', 4, [261.63, 392.0]));
        const waiting = page.waitForResponse((r) => r.url().endsWith('/api/deep-analyze'), { timeout: 60_000 });
        await page.getByRole('button', { name: '解析開始' }).click();
        expect((await waiting).status()).toBe(200);
        await expect(status(page)).toHaveText('解析完了');
        const report = page.locator('.result-area');
        // マークダウンの記号がそのまま見えていない (見出しと太字に直っている)
        await expect(report.locator('h3', { hasText: '基本情報' })).toBeVisible();
        await expect(report.locator('h3', { hasText: '周波数帯域エネルギー分布' })).toBeVisible();
        await expect(report).toContainText('長さ: 4.0 秒');
        await expect(report).toContainText('サンプルレート: 22050 Hz');
        await expect(report).not.toContainText('**');
        await expect(report).not.toContainText('##');
    });
});
