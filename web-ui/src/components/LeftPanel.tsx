/**
 * bunri DAW — 左パネル（シンセ / ドラム / FX / ファイル / カルテ タブ）
 *
 * 画面の文は docs/ui-terms.md の決まりに合わせる。
 */
import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { useDaw, type LeftTab } from '../lib/store';
import engine from '../lib/engine';
import { apiFetch, errorDetail } from '../lib/api';
import { modelDownloadNotice } from '../lib/models';
import ChartPanel from './ChartPanel';
import CoachPanel from './CoachPanel';
import type { ChartResponse } from '../lib/chart';

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
 * @property hint - マウスを載せたときに画面の下端に出す説明
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
    const { bpm, setStatus, withProgress, showProgress, bumpTracks, pianoRollRef, setHint } = useDaw();
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
            const buffer = await engine.ctx!.decodeAudioData(buf);

            // 追加先は、セレクタで選んだトラック。選んでいなければ、ピアノロールで開いているトラック
            let trackId: number | string | null = synthTrack && engine.getTrack(synthTrack) ? synthTrack : pr.getActiveTrackId();
            if (!trackId || !engine.getTrack(trackId)) {
                if (engine.tracks.length === 0) engine.addTrack('Synth');
                trackId = engine.tracks[0].id;
            }
            const trackName = engine.tracks.find(t => String(t.id) === String(trackId))?.name || '';
            await engine.addClipFromBuffer(trackId, buffer, 'synth-seq');
            bumpTracks();
            setStatus(`シーケンスを「${trackName}」に追加しました`);
        });
    }, [bpm, wave, vol, a, d, s, r, instrument, gmProgram, synthTrack, pianoRollRef, withProgress, bumpTracks, setStatus]);

    // GM楽器をカテゴリ別にグループ化
    const instMap: Record<number, string> = {};
    gmInstruments.forEach(i => { instMap[i.program] = i.name; });

    /** マウスを載せたときに、画面の下端に説明を出す。 */
    const h = (text: string) => ({ onMouseEnter: () => setHint(text), onMouseLeave: () => setHint('') });

    return (
        <div id="synth-panel" className="panel-content active">
            <h3>シンセサイザー</h3>
            <p className="panel-desc">下のピアノロールにノートを置いてから「シーケンスをレンダリング」を押すと、ノートが音声のクリップになってトラックに入ります。</p>
            <label htmlFor="synth-gm">楽器（GM 音源）</label>
            <select id="synth-gm" value={gmProgram} onChange={e => setGmProgram(e.target.value)}>
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
                <summary>カスタム波形の設定（GM 音源を選んでいないとき）</summary>
                <label htmlFor="synth-instrument">簡易楽器</label>
                <select id="synth-instrument" value={instrument} onChange={e => setInstrument(e.target.value)}>
                    <option value="">基本波形（下で選択）</option>
                    <option value="guitar">ギター</option>
                    <option value="violin">バイオリン</option>
                    <option value="chorus">コーラス</option>
                    <option value="flute">フルート</option>
                    <option value="bass">ベース</option>
                    <option value="organ">オルガン</option>
                </select>
                <label htmlFor="synth-wave">波形</label>
                <select id="synth-wave" value={wave} onChange={e => setWave(e.target.value)}>
                    <option value="sine">サイン波（まろやか）</option>
                    <option value="square">矩形波（ファミコン風）</option>
                    <option value="sawtooth">のこぎり波（鋭い）</option>
                    <option value="triangle">三角波（柔らかい）</option>
                </select>
            </details>
            <div className="param-row">
                <div {...h('アタック: 音が鳴り始めてから、いちばん大きくなるまでの時間')}>
                    <label htmlFor="synth-attack">アタック</label>
                    <input id="synth-attack" type="range" min="0.001" max="1" step="0.001" value={a} onChange={e => setA(+e.target.value)} />
                </div>
                <div {...h('ディケイ: いちばん大きくなってから、伸ばしているあいだの大きさに落ち着くまでの時間')}>
                    <label htmlFor="synth-decay">ディケイ</label>
                    <input id="synth-decay" type="range" min="0.001" max="1" step="0.001" value={d} onChange={e => setD(+e.target.value)} />
                </div>
            </div>
            <div className="param-row">
                <div {...h('サステイン: 音を伸ばしているあいだの大きさ')}>
                    <label htmlFor="synth-sustain">サステイン</label>
                    <input id="synth-sustain" type="range" min="0" max="1" step="0.05" value={s} onChange={e => setS(+e.target.value)} />
                </div>
                <div {...h('リリース: ノートが終わってから、音が消えるまでの時間')}>
                    <label htmlFor="synth-release">リリース</label>
                    <input id="synth-release" type="range" min="0.001" max="2" step="0.001" value={r} onChange={e => setR(+e.target.value)} />
                </div>
            </div>
            <label htmlFor="synth-volume">音量</label>
            <input id="synth-volume" type="range" min="0" max="1" step="0.05" value={vol} onChange={e => setVol(+e.target.value)} />
            <label htmlFor="synth-track">追加先トラック</label>
            <TrackSelector id="synth-track" value={synthTrack} onChange={setSynthTrack} emptyLabel="ピアノロールで開いているトラック" />
            <button className="action-btn" onClick={handleRender} disabled={showProgress}>シーケンスをレンダリング</button>
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
    const { bpm, setStatus, withProgress, showProgress, bumpTracks } = useDaw();
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
            const buffer = await engine.ctx!.decodeAudioData(buf);

            let track;
            if (drumTrack === '__new__') {
                track = engine.addTrack('Drum');
            } else {
                track = engine.tracks.find(t => String(t.id) === drumTrack);
                if (!track) track = engine.addTrack('Drum');
            }
            await engine.addClipFromBuffer(track.id, buffer, `drum-${pattern}`);
            bumpTracks();
            setStatus(`ドラムを「${track.name}」に追加しました`);
        });
    }, [pattern, bpm, bars, vol, drumTrack, withProgress, bumpTracks, setStatus]);

    return (
        <div id="drum-panel" className="panel-content">
            <h3>ドラムマシン</h3>
            <p className="panel-desc">決まったパターンから、ドラムの音声のクリップを作ってトラックに追加します。</p>
            <label htmlFor="drum-pattern">パターン</label>
            <select id="drum-pattern" value={pattern} onChange={e => setPattern(e.target.value)}>
                <option value="8ビート">8ビート（ポップス/ロック定番）</option>
                <option value="4つ打ち">4つ打ち（ダンス/テクノ）</option>
                <option value="ボサノバ">ボサノバ</option>
                <option value="レゲエ">レゲエ</option>
            </select>
            <label htmlFor="drum-bars">小節数</label>
            <input id="drum-bars" type="number" value={bars} min="1" max="32" onChange={e => setBars(+e.target.value)} />
            <label htmlFor="drum-volume">音量</label>
            <input id="drum-volume" type="range" min="0" max="1" step="0.05" value={vol} onChange={e => setVol(+e.target.value)} />
            <label htmlFor="drum-track">追加先トラック</label>
            <TrackSelector id="drum-track" value={drumTrack} onChange={setDrumTrack} includeNew />
            <button className="action-btn" onClick={handleGenerate} disabled={showProgress}>ドラム生成 → トラックに追加</button>
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
    const { setStatus, withProgress, showProgress, bumpTracks, setHint } = useDaw();
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
            const buffer = await engine.ctx!.decodeAudioData(buf);
            track.clips[0] = { buffer, offset: clip.offset, name: `${clip.name}[${fxType}]`, duration: buffer.duration };
            bumpTracks();
            // 識別子 (pitch_shift など) ではなく、日本語の名前で知らせる
            setStatus(`「${label}」を適用しました`);
        });
    }, [fxTrack, fxType, params, withProgress, bumpTracks, setStatus]);

    return (
        <div id="fx-panel" className="panel-content">
            <h3>エフェクト</h3>
            <p className="panel-desc">トラックの最初のクリップにエフェクトをかけて、かけた後の音声に置き換えます。</p>
            <label htmlFor="fx-track">対象トラック</label>
            <TrackSelector id="fx-track" value={fxTrack} onChange={setFxTrack} />
            <label htmlFor="fx-type">エフェクト</label>
            <select id="fx-type" value={fxType} onChange={e => setFxType(e.target.value)}>
                {Object.entries(FX_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <div id="fx-params">
                {(FX_PARAMS[fxType] || []).map(p => (
                    <div key={p.id} onMouseEnter={() => setHint(p.hint)} onMouseLeave={() => setHint('')}>
                        <label htmlFor={`fx-param-${p.id}`}>{p.label}（{params[p.id] ?? p.def}）</label>
                        <input id={`fx-param-${p.id}`} type="range" min={p.min} max={p.max} step={p.step}
                            value={params[p.id] ?? p.def}
                            onChange={e => setParams(prev => ({ ...prev, [p.id]: +e.target.value }))} />
                    </div>
                ))}
            </div>
            <button className="action-btn" onClick={handleApply} disabled={showProgress}>エフェクト適用</button>
        </div>
    );
}

/**
 * `/api/decompose` レスポンスにおける 1 パート（原曲を楽器ごとに分けた 1 つぶん）のデータ構造。
 * API の側では「ステム」と呼んでいる。画面では「パート」と呼ぶ（docs/ui-terms.md）。
 *
 * @property audio_url - 分離済み音声ファイルのサーバー側 URL（省略可）
 * @property notes - ピアノロールへ配置するノート情報の配列（ドラム以外のパート用、省略可）
 * @property drum_events - ドラムイベントの配列（ドラムのパート用、省略可）
 * @property gm_program - 推定された GM プログラム番号（推定不能時は `null`）
 * @property mix - 推定されたミックスパラメータ（音量 dB・パン・リバーブウェット）
 */
interface DecomposeStem {
    audio_url?: string;
    notes?: Array<{ note: string; octave: number; step: number; length: number; velocity?: number }>;
    drum_events?: Array<{ type: string; step: number; velocity: number }>;
    gm_program: number | null;
    mix: { volume_db: number; pan: number; reverb_wet: number };
}

/**
 * `/api/decompose` レスポンス全体のデータ構造。
 *
 * @property bpm - 自動検出された楽曲テンポ（Beats Per Minute）
 * @property stems - パートの名前（`"vocals"`, `"drums"` など）をキーとする分離結果マップ
 */
interface DecomposeResult {
    bpm: number;
    stems: Record<string, DecomposeStem>;
}

/**
 * パートの名前（英語）から日本語表示ラベルへのマッピング定数。
 * `/api/decompose` レスポンスのキーをトラック名として UI に表示する際に使用する。
 */
const STEM_LABELS_JP: Record<string, string> = {
    vocals: 'ボーカル',
    drums: 'ドラム',
    bass: 'ベース',
    guitar: 'ギター',
    piano: 'ピアノ',
    other: 'その他',
};

/**
 * ファイルパネルコンポーネント。以下の機能を統合する:
 * - 原曲を取り込んでカルテを作る（`/api/chart`）
 * - 原曲をパートに分けて採譜する（`/api/decompose`）: パート分離 → 採譜 → トラック自動生成
 * - WAV ファイルをトラックに読み込む
 * - 単音メロディの解析（`/api/analyze`）によるピアノロール自動配置
 * - マイク録音の開始・停止とトラックへの追加
 *
 * @returns ファイルパネル全体の `<div id="file-panel">` 要素
 */
// ---- ファイルパネル ----
function FilePanel() {
    const {
        setStatus, bumpTracks, withProgress, showProgress, pianoRollRef, bpm, setBpm, beatsPerBar,
        setChartResult, setLeftTab,
    } = useDaw();
    const [fileTrack, setFileTrack] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const analyzeFileRef = useRef<HTMLInputElement>(null);
    const transcribeFileRef = useRef<HTMLInputElement>(null);
    const [sensitivity, setSensitivity] = useState(0.5);
    const [transcribeSensitivity, setTranscribeSensitivity] = useState(0.5);
    const [autoBpm, setAutoBpm] = useState(true);
    const [isRecording, setIsRecording] = useState(false);

    const handleImport = useCallback(async () => {
        const files = fileInputRef.current?.files;
        if (!files?.length) { setStatus('読み込む WAV ファイルを選んでください', 'error'); return; }
        if (engine.tracks.length === 0) engine.addTrack();
        const trackId = resolveTrackId(fileTrack);
        const trackName = engine.tracks.find(t => String(t.id) === String(trackId))?.name || '';
        for (const file of files) {
            try {
                await engine.addClipFromFile(trackId, file);
            } catch {
                setStatus(`${file.name} を読み込めませんでした。WAV ファイルかどうかを確かめてください`, 'error');
                bumpTracks();
                return;
            }
            setStatus(`${file.name} を「${trackName}」に追加しました`);
        }
        bumpTracks();
    }, [fileTrack, setStatus, bumpTracks]);

    const handleAnalyze = useCallback(async () => {
        const file = analyzeFileRef.current?.files?.[0];
        if (!file) { setStatus('解析するWAVファイルを選択してください', 'error'); return; }
        const pr = pianoRollRef.current;
        if (!pr?.getActiveTrackId()) { setStatus('先にトラックをクリックしてピアノロールを開いてください', 'error'); return; }
        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', String(bpm));
        fd.append('sensitivity', String(sensitivity));
        await withProgress(`音声を解析しています…（${file.name}）`, async () => {
            const resp = await apiFetch('/api/analyze', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const notes = await resp.json();
            if (notes.length === 0) { setStatus('ノートが見つかりませんでした。感度を上げて、もう一度試してください', 'error'); return; }
            pr.setNotes(notes);
            // タイムラインのトラックの見出しに出るノートの数を、置いた数に合わせる
            bumpTracks();
            setStatus(`${notes.length}個のノートを検出しました`);
        });
    }, [sensitivity, bpm, pianoRollRef, withProgress, setStatus, bumpTracks]);

    /**
     * 原曲を取り込んで、楽曲カルテ（速報）を作る。解析の入口。
     *
     * パート分離を行わないため数秒〜十数秒で返る。まずここで
     * キー・コード進行・構成・ミックスを掴んでもらい、パート分離が必要なら
     * そのあとで「パートに分ける」に進んでもらう導線にしている。
     * 終わったら、カルテのタブを開く（結果がどこに出たかを探させない）。
     */
    const handleAnalyzeChart = useCallback(async () => {
        const file = transcribeFileRef.current?.files?.[0];
        if (!file) { setStatus('取り込む曲のファイルを選んでください', 'error'); return; }

        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', autoBpm ? '0' : String(bpm));
        fd.append('beats_per_bar', String(beatsPerBar));

        await withProgress(`原曲を解析しています…（${file.name}）`, async () => {
            const resp = await apiFetch('/api/chart', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));

            const result: ChartResponse = await resp.json();
            setChartResult(result);
            if (autoBpm) setBpm(Math.round(result.chart.grid.bpm));
            setLeftTab('chart');

            const chords = result.chart.chords.length;
            setStatus(
                `カルテを作りました（${result.chart.key.tonic
                    ? `キー ${result.chart.key.tonic} ${result.chart.key.mode === 'minor' ? 'マイナー' : 'メジャー'}`
                    : 'キー不明'} / ${chords} コード）`
            );
        });
    }, [autoBpm, bpm, beatsPerBar, withProgress, setStatus, setBpm, setChartResult, setLeftTab]);

    const handleFullTranscribe = useCallback(async () => {
        const file = transcribeFileRef.current?.files?.[0];
        if (!file) { setStatus('取り込む曲のファイルを選んでください', 'error'); return; }

        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', autoBpm ? '0' : String(bpm));
        fd.append('sensitivity', String(transcribeSensitivity));

        // 分離用のモデルが手元に無ければ、初回ダウンロードが入ることを添える
        const notice = await modelDownloadNotice('htdemucs_6s');
        await withProgress(
            `原曲をパートに分けています…（${file.name}）パート分離 → 採譜 → 楽器の推定。数分かかります。${notice}`,
            async () => {
                const resp = await apiFetch('/api/decompose', { method: 'POST', body: fd });
                if (!resp.ok) throw new Error(await errorDetail(resp));
                const result: DecomposeResult = await resp.json();

                // BPM を自動検出値で更新
                if (autoBpm && result.bpm) {
                    setBpm(result.bpm);
                }

                const pr = pianoRollRef.current;
                const stemEntries = Object.entries(result.stems);
                let createdTracks = 0;
                let firstTrackId: number | null = null;
                let totalNotes = 0;

                for (const [stemName, stem] of stemEntries) {
                    const label = STEM_LABELS_JP[stemName] || stemName;
                    const track = engine.addTrack(label);
                    if (firstTrackId === null) firstTrackId = track.id;
                    createdTracks++;

                    // ミックスパラメータ反映
                    if (stem.mix) {
                        engine.updateTrackGain(track.id, stem.mix.volume_db);
                        engine.updateTrackPan(track.id, stem.mix.pan);
                    }

                    // 音声クリップを追加
                    if (stem.audio_url) {
                        try {
                            await engine.addClipFromUrl(track.id, stem.audio_url, label, 0);
                        } catch (e) {
                            console.warn(`${stemName} の音声読み込みに失敗:`, e);
                        }
                    }

                    // ピアノロールノートを設定（ドラム以外）
                    if (stem.notes && stem.notes.length > 0) {
                        track.pianoNotes = stem.notes.map(n => ({
                            note: n.note,
                            octave: n.octave,
                            step: n.step,
                            length: n.length,
                        }));
                        // 採譜した時点のノートを、お手本として控えておく（差分コーチが使う）
                        track.referenceNotes = track.pianoNotes.map(n => ({ ...n }));
                        totalNotes += stem.notes.length;
                    }

                    // ドラムイベントを長さ1のパーカッションノートとして近似配置
                    if (stem.drum_events && stem.drum_events.length > 0) {
                        // type ごとに別のMIDIノートに割り当て（C1=kick, D1=snare, F#1=hihat 近似）
                        const drumMap: Record<string, { note: string; octave: number }> = {
                            kick: { note: 'C', octave: 2 },
                            snare: { note: 'D', octave: 2 },
                            hihat: { note: 'F#', octave: 2 },
                        };
                        track.pianoNotes = stem.drum_events.map(e => ({
                            ...(drumMap[e.type] || drumMap.kick),
                            step: e.step,
                            length: 1,
                        }));
                        totalNotes += stem.drum_events.length;
                    }
                }

                bumpTracks();

                // 最初のパートのピアノロールを開く
                if (firstTrackId !== null && pr) {
                    pr.switchToTrack(firstTrackId);
                }

                setStatus(
                    `パートに分けました（BPM ${result.bpm} / ${createdTracks} トラック / ${totalNotes} ノートを配置）`
                );
            },
        );
    }, [bpm, autoBpm, transcribeSensitivity, withProgress, setStatus, setBpm, bumpTracks, pianoRollRef]);

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
        let recTrack = engine.tracks.find(t => t.name.includes('Rec'));
        if (!recTrack) recTrack = engine.addTrack('Rec');
        await engine.addClipFromBuffer(recTrack.id, buffer, 'recording');
        bumpTracks();
        setStatus('録音をトラックに追加しました');
    }, [bumpTracks, setStatus]);

    return (
        <div id="file-panel" className="panel-content">
            <h3>原曲を取り込む</h3>
            <p className="panel-desc">
                曲のファイルを取り込んで、キー・コード進行・構成・ミックスの特性を調べます（数秒〜十数秒）。
                結果は<strong>カルテ</strong>に出て、自分で再現するための材料になります。
            </p>
            <label htmlFor="file-song">原曲のファイル</label>
            <input id="file-song" type="file" ref={transcribeFileRef} accept=".wav,.mp3,.flac,.ogg,.m4a" />
            <div className="param-row">
                <div>
                    <label htmlFor="file-auto-bpm">
                        <input id="file-auto-bpm" type="checkbox" checked={autoBpm}
                            onChange={e => setAutoBpm(e.target.checked)}
                            style={{ marginRight: 4 }} />
                        BPM を自動で検出する
                    </label>
                </div>
            </div>
            <button className="action-btn" onClick={handleAnalyzeChart} disabled={showProgress}>
                原曲を取り込んでカルテを作る
            </button>

            <details style={{ marginTop: 10 }}>
                <summary>パートに分ける（パート分離）</summary>
                <p className="panel-desc" style={{ marginTop: 6 }}>
                    原曲をパート（ボーカル・ドラム・ベースなど）に分け、パートごとにノートを採譜して、
                    トラックとピアノロールに並べます。採譜したノートは<strong style={{ color: 'var(--accent)' }}>お手本</strong>として残り、
                    「差分チェック」で自分の打ち込みと比べられます。
                    先に自分で打ち込んでみてから、お手本と比べるのがおすすめです。
                </p>
                <label htmlFor="file-transcribe-sensitivity">採譜の感度（{transcribeSensitivity}）</label>
                <input id="file-transcribe-sensitivity" type="range" min="0.1" max="1" step="0.05"
                    value={transcribeSensitivity}
                    onChange={e => setTranscribeSensitivity(+e.target.value)} />
                <button className="action-btn" onClick={handleFullTranscribe} disabled={showProgress}>
                    パートに分けて採譜する（数分かかります）
                </button>
            </details>
            <hr />
            <h3>WAV ファイルを読み込む</h3>
            <p className="panel-desc">WAV ファイルをトラックに追加します。タイムラインに直接ドラッグ&ドロップしても追加できます。</p>
            <label htmlFor="file-import">WAV ファイル</label>
            <input id="file-import" type="file" ref={fileInputRef} accept=".wav" multiple />
            <label htmlFor="file-track">追加先トラック</label>
            <TrackSelector id="file-track" value={fileTrack} onChange={setFileTrack} />
            <button className="action-btn" onClick={handleImport}>選択したトラックに追加</button>
            <hr />
            <h3>単音メロディ解析</h3>
            <p className="panel-desc">単音の WAV ファイル（ボーカルやメロディ）から音の高さを読み取って、開いているピアノロールにノートを並べます。</p>
            <label htmlFor="file-melody">単音の WAV ファイル</label>
            <input id="file-melody" type="file" ref={analyzeFileRef} accept=".wav" />
            <label htmlFor="file-melody-sensitivity">感度（{sensitivity}）</label>
            <input id="file-melody-sensitivity" type="range" min="0.1" max="1" step="0.05" value={sensitivity}
                onChange={e => setSensitivity(+e.target.value)} />
            <button className="action-btn" onClick={handleAnalyze} disabled={showProgress}>解析してピアノロールに配置</button>
            <hr />
            <h3>録音</h3>
            <p className="panel-desc">マイクから音声を録音してトラックに追加します。</p>
            {!isRecording
                ? <button className="action-btn" onClick={handleMicRecord}>マイク録音開始</button>
                : <button className="action-btn" onClick={handleMicStop}>録音停止</button>
            }
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
function TrackSelector({ value, onChange, includeNew, emptyLabel, id }: TrackSelectorProps) {
    // trackVersion を読んでおくと、トラックが増減するたびに描き直されて、選択肢に反映される
    const { trackVersion } = useDaw();
    void trackVersion;
    // トラック以外の選択肢 (新規作成・選ばない) が在るときは、その値をそのまま表示する。
    // 無いときは、表示されるトラックと、処理で使うトラック (resolveTrackId) を一致させる
    const shown = includeNew || emptyLabel !== undefined
        ? (value === '__new__' || engine.tracks.some(t => String(t.id) === value) ? value : (includeNew ? '__new__' : ''))
        : resolveTrackId(value);
    return (
        <select id={id} value={shown} onChange={e => onChange(e.target.value)}>
            {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
            {includeNew && <option value="__new__">新規作成（Drum）</option>}
            {engine.tracks.map(t => (
                <option key={t.id} value={String(t.id)}>{t.name}</option>
            ))}
        </select>
    );
}

/**
 * 左パネルのタブ定義。`key` はパネルの識別子、`label` はタブボタンの表示文字列。
 */
// ---- メインの LeftPanel ----
const TABS: { key: LeftTab; label: string }[] = [
    { key: 'synth', label: 'シンセ' },
    { key: 'drum', label: 'ドラム' },
    { key: 'fx', label: 'FX' },
    { key: 'file', label: 'ファイル' },
    { key: 'chart', label: 'カルテ' },
];

/**
 * 左パネルコンポーネント。
 * シンセ・ドラム・FX・ファイル・カルテの 5 タブを切り替えて表示する。
 * 各タブの内容は常に DOM に存在し、`hidden` の切り替えで表示・非表示を制御する。
 *
 * どのタブを開いているかは全体の状態（`leftTab`）に置いてある。解析が終わったときにカルテを開く、
 * といった切り替えを、ほかの部品からもできるようにするため。
 *
 * タブは `role="tablist"` / `tab` / `tabpanel` で組んであり、左右の矢印キーと Home / End で移れる。
 * 余白は中のパネル（`.panel-content`）が持つ。この枠には付けない（二重に付けると中身の幅が足りなくなる）。
 *
 * @returns 左パネル全体の `<div id="left-panel">` 要素
 */
export default function LeftPanel() {
    const { leftTab, setLeftTab } = useDaw();
    const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

    /** 左右の矢印キーと Home / End で、タブを移る。 */
    const handleTabKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        const index = TABS.findIndex(tab => tab.key === leftTab);
        let next = -1;
        if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = TABS.length - 1;
        if (next < 0) return;
        e.preventDefault();
        setLeftTab(TABS[next].key);
        tabRefs.current[TABS[next].key]?.focus();
    }, [leftTab, setLeftTab]);

    /** タブの中身を入れる枠の属性。 */
    const panelProps = (key: LeftTab) => ({
        id: `tabpanel-${key}`,
        className: 'panel-scroll',
        role: 'tabpanel',
        'aria-labelledby': `tab-${key}`,
        hidden: leftTab !== key,
    });

    return (
        <div id="left-panel">
            <div id="panel-tabs" role="tablist" aria-label="左パネルのタブ" onKeyDown={handleTabKey}>
                {TABS.map(tab => (
                    <button key={tab.key} type="button" role="tab"
                        id={`tab-${tab.key}`}
                        ref={el => { tabRefs.current[tab.key] = el; }}
                        aria-selected={leftTab === tab.key}
                        aria-controls={`tabpanel-${tab.key}`}
                        // 矢印キーで移るので、Tab キーで止まるのは開いているタブだけにする
                        tabIndex={leftTab === tab.key ? 0 : -1}
                        className={leftTab === tab.key ? 'active' : ''}
                        onClick={() => setLeftTab(tab.key)}>
                        {tab.label}
                    </button>
                ))}
            </div>
            <div {...panelProps('synth')}><SynthPanel /></div>
            <div {...panelProps('drum')}><DrumPanel /></div>
            <div {...panelProps('fx')}><FxPanel /></div>
            <div {...panelProps('file')}><FilePanel /></div>
            <div {...panelProps('chart')}>
                <ChartPanel />
                <CoachPanel />
            </div>
        </div>
    );
}
