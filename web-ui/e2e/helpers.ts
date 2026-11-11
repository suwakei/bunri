/**
 * ブラウザのテストで使う共通の部品。
 */
import type { Page } from '@playwright/test';

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

/** 左パネルのタブを開く。 */
export async function openTab(page: Page, label: string): Promise<void> {
    await page.locator('#panel-tabs').getByRole('button', { name: label, exact: true }).click();
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
