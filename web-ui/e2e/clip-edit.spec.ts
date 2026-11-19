/**
 * クリップを縮める・分割する・フェード (タイムライン)。
 *
 * - 左右の端をドラッグすると縮み、引き戻すと伸びる (音声の端より外へは伸びない。拍にそろう)
 * - 「再生位置で分割」で 2 つになる。再生位置がクリップの外なら押せず、理由が出る
 * - 上の角のつまみか、メニューの「フェード…」でフェードが付き、クリップに形が描かれる
 * - どれも 1 回の「元に戻す」で戻り、保存して開き直すと残り、書き出した WAV に入る
 * - キーボードだけで、分割 (S) とフェード (メニュー → 秒を打つ) ができる
 * - クリップに波形が出る。長い音声でも、描くのは見えている範囲だけ
 * - アシスタントに頼んでも、同じ処理で縮める・分ける・フェードを付ける (偽の Claude サーバ)
 */
import { expect, test, type APIRequestContext, type Download, type Page } from '@playwright/test';
import { makeWav, openDaw, openProject, openTab, saveProject, startFree, statusText, trackSummary } from './helpers';

/** タイムラインの縮尺 (1 秒 = 80px)。120 BPM の 1 拍は 0.5 秒 = 40px。 */
const PX_PER_SEC = 80;

const clips = (page: Page) => page.locator('#tracks-container .clip');
const tipOf = (page: Page, index = 0) => clips(page).nth(index).getAttribute('data-tip');
const undo = (page: Page) => page.getByRole('button', { name: '元に戻す', exact: true });

/** ファイルのタブから、先頭のトラックにクリップを足す (440 Hz の音が鳴り続ける WAV)。 */
async function addClip(page: Page, name: string, seconds: number, sampleRate = 22050) {
    await openTab(page, 'ファイル');
    const before = await clips(page).count();
    await page.locator('#file-import').setInputFiles({ name, mimeType: 'audio/wav', buffer: makeWav(seconds, [440], sampleRate) });
    await page.getByRole('button', { name: '選択したトラックに追加' }).click();
    await expect(clips(page)).toHaveCount(before + 1, { timeout: 60_000 });
}

/** 4 秒のクリップを 1 つ置いた状態で始める。 */
async function startWithClip(page: Page, seconds = 4) {
    await openDaw(page);
    await startFree(page);
    await addClip(page, 'take.wav', seconds);
}

/** クリップの中の部品 (端・フェードのつまみ) の真ん中を押して、横に `dx` だけ動かして離す。 */
async function dragPart(page: Page, selector: string, dx: number, options: { clip?: number; alt?: boolean } = {}) {
    const box = (await clips(page).nth(options.clip ?? 0).locator(selector).boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    if (options.alt) await page.keyboard.down('Alt');
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
    if (options.alt) await page.keyboard.up('Alt');
}

/** シークバーを押して、再生位置を曲の `fraction` (0〜1) のあたりへ移す。移った先の秒数を返す。 */
async function seekTo(page: Page, fraction: number): Promise<number> {
    const bar = (await page.locator('#seek-bar').boundingBox())!;
    await page.mouse.click(bar.x + bar.width * fraction, bar.y + bar.height / 2);
    const read = async () => { const [m, s] = ((await page.locator('#time-display').textContent()) ?? '0:0').split(':'); return Number(m) * 60 + Number(s); };
    await expect.poll(read).toBeGreaterThan(0);
    return read();
}

/**
 * 開いているメニューの中で、下矢印キーで、その名前の項目まで移る (押せない項目は、矢印キーでは飛ばされる)。
 */
async function focusMenuItem(page: Page, name: string) {
    const item = page.getByRole('menuitem', { name, exact: true });
    for (let i = 0; i < 6 && !(await item.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
    await expect(item).toBeFocused();
}

/**
 * クリップの波形の canvas の、1 点の色 (RGBA)。位置は、クリップの左上からの px。
 * canvas は見えている範囲にしか無いので、範囲の外なら null。
 */
function wavePixel(page: Page, index: number, x: number, y: number): Promise<number[] | null> {
    return clips(page).nth(index).locator('.clip-wave').evaluate((canvas: HTMLCanvasElement, [px, py]) => {
        const left = parseFloat(canvas.style.left) || 0, width = parseFloat(canvas.style.width) || 0;
        if (canvas.style.display === 'none' || px < left || px >= left + width) return null;
        const scale = canvas.width / width;
        return [...canvas.getContext('2d')!.getImageData(Math.round((px - left) * scale), Math.round(py * scale), 1, 1).data];
    }, [x, y]);
}

/** ダウンロードした WAV (16bit PCM) の、左チャンネルのサンプル (−1〜1) とサンプルレート。 */
async function wavSamples(file: Download): Promise<{ samples: Float32Array; sampleRate: number; seconds: number }> {
    const chunks: Buffer[] = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const channels = bytes.readUInt16LE(22), sampleRate = bytes.readUInt32LE(24);
    const frames = (bytes.length - 44) / 2 / channels;
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = bytes.readInt16LE(44 + i * 2 * channels) / 32768;
    return { samples, sampleRate, seconds: frames / sampleRate };
}

/** `[from, to)` 秒の、音の大きさ (二乗平均の平方根)。 */
function level(wav: { samples: Float32Array; sampleRate: number }, from: number, to: number): number {
    const a = Math.round(from * wav.sampleRate), b = Math.round(to * wav.sampleRate);
    let sum = 0;
    for (let i = a; i < b; i++) sum += wav.samples[i] * wav.samples[i];
    return Math.sqrt(sum / Math.max(1, b - a));
}

test('右の端をドラッグすると縮み、引き戻すと伸びる。拍にそろい、音声の端より外へは伸びない。元に戻せる', async ({ page }) => {
    await startWithClip(page);
    expect(await tipOf(page)).toContain('（0.0 秒から、長さ 4.0 秒）');
    // 右の端を 165px 左へ → 1.94 秒 → 拍 (0.5 秒) にそろって 2.0 秒
    await dragPart(page, '.clip-edge.right', -165);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /（0\.0 秒から、長さ 2\.0 秒）/);
    await expect(statusText(page)).toHaveText('クリップ「take.wav」を縮めました（0.0 秒から、長さ 2.0 秒）');
    expect(Math.round((await clips(page).first().boundingBox())!.width)).toBe(2 * PX_PER_SEC);
    await expect(page.locator('#btn-undo')).toHaveAttribute('data-tip', /クリップ「take\.wav」の長さを変更/);
    // 曲の長さも、見えている範囲の終わりまで
    await expect(page.locator('#seek-time-total')).toHaveText('0:02.0');

    // 引き戻す: 音声の終わり (4 秒) より外へは伸びない
    await dragPart(page, '.clip-edge.right', 600);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /（0\.0 秒から、長さ 4\.0 秒）/);
    await expect(statusText(page)).toHaveText('クリップ「take.wav」を伸ばしました（0.0 秒から、長さ 4.0 秒）');

    // 1 回のドラッグが、履歴 1 件。2 回戻すと、縮める前 (何もしていない状態) に戻る
    await page.keyboard.press('ControlOrMeta+z');
    await expect(clips(page).first()).toHaveAttribute('data-tip', /長さ 2\.0 秒/);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(clips(page).first()).toHaveAttribute('data-tip', /長さ 4\.0 秒/);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(clips(page).first()).toHaveAttribute('data-tip', /長さ 2\.0 秒/);
});

test('左の端を動かすと、音の位置は動かず、鳴らし始めだけが変わる。Option を押しているあいだは拍にそろえない', async ({ page }) => {
    await startWithClip(page);
    // 左の端を 85px 右へ → 1.06 秒 → 拍にそろって 1.0 秒。右の端 (4 秒) はそのまま
    await dragPart(page, '.clip-edge.left', 85);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /（1\.0 秒から、長さ 3\.0 秒）\n音声の 1 秒目から/);
    const box = (await clips(page).first().boundingBox())!;
    const wrap = (await page.locator('#tracks-container .track-canvas-wrap').first().boundingBox())!;
    expect(Math.round(box.x - wrap.x)).toBe(PX_PER_SEC);
    expect(Math.round(box.x + box.width - wrap.x)).toBe(4 * PX_PER_SEC);
    await expect(clips(page).first()).toHaveAttribute('aria-label', 'クリップ「take.wav」（「Track 1」、1.0 秒から、長さ 3.0 秒、音声の 1 秒目から）');

    // 音声の頭より前へは伸びない
    await dragPart(page, '.clip-edge.left', -400);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /（0\.0 秒から、長さ 4\.0 秒）\nドラッグ/);

    // Option (Alt) を押しているあいだは、拍にそろえない: 85px = 1.06 秒
    await dragPart(page, '.clip-edge.left', 85, { alt: true });
    await expect(clips(page).first()).toHaveAttribute('data-tip', /音声の 1\.06 秒目から/);

    // 既存の操作 (移動) は、端の内側をつかめばそのまま使える。縮めた範囲は、動かしても変わらない
    const now = (await clips(page).first().boundingBox())!;
    await page.mouse.move(now.x + 40, now.y + 30);
    await page.mouse.down();
    await page.mouse.move(now.x + 40 + 160, now.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect(clips(page).first()).toHaveAttribute('data-tip', /（3\.0 秒から、長さ 2\.9 秒）\n音声の 1\.06 秒目から/);
});

test('メニューの「再生位置で分割」で 2 つになる。再生位置がクリップの外なら押せず、理由が出る。元に戻せる', async ({ page }) => {
    await startWithClip(page);
    const first = (await clips(page).first().boundingBox())!;
    // 再生位置は 0 秒 (クリップの頭)。分割は押せない状態で、説明に理由が出る
    await page.mouse.click(first.x + 60, first.y + 30, { button: 'right' });
    const menu = page.getByRole('menu', { name: 'クリップ「take.wav」のメニュー' });
    await expect(menu.getByRole('menuitem')).toHaveText(['複製', '再生位置で分割', 'フェード…', '削除']);
    const split = menu.getByRole('menuitem', { name: '再生位置で分割' });
    await expect(split).toHaveAttribute('aria-disabled', 'true');
    await expect(split).toHaveAttribute('data-tip', /再生位置（0\.0 秒）が、このクリップの中（0\.0〜4\.0 秒）に在りません/);
    // 押すと、分けずに、理由が知らせとして出る (押せない項目なので、押せるようになるのを待たずに押す)
    await split.click({ force: true });
    await expect(clips(page)).toHaveCount(1);
    await expect(page.locator('#notice-region .notice-toast')).toContainText('このクリップの中（0.0〜4.0 秒）に在りません。分けたい場所へ再生位置を動かしてから、分割してください');
    // Esc で閉じる (WebKit は、ボタンを押してもフォーカスが移らないので、項目にフォーカスを置いてから押す)
    await menu.getByRole('menuitem', { name: '複製' }).focus();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // 再生位置を 2 秒のあたりへ移してから分割する
    const at = await seekTo(page, 0.5);
    await page.mouse.click(first.x + 60, first.y + 30, { button: 'right' });
    await expect(split).not.toHaveAttribute('aria-disabled', 'true');
    await split.click();
    await expect(clips(page)).toHaveCount(2);
    await expect(statusText(page)).toContainText('クリップ「take.wav」を、');
    await expect(statusText(page)).toContainText('秒の位置で 2 つに分けました');
    // 2 つは、同じ名前で、境目でつながっている (左は頭から、右は音声の途中から終わりまで)
    expect(await trackSummary(page)).toEqual([{ name: 'Track 1', clips: ['take.wav', 'take.wav'] }, { name: 'Track 2', clips: [] }]);
    const left = (await clips(page).nth(0).boundingBox())!, right = (await clips(page).nth(1).boundingBox())!;
    expect(Math.abs(left.x + left.width - right.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(left.width - at * PX_PER_SEC)).toBeLessThanOrEqual(8);
    expect(Math.round(left.width + right.width)).toBe(4 * PX_PER_SEC);
    expect(await tipOf(page, 1)).toMatch(/音声の [12](\.\d+)? 秒目から/);
    await expect(page.locator('#btn-undo')).toHaveAttribute('data-tip', /クリップ「take\.wav」を分割/);

    // 1 回の「元に戻す」で、1 つに戻る
    await undo(page).click();
    await expect(clips(page)).toHaveCount(1);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /（0\.0 秒から、長さ 4\.0 秒）/);
});

test('上の角のつまみをドラッグするとフェードが付き、クリップに形が描かれる。元に戻せる', async ({ page }) => {
    await startWithClip(page);
    // 波形が出ている (真ん中の高さに、音の山が描かれる)。上の端は、まだ何も描かれていない
    await expect.poll(async () => (await wavePixel(page, 0, 100, 25))?.[3] ?? 0).toBeGreaterThan(40);
    expect((await wavePixel(page, 0, 10, 5))![3]).toBe(0);

    // フェードインのつまみを 80px 右へ → 1 秒
    await dragPart(page, '.clip-fade.in', 80);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /フェードイン 1 秒/);
    await expect(statusText(page)).toHaveText('クリップ「take.wav」のフェード: フェードイン 1 秒、フェードアウト 0 秒');
    await expect(clips(page).first().locator('.clip-fade.in')).toHaveClass(/set/);
    // フェードの形: 音量が下がっているところ (左上の三角) が暗く塗られる
    const shaded = (await wavePixel(page, 0, 10, 5))!;
    expect(shaded[3]).toBeGreaterThan(60);
    expect(shaded[0]).toBeLessThan(40);
    // フェードの外 (1 秒より後ろ) の上の端は、塗られない
    expect((await wavePixel(page, 0, 120, 5))![3]).toBe(0);

    // フェードアウトのつまみを 120px 左へ → 1.5 秒
    await dragPart(page, '.clip-fade.out', -120);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /フェードイン 1 秒、フェードアウト 1\.5 秒/);
    expect((await wavePixel(page, 0, 4 * PX_PER_SEC - 10, 5))![3]).toBeGreaterThan(60);
    await expect(page.locator('#btn-undo')).toHaveAttribute('data-tip', /クリップ「take\.wav」のフェードを変更/);

    // 1 回のドラッグが、履歴 1 件
    await undo(page).click();
    await expect(clips(page).first()).toHaveAttribute('data-tip', /フェードイン 1 秒\n/);
    await undo(page).click();
    await expect(clips(page).first()).not.toHaveAttribute('data-tip', /フェードイン/);
    expect((await wavePixel(page, 0, 10, 5))![3]).toBe(0);
});

test('キーボードだけで、分割 (S) とフェード (メニューから秒を打つ) ができる', async ({ page }) => {
    await startWithClip(page);
    // 再生位置がクリップの頭に在るあいだは、S を押しても分けずに、理由を知らせる
    await clips(page).first().focus();
    await page.keyboard.press('s');
    await expect(clips(page)).toHaveCount(1);
    await expect(statusText(page)).toContainText('このクリップの中（0.0〜4.0 秒）に在りません');
    await expect(page.locator('#notice-region .notice-toast')).toContainText('分けたい場所へ再生位置を動かしてから、分割してください');

    // 再生位置を移して (シークバー)、クリップを選んで S
    await seekTo(page, 0.5);
    await clips(page).first().focus();
    await page.keyboard.press('s');
    await expect(clips(page)).toHaveCount(2);
    // 分けた後も、選んでいたクリップ (左) にフォーカスが残る
    await expect(clips(page).first()).toBeFocused();

    // フェード: メニュー (Shift+F10) → 「フェード…」→ 秒を打って Enter
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'クリップ「take.wav」のメニュー' });
    await expect(menu.getByRole('menuitem', { name: '複製' })).toBeFocused();
    await focusMenuItem(page, 'フェード…');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'クリップ「take.wav」のフェード' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('フェードイン（秒）')).toBeFocused();
    // 合計がクリップの長さを超えると、決めずに理由を出す
    await page.keyboard.type('9');
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('クリップの長さ');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('フェードイン（秒）').press('ControlOrMeta+a');
    await page.keyboard.type('0.5');
    // 次の欄へは、Tab で辿らずにフォーカスを置く (WebKit の Tab は、設定によって部品を飛ばす)
    await dialog.getByLabel('フェードアウト（秒）').focus();
    await page.keyboard.type('0.25');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /フェードイン 0\.5 秒、フェードアウト 0\.25 秒/);
    await expect(statusText(page)).toHaveText('クリップ「take.wav」のフェード: フェードイン 0.5 秒、フェードアウト 0.25 秒');
    // 窓を閉じると、クリップにフォーカスが戻る。もう片方のクリップには、フェードは付かない
    await expect(clips(page).first()).toBeFocused();
    expect(await tipOf(page, 1)).not.toMatch(/フェードイン|フェードアウト/);

    // 窓は Esc で、何も変えずに閉じる
    await page.keyboard.press('Shift+F10');
    await focusMenuItem(page, 'フェード…');
    await page.keyboard.press('Enter');
    await expect(dialog.getByLabel('フェードイン（秒）')).toHaveValue('0.5');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(clips(page).first()).toBeFocused();

    // 元に戻す: フェード → 分割 の順に、1 つずつ戻る
    await page.keyboard.press('ControlOrMeta+z');
    await expect(clips(page).first()).not.toHaveAttribute('data-tip', /フェードイン/);
    await expect(clips(page)).toHaveCount(2);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(clips(page)).toHaveCount(1);
});

test('縮めた範囲・分割・フェードは、保存して開き直しても残る。分割した 2 つの音声は、1 つだけ保存される', async ({ page }, testInfo) => {
    await startWithClip(page);
    // 頭を 1 秒縮め、フェードインを 0.5 秒付けてから、2 つに分ける
    await dragPart(page, '.clip-edge.left', 85);
    await dragPart(page, '.clip-fade.in', 40);
    await seekTo(page, 0.6);
    await clips(page).first().focus();
    await page.keyboard.press('s');
    await expect(clips(page)).toHaveCount(2);
    await dragPart(page, '.clip-fade.out', -80, { clip: 1 });
    const before = [await tipOf(page, 0), await tipOf(page, 1)];
    expect(before[0]).toMatch(/（1\.0 秒から、長さ .+ 秒）\n音声の 1 秒目から、フェードイン 0\.5 秒/);
    expect(before[1]).toMatch(/フェードアウト 1 秒/);
    await testInfo.attach('clips-edited', { body: await page.screenshot(), contentType: 'image/png' });

    // 保存する。2 つのクリップは同じ音声を指すので、入る音声は 1 つ
    const saved = page.waitForResponse((r) => r.url().includes('/api/project/document') && r.request().method() === 'POST');
    const name = await saveProject(page, `クリップの編集-${testInfo.project.name}-${Date.now()}`);
    expect(((await (await saved).json()) as { audio_count: number }).audio_count).toBe(1);

    await page.reload();
    await page.getByText('準備完了').waitFor();
    await openProject(page, name);
    await expect(clips(page)).toHaveCount(2);
    expect([await tipOf(page, 0), await tipOf(page, 1)]).toEqual(before);
    await expect(page.getByRole('region', { name: '音声の無いクリップ' })).toHaveCount(0);
    // 開き直した後も、縮めたぶんは引き戻せる (音声は丸ごと入っている)
    await dragPart(page, '.clip-edge.left', -400);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /（0\.0 秒から/);
});

test('書き出した WAV に、縮めた範囲とフェードが入る', async ({ page }) => {
    await startWithClip(page);
    const exportWav = async () => {
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
        return wavSamples(await download);
    };
    // 何もしていないクリップ: 頭から終わりまで、同じ大きさで鳴る
    const plain = await exportWav();
    expect(plain.seconds).toBeCloseTo(4, 1);
    const full = level(plain, 1.5, 2.5);
    expect(full).toBeGreaterThan(0.1);
    expect(level(plain, 0.2, 0.8)).toBeGreaterThan(full * 0.9);

    // 頭を 1 秒・終わりを 1 秒縮め (1〜3 秒だけが鳴る)、フェードインを 1 秒付ける
    await dragPart(page, '.clip-edge.left', 85);
    await dragPart(page, '.clip-edge.right', -85);
    await dragPart(page, '.clip-fade.in', 80);
    await expect(clips(page).first()).toHaveAttribute('data-tip', /（1\.0 秒から、長さ 2\.0 秒）\n音声の 1 秒目から、フェードイン 1 秒/);
    const edited = await exportWav();
    // 長さは、見えている範囲の終わり (3 秒) まで。縮めた頭 (0〜1 秒) は無音
    expect(edited.seconds).toBeCloseTo(3, 1);
    expect(level(edited, 0.1, 0.9)).toBeLessThan(0.002);
    // フェードイン (1〜2 秒): だんだん大きくなる。2 秒より後ろは、元の大きさ
    const quiet = level(edited, 1.05, 1.25), mid = level(edited, 1.4, 1.6), loud = level(edited, 2.2, 2.8);
    expect(quiet).toBeLessThan(full * 0.3);
    expect(mid).toBeGreaterThan(full * 0.35);
    expect(mid).toBeLessThan(full * 0.65);
    expect(loud).toBeGreaterThan(full * 0.9);
    expect(loud).toBeLessThan(full * 1.1);
});

test('長い音声 (5 分) のクリップにも波形が出る。描くのは見えている範囲だけで、スクロールすると描き足す', async ({ page }) => {
    await openDaw(page);
    await startFree(page);
    await addClip(page, 'five-min.wav', 300, 8000);
    const clipWidth = (await clips(page).first().boundingBox())!.width;
    expect(Math.round(clipWidth)).toBe(300 * PX_PER_SEC);
    const canvas = clips(page).first().locator('.clip-wave');
    const viewport = page.viewportSize()!.width;
    // 山の値は少しずつ作られ、できたら波形が出る。そのあいだも、画面は操作できる
    await page.getByRole('button', { name: '+ トラック追加' }).click();
    await expect(page.locator('#tracks-container .track-row')).toHaveCount(3);
    await expect.poll(async () => (await wavePixel(page, 0, 200, 25))?.[3] ?? 0, { timeout: 30_000 }).toBeGreaterThan(40);
    // canvas は、曲全体の幅ではなく、見えている範囲 (と左右の余白) の幅
    const width = () => canvas.evaluate((el: HTMLCanvasElement) => parseFloat(el.style.width));
    expect(await width()).toBeLessThan(viewport + 2 * 240 + 1);
    // 見えていない先には、まだ描いていない
    expect(await wavePixel(page, 0, 6000, 25)).toBeNull();

    // スクロールすると、その先を描き足す
    await page.locator('#timeline-area').evaluate((el) => { el.scrollLeft = 6000; });
    await expect.poll(async () => (await wavePixel(page, 0, 6200, 25))?.[3] ?? 0).toBeGreaterThan(40);
    expect(await width()).toBeLessThan(viewport + 2 * 240 + 1);
    expect(await canvas.evaluate((el: HTMLCanvasElement) => parseFloat(el.style.left))).toBeGreaterThan(5000);
});

test.describe('アシスタント', () => {
    test.skip(Boolean(process.env.BUNRI_E2E_LLM), '偽の Claude サーバを相手にするテスト。本物を呼ぶ BUNRI_E2E_LLM=1 のときは走らせない');

    /*
     * アシスタントの依頼は、1 日の上限 (既定 20 回) に数える。データ置き場はほかのテストと共用なので、
     * 始める前に上限を上げ、終わったら、このファイルで使った回数のぶんだけ上げたままにして戻す (assistant.spec.ts と同じ)。
     */
    const HEADROOM = 50;
    let callsBefore = 0;
    let raised = false;
    const guideSettings = async (request: APIRequestContext) => (await request.get('/api/settings/guide')).json();
    test.beforeAll(async ({ request }) => {
        const now = await guideSettings(request);
        callsBefore = now.today.calls;
        const limit = now.settings.daily_limit_calls;
        raised = limit !== null;
        if (raised) await request.post('/api/settings/guide', { data: { daily_limit_calls: limit + HEADROOM } });
    });
    test.afterAll(async ({ request }) => {
        if (!raised) return;
        const now = await guideSettings(request);
        const limit = now.settings.daily_limit_calls;
        if (limit !== null) await request.post('/api/settings/guide', { data: { daily_limit_calls: limit - HEADROOM + (now.today.calls - callsBefore) } });
    });

    test('頼むと、クリップを縮めて、分けて、フェードを付ける。1 回の「元に戻す」で、まとめて戻る', async ({ page }) => {
        await startWithClip(page);
        await page.getByRole('button', { name: 'アシスタント', exact: true }).click();
        const dock = page.getByRole('complementary', { name: 'アシスタント' });
        const chat = dock.getByRole('log', { name: '会話と操作ログ' });
        const input = dock.getByRole('textbox', { name: 'アシスタントに頼むこと' });
        await input.fill('クリップを短くして、分けて、頭をなだらかにして');
        await input.press('Enter');
        await expect(chat.locator('.assistant-turn')).toHaveCount(1, { timeout: 30_000 });

        // 操作ログ: 読む 1 行 + 変える 3 行。どれも成功
        const rows = chat.locator('.assistant-tool');
        await expect(rows).toHaveCount(4);
        await expect(rows.nth(1)).toContainText('クリップ「take.wav」を縮めました（0〜1.5 秒。Track 1）');
        await expect(rows.nth(2)).toContainText('クリップ「take.wav」を、1 秒で 2 つに分けました（Track 1）');
        await expect(rows.nth(3)).toContainText('クリップ「take.wav」にフェードを付けました（フェードイン 0.25 秒、フェードアウト 0 秒。Track 1）');
        // 画面も、そのとおりに変わっている
        await expect(clips(page)).toHaveCount(2);
        expect(await tipOf(page, 0)).toMatch(/（0\.0 秒から、長さ 1\.0 秒）\nフェードイン 0\.25 秒/);
        expect(await tipOf(page, 1)).toMatch(/（1\.0 秒から、長さ 0\.5 秒）\n音声の 1 秒目から/);

        // 1 回の依頼で変えたことは、1 回の「元に戻す」で戻る
        await chat.getByRole('button', { name: 'この依頼の変更を元に戻す' }).click();
        await expect(clips(page)).toHaveCount(1);
        await expect(clips(page).first()).toHaveAttribute('data-tip', /（0\.0 秒から、長さ 4\.0 秒）\nドラッグ/);
    });
});
