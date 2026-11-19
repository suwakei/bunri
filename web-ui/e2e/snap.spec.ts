/**
 * 刻み（ノートを置く・動かすときに吸い付く間隔）とスウィング: 三連・32 分の位置にノートを置ける。
 *
 * - ピアノロールの見出しの「刻み」で 8 分の三連を選ぶと、三連の位置に置け、矢印キーで三連 1 つぶん動き、
 *   動かす・伸ばす・複製する・貼るも三連に合う
 * - 選んだ刻みは、開き直しても覚えている（ふつうのトラックとドラムのトラックで別々。ドラムの既定は 16 分）
 * - 「スウィング」を選ぶと、8 分・16 分の裏の位置が後ろへずれる。スウィングはプロジェクトに保存される
 * - 小数のステップのノートは、保存して開き直しても、同じ位置に在る
 * - お手本が三連の曲は、練習を始めると刻みが 8 分の三連になり、お手本の位置に置いて比べると合う
 *
 * ピアノロールは、1 ステップ（16 分音符）= 20px、1 行 = 14px。ノートの中身は `data-note`（`C4 step:1.33 len:1.33`）で読む。
 * 小数のステップは、小数 2 桁で出る（8 分の三連の 2 つ目は 1.33、3 つ目は 2.67）。
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fakeJob, importSong, openDaw, openProject, openTab, saveProject, SONG_MP3, startFree, statusText } from './helpers';
import { DOWNBEAT, fakePracticeBackend } from './practice-fixtures';

const STEP_WIDTH = 20;

const notes = (page: Page) => page.locator('#note-layer .note-block');
/** 置かれたノートの中身 (例: "C4 step:1.33 len:1.33") を、位置の順に返す。 */
const noteTitles = async (page: Page) => (await notes(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.note ?? '')))
    .sort((a, b) => stepOf(a) - stepOf(b) || a.localeCompare(b));
/** ノートの中身から、位置 (ステップ) を出す。 */
const stepOf = (title: string) => Number(title.match(/step:([\d.]+)/)![1]);
/** ノートの位置と長さだけ (高さは、押した行で決まるので見ない)。 */
const shapes = async (page: Page) => (await noteTitles(page)).map((t) => t.replace(/^\S+ /, ''));
const snapSelect = (page: Page) => page.getByLabel('刻み', { exact: true });
const swingSelect = (page: Page) => page.getByLabel('スウィング', { exact: true });
const toasts = (page: Page) => page.locator('#notice-region .notice-toast');
const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

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

/** ノートの左寄りをつかんで、dx だけ横に動かす。 */
async function dragNote(page: Page, index: number, dx: number) {
    const box = (await notes(page).nth(index).boundingBox())!;
    const x = box.x + 5, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
}

/** ノートの右端をつかんで、dx だけ伸ばす (縮める)。 */
async function resizeNote(page: Page, index: number, dx: number) {
    const box = (await notes(page).nth(index).boundingBox())!;
    const x = box.x + box.width - 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
}

test.describe('刻み', () => {
    test('既定は 4 分。8 分の三連を選ぶと、三連の位置に置け、矢印キーで三連 1 つぶん動く。開き直しても、選んだ刻みを覚えている', async ({ page }) => {
        await openPianoRoll(page);
        // 既定は、これまでと同じ 4 分 (1 拍)。スウィングは、8 分か 16 分のときだけ選べる
        await expect(snapSelect(page)).toHaveValue('1/4');
        await expect(snapSelect(page).locator('option')).toHaveText(['4 分', '8 分', '16 分', '32 分', '8 分の三連', '16 分の三連']);
        await expect(page.locator('#piano-grid-wrap')).toHaveAttribute('data-snap', '1/4');
        await expect(swingSelect(page)).toBeDisabled();
        await placeNote(page, 30, 40);
        expect(await shapes(page)).toEqual(['step:0 len:4']);
        await notes(page).nth(0).click();
        await page.keyboard.press('Delete');
        await expect(notes(page)).toHaveCount(0);

        // キーボードで選べる: 欄にフォーカスして、選択肢を選ぶ
        await snapSelect(page).focus();
        await snapSelect(page).selectOption('1/8T');
        await expect(statusText(page)).toHaveText('刻みを「8 分の三連」にしました。ノートを置く・動かす位置が、この刻みに合います');
        await expect(page.locator('#piano-grid-wrap')).toHaveAttribute('data-snap', '1/8T');
        // 理由の要らない結果なので、知らせは出ない
        await expect(toasts(page)).toHaveCount(0);

        // 三連の位置に入る: 1.5 ステップのあたり → 1.33、3 ステップのあたり → 2.67、頭 → 0。長さは三連 1 つぶん
        await placeNote(page, 1.5 * STEP_WIDTH, 40);
        await placeNote(page, 3 * STEP_WIDTH, 68);
        await placeNote(page, 5, 96);
        expect(await shapes(page)).toEqual(['step:0 len:1.33', 'step:1.33 len:1.33', 'step:2.67 len:1.33']);
        // 描く位置も、1 拍 (80px) の 3 分の 1 ずつ
        const wrap = (await page.locator('#piano-grid-wrap').boundingBox())!;
        const lefts = await Promise.all([0, 1, 2].map(async (i) => (await notes(page).nth(i).boundingBox())!.x - wrap.x));
        expect(lefts.map((x) => Math.round(x * 3))).toEqual([80, 160, 0]);
        // 幅は、三連 1 つぶん (26.67px) から 1px 引いたもの
        expect((await notes(page).nth(0).boundingBox())!.width).toBeCloseTo(80 / 3 - 1, 0);

        // 矢印キーで、三連 1 つぶん動く。3 回で、ちょうど 1 拍 (端数がたまらず、整数のステップに戻る)
        await notes(page).nth(0).click();
        await page.keyboard.press('ArrowRight');
        expect(await shapes(page)).toEqual(['step:0 len:1.33', 'step:2.67 len:1.33', 'step:2.67 len:1.33']);
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        expect((await shapes(page))[2]).toBe('step:5.33 len:1.33');
        await page.keyboard.press('ArrowLeft');
        expect((await shapes(page))[2]).toBe('step:4 len:1.33');
        // 続けて押したぶんは、1 回の「元に戻す」で戻る
        await page.keyboard.press('ControlOrMeta+z');
        expect(await shapes(page)).toEqual(['step:0 len:1.33', 'step:1.33 len:1.33', 'step:2.67 len:1.33']);

        // 曲の頭より前へは動かせない。黙って止めずに、理由を出す
        await notes(page).nth(0).click();
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await expect(statusText(page)).toContainText('これ以上は、その向きに動かせません');
        expect((await shapes(page))[0]).toBe('step:0 len:1.33');

        // 選んだ刻みは、利用者ごとに覚える (ふつうのトラックの刻みとして)。開き直しても残る
        expect(await stored(page, 'bunri-snap')).toBe('1/8T');
        expect(await stored(page, 'bunri-snap-drums')).toBeNull();
        await page.reload();
        await page.getByText('準備完了').waitFor();
        await startFree(page);
        await page.locator('#tracks-container .track-name').first().click();
        await expect(snapSelect(page)).toHaveValue('1/8T');
        await placeNote(page, 3 * STEP_WIDTH, 40);
        expect(await shapes(page)).toEqual(['step:2.67 len:1.33']);
    });

    test('三連の刻みで、動かす・伸ばす・複製する・貼る。どれも三連の位置と長さに合う', async ({ page }) => {
        await openPianoRoll(page);
        await snapSelect(page).selectOption('1/8T');
        await placeNote(page, 5, 40);
        expect(await shapes(page)).toEqual(['step:0 len:1.33']);

        // 動かす: 1 拍 (80px) → 4。そこから 1.5 ステップぶん (30px) → いちばん近い三連 (5.33)
        await dragNote(page, 0, 4 * STEP_WIDTH);
        expect(await shapes(page)).toEqual(['step:4 len:1.33']);
        await dragNote(page, 0, 1.5 * STEP_WIDTH);
        expect(await shapes(page)).toEqual(['step:5.33 len:1.33']);

        // 伸ばす: 右端を、三連 1 つぶん (27px) 右へ → 長さは三連 2 つぶん。大きく縮めても、三連 1 つぶんは残る
        await resizeNote(page, 0, 27);
        expect(await shapes(page)).toEqual(['step:5.33 len:2.67']);
        await resizeNote(page, 0, -200);
        expect(await shapes(page)).toEqual(['step:5.33 len:1.33']);
        await resizeNote(page, 0, 27);
        expect(await shapes(page)).toEqual(['step:5.33 len:2.67']);

        // 複製: 選んだノートの長さ (三連 2 つぶん) の先へ → 8
        await page.keyboard.press('ControlOrMeta+d');
        await expect(notes(page)).toHaveCount(2);
        expect(await shapes(page)).toEqual(['step:5.33 len:2.67', 'step:8 len:2.67']);

        // コピーして貼る: 再生位置 (曲の頭) から。長さは、そのまま
        await page.keyboard.press('ControlOrMeta+c');
        await page.keyboard.press('ControlOrMeta+v');
        await expect(notes(page)).toHaveCount(3);
        expect(await shapes(page)).toEqual(['step:0 len:2.67', 'step:5.33 len:2.67', 'step:8 len:2.67']);

        // 元に戻すと、1 つずつ戻る (貼り付け → 複製 → 伸ばす)
        await page.keyboard.press('ControlOrMeta+z');
        await page.keyboard.press('ControlOrMeta+z');
        await page.keyboard.press('ControlOrMeta+z');
        expect(await shapes(page)).toEqual(['step:5.33 len:1.33']);
    });

    test('32 分と 16 分の三連: 横に広げると線が出て、その位置に置ける。幅の狭いノートも、つかんで動かせる', async ({ page }) => {
        await openPianoRoll(page);
        await snapSelect(page).selectOption('1/32');
        // 32 分音符 1 つは 10px。0.7 ステップのあたり → 0.5
        await placeNote(page, 0.7 * STEP_WIDTH, 40);
        expect(await shapes(page)).toEqual(['step:0.5 len:0.5']);
        // 幅 9px のノートでも、左寄りをつかめば動く (全部が「長さを変える」にならない)
        await dragNote(page, 0, 2 * STEP_WIDTH);
        expect(await shapes(page)).toEqual(['step:2.5 len:0.5']);
        await page.keyboard.press('ArrowRight');
        expect(await shapes(page)).toEqual(['step:3 len:0.5']);

        await snapSelect(page).selectOption('1/16T');
        await placeNote(page, 0.8 * STEP_WIDTH, 68);
        expect(await shapes(page)).toEqual(['step:0.67 len:0.67', 'step:3 len:0.5']);

        // 横の拡大の上限は、32 分音符が置きやすい大きさ (1 ステップ 100px) まで
        const zoomIn = page.getByRole('button', { name: '横に広げる' });
        for (let i = 0; i < 12 && await zoomIn.isEnabled(); i++) await zoomIn.click();
        await expect(zoomIn).toBeDisabled();
        // 32 分音符のノート (最初に置いたほう) の幅は、50px から 1px 引いたもの
        const wide = (await notes(page).nth(0).boundingBox())!;
        expect(Math.round(wide.width)).toBe(49);
        // 中身は変わらない
        expect(await shapes(page)).toEqual(['step:0.67 len:0.67', 'step:3 len:0.5']);
    });

    test('グリッドの線: 三連を選ぶと、三連の位置に線が出る (16 分音符の線は出ない)。4 分に戻すと、16 分音符の線に戻る', async ({ page }) => {
        await openPianoRoll(page);
        /** グリッドの canvas の、上の端から少し下の 1 行ぶんで、縦の線が在る x (px) を返す。 */
        const lineXs = () => page.locator('#piano-grid-canvas').evaluate((el) => {
            const canvas = el as HTMLCanvasElement;
            const ctx = canvas.getContext('2d')!;
            // 小節番号の文字 (上の 12px) を避けた高さで、白鍵の行を 1 つ探して読む
            const xs: number[] = [];
            const width = Math.min(canvas.width, 170);
            const rows = [20, 34, 48, 62, 76].map((y) => ctx.getImageData(0, y, width, 1).data);
            for (let x = 1; x < width - 1; x++) {
                // 縦の線は、どの行でも同じ x に在り、左右の隣より明るい
                const bright = rows.every((row) => {
                    const at = (i: number) => row[i * 4] * row[i * 4 + 3];
                    return at(x) > at(x - 1) + 150 || at(x) > at(x + 1) + 150;
                });
                if (bright) xs.push(x);
            }
            return xs;
        });
        const near = (xs: number[], x: number) => xs.some((v) => Math.abs(v - x) <= 1);

        // 4 分 (既定): 16 分音符ごと (20px) に線
        let xs = await lineXs();
        for (const x of [20, 40, 60, 80, 100]) expect(near(xs, x), `16 分の線 ${x}`).toBe(true);
        expect(near(xs, 27)).toBe(false);

        // 8 分の三連: 1 拍 (80px) を 3 つに分けた位置 (27・53px、107・133px)。16 分音符の線 (20・40・60px) は出ない
        await snapSelect(page).selectOption('1/8T');
        await expect.poll(async () => near(await lineXs(), 27)).toBe(true);
        xs = await lineXs();
        for (const x of [27, 53, 80, 107, 133, 160]) expect(near(xs, x), `三連の線 ${x}`).toBe(true);
        for (const x of [20, 40, 60, 100]) expect(near(xs, x), `16 分の線 ${x}`).toBe(false);

        // スウィング (8 分・67%): 裏の線が、三連の 3 つ目 (53px) に在る。まっすぐな 8 分の位置 (40px) には無い
        await snapSelect(page).selectOption('1/8');
        await swingSelect(page).selectOption({ label: '67%（三連）' });
        await expect.poll(async () => near(await lineXs(), 53)).toBe(true);
        xs = await lineXs();
        for (const x of [53, 80, 133, 160]) expect(near(xs, x), `スウィングの線 ${x}`).toBe(true);
        for (const x of [20, 27, 40, 60]) expect(near(xs, x), `線 ${x}`).toBe(false);

        await swingSelect(page).selectOption({ label: '50%（なし）' });
        await snapSelect(page).selectOption('1/4');
        await expect.poll(async () => near(await lineXs(), 20)).toBe(true);
        expect(near(await lineXs(), 27)).toBe(false);
    });
});

test.describe('スウィング', () => {
    test('8 分・67% を選ぶと、裏の位置が後ろへずれる。選べない刻みでは、選べない理由が出る', async ({ page }) => {
        await openPianoRoll(page);
        // 4 分では選べない。押すと、どうすれば選べるかが出る
        await expect(swingSelect(page)).toBeDisabled();
        const box = (await swingSelect(page).boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(toasts(page).first()).toContainText('スウィングは、刻みが 8 分か 16 分のときに使えます');

        await snapSelect(page).selectOption('1/8');
        await expect(swingSelect(page)).toBeEnabled();
        await expect(swingSelect(page).locator('option')).toHaveText(['50%（なし）', '54%', '58%', '62%', '67%（三連）', '71%', '75%']);
        // まだずらしていない: 2.5 ステップのあたり → まっすぐな 8 分の裏 (2)
        await placeNote(page, 2.5 * STEP_WIDTH, 40);
        expect(await shapes(page)).toEqual(['step:2 len:2']);

        await swingSelect(page).focus();
        await swingSelect(page).selectOption({ label: '67%（三連）' });
        await expect(statusText(page)).toHaveText('スウィングを 67% にしました。8 分の裏の位置が、後ろへずれます（すでに置いたノートは動きません）');
        // すでに置いたノートは動かない
        expect(await shapes(page)).toEqual(['step:2 len:2']);
        // 同じ場所 (2.5 ステップ) は、まだ表 (0)。長さは、次の吸い付く位置 (2.67) まで
        await placeNote(page, 2.5 * STEP_WIDTH, 68);
        // 3 ステップのあたりは、ずれた裏 (2.67 = 三連の 3 つ目)。長さは、次の表 (4) まで
        await placeNote(page, 3 * STEP_WIDTH, 96);
        expect(await shapes(page)).toEqual(['step:0 len:2.67', 'step:2 len:2', 'step:2.67 len:1.33']);

        // 矢印キー: 裏 (2.67) → 次の表 (4) → 次の裏 (6.67) と、吸い付く位置を 1 つずつ動く
        await notes(page).nth(2).click();
        await page.keyboard.press('ArrowRight');
        expect((await shapes(page))[2]).toBe('step:4 len:1.33');
        await page.keyboard.press('ArrowRight');
        expect((await shapes(page))[2]).toBe('step:6.67 len:1.33');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        expect((await shapes(page))[2]).toBe('step:2.67 len:1.33');

        // 16 分・75%: 裏が 1.5 (付点 16 分 + 32 分)
        await snapSelect(page).selectOption('1/16');
        await swingSelect(page).selectOption({ label: '75%' });
        await placeNote(page, 1.6 * STEP_WIDTH, 124);
        expect((await shapes(page)).filter((s) => s.startsWith('step:1.5'))).toEqual(['step:1.5 len:0.5']);

        // 三連を選ぶと、スウィングは効かない (選べなくなる)
        await snapSelect(page).selectOption('1/8T');
        await expect(swingSelect(page)).toBeDisabled();
    });

    test('小数のステップのノートとスウィングは、保存して開き直しても残る', async ({ page }) => {
        await openPianoRoll(page);
        await snapSelect(page).selectOption('1/8T');
        await placeNote(page, 1.5 * STEP_WIDTH, 40);     // 1.33
        await placeNote(page, 3 * STEP_WIDTH, 68);      // 2.67
        await snapSelect(page).selectOption('1/32');
        await placeNote(page, 4.6 * STEP_WIDTH, 96);    // 4.5
        await snapSelect(page).selectOption('1/8');
        await swingSelect(page).selectOption({ label: '58%' });
        await placeNote(page, 10.5 * STEP_WIDTH, 124);   // 8 + 2.32 → 1/60 ステップにそろえて 10.32
        const before = await noteTitles(page);
        expect(before.map((t) => t.replace(/^\S+ /, ''))).toEqual(['step:1.33 len:1.33', 'step:2.67 len:1.33', 'step:4.5 len:0.5', 'step:10.32 len:1.68']);

        // スウィングを変えると、保存していない変更になる (曲の性質なので、プロジェクトに入る)
        await expect(page).toHaveTitle(/●/);
        const name = await saveProject(page, `刻み ${Date.now()}`);
        await expect(page).not.toHaveTitle(/●/);
        // 保存したあとにスウィングだけを変えても、保存していない変更になる。元の値に戻すと消える
        await swingSelect(page).selectOption({ label: '62%' });
        await expect(page).toHaveTitle(/●/);
        await swingSelect(page).selectOption({ label: '58%' });
        await expect(page).not.toHaveTitle(/●/);

        // 開き直す (画面を読み込み直して、スウィングを既定に戻してから)
        await page.reload();
        await page.getByText('準備完了').waitFor();
        await openProject(page, name);
        await page.locator('#tracks-container .track-name').first().click();
        await expect(notes(page)).toHaveCount(4);
        expect(await noteTitles(page)).toEqual(before);
        // スウィングは、プロジェクトの値 (58%) に戻る。刻みは、利用者が最後に選んだもの (8 分) のまま
        await expect(snapSelect(page)).toHaveValue('1/8');
        await expect(swingSelect(page).locator('option:checked')).toHaveText('58%');
        // 開いた直後は、保存していない変更は無い
        await expect(page).not.toHaveTitle(/●/);
        // 開いたプロジェクトのスウィングで置ける
        await placeNote(page, 2.5 * STEP_WIDTH, 152);
        expect((await shapes(page)).filter((s) => s.startsWith('step:2.32'))).toEqual(['step:2.32 len:1.68']);
    });
});

// ---- 学ぶ流れ (カルテとパート分離の応答は差し替える。e2e/practice-fixtures.ts) ----

const hit = (type: string, step: number) => ({ type, step, velocity: 96 });
/** シャッフルのベース: 拍の頭と、三連の 3 つ目。1 小節目だけ。 */
const SHUFFLE_BASS = [0, 8 / 3, 4, 20 / 3, 8, 32 / 3, 12, 44 / 3].map((step, i) => ({ note: i % 2 ? 'G' : 'C', octave: 2, step, length: 4 / 3, velocity: 90 }));
/** シャッフルのドラム: ハイハットが三連の 1 つ目と 3 つ目、キックとスネアが拍の頭。 */
const SHUFFLE_DRUMS = [hit('kick', 0), hit('cymbals', 0), hit('cymbals', 8 / 3), hit('snare', 4), hit('cymbals', 4), hit('cymbals', 20 / 3)];

/** パート分離の応答 (三連のグリッドで採譜した、ベースとドラム)。 */
function shuffle() {
    const stem = (extra: object) => ({ gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [], drum_events: [], grid_feel: 'triplet', ...extra });
    return {
        bpm: 120, grid_offset_sec: DOWNBEAT, drum_source: 'stems', drum_fallback: null, grid_feel: 'triplet',
        stems: {
            bass: stem({ audio_url: '/api/download/decompose_bass_song.mp3', notes: SHUFFLE_BASS }),
            drums: stem({ audio_url: '/api/download/decompose_drums_song.mp3', drum_events: SHUFFLE_DRUMS, drum_source: 'stems' }),
        },
    };
}

/** 曲を取り込み、パートに分ける (応答は、三連の曲)。 */
async function separateShuffle(page: Page) {
    await fakePracticeBackend(page);
    // 後から仕掛けたほうが先に当たる (三連の応答に差し替える)
    await fakeJob(page, '/api/decompose', () => shuffle());
    await openDaw(page);
    // 再生の仕組み (AudioContext) を、本物のクリックの中で作っておく (e2e/practice-fixtures.ts の openBassPractice と同じ理由)
    await page.getByRole('button', { name: 'メトロノーム' }).click();
    await page.getByRole('button', { name: 'メトロノーム' }).click();
    await importSong(page, { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(SONG_MP3) });
    await expect(statusText(page)).toContainText('カルテを作りました');
    await openTab(page, '曲とパート');
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました（2 パート、お手本 2 パート）。三連の曲なので、お手本は三連の位置に載っています');
}

/** お手本の i 番目の左端のすぐ右を、ダブルクリックする (その位置の刻みに、ノートが入る)。 */
async function placeOnGhost(page: Page, index: number) {
    const before = await notes(page).count();
    const g = (await page.locator('#note-layer .note-ghost').nth(index).boundingBox())!;
    await page.mouse.dblclick(g.x + 3, g.y + g.height / 2);
    await expect(notes(page)).toHaveCount(before + 1);
}

test.describe('三連の曲を練習する', () => {
    test('ドラムのトラックの刻みは、既定が 16 分。ふつうのトラックとは別に覚える', async ({ page }) => {
        await separateShuffle(page);
        await page.locator('#part-list').getByRole('button', { name: '「ドラム」を練習する' }).click();
        await expect(page.getByRole('region', { name: '練習画面' })).toBeVisible();
        await expect(page.locator('#piano-grid-wrap')).toHaveAttribute('data-drums', 'true');
        // お手本が三連なので、ドラムの刻みも 8 分の三連に合わせる (利用者が覚えさせた刻みは、書き換えない)
        await expect(statusText(page)).toContainText('お手本が三連の曲なので、刻みを「8 分の三連」に合わせました');
        await expect(snapSelect(page)).toHaveValue('1/8T');
        expect(await stored(page, 'bunri-snap-drums')).toBeNull();
        // お手本の打音は、三連の位置に在る (ハイハットの 2 つ目は 2.67 ステップ = 1 拍の 3 分の 2)
        const ghosts = page.locator('#note-layer .note-ghost');
        await expect(ghosts).toHaveCount(SHUFFLE_DRUMS.length);
        // (お手本の打音は 1 ステップの長さ。ノートの幅は、升より 1px 小さい)
        const hat0 = (await ghosts.nth(1).boundingBox())!, hat1 = (await ghosts.nth(2).boundingBox())!;
        expect((hat1.x - hat0.x) / (hat0.width + 1)).toBeCloseTo(8 / 3, 1);

        // 利用者が 16 分に戻すと、それに従う。ドラムのトラックの刻みとして覚える
        await snapSelect(page).selectOption('1/16');
        expect(await stored(page, 'bunri-snap-drums')).toBe('1/16');
        expect(await stored(page, 'bunri-snap')).toBeNull();
        await placeOnGhost(page, 0);
        expect(await shapes(page)).toEqual(['step:0 len:1']);

        // アレンジに戻って、ふつうのトラック (ベース) を開くと、ふつうのトラックの刻み (既定の 4 分)
        await page.getByRole('button', { name: '← アレンジに戻る' }).click();
        await page.locator('#tracks-container .track-name').filter({ hasText: /^ベース/ }).first().click();
        await expect(page.locator('#piano-grid-wrap')).not.toHaveAttribute('data-drums', 'true');
        await expect(snapSelect(page)).toHaveValue('1/4');
        // ドラムの練習のトラックに戻ると、ドラムの刻み (16 分)。練習に入り直しても、三連に戻さない
        await openTab(page, '曲とパート');
        await page.locator('#part-list').getByRole('button', { name: '「ドラム」を練習する' }).click();
        await expect(page.getByRole('region', { name: '練習画面' })).toBeVisible();
        await expect(snapSelect(page)).toHaveValue('1/16');
        await expect(page.locator('#piano-grid-wrap')).toHaveAttribute('data-snap', '1/16');
    });

    test('ドラムのトラックは、何も選んでいなければ 16 分の刻み (ふつうのトラックで選んだ刻みは、ドラムには効かない)', async ({ page }) => {
        // ふつうのトラックの刻みとして、8 分の三連を覚えさせておく
        await page.addInitScript(() => localStorage.setItem('bunri-snap', '1/8T'));
        await fakePracticeBackend(page);
        // お手本がストレートのドラム (刻みを、お手本に合わせない)
        await fakeJob(page, '/api/decompose', () => {
            const result = shuffle();
            return { ...result, grid_feel: 'straight', stems: { drums: { ...result.stems.drums, grid_feel: 'straight', drum_events: [hit('kick', 0), hit('snare', 4), hit('cymbals', 6)] } } };
        });
        await openDaw(page);
        await page.getByRole('button', { name: 'メトロノーム' }).click();
        await page.getByRole('button', { name: 'メトロノーム' }).click();
        await importSong(page, { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(SONG_MP3) });
        await expect(statusText(page)).toContainText('カルテを作りました');
        await openTab(page, '曲とパート');
        await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
        await expect(statusText(page)).toContainText('パートに分けました（1 パート、お手本 1 パート）');
        await page.locator('#part-list').getByRole('button', { name: '「ドラム」を練習する' }).click();
        await expect(page.getByRole('region', { name: '練習画面' })).toBeVisible();
        // ストレートのお手本なので、刻みを合わせたという文は出ない
        await expect(statusText(page)).not.toContainText('刻みを');
        await expect(snapSelect(page)).toHaveValue('1/16');
        await expect(page.locator('#piano-grid-wrap')).toHaveAttribute('data-snap', '1/16');
        // 16 分音符の位置に、長さ 1 ステップで入る (3 つ目のお手本は、6 ステップ = 8 分の裏)
        await placeOnGhost(page, 2);
        expect(await shapes(page)).toEqual(['step:6 len:1']);
    });

    test('ベースを練習する: 刻みが 8 分の三連になり、お手本の位置に置いて比べると合う。三連 1 つぶんずらすと、その幅で指摘される', async ({ page }) => {
        await separateShuffle(page);
        await page.locator('#part-list').getByRole('button', { name: '「ベース」を練習する' }).click();
        await expect(page.getByRole('region', { name: '練習画面' })).toBeVisible();
        await expect(statusText(page)).toContainText('お手本が三連の曲なので、刻みを「8 分の三連」に合わせました（ピアノロールの上の「刻み」で変えられます）');
        await expect(snapSelect(page)).toHaveValue('1/8T');
        // アプリが合わせた刻みは、利用者の選んだ刻みとしては覚えない
        expect(await stored(page, 'bunri-snap')).toBeNull();

        // お手本の 8 つの位置に、そのまま置ける (4 分の刻みのままだと、三連の 3 つ目には置けない)
        await expect(page.locator('#note-layer .note-ghost')).toHaveCount(SHUFFLE_BASS.length);
        for (let i = 0; i < SHUFFLE_BASS.length; i++) await placeOnGhost(page, i);
        expect(await shapes(page)).toEqual([
            'step:0 len:1.33', 'step:2.67 len:1.33', 'step:4 len:1.33', 'step:6.67 len:1.33',
            'step:8 len:1.33', 'step:10.67 len:1.33', 'step:12 len:1.33', 'step:14.67 len:1.33',
        ]);

        // 比べる (差分は、処理を担当する部分が出す。小数のステップを、そのまま送る)
        await page.getByRole('button', { name: '比べる', exact: true }).click();
        await expect(page.getByTestId('match-rate')).toHaveText('100%');
        const layer = page.locator('#note-layer');
        await expect(layer.locator('.note-block.diff-ok')).toHaveCount(SHUFFLE_BASS.length);

        // 2 つ目 (2.67) を、三連 1 つぶん前 (1.33) へ動かして比べ直す。ずれは、三連の数で言う
        await layer.locator('.note-block').nth(1).click();
        await page.keyboard.press('ArrowLeft');
        expect((await shapes(page))[1]).toBe('step:1.33 len:1.33');
        const side = page.getByRole('complementary', { name: 'この区間の指摘' });
        await side.getByRole('button', { name: 'もう一度比べる' }).click();
        const issues = side.getByRole('list', { name: /指摘の一覧/ });
        await expect(issues.getByRole('button', { name: '1 小節 1 拍目: G2 が8 分の三連符 1 個ぶん早い' })).toBeVisible();
        // ずれたノートにだけ印が付く (小数の位置でも、隣のノートと取り違えない)
        await expect(layer.locator('.note-block.diff-rhythm')).toHaveCount(1);
        await expect(layer.locator('.note-block.diff-rhythm')).toHaveAttribute('data-note', /step:1\.33 /);
        await expect(layer.locator('.note-block.diff-ok')).toHaveCount(SHUFFLE_BASS.length - 1);
    });
});
