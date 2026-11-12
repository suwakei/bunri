/**
 * bunri DAW — グリッド補正モーダル（波形＋ビートグリッド）
 *
 * カルテ全体の信頼性を支える要。BPM が倍/半分に検出されたり小節頭がずれると、
 * コードもセクションも全部ずれるが、初心者はそれが間違いだと気づけない。
 *
 * 数値入力だけにしないのは、初心者が 128 と 64 のどちらが正しいかを数字から
 * 判断できないため。波形のアタックとグリッド線が揃っているかは目で見れば分かる。
 *
 * 曲全体を一画面に描くと拍が数ピクセル間隔になって照合できないので、
 * 数秒の窓に拡大して見せる。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaw } from '../lib/store';
import { apiFetch, errorDetail } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { cssVar } from '../lib/theme';
import { formatTime, type ChartResponse } from '../lib/chart';

/** 表示する窓の長さの選択肢（秒） */
const WINDOW_OPTIONS = [4, 8, 16];

/** 拍子の選択肢。自動検出せずユーザーに選ばせる */
const TIME_SIGNATURES = [
    { beats: 4, label: '4/4（ほとんどの曲）' },
    { beats: 3, label: '3/4（ワルツ）' },
    { beats: 6, label: '6/8' },
    { beats: 5, label: '5/4' },
];

/**
 * グリッド補正モーダル。
 * BPM・小節頭・拍子を波形と見比べながら直し、カルテを再計算する。
 * Esc キー・外側のクリック・「キャンセル」で閉じる（再計算の途中は閉じない）。
 */
export default function GridEditor() {
    const {
        chart, chartId, chartPeaks, showGridEditor, setShowGridEditor,
        setChartResult, setStatus, applyChartGrid, withProgress,
    } = useDaw();

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ x: number; offset: number } | null>(null);

    const [localBpm, setLocalBpm] = useState(120);
    const [localOffset, setLocalOffset] = useState(0);
    const [localBeats, setLocalBeats] = useState(4);
    const [viewStart, setViewStart] = useState(0);
    const [windowSec, setWindowSec] = useState(8);
    const [applying, setApplying] = useState(false);

    // モーダルを開くたびに現在のカルテの値へ初期化する
    useEffect(() => {
        if (!showGridEditor || !chart) return;
        setLocalBpm(chart.grid.bpm);
        setLocalOffset(chart.grid.downbeat_offset_sec);
        setLocalBeats(chart.grid.time_signature[0]);
        setViewStart(Math.max(0, chart.grid.downbeat_offset_sec - 0.5));
    }, [showGridEditor, chart]);

    const duration = chart?.source.duration_sec ?? 0;

    /** 波形とグリッド線を描画する */
    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !chartPeaks) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const mid = height / 2;
        const viewEnd = viewStart + windowSec;

        // 色は CSS のトークンから読む (canvas は var(--…) を解釈できない)
        const accent = cssVar('--accent', '#d4a44c');
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = cssVar('--bg-deep', '#0c0c0f');
        ctx.fillRect(0, 0, width, height);

        // ---- 波形 ----
        const total = chartPeaks.points;
        const peakDuration = chartPeaks.duration_sec || duration || 1;
        ctx.strokeStyle = cssVar('--text-dim', '#908c85');
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
            const t0 = viewStart + (x / width) * windowSec;
            const t1 = viewStart + ((x + 1) / width) * windowSec;
            const i0 = Math.max(0, Math.floor((t0 / peakDuration) * total));
            const i1 = Math.min(total - 1, Math.ceil((t1 / peakDuration) * total));
            if (i0 > i1 || i0 >= total) continue;

            let lo = 0;
            let hi = 0;
            for (let i = i0; i <= i1; i++) {
                lo = Math.min(lo, chartPeaks.min[i] ?? 0);
                hi = Math.max(hi, chartPeaks.max[i] ?? 0);
            }
            ctx.moveTo(x + 0.5, mid - hi * mid * 0.95);
            ctx.lineTo(x + 0.5, mid - lo * mid * 0.95);
        }
        ctx.stroke();

        // ---- グリッド線 ----
        // 補正中の BPM とオフセットから等間隔で引く。実測列ではなく
        // 「いま設定しようとしているグリッド」を見せるのが目的
        const interval = 60 / Math.max(1, localBpm);
        const perBar = Math.max(1, localBeats);
        let index = Math.floor((viewStart - localOffset) / interval) - 1;

        for (;;) {
            const time = localOffset + index * interval;
            if (time > viewEnd) break;
            if (time >= viewStart && index >= 0) {
                const x = ((time - viewStart) / windowSec) * width;
                const isBarHead = index % perBar === 0;
                ctx.strokeStyle = isBarHead ? accent : cssVar('--accent-glow', 'rgba(212, 164, 76, 0.25)');
                ctx.lineWidth = isBarHead ? 2 : 1;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                ctx.stroke();

                if (isBarHead) {
                    ctx.fillStyle = accent;
                    ctx.font = '11px system-ui, sans-serif';
                    ctx.fillText(String(index / perBar + 1), x + 3, 12);
                }
            }
            index++;
        }
    }, [chartPeaks, viewStart, windowSec, localBpm, localOffset, localBeats, duration]);

    useEffect(() => { draw(); }, [draw]);

    // ---- キャンバス上の横ドラッグで小節頭をずらす ----
    const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
        dragRef.current = { x: e.clientX, offset: localOffset };
    };

    useEffect(() => {
        if (!showGridEditor) return;

        const onMove = (e: MouseEvent) => {
            const drag = dragRef.current;
            const canvas = canvasRef.current;
            if (!drag || !canvas) return;
            const secondsPerPixel = windowSec / canvas.width;
            setLocalOffset(Math.max(0, drag.offset + (e.clientX - drag.x) * secondsPerPixel));
        };
        const onUp = () => { dragRef.current = null; };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [showGridEditor, windowSec]);

    const handleApply = useCallback(async () => {
        if (!chartId) return;
        setApplying(true);
        await withProgress('補正したグリッドでカルテを再計算しています…', async () => {
            const body = new FormData();
            body.append('chart_id', chartId);
            body.append('bpm', String(localBpm));
            body.append('downbeat_offset', String(localOffset));
            body.append('beats_per_bar', String(localBeats));

            const resp = await apiFetch('/api/chart/regrid', { method: 'POST', body });
            // 応答の本文をそのまま出すと、生の JSON が画面に出る。理由の文は errorDetail が作る
            if (!resp.ok) throw new Error('グリッドを確定できませんでした。' + await errorDetail(resp));

            const result: ChartResponse = await resp.json();
            setChartResult(result);
            // DAW 本体のテンポ・拍子・1 小節目の位置もカルテに合わせる (カルテとピアノロールの小節番号をそろえる)。
            // パートに分けた後は合わせない。お手本は分けたときのグリッドに載っているので、変えると原曲とずれる
            const applied = applyChartGrid(result.chart);
            setStatus(applied
                ? `グリッドを確定しました（BPM ${result.chart.grid.bpm.toFixed(1)}）`
                : `グリッドを確定しました（BPM ${result.chart.grid.bpm.toFixed(1)}）。お手本は直す前のグリッドで採譜したものなので、ピアノロールのテンポと小節の位置はそのままにしました。合わせるには、もう一度パートに分けてください`);
            setShowGridEditor(false);
        });
        setApplying(false);
    }, [chartId, localBpm, localOffset, localBeats, withProgress,
        setChartResult, applyChartGrid, setStatus, setShowGridEditor]);

    const open = showGridEditor && chart !== null;
    // 再計算の途中は閉じない (閉じると、結果がどうなったか分からなくなる)
    const close = useCallback(() => { if (!applying) setShowGridEditor(false); }, [applying, setShowGridEditor]);
    useDialog(dialogRef, open, close);

    if (!open) return null;

    const maxViewStart = Math.max(0, duration - windowSec);

    return (
        <div
            onClick={close}
            style={{
                position: 'fixed', inset: 0, zIndex: 200,
                background: 'rgba(0, 0, 0, 0.72)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
        >
            <div
                ref={dialogRef}
                id="grid-editor"
                className="panel-content"
                role="dialog" aria-modal="true" aria-labelledby="grid-editor-title" tabIndex={-1}
                onClick={e => e.stopPropagation()}
                style={{
                    width: 'min(900px, 94vw)', maxHeight: '90vh', overflow: 'auto',
                    background: 'var(--bg-panel)', border: '1px solid var(--border-light)',
                    borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', padding: 20,
                }}
            >
                <h3 id="grid-editor-title" style={{ marginTop: 0, marginBottom: 4 }}>グリッドの確認・補正</h3>
                <p className="body-text" style={{ color: 'var(--text-mid)', marginBottom: 12 }}>
                    <strong style={{ color: 'var(--text)' }}>音の始まり（波形が立ち上がるところ）に縦線が重なっていれば、合っています。</strong>
                    ずれていたら、下のボタンで直してください。
                    ここがずれているとコードも構成も全部ずれます。
                </p>

                <canvas
                    ref={canvasRef}
                    width={860}
                    height={180}
                    onMouseDown={handleMouseDown}
                    style={{
                        width: '100%', height: 180, cursor: 'ew-resize', display: 'block',
                        borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                    }}
                />
                <div className="note-text" style={{ margin: '4px 0 12px' }}>
                    波形の上を左右にドラッグすると、小節の先頭（太い線）を動かせます。
                </div>

                {/* ---- 表示位置と拡大率 ---- */}
                <div className="param-row">
                    <div style={{ flex: 2 }}>
                        <label htmlFor="grid-view-start">表示位置 — {formatTime(viewStart)} / {formatTime(duration)}</label>
                        <input id="grid-view-start" type="range" min={0} max={maxViewStart} step={0.05}
                            value={Math.min(viewStart, maxViewStart)}
                            onChange={e => setViewStart(+e.target.value)} />
                    </div>
                    <div>
                        <label htmlFor="grid-window">表示範囲</label>
                        <select id="grid-window" value={windowSec} onChange={e => setWindowSec(+e.target.value)}>
                            {WINDOW_OPTIONS.map(sec => <option key={sec} value={sec}>{sec} 秒</option>)}
                        </select>
                    </div>
                </div>

                {/* ---- BPM ---- */}
                <label htmlFor="grid-bpm">BPM</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
                    <button type="button" onClick={() => setLocalBpm(v => Math.max(20, v / 2))}
                        style={secondaryButton}>÷2（遅く）</button>
                    <input id="grid-bpm" type="number" step="0.1" value={localBpm.toFixed(1)}
                        onChange={e => setLocalBpm(Math.max(20, +e.target.value || 120))}
                        style={{ flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 600 }} />
                    <button type="button" onClick={() => setLocalBpm(v => Math.min(400, v * 2))}
                        style={secondaryButton}>×2（速く）</button>
                </div>
                <div className="note-text" style={{ marginBottom: 12 }}>
                    線が音の2回に1回しか来ていなければ <strong>×2</strong>、
                    音が鳴っていないところにも線が来ていれば <strong>÷2</strong> です。
                </div>

                {/* ---- 小節頭と拍子 ---- */}
                <div className="param-row">
                    <div>
                        <label htmlFor="grid-offset">小節の先頭（秒）</label>
                        <div style={{ display: 'flex', gap: 4 }}>
                            <button type="button" onClick={() => setLocalOffset(v => Math.max(0, v - 60 / localBpm))}
                                style={secondaryButton}>◀ 1拍</button>
                            <input id="grid-offset" type="number" step="0.001" value={localOffset.toFixed(3)}
                                onChange={e => setLocalOffset(Math.max(0, +e.target.value || 0))}
                                style={{ flex: 1, textAlign: 'center' }} />
                            <button type="button" onClick={() => setLocalOffset(v => v + 60 / localBpm)}
                                style={secondaryButton}>1拍 ▶</button>
                        </div>
                    </div>
                    <div>
                        <label htmlFor="grid-beats">拍子</label>
                        <select id="grid-beats" value={localBeats} onChange={e => setLocalBeats(+e.target.value)}>
                            {TIME_SIGNATURES.map(ts => (
                                <option key={ts.beats} value={ts.beats}>{ts.label}</option>
                            ))}
                        </select>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                    <button className="action-btn" data-autofocus style={{ flex: 2, marginTop: 0 }} disabled={applying} onClick={handleApply}>
                        {applying ? '再計算中…' : 'この設定で確定して再計算'}
                    </button>
                    <button type="button" style={{ ...secondaryButton, flex: 1 }} disabled={applying}
                        onClick={close}>
                        キャンセル
                    </button>
                </div>
                <div className="note-text" style={{ marginTop: 8 }}>
                    確定すると、この設定でコード進行と構成を検出し直します。
                </div>
            </div>
        </div>
    );
}

/** モーダル内の副次ボタンのスタイル */
const secondaryButton: React.CSSProperties = {
    padding: '6px 10px',
    background: 'transparent',
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
};
