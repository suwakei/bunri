/**
 * ドラムの差分: ドラムのパートを練習する → 鍵盤の列に種類の名前が出る → 打ち込む → 比べる →
 * 抜け・余分なノート・位置のずれが、種類の名前で出て、一致が出る → 練習の地図にドラムの行が出る。
 * 差分チェックの段では、Claude の説明のボタンの代わりに、決まった文が出る。
 * 「ドラムを種類ごとに分ける」の選択は、追加のモデルが手元に在るかで最初の状態と文が変わり、選んだとおりに送られる。
 *
 * カルテとパート分離の応答は差し替える (e2e/practice-fixtures.ts)。1 小節 = 16 ステップ。構成は「Aメロ？」1〜2 小節、「サビ？」3〜4 小節。
 * ドラムのお手本は、1 小節目に 9 打 (キック 2・スネア 2・ハイハット 4・タム 1)、3 小節目に 2 打。
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fakeJob, importSong, openDaw, openTab, recordOscillators, SONG_MP3, soundedFrequencies, statusText } from './helpers';
import { DOWNBEAT, fakePracticeBackend } from './practice-fixtures';

const hit = (type: string, step: number, velocity = 96) => ({ type, step, velocity });
/** ドラムの打音 (種類ごとに分けて採譜した結果の形)。お手本のノートは、この順に並ぶ。 */
const DRUM_EVENTS = [
    hit('kick', 0), hit('cymbals', 0), hit('snare', 4), hit('cymbals', 4),
    hit('kick', 8), hit('cymbals', 8), hit('snare', 12), hit('cymbals', 12), hit('toms', 14),
    hit('kick', 32), hit('snare', 36),
];
/** お手本の並びの中の番号。 */
const GHOST = { kick0: 0, hat0: 1, snare4: 2, hat4: 3, kick8: 4 };

/** パート分離の応答 (ボーカルとドラム)。 */
function decompose(source: 'stems' | 'spectral' = 'stems') {
    const stem = (extra: object) => ({ gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [], drum_events: [], ...extra });
    return {
        bpm: 120, grid_offset_sec: DOWNBEAT, drum_source: source, drum_fallback: null,
        stems: {
            vocals: stem({ audio_url: '/api/download/decompose_vocals_song.mp3', notes: [{ note: 'E', octave: 4, step: 0, length: 8, velocity: 90 }] }),
            drums: stem({ audio_url: '/api/download/decompose_drums_song.mp3', drum_events: DRUM_EVENTS, drum_source: source }),
        },
    };
}

const region = (page: Page) => page.getByRole('region', { name: '練習画面' });
const keys = (page: Page) => page.locator('#piano-keys');

/** 曲を取り込み、「曲とパート」の段を開く。 */
async function importAndOpenParts(page: Page) {
    // 再生の仕組み (AudioContext) を、本物のクリックの中で作っておく (e2e/practice-fixtures.ts の openBassPractice と同じ理由)
    await page.getByRole('button', { name: 'メトロノーム' }).click();
    await page.getByRole('button', { name: 'メトロノーム' }).click();
    await importSong(page, { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(SONG_MP3) });
    await expect(statusText(page)).toContainText('カルテを作りました');
    await openTab(page, '曲とパート');
}

/** パートに分けて、ドラムの「このパートを練習する」で練習画面を開く。 */
async function openDrumPractice(page: Page) {
    await importAndOpenParts(page);
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました');
    await page.locator('#part-list').getByRole('button', { name: '「ドラム」を練習する' }).click();
    await expect(region(page)).toBeVisible();
}

/** お手本の i 番目の位置から、steps ステップ後ろ・rows 行下 (負なら上の行) に、ノートを置く。 */
async function placeAt(page: Page, ghostIndex: number, steps = 0, rows = 0) {
    const g = (await page.locator('#note-layer .note-ghost').nth(ghostIndex).boundingBox())!;
    // お手本の打音は 1 ステップの長さ。ノートの幅と高さは、升より 1px 小さい
    const step = g.width + 1, row = g.height + 1;
    await page.mouse.dblclick(g.x + step / 2 + steps * step, g.y + row / 2 + rows * row);
}

test.beforeEach(async ({ page }) => {
    await fakePracticeBackend(page);
    // 後から仕掛けたほうが先に当たる (ドラムの入った応答に差し替える)
    await fakeJob(page, '/api/decompose', () => decompose());
});

test('ドラムのパートを練習する: 鍵盤の列に種類の名前が出て、打ち込んで比べると、種類ごとの抜け・余分・位置のずれと一致が出る', async ({ page }) => {
    await recordOscillators(page);
    await openDaw(page);
    await importAndOpenParts(page);
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました（2 パート、お手本 2 パート）。ドラムは、種類ごとに分けて採譜しました');
    // ドラムも、ほかのパートと同じ形: お手本を持ち、打ち込みは空
    const drumItem = page.locator('#part-list .part-item[data-part="drums"]');
    await expect(drumItem).toContainText(`お手本 ${DRUM_EVENTS.length} ノート`);
    await drumItem.getByRole('button', { name: '「ドラム」を練習する' }).click();
    await expect(region(page)).toBeVisible();
    await expect(region(page)).toContainText('練習: ドラム');
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(DRUM_EVENTS.length);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);

    // 鍵盤の列: ドラムの行に、音名の代わりに種類の名前が出て、見える位置に在る
    await expect(page.locator('#piano-grid-wrap')).toHaveAttribute('data-drums', 'true');
    const rows = keys(page).locator('.piano-key.drum-row');
    await expect(rows).toHaveText(['タム', 'ハイハット・シンバル', 'スネア', 'キック']);
    for (const name of ['タム', 'ハイハット・シンバル', 'スネア', 'キック']) await expect(keys(page).getByText(name, { exact: true })).toBeInViewport();
    // 名前は、列からはみ出さない
    const clipped = await rows.evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
    expect(clipped).toEqual([]);
    await expect(keys(page).getByText('キック', { exact: true })).toHaveAttribute('data-tip', 'キック（C2）。押すと、この音が鳴ります');
    // ほかの行は、音名のまま
    await expect(keys(page).getByText('E2', { exact: true })).toHaveAttribute('data-tip', 'E2。押すと、この高さの音が鳴ります');
    // ドラムでは、キーの音・コードの音は押せない (行の高さが音階を表さない)
    await expect(page.getByRole('button', { name: 'キーの音' })).toBeDisabled();

    // 鍵盤を押すと、種類ごとの音が鳴る (キックは 150 Hz から下がるサイン波。三角波の C2 = 65.41 Hz ではない)
    const before = (await soundedFrequencies(page)).length;
    await keys(page).getByText('キック', { exact: true }).click();
    expect((await soundedFrequencies(page)).slice(before)).toEqual([150]);

    // 打ち込む。ドラムのトラックでは、16 分音符の刻みで置ける (長さも 1 ステップ)
    await placeAt(page, GHOST.kick0);              // キック: 合っている
    await placeAt(page, GHOST.hat0);               // ハイハット: 合っている (キックと同時)
    await placeAt(page, GHOST.snare4, 1);          // スネア: 16 分音符 1 個遅い (位置のずれ)
    await placeAt(page, GHOST.kick8, 0, -9);       // 3 拍目のキックを、タムの行に置いた (キックの抜け + タムの余分)
    await expect(page.locator('#note-layer .note-block')).toHaveCount(4);
    // 置いたときも、その種類の音が鳴る (キック 150・スネアの短い音 240・タム 210。ハイハットはノイズだけ)
    expect((await soundedFrequencies(page)).slice(before + 1)).toEqual([150, 240, 210]);

    await page.getByRole('button', { name: '比べる', exact: true }).click();
    // 一致: 区間 (1〜2 小節) のお手本 9 打のうち、種類と位置が合ったのは キック・ハイハット・スネア (1 個遅れは許容内) の 3 つ
    await expect(page.getByTestId('match-rate')).toHaveText('33%');
    const side = page.getByRole('complementary', { name: 'この区間の指摘' });
    await expect(side.locator('#practice-drum-note')).toContainText('種類（キック・スネアなど）ごとの叩く位置を比べています');
    // 件数: 高さの違い・オクターブ違い・長さの違いは、出ない
    await expect(side.locator('.practice-counts')).toHaveText('抜け 6 / 余分なノート 1 / 位置のずれ 1');
    // 指摘は、種類の名前で書く
    const issues = side.getByRole('list', { name: /指摘の一覧/ });
    await expect(issues.getByRole('button', { name: '1 小節 2 拍目: スネア が16 分音符 1 個ぶん遅い' })).toBeVisible();
    await expect(issues.getByRole('button', { name: '1 小節 3 拍目: キック が抜けています' })).toBeVisible();
    await expect(issues.getByRole('button', { name: '1 小節 3 拍目: タム はお手本にありません' })).toBeVisible();
    await expect(issues.getByRole('button', { name: '1 小節 2 拍目: ハイハット・シンバル が抜けています' })).toBeVisible();
    await expect(issues.getByRole('button', { name: '1 小節 4 拍目: タム が抜けています' })).toBeVisible();

    // ノートの色と名前
    const notes = page.locator('#note-layer');
    await expect(notes.getByRole('img', { name: /^キック: 合っている$/ })).toHaveClass(/diff-ok/);
    await expect(notes.getByRole('img', { name: /^スネア: 位置か長さがずれている。1 小節 2 拍目: スネア が16 分音符 1 個ぶん遅い$/ })).toHaveClass(/diff-rhythm/);
    await expect(notes.getByRole('img', { name: /^タム: お手本にないノート。1 小節 3 拍目: タム はお手本にありません$/ })).toHaveClass(/diff-extra/);
    await expect(notes.getByRole('img', { name: /^お手本 キック: お手本の抜け。1 小節 3 拍目: キック が抜けています$/ })).toHaveClass(/ghost-missing/);
    // 指摘を押すと、そのノートを選んで光らせる
    await issues.getByRole('button', { name: '1 小節 3 拍目: タム はお手本にありません' }).click();
    await expect(notes.locator('.note-block.diff-extra')).toHaveClass(/flash/);

    // アレンジに戻って、差分の段へ
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /⑤ 差分で直す/ }).click();
    // 練習の地図: ドラムの行が出て、比べた区間に一致が出る。まだ比べていない区間は空の升
    const map = page.locator('#practice-map');
    const grid = map.getByRole('grid', { name: '練習の地図' });
    await expect(grid.getByRole('rowheader')).toHaveText(['ボーカル', 'ドラム']);
    const verse = map.getByRole('button', { name: 'ドラム・Aメロ？（1〜2 小節）: 一致 33%' });
    await expect(verse).toHaveText('33%');
    await expect(map.getByRole('button', { name: 'ドラム・サビ？（3〜4 小節）: まだ比べていません' })).toHaveText('');

    // 差分チェック: 曲全体 (お手本 11 打) で比べた結果。Claude の説明のボタンは出さず、決まった文を出す
    const coach = page.locator('#coach-panel');
    await expect(coach.locator('#coach-reference')).toHaveValue(/\d+/);
    await expect(coach).toContainText(/お手本 11 ノートのうち、27% が合っています\s*（位置がぴったり: 2 ノート）/);
    await expect(coach).toContainText('抜け 8 / 余分なノート 1 / 位置のずれ 1');
    await expect(coach.locator('#coach-drum-note')).toContainText('長さは比べません');
    await expect(coach.locator('#coach-drum-explain')).toContainText('ドラムの差分は、Claude の説明には対応していません');
    await expect(coach.getByRole('button', { name: /Claude に説明してもらう/ })).toHaveCount(0);
    await expect(coach.getByRole('list', { name: '指摘の一覧' }).getByRole('button', { name: '1 小節 2 拍目: スネア が16 分音符 1 個ぶん遅い' })).toBeVisible();

    // 差分チェックの段から比べ直しても、同じ比べ方 (同じ結果)
    const again = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/coach/diff');
    await coach.getByRole('button', { name: 'お手本と比べる' }).click();
    expect((await again).postDataJSON().mode).toBe('drums');
    await expect(coach.getByRole('button', { name: 'お手本と比べる' })).toBeEnabled();
    await expect(coach).toContainText(/お手本 11 ノートのうち、27% が合っています\s*（位置がぴったり: 2 ノート）/);
    await expect(coach).toContainText('抜け 8 / 余分なノート 1 / 位置のずれ 1');
});

test('ドラムの差分は、ドラムの比べ方を API に送る。ほかのパートでは送らない', async ({ page }) => {
    const bodies: { mode?: string; reference: unknown[]; timing_tolerance?: number }[] = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/coach/diff') bodies.push(request.postDataJSON());
    });
    await openDaw(page);
    await openDrumPractice(page);
    await placeAt(page, GHOST.kick0);
    await page.getByRole('button', { name: '比べる', exact: true }).click();
    await expect(page.getByTestId('match-rate')).toHaveText('11%');
    // 区間 (1〜2 小節) の比較と、曲全体の比較。どちらもドラムの比べ方で、許容は送らない (API の側が決める)
    expect(bodies.map((b) => [b.mode, b.reference.length, b.timing_tolerance])).toEqual([['drums', 9, undefined], ['drums', 11, undefined]]);

    // ボーカルと比べるときは、ふつうの比べ方
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /⑤ 差分で直す/ }).click();
    const coach = page.locator('#coach-panel');
    await coach.locator('#coach-reference').selectOption({ label: 'ボーカル（1 ノート）' });
    await coach.getByRole('button', { name: 'お手本と比べる' }).click();
    await expect(coach).toContainText('お手本 1 ノートのうち');
    expect(bodies[2].mode).toBeUndefined();
    await expect(coach.locator('#coach-drum-note')).toHaveCount(0);
});

test('「ドラムを種類ごとに分ける」: 追加のモデルが手元に無ければ選ばれておらず、選ぶとダウンロードが入ると出る。選んだとおりに送る', async ({ page }) => {
    let cached = false;
    await page.route('**/api/models/drumsep/status', (route) => route.fulfill({ json: { model: 'drumsep', cached, missing: cached ? 0 : 1 } }));
    const sent: string[] = [];
    await fakeJob(page, '/api/decompose', () => decompose(sent.at(-1) === 'true' ? 'stems' : 'spectral'), (request) => {
        sent.push(/name="split_drums"\r\n\r\n(\w+)\r\n/.exec(request.postData() ?? '')?.[1] ?? '(なし)');
    });
    await openDaw(page);
    await importAndOpenParts(page);

    const box = page.getByRole('checkbox', { name: /ドラムを種類ごとに分ける/ });
    const note = page.locator('#learn-split-drums-note');
    // モデルが手元に無い: 勝手には選ばない (約 160 MB のダウンロードは、利用者が選んだときだけ)
    await expect(box).not.toBeChecked();
    await expect(note).toContainText('分けずに採譜します');
    await expect(note).toContainText('チェックを入れると、初回のみ、追加のモデル（約 160 MB）をダウンロードします');
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました');
    expect(sent).toEqual(['false']);
    // 分けずに採譜した結果も、ドラムはお手本になる
    await expect(page.locator('#part-list .part-item[data-part="drums"]')).toContainText(`お手本 ${DRUM_EVENTS.length} ノート`);
    await expect(statusText(page)).not.toContainText('種類ごとに分けて採譜しました');

    // 選ぶと、ダウンロードが入る旨が出て、分けるよう送る
    await box.check();
    await expect(note).toContainText('初回のみ、追加のモデル（約 160 MB）をダウンロードします。ダウンロードできなければ、分けずに採譜します');
    cached = true;
    await page.getByRole('button', { name: /パートに分け直す/ }).click();
    await expect(statusText(page)).toContainText('ドラムは、種類ごとに分けて採譜しました');
    expect(sent).toEqual(['false', 'true']);
    // ダウンロードが済んだあとは、文が変わる
    await expect(note).toContainText('追加のモデルは、ダウンロード済みです');
});
