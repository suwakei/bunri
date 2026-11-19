/** 最初の画面から選べる music/ の曲。解析と取り込みは通常のファイルと同じ経路を使います。 */
import { invokeDesktop, isDesktop } from './api';

export interface MusicEntry { name: string }

async function musicFetch(url: string): Promise<Response> {
    const response = await fetch(url);
    if (!response.ok) throw new Error('music フォルダを読めませんでした。ファイルを確認して、一覧を更新してください');
    return response;
}

export async function listMusic(): Promise<MusicEntry[]> {
    if (isDesktop()) return invokeDesktop<MusicEntry[]>('music_list');
    return (await musicFetch('/__music')).json();
}

export async function readMusic(name: string): Promise<File> {
    const bytes = isDesktop()
        ? await invokeDesktop<ArrayBuffer | number[]>('music_read', { name })
        : await (await musicFetch(`/__music/file?name=${encodeURIComponent(name)}`)).arrayBuffer();
    return new File([Array.isArray(bytes) ? new Uint8Array(bytes) : bytes], name);
}
