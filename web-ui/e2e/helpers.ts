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
