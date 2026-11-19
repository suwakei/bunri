/**
 * bunri DAW — 練習の地図（曲のどこを比べ終えていて、どこが手つかずか）。
 *
 * 「学ぶ」→「差分」の段のいちばん上（差分チェックのパネルの上）に出す。行はお手本を持つパート、列は構成の区間（カルテに構成が無ければ 4 小節ごと）。
 * 升には、その区間の一致率を出す（まだ比べていなければ空の升）。升を押すと、そのパートの練習画面を、その区間の
 * 区間ループで開く（「このパートを練習する」と同じ処理。lib/learn.ts の `practicePart`）。
 *
 * ```
 * 練習の地図
 *          Aメロ？  サビ？  Aメロ？  サビ？
 * ボーカル   –      [   ]   –      [   ]
 * ベース    [72%]   [40%]  [   ]   [   ]
 *                   途中
 * ```
 *
 * 集計は lib/practice-map.ts（学習の記録から、小節ごとに、いちばん新しい記録の結果を採る）。LLM は使わない。
 * 色だけに頼らない（数字・「途中」のしるし・下の線の長さ・凡例・読み上げの名前）。
 * 升は表の形（`role="grid"`）で、Tab で入り、矢印キーで升を辿り、Enter か Space で押す。
 * 見た目だけの状態（どの升にフォーカスが在るか）は、プロジェクトに入れない（保存していない変更にしない）。
 */
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { stepsPerBar } from '../lib/grid';
import { practiceTrackOf, useLearnActions } from '../lib/learn';
import {
    LEVEL_HIGH, LEVEL_MID, barsText, cellLabel, cellText, hasAttempts, lastReferenceBar, mapRow, mapSections,
    referenceBarCounts, sectionLoop, type CellProgress, type MapSection,
} from '../lib/practice-map';
import { MAX_LOOP_BARS } from '../lib/practice';
import { tip } from '../lib/tooltip';
import { BUSY_REASON, blockedBy } from '../lib/notice';

/** 升の説明（マウスを載せたとき）。状態と、押すと何が起きるか。 */
function cellTip(label: string, section: MapSection, cell: CellProgress): string {
    if (cell.state === 'empty') return label;
    const { clamped } = sectionLoop(section);
    return `${label}\n押すと、この区間をくり返し練習できる練習画面を開きます`
        + (clamped ? `（区間ループは ${MAX_LOOP_BARS} 小節までなので、はじめの ${MAX_LOOP_BARS} 小節）` : '');
}

/** 升の見方（色だけに頼らないための凡例）。 */
function MapLegend() {
    return (
        <ul className="practice-map-legend" aria-label="升の見方">
            <li><span className="pm-swatch" data-state="done" data-level="high" aria-hidden="true" />{LEVEL_HIGH}% 以上</li>
            <li><span className="pm-swatch" data-state="done" data-level="mid" aria-hidden="true" />{LEVEL_MID}〜{LEVEL_HIGH - 1}%</li>
            <li><span className="pm-swatch" data-state="done" data-level="low" aria-hidden="true" />{LEVEL_MID}% 未満</li>
            <li><span className="pm-swatch" data-state="partial" aria-hidden="true" />途中（区間の一部だけ比べた）</li>
            <li><span className="pm-swatch" data-state="untouched" aria-hidden="true" />まだ比べていない</li>
            <li><span className="pm-swatch" data-state="empty" aria-hidden="true">–</span>お手本のノートが無い</li>
        </ul>
    );
}

/**
 * 練習の地図。お手本を持つトラックが無ければ、何も出さない（差分の段が、パートに分ける案内を出す）。
 */
export default function PracticeMap() {
    const { learnHistory, chart, bpm, beatsPerBar, gridOffset, trackVersion, showProgress, setStatus } = useDaw();
    const { practicePart } = useLearnActions();
    const tableRef = useRef<HTMLTableElement | null>(null);
    // フォーカスを受ける升 (表の中で 1 つだけが Tab の順に入る。矢印キーで動かす)
    const [active, setActive] = useState({ row: 0, col: 0 });
    const grid = useMemo(() => ({ bpm, beatsPerBar, offsetSec: gridOffset }), [bpm, beatsPerBar, gridOffset]);
    void trackVersion;

    // お手本を持つトラックなら、パートの種類に関わらず行に出す
    const parts = engine.tracks.filter((t) => (t.referenceNotes?.length ?? 0) > 0);
    if (parts.length === 0) return null;

    const per = stepsPerBar(grid);
    const lastBar = Math.max(...parts.map((p) => lastReferenceBar(referenceBarCounts(p.referenceNotes!, per))));
    const sections = mapSections(chart, grid, lastBar);
    // 行の組は「そのパートがお手本、その練習のトラックが打ち込み」。練習のトラックがまだ無ければ、どの升も空
    const pairs = parts.map((p) => ({ referenceId: p.id, attemptId: practiceTrackOf(p.id)?.id ?? null }));
    const rows = parts.map((p, i) => mapRow(learnHistory, pairs[i], p.referenceNotes!, per, sections));
    const empty = !hasAttempts(learnHistory, pairs);
    const rowAt = Math.min(active.row, parts.length - 1), colAt = Math.min(active.col, Math.max(0, sections.length - 1));

    const focusCell = (row: number, col: number) => {
        setActive({ row, col });
        tableRef.current?.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-col="${col}"]`)?.focus();
    };
    const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, row: number, col: number) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const lastRow = parts.length - 1, lastCol = sections.length - 1;
        let next: [number, number] | null = null;
        if (e.key === 'ArrowRight') next = [row, Math.min(lastCol, col + 1)];
        else if (e.key === 'ArrowLeft') next = [row, Math.max(0, col - 1)];
        else if (e.key === 'ArrowDown') next = [Math.min(lastRow, row + 1), col];
        else if (e.key === 'ArrowUp') next = [Math.max(0, row - 1), col];
        else if (e.key === 'Home') next = [row, 0];
        else if (e.key === 'End') next = [row, lastCol];
        if (!next) return;
        e.preventDefault();
        focusCell(next[0], next[1]);
    };
    const open = (row: number, col: number) => {
        const part = parts[row], section = sections[col], cell = rows[row][col];
        setActive({ row, col });
        if (cell.state === 'empty') {
            setStatus(`「${part.name}」の${section.fromChart ? `「${section.name}」（${barsText(section)}）` : barsText(section)}には、お手本のノートがありません`, 'hint');
            return;
        }
        practicePart(part.id, { loop: sectionLoop(section).loop, where: section.fromChart ? section.name : undefined });
    };

    return (
        <section id="practice-map" className="panel-content practice-map" aria-labelledby="practice-map-title">
            <h3 id="practice-map-title">練習の地図</h3>
            <p className="note-text" id="practice-map-desc">
                {empty
                    ? 'お手本と比べると、ここに曲全体の進み具合が出ます。升を押すと、その区間の練習を始められます。'
                    : 'パートと区間ごとの一致率です（いちばん新しく比べた結果）。升を押すと、その区間の練習画面を開きます。'}
            </p>
            {sections.length > 0 && (
                <div className="practice-map-scroll">
                    <table ref={tableRef} role="grid" aria-labelledby="practice-map-title" aria-describedby="practice-map-desc">
                        <thead>
                            <tr>
                                <th scope="col" className="pm-corner"><span className="visually-hidden">パート</span></th>
                                {sections.map((s) => (
                                    <th key={s.id} scope="col" className="pm-col" {...tip(s.fromChart ? `${s.name}（${barsText(s)}）` : barsText(s))}>
                                        <span className="pm-col-name">{s.name}</span>
                                        {s.fromChart && <span className="pm-col-bars">{s.startBar === s.endBar ? s.startBar : `${s.startBar}–${s.endBar}`}</span>}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {parts.map((part, r) => (
                                <tr key={part.id} data-part={part.part}>
                                    <th scope="row" className="pm-row" {...tip(part.name, { overflow: true })}>{part.name}</th>
                                    {rows[r].map((cell, c) => {
                                        const label = cellLabel(part.name, sections[c], cell);
                                        return (
                                            <td key={sections[c].id} role="gridcell">
                                                <button type="button" className="pm-cell" data-row={r} data-col={c}
                                                    data-state={cell.state} data-level={cell.level ?? undefined}
                                                    data-estimated={cell.estimated ? '' : undefined}
                                                    tabIndex={r === rowAt && c === colAt ? 0 : -1}
                                                    aria-label={label} aria-disabled={cell.state === 'empty' || showProgress ? true : undefined}
                                                    {...tip(cellTip(label, sections[c], cell))}
                                                    {...(showProgress ? blockedBy(BUSY_REASON) : cell.state === 'empty' ? { 'data-blocked': '' } : {})}
                                                    onFocus={() => setActive({ row: r, col: c })}
                                                    onKeyDown={(e) => onKeyDown(e, r, c)}
                                                    onClick={() => {
                                                        // キーで押したときも、黙って何もしないままにしない (マウスなら、押した時点で同じ文が出ている)
                                                        if (showProgress) setStatus(BUSY_REASON, 'hint'); else open(r, c);
                                                    }}>
                                                    <span className="pm-value">{cellText(cell)}</span>
                                                    {cell.state === 'partial' && <span className="pm-mark">途中</span>}
                                                    {cell.percent !== null && (
                                                        <span className="pm-meter" aria-hidden="true"><span style={{ width: `${cell.percent}%` }} /></span>
                                                    )}
                                                </button>
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <MapLegend />
        </section>
    );
}
