/**
 * bunri DAW — 左パネル（シンセ / ドラム / FX / ファイル タブ）
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useDaw } from '../lib/store.jsx';
import engine from '../lib/engine.js';

// ---- GM楽器カテゴリ ----
const GM_CATEGORIES = {
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

// ---- FXパラメータ定義 ----
const FX_PARAMS = {
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
    const [gmInstruments, setGmInstruments] = useState([]);

    useEffect(() => {
        fetch('/api/gm-instruments').then(r => r.json())
            .then(setGmInstruments).catch(() => {});
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
        fd.append('bpm', bpm);
        fd.append('waveform', wave);
        fd.append('volume', vol);
        fd.append('attack', a); fd.append('decay', d);
        fd.append('sustain', s); fd.append('release', r);
        fd.append('instrument', instrument);
        fd.append('gm_program', gmProgram);

        await withProgress('シーケンスをレンダリング中...', async () => {
            const resp = await fetch('/api/synth/sequence', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const blob = await resp.blob();
            const buf = await blob.arrayBuffer();
            const buffer = await engine.ctx.decodeAudioData(buf);

            let trackId = pr.getActiveTrackId();
            if (!trackId || !engine.tracks.find(t => t.id === trackId)) {
                trackId = synthTrack || (engine.tracks[0]?.id);
                if (!trackId) { engine.addTrack('Synth'); trackId = engine.tracks[0].id; }
            }
            const trackName = engine.tracks.find(t => t.id == trackId)?.name || '';
            await engine.addClipFromBuffer(trackId, buffer, 'synth-seq');
            bumpTracks();
            setStatus(`シーケンスを「${trackName}」に追加しました`);
        });
    }, [bpm, wave, vol, a, d, s, r, instrument, gmProgram, synthTrack, pianoRollRef, withProgress, bumpTracks, setStatus]);

    // GM楽器をカテゴリ別にグループ化
    const instMap = {};
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
                    <option value="guitar">ギター</option>
                    <option value="violin">バイオリン</option>
                    <option value="chorus">コーラス</option>
                    <option value="flute">フルート</option>
                    <option value="bass">ベース</option>
                    <option value="organ">オルガン</option>
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
        fd.append('bpm', bpm);
        fd.append('bars', bars);
        fd.append('volume', vol);

        await withProgress('ドラム生成中...', async () => {
            const resp = await fetch('/api/synth/drum', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const blob = await resp.blob();
            const buf = await blob.arrayBuffer();
            const buffer = await engine.ctx.decodeAudioData(buf);

            let track;
            if (drumTrack === '__new__') {
                track = engine.addTrack('Drum');
            } else {
                track = engine.tracks.find(t => t.id == drumTrack);
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

// ---- FXパネル ----
function FxPanel() {
    const { setStatus, withProgress, bumpTracks } = useDaw();
    const [fxTrack, setFxTrack] = useState('');
    const [fxType, setFxType] = useState('eq');
    const [params, setParams] = useState({});

    useEffect(() => {
        const defs = {};
        (FX_PARAMS[fxType] || []).forEach(p => { defs[p.id] = p.def; });
        setParams(defs);
    }, [fxType]);

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
            const buffer = await engine.ctx.decodeAudioData(buf);
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

// ---- ファイルパネル ----
function FilePanel() {
    const { setStatus, bumpTracks, withProgress, pianoRollRef, bpm } = useDaw();
    const [fileTrack, setFileTrack] = useState('');
    const fileInputRef = useRef(null);
    const analyzeFileRef = useRef(null);
    const [sensitivity, setSensitivity] = useState(0.5);
    const [isRecording, setIsRecording] = useState(false);

    const handleImport = useCallback(async () => {
        const files = fileInputRef.current?.files;
        if (!files?.length) return;
        let trackId = fileTrack;
        if (!trackId || !engine.tracks.find(t => t.id == trackId)) {
            if (engine.tracks.length === 0) engine.addTrack();
            trackId = engine.tracks[engine.tracks.length - 1].id;
        }
        const trackName = engine.tracks.find(t => t.id == trackId)?.name || '';
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
        fd.append('bpm', bpm);
        fd.append('sensitivity', sensitivity);
        await withProgress(`音声を解析中...（${file.name}）`, async () => {
            const resp = await fetch('/api/analyze', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const notes = await resp.json();
            if (notes.length === 0) { setStatus('ノートが検出されませんでした'); return; }
            pr.setNotes(notes);
            setStatus(`${notes.length}個のノートを検出しました`);
        });
    }, [sensitivity, bpm, pianoRollRef, withProgress, setStatus]);

    const handleMicRecord = useCallback(async () => {
        try {
            await engine.startRecording();
            setIsRecording(true);
            setStatus('録音中...');
        } catch { setStatus('マイクにアクセスできません'); }
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
            <h3>ファイル読み込み</h3>
            <p className="panel-desc">WAVファイルをトラックに追加します。タイムライン上に直接ドラッグ&ドロップもできます。</p>
            <input type="file" ref={fileInputRef} accept=".wav" multiple />
            <label>追加先トラック</label>
            <TrackSelector value={fileTrack} onChange={setFileTrack} />
            <button className="action-btn" onClick={handleImport}>選択したトラックに追加</button>
            <hr style={{ borderColor: 'var(--border)', margin: '12px 0' }} />
            <h3>WAV解析 → ピアノロール</h3>
            <p className="panel-desc">WAVファイルの音程を解析し、ピアノロールにノートとして自動配置します。</p>
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

// ---- トラック選択セレクタ（共通部品）----
function TrackSelector({ value, onChange, includeNew }) {
    const { trackVersion } = useDaw();
    return (
        <select value={value} onChange={e => onChange(e.target.value)}>
            {includeNew && <option value="__new__">新規作成（Drum）</option>}
            {engine.tracks.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
            ))}
        </select>
    );
}

// ---- メインの LeftPanel ----
const TABS = [
    { key: 'synth', label: 'シンセ' },
    { key: 'drum', label: 'ドラム' },
    { key: 'fx', label: 'FX' },
    { key: 'file', label: 'ファイル' },
];

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
        </div>
    );
}
