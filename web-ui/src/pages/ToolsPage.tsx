/**
 * bunri DAW — ツールページ（音源分離・編集・エフェクト・変換等）
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';

interface AudioResult {
    label: string;
    url: string;
}

interface FxToolParam {
    id: string;
    label: string;
    def: number;
    min?: number;
    max?: number;
    step?: number;
}

// ---- ユーティリティ ----
function makeAudioResult(label: string, url: string): AudioResult {
    return { label, url };
}

// ---- スタイル（tools.html 内蔵CSSを移植）----
const TOOLS_CSS = `
.tools-page { font-family: 'Outfit','Noto Sans JP',sans-serif; background: #111116; color: #e8e4de; line-height: 1.6; min-height: 100vh; }
.tools-page .container { max-width:900px; margin:0 auto; padding:24px; }
.tools-page .page-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; padding-bottom:16px; border-bottom:2px solid #2a2a35; }
.tools-page .page-header h1 { font-size:22px; color:#d4a44c; }
.tools-page .nav-links { display:flex; gap:8px; }
.tools-page .nav-links a { background:#1c1c25; border:1px solid #2a2a35; color:#e8e4de; padding:6px 16px; border-radius:6px; font-size:13px; text-decoration:none; cursor:pointer; }
.tools-page .nav-links a:hover { background:#d4a44c; color:#fff; }
.tools-page .tool-tabs { display:flex; gap:4px; margin-bottom:24px; flex-wrap:wrap; }
.tools-page .tool-tabs button { background:#1c1c25; border:1px solid #2a2a35; color:#9e9a92; padding:10px 20px; border-radius:6px 6px 0 0; font-size:13px; cursor:pointer; font-weight:600; }
.tools-page .tool-tabs button:hover { color:#e8e4de; }
.tools-page .tool-tabs button.active { background:#17171e; color:#d4a44c; border-bottom-color:#17171e; }
.tools-page .tool-panel { display:none; background:#17171e; border:1px solid #2a2a35; border-radius:0 8px 8px 8px; padding:24px; }
.tools-page .tool-panel.active { display:block; }
.tools-page .tool-panel h2 { font-size:18px; color:#d4a44c; margin-bottom:8px; }
.tools-page .desc { font-size:13px; color:#9e9a92; margin-bottom:20px; line-height:1.7; }
.tools-page .form-group { margin-bottom:16px; }
.tools-page .form-group label { display:block; font-size:12px; color:#9e9a92; margin-bottom:4px; font-weight:600; }
.tools-page .form-group input, .tools-page .form-group select { width:100%; background:#1c1c25; border:1px solid #2a2a35; color:#e8e4de; padding:8px 10px; border-radius:4px; font-size:13px; }
.tools-page .form-row { display:flex; gap:12px; }
.tools-page .form-row .form-group { flex:1; }
.tools-page .btn { background:#d4a44c; color:#fff; border:none; padding:10px 24px; border-radius:6px; font-size:14px; cursor:pointer; font-weight:600; width:100%; }
.tools-page .btn:hover { background:#e8bc6a; }
.tools-page .btn:disabled { opacity:0.5; cursor:not-allowed; }
.tools-page .result-area { margin-top:20px; padding:16px; border-radius:6px; background:#1c1c25; border:1px solid #2a2a35; }
.tools-page .result-area h3 { font-size:14px; color:#d4a44c; margin-bottom:8px; }
.tools-page .result-area audio { width:100%; margin:8px 0; }
.tools-page .result-area a { color:#e8bc6a; text-decoration:none; font-size:13px; }
.tools-page .result-item { margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid #2a2a35; }
.tools-page .result-item:last-child { border-bottom:none; }
.tools-page .result-label { font-size:12px; color:#9e9a92; font-weight:600; margin-bottom:4px; }
.tools-page .status { margin-top:12px; font-size:13px; color:#9e9a92; min-height:20px; }
.tools-page .status.error { color:#e74c3c; }
.tools-page .status.processing { color:#d4a44c; }
.tools-page .progress-bar { height:4px; background:#1c1c25; border-radius:2px; margin-top:8px; overflow:hidden; }
.tools-page .progress-bar .fill { height:100%; background:#d4a44c; border-radius:2px; animation: tools-indeterminate 1.5s infinite ease-in-out; width:30%; }
@keyframes tools-indeterminate { 0% { transform:translateX(-100%); } 100% { transform:translateX(400%); } }
.tools-page .hint { font-size:12px; color:#9e9a92; background:rgba(15,150,228,0.08); border:1px solid rgba(15,150,228,0.15); border-radius:4px; padding:8px 12px; margin:12px 0; line-height:1.6; }
`;

// ---- FXパラメータ定義 ----
const FX_TOOL_PARAMS: Record<string, FxToolParam[]> = {
    eq: [{ id: 'low', label: 'Low (dB)', def: 0, min: -12, max: 12 }, { id: 'mid', label: 'Mid (dB)', def: 0, min: -12, max: 12 }, { id: 'high', label: 'High (dB)', def: 0, min: -12, max: 12 }],
    compressor: [{ id: 'threshold', label: 'Threshold (dB)', def: -20, min: -40, max: 0 }, { id: 'ratio', label: 'Ratio', def: 4, min: 1, max: 20, step: 0.5 }],
    reverb: [{ id: 'room_size', label: 'Room Size (0-1)', def: 0.5, min: 0, max: 1, step: 0.05 }, { id: 'wet', label: 'Wet (0-1)', def: 0.3, min: 0, max: 1, step: 0.05 }],
    delay: [{ id: 'delay_ms', label: 'Time (ms)', def: 300, min: 50, max: 2000 }, { id: 'feedback', label: 'Feedback', def: 0.4, min: 0, max: 0.9, step: 0.05 }, { id: 'wet', label: 'Wet', def: 0.3, min: 0, max: 1, step: 0.05 }],
    normalize: [], volume: [{ id: 'db', label: '音量変更 (dB)', def: 0, min: -20, max: 20 }],
    fade_in: [{ id: 'duration', label: 'フェード時間（秒）', def: 3, min: 0.1, step: 0.1 }],
    fade_out: [{ id: 'duration', label: 'フェード時間（秒）', def: 3, min: 0.1, step: 0.1 }],
    pan: [{ id: 'pan', label: 'パン（-1=左、1=右）', def: 0, min: -1, max: 1, step: 0.1 }],
    reverse: [], pitch_shift: [{ id: 'semitones', label: '半音数', def: 0, min: -12, max: 12 }],
    time_stretch: [{ id: 'rate', label: '倍率', def: 1, min: 0.25, max: 3, step: 0.05 }],
    speed: [{ id: 'speed', label: '速度倍率', def: 1, min: 0.25, max: 4, step: 0.05 }],
};

const EDIT_HINTS: Record<string, string> = {
    trim: '<strong>トリム：</strong>開始〜終了の範囲だけを残し、それ以外を削除します。',
    cut: '<strong>カット：</strong>開始〜終了の範囲を削除し、前後を繋げます。',
    copy_range: '<strong>範囲コピー：</strong>開始〜終了の範囲をコピーし、指定した位置に挿入します。',
    silence: '<strong>無音挿入：</strong>「開始位置」に指定した秒数の無音を挿入します。',
    loop: '<strong>ループ：</strong>開始〜終了の範囲を指定回数繰り返します。',
};

const TABS = [
    { key: 'decompose', label: '完全分解' },
    { key: 'separate', label: '音源分離' }, { key: 'analyze', label: '解析' },
    { key: 'edit', label: '編集' }, { key: 'effects', label: 'エフェクト' },
    { key: 'batch', label: '一括編集' }, { key: 'overlay', label: '音源合成' },
    { key: 'convert', label: '変換' }, { key: 'wav_optimize', label: 'WAV最適化' },
];

// ---- 音源分離パネル ----
function SeparatePanel() {
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [progress, setProgress] = useState(false);
    const [results, setResults] = useState<AudioResult[]>([]);
    const [disabled, setDisabled] = useState(false);

    const handleSeparate = useCallback(async () => {
        const file = ((document.getElementById('sep-file') as HTMLInputElement | null))?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }
        const model = ((document.getElementById('sep-model') as HTMLInputElement)?.value);
        const mode = ((document.getElementById('sep-mode') as HTMLInputElement)?.value);
        const isDeep = mode === 'deep';
        let apiUrl; const fd = new FormData();
        if (isDeep) { fd.append('file', file); fd.append('depth', '1'); apiUrl = '/api/deep-separate'; }
        else { fd.append('file', file); fd.append('model', model); fd.append('two_stems', mode); apiUrl = '/api/separate'; }
        setStatus(`分離中...（${file.name}）`); setStatusType('processing'); setProgress(true); setResults([]); setDisabled(true);
        try {
            const resp = await fetch(apiUrl, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const result = await resp.json();
            const items = Object.entries(result).map(([key, info]) => {
                const v = info as { label?: string; url: string };
                return makeAudioResult(v.label || key, v.url);
            });
            setResults(items); setStatus(`分離完了！${items.length}個のレイヤーに分割されました`); setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
        finally { setProgress(false); setDisabled(false); }
    }, []);

    return (
        <div className={`tool-panel active`}>
            <h2>音源分離（Demucs）</h2>
            <p className="desc">AI（Meta Demucs）が音楽ファイルを楽器パートごとに自動分離します。<br /><strong>CPU処理のため、1曲あたり数分〜十数分かかります。</strong></p>
            <div className="form-group"><label>音声ファイル</label><input type="file" id="sep-file" accept=".wav,.mp3,.flac,.ogg,.m4a" /></div>
            <div className="form-row">
                <div className="form-group"><label>モデル</label>
                    <select id="sep-model"><option value="htdemucs">htdemucs — 標準（推奨）</option><option value="htdemucs_ft">htdemucs_ft — 高精度（遅い）</option><option value="htdemucs_6s">htdemucs_6s — 6ステム</option></select>
                </div>
                <div className="form-group"><label>分離モード</label>
                    <select id="sep-mode"><option value="true">2分割（ボーカル/伴奏）</option><option value="false">フル分割</option><option value="deep">深層分離</option></select>
                </div>
            </div>
            <button className="btn" onClick={handleSeparate} disabled={disabled}>音源分離を開始</button>
            {progress && <div className="progress-bar"><div className="fill" /></div>}
            {status && <div className={`status ${statusType}`}>{status}</div>}
            {results.length > 0 && (
                <div className="result-area">
                    <h3>分離結果</h3>
                    {results.map((r, i) => <div key={i} className="result-item"><div className="result-label">{r.label}</div><audio controls src={r.url} /><a href={r.url} download>ダウンロード</a></div>)}
                </div>
            )}
        </div>
    );
}

// ---- 解析パネル ----
function AnalyzePanel() {
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [progress, setProgress] = useState(false);
    const [report, setReport] = useState('');

    const handleAnalyze = useCallback(async () => {
        const file = ((document.getElementById('da-file') as HTMLInputElement | null))?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }
        const fd = new FormData(); fd.append('file', file);
        setStatus(`解析中...（${file.name}）`); setStatusType('processing'); setProgress(true); setReport('');
        try {
            const resp = await fetch('/api/deep-analyze', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            let html = data.report.replace(/^## (.+)$/gm, '<h3 style="color:#d4a44c;margin-top:16px">$1</h3>')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/^- (.+)$/gm, '<div style="padding-left:12px">・ $1</div>');
            setReport(html); setStatus('解析完了'); setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
        finally { setProgress(false); }
    }, []);

    return (
        <div className="tool-panel active">
            <h2>音声解析</h2>
            <p className="desc">音声ファイルの周波数帯域分布・推定楽器構成・テンポなどを解析します。</p>
            <div className="form-group"><label>音声ファイル</label><input type="file" id="da-file" accept=".wav,.mp3,.flac,.ogg,.m4a" /></div>
            <button className="btn" onClick={handleAnalyze}>解析開始</button>
            {progress && <div className="progress-bar"><div className="fill" /></div>}
            {status && <div className={`status ${statusType}`}>{status}</div>}
            {report && <div className="result-area"><h3>解析結果</h3><div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8 }} dangerouslySetInnerHTML={{ __html: report }} /></div>}
        </div>
    );
}

// ---- 編集パネル ----
function EditPanel() {
    const [action, setAction] = useState('trim');
    const [start, setStart] = useState(0);
    const [end, setEnd] = useState(10);
    const [extra, setExtra] = useState(0);
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [results, setResults] = useState<AudioResult[]>([]);

    const showExtra = ['copy_range', 'silence', 'loop'].includes(action);
    const extraLabel = action === 'copy_range' ? '挿入位置（秒）' : action === 'silence' ? '無音の長さ（秒）' : 'ループ回数';

    const handleEdit = useCallback(async () => {
        const file = ((document.getElementById('edit-file') as HTMLInputElement | null))?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }
        let params = {};
        if (action === 'trim' || action === 'cut') params = { start, end };
        else if (action === 'copy_range') params = { start, end, insert_at: extra };
        else if (action === 'silence') params = { position: start, length: extra };
        else if (action === 'loop') params = { start, end, count: Math.floor(extra) };
        const fd = new FormData(); fd.append('file', file); fd.append('params', JSON.stringify(params));
        setStatus('処理中...'); setStatusType('processing');
        try {
            const resp = await fetch(`/api/edit/${action}`, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const blob = await resp.blob(); const url = URL.createObjectURL(blob);
            setResults([makeAudioResult('編集結果', url)]); setStatus('完了'); setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
    }, [action, start, end, extra]);

    return (
        <div className="tool-panel active">
            <h2>音声編集</h2>
            <p className="desc">WAVファイルに対してトリム・カット・コピー・無音挿入・ループなどを行います。</p>
            <div className="form-group"><label>WAVファイル</label><input type="file" id="edit-file" accept=".wav" /></div>
            <div className="form-group"><label>編集操作</label>
                <select value={action} onChange={e => setAction(e.target.value)}>
                    <option value="trim">トリム</option><option value="cut">カット</option>
                    <option value="copy_range">範囲コピー</option><option value="silence">無音挿入</option><option value="loop">ループ</option>
                </select>
            </div>
            {action !== 'silence' && (
                <div className="form-row">
                    <div className="form-group"><label>開始位置（秒）</label><input type="number" value={start} min="0" step="0.1" onChange={e => setStart(+e.target.value)} /></div>
                    <div className="form-group"><label>終了位置（秒）</label><input type="number" value={end} min="0" step="0.1" onChange={e => setEnd(+e.target.value)} /></div>
                </div>
            )}
            {action === 'silence' && (
                <div className="form-group"><label>開始位置（秒）</label><input type="number" value={start} min="0" step="0.1" onChange={e => setStart(+e.target.value)} /></div>
            )}
            {showExtra && <div className="form-group"><label>{extraLabel}</label><input type="number" value={extra} step="0.1" onChange={e => setExtra(+e.target.value)} /></div>}
            <div className="hint" dangerouslySetInnerHTML={{ __html: EDIT_HINTS[action] || '' }} />
            <button className="btn" onClick={handleEdit}>編集を実行</button>
            {status && <div className={`status ${statusType}`}>{status}</div>}
            {results.length > 0 && <div className="result-area"><h3>編集結果</h3>{results.map((r, i) => <div key={i} className="result-item"><div className="result-label">{r.label}</div><audio controls src={r.url} /><a href={r.url} download>ダウンロード</a></div>)}</div>}
        </div>
    );
}

// ---- エフェクトパネル ----
function EffectsPanel() {
    const [fxType, setFxType] = useState('eq');
    const [params, setParams] = useState<Record<string, number>>({});
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [results, setResults] = useState<AudioResult[]>([]);

    useEffect(() => {
        const defs: Record<string, number> = {};
        (FX_TOOL_PARAMS[fxType] || []).forEach(p => { defs[p.id] = p.def; });
        setParams(defs);
    }, [fxType]);

    const handleApply = useCallback(async () => {
        const file = ((document.getElementById('fx-file') as HTMLInputElement | null))?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }
        const fd = new FormData(); fd.append('file', file); fd.append('params', JSON.stringify(params));
        setStatus('処理中...'); setStatusType('processing');
        try {
            const resp = await fetch(`/api/effects/${fxType}`, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const blob = await resp.blob(); const url = URL.createObjectURL(blob);
            setResults([makeAudioResult(`${fxType} 適用結果`, url)]); setStatus('完了'); setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
    }, [fxType, params]);

    return (
        <div className="tool-panel active">
            <h2>エフェクト</h2>
            <p className="desc">WAVファイルにエフェクトをかけて新しいファイルとしてダウンロードします。</p>
            <div className="form-group"><label>WAVファイル</label><input type="file" id="fx-file" accept=".wav" /></div>
            <div className="form-group"><label>エフェクト</label>
                <select value={fxType} onChange={e => setFxType(e.target.value)}>
                    <option value="eq">EQ（3バンド）</option><option value="compressor">コンプレッサー</option>
                    <option value="reverb">リバーブ</option><option value="delay">ディレイ</option>
                    <option value="normalize">ノーマライズ</option><option value="volume">音量変更</option>
                    <option value="fade_in">フェードイン</option><option value="fade_out">フェードアウト</option>
                    <option value="pan">パン</option><option value="reverse">リバース</option>
                    <option value="pitch_shift">ピッチシフト</option><option value="time_stretch">タイムストレッチ</option>
                    <option value="speed">速度変更</option>
                </select>
            </div>
            <div className="form-row" style={{ flexWrap: 'wrap' }}>
                {(FX_TOOL_PARAMS[fxType] || []).map(p => (
                    <div className="form-group" key={p.id}><label>{p.label}</label>
                        <input type="number" value={params[p.id] ?? p.def} min={p.min} max={p.max} step={p.step || 1}
                            onChange={e => setParams(prev => ({ ...prev, [p.id]: +e.target.value }))} />
                    </div>
                ))}
            </div>
            <button className="btn" onClick={handleApply}>エフェクト適用</button>
            {status && <div className={`status ${statusType}`}>{status}</div>}
            {results.length > 0 && <div className="result-area"><h3>処理結果</h3>{results.map((r, i) => <div key={i} className="result-item"><div className="result-label">{r.label}</div><audio controls src={r.url} /><a href={r.url} download>ダウンロード</a></div>)}</div>}
        </div>
    );
}

// ---- 一括編集パネル ----
function BatchPanel() {
    const [category, setCategory] = useState('edit');
    const [action, setAction] = useState('normalize');
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [progress, setProgress] = useState(false);
    const [results, setResults] = useState<AudioResult[]>([]);
    const [fileCount, setFileCount] = useState(0);

    const editActions = ['normalize', 'volume', 'fade_in', 'fade_out', 'reverse', 'speed', 'trim', 'cut', 'loop', 'silence'];
    const effectActions = ['normalize', 'eq', 'compressor', 'reverb', 'delay', 'volume', 'fade_in', 'fade_out', 'pan', 'reverse', 'pitch_shift', 'time_stretch', 'speed'];
    const actions = category === 'edit' ? editActions : effectActions;

    useEffect(() => { setAction(actions[0]); }, [category]);

    const handleBatch = useCallback(async () => {
        const files = ((document.getElementById('batch-files') as HTMLInputElement | null))?.files;
        if (!files?.length) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }
        const fd = new FormData();
        for (const f of files) fd.append('files', f);
        fd.append('params', JSON.stringify({}));
        let apiUrl;
        if (category === 'edit') { fd.append('action', action); apiUrl = '/api/batch/edit'; }
        else { fd.append('effect_name', action); apiUrl = '/api/batch/effects'; }
        setStatus(`${files.length}個のファイルに「${action}」を適用中...`); setStatusType('processing'); setProgress(true); setResults([]);
        try {
            const resp = await fetch(apiUrl, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            const items = (data as Array<{status: string; url?: string; filename: string}>).filter(r => r.status === 'ok' && r.url).map(r => makeAudioResult(r.filename, r.url!));
            setResults(items); setStatus(`完了: ${items.length}個成功`); setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
        finally { setProgress(false); }
    }, [category, action]);

    return (
        <div className="tool-panel active">
            <h2>一括編集</h2>
            <p className="desc">複数の音声ファイルに同じ操作を一括適用します。</p>
            <div className="form-group"><label>音声ファイル（複数選択可）</label><input type="file" id="batch-files" accept=".wav,.mp3,.flac,.ogg,.m4a" multiple onChange={e => setFileCount(e.target.files?.length ?? 0)} /></div>
            {fileCount > 0 && <div style={{ fontSize: 12, color: '#9e9a92', marginBottom: 12 }}>{fileCount}個のファイルを選択</div>}
            <div className="form-row">
                <div className="form-group"><label>カテゴリ</label><select value={category} onChange={e => setCategory(e.target.value)}><option value="edit">編集</option><option value="effects">エフェクト</option></select></div>
                <div className="form-group"><label>操作</label><select value={action} onChange={e => setAction(e.target.value)}>{actions.map(a => <option key={a} value={a}>{a}</option>)}</select></div>
            </div>
            <button className="btn" onClick={handleBatch}>一括実行</button>
            {progress && <div className="progress-bar"><div className="fill" /></div>}
            {status && <div className={`status ${statusType}`}>{status}</div>}
            {results.length > 0 && <div className="result-area"><h3>処理結果</h3>{results.map((r, i) => <div key={i} className="result-item"><div className="result-label">{r.label}</div><audio controls src={r.url} /><a href={r.url} download>ダウンロード</a></div>)}</div>}
        </div>
    );
}

// ---- 音源合成パネル ----
function OverlayPanel() {
    const [offset, setOffset] = useState(0);
    const [baseVol, setBaseVol] = useState(0);
    const [overVol, setOverVol] = useState(0);
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [results, setResults] = useState<AudioResult[]>([]);

    const handleOverlay = useCallback(async () => {
        const baseFile = ((document.getElementById('ovl-base') as HTMLInputElement | null))?.files?.[0];
        const overFile = ((document.getElementById('ovl-over') as HTMLInputElement | null))?.files?.[0];
        if (!baseFile || !overFile) { setStatus('2つのファイルを選択してください'); setStatusType('error'); return; }
        const fd = new FormData();
        fd.append('base_file', baseFile); fd.append('overlay_file', overFile);
        fd.append('offset_sec', String(offset)); fd.append('base_vol_db', String(baseVol)); fd.append('overlay_vol_db', String(overVol));
        setStatus('合成中...'); setStatusType('processing');
        try {
            const resp = await fetch('/api/overlay', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const blob = await resp.blob(); const url = URL.createObjectURL(blob);
            setResults([makeAudioResult('合成結果', url)]); setStatus('完了'); setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
    }, [offset, baseVol, overVol]);

    return (
        <div className="tool-panel active">
            <h2>音源合成（オーバーレイ）</h2>
            <p className="desc">2つのWAVファイルを重ねて1つのファイルにミックスします。</p>
            <div className="form-group"><label>ベース音源</label><input type="file" id="ovl-base" accept=".wav" /></div>
            <div className="form-group"><label>オーバーレイ音源</label><input type="file" id="ovl-over" accept=".wav" /></div>
            <div className="form-row">
                <div className="form-group"><label>開始位置（秒）</label><input type="number" value={offset} min="0" step="0.1" onChange={e => setOffset(+e.target.value)} /></div>
            </div>
            <div className="form-row">
                <div className="form-group"><label>ベース音量 (dB)</label><input type="number" value={baseVol} min="-20" max="20" onChange={e => setBaseVol(+e.target.value)} /></div>
                <div className="form-group"><label>オーバーレイ音量 (dB)</label><input type="number" value={overVol} min="-20" max="20" onChange={e => setOverVol(+e.target.value)} /></div>
            </div>
            <button className="btn" onClick={handleOverlay}>合成を実行</button>
            {status && <div className={`status ${statusType}`}>{status}</div>}
            {results.length > 0 && <div className="result-area"><h3>合成結果</h3>{results.map((r, i) => <div key={i} className="result-item"><div className="result-label">{r.label}</div><audio controls src={r.url} /><a href={r.url} download>ダウンロード</a></div>)}</div>}
        </div>
    );
}

// ---- 変換パネル ----
function ConvertPanel() {
    const [target, setTarget] = useState('wav');
    const [bitrate, setBitrate] = useState('192');
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [results, setResults] = useState<AudioResult[]>([]);

    const handleConvert = useCallback(async () => {
        const file = ((document.getElementById('conv-file') as HTMLInputElement | null))?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }
        const fd = new FormData(); fd.append('file', file); fd.append('bitrate', bitrate);
        setStatus('変換中...'); setStatusType('processing');
        try {
            const resp = await fetch(`/api/convert/${target}`, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const blob = await resp.blob(); const url = URL.createObjectURL(blob);
            setResults([makeAudioResult(`${target.toUpperCase()} 変換結果`, url)]); setStatus('完了'); setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
    }, [target, bitrate]);

    return (
        <div className="tool-panel active">
            <h2>フォーマット変換</h2>
            <p className="desc">動画ファイル（MP4等）や音声ファイルからWAVまたはMP3に変換します。</p>
            <div className="form-group"><label>変換元ファイル</label><input type="file" id="conv-file" accept=".mp4,.avi,.mkv,.webm,.mov,.flv,.m4a,.aac,.ogg,.flac" /></div>
            <div className="form-row">
                <div className="form-group"><label>出力フォーマット</label>
                    <select value={target} onChange={e => setTarget(e.target.value)}><option value="wav">WAV</option><option value="mp3">MP3</option></select>
                </div>
                {target === 'mp3' && (
                    <div className="form-group"><label>ビットレート</label>
                        <select value={bitrate} onChange={e => setBitrate(e.target.value)}>
                            <option value="128">128 kbps</option><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps</option>
                        </select>
                    </div>
                )}
            </div>
            <button className="btn" onClick={handleConvert}>変換を実行</button>
            {status && <div className={`status ${statusType}`}>{status}</div>}
            {results.length > 0 && <div className="result-area"><h3>変換結果</h3>{results.map((r, i) => <div key={i} className="result-item"><div className="result-label">{r.label}</div><audio controls src={r.url} /><a href={r.url} download>ダウンロード</a></div>)}</div>}
        </div>
    );
}

// ---- メインのツールページ ----
// ---- 完全分解パネル ----
interface StemResult {
    audio_url?: string;
    notes?: Array<{ note: string; octave: number; step: number; length: number; velocity: number }>;
    drum_events?: Array<{ type: string; step: number; velocity: number }>;
    gm_program: number | null;
    mix: { volume_db: number; pan: number; reverb_wet: number };
}

interface DecomposeResult {
    bpm: number;
    stems: Record<string, StemResult>;
}

const STEM_LABELS: Record<string, string> = {
    vocals: 'ボーカル', drums: 'ドラム', bass: 'ベース',
    guitar: 'ギター', piano: 'ピアノ', other: 'その他',
};

function DecomposePanel() {
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [progress, setProgress] = useState(false);
    const [bpm, setBpm] = useState(0);
    const [sensitivity, setSensitivity] = useState(0.5);
    const [result, setResult] = useState<DecomposeResult | null>(null);
    const [disabled, setDisabled] = useState(false);

    const handleDecompose = useCallback(async () => {
        const file = (document.getElementById('decompose-file') as HTMLInputElement | null)?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }

        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', String(bpm));
        fd.append('sensitivity', String(sensitivity));

        setStatus(`分解中...（${file.name}）Demucs分離 → ピッチ解析 → 楽器推定。CPU処理のため数分かかります。`);
        setStatusType('processing'); setProgress(true); setResult(null); setDisabled(true);

        try {
            const resp = await fetch('/api/decompose', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const data: DecomposeResult = await resp.json();
            setResult(data);
            const stemCount = Object.keys(data.stems).length;
            const totalNotes = Object.values(data.stems).reduce((sum, s) =>
                sum + (s.notes?.length || 0) + (s.drum_events?.length || 0), 0);
            setStatus(`分解完了！BPM: ${data.bpm} / ${stemCount}ステム / ${totalNotes}ノート検出`);
            setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
        finally { setProgress(false); setDisabled(false); }
    }, [bpm, sensitivity]);

    return (
        <div className="tool-panel active">
            <h2>完全分解（Decompose）</h2>
            <p className="desc">
                音源を楽器パートに分離し、各パートの音符を自動書き起こしします。<br />
                <strong>Demucs分離 → ポリフォニックピッチ検出 → ドラムパターン解析 → 楽器推定</strong>を一括実行。<br />
                結果はDAWのトラック+ピアノロールにそのまま読み込めるJSON形式です。
            </p>
            <div className="form-group">
                <label>音声ファイル（WAV / MP3 / FLAC）</label>
                <input type="file" id="decompose-file" accept=".wav,.mp3,.flac,.ogg,.m4a" />
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>BPM（0 = 自動検出）</label>
                    <input type="number" value={bpm} min="0" max="300"
                        onChange={e => setBpm(+e.target.value)} />
                </div>
                <div className="form-group">
                    <label>検出感度（{sensitivity}）</label>
                    <input type="range" min="0.1" max="1" step="0.05" value={sensitivity}
                        onChange={e => setSensitivity(+e.target.value)}
                        style={{ width: '100%', background: '#1c1c25' }} />
                </div>
            </div>
            <div className="hint">
                <strong>完全再現のワークフロー:</strong><br />
                1. ここでBGMを分解 → 各パートのノートデータを取得<br />
                2. DAWで「読込」→ 各トラックにノートが配置される<br />
                3. GM楽器を選び「シーケンスをレンダリング」で音声化<br />
                4. 原曲と聴き比べながら手動で微調整
            </div>
            <button className="btn" onClick={handleDecompose} disabled={disabled}>
                完全分解を開始
            </button>
            {progress && <div className="progress-bar"><div className="fill" /></div>}
            {status && <div className={`status ${statusType}`}>{status}</div>}

            {result && (
                <div className="result-area" style={{ display: 'block' }}>
                    <h3>分解結果（BPM: {result.bpm}）</h3>
                    {Object.entries(result.stems).map(([name, stem]) => (
                        <div key={name} className="result-item" style={{ paddingBottom: 16, marginBottom: 16 }}>
                            <div className="result-label" style={{ fontSize: 14, marginBottom: 8 }}>
                                {STEM_LABELS[name] || name}
                                {stem.gm_program != null && <span style={{ marginLeft: 8, color: '#9e9a92' }}>GM#{stem.gm_program}</span>}
                            </div>

                            {stem.audio_url && <audio controls src={stem.audio_url} style={{ width: '100%', marginBottom: 8 }} />}

                            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#9e9a92', marginBottom: 8 }}>
                                <span>音量: {stem.mix.volume_db}dB</span>
                                <span>パン: {stem.mix.pan}</span>
                                <span>残響: {(stem.mix.reverb_wet * 100).toFixed(0)}%</span>
                            </div>

                            {stem.notes && stem.notes.length > 0 && (
                                <div style={{ fontSize: 12, color: '#d4a44c' }}>
                                    {stem.notes.length}ノート検出
                                    <span style={{ color: '#9e9a92', marginLeft: 8 }}>
                                        ({stem.notes.slice(0, 5).map(n => `${n.note}${n.octave}`).join(' ')}...)
                                    </span>
                                </div>
                            )}

                            {stem.drum_events && stem.drum_events.length > 0 && (
                                <div style={{ fontSize: 12, color: '#4ecdc4' }}>
                                    {stem.drum_events.length}ドラムヒット検出
                                    <span style={{ color: '#9e9a92', marginLeft: 8 }}>
                                        (kick: {stem.drum_events.filter(e => e.type === 'kick').length}
                                        / snare: {stem.drum_events.filter(e => e.type === 'snare').length}
                                        / hihat: {stem.drum_events.filter(e => e.type === 'hihat').length})
                                    </span>
                                </div>
                            )}

                            {stem.audio_url && <a href={stem.audio_url} download style={{ fontSize: 12 }}>WAVダウンロード</a>}
                        </div>
                    ))}

                    <div style={{ marginTop: 16, padding: 12, background: '#1c1c25', borderRadius: 6 }}>
                        <div style={{ fontSize: 13, color: '#d4a44c', marginBottom: 8 }}>DAW用JSONデータ</div>
                        <textarea
                            readOnly
                            value={JSON.stringify(result, null, 2)}
                            style={{ width: '100%', height: 120, background: '#111116', color: '#e8e4de', border: '1px solid #2a2a35', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', resize: 'vertical', padding: 8 }}
                        />
                        <button className="btn" style={{ marginTop: 8 }}
                            onClick={() => {
                                const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url; a.download = 'decompose_result.json';
                                a.click(); URL.revokeObjectURL(url);
                            }}>
                            JSONをダウンロード
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ---- WAV最適化パネル ----
interface WavInfo {
    sample_rate: number;
    channels: number;
    bit_depth: string;
    duration_sec: number;
    file_size_mb: number;
}

interface OptimizeResult {
    original: WavInfo;
    optimized: WavInfo;
    reduction_pct: number;
    download_url: string;
}

function WavOptimizePanel() {
    const [targetSr, setTargetSr] = useState(44100);
    const [targetBit, setTargetBit] = useState(16);
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [progress, setProgress] = useState(false);
    const [result, setResult] = useState<OptimizeResult | null>(null);
    const [info, setInfo] = useState<WavInfo | null>(null);

    const handleInfo = useCallback(async () => {
        const file = (document.getElementById('opt-file') as HTMLInputElement | null)?.files?.[0];
        if (!file) return;
        const fd = new FormData(); fd.append('file', file);
        try {
            const resp = await fetch('/api/wav/info', { method: 'POST', body: fd });
            if (resp.ok) setInfo(await resp.json());
        } catch (_e) { /* ignore */ }
    }, []);

    const handleOptimize = useCallback(async () => {
        const file = (document.getElementById('opt-file') as HTMLInputElement | null)?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }

        const fd = new FormData();
        fd.append('file', file);
        fd.append('target_sr', String(targetSr));
        fd.append('target_bit_depth', String(targetBit));

        setStatus('最適化中...'); setStatusType('processing'); setProgress(true); setResult(null);
        try {
            const resp = await fetch('/api/wav/optimize', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const data: OptimizeResult = await resp.json();
            setResult(data);
            setStatus(`完了！容量 ${data.reduction_pct}% 削減（${data.original.file_size_mb}MB → ${data.optimized.file_size_mb}MB）`);
            setStatusType('');
        } catch (e: unknown) { setStatus('エラー: ' + (e as Error).message); setStatusType('error'); }
        finally { setProgress(false); }
    }, [targetSr, targetBit]);

    return (
        <div className="tool-panel active">
            <h2>WAV最適化（容量削減）</h2>
            <p className="desc">
                動画から生成した大容量WAVを、音質を維持したまま一般的なサイズに圧縮します。<br />
                <strong>サンプルレート変換</strong>（48kHz→44.1kHz）+ <strong>ビット深度変換</strong>（32bit→16bit）+
                <strong>TPDFディザリング</strong>で量子化ノイズを最小化。
            </p>
            <div className="form-group">
                <label>WAVファイル</label>
                <input type="file" id="opt-file" accept=".wav" onChange={handleInfo} />
            </div>

            {info && (
                <div style={{ fontSize: 12, color: '#9e9a92', padding: '8px 12px', background: '#1c1c25', borderRadius: 4, marginBottom: 12 }}>
                    現在: <strong style={{ color: '#e8e4de' }}>{info.sample_rate}Hz / {info.bit_depth} / {info.channels}ch</strong>
                    {' '}— {info.duration_sec}秒 / {info.file_size_mb}MB
                </div>
            )}

            <div className="form-row">
                <div className="form-group">
                    <label>目標サンプルレート</label>
                    <select value={targetSr} onChange={e => setTargetSr(+e.target.value)}>
                        <option value="44100">44100 Hz（CD品質・推奨）</option>
                        <option value="48000">48000 Hz（動画標準）</option>
                        <option value="22050">22050 Hz（軽量）</option>
                    </select>
                </div>
                <div className="form-group">
                    <label>目標ビット深度</label>
                    <select value={targetBit} onChange={e => setTargetBit(+e.target.value)}>
                        <option value="16">16bit（CD品質・推奨）</option>
                        <option value="24">24bit（高品質）</option>
                    </select>
                </div>
            </div>

            <div className="hint">
                <strong>44.1kHz / 16bit</strong> が一般的なCDやストリーミングの品質です。<br />
                人間の可聴域（〜20kHz）を完全にカバーし、聴感上の差はほぼありません。<br />
                動画由来の 48kHz/32bit WAV → 44.1kHz/16bit で <strong>容量が約1/3〜1/4</strong> になります。
            </div>

            <button className="btn" onClick={handleOptimize}>最適化を実行</button>
            {progress && <div className="progress-bar"><div className="fill" /></div>}
            {status && <div className={`status ${statusType}`}>{status}</div>}

            {result && (
                <div className="result-area" style={{ display: 'block' }}>
                    <h3>最適化結果</h3>
                    <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                        <thead><tr style={{ color: '#9e9a92', textAlign: 'left' }}>
                            <th style={{ padding: '4px 8px' }}></th><th style={{ padding: '4px 8px' }}>元</th><th style={{ padding: '4px 8px' }}>最適化後</th>
                        </tr></thead>
                        <tbody>
                            <tr><td style={{ padding: '4px 8px', color: '#9e9a92' }}>サンプルレート</td>
                                <td style={{ padding: '4px 8px' }}>{result.original.sample_rate} Hz</td>
                                <td style={{ padding: '4px 8px', color: '#d4a44c' }}>{result.optimized.sample_rate} Hz</td></tr>
                            <tr><td style={{ padding: '4px 8px', color: '#9e9a92' }}>ビット深度</td>
                                <td style={{ padding: '4px 8px' }}>{result.original.bit_depth}</td>
                                <td style={{ padding: '4px 8px', color: '#d4a44c' }}>{result.optimized.bit_depth}</td></tr>
                            <tr><td style={{ padding: '4px 8px', color: '#9e9a92' }}>ファイルサイズ</td>
                                <td style={{ padding: '4px 8px' }}>{result.original.file_size_mb} MB</td>
                                <td style={{ padding: '4px 8px', color: '#4ecdc4', fontWeight: 'bold' }}>{result.optimized.file_size_mb} MB（{result.reduction_pct}%削減）</td></tr>
                        </tbody>
                    </table>
                    {result.download_url && (
                        <div style={{ marginTop: 12 }}>
                            <audio controls src={result.download_url} style={{ width: '100%', marginBottom: 8 }} />
                            <a href={result.download_url} download style={{ color: '#e8bc6a', fontSize: 13 }}>最適化済みWAVをダウンロード</a>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

const PANELS: Record<string, () => React.ReactElement> = {
    decompose: DecomposePanel,
    separate: SeparatePanel, analyze: AnalyzePanel, edit: EditPanel,
    effects: EffectsPanel, batch: BatchPanel, overlay: OverlayPanel, convert: ConvertPanel,
    wav_optimize: WavOptimizePanel,
};

export default function ToolsPage() {
    const [activeTab, setActiveTab] = useState<string>('decompose');
    const ActivePanel = PANELS[activeTab];

    return (
        <div className="tools-page">
            <style>{TOOLS_CSS}</style>
            <div className="container">
                <div className="page-header">
                    <h1>bunri ツール</h1>
                    <div className="nav-links">
                        <Link to="/">DAWに戻る</Link>
                        <Link to="/help">使い方</Link>
                    </div>
                </div>
                <div className="tool-tabs">
                    {TABS.map(tab => (
                        <button key={tab.key} className={activeTab === tab.key ? 'active' : ''}
                            onClick={() => setActiveTab(tab.key)}>{tab.label}</button>
                    ))}
                </div>
                <ActivePanel />
            </div>
        </div>
    );
}
