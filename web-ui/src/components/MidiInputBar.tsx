/**
 * bunri DAW — MIDI キーボード入力の操作バー（ピアノロールの見出し行に出す）。
 *
 * 「MIDI 入力」を押すと、つながっている鍵盤をすべて開く。弾くと音が鳴り、録り方に応じて
 * ピアノロールにノートが入る。
 *
 * - 録らない: 音を鳴らすだけ（音を探すとき用）
 * - ステップ入力: 弾くたびに、カーソルの位置へノートを置いて進む。1 歩は、ピアノロールで選んだ刻み（既定）か、決めた長さ
 * - リアルタイム録音: 再生中に弾いた位置と長さを、16 分音符に丸めて置く（選んだ刻みが 32 分か三連のときは、その刻みに）。
 *   再生の前に 1 小節ぶんのカウントを入れられる。
 *   弾いた位置は、遅れの補正のぶんだけ前へ戻して置く
 *
 * 弾いた強さ（ベロシティ）は、どちらの録り方でもノートに残る。
 *
 * 入力元は環境で変わる（lib/midi-input.ts）。開発用のブラウザ起動は Web MIDI API（Chrome / Edge）、
 * デスクトップ版はネイティブ側。どちらも無い環境では、使えない旨だけを出す。
 *
 * つなぐ・録る仕組みは `useMidiInput`（lib/useMidiInput.ts）にまとめてあり、中央エリアが 1 つだけ持つ。ふだんのピアノロールの
 * 見出し（この操作バー）と練習画面の「入力」は、同じ 1 つを操作する（画面を切り替えても、つないだまま）。
 */
import { useDaw } from '../lib/store';
import { cursorLabel, type RecordMode } from '../lib/midi-input';
import { MAX_LATENCY_MS, STEP_FOLLOWS_SNAP, midiUnavailableText, useMidiInput, type MidiInputController } from '../lib/useMidiInput';
import { tip } from '../lib/tooltip';
import { midiModeGuidance } from '../lib/midi-guidance';

/**
 * ステップ入力で選べるノートの長さ（ステップ数と呼び名）。既定の「刻みと同じ」は、ピアノロールで選んだ刻み 1 つぶん
 * （三連なら三連の位置を 1 つずつ進み、スウィングなら、ずらした位置を進む）。
 */
const STEP_LENGTHS: [number, string][] = [[STEP_FOLLOWS_SNAP, '刻みと同じ'], [1, '16 分'], [2, '8 分'], [4, '4 分'], [8, '2 分'], [16, '全音符']];

/** 録り方に載せたときの説明 */
const MODE_TIPS: Record<RecordMode, string> = {
    off: '鍵盤を弾くと音が鳴るだけで、ノートは置きません',
    step: '弾くたびに、ピアノロールで選んだ刻み（か、決めた長さ）のノートを順に置いていきます。同時に押すと和音になります',
    realtime: '再生しているあいだ、弾いたとおりのタイミングと長さでノートを置きます（16 分音符に寄せます。刻みが 32 分か三連のときは、その刻みに寄せます）',
};

/** 鍵盤の録り方と、次の操作。自由制作と練習画面で同じ案内を使う。 */
export function MidiRecordingHelp({ mode, countIn, connected = true, practice = false }: { mode: RecordMode; countIn: boolean; connected?: boolean; practice?: boolean }) {
    if (!connected) return (
        <span className="midi-recording-help">鍵盤の入力はまだつながっていません。{practice
            ? '鍵盤をつないで「同じ長さで 1 音ずつ置く」か「弾いた長さで録る」を選ぶと、入力を始めます。'
            : '鍵盤をつないだら、まず「MIDI 入力」を押します。つないだだけでは音は鳴りません。'}</span>
    );
    return (
        <span className="midi-recording-help">
            {practice && mode === 'off' && 'マウスでは、ダブルクリックで横棒を置けます。'}
            {midiModeGuidance(mode, countIn, practice ? 'practice' : 'arrange')}
        </span>
    );
}

const controlStyle = {
    fontSize: 11, padding: '1px 6px', marginLeft: 6, textTransform: 'none', letterSpacing: 0,
    background: 'var(--bg-deep)', color: 'var(--text-mid)', border: '1px solid var(--border)',
    borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
} as const;

/**
 * リアルタイム録音の設定（録音前のカウントと、遅れの補正）。練習画面でも使う。
 *
 * 遅れの補正は、弾いた位置を前へ戻す量。聞こえた音に合わせて弾くと、音が耳に届くまでの遅れのぶんだけ
 * 後ろに置かれるので、そのぶんを戻す。既定は、音の出力の遅れ（ブラウザが知らせる値）。
 * ノートが後ろにずれて入るなら増やし、前にずれるなら減らす。
 */
export function RealtimeSettings({ midi, style }: { midi: MidiInputController; style?: React.CSSProperties }) {
    const control = style ?? controlStyle;
    // 見出しと欄が、行の折り返しで離れないようにする
    const labelStyle = { marginLeft: 8, fontSize: 11, color: 'var(--text-mid)', whiteSpace: 'nowrap', display: 'inline-block' } as const;
    return (
        <>
            <label style={labelStyle}>
                <input type="checkbox" checked={midi.countIn} onChange={(e) => midi.setCountIn(e.target.checked)}
                    style={{ width: 'auto', marginRight: 4, verticalAlign: 'middle' }}
                    {...tip('再生を押すと、曲が始まる前に 1 小節ぶんのクリックが鳴ります。そのあいだは、弾いても録りません')} />
                録音前にカウント
            </label>
            <label style={labelStyle}>
                遅れの補正
                <input type="number" aria-label="遅れの補正（ミリ秒）" min={0} max={MAX_LATENCY_MS} step={5} value={midi.latencyMs}
                    onChange={(e) => midi.setLatencyMs(e.target.value === '' ? null : Number(e.target.value))}
                    style={{ ...control, width: 56, cursor: 'text' }}
                    {...tip('弾いた位置を、この時間だけ前へ戻して置きます。ノートが後ろにずれて入るなら増やし、前にずれるなら減らしてください')} />
                ミリ秒
            </label>
            {!midi.latencyAuto && (
                <button type="button" style={control} onClick={() => midi.setLatencyMs(null)}
                    {...tip('遅れの補正を、音が出るまでの遅れから自動で決めた値に戻します')}>おまかせに戻す</button>
            )}
        </>
    );
}

/** ステップ入力の長さの選択肢（練習画面でも使う）。 */
export function StepLengthSelect({ midi, style }: { midi: MidiInputController; style?: React.CSSProperties }) {
    return (
        <select aria-label="ノートの長さ" style={style ?? controlStyle} value={midi.stepLength}
            {...tip(midi.stepLength === STEP_FOLLOWS_SNAP
                ? 'ステップ入力で置くノートの長さ。いまは、ピアノロールで選んだ刻み 1 つぶんを置いて、隣の刻みへ進みます'
                : 'ステップ入力で置くノートの長さ。いまは、この長さのノートを置いて、同じ長さだけ進みます')}
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
                {...tip(c.connected
                    ? 'MIDI 鍵盤からの入力を止めます'
                    : 'つないだ MIDI 鍵盤で音を鳴らしたり、ノートを置いたりできるようにします')}
                onClick={c.connected ? () => void c.disconnect() : () => void c.connect()}>
                {c.connected ? 'MIDI 入力を止める' : 'MIDI 入力'}
            </button>
            {c.connected && (
                <>
                    <button type="button" style={controlStyle} onClick={() => void c.connect()} {...tip('鍵盤をつなぎ直したときに押します')}>再検出</button>
                    <label className="midi-recording-label">鍵盤の録り方
                        <select aria-label="録り方" style={controlStyle} value={c.mode} onChange={(e) => c.setMode(e.target.value as RecordMode)}
                            {...tip(MODE_TIPS[c.mode])}>
                            <option value="off">音を鳴らすだけ</option>
                            <option value="step">同じ長さで 1 音ずつ置く（ステップ入力）</option>
                            <option value="realtime">弾いた長さで録る（リアルタイム録音）</option>
                        </select>
                    </label>
                    {c.mode === 'step' && (
                        <>
                            <StepLengthSelect midi={c} />
                            <span className="area-hint" style={{ marginLeft: 6 }}>次の位置: {cursorLabel(c.cursor, beatsPerBar)}</span>
                            <button type="button" style={controlStyle} onClick={() => c.setCursor(0)}
                                {...tip('次にノートを置く位置を、曲の頭に戻します')}>
                                先頭へ
                            </button>
                        </>
                    )}
                    {c.mode === 'realtime' && <RealtimeSettings midi={c} />}
                    <span className="area-hint" style={{ marginLeft: 8 }}>
                        {c.devices.length > 0 ? c.devices.join(' / ') : '鍵盤が見つかりません（つないでから「再検出」）'}
                    </span>
                </>
            )}
            <MidiRecordingHelp mode={c.mode} countIn={c.countIn} connected={c.connected} />
        </span>
    );
}
