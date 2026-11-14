/**
 * bunri DAW — 再現ガイド（第2層）のパネル。
 * 「学ぶ」タブの「ガイド」の段に出す。カルテを Claude に渡し、「こう作れば再現できる」という手順を表示する。
 * 手順に付いた場所（区間・小節）を押すと、そこへ移動する。
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
import { tip } from '../lib/tooltip';
import { SECTION_LABEL_JA } from '../lib/chart';
import { chartBarToSec } from '../lib/grid';
import {
    GuideRequestError, fetchSavedGuide, formatUsd, refLabel, requestGuide, type GuideResponse, type GuideToday,
} from '../lib/guide';
import { todayLine, usageLine } from '../lib/claude-usage';
import { ClaudeSendNote, ClaudeSettings, UnverifiedTerms } from './ClaudeParts';

/** 手順の主題ごとの見出しラベル。 */
const TOPIC_LABEL: Record<string, string> = {
    grid: 'テンポ・拍',
    key: 'キー',
    chords: 'コード',
    sections: '構成',
    mix: '音作り・ミックス',
    general: '全体',
};

/**
 * 再現ガイドのパネル。カルテが無いときは何も出さない。
 */
export default function GuidePanel() {
    const { chart, chartId, jumpTo, setStatus, openLearn } = useDaw();
    const [focus, setFocus] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<GuideResponse | null>(null);
    const [today, setToday] = useState<GuideToday | null>(null);
    const [error, setError] = useState<GuideRequestError | null>(null);
    const [showKeyForm, setShowKeyForm] = useState(false);

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

    // API キーを設定したら欄を閉じ、上限を変えたら、上限の失敗の表示を消す
    const handleSettingsSaved = useCallback((what: 'key' | 'limit') => {
        if (what === 'key') setShowKeyForm(false);
        setError(null);
    }, []);

    if (!chart || !chartId) {
        return (
            <div id="guide-panel" className="panel-content">
                <h3 style={{ marginBottom: 6 }}>再現ガイド</h3>
                <p className="body-text" style={{ color: 'var(--text-mid)' }}>
                    カルテができると、ここで「こう作れば再現できる」という手順を作れます。先に曲を取り込んでください。
                </p>
                <button className="action-btn" onClick={() => openLearn('song')} {...tip('曲を取り込む場所を開きます')}>曲を取り込む</button>
            </div>
        );
    }
    const guide = result?.guide;

    /** 手順の場所（区間・小節）へ移動する。小節が在れば小節へ、無ければ区間の頭へ。 */
    const jumpToRef = (ref: { bar: number | null; beat: number | null; section_id: string | null }, label: string) => {
        let sec: number | null = null;
        if (ref.bar !== null) sec = chartBarToSec(chart, ref.bar, ref.beat ?? 1);
        else if (ref.section_id !== null) sec = chart.sections.find((s) => s.id === ref.section_id)?.start_sec ?? null;
        if (sec === null) return;
        jumpTo({ sec });
        setStatus(`${label} へ移動しました`);
    };

    return (
        <div id="guide-panel" className="panel-content">
            <h3 style={{ marginBottom: 6 }}>再現ガイド</h3>
            <p className="panel-desc" style={{ marginBottom: 8 }}>
                カルテの内容を「こう作れば再現できる」という手順に言い換えます。
            </p>

            <div>
                <label htmlFor="guide-focus">対象</label>
                <select id="guide-focus" value={focus} onChange={(e) => setFocus(e.target.value)} disabled={busy}
                    {...tip('手順を作る範囲。曲全体か、サビなどの区間を選びます')}>
                    <option value="">曲全体</option>
                    {chart.sections.map((s) => {
                        const raw = s.label ?? s.suggested_label;
                        const name = raw ? (SECTION_LABEL_JA[raw] ?? raw) : `区間 ${s.id}`;
                        return <option key={s.id} value={s.id}>{name}（{s.start_bar}〜{s.end_bar} 小節）</option>;
                    })}
                </select>
            </div>
            <button className="action-btn" onClick={handleGenerate} disabled={busy}
                {...tip(busy ? '手順を作っています' : guide
                    ? 'もう一度 Claude に頼んで、手順を作り直します。そのたびに費用がかかります'
                    : 'カルテを Claude に渡して、似せて作るための手順を書いてもらいます。数十秒かかります')}>
                {busy ? '作成中…（数十秒かかります）' : guide ? 'ガイドを作り直す（費用がかかります）' : 'ガイドを作る'}
            </button>
            {guide && !busy && (
                <p className="note-text" style={{ marginTop: 6 }}>
                    このガイドは保存済みです。開き直しても Claude は呼びません。作り直すと、もう一度 Claude を呼びます
                    {typeof result?.cost_usd === 'number' ? `（前回は概算 ${formatUsd(result.cost_usd)}）` : ''}。
                </p>
            )}
            <ClaudeSendNote open={showKeyForm} onToggle={() => setShowKeyForm((v) => !v)}>
                カルテ（解析結果）を Anthropic の Claude に送ります。音声は送りません。ファイル名も送りません。
            </ClaudeSendNote>
            {today && <p id="guide-today" className="note-text" style={{ marginTop: 4 }}>{todayLine(today)}</p>}

            {error && <p role="alert" className="error-text" style={{ marginTop: 8 }}>{error.message}</p>}

            <ClaudeSettings idPrefix="guide" open={showKeyForm} today={today} onToday={setToday} onSaved={handleSettingsSaved} />

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
                                        {step.refs.map((ref, j) => {
                                            const label = refLabel(ref, chart);
                                            return (
                                                <button type="button" key={j} className="guide-ref" {...tip('この場所へ移動します')}
                                                    onClick={() => jumpToRef(ref, label)}
                                                    style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-mid)', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                                                    {label}
                                                </button>
                                            );
                                        })}
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

                    <UnverifiedTerms terms={guide.unverified_terms} source="解析結果" />
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
