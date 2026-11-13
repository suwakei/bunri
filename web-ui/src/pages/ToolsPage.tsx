/**
 * bunri DAW — ツールページ（パート分離・編集・エフェクト・変換等）
 *
 * 文は docs/ui-terms.md の決まりに合わせる。色は styles/global.css のトークンを使う。
 * 時間のかかる処理を始めるボタンは、その処理が走っているあいだ押せなくする（二重に始めないため）。
 * パート分離は時間のかかる処理（ジョブ）として動かし、進み具合のカードをボタンの下に出す。
 * 重い処理は同時に 1 つなので、DAW の画面（別の窓）で動いている処理があれば、ページの上に出して中止できるようにする。
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch, backendUrl, describeError, errorDetail } from '../lib/api';
import { modelDownloadNotice } from '../lib/models';
import { JobCancelledError, jobErrorMessage, jobTracker, slotOf, type Job, type JobSlot } from '../lib/jobs';
import { useJob, useJobs } from '../lib/useJob';
import JobCard from '../components/JobCard';
import { tip } from '../lib/tooltip';

interface AudioResult {
    label: string;
    url: string;
    /** ダウンロードするときのファイル名。API の URL のときは要らない（API が名前を付けて返す） */
    filename?: string;
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
function makeAudioResult(label: string, url: string, filename?: string): AudioResult {
    return { label, url, filename };
}

/** ファイル名から拡張子を除く（結果のファイル名を、元の名前から作るため）。 */
function stem(filename: string): string {
    return filename.replace(/\.[^.]+$/, '');
}

/**
 * 処理結果の 1 件。聴くためのプレーヤーと、ダウンロードのリンク。
 *
 * どちらの URL も `backendUrl` を通す。デスクトップ版では API が別の origin に在り、鍵も要るため
 * （通さないと、リンクが画面側の origin を指してしまい、ダウンロードできない）。
 * 手元で作った blob: の URL には名前が無いので、`filename` で付ける
 * （付けないと、ランダムな文字列がファイル名になる）。
 */
function ResultItem({ result }: { result: AudioResult }) {
    return (
        <div className="result-item">
            <div className="result-label">{result.label}</div>
            <audio controls src={backendUrl(result.url)} />
            <a href={backendUrl(result.url)} download={result.filename || true}>ダウンロード</a>
        </div>
    );
}

/**
 * 処理の状態の表示。失敗（`type` が `error`）は色を変えて、読み上げの対象にする。
 *
 * @param text - 表示する文。空なら何も出さない
 * @param type - `''`（結果）/ `processing`（処理中）/ `error`（失敗）
 */
function StatusLine({ text, type }: { text: string; type: string }) {
    if (!text) return null;
    return <div className={`status ${type}`} role={type === 'error' ? 'alert' : 'status'}>{text}</div>;
}

// ---- スタイル（tools.html 内蔵CSSを移植）----
const TOOLS_CSS = `
html, body { overflow: auto; height: auto; }
.tools-page { font-family: var(--font-ui); background: var(--bg-primary); color: var(--text); line-height: 1.6; min-height: 100vh; }
.tools-page .container { max-width:900px; margin:0 auto; padding:24px; }
.tools-page .page-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; padding-bottom:16px; border-bottom:2px solid var(--border); }
.tools-page .page-header h1 { font-size:22px; color:var(--accent); }
.tools-page .nav-links { display:flex; gap:8px; }
.tools-page .nav-links a { background:var(--bg-panel); border:1px solid var(--border); color:var(--text); padding:6px 16px; border-radius:6px; font-size:13px; text-decoration:none; cursor:pointer; }
.tools-page .nav-links a:hover { background:var(--accent); color:var(--bg-deep); }
.tools-page .tool-tabs { display:flex; gap:4px; margin-bottom:24px; flex-wrap:wrap; }
.tools-page .tool-tabs button { background:var(--bg-panel); border:1px solid var(--border); color:var(--text-mid); padding:10px 20px; border-radius:6px 6px 0 0; font-size:13px; cursor:pointer; font-weight:600; }
.tools-page .tool-tabs button:hover { color:var(--text); }
.tools-page .tool-tabs button.active { background:var(--bg-secondary); color:var(--accent); border-bottom-color:var(--bg-secondary); }
.tools-page .tool-panel { display:none; background:var(--bg-secondary); border:1px solid var(--border); border-radius:0 8px 8px 8px; padding:24px; }
.tools-page .tool-panel.active { display:block; }
.tools-page .tool-panel h2 { font-size:18px; color:var(--accent); margin-bottom:8px; }
.tools-page .desc { font-size:13px; color:var(--text-mid); margin-bottom:20px; line-height:1.7; }
.tools-page .form-group { margin-bottom:16px; }
.tools-page .form-group label { display:block; font-size:12px; color:var(--text-mid); margin-bottom:4px; font-weight:600; }
.tools-page .form-group input, .tools-page .form-group select { width:100%; background:var(--bg-panel); border:1px solid var(--border); color:var(--text); padding:8px 10px; border-radius:4px; font-size:13px; }
.tools-page .form-row { display:flex; gap:12px; }
.tools-page .form-row .form-group { flex:1; }
.tools-page .btn { background:var(--accent); color:var(--bg-deep); border:none; padding:10px 24px; border-radius:6px; font-size:14px; cursor:pointer; font-weight:600; width:100%; }
.tools-page .btn:hover { background:var(--accent-hover); color:var(--bg-deep); }
.tools-page .btn:disabled { opacity:0.5; cursor:not-allowed; }
.tools-page .result-area { margin-top:20px; padding:16px; border-radius:6px; background:var(--bg-panel); border:1px solid var(--border); }
.tools-page .result-area h3 { font-size:14px; color:var(--accent); margin-bottom:8px; }
.tools-page .result-area audio { width:100%; margin:8px 0; }
.tools-page .result-area a { color:var(--accent-hover); text-decoration:none; font-size:13px; }
.tools-page .result-item { margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--border); }
.tools-page .result-item:last-child { border-bottom:none; }
.tools-page .result-label { font-size:12px; color:var(--text-mid); font-weight:600; margin-bottom:4px; }
.tools-page .status { margin-top:12px; font-size:13px; color:var(--text-mid); min-height:20px; }
.tools-page .status.error { color:var(--error); }
.tools-page .status.processing { color:var(--accent); }
.tools-page .progress-bar { height:4px; background:var(--bg-panel); border-radius:2px; margin-top:8px; overflow:hidden; }
.tools-page .progress-bar .fill { height:100%; background:var(--accent); border-radius:2px; animation: tools-indeterminate 1.5s infinite ease-in-out; width:30%; }
@keyframes tools-indeterminate { 0% { transform:translateX(-100%); } 100% { transform:translateX(400%); } }
.tools-page .hint { font-size:12px; color:var(--text-mid); background:var(--bg-panel); border:1px solid var(--border-light); border-radius:4px; padding:8px 12px; margin:12px 0; line-height:1.6; }
`;

// ---- FXパラメータ定義 ----
const FX_TOOL_PARAMS: Record<string, FxToolParam[]> = {
    eq: [{ id: 'low', label: '低域 (dB)', def: 0, min: -12, max: 12 }, { id: 'mid', label: '中域 (dB)', def: 0, min: -12, max: 12 }, { id: 'high', label: '高域 (dB)', def: 0, min: -12, max: 12 }],
    compressor: [{ id: 'threshold', label: 'しきい値 (dB)', def: -20, min: -40, max: 0 }, { id: 'ratio', label: '圧縮比', def: 4, min: 1, max: 20, step: 0.5 }],
    reverb: [{ id: 'room_size', label: '部屋の広さ（0〜1）', def: 0.5, min: 0, max: 1, step: 0.05 }, { id: 'wet', label: 'エフェクト音の量（0〜1）', def: 0.3, min: 0, max: 1, step: 0.05 }],
    delay: [{ id: 'delay_ms', label: '遅れの時間 (ms)', def: 300, min: 50, max: 2000 }, { id: 'feedback', label: '繰り返しの量', def: 0.4, min: 0, max: 0.9, step: 0.05 }, { id: 'wet', label: 'エフェクト音の量（0〜1）', def: 0.3, min: 0, max: 1, step: 0.05 }],
    normalize: [], volume: [{ id: 'db', label: '音量変更 (dB)', def: 0, min: -20, max: 20 }],
    fade_in: [{ id: 'duration', label: 'フェード時間（秒）', def: 3, min: 0.1, step: 0.1 }],
    fade_out: [{ id: 'duration', label: 'フェード時間（秒）', def: 3, min: 0.1, step: 0.1 }],
    pan: [{ id: 'pan', label: 'パン（-1=左、1=右）', def: 0, min: -1, max: 1, step: 0.1 }],
    reverse: [], pitch_shift: [{ id: 'semitones', label: '半音数', def: 0, min: -12, max: 12 }],
    time_stretch: [{ id: 'rate', label: '倍率', def: 1, min: 0.25, max: 3, step: 0.05 }],
    speed: [{ id: 'speed', label: '速度倍率', def: 1, min: 0.25, max: 4, step: 0.05 }],
};

/** エフェクトの日本語の名前（選択肢と、結果の見出しに使う。識別子を画面に出さない）。 */
const FX_TOOL_LABELS: Record<string, string> = {
    eq: 'EQ（3 バンド）', compressor: 'コンプレッサー', reverb: 'リバーブ', delay: 'ディレイ',
    normalize: 'ノーマライズ', volume: '音量変更', fade_in: 'フェードイン', fade_out: 'フェードアウト',
    pan: 'パン', reverse: 'リバース', pitch_shift: 'ピッチシフト', time_stretch: 'タイムストレッチ',
    speed: '速度変更',
};

const EDIT_HINTS: Record<string, string> = {
    trim: '<strong>トリム：</strong>開始〜終了の範囲だけを残し、それ以外を削除します。',
    cut: '<strong>カット：</strong>開始〜終了の範囲を削除し、前後を繋げます。',
    copy_range: '<strong>範囲コピー：</strong>開始〜終了の範囲をコピーし、指定した位置に挿入します。',
    silence: '<strong>無音挿入：</strong>「開始位置」に指定した秒数の無音を挿入します。',
    loop: '<strong>ループ：</strong>開始〜終了の範囲を指定回数繰り返します。',
};

/** 編集の「追加の欄」（挿入位置 / 無音の長さ / ループ回数）の、操作ごとの初期値。 */
const EDIT_EXTRA_DEFAULTS: Record<string, number> = { copy_range: 0, silence: 2, loop: 3 };

const TABS = [
    { key: 'decompose', label: 'パート分離と採譜', tip: '曲をパートに分けて、パートごとのノートまで読み取ります' },
    { key: 'separate', label: 'パート分離', tip: '曲をボーカル・ドラム・ベースなどの音声に分けます' },
    { key: 'analyze', label: '解析', tip: '音の帯域の偏り、使われている楽器、テンポなどを調べます' },
    { key: 'edit', label: '編集', tip: 'WAV ファイルの一部を切り出す・消す・繰り返すなどの編集をします' },
    { key: 'effects', label: 'エフェクト', tip: 'WAV ファイルに響きや音量の整えなどの効果をかけます' },
    { key: 'batch', label: '一括編集', tip: 'いくつものファイルに、同じ操作をまとめてかけます' },
    { key: 'overlay', label: '音源合成', tip: '2 つの WAV ファイルを重ねて、1 つにします' },
    { key: 'convert', label: '変換', tip: '動画や音声のファイルを、WAV か MP3 に変換します' },
    { key: 'wav_optimize', label: 'WAV 最適化', tip: '大きな WAV ファイルを、音質を保ったまま小さくします' },
];

// ---- パート分離パネル ----
/** 音源分離の結果（パートごとの音声）を、結果の一覧にする。 */
function separateResults(result: unknown): AudioResult[] {
    return Object.entries((result ?? {}) as Record<string, { label?: string; url?: unknown } | null>)
        .filter(([, v]) => typeof v?.url === 'string')
        .map(([key, v]) => makeAudioResult(v!.label || key, v!.url as string));
}

/** 「〇〇を中止しました」/ 失敗の文を、ジョブの終わり方から作る（つなぎ直したジョブ用）。 */
function endedText(name: string, job: Job): [string, string] {
    if (job.state === 'cancelled') return [`${name}を中止しました`, ''];
    return [jobErrorMessage(job), 'error'];
}

function SeparatePanel() {
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [results, setResults] = useState<AudioResult[]>([]);
    // 画面を開き直す前に始めた分離が終わったら、その結果を出す
    const separate = useJob('tools-separate', (job) => {
        if (job.state === 'done') {
            const items = separateResults(job.result);
            setResults(items); setStatus(`${items.length} 個のパートに分けました`); setStatusType('');
        } else {
            const [text, type] = endedText('パート分離', job);
            setStatus(text); setStatusType(type);
        }
    });

    const handleSeparate = useCallback(async () => {
        const file = ((document.getElementById('sep-file') as HTMLInputElement | null))?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }
        const model = ((document.getElementById('sep-model') as HTMLInputElement)?.value);
        const mode = ((document.getElementById('sep-mode') as HTMLInputElement)?.value);
        const isDeep = mode === 'deep';
        let apiUrl; const fd = new FormData();
        if (isDeep) { fd.append('file', file); fd.append('depth', '1'); apiUrl = '/api/deep-separate'; }
        else { fd.append('file', file); fd.append('model', model); fd.append('two_stems', mode); apiUrl = '/api/separate'; }
        setStatus(`パートに分けています…（${file.name}）`); setStatusType('processing'); setResults([]);
        modelDownloadNotice(isDeep ? 'htdemucs_6s' : model).then((notice) => { if (notice) setStatus((prev) => prev.startsWith('パートに分けています') ? prev + notice : prev); });
        try {
            const items = separateResults(await separate.run(apiUrl, fd));
            setResults(items); setStatus(`${items.length} 個のパートに分けました`); setStatusType('');
        } catch (e: unknown) {
            if (e instanceof JobCancelledError) { setStatus('パート分離を中止しました'); setStatusType(''); }
            else { setStatus(describeError(e)); setStatusType('error'); }
        }
    }, [separate]);

    return (
        <div className={`tool-panel active`}>
            <h2>パート分離</h2>
            <p className="desc">曲のファイルを、パート（ボーカル・ドラム・ベースなど）に分けます（Demucs による音源分離）。<br /><strong>CPU で処理するため、1 曲あたり数分〜十数分かかります。</strong></p>
            <div className="form-group"><label>音声ファイル</label><input type="file" id="sep-file" accept=".wav,.mp3,.flac,.ogg,.m4a" {...tip('分けたい曲のファイルを選びます')} /></div>
            <div className="form-row">
                <div className="form-group"><label>モデル</label>
                    <select id="sep-model" {...tip('分けるときに使う方式。迷ったら標準の htdemucs を選んでください')}><option value="htdemucs">htdemucs — 標準（推奨）</option><option value="htdemucs_ft">htdemucs_ft — 高精度（遅い）</option><option value="htdemucs_6s">htdemucs_6s — 6 パート</option></select>
                </div>
                <div className="form-group"><label>分け方</label>
                    <select id="sep-mode" {...tip('いくつに分けるか。歌と伴奏を分けるだけなら「2 つに分ける」が早く済みます')}><option value="true">2 つに分ける（ボーカル / 伴奏）</option><option value="false">すべてのパートに分ける</option><option value="deep">さらに細かく分ける（6 パート）</option></select>
                </div>
            </div>
            <button className="btn" onClick={handleSeparate} disabled={separate.heavyBusy} {...tip('パート分離を始めます。終わるまで数分〜十数分かかります')}>パート分離を始める</button>
            <ToolsJobCard slot="tools-separate" handle={separate} hint="待っている間も、ほかのタブ（編集・変換など）は使えます。" />
            <StatusLine text={status} type={statusType} />
            {results.length > 0 && (
                <div className="result-area">
                    <h3>分けたパート</h3>
                    {results.map((r, i) => <ResultItem key={i} result={r} />)}
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
        setStatus(`解析しています…（${file.name}）`); setStatusType('processing'); setProgress(true); setReport('');
        try {
            const resp = await apiFetch('/api/deep-analyze', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const data = await resp.json();
            const html = data.report.replace(/^## (.+)$/gm, '<h3 style="color:var(--accent);margin-top:16px">$1</h3>')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/^- (.+)$/gm, '<div style="padding-left:12px">・ $1</div>')
                // 見出しと箇条書きは、それ自体が 1 行を占める。後ろの改行を残すと 1 行ずつ空く
                .replace(/(<\/h3>|<\/div>)\n/g, '$1');
            setReport(html); setStatus('解析完了'); setStatusType('');
        } catch (e: unknown) { setStatus(describeError(e)); setStatusType('error'); }
        finally { setProgress(false); }
    }, []);

    return (
        <div className="tool-panel active">
            <h2>音声解析</h2>
            <p className="desc">音声ファイルの周波数帯域分布・推定楽器構成・テンポなどを解析します。</p>
            <div className="form-group"><label>音声ファイル</label><input type="file" id="da-file" accept=".wav,.mp3,.flac,.ogg,.m4a" {...tip('調べたい音声ファイルを選びます')} /></div>
            <button className="btn" onClick={handleAnalyze} disabled={progress} {...tip('選んだファイルを調べて、結果を下に表示します')}>解析開始</button>
            {progress && <div className="progress-bar"><div className="fill" /></div>}
            <StatusLine text={status} type={statusType} />
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
        setStatus('処理しています…'); setStatusType('processing');
        try {
            const resp = await apiFetch(`/api/edit/${action}`, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const blob = await resp.blob(); const url = URL.createObjectURL(blob);
            setResults([makeAudioResult('編集結果', url, `${stem(file.name)}_${action}.wav`)]); setStatus('完了'); setStatusType('');
        } catch (e: unknown) { setResults([]); setStatus(describeError(e)); setStatusType('error'); }
    }, [action, start, end, extra]);

    return (
        <div className="tool-panel active">
            <h2>音声編集</h2>
            <p className="desc">WAV ファイルに、トリム・カット・コピー・無音挿入・ループなどの編集をします。</p>
            <div className="form-group"><label>WAV ファイル</label><input type="file" id="edit-file" accept=".wav" {...tip('編集する WAV ファイルを選びます')} /></div>
            <div className="form-group"><label>編集操作</label>
                <select value={action} {...tip('行う編集の種類。下の枠に、それぞれの動きが出ます')} onChange={e => {
                    setAction(e.target.value);
                    // 追加の欄は操作ごとに意味が違うので、その操作でそのまま実行できる値にしておく
                    // (ループの回数は 2 以上でないと断られる)
                    setExtra(EDIT_EXTRA_DEFAULTS[e.target.value] ?? 0);
                }}>
                    <option value="trim">トリム</option><option value="cut">カット</option>
                    <option value="copy_range">範囲コピー</option><option value="silence">無音挿入</option><option value="loop">ループ</option>
                </select>
            </div>
            {action !== 'silence' && (
                <div className="form-row">
                    <div className="form-group"><label>開始位置（秒）</label><input type="number" value={start} min="0" step="0.1" onChange={e => setStart(+e.target.value)} {...tip('編集する範囲の始まり（曲の頭から何秒目か）')} /></div>
                    <div className="form-group"><label>終了位置（秒）</label><input type="number" value={end} min="0" step="0.1" onChange={e => setEnd(+e.target.value)} {...tip('編集する範囲の終わり（曲の頭から何秒目か）')} /></div>
                </div>
            )}
            {action === 'silence' && (
                <div className="form-group"><label>開始位置（秒）</label><input type="number" value={start} min="0" step="0.1" onChange={e => setStart(+e.target.value)} {...tip('無音を入れる位置（曲の頭から何秒目か）')} /></div>
            )}
            {showExtra && <div className="form-group"><label>{extraLabel}</label><input type="number" value={extra} step="0.1" onChange={e => setExtra(+e.target.value)} /></div>}
            <div className="hint" dangerouslySetInnerHTML={{ __html: EDIT_HINTS[action] || '' }} />
            <button className="btn" onClick={handleEdit} disabled={statusType === 'processing'} {...tip('編集した結果を、新しいファイルとして作ります。元のファイルはそのままです')}>編集を実行</button>
            <StatusLine text={status} type={statusType} />
            {results.length > 0 && <div className="result-area"><h3>編集結果</h3>{results.map((r, i) => <ResultItem key={i} result={r} />)}</div>}
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
        setStatus('処理しています…'); setStatusType('processing');
        try {
            const resp = await apiFetch(`/api/effects/${fxType}`, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const blob = await resp.blob(); const url = URL.createObjectURL(blob);
            // 見出しは日本語の名前で出す (識別子の pitch_shift などを画面に出さない)
            setResults([makeAudioResult(`「${FX_TOOL_LABELS[fxType] ?? fxType}」をかけた結果`, url, `${stem(file.name)}_${fxType}.wav`)]); setStatus('完了'); setStatusType('');
        } catch (e: unknown) { setStatus(describeError(e)); setStatusType('error'); }
    }, [fxType, params]);

    return (
        <div className="tool-panel active">
            <h2>エフェクト</h2>
            <p className="desc">WAV ファイルにエフェクトをかけて、新しいファイルとしてダウンロードします。</p>
            <div className="form-group"><label>WAV ファイル</label><input type="file" id="fx-file" accept=".wav" {...tip('効果をかける WAV ファイルを選びます')} /></div>
            <div className="form-group"><label>エフェクト</label>
                <select value={fxType} onChange={e => setFxType(e.target.value)} {...tip('かける効果の種類')}>
                    {Object.entries(FX_TOOL_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
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
            <button className="btn" onClick={handleApply} disabled={statusType === 'processing'} {...tip('効果をかけた新しいファイルを作ります。元のファイルはそのままです')}>エフェクト適用</button>
            <StatusLine text={status} type={statusType} />
            {results.length > 0 && <div className="result-area"><h3>処理結果</h3>{results.map((r, i) => <ResultItem key={i} result={r} />)}</div>}
        </div>
    );
}

// ---- 一括編集パネル ----
/** 一括編集の操作の 1 つ。`label` は一覧に出す名前、`params` は入力欄（API に渡すパラメータ）。 */
interface BatchAction {
    label: string;
    params: FxToolParam[];
}

/** 開始〜終了の範囲を取る操作（トリム・カット・ループ）の入力欄。 */
const BATCH_RANGE: FxToolParam[] = [
    { id: 'start', label: '開始（秒）', def: 0, min: 0, step: 0.1 },
    { id: 'end', label: '終了（秒）', def: 10, min: 0, step: 0.1 },
];

/**
 * 一括編集で選べる操作と、その入力欄。キーは API に渡す操作名。
 *
 * トリム・カット・ループ・無音挿入は、範囲などのパラメータが無いと API が処理できない。
 * 入力欄を出さずに空のパラメータを送ると、全部のファイルが失敗する。
 */
const BATCH_ACTIONS: Record<string, Record<string, BatchAction>> = {
    edit: {
        normalize: { label: 'ノーマライズ', params: [] },
        volume: { label: '音量変更', params: FX_TOOL_PARAMS.volume },
        fade_in: { label: 'フェードイン', params: FX_TOOL_PARAMS.fade_in },
        fade_out: { label: 'フェードアウト', params: FX_TOOL_PARAMS.fade_out },
        reverse: { label: 'リバース', params: [] },
        speed: { label: '速度変更', params: FX_TOOL_PARAMS.speed },
        trim: { label: 'トリム', params: BATCH_RANGE },
        cut: { label: 'カット', params: BATCH_RANGE },
        loop: { label: 'ループ', params: [...BATCH_RANGE, { id: 'count', label: '回数', def: 3, min: 2, max: 50 }] },
        silence: {
            label: '無音挿入',
            params: [
                { id: 'position', label: '位置（秒）', def: 0, min: 0, step: 0.1 },
                { id: 'length', label: '長さ（秒）', def: 2, min: 0.1, step: 0.1 },
            ],
        },
    },
    effects: {
        normalize: { label: 'ノーマライズ', params: [] },
        eq: { label: 'EQ（3 バンド）', params: FX_TOOL_PARAMS.eq },
        compressor: { label: 'コンプレッサー', params: FX_TOOL_PARAMS.compressor },
        reverb: { label: 'リバーブ', params: FX_TOOL_PARAMS.reverb },
        delay: { label: 'ディレイ', params: FX_TOOL_PARAMS.delay },
        volume: { label: '音量変更', params: FX_TOOL_PARAMS.volume },
        fade_in: { label: 'フェードイン', params: FX_TOOL_PARAMS.fade_in },
        fade_out: { label: 'フェードアウト', params: FX_TOOL_PARAMS.fade_out },
        pan: { label: 'パン', params: FX_TOOL_PARAMS.pan },
        reverse: { label: 'リバース', params: [] },
        pitch_shift: { label: 'ピッチシフト', params: FX_TOOL_PARAMS.pitch_shift },
        time_stretch: { label: 'タイムストレッチ', params: FX_TOOL_PARAMS.time_stretch },
        speed: { label: '速度変更', params: FX_TOOL_PARAMS.speed },
    },
};

/** 入力欄の定義から、初期値の組を作る。 */
function defaultParams(defs: FxToolParam[]): Record<string, number> {
    const values: Record<string, number> = {};
    defs.forEach(p => { values[p.id] = p.def; });
    return values;
}

function BatchPanel() {
    const [category, setCategory] = useState('edit');
    const [action, setAction] = useState('normalize');
    const [params, setParams] = useState<Record<string, number>>({});
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [progress, setProgress] = useState(false);
    const [results, setResults] = useState<AudioResult[]>([]);
    const [failures, setFailures] = useState<Array<{ filename: string; reason: string }>>([]);
    const [fileCount, setFileCount] = useState(0);

    const actions = BATCH_ACTIONS[category];
    const paramDefs = actions[action]?.params ?? [];

    /** カテゴリと操作を選び直す。入力欄は、その操作の初期値に戻す。 */
    const choose = (nextCategory: string, nextAction: string) => {
        setCategory(nextCategory);
        setAction(nextAction);
        setParams(defaultParams(BATCH_ACTIONS[nextCategory][nextAction].params));
    };

    const handleBatch = useCallback(async () => {
        const files = ((document.getElementById('batch-files') as HTMLInputElement | null))?.files;
        if (!files?.length) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }
        const defs = BATCH_ACTIONS[category][action].params;
        const fd = new FormData();
        for (const f of files) fd.append('files', f);
        fd.append('params', JSON.stringify({ ...defaultParams(defs), ...params }));
        let apiUrl;
        if (category === 'edit') { fd.append('action', action); apiUrl = '/api/batch/edit'; }
        else { fd.append('effect_name', action); apiUrl = '/api/batch/effects'; }
        const label = BATCH_ACTIONS[category][action].label;
        setStatus(`${files.length}個のファイルに「${label}」を適用しています…`); setStatusType('processing'); setProgress(true); setResults([]); setFailures([]);
        try {
            const resp = await apiFetch(apiUrl, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const data = await resp.json() as Array<{ status: string; url?: string | null; filename: string }>;
            const items = data.filter(r => r.status === 'ok' && r.url).map(r => makeAudioResult(r.filename, r.url!));
            // 失敗したファイルは、理由と一緒に見せる (見せないと「0個成功」としか分からない)
            const failed = data.filter(r => !(r.status === 'ok' && r.url))
                .map(r => ({ filename: r.filename, reason: r.status.replace(/^error:\s*/, '') }));
            setResults(items); setFailures(failed);
            setStatus(`完了: ${items.length}個成功` + (failed.length > 0 ? ` / ${failed.length}個失敗` : ''));
            setStatusType(failed.length > 0 ? 'error' : '');
        } catch (e: unknown) { setStatus(describeError(e)); setStatusType('error'); }
        finally { setProgress(false); }
    }, [category, action, params]);

    return (
        <div className="tool-panel active">
            <h2>一括編集</h2>
            <p className="desc">複数の音声ファイルに同じ操作を一括適用します。</p>
            <div className="form-group"><label>音声ファイル（複数選択可）</label><input type="file" id="batch-files" accept=".wav,.mp3,.flac,.ogg,.m4a" multiple onChange={e => setFileCount(e.target.files?.length ?? 0)} {...tip('まとめて処理するファイルを選びます。いくつでも選べます')} /></div>
            {fileCount > 0 && <div style={{ fontSize: 12, color: 'var(--text-mid)', marginBottom: 12 }}>{fileCount}個のファイルを選択</div>}
            <div className="form-row">
                <div className="form-group"><label>カテゴリ</label>
                    <select value={category} onChange={e => choose(e.target.value, Object.keys(BATCH_ACTIONS[e.target.value])[0])}
                        {...tip('編集とエフェクトの、どちらの操作をかけるか')}>
                        <option value="edit">編集</option><option value="effects">エフェクト</option>
                    </select>
                </div>
                <div className="form-group"><label>操作</label>
                    <select value={action} onChange={e => choose(category, e.target.value)} {...tip('かける操作')}>
                        {Object.entries(actions).map(([key, a]) => <option key={key} value={key}>{a.label}</option>)}
                    </select>
                </div>
            </div>
            {paramDefs.length > 0 && (
                <div className="form-row batch-params" style={{ flexWrap: 'wrap' }}>
                    {paramDefs.map(p => (
                        <div className="form-group" key={p.id}><label>{p.label}</label>
                            <input type="number" value={params[p.id] ?? p.def} min={p.min} max={p.max} step={p.step || 1}
                                onChange={e => setParams(prev => ({ ...prev, [p.id]: +e.target.value }))} />
                        </div>
                    ))}
                </div>
            )}
            <button className="btn" onClick={handleBatch} disabled={progress} {...tip('選んだすべてのファイルに、同じ操作をかけます')}>一括実行</button>
            {progress && <div className="progress-bar"><div className="fill" /></div>}
            <StatusLine text={status} type={statusType} />
            {failures.length > 0 && (
                <div className="batch-failures" style={{ fontSize: 12, color: 'var(--error)', marginTop: 8, lineHeight: 1.7 }}>
                    {failures.map((f, i) => <div key={i}>{f.filename}: {f.reason}</div>)}
                </div>
            )}
            {results.length > 0 && <div className="result-area"><h3>処理結果</h3>{results.map((r, i) => <ResultItem key={i} result={r} />)}</div>}
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
        setStatus('合成しています…'); setStatusType('processing');
        try {
            const resp = await apiFetch('/api/overlay', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const blob = await resp.blob(); const url = URL.createObjectURL(blob);
            setResults([makeAudioResult('合成結果', url, `${stem(baseFile.name)}_overlay.wav`)]); setStatus('完了'); setStatusType('');
        } catch (e: unknown) { setStatus(describeError(e)); setStatusType('error'); }
    }, [offset, baseVol, overVol]);

    return (
        <div className="tool-panel active">
            <h2>音源合成（オーバーレイ）</h2>
            <p className="desc">2 つの WAV ファイルを重ねて、1 つのファイルにします。</p>
            <div className="form-group"><label>ベース音源</label><input type="file" id="ovl-base" accept=".wav" {...tip('下に敷く音（伴奏など）の WAV ファイル')} /></div>
            <div className="form-group"><label>オーバーレイ音源</label><input type="file" id="ovl-over" accept=".wav" {...tip('上に重ねる音（歌など）の WAV ファイル')} /></div>
            <div className="form-row">
                <div className="form-group"><label>開始位置（秒）</label><input type="number" value={offset} min="0" step="0.1" onChange={e => setOffset(+e.target.value)} {...tip('重ねる音を、ベース音源の何秒目から鳴らすか')} /></div>
            </div>
            <div className="form-row">
                <div className="form-group"><label>ベース音量 (dB)</label><input type="number" value={baseVol} min="-20" max="20" onChange={e => setBaseVol(+e.target.value)} {...tip('ベース音源の大きさの増減。0 でそのまま')} /></div>
                <div className="form-group"><label>オーバーレイ音量 (dB)</label><input type="number" value={overVol} min="-20" max="20" onChange={e => setOverVol(+e.target.value)} {...tip('重ねる音の大きさの増減。0 でそのまま')} /></div>
            </div>
            <button className="btn" onClick={handleOverlay} disabled={statusType === 'processing'} {...tip('2 つを重ねた新しいファイルを作ります')}>合成を実行</button>
            <StatusLine text={status} type={statusType} />
            {results.length > 0 && <div className="result-area"><h3>合成結果</h3>{results.map((r, i) => <ResultItem key={i} result={r} />)}</div>}
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
        setStatus('変換しています…'); setStatusType('processing');
        try {
            const resp = await apiFetch(`/api/convert/${target}`, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const blob = await resp.blob(); const url = URL.createObjectURL(blob);
            setResults([makeAudioResult(`${target.toUpperCase()} 変換結果`, url, `${stem(file.name)}.${target}`)]); setStatus('完了'); setStatusType('');
        } catch (e: unknown) { setStatus(describeError(e)); setStatusType('error'); }
    }, [target, bitrate]);

    return (
        <div className="tool-panel active">
            <h2>フォーマット変換</h2>
            <p className="desc">動画ファイル（MP4 など）や音声ファイルを、WAV か MP3 に変換します。</p>
            <div className="form-group"><label>変換元ファイル</label><input type="file" id="conv-file" accept=".mp4,.avi,.mkv,.webm,.mov,.flv,.m4a,.aac,.ogg,.flac,.wav,.mp3" {...tip('変換するファイル。MP4 などの動画からは、音だけを取り出します')} /></div>
            <div className="form-row">
                <div className="form-group"><label>出力フォーマット</label>
                    <select value={target} onChange={e => setTarget(e.target.value)} {...tip('作るファイルの形式。WAV は音質そのまま、MP3 はファイルが小さくなります')}><option value="wav">WAV</option><option value="mp3">MP3</option></select>
                </div>
                {target === 'mp3' && (
                    <div className="form-group"><label>ビットレート</label>
                        <select value={bitrate} onChange={e => setBitrate(e.target.value)} {...tip('MP3 の音質。数字が大きいほど音がよく、ファイルも大きくなります')}>
                            <option value="128">128 kbps</option><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps</option>
                        </select>
                    </div>
                )}
            </div>
            <button className="btn" onClick={handleConvert} disabled={statusType === 'processing'} {...tip('変換したファイルを作ります')}>変換を実行</button>
            <StatusLine text={status} type={statusType} />
            {results.length > 0 && <div className="result-area"><h3>変換結果</h3>{results.map((r, i) => <ResultItem key={i} result={r} />)}</div>}
        </div>
    );
}

// ---- パート分離と採譜パネル ----
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

/** 分解の結果を、状態の 1 行にする。 */
function decomposeSummary(data: DecomposeResult): string {
    const stemCount = Object.keys(data.stems).length;
    const totalNotes = Object.values(data.stems).reduce((sum, s) =>
        sum + (s.notes?.length || 0) + (s.drum_events?.length || 0), 0);
    return `パートに分けて採譜しました（BPM ${data.bpm} / ${stemCount} パート / ${totalNotes} ノート）`;
}

function DecomposePanel() {
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('');
    const [bpm, setBpm] = useState(0);
    const [sensitivity, setSensitivity] = useState(0.5);
    const [result, setResult] = useState<DecomposeResult | null>(null);
    // 画面を開き直す前に始めた分解が終わったら、その結果を出す
    const decompose = useJob('tools-decompose', (job) => {
        if (job.state === 'done') {
            const data = job.result as DecomposeResult;
            setResult(data); setStatus(decomposeSummary(data)); setStatusType('');
        } else {
            const [text, type] = endedText('パート分離と採譜', job);
            setStatus(text); setStatusType(type);
        }
    });

    const handleDecompose = useCallback(async () => {
        const file = (document.getElementById('decompose-file') as HTMLInputElement | null)?.files?.[0];
        if (!file) { setStatus('ファイルを選択してください'); setStatusType('error'); return; }

        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', String(bpm));
        fd.append('sensitivity', String(sensitivity));

        setStatus(`パートに分けて採譜しています…（${file.name}）パート分離 → 採譜 → 楽器の推定。CPU で処理するため数分かかります。`);
        modelDownloadNotice('htdemucs_6s').then((notice) => { if (notice) setStatus((prev) => prev.startsWith('パートに分けて採譜しています') ? prev + notice : prev); });
        setStatusType('processing'); setResult(null);

        try {
            const data = await decompose.run<DecomposeResult>('/api/decompose', fd);
            setResult(data);
            setStatus(decomposeSummary(data));
            setStatusType('');
        } catch (e: unknown) {
            if (e instanceof JobCancelledError) { setStatus('パート分離と採譜を中止しました'); setStatusType(''); }
            else { setStatus(describeError(e)); setStatusType('error'); }
        }
    }, [bpm, sensitivity, decompose]);

    return (
        <div className="tool-panel active">
            <h2>パート分離と採譜</h2>
            <p className="desc">
                曲のファイルをパートに分け、パートごとにノートを採譜します。<br />
                <strong>パート分離 → 採譜（和音にも対応）→ ドラムのパターンの解析 → 楽器の推定</strong>をまとめて行います。<br />
                結果は、パートごとの音声と、ノートのデータ（JSON）で受け取れます。
            </p>
            <div className="form-group">
                <label>曲のファイル（WAV / MP3 / FLAC）</label>
                <input type="file" id="decompose-file" accept=".wav,.mp3,.flac,.ogg,.m4a" {...tip('分けたい曲のファイルを選びます')} />
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>BPM（0 = 自動検出）</label>
                    <input type="number" value={bpm} min="0" max="300"
                        onChange={e => setBpm(+e.target.value)} {...tip('曲の速さ。0 にすると自動で調べます')} />
                </div>
                <div className="form-group">
                    <label>採譜の感度（{sensitivity}）</label>
                    <input type="range" min="0.1" max="1" step="0.05" value={sensitivity}
                        onChange={e => setSensitivity(+e.target.value)}
                        {...tip('上げると小さな音まで拾います。余分なノートが多いときは下げてください')}
                        style={{ width: '100%', background: 'var(--bg-panel)' }} />
                </div>
            </div>
            <div className="hint">
                <strong>DAW の画面で使うには:</strong><br />
                DAW の画面の左パネル「ファイル」タブにある「パートに分ける（パート分離）」が、同じ処理をします。
                そちらを使うと、分けたパートがそのままトラックになり、採譜したノートがピアノロールに並びます
                （お手本としても残ります）。
            </div>
            <button className="btn" onClick={handleDecompose} disabled={decompose.heavyBusy} {...tip('パート分離と採譜を始めます。数分かかります')}>
                パート分離と採譜を始める
            </button>
            <ToolsJobCard slot="tools-decompose" handle={decompose} hint="待っている間も、ほかのタブ（編集・変換など）は使えます。" />
            <StatusLine text={status} type={statusType} />

            {result && (
                <div className="result-area" style={{ display: 'block' }}>
                    <h3>結果（BPM {result.bpm}）</h3>
                    {Object.entries(result.stems).map(([name, stem]) => (
                        <div key={name} className="result-item" style={{ paddingBottom: 16, marginBottom: 16 }}>
                            <div className="result-label" style={{ fontSize: 14, marginBottom: 8 }}>
                                {STEM_LABELS[name] || name}
                                {stem.gm_program != null && <span style={{ marginLeft: 8, color: 'var(--text-mid)' }}>GM 音源 {stem.gm_program} 番</span>}
                            </div>

                            {stem.audio_url && <audio controls src={backendUrl(stem.audio_url)} style={{ width: '100%', marginBottom: 8 }} />}

                            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-mid)', marginBottom: 8 }}>
                                <span>音量: {stem.mix.volume_db} dB</span>
                                <span>パン: {stem.mix.pan}</span>
                                <span>残響: {(stem.mix.reverb_wet * 100).toFixed(0)}%</span>
                            </div>

                            {stem.notes && stem.notes.length > 0 && (
                                <div style={{ fontSize: 12, color: 'var(--accent)' }}>
                                    {stem.notes.length} ノート
                                    <span style={{ color: 'var(--text-mid)', marginLeft: 8 }}>
                                        （{stem.notes.slice(0, 5).map(n => `${n.note}${n.octave}`).join(' ')}{stem.notes.length > 5 ? ' …' : ''}）
                                    </span>
                                </div>
                            )}

                            {stem.drum_events && stem.drum_events.length > 0 && (
                                <div style={{ fontSize: 12, color: 'var(--secondary)' }}>
                                    ドラム {stem.drum_events.length} 打
                                    <span style={{ color: 'var(--text-mid)', marginLeft: 8 }}>
                                        （キック {stem.drum_events.filter(e => e.type === 'kick').length}
                                        {' '}/ スネア {stem.drum_events.filter(e => e.type === 'snare').length}
                                        {' '}/ ハイハット {stem.drum_events.filter(e => e.type === 'hihat').length}）
                                    </span>
                                </div>
                            )}

                            {stem.audio_url && <a href={backendUrl(stem.audio_url)} download style={{ fontSize: 12 }}>WAV をダウンロード</a>}
                        </div>
                    ))}

                    <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-panel)', borderRadius: 6 }}>
                        <div style={{ fontSize: 13, color: 'var(--accent)', marginBottom: 8 }}>ノートのデータ（JSON）</div>
                        <textarea
                            readOnly
                            value={JSON.stringify(result, null, 2)}
                            style={{ width: '100%', height: 120, background: 'var(--bg-primary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, fontFamily: 'var(--font-mono)', resize: 'vertical', padding: 8 }}
                        />
                        <button className="btn" style={{ marginTop: 8 }} {...tip('上のデータを、JSON ファイルとして保存します')}
                            onClick={() => {
                                const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url; a.download = 'decompose_result.json';
                                a.click(); URL.revokeObjectURL(url);
                            }}>
                            JSON をダウンロード
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ---- WAV 最適化パネル ----
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
            const resp = await apiFetch('/api/wav/info', { method: 'POST', body: fd });
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

        setStatus('最適化しています…'); setStatusType('processing'); setProgress(true); setResult(null);
        try {
            const resp = await apiFetch('/api/wav/optimize', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const data: OptimizeResult = await resp.json();
            setResult(data);
            setStatus(`完了: 容量を ${data.reduction_pct}% 減らしました（${data.original.file_size_mb} MB → ${data.optimized.file_size_mb} MB）`);
            setStatusType('');
        } catch (e: unknown) { setStatus(describeError(e)); setStatusType('error'); }
        finally { setProgress(false); }
    }, [targetSr, targetBit]);

    return (
        <div className="tool-panel active">
            <h2>WAV 最適化（容量削減）</h2>
            <p className="desc">
                動画から作った大きな WAV ファイルを、音質を保ったまま一般的な大きさにします。<br />
                <strong>サンプルレート変換</strong>（48kHz→44.1kHz）+ <strong>ビット深度変換</strong>（32bit→16bit）+
                <strong>TPDFディザリング</strong>で量子化ノイズを最小化。
            </p>
            <div className="form-group">
                <label>WAV ファイル</label>
                <input type="file" id="opt-file" accept=".wav" onChange={handleInfo} {...tip('小さくしたい WAV ファイル。選ぶと、いまの形式が下に出ます')} />
            </div>

            {info && (
                <div style={{ fontSize: 12, color: 'var(--text-mid)', padding: '8px 12px', background: 'var(--bg-panel)', borderRadius: 4, marginBottom: 12 }}>
                    現在: <strong style={{ color: 'var(--text)' }}>{info.sample_rate}Hz / {info.bit_depth} / {info.channels}ch</strong>
                    {' '}— {info.duration_sec}秒 / {info.file_size_mb}MB
                </div>
            )}

            <div className="form-row">
                <div className="form-group">
                    <label>目標サンプルレート</label>
                    <select value={targetSr} onChange={e => setTargetSr(+e.target.value)} {...tip('1 秒を何回に分けて記録するか。44100 Hz で十分な音質です')}>
                        <option value="44100">44100 Hz（CD品質・推奨）</option>
                        <option value="48000">48000 Hz（動画標準）</option>
                        <option value="22050">22050 Hz（軽量）</option>
                    </select>
                </div>
                <div className="form-group">
                    <label>目標ビット深度</label>
                    <select value={targetBit} onChange={e => setTargetBit(+e.target.value)} {...tip('音の大きさを記録する細かさ。16bit で十分な音質です')}>
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

            <button className="btn" onClick={handleOptimize} disabled={progress} {...tip('形式を変えて、小さくした WAV ファイルを作ります')}>最適化を実行</button>
            {progress && <div className="progress-bar"><div className="fill" /></div>}
            <StatusLine text={status} type={statusType} />

            {result && (
                <div className="result-area" style={{ display: 'block' }}>
                    <h3>最適化結果</h3>
                    <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                        <thead><tr style={{ color: 'var(--text-mid)', textAlign: 'left' }}>
                            <th style={{ padding: '4px 8px' }}></th><th style={{ padding: '4px 8px' }}>元</th><th style={{ padding: '4px 8px' }}>最適化後</th>
                        </tr></thead>
                        <tbody>
                            <tr><td style={{ padding: '4px 8px', color: 'var(--text-mid)' }}>サンプルレート</td>
                                <td style={{ padding: '4px 8px' }}>{result.original.sample_rate} Hz</td>
                                <td style={{ padding: '4px 8px', color: 'var(--accent)' }}>{result.optimized.sample_rate} Hz</td></tr>
                            <tr><td style={{ padding: '4px 8px', color: 'var(--text-mid)' }}>ビット深度</td>
                                <td style={{ padding: '4px 8px' }}>{result.original.bit_depth}</td>
                                <td style={{ padding: '4px 8px', color: 'var(--accent)' }}>{result.optimized.bit_depth}</td></tr>
                            <tr><td style={{ padding: '4px 8px', color: 'var(--text-mid)' }}>ファイルサイズ</td>
                                <td style={{ padding: '4px 8px' }}>{result.original.file_size_mb} MB</td>
                                <td style={{ padding: '4px 8px', color: 'var(--ok)', fontWeight: 'bold' }}>{result.optimized.file_size_mb} MB（{result.reduction_pct}% 減）</td></tr>
                        </tbody>
                    </table>
                    {result.download_url && (
                        <div style={{ marginTop: 12 }}>
                            <audio controls src={backendUrl(result.download_url)} style={{ width: '100%', marginBottom: 8 }} />
                            <a href={backendUrl(result.download_url)} download style={{ color: 'var(--accent-hover)', fontSize: 13 }}>最適化した WAV をダウンロード</a>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/** ツールの画面の、進み具合のカード。断られたときの「実行中の処理を見る」は、ページの上のカードへ移る。 */
function ToolsJobCard({ slot, handle, hint }: { slot: JobSlot; handle: ReturnType<typeof useJob>; hint?: string }) {
    return (
        <JobCard slot={slot} job={handle.job} busyJob={handle.busyJob} onCancel={() => void handle.cancel()} hint={hint}
            onShowBusy={(job) => jobTracker.requestFocus(slotOf(job) ?? OTHER_SLOT)} />
    );
}

/** どこで始めたか分からない処理を、ページの上のカードで受けるときの置き場所。 */
const OTHER_SLOT: JobSlot = 'tools-separate';

/** タブごとの置き場所（そのタブの中にカードが在るもの）。 */
const TAB_SLOT: Record<string, JobSlot> = { separate: 'tools-separate', decompose: 'tools-decompose' };

/**
 * いま開いているタブの外で動いている処理（DAW の画面や、別のタブで始めたもの）を、ページの上に出す。
 * 重い処理は同時に 1 つなので、何が動いているか分からないまま始めるボタンが押せない、ということにしない。
 */
function OtherJobCard({ activeTab }: { activeTab: string }) {
    const { active } = useJobs();
    if (!active) return null;
    const slot = slotOf(active);
    if (slot && slot === TAB_SLOT[activeTab]) return null;
    return (
        <div style={{ marginBottom: 16 }}>
            <JobCard slot={slot ?? OTHER_SLOT} job={active} onCancel={() => void jobTracker.cancel(active.id)}
                hint="重い処理は 1 つずつ動きます。終わると、パート分離などを始められます。" />
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
            {/* 説明は右に出す (入らなければ下か上)。欄は横いっぱいなので、多くは下に出る */}
            <div className="container" data-tip-side="right">
                <div className="page-header" data-tip-side="bottom">
                    <h1>bunri ツール</h1>
                    <div className="nav-links">
                        <Link to="/" {...tip('DAW の画面に戻ります')}>DAW に戻る</Link>
                        <Link to="/help" {...tip('使い方の説明を開きます')}>使い方</Link>
                    </div>
                </div>
                <div className="tool-tabs" data-tip-side="bottom">
                    {TABS.map(tab => (
                        <button key={tab.key} className={activeTab === tab.key ? 'active' : ''} {...tip(tab.tip)}
                            onClick={() => setActiveTab(tab.key)}>{tab.label}</button>
                    ))}
                </div>
                <OtherJobCard activeTab={activeTab} />
                <ActivePanel />
            </div>
        </div>
    );
}
