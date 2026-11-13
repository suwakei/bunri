/**
 * bunri DAW — 左パネル（学ぶ / 音作り / ファイル の 3 タブ）
 *
 * - 学ぶ: 曲を取り込んで、カルテ・再現ガイド・差分チェックへ進む流れ（LearnPanel）
 * - 音作り: シンセ・ドラム・FX
 * - ファイル: 音声ファイルの読み込み、単音メロディ解析、録音（曲を使わずに自由に作るとき）
 *
 * 幅は、右端の境目をドラッグするか、左右の矢印キーで変えられる（この画面を開いた人ごとに覚える）。
 *
 * 画面の文は docs/ui-terms.md の決まりに合わせる。
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useDaw, type LeftTab, type SoundTab } from '../lib/store';
import { LEFT_WIDTH_MAX, LEFT_WIDTH_MIN } from '../lib/storage';
import engine, { type PianoNote } from '../lib/engine';
import { decodeWithSource } from '../lib/audio-sources';
import { apiFetch, describeError, errorDetail } from '../lib/api';
import { useLearnActions } from '../lib/learn';
import { JobCancelledError, jobErrorMessage } from '../lib/jobs';
import { useJob } from '../lib/useJob';
import { useShowJob } from '../lib/job-focus';
import JobCard from './JobCard';
import SubTabs from './SubTabs';
import { tabPanelProps, type TabDef } from '../lib/tabs';
import LearnPanel from './LearnPanel';
import DataCleanup from './DataCleanup';
import { tip } from '../lib/tooltip';

/**
 * GM（General MIDI）音源の単一楽器エントリーを表すインターフェース。
 * `/api/gm-instruments` レスポンスの各要素に対応する。
 *
 * @property program - GM プログラム番号（0〜127）
 * @property name - 楽器名（例: `"Acoustic Grand Piano"`）
 */
interface GmInstrument {
    program: number;
    name: string;
}

/**
 * FX パネルで表示・操作する単一パラメータの定義。
 * `FX_PARAMS` 定数の各エントリーに対応する。
 *
 * @property id - API に送信するパラメータキー（例: `"threshold"`）
 * @property label - UI 上に表示するラベル文字列（例: `"しきい値 (dB)"`）
 * @property hint - つまみにマウスを載せたときに出す説明（ツールチップ）
 * @property min - スライダーの最小値
 * @property max - スライダーの最大値
 * @property step - スライダーのステップ幅
 * @property def - デフォルト値（エフェクト切り替え時に適用される）
 */
interface FxParamDef {
    id: string;
    label: string;
    hint: string;
    min: number;
    max: number;
    step: number;
    def: number;
}

/**
 * GM 楽器をカテゴリ名 → GM プログラム番号配列にまとめた定数。
 * シンセパネルの楽器セレクトボックスをカテゴリ別 `<optgroup>` で表示するために使用する。
 */
// ---- GM楽器カテゴリ ----
const GM_CATEGORIES: Record<string, number[]> = {
    'ピアノ': [0,1,2,4,5,6,8],
    'クロマチックパーカッション': [9,10,11,12,13],
    'ギター': [24,25,26,27,28,29,30],
    'ベース': [32,33,34,35,36,38],
    'ストリングス': [40,41,42,43,44,45,46,48,49,50],
    'コーラス/ボイス': [52,53,54],
    'ブラス': [56,57,58,59,60,61,62],
    'リード/サックス': [64,65,66,67],
    '木管': [68,69,70,71,72,73,74,75,79],
    'シンセリード': [80,81],
    'シンセパッド': [88,89,90,91,95],
    'エスニック/その他': [104,105,108,110,114],
};

/**
 * エフェクト種別ごとのパラメータ定義マップ。
 * キーは `/api/effects/{name}` のパス部分（`"eq"`, `"reverb"` など）と一致する。
 * 値は空配列の場合、追加パラメータなし（例: `"normalize"`）。
 */
// ---- FXパラメータ定義 ----
const FX_PARAMS: Record<string, FxParamDef[]> = {
    eq: [
        { id: 'low', label: '低域 (dB)', hint: '低い音（ベースやキックのあたり）を強める・弱める', min: -12, max: 12, step: 1, def: 0 },
        { id: 'mid', label: '中域 (dB)', hint: '真ん中の高さの音（歌やギターのあたり）を強める・弱める', min: -12, max: 12, step: 1, def: 0 },
        { id: 'high', label: '高域 (dB)', hint: '高い音（シンバルや息の音のあたり）を強める・弱める', min: -12, max: 12, step: 1, def: 0 },
    ],
    compressor: [
        { id: 'threshold', label: 'しきい値 (dB)', hint: 'この大きさを超えた音を抑えます。下げるほど、多くの音が抑えられます', min: -40, max: 0, step: 1, def: -20 },
        { id: 'ratio', label: '圧縮比', hint: '超えたぶんをどれだけ抑えるか。大きいほど強く抑えます', min: 1, max: 20, step: 0.5, def: 4 },
    ],
    reverb: [
        { id: 'room_size', label: '部屋の広さ', hint: '響きの長さ。大きいほど、広い部屋のように長く響きます', min: 0, max: 1, step: 0.05, def: 0.5 },
        { id: 'wet', label: 'エフェクト音の量', hint: '響きをどれだけ混ぜるか。0 で元の音だけになります', min: 0, max: 1, step: 0.05, def: 0.3 },
    ],
    delay: [
        { id: 'delay_ms', label: '遅れの時間 (ms)', hint: 'やまびこが返ってくるまでの時間（ミリ秒）', min: 50, max: 2000, step: 10, def: 300 },
        { id: 'feedback', label: '繰り返しの量', hint: 'やまびこが何度も繰り返す度合い。大きいほど長く続きます', min: 0, max: 0.9, step: 0.05, def: 0.4 },
        { id: 'wet', label: 'エフェクト音の量', hint: 'やまびこをどれだけ混ぜるか。0 で元の音だけになります', min: 0, max: 1, step: 0.05, def: 0.3 },
    ],
    normalize: [],
    pitch_shift: [
        { id: 'semitones', label: '半音', hint: '音の高さを半音単位で上げ下げします（12 で 1 オクターブ）', min: -12, max: 12, step: 1, def: 0 },
    ],
    time_stretch: [
        { id: 'rate', label: '速度', hint: '音の高さを変えずに速さを変えます（2 で 2 倍速、長さは半分）', min: 0.25, max: 3, step: 0.05, def: 1 },
    ],
};

/**
 * エフェクトの日本語の名前。キーは `FX_PARAMS` と同じ。
 * 選択肢と、適用したときの知らせに使う（識別子の `pitch_shift` などを画面に出さない）。
 */
const FX_LABELS: Record<string, string> = {
    eq: 'EQ（3 バンド）',
    compressor: 'コンプレッサー',
    reverb: 'リバーブ',
    delay: 'ディレイ',
    normalize: 'ノーマライズ',
    pitch_shift: 'ピッチシフト',
    time_stretch: 'タイムストレッチ',
};

/** マイクを使えなかったときの知らせ。 */
/** エフェクトの種類を選んだときに出す説明 */
const FX_TIPS: Record<string, string> = {
    eq: '低い音・真ん中の音・高い音の大きさを、それぞれ上げ下げします',
    compressor: '大きすぎる音を抑えて、音量のばらつきを小さくします',
    reverb: '部屋で鳴らしたような響きを足します',
    delay: 'やまびこのように、少し遅れて同じ音を繰り返します',
    normalize: '音が割れない範囲で、全体の音量をいっぱいまで上げます',
    pitch_shift: '速さを変えずに、音の高さを上げ下げします',
    time_stretch: '音の高さを変えずに、速さを変えます',
};

const MIC_DENIED = 'マイクを使えませんでした。OS の設定で、このアプリにマイクの使用を許可してください';

/**
 * シンセサイザーパネルコンポーネント。
 * GM 音源またはカスタム波形を選択し、ピアノロールのノートを
 * `/api/synth/sequence` へ送信してシーケンスをレンダリング・トラックに追加する。
 *
 * @returns シンセパネル全体の `<div id="synth-panel">` 要素
 */
// ---- シンセパネル ----
function SynthPanel() {
    const { bpm, setStatus, withProgress, showProgress, bumpTracks, pianoRollRef, recordAsync } = useDaw();
    const [gmProgram, setGmProgram] = useState('none');
    const [instrument, setInstrument] = useState('');
    const [wave, setWave] = useState('sine');
    const [vol, setVol] = useState(0.5);
    const [a, setA] = useState(0.01);
    const [d, setD] = useState(0.1);
    const [s, setS] = useState(0.6);
    const [r, setR] = useState(0.2);
    const [synthTrack, setSynthTrack] = useState('');
    const [gmInstruments, setGmInstruments] = useState<GmInstrument[]>([]);

    useEffect(() => {
        apiFetch('/api/gm-instruments').then(r => r.json())
            .then((data: GmInstrument[]) => setGmInstruments(data)).catch(() => {});
    }, []);

    const handleRender = useCallback(async () => {
        const pr = pianoRollRef.current;
        if (!pr) return;
        const notes = pr.getNotes();
        if (notes.length === 0) {
            setStatus('ピアノロールにノートを配置してください', 'error');
            return;
        }
        const fd = new FormData();
        fd.append('notes_json', JSON.stringify(notes));
        fd.append('bpm', String(bpm));
        fd.append('waveform', wave);
        fd.append('volume', String(vol));
        fd.append('attack', String(a)); fd.append('decay', String(d));
        fd.append('sustain', String(s)); fd.append('release', String(r));
        fd.append('instrument', instrument);
        fd.append('gm_program', gmProgram);

        await withProgress('ノートを音声にしています…', async () => {
            const resp = await apiFetch('/api/synth/sequence', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const blob = await resp.blob();
            const buf = await blob.arrayBuffer();
            // 元のバイト列を覚えておく (プロジェクトの保存で、そのまま入れる。lib/audio-sources.ts)
            const buffer = await decodeWithSource(engine.ctx!, buf, 'synth-seq.wav');

            // 追加先は、セレクタで選んだトラック。選んでいなければ、ピアノロールで開いているトラック
            let trackId: number | string | null = synthTrack && engine.getTrack(synthTrack) ? synthTrack : pr.getActiveTrackId();
            // トラックを作ること・クリップを置くことは、まとめて元に戻せる
            await recordAsync('シーケンスを追加', async () => {
                if (!trackId || !engine.getTrack(trackId)) {
                    if (engine.tracks.length === 0) engine.addTrack('Synth');
                    trackId = engine.tracks[0].id;
                }
                // 音声のクリップは、1 小節目の位置 (ノートのステップ 0) に置く
                await engine.addClipFromBuffer(trackId, buffer, 'synth-seq', engine.gridOffset);
            });
            const trackName = engine.tracks.find(t => String(t.id) === String(trackId))?.name || '';
            bumpTracks();
            setStatus(`シーケンスを「${trackName}」に追加しました`);
        });
    }, [bpm, wave, vol, a, d, s, r, instrument, gmProgram, synthTrack, pianoRollRef, withProgress, bumpTracks, setStatus, recordAsync]);

    // GM楽器をカテゴリ別にグループ化
    const instMap: Record<number, string> = {};
    gmInstruments.forEach(i => { instMap[i.program] = i.name; });

    return (
        <div id="synth-panel" className="panel-content active">
            <h3>シンセサイザー</h3>
            <p className="panel-desc">下のピアノロールにノートを置いてから「シーケンスをレンダリング」を押すと、ノートが音声のクリップになってトラックに入ります。</p>
            <label htmlFor="synth-gm">楽器（GM 音源）</label>
            <select id="synth-gm" value={gmProgram} onChange={e => setGmProgram(e.target.value)}
                {...tip('鳴らす楽器を選びます。ピアノやギターなど、実際の楽器に近い音です')}>
                <option value="none">カスタム波形（下で選択）</option>
                {Object.entries(GM_CATEGORIES).map(([cat, programs]) => {
                    const opts = programs.filter(p => instMap[p]);
                    if (opts.length === 0) return null;
                    return (
                        <optgroup key={cat} label={cat}>
                            {opts.map(p => <option key={p} value={p}>{instMap[p]}</option>)}
                        </optgroup>
                    );
                })}
            </select>
            <details style={{ marginTop: 4 }}>
                <summary {...tip('楽器を選ばずに、電子音の形を自分で決めるときに開きます')}>カスタム波形の設定（GM 音源を選んでいないとき）</summary>
                <label htmlFor="synth-instrument">簡易楽器</label>
                <select id="synth-instrument" value={instrument} onChange={e => setInstrument(e.target.value)}
                    {...tip('電子音で、楽器の雰囲気をまねます。上で楽器を選んでいるときは使われません')}>
                    <option value="">基本波形（下で選択）</option>
                    <option value="guitar">ギター</option>
                    <option value="violin">バイオリン</option>
                    <option value="chorus">コーラス</option>
                    <option value="flute">フルート</option>
                    <option value="bass">ベース</option>
                    <option value="organ">オルガン</option>
                </select>
                <label htmlFor="synth-wave">波形</label>
                <select id="synth-wave" value={wave} onChange={e => setWave(e.target.value)}
                    {...tip('電子音の形。サイン波はまろやかに、のこぎり波は鋭く聞こえます')}>
                    <option value="sine">サイン波（まろやか）</option>
                    <option value="square">矩形波（ファミコン風）</option>
                    <option value="sawtooth">のこぎり波（鋭い）</option>
                    <option value="triangle">三角波（柔らかい）</option>
                </select>
            </details>
            <div className="param-row">
                <div>
                    <label htmlFor="synth-attack">アタック</label>
                    <input id="synth-attack" type="range" min="0.001" max="1" step="0.001" value={a} onChange={e => setA(+e.target.value)}
                        {...tip('鳴り始めてから、いちばん大きくなるまでの時間。短いと歯切れよく、長いとふわっと始まります')} />
                </div>
                <div>
                    <label htmlFor="synth-decay">ディケイ</label>
                    <input id="synth-decay" type="range" min="0.001" max="1" step="0.001" value={d} onChange={e => setD(+e.target.value)}
                        {...tip('いちばん大きくなってから、伸ばしているときの大きさに落ち着くまでの時間')} />
                </div>
            </div>
            <div className="param-row">
                <div>
                    <label htmlFor="synth-sustain">サステイン</label>
                    <input id="synth-sustain" type="range" min="0" max="1" step="0.05" value={s} onChange={e => setS(+e.target.value)}
                        {...tip('ノートを伸ばしているあいだの音の大きさ')} />
                </div>
                <div>
                    <label htmlFor="synth-release">リリース</label>
                    <input id="synth-release" type="range" min="0.001" max="2" step="0.001" value={r} onChange={e => setR(+e.target.value)}
                        {...tip('ノートが終わってから、音が消えきるまでの時間。長いと余韻が残ります')} />
                </div>
            </div>
            <label htmlFor="synth-volume">音量</label>
            <input id="synth-volume" type="range" min="0" max="1" step="0.05" value={vol} onChange={e => setVol(+e.target.value)}
                {...tip('作る音の大きさ')} />
            <label htmlFor="synth-track">追加先トラック</label>
            <TrackSelector id="synth-track" value={synthTrack} onChange={setSynthTrack} emptyLabel="ピアノロールで開いているトラック"
                tipText="できた音を置くトラック" />
            <button className="action-btn" onClick={handleRender} disabled={showProgress}
                {...tip('ピアノロールのノートを音声にして、トラックにクリップとして置きます')}>シーケンスをレンダリング</button>
        </div>
    );
}

/**
 * ドラムマシンパネルコンポーネント。
 * プリセットパターン・小節数・音量を指定して `/api/synth/drum` を呼び出し、
 * 生成されたドラム音声を選択トラックに追加する。
 *
 * @returns ドラムパネル全体の `<div id="drum-panel">` 要素
 */
// ---- ドラムパネル ----
function DrumPanel() {
    const { bpm, setStatus, withProgress, showProgress, bumpTracks, recordAsync } = useDaw();
    const [pattern, setPattern] = useState('8ビート');
    const [bars, setBars] = useState(4);
    const [vol, setVol] = useState(0.7);
    const [drumTrack, setDrumTrack] = useState('__new__');

    const handleGenerate = useCallback(async () => {
        const fd = new FormData();
        fd.append('pattern', pattern);
        fd.append('bpm', String(bpm));
        fd.append('bars', String(bars));
        fd.append('volume', String(vol));

        await withProgress('ドラムを作っています…', async () => {
            const resp = await apiFetch('/api/synth/drum', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const blob = await resp.blob();
            const buf = await blob.arrayBuffer();
            // 元のバイト列を覚えておく (プロジェクトの保存で、そのまま入れる。lib/audio-sources.ts)
            const buffer = await decodeWithSource(engine.ctx!, buf, `drum-${pattern}.wav`);

            // トラックを作ること・クリップを置くことは、まとめて元に戻せる
            const track = await recordAsync('ドラムを追加', async () => {
                let target;
                if (drumTrack === '__new__') {
                    target = engine.addTrack('Drum');
                } else {
                    target = engine.tracks.find(t => String(t.id) === drumTrack);
                    if (!target) target = engine.addTrack('Drum');
                }
                // 1 小節目の位置から置く (ピアノロールの小節とそろえる)
                await engine.addClipFromBuffer(target.id, buffer, `drum-${pattern}`, engine.gridOffset);
                return target;
            });
            bumpTracks();
            setStatus(`ドラムを「${track.name}」に追加しました`);
        });
    }, [pattern, bpm, bars, vol, drumTrack, withProgress, bumpTracks, setStatus, recordAsync]);

    return (
        <div id="drum-panel" className="panel-content">
            <h3>ドラムマシン</h3>
            <p className="panel-desc">決まったパターンから、ドラムの音声のクリップを作ってトラックに追加します。</p>
            <label htmlFor="drum-pattern">パターン</label>
            <select id="drum-pattern" value={pattern} onChange={e => setPattern(e.target.value)}
                {...tip('叩き方の型。8ビートはポップスやロックでよく使われます')}>
                <option value="8ビート">8ビート（ポップス/ロック定番）</option>
                <option value="4つ打ち">4つ打ち（ダンス/テクノ）</option>
                <option value="ボサノバ">ボサノバ</option>
                <option value="レゲエ">レゲエ</option>
            </select>
            <label htmlFor="drum-bars">小節数</label>
            <input id="drum-bars" type="number" value={bars} min="1" max="32" onChange={e => setBars(+e.target.value)}
                {...tip('作るドラムの長さ（小節の数）')} />
            <label htmlFor="drum-volume">音量</label>
            <input id="drum-volume" type="range" min="0" max="1" step="0.05" value={vol} onChange={e => setVol(+e.target.value)}
                {...tip('ドラムの音の大きさ')} />
            <label htmlFor="drum-track">追加先トラック</label>
            <TrackSelector id="drum-track" value={drumTrack} onChange={setDrumTrack} includeNew
                tipText="ドラムを置くトラック。「新規作成」なら、新しいトラックを作ります" />
            <button className="action-btn" onClick={handleGenerate} disabled={showProgress}
                {...tip('選んだパターンでドラムの音声を作り、1 小節目から置きます')}>ドラム生成 → トラックに追加</button>
        </div>
    );
}

/**
 * エフェクトパネルコンポーネント。
 * 対象トラックの最初のクリップを WAV に変換して `/api/effects/{fxType}` に送信し、
 * エフェクト処理済みの音声でクリップを上書きする。
 *
 * @returns FX パネル全体の `<div id="fx-panel">` 要素
 */
// ---- FXパネル ----
function FxPanel() {
    const { setStatus, withProgress, showProgress, bumpTracks, record } = useDaw();
    const [fxTrack, setFxTrack] = useState('');
    const [fxType, setFxType] = useState('eq');
    const defaultParams = useCallback(() => {
        const defs: Record<string, number> = {};
        (FX_PARAMS[fxType] || []).forEach(p => { defs[p.id] = p.def; });
        return defs;
    }, [fxType]);
    const [params, setParams] = useState<Record<string, number>>(defaultParams);

    useEffect(() => {
        setParams(defaultParams());
    }, [defaultParams]);

    const handleApply = useCallback(async () => {
        const track = engine.getTrack(resolveTrackId(fxTrack));
        if (!track || track.clips.length === 0) {
            setStatus('エフェクト対象のトラックにクリップがありません', 'error');
            return;
        }
        const label = FX_LABELS[fxType] ?? fxType;
        // 最初のクリップをWAVに変換して送信
        await withProgress(`「${label}」を適用しています…`, async () => {
            const clip = track.clips[0];
            const wavBlob = engine._audioBufferToWav(clip.buffer);
            const fd = new FormData();
            fd.append('file', wavBlob, 'clip.wav');
            fd.append('params', JSON.stringify(params));
            const resp = await apiFetch(`/api/effects/${fxType}`, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const blob = await resp.blob();
            const buf = await blob.arrayBuffer();
            // 元のバイト列を覚えておく (プロジェクトの保存で、そのまま入れる。lib/audio-sources.ts)
            const buffer = await decodeWithSource(engine.ctx!, buf, `${clip.name}[${fxType}].wav`);
            // エフェクトをかけたクリップに差し替える (元に戻すと、かける前のクリップに戻る)
            record(`「${label}」を適用`, () => {
                track.clips[0] = { buffer, offset: clip.offset, name: `${clip.name}[${fxType}]`, duration: buffer.duration };
            });
            bumpTracks();
            // 識別子 (pitch_shift など) ではなく、日本語の名前で知らせる
            setStatus(`「${label}」を適用しました`);
        });
    }, [fxTrack, fxType, params, withProgress, bumpTracks, setStatus, record]);

    return (
        <div id="fx-panel" className="panel-content">
            <h3>エフェクト</h3>
            <p className="panel-desc">トラックの最初のクリップにエフェクトをかけて、かけた後の音声に置き換えます。</p>
            <label htmlFor="fx-track">対象トラック</label>
            <TrackSelector id="fx-track" value={fxTrack} onChange={setFxTrack}
                tipText="効果をかけるトラック。そのトラックの最初のクリップにかかります" />
            <label htmlFor="fx-type">エフェクト</label>
            <select id="fx-type" value={fxType} onChange={e => setFxType(e.target.value)} {...tip(FX_TIPS[fxType] ?? '')}>
                {Object.entries(FX_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <div id="fx-params">
                {(FX_PARAMS[fxType] || []).map(p => (
                    <div key={p.id}>
                        <label htmlFor={`fx-param-${p.id}`}>{p.label}（{params[p.id] ?? p.def}）</label>
                        <input id={`fx-param-${p.id}`} type="range" min={p.min} max={p.max} step={p.step}
                            value={params[p.id] ?? p.def}
                            onChange={e => setParams(prev => ({ ...prev, [p.id]: +e.target.value }))}
                            {...tip(p.hint)} />
                    </div>
                ))}
            </div>
            <button className="action-btn" onClick={handleApply} disabled={showProgress}
                {...tip('効果をかけて、クリップをかけた後の音に置き換えます。元に戻すで戻せます')}>エフェクト適用</button>
        </div>
    );
}

/**
 * ファイルパネルコンポーネント。曲を使わずに自由に作るときの読み込みをまとめる:
 * - 音声ファイル（WAV・MP3・FLAC など）をトラックに読み込む
 * - 単音メロディの解析（`/api/analyze`）によるピアノロール自動配置
 * - マイク録音の開始・停止とトラックへの追加
 *
 * 原曲の取り込み（カルテを作る）とパート分離は、「学ぶ」タブに在る。
 *
 * @returns ファイルパネル全体の `<div id="file-panel">` 要素
 */
// ---- ファイルパネル ----
function FilePanel() {
    const { setStatus, bumpTracks, showProgress, pianoRollRef, bpm, recordAsync } = useDaw();
    const { placeAudio } = useLearnActions();
    const showJob = useShowJob();
    const [fileTrack, setFileTrack] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const analyzeFileRef = useRef<HTMLInputElement>(null);
    const [sensitivity, setSensitivity] = useState(0.5);
    const [isRecording, setIsRecording] = useState(false);

    const handleImport = useCallback(async () => {
        const files = fileInputRef.current?.files;
        if (!files?.length) { setStatus('読み込む音声ファイルを選んでください', 'error'); return; }
        // 選んだファイルをまとめて 1 つの記録にする (元に戻すと、まとめて外れる)
        await recordAsync('音声ファイルを追加', async () => {
            if (engine.tracks.length === 0) engine.addTrack();
            const trackId = resolveTrackId(fileTrack);
            const trackName = engine.tracks.find(t => String(t.id) === String(trackId))?.name || '';
            for (const file of files) {
                try {
                    // ブラウザで読めない形式は、API で WAV に変換してから置く
                    await placeAudio(Number(trackId), file);
                } catch {
                    setStatus(`${file.name} を読み込めませんでした。WAV・MP3・FLAC などの音声ファイルかどうかを確かめてください`, 'error');
                    return;
                }
                setStatus(`${file.name} を「${trackName}」に追加しました`);
            }
        });
        bumpTracks();
    }, [fileTrack, setStatus, bumpTracks, placeAudio, recordAsync]);

    // 単音メロディの解析は時間のかかる処理 (ジョブ)。進み具合は解析のボタンの下に出す
    const analyzeJob = useJob('file-analyze', (job) => {
        // 画面を開き直す前に始めた解析は、置く先のピアノロールが分からないので、終わったことだけ知らせる
        if (job.state === 'done') setStatus('前に始めた単音メロディの解析が終わりました。結果を置くには、トラックを開いてもう一度解析してください');
        else if (job.state === 'error') setStatus(jobErrorMessage(job), 'error');
    });

    const handleAnalyze = useCallback(async () => {
        const file = analyzeFileRef.current?.files?.[0];
        if (!file) { setStatus('解析するWAVファイルを選択してください', 'error'); return; }
        const pr = pianoRollRef.current;
        if (!pr?.getActiveTrackId()) { setStatus('先にトラックをクリックしてピアノロールを開いてください', 'error'); return; }
        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', String(bpm));
        fd.append('sensitivity', String(sensitivity));
        setStatus(`音声を解析しています…（${file.name}）`);
        try {
            const notes = await analyzeJob.run<PianoNote[]>('/api/analyze', fd);
            if (notes.length === 0) { setStatus('ノートが見つかりませんでした。感度を上げて、もう一度試してください', 'error'); return; }
            pr.setNotes(notes, '解析したノートを置く');
            // タイムラインのトラックの見出しに出るノートの数を、置いた数に合わせる
            bumpTracks();
            setStatus(`${notes.length}個のノートを検出しました`);
        } catch (e) {
            if (e instanceof JobCancelledError) setStatus('単音メロディの解析を中止しました');
            else setStatus(describeError(e), 'error');
        }
    }, [sensitivity, bpm, pianoRollRef, analyzeJob, setStatus, bumpTracks]);

    const handleMicRecord = useCallback(async () => {
        try {
            await engine.startRecording();
            setIsRecording(true);
            setStatus('録音中…');
        } catch (_e) { setStatus(MIC_DENIED, 'error'); }
    }, [setStatus]);

    const handleMicStop = useCallback(async () => {
        const buffer = await engine.stopRecording();
        setIsRecording(false);
        await recordAsync('録音を追加', async () => {
            let recTrack = engine.tracks.find(t => t.name.includes('Rec'));
            if (!recTrack) recTrack = engine.addTrack('Rec');
            await engine.addClipFromBuffer(recTrack.id, buffer, 'recording');
        });
        bumpTracks();
        setStatus('録音をトラックに追加しました');
    }, [bumpTracks, setStatus, recordAsync]);

    return (
        <div id="file-panel" className="panel-content">
            <h3>音声ファイルを読み込む</h3>
            <p className="panel-desc">
                WAV・MP3・FLAC などの音声ファイルをトラックに追加します。タイムラインに直接ドラッグ&ドロップしても追加できます。
                曲を教材にして学ぶときは、「学ぶ」タブで曲を取り込んでください。
            </p>
            <label htmlFor="file-import">音声ファイル</label>
            <input id="file-import" type="file" ref={fileInputRef} accept=".wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff,audio/*" multiple
                {...tip('トラックに置く音声ファイルを選びます。いくつかまとめて選べます')} />
            <label htmlFor="file-track">追加先トラック</label>
            <TrackSelector id="file-track" value={fileTrack} onChange={setFileTrack} tipText="音声を置くトラック" />
            <button className="action-btn" onClick={handleImport} {...tip('選んだファイルを、指定したトラックに置きます')}>選択したトラックに追加</button>
            <hr />
            <h3>単音メロディ解析</h3>
            <p className="panel-desc">単音の WAV ファイル（ボーカルやメロディ）から音の高さを読み取って、開いているピアノロールにノートを並べます。</p>
            <label htmlFor="file-melody">単音の WAV ファイル</label>
            <input id="file-melody" type="file" ref={analyzeFileRef} accept=".wav"
                {...tip('歌や楽器 1 本だけのメロディが入った WAV ファイル。伴奏が混ざっていると、うまく読み取れません')} />
            <label htmlFor="file-melody-sensitivity">感度（{sensitivity}）</label>
            <input id="file-melody-sensitivity" type="range" min="0.1" max="1" step="0.05" value={sensitivity}
                onChange={e => setSensitivity(+e.target.value)}
                {...tip('上げると小さな音まで拾います。余分なノートが多いときは下げてください')} />
            <button className="action-btn" onClick={handleAnalyze} disabled={showProgress || analyzeJob.heavyBusy}
                {...tip('音の高さを読み取って、開いているピアノロールにノートを並べます')}>解析してピアノロールに配置</button>
            <JobCard slot="file-analyze" job={analyzeJob.job} busyJob={analyzeJob.busyJob} onCancel={() => void analyzeJob.cancel()}
                onShowBusy={showJob} hint="解析は途中では止められません。中止すると、終わったあとに結果を捨てます。" />
            <hr />
            <h3>録音</h3>
            <p className="panel-desc">マイクから音声を録音してトラックに追加します。</p>
            {!isRecording
                ? <button className="action-btn" onClick={handleMicRecord} {...tip('マイクの音を録ります。止めると「Rec」のトラックに入ります')}>マイク録音開始</button>
                : <button className="action-btn" onClick={handleMicStop} {...tip('録音を止めて、トラックに置きます')}>録音停止</button>
            }
            <hr />
            <DataCleanup />
        </div>
    );
}

/**
 * トラック選択セレクトボックスの Props。
 *
 * @property value - 現在選択中のトラック ID 文字列（`engine.tracks[].id` を文字列化したもの）
 * @property onChange - トラック ID が変更されたときに呼ばれるコールバック
 * @property includeNew - `true` のとき「新規作成」オプションを先頭に表示する（省略時 `false`）
 * @property emptyLabel - 指定すると、トラックを選ばない選択肢（値は空文字）をこの文で先頭に表示する
 * @property id - `<select>` の id。見出し（`<label htmlFor>`）と結び付けるために渡す
 */
// ---- トラック選択セレクタ（共通部品）----
interface TrackSelectorProps {
    value: string;
    onChange: (v: string) => void;
    includeNew?: boolean;
    emptyLabel?: string;
    id?: string;
    /** マウスを載せたときの説明 */
    tipText?: string;
}

/**
 * セレクタの値を、実在するトラックの ID にする。
 *
 * セレクタの状態は、選び直すまで空文字のまま。その間も画面には先頭のトラックが表示されているので、
 * 表示と食い違わないよう、空文字や、消されたトラックを指す値は、先頭のトラックとして扱う。
 *
 * @param value - セレクタの状態（トラック ID の文字列、または空文字）
 * @returns 実在するトラックの ID の文字列。トラックが 1 本も無ければ空文字
 */
function resolveTrackId(value: string): string {
    if (value && engine.tracks.some(t => String(t.id) === value)) return value;
    return engine.tracks[0] ? String(engine.tracks[0].id) : '';
}

/**
 * 現在のエンジントラック一覧から選択できる `<select>` コンポーネント。
 * `trackVersion` が変わると自動的に再描画され、トラックの増減を反映する。
 *
 * @param value - 現在選択中のトラック ID 文字列
 * @param onChange - 選択変更時のコールバック（新しいトラック ID を引数に受け取る）
 * @param includeNew - `true` のとき「新規作成（Drum）」オプションを先頭に追加する
 * @param emptyLabel - 指定すると、トラックを選ばない選択肢をこの文で先頭に追加する
 * @param id - `<select>` の id（見出しと結び付ける）
 * @returns エンジントラック一覧を選択肢として持つ `<select>` 要素
 */
function TrackSelector({ value, onChange, includeNew, emptyLabel, id, tipText }: TrackSelectorProps) {
    // trackVersion を読んでおくと、トラックが増減するたびに描き直されて、選択肢に反映される
    const { trackVersion } = useDaw();
    void trackVersion;
    // トラック以外の選択肢 (新規作成・選ばない) が在るときは、その値をそのまま表示する。
    // 無いときは、表示されるトラックと、処理で使うトラック (resolveTrackId) を一致させる
    const shown = includeNew || emptyLabel !== undefined
        ? (value === '__new__' || engine.tracks.some(t => String(t.id) === value) ? value : (includeNew ? '__new__' : ''))
        : resolveTrackId(value);
    return (
        <select id={id} value={shown} onChange={e => onChange(e.target.value)} {...(tipText ? tip(tipText) : {})}>
            {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
            {includeNew && <option value="__new__">新規作成（Drum）</option>}
            {engine.tracks.map(t => (
                <option key={t.id} value={String(t.id)}>{t.name}</option>
            ))}
        </select>
    );
}

/** 左パネルの上の段のタブ。 */
// ---- メインの LeftPanel ----
const TABS: TabDef<LeftTab>[] = [
    { key: 'learn', label: '学ぶ', tip: '曲を取り込んで、カルテを見たり、パートを打ち込んで練習したりします' },
    { key: 'sound', label: '音作り', tip: 'シンセやドラムで音を作り、エフェクトをかけます' },
    { key: 'file', label: 'ファイル', tip: '音声ファイルの追加、メロディの読み取り、マイク録音' },
];

/** 「音作り」タブの中の段。 */
const SOUND_TABS: TabDef<SoundTab>[] = [
    { key: 'synth', label: 'シンセ', tip: 'ピアノロールのノートを、選んだ楽器の音にします' },
    { key: 'drum', label: 'ドラム', tip: '決まったリズムのドラムを作って、トラックに置きます' },
    { key: 'fx', label: 'FX', tip: 'トラックの音に、響きや音の高さの変更などの効果をかけます' },
];

/** 境目をキーボードで動かすときの 1 回ぶん (px)。 */
const WIDTH_KEY_STEP = 20;

/**
 * 「音作り」タブの中身。シンセ・ドラム・FX を段で切り替える。
 */
function SoundPanel() {
    const { soundTab, setSoundTab } = useDaw();
    return (
        <div id="sound-panel">
            <SubTabs idPrefix="sound" label="音作りの段" tabs={SOUND_TABS} active={soundTab} onSelect={setSoundTab}
                className="sub-tabs" id="sound-tabs" />
            <div {...tabPanelProps('sound', 'synth', soundTab, 'sub-panel')}><SynthPanel /></div>
            <div {...tabPanelProps('sound', 'drum', soundTab, 'sub-panel')}><DrumPanel /></div>
            <div {...tabPanelProps('sound', 'fx', soundTab, 'sub-panel')}><FxPanel /></div>
        </div>
    );
}

/**
 * 左パネルコンポーネント。
 * 学ぶ・音作り・ファイルの 3 タブを切り替えて表示する。起動したときは「学ぶ」。
 * 各タブの内容は常に DOM に存在し、`hidden` の切り替えで表示・非表示を制御する。
 *
 * どのタブを開いているかは全体の状態（`leftTab` / `learnTab` / `soundTab`）に置いてある。
 * 解析が終わったときにカルテを開く、進み具合の段階を押したときにその場所を開く、といった切り替えを、
 * ほかの部品からもできるようにするため。
 *
 * タブは `role="tablist"` / `tab` / `tabpanel` で組んであり、左右の矢印キーと Home / End で移れる。
 * 余白は中のパネル（`.panel-content`）が持つ。この枠には付けない（二重に付けると中身の幅が足りなくなる）。
 *
 * @returns 左パネル全体の `<div id="left-panel">` 要素と、右端の境目
 */
export default function LeftPanel() {
    const { leftTab, setLeftTab, leftWidth, setLeftWidth } = useDaw();
    const [resizing, setResizing] = useState(false);
    const startRef = useRef<{ x: number; width: number } | null>(null);

    const handleResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        startRef.current = { x: e.clientX, width: leftWidth };
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 取れなくても、窓の中では動かせる */ }
        setResizing(true);
    }, [leftWidth]);
    // ドラッグのあいだの動きは、窓全体で受ける (境目は細いので、境目の上だけで受けると、すぐに外れる)
    useEffect(() => {
        if (!resizing) return;
        const onMove = (e: PointerEvent) => {
            const start = startRef.current;
            if (start) setLeftWidth(start.width + (e.clientX - start.x));
        };
        const onEnd = () => { startRef.current = null; setResizing(false); };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointercancel', onEnd);
        };
    }, [resizing, setLeftWidth]);
    const handleResizeKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        let next: number | null = null;
        if (e.key === 'ArrowRight') next = leftWidth + WIDTH_KEY_STEP;
        else if (e.key === 'ArrowLeft') next = leftWidth - WIDTH_KEY_STEP;
        else if (e.key === 'Home') next = LEFT_WIDTH_MIN;
        else if (e.key === 'End') next = LEFT_WIDTH_MAX;
        if (next === null) return;
        e.preventDefault();
        setLeftWidth(next);
    }, [leftWidth, setLeftWidth]);

    return (
        <>
            {/* 説明はパネルの外（右、中央の側）に出す。左パネルの中の、次に触る欄を隠さないため */}
            <div id="left-panel" style={{ width: leftWidth, minWidth: leftWidth }} data-tip-side="right" data-tip-box="">
                <SubTabs idPrefix="" label="左パネルのタブ" tabs={TABS} active={leftTab} onSelect={setLeftTab} id="panel-tabs" />
                <div {...tabPanelProps('', 'learn', leftTab)}><LearnPanel /></div>
                <div {...tabPanelProps('', 'sound', leftTab)}><SoundPanel /></div>
                <div {...tabPanelProps('', 'file', leftTab)}><FilePanel /></div>
            </div>
            {/* 左パネルと中央の境目。ドラッグか、左右の矢印キーで動かす */}
            <div className={'resize-handle vertical' + (resizing ? ' dragging' : '')} id="resize-left"
                role="separator" aria-orientation="vertical" tabIndex={0}
                aria-label="左パネルの幅（左右の矢印キーで変えられます）"
                aria-valuemin={LEFT_WIDTH_MIN} aria-valuemax={LEFT_WIDTH_MAX} aria-valuenow={leftWidth}
                data-tip-side="right" {...tip('左右にドラッグすると、左パネルの幅が変わります')}
                onPointerDown={handleResizeDown} onKeyDown={handleResizeKey} />
        </>
    );
}
