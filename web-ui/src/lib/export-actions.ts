/**
 * bunri DAW — 書き出し（WAV・MIDI）。ヘッダのボタン（components/HeaderBar.tsx）と、アシスタントのツール
 * （lib/assistant-tools-app.ts）が、同じ処理を使う。
 *
 * ファイルは、ダウンロードとして渡す。デスクトップアプリでは、窓を出さずに「ダウンロード」フォルダに入る
 * （src-tauri の `on_download`）。ブラウザでは、ブラウザのダウンロードになる。
 */
import engine from './engine';
import { describeError } from './api';
import { notesToMidi } from './midi';

/** 書き出しの結果。失敗は、利用者にそのまま見せられる文。 */
export type ExportOutcome = { ok: true; fileName: string; message: string } | { ok: false; message: string };

/** WAV の書き出しのファイル名。 */
export const WAV_FILE_NAME = 'bunri_mix.wav';
/** MIDI の書き出しのファイル名。 */
export const MIDI_FILE_NAME = 'bunri.mid';

/** バイト列を、その名前のファイルとしてダウンロードに渡す。 */
function download(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

/**
 * 書き出せるかを確かめる（WAV）。書き出せなければ、理由の文。
 * 書き出すのは、再生で鳴るもの（クリップと、ピアノロールのノート）。
 */
export function wavExportBlocker(): string | null {
    if (engine.getTotalDuration() === 0) return '書き出すものがありません。クリップかノートを置いてください';
    if (engine.audibleTracks().length === 0) return '鳴らすトラックがありません。ミュートを外してから書き出してください';
    return null;
}

/**
 * 再生で鳴る音をまとめて、1 つの WAV ファイルに書き出す。
 * 呼ぶ前に、ピアノロールの手元のノートを書き戻しておく（`_saveToEngine`）。
 */
export async function exportMixWav(): Promise<ExportOutcome> {
    engine.init();
    const blocker = wavExportBlocker();
    if (blocker) return { ok: false, message: blocker };
    let blob: Blob | null;
    try {
        blob = await engine.exportWav();
    } catch (e) {
        return { ok: false, message: 'WAV を書き出せませんでした（' + describeError(e) + '）' };
    }
    if (!blob) return { ok: false, message: 'WAV を書き出せませんでした。もう一度試してください' };
    download(blob, WAV_FILE_NAME);
    return { ok: true, fileName: WAV_FILE_NAME, message: 'WAV ファイルを書き出しました' };
}

/**
 * ピアノロールのノートを、標準 MIDI ファイルとして書き出す。ノートの在るトラックを 1 本ずつ MIDI のトラックにする。
 * 呼ぶ前に、ピアノロールの手元のノートを書き戻しておく（`_saveToEngine`）。
 */
export function exportMidiFile(): ExportOutcome {
    try {
        const bytes = notesToMidi(engine.tracks.map((t) => ({ name: t.name, notes: t.pianoNotes || [] })), engine.bpm);
        download(new Blob([bytes as BlobPart], { type: 'audio/midi' }), MIDI_FILE_NAME);
        return { ok: true, fileName: MIDI_FILE_NAME, message: 'MIDI ファイルを書き出しました' };
    } catch (e) {
        return {
            ok: false,
            message: (e as Error).message === '書き出せるノートがありません'
                ? '書き出すノートがありません。ピアノロールにノートを置いてください'
                : 'MIDI ファイルを書き出せませんでした（' + describeError(e) + '）',
        };
    }
}
