/**
 * bunri DAW — 再現ガイド（第2層）のパネル。
 * 楽曲カルテの下に出す。カルテを Claude に渡し、「こう作れば再現できる」という手順を表示する。
 *
 * 表示するのは説明文と、カルテ上の場所（セクション・小節）だけ。音符は出さない。
 * 説明文にカルテに無い音名・コード名が出てきたら、その旨を添える。
 *
 * Claude を呼ぶと費用がかかるので、
 * - 保存済みのガイドが在れば、最初からそれを表示する（Claude は呼ばない）
 * - 作り直しは、費用がかかる旨を添えたボタンを押したときだけ
 * - 1 回ごとのトークン数と概算の費用、今日の累計と上限を見せる
 */
import { useCallback, useEffect, useState } from 'react';
import { useDaw } from '../lib/store';
import { SECTION_LABEL_JA } from '../lib/chart';
import { isDesktop } from '../lib/api';
import {
    GuideRequestError, deleteApiKey, fetchSavedGuide, formatUsd, refLabel, requestGuide, saveApiKey, saveGuideSettings,
    type GuideResponse, type GuideToday,
} from '../lib/guide';

/** 手順の主題ごとの見出しラベル。 */
const TOPIC_LABEL: Record<string, string> = {
    grid: 'テンポ・拍',
    key: 'キー',
    chords: 'コード',
    sections: '構成',
    mix: '音作り・ミックス',
    general: '全体',
};

/** トークン数を、桁区切りつきの文字にする。 */
const count = (value: number | null | undefined) => (value ?? 0).toLocaleString('ja-JP');

/** このガイドを作った呼び出しの使用量を、1 行の文にする。 */
function usageLine(result: GuideResponse): string {
    const u = result.usage ?? {};
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const parts = [`入力 ${count(input)} トークン`];
    if (u.cache_read_input_tokens) parts[0] += `（うち ${count(u.cache_read_input_tokens)} はキャッシュから）`;
    parts.push(`出力 ${count(u.output_tokens)} トークン`);
    if (typeof result.cost_usd === 'number') parts.push(`概算 ${formatUsd(result.cost_usd)}`);
    return parts.join('、');
}

/** 今日の累計と上限を、1 行の文にする。 */
function todayLine(today: GuideToday): string {
    const limits: string[] = [];
    if (today.limit_calls !== null) limits.push(`${today.limit_calls} 回`);
    if (today.limit_usd !== null) limits.push(formatUsd(today.limit_usd));
    const limit = limits.length > 0 ? `上限 ${limits.join('・')}` : '上限なし';
    return `今日 Claude を呼んだ回数: ${today.calls} 回、概算 ${formatUsd(today.cost_usd)}（1 日の${limit}）`;
}

/**
 * 再現ガイドのパネル。カルテが無いときは何も出さない。
 */
export default function GuidePanel() {
    const { chart, chartId } = useDaw();
    const [focus, setFocus] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<GuideResponse | null>(null);
    const [today, setToday] = useState<GuideToday | null>(null);
    const [error, setError] = useState<GuideRequestError | null>(null);
    const [showKeyForm, setShowKeyForm] = useState(false);
    const [keyInput, setKeyInput] = useState('');
    const [keyMessage, setKeyMessage] = useState('');
    const [limitInput, setLimitInput] = useState('');

    // カルテを開いたとき・対象を変えたとき・カルテが変わったとき（グリッド補正）に、保存済みのガイドを探す。
    // 在れば最初から表示する。Claude は呼ばない
    useEffect(() => {
        if (!chartId) return;
        let stale = false;
        setResult(null);
        setError(null);
        fetchSavedGuide(chartId, focus || null)
            .then((saved) => {
                if (stale) return;
                if (saved.today) setToday(saved.today);
                if (saved.saved === true) setResult(saved);
            })
            .catch(() => {
                // 保存済みが取れなくても、作ることはできる。ここでは何も出さない
            });
        return () => { stale = true; };
    }, [chartId, chart, focus]);

    const handleGenerate = useCallback(async () => {
        if (!chartId) return;
        setBusy(true);
        setError(null);
        try {
            // すでに表示しているときにボタンを押すのは「作り直す」。そのときだけ、保存済みを使わせない
            const made = await requestGuide(chartId, focus || null, result !== null);
            setResult(made);
            if (made.today) setToday(made.today);
        } catch (e) {
            const err = e instanceof GuideRequestError ? e : new GuideRequestError(String((e as Error)?.message ?? e), 'api');
            setError(err);
            if (err.needsKey) setShowKeyForm(true);
        } finally {
            setBusy(false);
        }
    }, [chartId, focus, result]);

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

    const handleSaveLimit = useCallback(async () => {
        const text = limitInput.trim();
        const value = text === '' ? null : Number(text);
        if (value !== null && (!Number.isInteger(value) || value < 0)) {
            setKeyMessage('上限は 0 以上の整数で入力してください（空にすると上限なし）');
            return;
        }
        try {
            const saved = await saveGuideSettings({ daily_limit_calls: value });
            setToday(saved.today);
            setLimitInput('');
            setKeyMessage(value === null ? '1 日の上限を無しにしました' : `1 日の上限を ${value} 回にしました`);
            setError(null);
        } catch (e) {
            setKeyMessage('設定できませんでした: ' + String((e as Error)?.message ?? e));
        }
    }, [limitInput]);

    if (!chart || !chartId) return null;
    const guide = result?.guide;

    return (
        <div id="guide-panel" className="panel-section">
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
                {busy ? '作成中…（数十秒かかります）' : guide ? 'ガイドを作り直す（費用がかかります）' : 'ガイドを作る'}
            </button>
            {guide && !busy && (
                <p className="note-text" style={{ marginTop: 6 }}>
                    このガイドは保存済みです。開き直しても Claude は呼びません。作り直すと、もう一度 Claude を呼びます
                    {typeof result?.cost_usd === 'number' ? `（前回は概算 ${formatUsd(result.cost_usd)}）` : ''}。
                </p>
            )}
            <p className="note-text" style={{ marginTop: 6 }}>
                カルテ（解析結果）を Anthropic の Claude に送ります。音声は送りません。ファイル名も送りません。
                {' '}
                <button type="button" onClick={() => setShowKeyForm((v) => !v)} aria-expanded={showKeyForm}
                    style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', padding: 0, textDecoration: 'underline' }}>
                    API キーと上限の設定
                </button>
            </p>
            {today && <p id="guide-today" className="note-text" style={{ marginTop: 4 }}>{todayLine(today)}</p>}

            {error && <p role="alert" className="error-text" style={{ marginTop: 8 }}>{error.message}</p>}

            {showKeyForm && (
                <div style={{ marginTop: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <div>
                        <label htmlFor="guide-api-key">Claude の API キー</label>
                        <input id="guide-api-key" type="password" autoComplete="off" value={keyInput}
                            placeholder="sk-ant-…" onChange={(e) => setKeyInput(e.target.value)} />
                    </div>
                    <button className="action-btn" style={{ marginTop: 6 }} onClick={handleSaveKey}>設定する</button>
                    {' '}
                    <button className="action-btn" style={{ marginTop: 6 }} onClick={handleDeleteKey}>設定を消す</button>
                    <p className="note-text" style={{ marginTop: 6 }}>
                        {/* 開発者向けの説明 (API サーバの再起動、環境変数) は、デスクトップアプリでは出さない */}
                        {isDesktop()
                            ? 'この Mac のキーチェーンに保存します。'
                            : '開発用のブラウザ起動では、API サーバを再起動すると消えます（続けて使うなら、環境変数 ANTHROPIC_API_KEY を設定して起動してください）。'}
                    </p>
                    <div style={{ marginTop: 8 }}>
                        <label htmlFor="guide-daily-limit">1 日に Claude を呼ぶ回数の上限</label>
                        <input id="guide-daily-limit" type="number" min={0} step={1} value={limitInput}
                            placeholder={today?.limit_calls != null ? `いまは ${today.limit_calls} 回` : 'いまは上限なし'}
                            onChange={(e) => setLimitInput(e.target.value)} />
                    </div>
                    <button className="action-btn" style={{ marginTop: 6 }} onClick={handleSaveLimit}>上限を変える</button>
                    <p className="note-text" style={{ marginTop: 6 }}>
                        上限に達すると、その日は Claude を呼ばなくなります（保存済みのガイドは見られます）。空にして押すと上限なし。
                    </p>
                </div>
            )}
            {keyMessage && <p className="note-text" role="status" style={{ marginTop: 6 }}>{keyMessage}</p>}

            {guide && (
                <div style={{ marginTop: 12 }}>
                    <p className="body-text" style={{ marginBottom: 10 }}>{guide.overview}</p>
                    <ol style={{ paddingLeft: 18, margin: 0 }}>
                        {guide.steps.map((step, i) => (
                            <li key={i} style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: 13, fontWeight: 600 }}>
                                    {step.title}
                                    <span className="note-text" style={{ marginLeft: 6, fontWeight: 400 }}>{TOPIC_LABEL[step.topic] ?? step.topic}</span>
                                </div>
                                <p className="body-text" style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{step.body}</p>
                                {step.refs.length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                        {step.refs.map((ref, j) => (
                                            <span key={j} className="guide-ref"
                                                style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-mid)' }}>
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
                            <div style={{ fontSize: 12, fontWeight: 600 }}>注意</div>
                            <ul style={{ paddingLeft: 18, margin: '4px 0' }}>
                                {guide.cautions.map((c, i) => <li key={i} className="body-text">{c}</li>)}
                            </ul>
                        </div>
                    )}

                    {guide.unverified_terms.length > 0 && (
                        <p role="note" style={{ fontSize: 12, color: 'var(--warn)', marginTop: 8, lineHeight: 1.6 }}>
                            解析結果に無い音名・コード名が説明に含まれています: {guide.unverified_terms.join('、')}。
                            この部分は解析ではなく、モデルの推測かもしれません。
                        </p>
                    )}
                    <p className="note-text" style={{ marginTop: 8 }}>
                        作成: {result.model}
                        {result.created_at ? `（${new Date(result.created_at).toLocaleString('ja-JP')}）` : ''}
                    </p>
                    <p id="guide-usage" className="note-text">このガイドを作ったときの使用量: {usageLine(result)}</p>
                </div>
            )}
        </div>
    );
}
