/**
 * タイムライン (上の段): 小節番号の段とクリップの位置が合うこと、長い曲を横にスクロールして見られること、
 * シーク、トラックの追加と削除。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { makeWav, openDaw, openTab, statusText } from './helpers';

/** タイムラインの縮尺 (1 秒 = 80px) と、トラックの見出しの幅。 */
const PX_PER_SEC = 80;
const HEADER_WIDTH = 130;

const area = (page: Page) => page.locator('#timeline-area');
const clips = (page: Page) => page.locator('#tracks-container .clip');
const trackNames = async (page: Page) => (await page.locator('#tracks-container .track-name').allTextContents()).map((t) => t.trim());

/** ファイルのタブから、先頭のトラックにクリップを足す。 */
async function addClip(page: Page, name: string, seconds: number, sampleRate = 22050) {
    await openTab(page, 'ファイル');
    const before = await clips(page).count();
    await page.locator('#file-panel input[type="file"]').nth(1)
        .setInputFiles({ name, mimeType: 'audio/wav', buffer: makeWav(seconds, [440, 660], sampleRate) });
    await page.getByRole('button', { name: '選択したトラックに追加' }).click();
    await expect(clips(page)).toHaveCount(before + 1, { timeout: 60_000 });
}

/** 要素の左端・上端・幅 (画面の座標)。 */
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

/**
 * 小節番号の段に描かれた、小節の線の位置 (段の左端からの px) を返す。
 * 小節の線は拍の線より明るいので、下端の行の明るさで見分ける。線は幅 1px で、
 * 画素の境目に引かれるので、隣り合う 2 つの画素にまたがる。その右側の画素の位置を返す。
 */
const barLines = (page: Page) => page.locator('#timeline-header-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const row = canvas.getContext('2d')!.getImageData(0, 22, canvas.width, 1).data;
    const xs: number[] = [];
    // 背景は 23、拍の線は 35 前後、小節の線は 58 前後
    for (let x = 1; x < canvas.width; x++) {
        if (row[x * 4] > 46 && row[(x - 1) * 4] > 46) xs.push(x);
    }
    return xs;
});

async function scrollTimeline(page: Page, left: number, top = 0) {
    await area(page).evaluate((el, [l, t]) => { el.scrollLeft = l; el.scrollTop = t; }, [left, top]);
}

test('小節番号の段が、クリップを置く領域と同じ位置から始まる', async ({ page }) => {
    await openDaw(page);
    await addClip(page, 'two-sec.wav', 2);
    const ruler = await box(page, '#timeline-header-canvas');
    const clip = await box(page, '#tracks-container .clip');
    // 0 秒に置いたクリップの左端 = 1 小節目の線。120 BPM・4/4 では 1 小節 = 2 秒 = 160px
    const lines = await barLines(page);
    expect(Math.abs(ruler.x + lines[0] - clip.x)).toBeLessThanOrEqual(1);
    expect(lines[1] - lines[0]).toBe(2 * PX_PER_SEC);
    // 2 秒のクリップの右端が、2 小節目の線に来る
    expect(Math.abs(ruler.x + lines[1] - (clip.x + clip.width))).toBeLessThanOrEqual(1);
    // トラックの見出しの列の上には、線を描かない
    expect(lines[0]).toBeGreaterThanOrEqual(HEADER_WIDTH - 1);
});

test('テンポや拍子を変えると、小節番号の段が描き直される', async ({ page }) => {
    await openDaw(page);
    const spacing = async () => { const lines = await barLines(page); return lines[1] - lines[0]; };
    expect(await spacing()).toBe(160);
    // 60 BPM なら 1 小節 = 4 秒 = 320px
    await page.locator('#transport input[type="number"]').fill('60');
    await expect.poll(spacing).toBe(320);
    // 3/4 なら 1 小節 = 3 秒 = 240px
    await page.locator('#transport select').first().selectOption('3');
    await expect.poll(spacing).toBe(240);
});

test('長い曲を横にスクロールすると、後ろのクリップが見え、見出しとシークバーは留まる', async ({ page }) => {
    await openDaw(page);
    await addClip(page, 'sixty-sec.wav', 60, 8000);
    const view = await box(page, '#timeline-area');
    // 曲の長さ + 10 秒の余白ぶんの幅を、横にスクロールできる
    const scrollWidth = await area(page).evaluate((el) => el.scrollWidth);
    expect(scrollWidth).toBe(HEADER_WIDTH + 70 * PX_PER_SEC);

    await scrollTimeline(page, 3000);
    // 60 秒のクリップが、見えている範囲を覆っている (以前は 12 秒あたりで切れていた)
    const clip = await box(page, '#tracks-container .clip');
    expect(clip.x).toBeLessThan(view.x + HEADER_WIDTH);
    expect(clip.x + clip.width).toBeGreaterThan(view.x + view.width - 1);
    await expect(clips(page).first()).toBeInViewport();
    // トラックの行も、見えている範囲の右端まで在る
    const row = await box(page, '#tracks-container .track-row');
    expect(row.x + row.width).toBeGreaterThan(view.x + view.width - 1);

    // 見出し・トラック名・追加ボタン・シークバーは、左端に留まる
    for (const selector of ['#timeline-area .area-label', '#tracks-container .track-header', '#seek-bar-area']) {
        expect((await box(page, selector)).x, selector).toBe(view.x);
    }
    await expect(page.locator('#btn-add-track')).toBeInViewport();
    await expect(page.locator('#seek-bar')).toBeInViewport();

    // 小節番号の段は、スクロールした先の小節を示す。3000px = 37.5 秒 → 次の小節の線は 38 秒 (20 小節目)
    const ruler = await box(page, '#timeline-header-canvas');
    expect(ruler.x).toBe(view.x);
    const lines = await barLines(page);
    expect(lines[0]).toBe(HEADER_WIDTH + 38 * PX_PER_SEC - 3000);
});

test('スクロールした先でクリップを動かしても、押した分だけ動く', async ({ page }) => {
    await openDaw(page);
    await addClip(page, 'two-sec.wav', 2);
    const drag = async (dx: number) => {
        const clip = await box(page, '#tracks-container .clip');
        await page.mouse.move(clip.x + 20, clip.y + 20);
        await page.mouse.down();
        await page.mouse.move(clip.x + 20 + dx, clip.y + 20, { steps: 5 });
        await page.mouse.up();
    };
    // 拍 (0.5 秒 = 40px) にそろう。205px → 200px = 2.5 秒
    await drag(205);
    await expect(clips(page).first()).toHaveAttribute('title', /開始: 2\.5s/);
    await scrollTimeline(page, 120);
    await drag(120);
    await expect(clips(page).first()).toHaveAttribute('title', /開始: 4\.0s/);
    // 小節番号の段と合っている: 4.0 秒 = 3 小節目の頭
    const ruler = await box(page, '#timeline-header-canvas');
    const clip = await box(page, '#tracks-container .clip');
    const lines = await barLines(page);
    expect(lines.some((x) => Math.abs(ruler.x + x - clip.x) <= 1)).toBe(true);
});

test('縦にスクロールしても、見出しと小節番号の段は上端に留まる', async ({ page }) => {
    await openDaw(page);
    for (let i = 0; i < 7; i++) await page.getByRole('button', { name: '+ トラック追加' }).click();
    await expect(page.locator('#tracks-container .track-row')).toHaveCount(9);
    await scrollTimeline(page, 0, 0);
    const view = await box(page, '#timeline-area');
    const before = await box(page, '#timeline-header-canvas');
    await scrollTimeline(page, 0, 200);
    expect(await area(page).evaluate((el) => el.scrollTop)).toBe(200);
    expect((await box(page, '#timeline-area .area-label')).y).toBe(view.y);
    expect((await box(page, '#timeline-header-canvas')).y).toBe(before.y);
    // 段は描かれたまま
    expect((await barLines(page)).length).toBeGreaterThan(3);
});

test.describe('シークバー', () => {
    const current = (page: Page) => page.locator('#time-display').textContent();

    test('矢印キーで動かすと、その位置へ移動し、その後も再生位置を追う', async ({ page }) => {
        await openDaw(page);
        await addClip(page, 'ten-sec.wav', 10, 8000);
        await expect(page.locator('#seek-time-total')).toHaveText('0:10.0');
        await page.locator('#seek-bar').focus();
        // 1 回で 0.1% = 0.01 秒。30 回で 0.3 秒ぶん
        for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
        await expect(page.locator('#seek-time-current')).toHaveText('0:00.3');
        await expect.poll(() => current(page)).toBe('0:00.3');

        // 再生すると、つまみが動き出す (以前は、キーで動かした後は止まったままだった)
        await page.locator('#btn-play').click();
        await expect.poll(async () => Number(await page.locator('#seek-bar').inputValue())).toBeGreaterThan(10);
        await page.locator('#transport button[title="停止"]').click();
    });

    test('押した位置へ移動する (続けて押しても、1 つ前の位置にならない)', async ({ page }) => {
        await openDaw(page);
        await addClip(page, 'ten-sec.wav', 10, 8000);
        await expect(page.locator('#seek-time-total')).toHaveText('0:10.0');
        const bar = await box(page, '#seek-bar');
        const seconds = async () => { const [m, s] = (await current(page))!.split(':'); return Number(m) * 60 + Number(s); };
        await page.mouse.click(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
        await expect.poll(seconds).toBeGreaterThan(4.5);
        expect(await seconds()).toBeLessThan(5.5);
        await page.mouse.click(bar.x + bar.width * 0.2, bar.y + bar.height / 2);
        await expect.poll(seconds).toBeLessThan(2.5);
        expect(await seconds()).toBeGreaterThan(1.5);
    });
});

test.describe('トラックとクリップ', () => {
    test('途中のトラックを消してから足しても、同じ名前のトラックができない', async ({ page }) => {
        await openDaw(page);
        await page.getByRole('button', { name: '+ トラック追加' }).click();
        expect(await trackNames(page)).toEqual(['Track 1', 'Track 2', 'Track 3']);
        await page.locator('#tracks-container .btn-delete-track').nth(1).click();
        await page.getByRole('button', { name: '+ トラック追加' }).click();
        expect(await trackNames(page)).toEqual(['Track 1', 'Track 3', 'Track 4']);
        // 全部消してから足すと、Track 1 から
        while (await page.locator('#tracks-container .btn-delete-track').count() > 0) {
            await page.locator('#tracks-container .btn-delete-track').first().click();
        }
        await expect(page.locator('#tracks-container .track-row')).toHaveCount(0);
        await page.getByRole('button', { name: '+ トラック追加' }).click();
        expect(await trackNames(page)).toEqual(['Track 1']);
    });

    test('ピアノロールで開いているトラックを消すと、ピアノロールは選択なしに戻る', async ({ page }) => {
        await openDaw(page);
        await page.locator('#tracks-container .track-name').nth(1).click();
        await expect(page.locator('#piano-roll-area .area-label')).toContainText('Track 2');
        await page.locator('#tracks-container .btn-delete-track').nth(1).click();
        expect(await trackNames(page)).toEqual(['Track 1']);
        await expect(page.locator('#piano-roll-area .area-label')).toContainText('トラックをクリックして選択');
    });

    test('記号を含むトラック名が、そのまま文字として出る', async ({ page, request }: { page: Page; request: APIRequestContext }) => {
        const name = 'A<b>B</b> & <i>C';
        const project = { bpm: 120, beatsPerBar: 4, automation: {}, tracks: [{ name, pianoNotes: [{ note: 'C', octave: 4, step: 0, length: 4 }] }] };
        expect((await request.post('/api/project/save', { form: { data: JSON.stringify(project) } })).ok()).toBe(true);
        await openDaw(page);
        await page.getByRole('button', { name: '読込', exact: true }).click();
        await expect(statusText(page)).toContainText('を読み込みました');
        const nameEl = page.locator('#tracks-container .track-name').first();
        // 名前の後ろに、ノートの数の印が付く
        await expect(nameEl).toHaveText(`${name} 1`);
        expect(await nameEl.locator('b, i').count()).toBe(0);
    });

    test('クリップを右クリックで消すと、何を消したかが出る', async ({ page }) => {
        await openDaw(page);
        await addClip(page, 'two-sec.wav', 2);
        const clip = await box(page, '#tracks-container .clip');
        await page.mouse.click(clip.x + 10, clip.y + 10, { button: 'right' });
        await expect(clips(page)).toHaveCount(0);
        await expect(statusText(page)).toHaveText('クリップ「two-sec.wav」を「Track 1」から削除しました');
    });

    test('WAV をドロップすると、落とした位置にクリップが入る。WAV 以外は断る', async ({ page }) => {
        await openDaw(page);
        const drop = async (fileName: string, x: number) => {
            const bytes = [...makeWav(1)];
            const dataTransfer = await page.evaluateHandle(([name, data]) => {
                const transfer = new DataTransfer();
                transfer.items.add(new File([new Uint8Array(data as number[])], name as string, { type: 'audio/wav' }));
                return transfer;
            }, [fileName, bytes] as const);
            const wrap = await box(page, '#tracks-container .track-canvas-wrap');
            await page.locator('#tracks-container .track-canvas-wrap').first()
                .dispatchEvent('drop', { dataTransfer, clientX: wrap.x + x, clientY: wrap.y + 20 });
        };
        // 拡張子が大文字でも受ける。240px = 3 秒の位置
        await drop('LOUD.WAV', 240);
        await expect(clips(page)).toHaveCount(1);
        await expect(clips(page).first()).toHaveAttribute('title', /開始: 3\.0s/);
        await expect(statusText(page)).toHaveText('LOUD.WAV を「Track 1」に追加しました');

        await drop('notes.txt', 100);
        await expect(statusText(page)).toHaveText('WAV 以外のファイルは追加できません: notes.txt');
        await expect(clips(page)).toHaveCount(1);
    });
});
