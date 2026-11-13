/**
 * MIDI ファイルを読み込む (左パネルの「ファイル」タブ)。
 *
 * MIDI のトラックごとに、新しいトラックにするか、お手本として読み込むか、読み込まないかを選ぶ。
 * 読み込みで元のファイルから変わること (16 分音符への丸めなど) は、読み込む前に画面に出る。
 */
import { expect, test, type Page } from '@playwright/test';
import { notesToMidi } from '../src/lib/midi';
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
 * フォーマット 0 の MIDI ファイル。チャンネル 1 に 3 連符の位置のノート (16 分音符に乗らない)、
 * チャンネル 10 (ドラム) にノートが 1 つ。
 */
const drumsAndTriplets = () => {
    const events = [
        0x00, 0x90, 60, 100, 0x81, 0x20, 0x80, 60, 0,   // 0〜160 tick (3 連符の長さ)
        0x00, 0x90, 62, 100, 0x81, 0x20, 0x80, 62, 0,   // 160〜320 tick
        0x00, 0x99, 36, 110, 0x78, 0x89, 36, 0,         // ドラム
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
    await page.locator('#transport button[title="停止"]').click();

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
    await chooseFile(page, drumsAndTriplets());

    const list = page.locator('#midi-track-list li');
    await expect(list).toHaveCount(2);
    await expect(list.nth(1)).toContainText('（ドラム）');
    await expect(list.nth(1)).toContainText('打楽器の種類を表します');
    const drum = list.nth(1).locator('select');
    await expect(drum).toHaveValue('skip');
    // ドラムは、お手本にできない
    await expect(drum.locator('option')).toHaveText(['新しいトラックにする', '読み込まない']);
    // 丸めた数は、読み込むトラックのぶんだけ (メロディの 2 個。ドラムの 1 個は、読み込まないので数えない)
    await expect(page.locator('#midi-loss-list')).toContainText('16 分音符に合わせて、位置か長さを丸めたノートが 2 個あります');
    await expect(page.locator('#midi-tempo-notice')).toContainText('テンポが書かれていません');

    await list.nth(0).locator('select').selectOption('skip');
    await expect(page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true })).toBeDisabled();

    // ドラムを新しいトラックとして読み込むことはできる。選ぶと、ドラムのぶんの丸めが出る
    await drum.selectOption('track');
    await expect(page.locator('#midi-loss-list')).toContainText('丸めたノートが 1 個あります');
    await page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toContainText('groove.mid から 1 本のトラックを読み込みました');
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
