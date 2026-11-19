/**
 * bunri DAW — クリップのフェードの長さを、秒で決める窓。
 *
 * クリップのメニューの「フェード…」で開く。フェードは、クリップの上の角のつまみをドラッグしても付けられるが、
 * つまみはマウスでしか動かせないので、キーボードだけで使う経路として、秒を打って決められるようにする
 * （細かい値をそろえたいときにも使う）。決めるのは、つまみと同じ処理（`TimelineEngine.setClipFades` →
 * lib/clip.ts の `setClipFades`）で、1 回の「元に戻す」で戻る。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import engine from '../lib/engine';
import { fadeInOf, fadeOutOf, formatSeconds, playLength } from '../lib/clip';
import { useDialog } from '../lib/dialog';
import { tip } from '../lib/tooltip';

/** 窓が指すクリップ。 */
export interface FadeTarget {
    trackId: number;
    clipIndex: number;
}

/** タイムラインのうち、この窓が使うところ。 */
interface FadeTimeline {
    container: HTMLElement | null;
    setClipFades: (trackId: number, clipIndex: number, fades: { fadeIn?: number; fadeOut?: number }) => boolean;
}

/** 入力欄の文字を、秒数にする（空は 0。数でない・負の値は null）。 */
function parseSeconds(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return 0;
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * フェードの長さを決める窓。
 * @param target - 対象のクリップ
 * @param timelineRef - タイムライン（ストアの `timelineRef`。中身は、押したときに読む）
 * @param onClose - 閉じるとき
 */
export default function ClipFadeDialog({ target, timelineRef, onClose }: { target: FadeTarget; timelineRef: { current: FadeTimeline | null }; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const clip = engine.getTrack(target.trackId)?.clips[target.clipIndex];
    const length = clip ? playLength(clip) : 0;
    // 開いたときの値。欄には小数 2 桁に丸めて出すが、触っていない欄は、丸めた値ではなく元の値のまま扱う
    // (ドラッグで付けた 0.337 秒を、決めただけで 0.34 秒に書き換えない)
    const [initial] = useState(() => {
        const inSec = clip ? fadeInOf(clip) : 0, outSec = clip ? fadeOutOf(clip) : 0;
        return { inSec, outSec, inText: formatSeconds(inSec), outText: formatSeconds(outSec) };
    });
    const [fadeIn, setFadeIn] = useState(initial.inText);
    const [fadeOut, setFadeOut] = useState(initial.outText);
    const [problem, setProblem] = useState<string | null>(null);

    // 閉じる処理は、同じ関数のまま持つ（`useDialog` は、関数が替わるたびにフォーカスを最初の欄へ移し直すため）
    const latest = useRef({ onClose, target });
    useEffect(() => { latest.current = { onClose, target }; });
    /** 閉じて、開く前に居たクリップへフォーカスを戻す（描き直しで要素が替わるので、閉じた後に探す）。 */
    const close = useCallback(() => {
        const now = latest.current;
        now.onClose();
        requestAnimationFrame(() => {
            timelineRef.current?.container?.querySelector<HTMLElement>(`.clip[data-track-id="${now.target.trackId}"][data-clip-index="${now.target.clipIndex}"]`)?.focus();
        });
    }, [timelineRef]);
    useDialog(ref, true, close);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        // 触っていない欄 (開いたときの文字のまま) は送らない (`setClipFades` は、渡さなかったほうを変えない)
        const inTouched = fadeIn !== initial.inText, outTouched = fadeOut !== initial.outText;
        const a = inTouched ? parseSeconds(fadeIn) : initial.inSec, b = outTouched ? parseSeconds(fadeOut) : initial.outSec;
        if (a === null || b === null) { setProblem('0 以上の秒数を入れてください'); return; }
        // 2 つのフェードは重ねられない。合計 (送るほうは新しい値、送らないほうは元の値) がクリップの長さを超えるときは、決めずに理由を出す
        if ((inTouched || outTouched) && a + b > length + 1e-9) {
            setProblem(`フェードインとフェードアウトを合わせて、クリップの長さ（${formatSeconds(length)} 秒）までにしてください`);
            return;
        }
        const fades: { fadeIn?: number; fadeOut?: number } = {};
        if (inTouched) fades.fadeIn = a;
        if (outTouched) fades.fadeOut = b;
        // どちらも変えていなければ、何もせずに閉じる
        if (inTouched || outTouched) timelineRef.current?.setClipFades(target.trackId, target.clipIndex, fades);
        close();
    };

    if (!clip) return null;
    return (
        <div className="project-overlay">
            <div className="project-modal clip-fade-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="clip-fade-title" tabIndex={-1}>
                <h2 id="clip-fade-title">クリップ「{clip.name}」のフェード</h2>
                {/* 値の確かめは自分で行い、理由を文で出す（ブラウザの吹き出しに任せない） */}
                <form onSubmit={submit} noValidate>
                    <div className="clip-fade-fields">
                        <label htmlFor="clip-fade-in">フェードイン（秒）</label>
                        <input id="clip-fade-in" type="number" min={0} max={formatSeconds(length)} step={0.1} value={fadeIn} data-autofocus
                            onChange={(e) => { setFadeIn(e.target.value); setProblem(null); }} onFocus={(e) => e.target.select()}
                            {...tip('頭の音量を、この秒数をかけて、だんだん上げます。0 で外れます')} />
                        <label htmlFor="clip-fade-out">フェードアウト（秒）</label>
                        <input id="clip-fade-out" type="number" min={0} max={formatSeconds(length)} step={0.1} value={fadeOut}
                            onChange={(e) => { setFadeOut(e.target.value); setProblem(null); }} onFocus={(e) => e.target.select()}
                            {...tip('終わりの音量を、この秒数をかけて、だんだん下げます。0 で外れます')} />
                    </div>
                    <p className="note-text">クリップの長さは {formatSeconds(length)} 秒です。0 にすると、フェードが外れます。</p>
                    {problem && <p className="clip-fade-problem" role="alert">{problem}</p>}
                    <div className="project-actions">
                        <button type="submit" className="action-btn primary" {...tip('この長さでフェードを付けます。「元に戻す」で戻せます')}>フェードを決める</button>
                        <button type="button" className="action-btn secondary" onClick={close}
                            {...tip('何も変えずに、元の画面に戻ります')}>キャンセル</button>
                    </div>
                </form>
            </div>
        </div>
    );
}
