/**
 * bunri DAW — 左パネル（シンセ / ドラム / FX / ファイル タブ）
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import AssistantPanel from './AssistantPanel';

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
 * @property label - UI 上に表示するラベル文字列（例: `"Threshold (dB)"`）
 * @property min - スライダーの最小値
 * @property max - スライダーの最大値
 * @property step - スライダーのステップ幅
 * @property def - デフォルト値（エフェクト切り替え時に適用される）
 */
interface FxParamDef {
    id: string;
    label: string;
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
    'ピアノ': [0,1,2,3,4,5,6,7,8],
    'クロマチックパーカッション': [9,10,11,12,13,14,15],
    'オルガン': [16,17,18,19,20,21,22,23],
    'ギター': [24,25,26,27,28,29,30,31],
    'ベース': [32,33,34,35,36,37,38,39],
    'ストリングス': [40,41,42,43,44,45,46,47],
    'アンサンブル/合唱': [48,49,50,51,52,53,54,55],
    'ブラス': [56,57,58,59,60,61,62,63],
    'リード/サックス': [64,65,66,67],
    '木管': [68,69,70,71,72,73,74,75,76,77,78,79],
    'シンセリード': [80,81,82,83,84,85,86,87],
    'シンセパッド': [88,89,90,91,92,93,94,95],
    'シンセ効果音': [96,97,98,99,100,101,102,103],
    'エスニック': [104,105,106,107,108,109,110,111],
    'パーカッション': [112,113,114,115,116,117,118,119],
    'サウンドエフェクト': [120,121,122,123,124,125,126,127],
};

/**
 * エフェクト種別ごとのパラメータ定義マップ。
 * キーは `/api/effects/{name}` のパス部分（`"eq"`, `"reverb"` など）と一致する。
 * 値は空配列の場合、追加パラメータなし（例: `"normalize"`）。
 */
// ---- FXパラメータ定義 ----
const FX_PARAMS: Record<string, FxParamDef[]> = {
    eq: [
        { id: 'low', label: 'Low (dB)', min: -12, max: 12, step: 1, def: 0 },
        { id: 'mid', label: 'Mid (dB)', min: -12, max: 12, step: 1, def: 0 },
        { id: 'high', label: 'High (dB)', min: -12, max: 12, step: 1, def: 0 },
    ],
    compressor: [
        { id: 'threshold', label: 'Threshold (dB)', min: -40, max: 0, step: 1, def: -20 },
        { id: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, def: 4 },
    ],
    reverb: [
        { id: 'room_size', label: 'Room Size', min: 0, max: 1, step: 0.05, def: 0.5 },
        { id: 'wet', label: 'Wet', min: 0, max: 1, step: 0.05, def: 0.3 },
    ],
    delay: [
        { id: 'delay_ms', label: 'Time (ms)', min: 50, max: 2000, step: 10, def: 300 },
        { id: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.05, def: 0.4 },
        { id: 'wet', label: 'Wet', min: 0, max: 1, step: 0.05, def: 0.3 },
    ],
    normalize: [],
    pitch_shift: [
        { id: 'semitones', label: '半音', min: -12, max: 12, step: 1, def: 0 },
    ],
    time_stretch: [
        { id: 'rate', label: '速度', min: 0.25, max: 3, step: 0.05, def: 1 },
    ],
};

/**
 * シンセサイザーパネルコンポーネント。
 * GM 音源またはカスタム波形を選択し、ピアノロールのノートを
 * `/api/synth/sequence` へ送信してシーケンスをレンダリング・トラックに追加する。
 *
 * @returns シンセパネル全体の `<div id="synth-panel">` 要素
 */
// ---- シンセパネル ----
function SynthPanel() {
    const { bpm, setStatus, withProgress, bumpTracks, pianoRollRef, setHint } = useDaw();
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
        fetch('/api/gm-instruments').then(r => r.json())
            .then((data: GmInstrument[]) => setGmInstruments(data)).catch(() => {});
    }, []);

    const handleRender = useCallback(async () => {
        const pr = pianoRollRef.current;
        if (!pr) return;
        const notes = pr.getNotes();
        if (notes.length === 0) {
            setStatus('ピアノロールにノートを配置してください');
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

        await withProgress('シーケンスをレンダリング中...', async () => {
            const resp = await fetch('/api/synth/sequence', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const blob = await resp.blob();
            const buf = await blob.arrayBuffer();
            const buffer = await engine.ctx!.decodeAudioData(buf);

            let trackId = pr.getActiveTrackId();
            if (!trackId || !engine.tracks.find(t => t.id === trackId)) {
                trackId = synthTrack || (engine.tracks[0]?.id);
                if (!trackId) { engine.addTrack('Synth'); trackId = engine.tracks[0].id; }
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

    return (
        <div id="synth-panel" className="panel-content active">
            <h3>シンセサイザー</h3>
            <p className="panel-desc">下のピアノロールにノートを配置してからレンダリングすると、音声が生成されてトラックに追加されます。</p>
            <label>楽器（GM音源）</label>
            <select value={gmProgram} onChange={e => setGmProgram(e.target.value)}>
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
                <summary style={{ fontSize: 11, color: 'var(--text-dim)', cursor: 'pointer' }}>
                    カスタム波形設定（GM音源未選択時）
                </summary>
                <label>簡易楽器</label>
                <select value={instrument} onChange={e => setInstrument(e.target.value)}>
                    <option value="">基本波形（下で選択）</option>
                    <optgroup label="鍵盤">
                        <option value="piano">ピアノ</option>
                        <option value="epiano">エレピ</option>
                        <option value="organ">オルガン</option>
                    </optgroup>
                    <optgroup label="弦">
                        <option value="guitar">ギター</option>
                        <option value="pluck">プラック</option>
                        <option value="violin">バイオリン</option>
                        <option value="strings">ストリングス</option>
                        <option value="bass">ベース</option>
                    </optgroup>
                    <optgroup label="管">
                        <option value="flute">フルート</option>
                        <option value="brass">ブラス</option>
                    </optgroup>
                    <optgroup label="ボイス">
                        <option value="chorus">コーラス（デチューン）</option>
                        <option value="choir">合唱（男女混声）</option>
                    </optgroup>
                    <optgroup label="シンセ">
                        <option value="lead">シンセリード</option>
                        <option value="pad">シンセパッド</option>
                        <option value="bell">シンセベル</option>
                    </optgroup>
                </select>
                <label>波形</label>
                <select value={wave} onChange={e => setWave(e.target.value)}>
                    <option value="sine">Sine（まろやか）</option>
                    <option value="square">Square（ファミコン風）</option>
                    <option value="sawtooth">Sawtooth（鋭い）</option>
                    <option value="triangle">Triangle（柔らかい）</option>
                </select>
            </details>
            <div className="param-row">
                <div><label>Attack</label><input type="range" min="0.001" max="1" step="0.001" value={a} onChange={e => setA(+e.target.value)} /></div>
                <div><label>Decay</label><input type="range" min="0.001" max="1" step="0.001" value={d} onChange={e => setD(+e.target.value)} /></div>
            </div>
            <div className="param-row">
                <div><label>Sustain</label><input type="range" min="0" max="1" step="0.05" value={s} onChange={e => setS(+e.target.value)} /></div>
                <div><label>Release</label><input type="range" min="0.001" max="2" step="0.001" value={r} onChange={e => setR(+e.target.value)} /></div>
            </div>
            <label>音量</label>
            <input type="range" min="0" max="1" step="0.05" value={vol} onChange={e => setVol(+e.target.value)} />
            <label>追加先トラック</label>
            <TrackSelector value={synthTrack} onChange={setSynthTrack} />
            <button className="action-btn" onClick={handleRender}>シーケンスをレンダリング</button>
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
    const { bpm, setStatus, withProgress, bumpTracks } = useDaw();
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

        await withProgress('ドラム生成中...', async () => {
            const resp = await fetch('/api/synth/drum', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
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
            <p className="panel-desc">プリセットパターンからドラムトラックを自動生成します。</p>
            <label>パターン</label>
            <select value={pattern} onChange={e => setPattern(e.target.value)}>
                <option value="8ビート">8ビート（ポップス/ロック定番）</option>
                <option value="4つ打ち">4つ打ち（ダンス/テクノ）</option>
                <option value="ボサノバ">ボサノバ</option>
                <option value="レゲエ">レゲエ</option>
            </select>
            <label>小節数</label>
            <input type="number" value={bars} min="1" max="32" onChange={e => setBars(+e.target.value)} />
            <label>音量</label>
            <input type="range" min="0" max="1" step="0.05" value={vol} onChange={e => setVol(+e.target.value)} />
            <label>追加先トラック</label>
            <TrackSelector value={drumTrack} onChange={setDrumTrack} includeNew />
            <button className="action-btn" onClick={handleGenerate}>ドラム生成 → トラックに追加</button>
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
    const { setStatus, withProgress, bumpTracks } = useDaw();
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
        const track = engine.getTrack(fxTrack);
        if (!track || track.clips.length === 0) {
            setStatus('エフェクト対象のトラックにクリップがありません');
            return;
        }
        // 最初のクリップをWAVに変換して送信
        await withProgress('エフェクト適用中...', async () => {
            const clip = track.clips[0];
            const wavBlob = engine._audioBufferToWav(clip.buffer);
            const fd = new FormData();
            fd.append('file', wavBlob, 'clip.wav');
            fd.append('params', JSON.stringify(params));
            const resp = await fetch(`/api/effects/${fxType}`, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const blob = await resp.blob();
            const buf = await blob.arrayBuffer();
            const buffer = await engine.ctx!.decodeAudioData(buf);
            track.clips[0] = { buffer, offset: clip.offset, name: `${clip.name}[${fxType}]`, duration: buffer.duration };
            bumpTracks();
            setStatus(`${fxType} を適用しました`);
        });
    }, [fxTrack, fxType, params, withProgress, bumpTracks, setStatus]);

    return (
        <div id="fx-panel" className="panel-content">
            <h3>エフェクト</h3>
            <label>対象トラック</label>
            <TrackSelector value={fxTrack} onChange={setFxTrack} />
            <label>エフェクト</label>
            <select value={fxType} onChange={e => setFxType(e.target.value)}>
                <option value="eq">EQ (3バンド)</option>
                <option value="compressor">コンプレッサー</option>
                <option value="reverb">リバーブ</option>
                <option value="delay">ディレイ</option>
                <option value="normalize">ノーマライズ</option>
                <option value="pitch_shift">ピッチシフト</option>
                <option value="time_stretch">タイムストレッチ</option>
            </select>
            <div id="fx-params">
                {(FX_PARAMS[fxType] || []).map(p => (
                    <div key={p.id}>
                        <label>{p.label}</label>
                        <input type="range" min={p.min} max={p.max} step={p.step}
                            value={params[p.id] ?? p.def}
                            onChange={e => setParams(prev => ({ ...prev, [p.id]: +e.target.value }))} />
                    </div>
                ))}
            </div>
            <button className="action-btn" onClick={handleApply}>エフェクト適用</button>
        </div>
    );
}

/**
 * `/api/decompose` レスポンスにおける単一ステム（音源分離パート）のデータ構造。
 *
 * @property audio_url - 分離済み音声ファイルのサーバー側 URL（省略可）
 * @property notes - ピアノロールへ配置するノート情報の配列（ドラム以外のステム用、省略可）
 * @property drum_events - ドラムイベントの配列（ドラムステム用、省略可）
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
 * @property stems - ステム名（`"vocals"`, `"drums"` など）をキーとする分離結果マップ
 */
interface DecomposeResult {
    bpm: number;
    stems: Record<string, DecomposeStem>;
}

/**
 * ステム名（英語）から日本語表示ラベルへのマッピング定数。
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
 * - 楽曲の完全解析（`/api/decompose`）: ステム分離 → ピッチ検出 → トラック自動生成
 * - WAV ファイルのトラックへのインポート
 * - 単音メロディの解析（`/api/analyze`）によるピアノロール自動配置
 * - マイク録音の開始・停止とトラックへの追加
 *
 * @returns ファイルパネル全体の `<div id="file-panel">` 要素
 */
// ---- ファイルパネル ----
function FilePanel() {
    const { setStatus, bumpTracks, withProgress, pianoRollRef, bpm, setBpm } = useDaw();
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
        if (!files?.length) return;
        let trackId = fileTrack;
        if (!trackId || !engine.tracks.find(t => String(t.id) === String(trackId))) {
            if (engine.tracks.length === 0) engine.addTrack();
            trackId = String(engine.tracks[engine.tracks.length - 1].id);
        }
        const trackName = engine.tracks.find(t => String(t.id) === String(trackId))?.name || '';
        for (const file of files) {
            await engine.addClipFromFile(trackId, file);
            setStatus(`${file.name} を「${trackName}」に追加しました`);
        }
        bumpTracks();
    }, [fileTrack, setStatus, bumpTracks]);

    const handleAnalyze = useCallback(async () => {
        const file = analyzeFileRef.current?.files?.[0];
        if (!file) { setStatus('解析するWAVファイルを選択してください'); return; }
        const pr = pianoRollRef.current;
        if (!pr?.getActiveTrackId()) { setStatus('先にトラックをクリックしてピアノロールを開いてください'); return; }
        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', String(bpm));
        fd.append('sensitivity', String(sensitivity));
        await withProgress(`音声を解析中...（${file.name}）`, async () => {
            const resp = await fetch('/api/analyze', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const notes = await resp.json();
            if (notes.length === 0) { setStatus('ノートが検出されませんでした'); return; }
            pr.setNotes(notes);
            setStatus(`${notes.length}個のノートを検出しました`);
        });
    }, [sensitivity, bpm, pianoRollRef, withProgress, setStatus]);

    const handleFullTranscribe = useCallback(async () => {
        const file = transcribeFileRef.current?.files?.[0];
        if (!file) { setStatus('解析する楽曲ファイルを選択してください'); return; }

        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', autoBpm ? '0' : String(bpm));
        fd.append('sensitivity', String(transcribeSensitivity));

        await withProgress(
            `楽曲を解析中...（${file.name}）ステム分離 → ピッチ検出 → 楽器推定。数分かかります`,
            async () => {
                const resp = await fetch('/api/decompose', { method: 'POST', body: fd });
                if (!resp.ok) throw new Error(await resp.text());
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

                // 最初のステムのピアノロールを開く
                if (firstTrackId !== null && pr) {
                    pr.switchToTrack(firstTrackId);
                }

                setStatus(
                    `解析完了！BPM: ${result.bpm} / ${createdTracks}トラック / ${totalNotes}ノート自動配置`
                );
            },
        );
    }, [bpm, autoBpm, transcribeSensitivity, withProgress, setStatus, setBpm, bumpTracks, pianoRollRef]);

    const handleMicRecord = useCallback(async () => {
        try {
            await engine.startRecording();
            setIsRecording(true);
            setStatus('録音中...');
        } catch (_e) { setStatus('マイクにアクセスできません'); }
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
            <h3 style={{ color: 'var(--accent)' }}>楽曲を完全解析して配置</h3>
            <p className="panel-desc">
                <strong>アップロード1回で全自動:</strong> ステム分離 → ピッチ検出 → 楽器推定 → トラック自動作成 → ピアノロール配置。
                既存曲を分解してDAWで再現・編集できます。
            </p>
            <input type="file" ref={transcribeFileRef} accept=".wav,.mp3,.flac,.ogg,.m4a" />
            <div className="param-row">
                <div>
                    <label>
                        <input type="checkbox" checked={autoBpm}
                            onChange={e => setAutoBpm(e.target.checked)}
                            style={{ marginRight: 4 }} />
                        BPM自動検出
                    </label>
                </div>
                <div>
                    <label>感度 ({transcribeSensitivity})</label>
                    <input type="range" min="0.1" max="1" step="0.05"
                        value={transcribeSensitivity}
                        onChange={e => setTranscribeSensitivity(+e.target.value)} />
                </div>
            </div>
            <button className="action-btn" onClick={handleFullTranscribe}>
                楽曲を完全解析（数分かかります）
            </button>
            <hr style={{ borderColor: 'var(--border)', margin: '12px 0' }} />
            <h3>ファイル読み込み</h3>
            <p className="panel-desc">WAVファイルをトラックに追加します。タイムライン上に直接ドラッグ&ドロップもできます。</p>
            <input type="file" ref={fileInputRef} accept=".wav" multiple />
            <label>追加先トラック</label>
            <TrackSelector value={fileTrack} onChange={setFileTrack} />
            <button className="action-btn" onClick={handleImport}>選択したトラックに追加</button>
            <hr style={{ borderColor: 'var(--border)', margin: '12px 0' }} />
            <h3>単音メロディ解析</h3>
            <p className="panel-desc">単音のWAVからピッチを抽出して、選択中のピアノロールに配置します（ボーカルやメロディ用）。</p>
            <input type="file" ref={analyzeFileRef} accept=".wav" />
            <label>感度</label>
            <input type="range" min="0.1" max="1" step="0.05" value={sensitivity}
                onChange={e => setSensitivity(+e.target.value)} />
            <button className="action-btn" onClick={handleAnalyze}>解析してピアノロールに配置</button>
            <hr style={{ borderColor: 'var(--border)', margin: '12px 0' }} />
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
 */
// ---- トラック選択セレクタ（共通部品）----
interface TrackSelectorProps {
    value: string;
    onChange: (v: string) => void;
    includeNew?: boolean;
}

/**
 * 現在のエンジントラック一覧から選択できる `<select>` コンポーネント。
 * `trackVersion` が変わると自動的に再描画され、トラックの増減を反映する。
 *
 * @param value - 現在選択中のトラック ID 文字列
 * @param onChange - 選択変更時のコールバック（新しいトラック ID を引数に受け取る）
 * @param includeNew - `true` のとき「新規作成（Drum）」オプションを先頭に追加する
 * @returns エンジントラック一覧を選択肢として持つ `<select>` 要素
 */
function TrackSelector({ value, onChange, includeNew }: TrackSelectorProps) {
    const { trackVersion } = useDaw();
    return (
        <select value={value} onChange={e => onChange(e.target.value)}>
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
const TABS = [
    { key: 'synth', label: 'シンセ' },
    { key: 'drum', label: 'ドラム' },
    { key: 'fx', label: 'FX' },
    { key: 'file', label: 'ファイル' },
    { key: 'ai', label: 'AI' },
];

/**
 * 左パネルコンポーネント。
 * シンセ・ドラム・FX・ファイル・AI の 5 タブを切り替えて表示する。
 * 各タブの内容は常に DOM に存在し、`display` の切り替えで表示・非表示を制御する。
 *
 * @returns 左パネル全体の `<div id="left-panel">` 要素
 */
export default function LeftPanel() {
    const [activeTab, setActiveTab] = useState('synth');

    return (
        <div id="left-panel">
            <div id="panel-tabs">
                {TABS.map(tab => (
                    <button key={tab.key}
                        className={activeTab === tab.key ? 'active' : ''}
                        onClick={() => setActiveTab(tab.key)}>
                        {tab.label}
                    </button>
                ))}
            </div>
            <div style={{ display: activeTab === 'synth' ? 'block' : 'none', flex: 1, overflow: 'auto', padding: 16 }}>
                <SynthPanel />
            </div>
            <div style={{ display: activeTab === 'drum' ? 'block' : 'none', flex: 1, overflow: 'auto', padding: 16 }}>
                <DrumPanel />
            </div>
            <div style={{ display: activeTab === 'fx' ? 'block' : 'none', flex: 1, overflow: 'auto', padding: 16 }}>
                <FxPanel />
            </div>
            <div style={{ display: activeTab === 'file' ? 'block' : 'none', flex: 1, overflow: 'auto', padding: 16 }}>
                <FilePanel />
            </div>
            <div style={{ display: activeTab === 'ai' ? 'block' : 'none', flex: 1, overflow: 'auto', padding: 16 }}>
                <AssistantPanel />
            </div>
        </div>
    );
}
