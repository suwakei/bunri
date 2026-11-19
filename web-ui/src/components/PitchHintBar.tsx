/**
 * bunri DAW — 「キーの音」「コードの音」の切り替え（ピアノロールの見出し行に出す。練習画面でも同じもの）。
 *
 * カルテ（第1層。信号処理の事実）のキーとコード進行を、ピアノロールの行の色として出す。
 * 打ち込むときに「いまのキーで使う音」「いま鳴っているコードの音」が、行を見るだけで分かるようにするためのもの。
 * Claude は呼ばない。
 *
 * - キーの音: キーの音階に入る高さの行を、金色（`--accent`）でごく薄く塗る。主音の行は少し濃い。鍵盤の列にも同じしるし
 * - コードの音: コードの区間の幅だけ、構成音の高さの行を、青緑（`--secondary`）で薄く塗る。ルートの行は少し濃い
 * - どちらも既定は ON。選んだ状態は、利用者ごとに覚える（localStorage。「再生位置を追う」と同じ覚え方）
 * - カルテが無い（自由に作る）・キーやコードが取れていない・ドラムのトラックでは、押せない状態にして、理由を説明に出す。
 *   押せないボタンを押したときは、同じ理由を知らせとして出す（`blockedBy`。lib/notice.ts）
 *
 * 計算は `lib/pitch-hints.ts`、描くのは `CenterArea.tsx` の `PianoRollEngine`（`setPitchHints`）。
 * この部品は、切り替えの状態を持ち、いま出すものをピアノロールに渡すだけ。
 * ボタンの中の小さな色の札が、どの色が何かの凡例を兼ねる。
 */
import { useEffect, useMemo, useState } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { tip } from '../lib/tooltip';
import { blockedBy } from '../lib/notice';
import {
    chordRegions, isDrumTrack, keyHint, readPitchHintPrefs, writePitchHintPref,
    type PitchHintKind, type PitchHintPrefs,
} from '../lib/pitch-hints';

/** ドラムのトラックで押せない理由（2 つのボタンで同じ）。 */
const DRUM_REASON = 'ドラムのトラックでは、行の高さが音階を表さないので、キーの音とコードの音は出しません';

/**
 * 「キーの音」「コードの音」の切り替え。
 *
 * @param activeTrackId - ピアノロールで開いているトラックの ID（開いていなければ null。そのあいだは出さない）
 */
export default function PitchHintBar({ activeTrackId }: { activeTrackId: number | null }) {
    // trackVersion を読んでおくと、トラックの役割が変わったとき（元に戻す・開き直す）に描き直される
    const { chart, bpm, beatsPerBar, gridOffset, pianoRollRef, trackVersion } = useDaw();
    const [prefs, setPrefs] = useState<PitchHintPrefs>(readPitchHintPrefs);

    const track = activeTrackId !== null ? engine.getTrack(activeTrackId) : undefined;
    const drums = isDrumTrack(track, (id) => engine.getTrack(id));

    // キーの音階と、コードの区間（ステップ）は、カルテかグリッドが変わったときだけ出し直す
    // （スクロールや再生のたびには計算しない。描く側は、見えている範囲の区間だけを拾う）
    const key = useMemo(() => keyHint(chart?.key), [chart]);
    const regions = useMemo(
        () => chordRegions(chart?.chords, { bpm, beatsPerBar, offsetSec: gridOffset }),
        [chart, bpm, beatsPerBar, gridOffset],
    );

    const showKey = prefs.key && !drums && key !== null;
    const showChords = prefs.chord && !drums && regions.length > 0;

    // いま出すものを、ピアノロールに渡す
    useEffect(() => {
        pianoRollRef.current?.setPitchHints?.({
            key: activeTrackId !== null && showKey ? key : null,
            chords: activeTrackId !== null && showChords ? regions : [],
        });
    }, [pianoRollRef, activeTrackId, showKey, showChords, key, regions, trackVersion]);

    if (activeTrackId === null) return null;

    const toggle = (kind: PitchHintKind) => {
        const next = { ...prefs, [kind]: !prefs[kind] };
        setPrefs(next);
        writePitchHintPref(kind, next[kind]);
    };

    // 押せないあいだは理由を、押せるあいだは、いま押したときのことを書く（docs/ui-terms.md）
    const keyReason = drums ? DRUM_REASON
        : !chart ? '曲を取り込んでカルテを作ると、キーの音階に入る高さの行に色を付けられます'
            : !key ? 'この曲はカルテでキーを判定できなかったので、キーの音は出せません' : null;
    const keyRows = key ? `の音階に入る高さの行を金色で薄く、主音（キーの中心の音。${key.tonic}）の行を少し濃く` : '';
    const keyTip = keyReason ?? (prefs.key
        ? `カルテのキー（${key!.label}。確信度は「${key!.confidenceLabel}」）${keyRows}塗っています。押すと消します`
        : `カルテのキー（${key!.label}。確信度は「${key!.confidenceLabel}」）${keyRows}塗ります`);

    const chordReason = drums ? DRUM_REASON
        : !chart ? '曲を取り込んでカルテを作ると、コードを作っている音の高さの行に色を付けられます'
            : regions.length === 0 ? 'この曲はカルテでコードを読み取れなかったので、コードの音は出せません' : null;
    const chordRows = 'カルテのコードが鳴っている時間の幅だけ、そのコードを作っている音の高さの行を青緑で薄く、ルート（コードの土台の音）の行を少し濃く';
    const chordTip = chordReason ?? (prefs.chord ? `${chordRows}塗っています。押すと消します` : `${chordRows}塗ります`);

    return (
        <span className="pitch-hints" role="group" aria-label="キーの音とコードの音の色分け">
            <button type="button" className="pitch-hint-toggle" data-hint="key" aria-pressed={prefs.key}
                disabled={keyReason !== null} {...tip(keyTip)} {...blockedBy(keyReason)} onClick={() => toggle('key')}>
                <span className="hint-swatch" aria-hidden="true" />キーの音
            </button>
            <button type="button" className="pitch-hint-toggle" data-hint="chord" aria-pressed={prefs.chord}
                disabled={chordReason !== null} {...tip(chordTip)} {...blockedBy(chordReason)} onClick={() => toggle('chord')}>
                <span className="hint-swatch" aria-hidden="true" />コードの音
            </button>
        </span>
    );
}
