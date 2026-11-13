/**
 * 元に戻す / やり直す、消す操作の「元に戻す」付きの知らせ、トラックの音量とパン、
 * ピアノロールの複数選択・矢印キー・コピーと貼り付け・表示の大きさ。
 */
import { expect, test, type Download, type Page } from '@playwright/test';
import { deleteTrack, openDaw, openProject, readWav, saveProject, startFree, statusText } from './helpers';

const STEP_WIDTH = 20;
const NOTE_HEIGHT = 14;

const notes = (page: Page) => page.locator('#note-layer .note-block');
const selected = (page: Page) => page.locator('#note-layer .note-block.selected');
const undoButton = (page: Page) => page.getByRole('button', { name: '元に戻す', exact: true }).first();
const redoButton = (page: Page) => page.getByRole('button', { name: 'やり直す', exact: true });
const trackNames = async (page: Page) => page.locator('#tracks-container .track-row').evaluateAll((rows) =>
    rows.map((row) => (row.querySelector('.track-name')?.firstChild?.textContent ?? '').trim()));

/** 置かれたノートの説明 (例: "C4 step:8 len:4") を全部返す。 */
const noteTitles = (page: Page) => notes(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).title));
const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiOf(title: string): number {
    const [, name, octave] = title.match(/^([A-G]#?)(-?\d+) /)!;
    return (Number(octave) + 1) * 12 + CHROMATIC.indexOf(name);
}
const stepOf = (title: string) => Number(title.match(/step:(\d+)/)![1]);

async function openPianoRoll(page: Page) {
    await openDaw(page);
    await startFree(page);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');
}

/** 見えている範囲の (x, y) をダブルクリックして、ノートを 1 つ置く。 */
async function placeNote(page: Page, x: number, y: number) {
    const before = await notes(page).count();
    const wrap = (await page.locator('#piano-grid-wrap').boundingBox())!;
    await page.mouse.dblclick(wrap.x + x, wrap.y + y);
    await expect(notes(page)).toHaveCount(before + 1);
}

/** ノートをつかんで、(dx, dy) だけ動かす。 */
async function dragNote(page: Page, index: number, dx: number, dy: number) {
    const box = (await notes(page).nth(index).boundingBox())!;
    const x = box.x + 6, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
}

/** 見えている範囲の 2 点で囲んで選ぶ (何も無いところから押し始める)。 */
async function band(page: Page, from: [number, number], to: [number, number]) {
    const wrap = (await page.locator('#piano-grid-wrap').boundingBox())!;
    await page.mouse.move(wrap.x + from[0], wrap.y + from[1]);
    await page.mouse.down();
    await page.mouse.move(wrap.x + to[0], wrap.y + to[1], { steps: 6 });
    await page.mouse.up();
}

async function downloadBytes(file: Download): Promise<Buffer> {
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
}

async function exportPeak(page: Page): Promise<number> {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'WAV 書き出し', exact: true }).click();
    return readWav(await downloadBytes(await download)).peak;
}

test.describe('元に戻す / やり直す', () => {
    test('ノートの追加・移動・削除を、Cmd+Z で元に戻し、Cmd+Shift+Z とボタンでやり直せる。ボタンの説明に何を戻すかが出る', async ({ page }) => {
        await openPianoRoll(page);
        // トラックを作った操作も戻せる
        await page.keyboard.press('ControlOrMeta+z');
        await expect(page.locator('#tracks-container .track-row')).toHaveCount(1);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(page.locator('#tracks-container .track-row')).toHaveCount(2);
        await page.locator('#tracks-container .track-name').first().click();

        await placeNote(page, 30, 100);
        await expect(undoButton(page)).toBeEnabled();
        await expect(undoButton(page)).toHaveAttribute('title', /元に戻す: ノートを追加/);
        const placed = (await noteTitles(page))[0];
        await dragNote(page, 0, 4 * STEP_WIDTH, 0);
        expect(stepOf((await noteTitles(page))[0])).toBe(4);
        await expect(undoButton(page)).toHaveAttribute('title', /ノートを移動/);
        await notes(page).first().click();
        await page.keyboard.press('Delete');
        await expect(notes(page)).toHaveCount(0);
        await expect(undoButton(page)).toHaveAttribute('title', /ノートを削除/);

        // 1 つずつ戻る
        await page.keyboard.press('ControlOrMeta+z');
        await expect(notes(page)).toHaveCount(1);
        expect(stepOf((await noteTitles(page))[0])).toBe(4);
        await expect(statusText(page)).toHaveText('元に戻しました（ノートを削除）');
        await page.keyboard.press('ControlOrMeta+z');
        expect(await noteTitles(page)).toEqual([placed]);
        await undoButton(page).click();
        await expect(notes(page)).toHaveCount(0);
        // トラックの見出しのノートの数も戻る
        await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveCount(0);

        // やり直す (ボタンとキー)
        await expect(redoButton(page)).toHaveAttribute('title', /やり直す: ノートを追加/);
        await redoButton(page).click();
        expect(await noteTitles(page)).toEqual([placed]);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        expect(stepOf((await noteTitles(page))[0])).toBe(4);

        // 戻した後に新しい操作をすると、やり直せなくなる
        await page.keyboard.press('ControlOrMeta+z');
        await placeNote(page, 130, 60);
        await expect(redoButton(page)).toBeDisabled();
        await expect(redoButton(page)).toHaveAttribute('title', 'やり直せる操作はありません');
    });

    test('文字を打ち込む欄の中の Cmd+Z は、その欄の文字を戻すだけで、アプリの「元に戻す」は動かない', async ({ page }) => {
        await openPianoRoll(page);
        await placeNote(page, 30, 100);
        const bpm = page.getByLabel('BPM', { exact: true });
        await bpm.fill('90');
        await bpm.press('ControlOrMeta+z');
        await bpm.press('ControlOrMeta+Shift+z');
        await expect(notes(page)).toHaveCount(1);
        await expect(undoButton(page)).toHaveAttribute('title', /ノートを追加/);

        // トラック名の入力欄でも同じ
        await page.getByRole('button', { name: '「Track 1」のメニュー' }).click();
        await page.getByRole('menuitem', { name: '名前を変更' }).click();
        const input = page.getByRole('textbox', { name: '「Track 1」の新しい名前' });
        await expect(input).toBeFocused();
        await input.fill('Lead');
        await input.press('ControlOrMeta+z');
        await expect(notes(page)).toHaveCount(1);
        await expect(input).toBeVisible();
        await input.fill('Lead');
        await input.press('Enter');
        expect(await trackNames(page)).toEqual(['Lead', 'Track 2']);
        // ピアノロールの見出しの名前も変わる
        await expect(page.locator('#piano-roll-area .area-label')).toContainText('Lead');
        await page.keyboard.press('ControlOrMeta+z');
        expect(await trackNames(page)).toEqual(['Track 1', 'Track 2']);
        await expect(notes(page)).toHaveCount(1);
    });

    test('トラックの並びの変更・ミュート・ソロも元に戻せる', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        await page.getByRole('button', { name: '「Track 2」のメニュー' }).click();
        // いちばん下のトラックは、下へ移動できない
        await expect(page.getByRole('menuitem', { name: '下へ移動' })).toHaveAttribute('aria-disabled', 'true');
        await page.getByRole('menuitem', { name: '上へ移動' }).click();
        expect(await trackNames(page)).toEqual(['Track 2', 'Track 1']);
        // メニューを閉じたら、開いたボタンにフォーカスが戻る
        await expect(page.getByRole('button', { name: '「Track 2」のメニュー' })).toBeFocused();
        await page.getByRole('button', { name: '「Track 1」をミュート' }).click();
        await page.getByRole('button', { name: '「Track 2」をソロ' }).click();
        await expect(undoButton(page)).toHaveAttribute('title', /「Track 2」をソロ/);
        await undoButton(page).click();
        await expect(page.getByRole('button', { name: '「Track 2」をソロ' })).toHaveAttribute('aria-pressed', 'false');
        await undoButton(page).click();
        await expect(page.getByRole('button', { name: '「Track 1」をミュート' })).toHaveAttribute('aria-pressed', 'false');
        await undoButton(page).click();
        expect(await trackNames(page)).toEqual(['Track 1', 'Track 2']);
    });
});

test.describe('消す操作', () => {
    test('トラックを消すと、確かめの窓は出ずに「元に戻す」付きの知らせが出る。押すとノートごと戻る', async ({ page }) => {
        const dialogs: string[] = [];
        page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
        await openDaw(page);
        await startFree(page);
        await page.locator('#tracks-container .track-name').nth(1).click();
        await placeNote(page, 30, 100);
        await placeNote(page, 130, 60);

        await deleteTrack(page, 'Track 2');
        expect(await trackNames(page)).toEqual(['Track 1']);
        expect(dialogs).toEqual([]);
        const toast = page.locator('#undo-toast-region');
        await expect(toast).toHaveAttribute('role', 'status');
        await expect(toast).toContainText('「Track 2」を削除しました');
        await toast.getByRole('button', { name: '元に戻す' }).click();
        expect(await trackNames(page)).toEqual(['Track 1', 'Track 2']);
        await expect(page.locator('#tracks-container .track-row').nth(1).locator('.notes-badge')).toHaveText('2');
        await expect(toast.locator('.undo-toast')).toHaveCount(0);

        // Cmd+Z でも戻せる。別の操作をしたら、知らせは閉じる (押すと、その別の操作が戻ってしまうため)
        await deleteTrack(page, 'Track 2');
        await page.keyboard.press('ControlOrMeta+z');
        expect(await trackNames(page)).toEqual(['Track 1', 'Track 2']);
        await deleteTrack(page, 'Track 2');
        await expect(toast).toContainText('「Track 2」を削除しました');
        await page.getByRole('button', { name: '+ トラック追加' }).click();
        await expect(toast.locator('.undo-toast')).toHaveCount(0);
    });
});

test.describe('トラックの音量とパン', () => {
    test('つまみは読み上げで値が分かり、キーボードで動かせ、ダブルクリックで戻る。動かし続けたぶんは 1 回で元に戻る', async ({ page }) => {
        await openDaw(page);
        await startFree(page);
        const gain = page.getByRole('slider', { name: '「Track 1」の音量' });
        const pan = page.getByRole('slider', { name: '「Track 1」のパン' });
        const row = page.locator('#tracks-container .track-row').first();
        await expect(gain).toHaveAttribute('aria-valuetext', '0.0 dB');
        await expect(pan).toHaveAttribute('aria-valuetext', '中央');

        await gain.focus();
        for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
        await expect(gain).toHaveAttribute('aria-valuetext', '−6.0 dB');
        await expect(row.locator('.gain-readout')).toHaveText('−6.0 dB');
        await pan.focus();
        for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
        await expect(pan).toHaveAttribute('aria-valuetext', '左 30');
        await expect(row.locator('.pan-readout')).toHaveText('左 30');
        // つまみを触っても、ピアノロールは開かない (行が描き直されて、つまみのドラッグが途切れないように)
        await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 1');

        await gain.dblclick();
        await expect(gain).toHaveAttribute('aria-valuetext', '0.0 dB');

        // ダブルクリックで戻した → パン → 音量 (キーで 12 回動かしたぶん) の順に、1 回ずつ戻る
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.keyboard.press('ControlOrMeta+z');
        await expect(gain).toHaveAttribute('aria-valuetext', '−6.0 dB');
        await page.keyboard.press('ControlOrMeta+z');
        await expect(pan).toHaveAttribute('aria-valuetext', '中央');
        await page.keyboard.press('ControlOrMeta+z');
        await expect(gain).toHaveAttribute('aria-valuetext', '0.0 dB');
    });

    test('音量を下げると書き出した WAV が小さくなる。音量とパンは保存して読み込んでも残る', async ({ page }) => {
        await openDaw(page);
        await startFree(page, 1);
        await page.locator('#tracks-container .track-name').first().click();
        await placeNote(page, 30, 100);
        const loud = await exportPeak(page);
        expect(loud).toBeGreaterThan(0.05);

        await page.getByRole('slider', { name: '「Track 1」の音量' }).fill('-20');
        await expect(page.getByRole('slider', { name: '「Track 1」の音量' })).toHaveAttribute('aria-valuetext', '−20.0 dB');
        const quiet = await exportPeak(page);
        // −20 dB = 1/10
        expect(quiet / loud).toBeGreaterThan(0.08);
        expect(quiet / loud).toBeLessThan(0.12);

        await page.getByRole('slider', { name: '「Track 1」のパン' }).fill('-50');
        const name = await saveProject(page, `undo-mix-${Date.now()}`);

        await page.reload();
        await page.getByText('準備完了').waitFor();
        await openProject(page, name);
        await expect(page.getByRole('slider', { name: '「Track 1」の音量' })).toHaveAttribute('aria-valuetext', '−20.0 dB');
        await expect(page.getByRole('slider', { name: '「Track 1」のパン' })).toHaveAttribute('aria-valuetext', '左 50');
        // 開くと新しい文書になるので、元に戻すの履歴は空 (開く前のプロジェクトに戻さない。
        // 戻したいときは「開く」で前のプロジェクトを開く)
        await expect(page.locator('#btn-undo')).toBeDisabled();
        await page.keyboard.press('ControlOrMeta+z');
        await expect(page.locator('#tracks-container .track-row')).toHaveCount(1);
    });
});

test.describe('ピアノロールの複数選択', () => {
    test('囲んで選ぶ・Shift+クリック・Cmd+A。矢印キーで動かし (←→ は刻み、↑↓ は半音、Shift で 1 オクターブ)、まとめて元に戻せる', async ({ page }) => {
        await openPianoRoll(page);
        await placeNote(page, 30, 60);
        await placeNote(page, 110, 74);
        await placeNote(page, 190, 88);
        const original = await noteTitles(page);

        // 何も無いところから囲むと、掛かったノートが選ばれる (横は 2 つ目のノートの途中まで)
        await band(page, [5, 40], [150, 110]);
        await expect(selected(page)).toHaveCount(2);
        // Shift+クリックで足す・外す
        await notes(page).nth(2).click({ modifiers: ['Shift'] });
        await expect(selected(page)).toHaveCount(3);
        await notes(page).nth(0).click({ modifiers: ['Shift'] });
        await expect(selected(page)).toHaveCount(2);
        // 何も無いところを押すと、選択が外れる
        const wrap = (await page.locator('#piano-grid-wrap').boundingBox())!;
        await page.mouse.click(wrap.x + 400, wrap.y + 150);
        await expect(selected(page)).toHaveCount(0);
        // Cmd+A で全部 (ピアノロールにフォーカスがあるとき)
        await page.keyboard.press('ControlOrMeta+a');
        await expect(selected(page)).toHaveCount(3);

        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Shift+ArrowUp');
        await page.keyboard.press('ArrowRight');
        const moved = await noteTitles(page);
        moved.forEach((title, i) => {
            expect(midiOf(title)).toBe(midiOf(original[i]) + 13);
            expect(stepOf(title)).toBe(stepOf(original[i]) + 4);
        });
        // 選んだまま (続けて動かせる)
        await expect(selected(page)).toHaveCount(3);

        // 横に動かしたぶん → 高さを変えたぶん (続けて押したキーは 1 つにまとまる) の順に戻る
        await page.keyboard.press('ControlOrMeta+z');
        (await noteTitles(page)).forEach((title, i) => {
            expect(stepOf(title)).toBe(stepOf(original[i]));
            expect(midiOf(title)).toBe(midiOf(original[i]) + 13);
        });
        await page.keyboard.press('ControlOrMeta+z');
        expect(await noteTitles(page)).toEqual(original);

        // Esc で選択を外す
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Escape');
        await expect(selected(page)).toHaveCount(0);
    });

    test('選んだノートをまとめてドラッグで動かし、まとめて消せる', async ({ page }) => {
        await openPianoRoll(page);
        await placeNote(page, 30, 60);
        await placeNote(page, 110, 74);
        const original = await noteTitles(page);
        await page.keyboard.press('ControlOrMeta+a');
        await dragNote(page, 1, 8 * STEP_WIDTH, 2 * NOTE_HEIGHT);
        (await noteTitles(page)).forEach((title, i) => {
            expect(stepOf(title)).toBe(stepOf(original[i]) + 8);
            expect(midiOf(title)).toBe(midiOf(original[i]) - 2);
        });
        await page.keyboard.press('Backspace');
        await expect(notes(page)).toHaveCount(0);
        await page.keyboard.press('ControlOrMeta+z');
        await expect(notes(page)).toHaveCount(2);
        await page.keyboard.press('ControlOrMeta+z');
        expect(await noteTitles(page)).toEqual(original);
    });

    test('コピー・切り取り・貼り付け (再生位置へ)・複製 (すぐ後ろへ)。どれも元に戻せる', async ({ page }) => {
        await openPianoRoll(page);
        await placeNote(page, 30, 60);
        await placeNote(page, 110, 74);
        await placeNote(page, 190, 88);
        const steps = async () => (await noteTitles(page)).map(stepOf).sort((a, b) => a - b);
        expect(await steps()).toEqual([0, 4, 8]);

        // 複製: 選んだノートの長さ (0〜12 ステップ) の先へ置き、置いたほうを選ぶ
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('ControlOrMeta+d');
        expect(await steps()).toEqual([0, 4, 8, 12, 16, 20]);
        await expect(selected(page)).toHaveCount(3);
        await expect(statusText(page)).toHaveText('3 ノートを複製しました');

        // コピーして、再生位置 (曲の終わり = 24 ステップ = 3 秒) へ貼り付ける
        await page.keyboard.press('ControlOrMeta+c');
        await expect(statusText(page)).toHaveText('3 ノートをコピーしました');
        await page.locator('#seek-bar').focus();
        await page.keyboard.press('End');
        await expect(page.locator('#time-display')).toHaveText('0:03.0');
        await page.locator('#piano-grid-wrap').focus();
        await page.keyboard.press('ControlOrMeta+v');
        expect(await steps()).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32]);
        await expect(selected(page)).toHaveCount(3);

        // 切り取り: 選んでいる (貼り付けた) ノートが消える
        await page.keyboard.press('ControlOrMeta+x');
        expect(await steps()).toEqual([0, 4, 8, 12, 16, 20]);
        await page.keyboard.press('ControlOrMeta+z');
        expect((await steps()).length).toBe(9);
        await page.keyboard.press('ControlOrMeta+z');
        await page.keyboard.press('ControlOrMeta+z');
        expect(await steps()).toEqual([0, 4, 8]);

        // 別のトラックへも貼り付けられる
        await page.locator('#tracks-container .track-name').nth(1).click();
        await page.locator('#piano-grid-wrap').focus();
        await page.keyboard.press('ControlOrMeta+v');
        await expect(notes(page)).toHaveCount(3);
    });

    test('Cmd+A は、ピアノロールにフォーカスが無いときはノートを選ばない', async ({ page }) => {
        await openPianoRoll(page);
        await placeNote(page, 30, 60);
        await page.getByRole('button', { name: '+ トラック追加' }).focus();
        await page.keyboard.press('ControlOrMeta+a');
        await expect(selected(page)).toHaveCount(0);
    });
});

test.describe('ピアノロールの表示の大きさ', () => {
    /**
     * グリッドの canvas の、指定した行に描かれた小節の線の位置 (canvas の左端からの px)。
     * 小節の線は白の 25%、拍の線は 10% で描いているので、透明度で見分ける。
     */
    const gridBarLines = (page: Page) => page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('#piano-grid-canvas')!;
        const area = canvas.getBoundingClientRect();
        // 見えている白鍵の行の真ん中 (黒鍵の行は塗ってあるので避ける。行の境目の横線も避ける)
        const keys = [...document.querySelectorAll('#piano-keys .piano-key:not(.black)')]
            .map((k) => k.getBoundingClientRect()).filter((r) => r.top >= area.top && r.bottom <= area.bottom);
        const key = keys[Math.floor(keys.length / 2)];
        const y = Math.round(key.top + key.height / 2 - area.top);
        const data = canvas.getContext('2d')!.getImageData(0, y, canvas.width, 1).data;
        const xs: number[] = [];
        // 線は画素の境目に引くので、隣り合う 2 つの画素に半分ずつ描かれる (小節の線は 32 前後、拍の線は 13 前後)
        for (let x = 0; x < canvas.width; x++) if (data[x * 4 + 3] > 24) xs.push(x);
        return xs;
    });

    test('横・縦に広げても、ノートはグリッドの線とそろったまま。Cmd+ホイールでも変えられる', async ({ page }) => {
        await openPianoRoll(page);
        // 1 小節目の頭 (ステップ 0) と、2 小節目の頭 (ステップ 16) に置く
        await placeNote(page, 10, 100);
        await placeNote(page, 16 * STEP_WIDTH + 10, 100);
        const before = await noteTitles(page);

        const check = async (stepWidth: number, noteHeight: number) => {
            await expect.poll(() => page.locator('#note-layer').evaluate((el) => el.getBoundingClientRect().width)).toBe(128 * stepWidth);
            const layer = (await page.locator('#note-layer').boundingBox())!;
            const second = (await notes(page).nth(1).boundingBox())!;
            expect(Math.round(second.x - layer.x)).toBe(16 * stepWidth);
            expect(Math.round(second.height)).toBe(noteHeight - 1);
            // グリッドの小節の線 (canvas) が、ノートの左端と同じ位置に在る (スクロールすると描き直すので、待つ)
            await page.locator('#piano-grid-wrap').evaluate((el) => { el.scrollLeft = 0; });
            await expect.poll(async () => {
                const canvas = (await page.locator('#piano-grid-canvas').boundingBox())!;
                const xs = [(await notes(page).nth(0).boundingBox())!.x - canvas.x, (await notes(page).nth(1).boundingBox())!.x - canvas.x];
                const lines = await gridBarLines(page);
                return xs.every((x) => lines.some((l) => Math.abs(l - x) <= 1));
            }).toBe(true);
            // 鍵盤の行の高さも同じだけ変わる
            const key = (await page.locator('#piano-keys .piano-key').first().boundingBox())!;
            expect(Math.round(key.height)).toBe(noteHeight);
        };

        await check(20, 14);
        await page.getByRole('button', { name: '横に広げる' }).click();
        // 曲の頭を見ているときは、広げても 1 小節目が左へ逃げない
        expect(await page.locator('#piano-grid-wrap').evaluate((el) => el.scrollLeft)).toBe(0);
        await check(24, 14);
        await page.getByRole('button', { name: '縦に広げる' }).click();
        await check(24, 17);
        await page.getByRole('button', { name: '横に縮める' }).click();
        await page.getByRole('button', { name: '横に縮める' }).click();
        await check(15, 17);
        // ノートそのもの (位置と長さ) は変わらない
        expect(await noteTitles(page)).toEqual(before);

        // Cmd (Ctrl) + ホイールで広げる
        const wrap = (await page.locator('#piano-grid-wrap').boundingBox())!;
        await page.mouse.move(wrap.x + 100, wrap.y + 100);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -120);
        await page.keyboard.up('Control');
        await check(20, 17);

        // いちばん小さくすると、それ以上は縮められない
        for (let i = 0; i < 12; i++) {
            const out = page.getByRole('button', { name: '横に縮める' });
            if (await out.isDisabled()) break;
            await out.click();
        }
        await expect(page.getByRole('button', { name: '横に縮める' })).toBeDisabled();
        await check(5, 17);
    });
});

test.describe('ノートの強さを元に戻す', () => {
    const velocities = (page: Page) => noteTitles(page).then((titles) => titles.map((t) => t.match(/強さ:(\d+)$/)?.[1] ?? null));

    test('強さの変更は元に戻せ、やり直せる。続けて押した Option+↑ は 1 つの記録にまとまる', async ({ page }) => {
        await openPianoRoll(page);
        await placeNote(page, 30, 60);
        await placeNote(page, 110, 60);
        await page.keyboard.press('ControlOrMeta+a');
        await expect(selected(page)).toHaveCount(2);

        await page.locator('#velocity-input').fill('50');
        await page.locator('#velocity-input').press('Enter');
        expect(await velocities(page)).toEqual(['50', '50']);
        await expect(undoButton(page)).toHaveAttribute('title', /2 ノートの強さを変更/);

        await page.locator('#piano-grid-wrap').focus();
        for (let i = 0; i < 3; i++) await page.keyboard.press('Alt+ArrowUp');
        expect(await velocities(page)).toEqual(['80', '80']);

        // 続けて押したぶんが 1 つ戻り、次で、強さを持たない元の状態に戻る
        await page.keyboard.press('ControlOrMeta+z');
        expect(await velocities(page)).toEqual(['50', '50']);
        await page.keyboard.press('ControlOrMeta+z');
        expect(await velocities(page)).toEqual([null, null]);

        await redoButton(page).click();
        expect(await velocities(page)).toEqual(['50', '50']);
    });
});
