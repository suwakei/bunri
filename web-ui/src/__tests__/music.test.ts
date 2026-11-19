import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listMusic as listLocal, readMusic as readLocal } from '../../music-plugin';
import { listMusic, readMusic } from '../lib/music';

const dirs: string[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('music フォルダ', () => {
    it('対応音声だけを並べ、外へのリンク・ディレクトリ・パスの逸脱を受け付けない', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'bunri-music-')); dirs.push(root);
        const music = path.join(root, 'music'); await mkdir(music);
        await Promise.all([
            writeFile(path.join(music, '練習曲.MP3'), 'audio'),
            writeFile(path.join(music, 'readme.txt'), 'text'),
            writeFile(path.join(music, '.hidden.wav'), 'hidden'),
            writeFile(path.join(root, 'outside.wav'), 'outside'),
            mkdir(path.join(music, 'directory.wav')),
        ]);
        await symlink(path.join(root, 'outside.wav'), path.join(music, 'link.wav'));
        expect(await listLocal(music)).toEqual([{ name: '練習曲.MP3' }]);
        expect((await readLocal(music, '練習曲.MP3')).toString()).toBe('audio');
        await expect(readLocal(music, '../outside.wav')).rejects.toThrow();
        await expect(readLocal(music, 'link.wav')).rejects.toThrow();
        await expect(readLocal(music, 'directory.wav')).rejects.toThrow();
        expect(await listLocal(path.join(root, 'missing'))).toEqual([]);
        await symlink(music, path.join(root, 'linked-music'));
        await expect(listLocal(path.join(root, 'linked-music'))).rejects.toThrow();
        await expect(readLocal(path.join(root, 'linked-music'), '練習曲.MP3')).rejects.toThrow();
    });

    it('デスクトップの一覧とバイト列を取り込み用 File にする', async () => {
        const invoke = vi.fn().mockResolvedValueOnce([{ name: '曲.mp3' }]).mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer);
        vi.stubGlobal('__TAURI__', { core: { invoke } });
        expect(await listMusic()).toEqual([{ name: '曲.mp3' }]);
        const file = await readMusic('曲.mp3');
        expect(file.name).toBe('曲.mp3'); expect(file.size).toBe(3);
        expect(invoke).toHaveBeenLastCalledWith('music_read', { name: '曲.mp3' });
    });

    it('ブラウザの読めないファイルを成功扱いにしない', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
        await expect(readMusic('消えた曲.wav')).rejects.toThrow('一覧を更新');
    });
});
