/**
 * bunri DAW — 音声の無いクリップの知らせ。
 *
 * 以前の形式のプロジェクト（projects/*.json）は音声を持っていないので、開くとクリップは位置と長さだけになる
 * （無音の置き場所。engine.ts の `Clip.missing`）。ここで、どのクリップかを示し、「音声を読み込み直す」で
 * 手元のファイルを選び直せるようにする。読み込み直しは元に戻せる。
 */
import { useCallback, useRef, useState } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { missingClips } from '../lib/project-file';
import { decodeWithSource } from '../lib/audio-sources';
import { describeError } from '../lib/api';

export default function MissingAudioBar() {
    const { trackVersion, bumpTracks, setStatus, record } = useDaw();
    void trackVersion;
    const inputRef = useRef<HTMLInputElement>(null);
    const [target, setTarget] = useState<{ trackId: number; index: number } | null>(null);
    const list = missingClips();

    const pick = useCallback((trackId: number, index: number) => {
        setTarget({ trackId, index });
        inputRef.current?.click();
    }, []);

    const onFile = useCallback(async (file: File | undefined) => {
        if (!file || !target) return;
        engine.init();
        const track = engine.getTrack(target.trackId);
        const clip = track?.clips[target.index];
        if (!track || !clip) return;
        try {
            const buffer = await decodeWithSource(engine.ctx!, await file.arrayBuffer(), file.name);
            record('音声を読み込み直す', () => {
                track.clips = track.clips.map((c, i) => (i === target.index
                    ? { buffer, offset: c.offset, name: c.name, duration: buffer.duration }
                    : c));
            });
            bumpTracks();
            setStatus(`「${clip.name}」の音声を読み込み直しました`);
        } catch (e) {
            setStatus(`${file.name} を読み込めませんでした。` + describeError(e), 'error');
        } finally {
            if (inputRef.current) inputRef.current.value = '';
        }
    }, [target, record, bumpTracks, setStatus]);

    if (list.length === 0) return null;
    return (
        <div id="missing-audio" role="region" aria-label="音声の無いクリップ">
            <span>音声の無いクリップが {list.length} 個あります（以前の形式のプロジェクトは音声を保存していません）。</span>
            <ul>
                {list.map(({ track, index, clip }) => (
                    <li key={`${track.id}-${index}`}>
                        「{track.name}」の「{clip.name}」
                        <button type="button" className="action-btn secondary" onClick={() => pick(track.id, index)}
                            aria-label={`「${track.name}」の「${clip.name}」の音声を読み込み直す`}>音声を読み込み直す</button>
                    </li>
                ))}
            </ul>
            <input ref={inputRef} type="file" accept=".wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff,audio/*" hidden
                aria-label="読み込み直す音声のファイル" onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
    );
}
