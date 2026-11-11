/**
 * bunri DAW — 再現ガイド（第2層）のパネル。
 * 楽曲カルテの下に出す。カルテを Claude に渡し、「こう作れば再現できる」という手順を表示する。
 *
 * 表示するのは説明文と、カルテ上の場所（セクション・小節）だけ。音符は出さない。
 * 説明文にカルテに無い音名・コード名が出てきたら、その旨を添える。
 */
import { useCallback, useState } from 'react';
import { useDaw } from '../lib/store';
import { SECTION_LABEL_JA } from '../lib/chart';
import { GuideRequestError, deleteApiKey, refLabel, requestGuide, saveApiKey, type GuideResponse } from '../lib/guide';

/** 手順の主題ごとの見出しラベル。 */
const TOPIC_LABEL: Record<string, string> = {
    grid: 'テンポ・拍',
    key: 'キー',
    chords: 'コード',
    sections: '構成',
    mix: '音作り・ミックス',
    general: '全体',
};

const noteStyle = { fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.6 } as const;

/**
 * 再現ガイドのパネル。カルテが無いときは何も出さない。
 */
export default function GuidePanel() {
    const { chart, chartId } = useDaw();
    const [focus, setFocus] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<GuideResponse | null>(null);
    const [error, setError] = useState<GuideRequestError | null>(null);
    const [showKeyForm, setShowKeyForm] = useState(false);
    const [keyInput, setKeyInput] = useState('');
    const [keyMessage, setKeyMessage] = useState('');

    const handleGenerate = useCallback(async () => {
        if (!chartId) return;
        setBusy(true);
        setError(null);
        try {
            setResult(await requestGuide(chartId, focus || null));
        } catch (e) {
            const err = e instanceof GuideRequestError ? e : new GuideRequestError(String((e as Error)?.message ?? e), 'api');
            setError(err);
            if (err.needsKey) setShowKeyForm(true);
        } finally {
            setBusy(false);
        }
    }, [chartId, focus]);

    const handleSaveKey = useCallback(async () => {
        const key = keyInput.trim();
        if (!key) { setKeyMessage('API キーを入力してください'); return; }
        try {
            await saveApiKey(key);
            setKeyInput('');
            setKeyMessage('API キーを設定しました');
            setShowKeyForm(false);
            setError(null);
        } catch (e) {
            setKeyMessage('設定できませんでした: ' + String((e as Error)?.message ?? e));
        }
    }, [keyInput]);

    const handleDeleteKey = useCallback(async () => {
        try {
            await deleteApiKey();
            setKeyMessage('設定した API キーを消しました');
        } catch (e) {
            setKeyMessage('消せませんでした: ' + String((e as Error)?.message ?? e));
        }
    }, []);

    if (!chart || !chartId) return null;
    const guide = result?.guide;

    return (
        <div id="guide-panel" style={{ marginTop: 20, paddingTop: 12, borderTop: '1px solid var(--border, #2a2a35)' }}>
            <h3 style={{ marginBottom: 6 }}>再現ガイド</h3>
            <p className="panel-desc" style={{ marginBottom: 8 }}>
                カルテの内容を「こう作れば再現できる」という手順に言い換えます。
            </p>

            <div>
                <label htmlFor="guide-focus">対象</label>
                <select id="guide-focus" value={focus} onChange={(e) => setFocus(e.target.value)} disabled={busy}>
                    <option value="">曲全体</option>
                    {chart.sections.map((s) => {
                        const raw = s.label ?? s.suggested_label;
                        const name = raw ? (SECTION_LABEL_JA[raw] ?? raw) : `区間 ${s.id}`;
                        return <option key={s.id} value={s.id}>{name}（{s.start_bar}〜{s.end_bar} 小節）</option>;
                    })}
                </select>
            </div>
            <button className="action-btn" onClick={handleGenerate} disabled={busy}>
                {busy ? '作成中…（数十秒かかります）' : guide ? 'ガイドを作り直す' : 'ガイドを作る'}
            </button>
            <p style={{ ...noteStyle, marginTop: 6 }}>
                カルテ（ファイル名と解析結果）を Anthropic の Claude に送ります。音声は送りません。
                {' '}
                <button type="button" onClick={() => setShowKeyForm((v) => !v)}
                    style={{ background: 'none', border: 'none', color: 'var(--accent, #e8bc6a)', cursor: 'pointer', fontSize: 10, padding: 0 }}>
                    API キーの設定
                </button>
            </p>

            {error && <p role="alert" style={{ fontSize: 11, color: '#e87878', marginTop: 8 }}>{error.message}</p>}

            {showKeyForm && (
                <div style={{ marginTop: 8, padding: 8, border: '1px solid var(--border, #2a2a35)', borderRadius: 4 }}>
                    <div>
                        <label htmlFor="guide-api-key">Claude の API キー</label>
                        <input id="guide-api-key" type="password" autoComplete="off" value={keyInput}
                            placeholder="sk-ant-…" onChange={(e) => setKeyInput(e.target.value)} />
                    </div>
                    <button className="action-btn" style={{ marginTop: 6 }} onClick={handleSaveKey}>設定する</button>
                    {' '}
                    <button className="action-btn" style={{ marginTop: 6 }} onClick={handleDeleteKey}>設定を消す</button>
                    <p style={{ ...noteStyle, marginTop: 6 }}>
                        この Mac のキーチェーンに保存します。開発用にブラウザで開いているときは、バックエンドを再起動すると消えます
                        （続けて使うなら、環境変数 ANTHROPIC_API_KEY を設定して起動してください）。
                    </p>
                </div>
            )}
            {keyMessage && <p style={{ ...noteStyle, marginTop: 6 }}>{keyMessage}</p>}

            {guide && (
                <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 10 }}>{guide.overview}</p>
                    <ol style={{ paddingLeft: 18, margin: 0 }}>
                        {guide.steps.map((step, i) => (
                            <li key={i} style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: 12, fontWeight: 600 }}>
                                    {step.title}
                                    <span style={{ ...noteStyle, marginLeft: 6, fontWeight: 400 }}>{TOPIC_LABEL[step.topic] ?? step.topic}</span>
                                </div>
                                <p style={{ fontSize: 11, lineHeight: 1.7, margin: '4px 0', whiteSpace: 'pre-wrap' }}>{step.body}</p>
                                {step.refs.length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                        {step.refs.map((ref, j) => (
                                            <span key={j} className="guide-ref"
                                                style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'var(--bg-raised, #22222b)', color: 'var(--text-mid)' }}>
                                                {refLabel(ref, chart)}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>

                    {guide.cautions.length > 0 && (
                        <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 600 }}>注意</div>
                            <ul style={{ paddingLeft: 18, margin: '4px 0' }}>
                                {guide.cautions.map((c, i) => <li key={i} style={{ fontSize: 11, lineHeight: 1.6 }}>{c}</li>)}
                            </ul>
                        </div>
                    )}

                    {guide.unverified_terms.length > 0 && (
                        <p role="note" style={{ fontSize: 11, color: '#e8bc6a', marginTop: 8, lineHeight: 1.6 }}>
                            解析結果に無い音名・コード名が説明に含まれています: {guide.unverified_terms.join('、')}。
                            この部分は解析ではなく、モデルの推測かもしれません。
                        </p>
                    )}
                    <p style={{ ...noteStyle, marginTop: 8 }}>作成: {result.model}</p>
                </div>
            )}
        </div>
    );
}
