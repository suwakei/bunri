/** 開発用ブラウザから、リポジトリ直下の music/ だけを読みます。 */
import { readdir, realpath, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const extensions = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.aif', '.aiff']);

async function musicPath(root: string, name: string): Promise<string> {
    if (!name || name.startsWith('.') || path.basename(name) !== name || name.includes('\\') || !extensions.has(path.extname(name).toLowerCase())) {
        throw new Error('曲のファイル名を確認してください');
    }
    if (!(await lstat(root)).isDirectory()) throw new Error('music フォルダを確認してください');
    const base = await realpath(root);
    if (!(await lstat(path.join(base, name))).isFile()) throw new Error('通常の音声ファイルを選んでください');
    const target = await realpath(path.join(base, name));
    if (path.dirname(target) !== base) throw new Error('music フォルダ内の音声ファイルを選んでください');
    return target;
}

export async function listMusic(root: string): Promise<{ name: string }[]> {
    let entries;
    try {
        if (!(await lstat(root)).isDirectory()) throw new Error('music フォルダを確認してください');
        entries = await readdir(root);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const names = await Promise.all(entries.map(async (name) => {
        try { await musicPath(root, name); return { name }; } catch { return null; }
    }));
    return names.filter((entry): entry is { name: string } => entry !== null).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

export async function readMusic(root: string, name: string): Promise<Buffer> {
    return readFile(await musicPath(root, name));
}

export function musicPlugin(root: string): Plugin {
    const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/__music' && url.pathname !== '/__music/file') { next(); return; }
        res.setHeader('Cache-Control', 'no-store');
        // 別サイトからローカルの音源を読ませない。
        if (req.method !== 'GET' || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
            res.statusCode = 403; res.end('この画面から曲を選んでください'); return;
        }
        void (async () => {
            try {
                if (url.pathname === '/__music') {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(await listMusic(root)));
                } else {
                    const body = await readMusic(root, url.searchParams.get('name') ?? '');
                    res.setHeader('Content-Type', 'application/octet-stream');
                    res.end(body);
                }
            } catch {
                res.statusCode = 400;
                res.end('music フォルダを読めませんでした。ファイルがあるか確認して、もう一度お試しください');
            }
        })();
    };
    return {
        name: 'bunri-music',
        configureServer(server) { server.middlewares.use(middleware); },
        configurePreviewServer(server) { server.middlewares.use(middleware); },
    };
}
