/**
 * MIDI キーボード入力: 弾いた強さ（ベロシティ）がノートに残ること、録音前のカウント、遅れの補正の欄。
 *
 * 鍵盤は、ブラウザの Web MIDI API を偽の機器に差し替えて弾く（`__midiSend`）。本物の鍵盤とネイティブ側
 * （デスクトップ版）は、ここでは確かめられない。
 */
import { expect, test, type Page } from '@playwright/test';
import { parseMidi } from '../src/lib/midi';
import { openDaw, openProject, recordOscillators, saveProject, soundedFrequencies, startFree } from './helpers';

/** 偽の MIDI 鍵盤を 1 台つなぐ。画面を開く前に呼ぶ。 */
async function fakeKeyboard(page: Page) {
    await page.addInitScript(() => {
        const input: { name: string; state: string; onmidimessage: null | ((e: { data: Uint8Array; timeStamp: number }) => void) } =
            { name: 'E2E Keys', state: 'connected', onmidimessage: null };
        (window as unknown as { __midiSend: (bytes: number[]) => void }).__midiSend =
            (bytes) => input.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp: performance.now() });
        (navigator as unknown as { requestMIDIAccess: unknown }).requestMIDIAccess =
            async () => ({ inputs: { forEach: (fn: (i: typeof input) => void) => fn(input) }, onstatechange: null });
    });
}
const send = (page: Page, bytes: number[]) => page.evaluate((b) => (window as unknown as { __midiSend: (bytes: number[]) => void }).__midiSend(b), bytes);
const press = async (page: Page, pitch: number, velocity: number) => { await send(page, [0x90, pitch, velocity]); await send(page, [0x80, pitch, 0]); };

/** Track 1 を開いて、MIDI 入力をつなぐ。 */
async function connect(page: Page) {
    await openDaw(page);
    await startFree(page, 1);
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#midi-input-bar').getByRole('button', { name: 'MIDI 入力', exact: true }).click();
    await expect(page.locator('#midi-input-bar')).toContainText('E2E Keys');
}

const notes = (page: Page) => page.locator('#note-layer .note-block');

test('弾いた強さがノートに残り、保存して開き直しても、MIDI に書き出しても残る', async ({ page }) => {
    await fakeKeyboard(page);
    await connect(page);
    // ステップ入力 (既定): 弱く C4、強く E4
    await press(page, 60, 30);
    await press(page, 64, 120);
    await expect(notes(page)).toHaveCount(2);
    await expect(notes(page).nth(0)).toHaveAttribute('data-note', /^C4 step:0 len:4 強さ:30$/);
    await expect(notes(page).nth(1)).toHaveAttribute('data-note', /^E4 step:4 len:4 強さ:120$/);
    // 弱いノートのほうが薄く見える
    const opacity = (index: number) => notes(page).nth(index).evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(await opacity(0)).toBeLessThan(await opacity(1));

    // マウスで置いたノートは、強さを持たない (これまでどおりの見え方)
    await page.locator('#note-layer').dblclick({ position: { x: 330, y: 700 } });
    await expect(notes(page)).toHaveCount(3);
    await expect(notes(page).nth(2)).not.toHaveAttribute('data-note', /強さ/);

    // MIDI に書き出すと、強さが入る。強さを持たないノートは 96
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'MIDI 書き出し', exact: true }).click();
    const stream = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const exported = parseMidi(new Uint8Array(Buffer.concat(chunks))).tracks[0].notes;
    expect(exported.map((n) => n.velocity).sort((a, b) => a - b)).toEqual([30, 96, 120]);

    // 保存して、画面を開き直して、開く
    const name = await saveProject(page, `e2e-velocity-${Date.now()}`);
    await page.reload();
    await page.getByText('準備完了').waitFor();
    await openProject(page, name);
    await page.locator('#tracks-container .track-name').first().click();
    await expect(notes(page)).toHaveCount(3);
    await expect(notes(page).nth(0)).toHaveAttribute('data-note', /強さ:30$/);
    await expect(notes(page).nth(1)).toHaveAttribute('data-note', /強さ:120$/);
    await expect(notes(page).nth(2)).not.toHaveAttribute('data-note', /強さ/);
});

test('リアルタイム録音は、1 小節ぶんのカウントのあとから録る。カウントの間に弾いた音は録らない', async ({ page }) => {
    await recordOscillators(page);
    await fakeKeyboard(page);
    await connect(page);
    await page.getByLabel('録り方').selectOption('realtime');
    // 既定でカウントが入る。遅れの補正の欄が出る
    await expect(page.getByLabel('録音前にカウント')).toBeChecked();
    await page.getByLabel('遅れの補正（ミリ秒）').fill('0');
    await expect(page.getByRole('button', { name: 'おまかせに戻す' })).toBeVisible();

    await page.locator('#btn-play').click();
    // クリックが 4 つ (最初だけ高い音)。まだ曲は進んでいない
    await expect.poll(() => soundedFrequencies(page)).toEqual([1500, 1000, 1000, 1000]);
    await expect(page.locator('#time-display')).toHaveText('0:00.0');
    // カウントの間に弾いても録らない (弾いた音は鳴る)。「再生してから弾いてください」とも出さない
    await press(page, 60, 100);
    await expect(notes(page)).toHaveCount(0);
    await expect(page.locator('#status-text')).not.toContainText('再生してから弾いてください');

    // カウント (120 BPM の 4 拍 = 2 秒) が終わると、曲が進み始める。そこから弾いた音は録る
    await expect(page.locator('#time-display')).not.toHaveText('0:00.0', { timeout: 15_000 });
    await send(page, [0x90, 62, 77]);
    await page.waitForTimeout(300);
    await send(page, [0x80, 62, 0]);
    await expect(notes(page)).toHaveCount(1);
    await expect(notes(page).first()).toHaveAttribute('data-note', /^D4 step:\d+ len:\d+ 強さ:77$/);
    await page.getByRole('button', { name: '停止', exact: true }).click();

    // カウントを外すと、すぐに曲が進む
    await page.getByLabel('録音前にカウント').uncheck();
    const before = (await soundedFrequencies(page)).length;
    await page.locator('#btn-play').click();
    await expect(page.locator('#time-display')).not.toHaveText('0:00.0', { timeout: 5_000 });
    // 置いたノート (D4) は鳴るが、カウントのクリック (1500 / 1000 Hz) は鳴らない
    const after = (await soundedFrequencies(page)).slice(before);
    expect(after.filter((f) => f === 1500 || f === 1000)).toEqual([]);
    await page.getByRole('button', { name: '停止', exact: true }).click();
});
