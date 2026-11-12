/**
 * bunri DAW — MIDI キーボード入力の操作バー（ピアノロールの見出し行に出す）。
 *
 * 「MIDI 入力」を押すと、つながっている鍵盤をすべて開く。弾くと音が鳴り、録り方に応じて
 * ピアノロールにノートが入る。
 *
 * - 録らない: 音を鳴らすだけ（音を探すとき用）
 * - ステップ入力: 弾くたびに、カーソルの位置へ決まった長さのノートを置いて進む
 * - リアルタイム録音: 再生中に弾いた位置と長さを、16 分音符に丸めて置く
 *
 * 入力元は環境で変わる（lib/midi-input.ts）。開発用のブラウザ起動は Web MIDI API（Chrome / Edge）、
 * デスクトップ版はネイティブ側。どちらも無い環境では、使えない旨だけを出す。
 *
 * つなぐ・録る仕組みは `useMidiInput`（lib/useMidiInput.ts）にまとめてあり、中央エリアが 1 つだけ持つ。ふだんのピアノロールの
 * 見出し（この操作バー）と練習画面の「入力」は、同じ 1 つを操作する（画面を切り替えても、つないだまま）。
 */
import { useDaw } from '../lib/store';
import { cursorLabel, type RecordMode } from '../lib/midi-input';
import { midiUnavailableText, useMidiInput, type MidiInputController } from '../lib/useMidiInput';

/** ステップ入力で選べるノートの長さ（ステップ数と呼び名）。 */
const STEP_LENGTHS: [number, string][] = [[1, '16 分'], [2, '8 分'], [4, '4 分'], [8, '2 分'], [16, '全音符']];

const controlStyle = {
    fontSize: 11, padding: '1px 6px', marginLeft: 6, textTransform: 'none', letterSpacing: 0,
    background: 'var(--bg-deep)', color: 'var(--text-mid)', border: '1px solid var(--border)',
    borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
} as const;

/** ステップ入力の長さの選択肢（練習画面でも使う）。 */
export function StepLengthSelect({ midi, style }: { midi: MidiInputController; style?: React.CSSProperties }) {
    return (
        <select aria-label="ノートの長さ" style={style ?? controlStyle} value={midi.stepLength}
            onChange={(e) => midi.setStepLength(Number(e.target.value))}>
            {STEP_LENGTHS.map(([steps, label]) => <option key={steps} value={steps}>{label}</option>)}
        </select>
    );
}

/**
 * MIDI キーボード入力の操作バー。
 *
 * @param midi - 中央エリアが持つ MIDI 入力の仕組み。省略すると、自分で 1 つ持つ（テスト用）
 */
export default function MidiInputBar({ midi }: { midi?: MidiInputController }) {
    const { beatsPerBar } = useDaw();
    const own = useMidiInput();
    const c = midi ?? own;

    if (!c.available) {
        return <span className="area-hint" style={{ marginLeft: 12 }}>{midiUnavailableText()}</span>;
    }

    return (
        <span id="midi-input-bar" style={{ marginLeft: 12, textTransform: 'none', letterSpacing: 0 }}>
            <button type="button" style={controlStyle} aria-pressed={c.connected}
                onClick={c.connected ? () => void c.disconnect() : () => void c.connect()}>
                {c.connected ? 'MIDI 入力を止める' : 'MIDI 入力'}
            </button>
            {c.connected && (
                <>
                    <button type="button" style={controlStyle} onClick={() => void c.connect()} title="機器を挿し直したときに押す">再検出</button>
                    <select aria-label="録り方" style={controlStyle} value={c.mode} onChange={(e) => c.setMode(e.target.value as RecordMode)}>
                        <option value="off">録らない（音だけ）</option>
                        <option value="step">ステップ入力</option>
                        <option value="realtime">リアルタイム録音</option>
                    </select>
                    {c.mode === 'step' && (
                        <>
                            <StepLengthSelect midi={c} />
                            <span className="area-hint" style={{ marginLeft: 6 }}>次の位置: {cursorLabel(c.cursor, beatsPerBar)}</span>
                            <button type="button" style={controlStyle} onClick={() => c.setCursor(0)}>
                                先頭へ
                            </button>
                        </>
                    )}
                    <span className="area-hint" style={{ marginLeft: 8 }}>
                        {c.devices.length > 0 ? c.devices.join(' / ') : '鍵盤が見つかりません（つないでから「再検出」）'}
                    </span>
                </>
            )}
        </span>
    );
}
