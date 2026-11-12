/**
 * ブラウザのテストで使う共通の部品。
 */
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/** テスト用の小さな MP3 (C4 E4 G4 C5 を 2 秒ずつ、8 秒)。WAV 以外の曲の取り込みを確かめるのに使う。 */
export const SONG_MP3 = fileURLToPath(new URL('./fixtures/song.mp3', import.meta.url));

/** 偽の Claude API サーバ (fake-anthropic.mjs) のポートと URL。playwright.config.ts が起動する。 */
export const FAKE_LLM_PORT = 5198;
export const FAKE_LLM_URL = `http://127.0.0.1:${FAKE_LLM_PORT}`;

/**
 * 初回の案内 (ウェルカムガイド) を出さない状態で DAW の画面を開く。
 * 案内は初めて開いたときだけ出て、画面全体を覆うので、普段のテストでは既読にしておく。
 */
export async function openDaw(page: Page): Promise<void> {
    await page.addInitScript(() => localStorage.setItem('bunri-guide-seen', '1'));
    await page.goto('/');
    await page.getByText('準備完了').waitFor();
}

/**
 * テスト用の WAV ファイル (モノラル 16bit) を作る。
 *
 * @param seconds - 長さ (秒)
 * @param notes - 鳴らす音の周波数 (Hz)。等分して順に鳴らす
 * @param sampleRate - サンプルレート
 */
export function makeWav(seconds: number, notes: number[] = [440], sampleRate = 22050): Buffer {
    const total = Math.floor(seconds * sampleRate);
    const data = Buffer.alloc(total * 2);
    const per = Math.floor(total / notes.length);
    for (let i = 0; i < total; i++) {
        const freq = notes[Math.min(notes.length - 1, Math.floor(i / per))];
        // 音の切れ目でぷつっと鳴らないよう、各音の頭と終わりを短くなだらかにする
        const pos = i % per;
        const edge = Math.min(1, pos / 200, (per - pos) / 200);
        data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000 * edge), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

/** ステータスバーの文 (左側)。 */
export const statusText = (page: Page) => page.locator('#status-text');

/** 左パネルの中の段と、それを持つ上の段のタブ。 */
const SUB_TAB_PARENT: Record<string, string> = {
    '曲とパート': '学ぶ', 'カルテ': '学ぶ', 'ガイド': '学ぶ', '差分': '学ぶ',
    'シンセ': '音作り', 'ドラム': '音作り', 'FX': '音作り',
};

/**
 * 左パネルのタブを開く。上の段のタブ (学ぶ・音作り・ファイル) か、中の段 (カルテ・シンセなど) の名前で指す。
 * 中の段なら、それを持つ上の段のタブを先に開く。
 */
export async function openTab(page: Page, label: string): Promise<void> {
    const parent = SUB_TAB_PARENT[label];
    await page.locator('#panel-tabs').getByRole('tab', { name: parent ?? label, exact: true }).click();
    if (parent) await page.locator('#left-panel [role="tabpanel"]:not([hidden])').getByRole('tab', { name: label, exact: true }).first().click();
}

/**
 * 「自由に作る」で始める (曲を取り込まずに、空のトラックを作る)。
 * 起動したときはトラックが無いので、トラックを使うテストはこれで用意する。
 *
 * @param tracks - 作るトラックの数 (Track 1, Track 2, …)
 */
export async function startFree(page: Page, tracks = 2): Promise<void> {
    await page.getByRole('button', { name: '自由に作る' }).click();
    for (let i = 1; i < tracks; i++) await page.getByRole('button', { name: '+ トラック追加' }).click();
    await page.locator('#tracks-container .track-row').nth(tracks - 1).waitFor();
}

/** 指定したテスト用の音声を、取り込む曲として選ぶ (原曲のファイルの欄。画面には出ていない)。 */
export async function importSong(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    await page.locator('#song-file').setInputFiles(file);
}

/**
 * 鳴らされた音 (オシレータ) の周波数を、鳴らした順に記録する仕掛けを入れる。画面を開く前に呼ぶ。
 * 試し聴き (ノートを置いたとき、鍵盤を押したとき) で、どの高さが鳴ったかを確かめるのに使う。
 * 記録は `soundedFrequencies` で読む。
 */
export async function recordOscillators(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const log: number[] = [];
        (window as unknown as { __oscillators: number[] }).__oscillators = log;
        const start = OscillatorNode.prototype.start;
        OscillatorNode.prototype.start = function (this: OscillatorNode, ...args: [number?]) {
            log.push(Math.round(this.frequency.value * 100) / 100);
            return start.apply(this, args);
        };
    });
}

/** `recordOscillators` を入れてから鳴らされた音の周波数 (Hz。小数 2 桁)。 */
export function soundedFrequencies(page: Page): Promise<number[]> {
    return page.evaluate(() => (window as unknown as { __oscillators: number[] }).__oscillators.slice());
}

/** タイムラインの各トラックの、名前とクリップ名の一覧。 */
export function trackSummary(page: Page): Promise<{ name: string; clips: string[] }[]> {
    return page.locator('#tracks-container .track-row').evaluateAll((rows) => rows.map((row) => ({
        // 名前の後ろにノートの数のバッジが付くので、名前だけを取り出す
        name: (row.querySelector('.track-name')!.firstChild?.textContent ?? '').trim(),
        clips: [...row.querySelectorAll('.clip')].map((c) => c.textContent ?? ''),
    })));
}

/** テスト用の WAV を、ファイル選択に渡す形にする。 */
export function wavFile(name: string, seconds = 2, notes: number[] = [440]) {
    return { name, mimeType: 'audio/wav', buffer: makeWav(seconds, notes) };
}

/**
 * WAV (16bit PCM) の中身を読む。長さ (秒) と、いちばん大きい振幅 (0〜1) を返す。
 * 「音が出ている (無音ではない)」ことを確かめるのに使う。
 */
export function readWav(bytes: Buffer): { seconds: number; peak: number; sampleRate: number; channels: number } {
    if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WAVE') {
        throw new Error('WAV ではありません');
    }
    let pos = 12;
    let sampleRate = 0, channels = 0, bits = 0;
    while (pos + 8 <= bytes.length) {
        const id = bytes.subarray(pos, pos + 4).toString('latin1');
        const size = bytes.readUInt32LE(pos + 4);
        if (id === 'fmt ') {
            channels = bytes.readUInt16LE(pos + 10);
            sampleRate = bytes.readUInt32LE(pos + 12);
            bits = bytes.readUInt16LE(pos + 22);
        } else if (id === 'data') {
            if (bits !== 16) throw new Error(`16bit ではない WAV です (${bits}bit)`);
            const end = Math.min(bytes.length, pos + 8 + size);
            let peak = 0;
            for (let i = pos + 8; i + 1 < end; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
            return { seconds: (end - pos - 8) / 2 / channels / sampleRate, peak: peak / 32768, sampleRate, channels };
        }
        pos += 8 + size + (size % 2);
    }
    throw new Error('WAV に data が在りません');
}
