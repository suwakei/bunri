/**
 * bunri DAW — 楽曲カルテパネル（第1層の表示）
 *
 * 解析結果を初心者にも読める形で提示する。設計上の約束:
 * - 確信度は数値ではなく3段階で見せる（0.71 は初心者の判断材料にならない）
 * - 検出できなかった項目は値を出さず理由を示す
 * - セクションのラベルは「提案」として出し、断定しない
 * - 全要素にツールチップを付ける（`Term` を通すことで構造的に強制する）
 */
import { useMemo, type ReactNode } from 'react';
import { useDaw } from '../lib/store';
import GuidePanel from './GuidePanel';
import {
    confidenceTier, formatTime,
    TIER_DISPLAY, SECTION_LABEL_JA, BAND_LABEL_JA,
    type ChartChord, type ConfidenceTier,
} from '../lib/chart';

/**
 * 用語にツールチップを付けるラッパー。
 *
 * 辞書に載っている用語は点線の下線が付き、ホバーでステータスバーに解説が出る。
 * 辞書を Python 側に置いているため、ここでの説明と LLM（第2層）の説明が
 * 食い違わない。
 *
 * @param term - 用語キー（バックエンドの GLOSSARY のキー）
 * @param children - 表示する内容
 */
function Term({ term, children }: { term: string; children: ReactNode }) {
    const { glossary, setHint } = useDaw();
    const text = glossary[term]?.ja;

    if (!text) return <>{children}</>;
    return (
        <span
            onMouseEnter={() => setHint(text)}
            onMouseLeave={() => setHint('')}
            style={{ borderBottom: '1px dotted var(--text-dim)', cursor: 'help' }}
        >
            {children}
        </span>
    );
}

/**
 * 確信度を3段階のバッジで表示する。
 * @param value - 確信度の生値（0.0〜1.0）
 */
function ConfidenceBadge({ value }: { value: number | null }) {
    const { glossary, setHint } = useDaw();
    const tier: ConfidenceTier = confidenceTier(value);
    const display = TIER_DISPLAY[tier];

    return (
        <span
            onMouseEnter={() => setHint(glossary['confidence']?.ja ?? '')}
            onMouseLeave={() => setHint('')}
            style={{
                fontSize: 11, padding: '1px 6px', borderRadius: 8, marginLeft: 6,
                border: `1px solid ${display.color}`, color: display.color,
                fontWeight: 600, cursor: 'help', whiteSpace: 'nowrap',
            }}
        >
            {display.label}
        </span>
    );
}

/**
 * 検出できなかった項目の理由を表示する。
 * 値を出さない代わりに、なぜ出せないのかを必ず伝える。
 * @param reason - バックエンドが返した理由。undefined なら何も描画しない
 */
function Unavailable({ reason }: { reason?: string }) {
    if (!reason) return null;
    return (
        <div style={{
            fontSize: 12, lineHeight: 1.6, color: 'var(--text-mid)', padding: '6px 8px',
            background: 'var(--bg-deep)', borderRadius: 'var(--radius-sm)',
            borderLeft: '2px solid var(--warn)',
        }}>
            {reason}
        </div>
    );
}

/** カルテ内の見出し付きセクション */
function Block({ title, term, badge, children }: {
    title: string; term?: string; badge?: ReactNode; children: ReactNode;
}) {
    return (
        <div style={{ marginBottom: 16 }}>
            <h3 style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                {term ? <Term term={term}>{title}</Term> : title}
                {badge}
            </h3>
            {children}
        </div>
    );
}

/** 数値の行（ラベル + 値）。ラベルには必ずツールチップが付く */
function Row({ term, label, children }: { term: string; label: string; children: ReactNode }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
            <span style={{ color: 'var(--text-mid)' }}><Term term={term}>{label}</Term></span>
            <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{children}</span>
        </div>
    );
}

/**
 * 楽曲カルテパネル。
 * 解析済みのカルテが無い場合は、ファイルタブへ誘導する案内を出す。
 * 文字の大きさは、本文 12px・補足 11px を下限にする（docs/ui-terms.md）。
 */
export default function ChartPanel() {
    const { chart, setShowGridEditor, setHint } = useDaw();

    // 小節ごとに最も長いコードを代表として選ぶ（1小節に複数コードがある場合の要約）
    const chordsByBar = useMemo(() => {
        if (!chart) return [];
        const byBar = new Map<number, ChartChord>();
        for (const chord of chart.chords) {
            const current = byBar.get(chord.bar);
            if (!current || chord.beat_count > current.beat_count) byBar.set(chord.bar, chord);
        }
        return [...byBar.entries()].sort((a, b) => a[0] - b[0]).map(([bar, chord]) => ({ bar, chord }));
    }, [chart]);

    if (!chart) {
        return (
            <div id="chart-panel" className="panel-content">
                <h3>楽曲カルテ</h3>
                <p className="panel-desc">
                    取り込んだ原曲を解析して、キー・コード進行・構成・ミックスの特性を表示します。
                    「自分の力で再現する」ための材料です。
                </p>
                <div style={{
                    fontSize: 12, lineHeight: 1.7, color: 'var(--text-mid)', padding: 12,
                    background: 'var(--bg-deep)', borderRadius: 'var(--radius-sm)',
                    border: '1px dashed var(--border-light)', textAlign: 'center',
                }}>
                    まだ解析していません。<br />
                    <strong style={{ color: 'var(--accent)' }}>ファイル</strong>タブで原曲を取り込んでください。
                </div>
            </div>
        );
    }

    const { grid, key, sections, mix, unavailable } = chart;
    const perBar = grid.time_signature[0];

    return (
        <div id="chart-panel" className="panel-content">
            <h3>楽曲カルテ</h3>
            <p className="panel-desc" style={{ marginBottom: 12 }}>
                {chart.source.filename}（{formatTime(chart.source.duration_sec)}）
            </p>

            {/* ---- グリッド ---- */}
            <Block title="グリッド" term="bpm" badge={<ConfidenceBadge value={grid.bpm_confidence} />}>
                <Row term="bpm" label="BPM">{grid.bpm.toFixed(1)}</Row>
                <Row term="time_signature" label="拍子">{grid.time_signature[0]}/{grid.time_signature[1]}</Row>
                <Row term="downbeat_offset" label="1拍目">{grid.downbeat_offset_sec.toFixed(3)} 秒</Row>
                <Row term="beat" label="検出した拍数">{grid.beat_times_sec.length}</Row>
                <Unavailable reason={unavailable['grid']} />
                <button
                    className="action-btn"
                    style={{ marginTop: 8 }}
                    onClick={() => setShowGridEditor(true)}
                    onMouseEnter={() => setHint('波形とグリッド線を見比べて、BPMや小節頭のずれを直します。ここがずれていると他の解析も全部ずれます')}
                    onMouseLeave={() => setHint('')}
                >
                    グリッドを確認・補正する
                </button>
                {!grid.user_confirmed && (
                    <div className="note-text" style={{ color: 'var(--text-mid)', marginTop: 6 }}>
                        グリッドは自動検出のままです。<strong style={{ color: 'var(--accent)' }}>ここがずれていると
                        コードも構成も全部ずれます</strong>。波形を見て確認することをおすすめします。
                    </div>
                )}
            </Block>

            {/* ---- キー ---- */}
            <Block title="キー" term="key" badge={key.tonic ? <ConfidenceBadge value={key.confidence} /> : undefined}>
                {key.tonic ? (
                    <>
                        <div style={{ fontSize: 20, color: 'var(--accent)', fontWeight: 600, marginBottom: 4 }}>
                            {key.tonic} <Term term={key.mode ?? 'major'}>{key.mode === 'minor' ? 'マイナー' : 'メジャー'}</Term>
                        </div>
                        {key.alternatives.length > 0 && (
                            <div className="note-text">
                                他の可能性: {key.alternatives.map(a =>
                                    `${a.tonic} ${a.mode === 'minor' ? 'マイナー' : 'メジャー'}`).join(' / ')}
                            </div>
                        )}
                    </>
                ) : <Unavailable reason={unavailable['key']} />}
            </Block>

            {/* ---- コード進行 ---- */}
            <Block title="コード進行" term="chord">
                {chordsByBar.length > 0 ? (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(perBar, 4)}, 1fr)`, gap: 4 }}>
                            {chordsByBar.map(({ bar, chord }) => (
                                <div key={bar}
                                    onMouseEnter={() => setHint(
                                        `${bar}小節目: ${chord.symbol}` +
                                        (chord.degree ? `（キーに対して ${chord.degree}）` : '') +
                                        ` — ${TIER_DISPLAY[confidenceTier(chord.confidence)].label}`
                                    )}
                                    onMouseLeave={() => setHint('')}
                                    style={{
                                        padding: '5px 4px', borderRadius: 'var(--radius-sm)',
                                        background: 'var(--bg-deep)', textAlign: 'center', cursor: 'help',
                                        borderLeft: `2px solid ${TIER_DISPLAY[confidenceTier(chord.confidence)].color}`,
                                    }}>
                                    <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{bar}</div>
                                    <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{chord.symbol}</div>
                                    {chord.degree && (
                                        <div style={{ fontSize: 11, color: 'var(--secondary)' }}>
                                            <Term term="degree">{chord.degree}</Term>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                        <div className="note-text" style={{ marginTop: 6 }}>
                            上の数字は小節番号。コード名の下の青緑の文字は <Term term="degree">ディグリー</Term>（キーから見た度数）で、
                            キーが変わっても同じ進行なら同じ番号になります。
                        </div>
                    </>
                ) : <Unavailable reason={unavailable['chords']} />}
            </Block>

            {/* ---- 構成 ---- */}
            <Block title="構成" term="section">
                {sections.length > 0 ? (
                    <>
                        {sections.map(section => (
                            <div key={section.id}
                                onMouseEnter={() => setHint(
                                    `${section.start_bar}〜${section.end_bar}小節（${formatTime(section.start_sec)}〜${formatTime(section.end_sec)}）` +
                                    `／繰り返しグループ ${section.repeat_group}`
                                )}
                                onMouseLeave={() => setHint('')}
                                style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    fontSize: 12, padding: '5px 8px', marginBottom: 3, cursor: 'help',
                                    background: 'var(--bg-deep)', borderRadius: 'var(--radius-sm)',
                                    borderLeft: '3px solid var(--secondary)',
                                }}>
                                <span style={{ color: 'var(--text)' }}>
                                    {section.start_bar}–{section.end_bar} 小節
                                    <span style={{ color: 'var(--text-dim)', marginLeft: 6, fontSize: 11 }}>
                                        <Term term="repeat_group">{section.repeat_group}</Term>
                                    </span>
                                </span>
                                <span style={{ color: 'var(--text-mid)', fontSize: 11 }}>
                                    {section.suggested_label
                                        ? `${SECTION_LABEL_JA[section.suggested_label] ?? section.suggested_label}？`
                                        : '—'}
                                </span>
                            </div>
                        ))}
                        <div className="note-text" style={{ marginTop: 6 }}>
                            「イントロ？」のような名前は<strong>自動推定の提案</strong>で、確定ではありません。
                            区間の切れ目そのものは音の変化から検出したものです。
                        </div>
                    </>
                ) : <Unavailable reason={unavailable['sections']} />}
            </Block>

            {/* ---- ミックス ---- */}
            <Block title="ミックス" term="loudness_lufs">
                {mix.loudness_lufs !== null ? (
                    <>
                        <Row term="loudness_lufs" label="ラウドネス">{mix.loudness_lufs.toFixed(1)} LUFS</Row>
                        {mix.peak_dbfs !== null && <Row term="peak_dbfs" label="ピーク">{mix.peak_dbfs.toFixed(1)} dBFS</Row>}
                        {mix.dynamic_range_db !== null && (
                            <Row term="dynamic_range_db" label="音量の幅">{mix.dynamic_range_db.toFixed(1)} dB</Row>
                        )}
                        {mix.stereo_width !== null && (
                            <Row term="stereo_width" label="ステレオ幅">{(mix.stereo_width * 100).toFixed(0)}%</Row>
                        )}
                        {mix.bass_mono !== null && (
                            <Row term="bass_mono" label="低音の定位">{mix.bass_mono ? '中央（モノラル）' : '左右に広がる'}</Row>
                        )}
                        {mix.reverb_tail_sec !== null && (
                            <Row term="reverb_tail_sec" label="残響の長さ">{mix.reverb_tail_sec.toFixed(2)} 秒</Row>
                        )}
                        {mix.spectrum_bands.length > 0 && <SpectrumBars bands={mix.spectrum_bands} />}
                    </>
                ) : <Unavailable reason={unavailable['mix']} />}
            </Block>

            {/* ---- 再現ガイド（第2層） ---- */}
            <GuidePanel />
        </div>
    );
}

/**
 * 帯域エネルギーを横棒で表示する。
 * 最大値を100%として相対的に描くため、絶対値ではなく傾向を読むためのもの。
 * @param bands - 帯域ごとのエネルギー
 */
function SpectrumBars({ bands }: { bands: { name: string; hz: [number, number]; energy_db: number }[] }) {
    const { setHint } = useDaw();
    const values = bands.map(b => b.energy_db);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = Math.max(1, max - min);

    return (
        <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--text-mid)', marginBottom: 4 }}>
                <Term term="spectrum_bands">帯域バランス</Term>
            </div>
            {bands.map(band => (
                <div key={band.name}
                    onMouseEnter={() => setHint(`${band.hz[0]}〜${band.hz[1]}Hz: ${band.energy_db.toFixed(1)} dB`)}
                    onMouseLeave={() => setHint('')}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, cursor: 'help' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', width: 48, textAlign: 'right' }}>
                        {BAND_LABEL_JA[band.name] ?? band.name}
                    </span>
                    <div style={{ flex: 1, height: 8, background: 'var(--bg-deep)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                            width: `${((band.energy_db - min) / span) * 100}%`,
                            height: '100%', background: 'var(--accent)',
                        }} />
                    </div>
                </div>
            ))}
        </div>
    );
}
