/**
 * bunri DAW — 音声の無いクリップの知らせ。
 *
 * 以前の形式のプロジェクト（projects/*.json）は音声を持っていないので、開くとクリップは位置と長さだけになる
 * （無音の置き場所。engine.ts の `Clip.missing`）。ここで、どのクリップかを示し、「音声を読み込み直す」で
 * 手元のファイルを選び直せるようにする。読み込み直しは元に戻せる。
 *
 * クリップの位置・鳴らす範囲・フェードは残し、範囲が新しい音声の長さを超えないようにする（lib/clip.ts の
 * `fitClipToBuffer`）。分割や複製で同じ音声を指しているクリップは、まとめて読み込み直す。
 */
import { useRef } from 'react';
import { useDaw } from '../lib/store';
import engine, { type Clip, type Track } from '../lib/engine';
import { missingClips } from '../lib/project-file';
import { decodeWithSource } from '../lib/audio-sources';
import { fitClipToBuffer } from '../lib/clip';
import { describeError } from '../lib/api';
import { tip } from '../lib/tooltip';

/** 音声の無いクリップ 1 つの行。ファイルを選ぶ欄は行ごとに持つ（どのクリップに読み込むかを取り違えない）。 */
function MissingRow({ track, clip, onFile }: { track: Track; clip: Clip; onFile: (file: File) => void }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const label = `「${track.name}」の「${clip.name}」`;
    return (
        <li>
            {label}
            <button type="button" className="action-btn secondary" onClick={() => inputRef.current?.click()}
                aria-label={`${label}の音声を読み込み直す`}
                {...tip('このクリップの音声ファイルが見つからないので、ファイルを選び直します')}>音声を読み込み直す</button>
            <input ref={inputRef} type="file" accept=".wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff,audio/*" hidden
                aria-label={`${label}に読み込む音声のファイル`}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
        </li>
    );
}

export default function MissingAudioBar() {
    const { trackVersion, bumpTracks, setStatus, record } = useDaw();
    void trackVersion;
    const list = missingClips();

    const replace = async (track: Track, clip: Clip, file: File) => {
        engine.init();
        try {
            const buffer = await decodeWithSource(engine.ctx!, await file.arrayBuffer(), file.name);
            record('音声を読み込み直す', () => {
                // 同じ音声を指すクリップ (分割・複製したもの) も、一緒に差し替える。音声の無い印は外す
                const reload = (c: Clip): Clip => {
                    if (c !== clip && !(c.missing && c.buffer === clip.buffer)) return c;
                    const { missing: _missing, ...rest } = c;
                    return fitClipToBuffer({ ...rest, buffer }, buffer);
                };
                for (const t of engine.tracks) {
                    if (t === track || t.clips.some((c) => c.missing && c.buffer === clip.buffer)) t.clips = t.clips.map(reload);
                }
            });
            bumpTracks();
            setStatus(`「${clip.name}」の音声を読み込み直しました`);
        } catch (e) {
            setStatus(`${file.name} を読み込めませんでした。` + describeError(e), 'error');
        }
    };

    if (list.length === 0) return null;
    return (
        <div id="missing-audio" role="region" aria-label="音声の無いクリップ">
            <span>音声の無いクリップが {list.length} 個あります（以前の形式のプロジェクトは音声を保存していません）。</span>
            <ul>
                {list.map(({ track, index, clip }) => (
                    <MissingRow key={`${track.id}-${index}`} track={track} clip={clip} onFile={(f) => void replace(track, clip, f)} />
                ))}
            </ul>
        </div>
    );
}
