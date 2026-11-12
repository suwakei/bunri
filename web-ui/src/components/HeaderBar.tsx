/**
 * bunri DAW — ヘッダーバー（トランスポート + アクションボタン）
 */
import { useCallback, useState, useEffect } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { describeError } from '../lib/api';
import { UNTITLED, useProjectActions, useProjectWiring } from '../lib/project-actions';
import PopupMenu, { type MenuRequest } from './PopupMenu';
import { historyShortcut, isDialogOpen, isKeyboardFocusedControl, isTypingTarget, modKeyLabel } from '../lib/keys';
import { notesToMidi } from '../lib/midi';

/**
 * 再生時間（秒）を `M:SS.d` 形式の文字列に変換する。
 *
 * @param t - 変換する時間（秒、0 以上の実数）
 * @returns `"分:秒.1桁"` 形式の時刻文字列（例: `"1:03.5"`）
 */
function formatTime(t: number): string {
    const min = Math.floor(t / 60);
    const sec = (t % 60).toFixed(1);
    return `${min}:${sec.padStart(4, '0')}`;
}

/**
 * エンジンの現在再生位置を 100ms 間隔でポーリングし、
 * `M:SS.d` 形式でリアルタイム表示するコンポーネント。
 *
 * @returns 現在再生時刻を示す `<span id="time-display">` 要素
 */
function TimeDisplay() {
    const [time, setTime] = useState('0:00.0');
    useEffect(() => {
        const interval = setInterval(() => {
            setTime(formatTime(engine.getCurrentTime()));
        }, 100);
        return () => clearInterval(interval);
    }, []);
    return <span id="time-display">{time}</span>;
}

/**
 * ヘッダーバーコンポーネント。
 * トランスポートコントロール（BPM・拍子・再生/停止/録音/メトロノーム）と、
 * 元に戻す・やり直す、プロジェクト操作ボタン（保存・読み込む・WAV 書き出し・MIDI 書き出し）を提供する。
 * Space キーで、再生と一時停止を切り替えられる。Cmd+Z / Cmd+Shift+Z（Ctrl でも）で元に戻す・やり直す。
 *
 * @returns ヘッダー全体の `<div id="header">` 要素
 */
export default function HeaderBar() {
    const {
        bpm, setBpm, beatsPerBar, setBeatsPerBar,
        isPlaying, setIsPlaying, setStatus,
        metronomeEnabled, setMetronomeEnabled,
        withProgress, showProgress, bumpTracks, pianoRollRef,
        setHint,
        canUndo, canRedo, undoLabel, redoLabel, undo, redo, recordAsync, project, isDirty,
    } = useDaw();

    // Cmd+Z (Ctrl+Z) で元に戻す、Cmd+Shift+Z (Ctrl+Shift+Z, Ctrl+Y) でやり直す。
    // 文字を打ち込む欄の中では受けない (欄の中の Cmd+Z は、打った文字を元に戻す。ブラウザと、
    // デスクトップアプリの「編集」メニューに任せる)。案内などの窓が開いているあいだも受けない
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const action = historyShortcut(e);
            if (!action || isTypingTarget(e.target) || isDialogOpen()) return;
            e.preventDefault();
            if (action === 'undo') undo(); else redo();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [undo, redo]);

    const handlePlay = useCallback(() => {
        engine.init();
        if (engine.isPlaying) {
            engine.pause();
            setIsPlaying(false);
            setStatus('一時停止');
        } else {
            const pr = pianoRollRef.current;
            if (pr) pr._saveToEngine();
            engine.play();
            setIsPlaying(true);
            setStatus('再生中…');
        }
        bumpTracks();
    }, [pianoRollRef, setIsPlaying, setStatus, bumpTracks]);

    // Space キーで、再生と一時停止を切り替える (▶ のボタンと同じ)。
    // - 文字を打ち込む欄に居るとき、案内などの窓が開いているときは、切り替えない
    // - キーボードで選んだボタンに居るときも、切り替えない (Space はそのボタンを押す操作)
    // - マウスで押したボタンにフォーカスが残っているだけのときは、切り替える。そのままだと
    //   ブラウザがそのボタンをもう一度押してしまうので、キーを離すところまで既定の動作を止める
    useEffect(() => {
        let swallowKeyUp = false;
        const isSpace = (e: KeyboardEvent) => e.code === 'Space' || e.key === ' ';
        const onKeyDown = (e: KeyboardEvent) => {
            if (!isSpace(e) || e.ctrlKey || e.metaKey || e.altKey) return;
            if (isTypingTarget(e.target) || isKeyboardFocusedControl(e.target) || isDialogOpen()) return;
            e.preventDefault();
            swallowKeyUp = true;
            // 押しっぱなしで何度も切り替わらないようにする
            if (!e.repeat) handlePlay();
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (!isSpace(e) || !swallowKeyUp) return;
            swallowKeyUp = false;
            e.preventDefault();
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('keyup', onKeyUp);
        };
    }, [handlePlay]);

    const handleStop = useCallback(() => {
        engine.stop();
        setIsPlaying(false);
        setStatus('停止');
        bumpTracks();
    }, [setIsPlaying, setStatus, bumpTracks]);

    const handleRecord = useCallback(async () => {
        if (!engine.isRecording) {
            try {
                await engine.startRecording();
                const pr = pianoRollRef.current;
                if (pr) pr._saveToEngine();
                engine.play();
                setIsPlaying(true);
                setStatus('録音中…');
            } catch (_e) {
                setStatus('マイクを使えませんでした。OS の設定で、このアプリにマイクの使用を許可してください', 'error');
            }
        } else {
            const buffer = await engine.stopRecording();
            engine.pause();
            setIsPlaying(false);
            await recordAsync('録音を追加', async () => {
                let recTrack = engine.tracks.find(t => t.name.includes('Rec'));
                if (!recTrack) recTrack = engine.addTrack('Rec');
                await engine.addClipFromBuffer(recTrack.id, buffer, 'recording');
            });
            bumpTracks();
            setStatus('録音完了');
        }
    }, [pianoRollRef, setIsPlaying, setStatus, bumpTracks, recordAsync]);

    const handleMetronome = useCallback(() => {
        engine.init();
        engine.metronomeEnabled = !engine.metronomeEnabled;
        setMetronomeEnabled(engine.metronomeEnabled);
        setStatus(engine.metronomeEnabled ? 'メトロノーム ON' : 'メトロノーム OFF');
    }, [setMetronomeEnabled, setStatus]);

    const handleExport = useCallback(async () => {
        engine.init();
        const pr = pianoRollRef.current;
        if (pr) pr._saveToEngine();
        // 書き出すのは、再生で鳴るもの (クリップと、ピアノロールのノート)。どちらも無ければ書き出さない
        if (engine.getTotalDuration() === 0) {
            setStatus('書き出すものがありません。クリップかノートを置いてください', 'error');
            return;
        }
        if (engine.audibleTracks().length === 0) {
            setStatus('鳴らすトラックがありません。ミュートを外してから書き出してください', 'error');
            return;
        }
        await withProgress('WAV を書き出しています…', async () => {
            const blob = await engine.exportWav();
            if (!blob) { setStatus('WAV を書き出せませんでした。もう一度試してください', 'error'); return; }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'bunri_mix.wav'; a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
            setStatus('WAV ファイルを書き出しました');
        });
    }, [withProgress, setStatus, pianoRollRef]);

    /**
     * ピアノロールのノートを標準 MIDI ファイルとして書き出す。
     * ノートの在るトラックを 1 本ずつ MIDI のトラックにする。
     */
    const handleExportMidi = useCallback(() => {
        const pr = pianoRollRef.current;
        if (pr) pr._saveToEngine();
        try {
            const bytes = notesToMidi(
                engine.tracks.map(t => ({ name: t.name, notes: t.pianoNotes || [] })),
                engine.bpm,
            );
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/midi' }));
            const a = document.createElement('a');
            a.href = url; a.download = 'bunri.mid'; a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
            setStatus('MIDI ファイルを書き出しました');
        } catch (e) {
            setStatus((e as Error).message === '書き出せるノートがありません'
                ? '書き出すノートがありません。ピアノロールにノートを置いてください'
                : 'MIDI ファイルを書き出せませんでした（' + describeError(e) + '）', 'error');
        }
    }, [setStatus, pianoRollRef]);

    // プロジェクトの保存・開く (lib/project-actions.ts)。⌘S / ⇧⌘S / ⌘O と、窓を閉じる前の確かめもここで受ける
    const projectActions = useProjectActions();
    useProjectWiring(projectActions);
    const [projectMenu, setProjectMenu] = useState<MenuRequest | null>(null);
    const openProjectMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const mod = modKeyLabel();
        setProjectMenu({
            label: 'プロジェクト', x: rect.left, y: rect.bottom + 2,
            returnFocus: () => document.getElementById('btn-project-menu'),
            items: [
                { label: '新しいプロジェクト', action: () => void projectActions.newProject() },
                { label: `別名で保存…（${mod}Shift+S）`, action: () => void projectActions.save(true) },
                { label: `最近使ったプロジェクト…（${mod}O）`, action: () => void projectActions.open() },
            ],
        });
    }, [projectActions]);

    const h = (text: string) => ({
        onMouseEnter: () => setHint(text),
        onMouseLeave: () => setHint(''),
    });

    return (
        <div id="header">
            <h1>bunri DAW</h1>
            <span id="project-title" title={project.path ?? project.file ?? 'まだ保存していません'}
                aria-label={`プロジェクト: ${project.name ?? UNTITLED}${isDirty ? '（保存していない変更があります）' : ''}`}>
                {project.name ?? UNTITLED}{project.legacy ? '（以前の形式）' : ''}
                {isDirty && <span className="unsaved-mark" aria-hidden="true"> ●</span>}
            </span>
            <div id="transport">
                <label htmlFor="transport-bpm">BPM</label>
                <input id="transport-bpm" type="number" value={bpm} min="20" max="300" step="0.01"
                    onChange={e => setBpm(e.target.value)}
                    {...h('テンポ（BPM）。曲の速さを指定します')} />
                <label htmlFor="transport-meter">拍子</label>
                <select id="transport-meter" value={beatsPerBar} onChange={e => setBeatsPerBar(e.target.value)}
                    {...h('1 小節の拍の数')}>
                    <option value="4">4/4</option>
                    <option value="3">3/4</option>
                    <option value="6">6/8</option>
                </select>
                <button id="btn-play" title="再生/一時停止（Space）" aria-label={isPlaying ? '一時停止' : '再生'} onClick={handlePlay}
                    {...h('再生と一時停止を切り替えます（Space キーでも切り替えられます）')}>
                    {isPlaying ? '⏸' : '▶'}
                </button>
                <button title="停止" aria-label="停止" onClick={handleStop} {...h('停止して先頭に戻ります')}>■</button>
                <button title="録音" aria-label="録音" aria-pressed={engine.isRecording} onClick={handleRecord}
                    className={engine.isRecording ? 'active' : ''}
                    style={engine.isRecording ? { color: 'var(--danger)' } : {}}
                    {...h('マイクから録音します')}>●</button>
                <button title="メトロノーム" aria-label="メトロノーム" aria-pressed={metronomeEnabled} onClick={handleMetronome}
                    className={metronomeEnabled ? 'active' : ''}
                    {...h('メトロノームを鳴らす・止める')}>🔔</button>
                <TimeDisplay />
            </div>
            <div>
                {/* 元に戻す・やり直す。何を戻すかを、マウスを載せたときの説明 (title) に出す */}
                <div id="history-buttons" role="group" aria-label="元に戻す・やり直す">
                    {/* ヘッダの幅が足りないので記号だけを出し、名前は aria-label で伝える */}
                    <button type="button" id="btn-undo" onClick={undo} disabled={!canUndo} aria-label="元に戻す"
                        aria-keyshortcuts="Meta+Z Control+Z"
                        title={canUndo ? `元に戻す: ${undoLabel}（${modKeyLabel()}Z）` : '元に戻せる操作はありません'}>
                        <span aria-hidden="true">↶</span>
                    </button>
                    <button type="button" id="btn-redo" onClick={redo} disabled={!canRedo} aria-label="やり直す"
                        aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y"
                        title={canRedo ? `やり直す: ${redoLabel}（${modKeyLabel()}Shift+Z）` : 'やり直せる操作はありません'}>
                        <span aria-hidden="true">↷</span>
                    </button>
                </div>
                <button onClick={() => void projectActions.save(false)} aria-keyshortcuts="Meta+S Control+S"
                    {...h(`プロジェクト（トラック・ノート・音声・カルテ・学習の記録）を 1 つのファイルに保存します（${modKeyLabel()}S）`)}>保存</button>
                <button onClick={() => void projectActions.open()} aria-keyshortcuts="Meta+O Control+O"
                    {...h(`保存したプロジェクトを開きます（${modKeyLabel()}O）`)}>開く</button>
                <button id="btn-project-menu" type="button" aria-label="プロジェクトのメニュー" aria-haspopup="menu"
                    aria-expanded={projectMenu !== null} onClick={openProjectMenu}
                    {...h('新しいプロジェクト・別名で保存・最近使ったプロジェクト')}>▾</button>
                <PopupMenu request={projectMenu} onClose={() => setProjectMenu(null)} />
                <button onClick={handleExport} disabled={showProgress}
                    {...h('再生で鳴る音を、1 つの WAV ファイルとして書き出します')}>WAV 書き出し</button>
                <button onClick={handleExportMidi} {...h('ピアノロールのノートを、MIDI ファイルとして書き出します')}>MIDI 書き出し</button>
                <a href="/tools" target="_blank" {...h('音声ファイルを加工するツールを、別の窓で開きます')}>ツール</a>
                <a href="/help" target="_blank" {...h('使い方の説明を、別の窓で開きます')}>使い方</a>
            </div>
        </div>
    );
}
