/**
 * MIDI ファイルを読み込む (左パネルの「ファイル」タブ)。
 *
 * MIDI のトラックごとに、新しいトラックにするか、お手本として読み込むか、読み込まないかを選ぶ。
 * 読み込みで元のファイルから変わること (1 拍の 24 分の 1 への丸めなど) は、読み込む前に画面に出る。
 * 三連と 32 分音符の位置は、丸めずにそのまま入る。
 */
import { expect, test, type Page } from '@playwright/test';
import { notesToMidi, parseMidi } from '../src/lib/midi';
import { openDaw, openTab, recordOscillators, soundedFrequencies, startFree, statusText } from './helpers';

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });
const LEAD = [note('C', 4, 0), note('E', 4, 4), note('G', 4, 8), note('C', 5, 12)];
const BASS = [note('E', 1, 0, 8), note('G', 1, 8, 8)];

/** 2 本のトラック (Lead、Bass) を持つ、96 BPM の MIDI ファイル。 */
const twoTracks = () => ({
    name: 'song.mid', mimeType: 'audio/midi',
    buffer: Buffer.from(notesToMidi([{ name: 'Lead', notes: LEAD }, { name: 'Bass', notes: BASS }], 96)),
});

/** バイト列の部品 (手で組む MIDI ファイル用)。 */
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const be32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/**
 * フォーマット 0 の MIDI ファイル (分解能 480)。チャンネル 1 に、人が弾いたように少しずれた位置のノート
 * (1 拍の 24 分の 1 = 20 tick に乗らない)、チャンネル 10 (ドラム) に、とても短いノートが 1 つ。
 */
const drumsAndLoose = () => {
    const events = [
        0x00, 0x90, 60, 100, 0x81, 0x27, 0x80, 60, 0,   // 0〜167 tick (終わりが乗らない)
        0x00, 0x90, 62, 100, 0x81, 0x19, 0x80, 62, 0,   // 167〜320 tick (始まりが乗らない)
        0x00, 0x99, 36, 110, 0x07, 0x89, 36, 0,         // ドラム: 320〜327 tick (32 分音符より短い)
        0x00, 0xff, 0x2f, 0x00,
    ];
    return {
        name: 'groove.mid', mimeType: 'audio/midi',
        buffer: Buffer.from([...ascii('MThd'), ...be32(6), 0, 0, 0, 1, 0x01, 0xe0, ...ascii('MTrk'), ...be32(events.length), ...events]),
    };
};

const chooseFile = (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => page.locator('#file-midi').setInputFiles(file);
const modeOf = (page: Page, track: string) => page.getByLabel(`「${track}」の読み込み方`);
const trackNames = async (page: Page) => (await page.locator('#tracks-container .track-row').evaluateAll((rows) =>
    rows.map((row) => (row.querySelector('.track-name')?.firstChild?.textContent ?? '').trim())));
const bpmField = (page: Page) => page.locator('#transport input[type="number"]');

test('新しいトラックとして読み込むと、MIDI のトラックごとにトラックができ、空のプロジェクトならテンポも合う。元に戻せる', async ({ page }) => {
    await openDaw(page);
    await startFree(page, 1);
    await openTab(page, 'ファイル');
    await chooseFile(page, twoTracks());

    // 読み込む前に、中身と、変わることが出る。まだ何も変わっていない
    const list = page.locator('#midi-track-list li');
    await expect(list).toHaveCount(2);
    await expect(list.nth(0)).toContainText('Lead');
    await expect(list.nth(0)).toContainText('4 ノート');
    await expect(modeOf(page, 'Lead')).toHaveValue('track');
    await expect(page.locator('#midi-tempo-notice')).toHaveText('テンポを、MIDI ファイルの 96 BPM に合わせます');
    // 16 分音符に乗ったノートだけの MIDI ファイルなので、読み込みで変わることは無い
    await expect(page.locator('#midi-loss-list')).toHaveCount(0);
    expect(await trackNames(page)).toEqual(['Track 1']);
    await expect(bpmField(page)).toHaveValue('120');

    await page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toHaveText('song.mid から 2 本のトラックを読み込みました');
    expect(await trackNames(page)).toEqual(['Track 1', 'Lead', 'Bass']);
    await expect(bpmField(page)).toHaveValue('96');
    // 読み込んだら、一覧は閉じる
    await expect(page.locator('#midi-import-plan')).toHaveCount(0);

    // ノートは打ち込みとして入り、ピアノロールで開ける (低い音のトラックも、ノートの在る高さが見える)
    await page.locator('#tracks-container .track-name').nth(2).click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(BASS.length);
    await expect(page.locator('#note-layer .note-block').first()).toBeInViewport();
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(0);

    // まとめて元に戻せる (トラックもテンポも)
    await page.getByRole('button', { name: '元に戻す', exact: true }).first().click();
    expect(await trackNames(page)).toEqual(['Track 1']);
    await expect(bpmField(page)).toHaveValue('120');
});

test('すでにノートが在るプロジェクトでは、テンポを変えない', async ({ page }) => {
    await openDaw(page);
    await startFree(page, 1);
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 800 } });
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);

    await openTab(page, 'ファイル');
    await chooseFile(page, twoTracks());
    await expect(page.locator('#midi-tempo-notice')).toContainText('いまのテンポ（120 BPM）は変えません');
    await page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toContainText('2 本のトラックを読み込みました');
    await expect(bpmField(page)).toHaveValue('120');
});

test('お手本として読み込むと、パートの一覧に出て、「このパートを練習する」で練習画面が開き、再生するとお手本の音が鳴る', async ({ page }) => {
    await recordOscillators(page);
    await openDaw(page);
    await startFree(page, 1);
    await openTab(page, 'ファイル');
    await chooseFile(page, twoTracks());
    await modeOf(page, 'Lead').selectOption('reference');
    await modeOf(page, 'Bass').selectOption('skip');
    await page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toContainText('song.mid から 1 本のお手本を読み込みました');
    expect(await trackNames(page)).toEqual(['Track 1', 'Lead']);

    // お手本は打ち込みにはならない (トラックの見出しに、ノートの数の印が付かない)
    await expect(page.locator('#tracks-container .track-row').nth(1).locator('.notes-badge')).toHaveCount(0);

    // 再生すると、お手本のノートが鳴る (MIDI のお手本には音声が無いので、ノートを鳴らす)。C4 = 261.63 Hz
    await page.locator('#btn-play').click();
    await expect.poll(() => soundedFrequencies(page)).toContain(261.63);
    await page.getByRole('button', { name: '停止', exact: true }).click();

    // 「学ぶ」のパートの一覧に出る
    await openTab(page, '学ぶ');
    const part = page.locator('#part-list li').filter({ hasText: 'Lead' });
    await expect(part).toContainText(`お手本 ${LEAD.length} ノート`);
    // 原曲から分けたパートは無いので、「分け直す」とは出さない
    await expect(page.getByRole('button', { name: /パートに分けて採譜する/ })).toBeVisible();
    await part.getByRole('button', { name: '「Lead」を練習する' }).click();

    // 練習画面が開き、お手本が水色で重なる。自分の打ち込みは空から始まる
    await expect(page.getByRole('button', { name: '← アレンジに戻る' })).toBeVisible();
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(LEAD.length);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(0);
});

test('ドラムは既定で読み込まない。丸めたノートの数が出る。全部「読み込まない」なら読み込めない', async ({ page }) => {
    await openDaw(page);
    await startFree(page, 1);
    await openTab(page, 'ファイル');
    await chooseFile(page, drumsAndLoose());

    const list = page.locator('#midi-track-list li');
    await expect(list).toHaveCount(2);
    await expect(list.nth(1)).toContainText('（ドラム）');
    await expect(list.nth(1)).toContainText('打楽器の種類を表します');
    const drum = list.nth(1).locator('select');
    await expect(drum).toHaveValue('skip');
    // ドラムは、お手本にできない
    await expect(drum.locator('option')).toHaveText(['新しいトラックにする', '読み込まない']);
    // 丸めた数は、読み込むトラックのぶんだけ (メロディの 2 個。ドラムの 1 個は、読み込まないので数えない)
    await expect(page.locator('#midi-loss-list')).toContainText('位置か長さを、1 拍の 24 分の 1 に丸めたノートが 2 個あります');
    // 16 分音符には寄せない (三連・32 分は、そのまま入る) ことも伝える
    await expect(page.locator('#midi-loss-list')).toContainText('16 分・32 分・三連の位置は、そのまま入ります');
    await expect(page.locator('#midi-tempo-notice')).toContainText('テンポが書かれていません');

    await list.nth(0).locator('select').selectOption('skip');
    await expect(page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true })).toBeDisabled();

    // ドラムを新しいトラックとして読み込むことはできる。選ぶと、ドラムのぶんの丸めが出る
    await drum.selectOption('track');
    await expect(page.locator('#midi-loss-list')).toContainText('丸めたノートが 1 個あります');
    await page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toContainText('groove.mid から 1 本のトラックを読み込みました');
});

test('三連と 32 分音符の MIDI ファイルは、位置がそのまま入る (16 分音符に寄らない)。書き出しても、位置は変わらない', async ({ page }) => {
    // 1 拍目に 8 分の三連が 3 つ、2 拍目に 32 分音符が 2 つ、3 拍目の頭に 4 分音符
    const SHUFFLE = [
        note('C', 4, 0, 4 / 3), note('D', 4, 4 / 3, 4 / 3), note('E', 4, 8 / 3, 4 / 3),
        note('F', 4, 4, 0.5), note('G', 4, 4.5, 0.5), note('A', 4, 8, 4),
    ];
    const source = Buffer.from(notesToMidi([{ name: 'Shuffle', notes: SHUFFLE }], 100));
    await openDaw(page);
    await startFree(page, 1);
    await openTab(page, 'ファイル');
    await chooseFile(page, { name: 'shuffle.mid', mimeType: 'audio/midi', buffer: source });
    await expect(page.locator('#midi-track-list li')).toHaveCount(1);
    // 丸めたノートは無い (「読み込みで変わること」に、丸めの行が出ない)
    await expect(page.locator('#midi-import-plan')).not.toContainText('丸めたノート');
    await page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toContainText('shuffle.mid から 1 本のトラックを読み込みました');

    // ピアノロールで開くと、三連と 32 分の位置のまま (小数のステップは、小数 2 桁で出る)
    await page.locator('#tracks-container .track-name').filter({ hasText: 'Shuffle' }).click();
    await expect(page.locator('#note-layer .note-block')).toHaveCount(SHUFFLE.length);
    const placed = await page.locator('#note-layer .note-block').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.note ?? ''));
    expect(placed.map((text) => text.replace(/ 強さ:\d+$/, ''))).toEqual([
        'C4 step:0 len:1.33', 'D4 step:1.33 len:1.33', 'E4 step:2.67 len:1.33',
        'F4 step:4 len:0.5', 'G4 step:4.5 len:0.5', 'A4 step:8 len:4',
    ]);
    // 三連の 2 つ目は、1 拍 (4 ステップ = 80px) の 3 分の 1 の位置に描かれる
    const first = (await page.locator('#note-layer .note-block').nth(0).boundingBox())!;
    const second = (await page.locator('#note-layer .note-block').nth(1).boundingBox())!;
    expect(second.x - first.x).toBeCloseTo(80 / 3, 0);

    // 書き出すと、ノートの位置 (tick) が、読み込んだファイルと同じ (空の Track 1 は書き出されない)
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'MIDI 書き出し', exact: true }).click();
    const stream = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const back = parseMidi(new Uint8Array(Buffer.concat(chunks)));
    const original = parseMidi(new Uint8Array(source));
    expect(back.tracks).toHaveLength(1);
    expect(back.tracks[0].notes).toEqual(original.tracks[0].notes);
    expect(back.tracks[0].notes.map((n) => n.step)).toEqual(SHUFFLE.map((n) => n.step));
    expect(back.loss.rounded).toBe(0);
});

test('MIDI ファイルでないものを選ぶと、理由を付けて断る', async ({ page }) => {
    await openDaw(page);
    await startFree(page, 1);
    await openTab(page, 'ファイル');
    await chooseFile(page, { name: 'broken.mid', mimeType: 'audio/midi', buffer: Buffer.from('これは MIDI ではありません') });
    await expect(statusText(page)).toHaveText('broken.mid を読み込めませんでした。MIDI ファイルではありません');
    await expect(page.locator('#midi-import-plan')).toHaveCount(0);
    expect(await trackNames(page)).toEqual(['Track 1']);
});
