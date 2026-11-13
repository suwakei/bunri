/**
 * bunri DAW — ヘッダーバー（トランスポート + アクションボタン）
 */
import { useCallback, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { describeError } from '../lib/api';
import { UNTITLED, useProjectActions, useProjectWiring } from '../lib/project-actions';
import PopupMenu, { type MenuRequest } from './PopupMenu';
import { historyShortcut, isDialogOpen, isKeyboardFocusedControl, isTypingTarget, modKeyLabel } from '../lib/keys';
import { notesToMidi } from '../lib/midi';
import { tip } from '../lib/tooltip';

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
    return <span id="time-display" {...tip('いまの再生位置（分:秒）')}>{time}</span>;
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
                { label: '新しいプロジェクト', action: () => void projectActions.newProject(), title: '空のプロジェクトから始めます' },
                { label: `別名で保存…（${mod}Shift+S）`, action: () => void projectActions.save(true), title: 'いまの内容を、別の名前のファイルとして保存します' },
                { label: `最近使ったプロジェクト…（${mod}O）`, action: () => void projectActions.open(), title: '最近開いたプロジェクトから選んで開きます' },
            ],
        });
    }, [projectActions]);

    const mod = modKeyLabel();

    return (
        <div id="header" data-tip-side="bottom">
            <h1>bunri DAW</h1>
            <span id="project-title"
                {...tip(project.path ?? project.file
                    ? `保存先: ${project.path ?? project.file}${isDirty ? '\n● は、まだ保存していない変更があるしるしです' : ''}`
                    : 'まだ保存していないプロジェクトです')}
                aria-label={`プロジェクト: ${project.name ?? UNTITLED}${isDirty ? '（保存していない変更があります）' : ''}`}>
                <span className="project-name">{project.name ?? UNTITLED}{project.legacy ? '（以前の形式）' : ''}</span>
                {isDirty && <span className="unsaved-mark" aria-hidden="true">●</span>}
            </span>
            <div id="transport">
                <label htmlFor="transport-bpm">BPM</label>
                <input id="transport-bpm" type="number" value={bpm} min="20" max="300" step="0.01"
                    onChange={e => setBpm(e.target.value)}
                    {...tip('曲の速さ（1 分間に刻む拍の数）。数字を大きくすると速くなります')} />
                <label htmlFor="transport-meter">拍子</label>
                <select id="transport-meter" value={beatsPerBar} onChange={e => setBeatsPerBar(e.target.value)}
                    {...tip('1 小節に入る拍の数。多くの曲は 4/4 です')}>
                    <option value="4">4/4</option>
                    <option value="3">3/4</option>
                    <option value="6">6/8</option>
                </select>
                <button id="btn-play" aria-label={isPlaying ? '一時停止' : '再生'} onClick={handlePlay}
                    {...tip(isPlaying ? '一時停止します。もう一度押すと続きから鳴ります' : 'いまの再生位置から鳴らします', { key: 'Space' })}>
                    {isPlaying ? '⏸' : '▶'}
                </button>
                <button aria-label="停止" onClick={handleStop} {...tip('止めて、曲の頭に戻ります')}>■</button>
                <button aria-label="録音" aria-pressed={engine.isRecording} onClick={handleRecord}
                    className={engine.isRecording ? 'active' : ''}
                    style={engine.isRecording ? { color: 'var(--danger)' } : {}}
                    {...tip(engine.isRecording
                        ? '録音を止めます。録った音は「Rec」のトラックに入ります'
                        : 'マイクの音を録ります。ほかのトラックを鳴らしながら録れます')}>●</button>
                <button aria-label="メトロノーム" aria-pressed={metronomeEnabled} onClick={handleMetronome}
                    className={metronomeEnabled ? 'active' : ''}
                    {...tip(metronomeEnabled ? 'クリック音を止めます' : '再生中、拍に合わせてクリック音を鳴らします')}>🔔</button>
                <TimeDisplay />
            </div>
            <div>
                {/* 元に戻す・やり直す。何を戻すかを、マウスを載せたときの説明に出す */}
                <div id="history-buttons" role="group" aria-label="元に戻す・やり直す">
                    {/* ヘッダの幅が足りないので記号だけを出し、名前は aria-label で伝える */}
                    <button type="button" id="btn-undo" onClick={undo} disabled={!canUndo} aria-label="元に戻す"
                        aria-keyshortcuts="Meta+Z Control+Z"
                        {...(canUndo
                            ? tip(`直前の操作（${undoLabel}）を取り消します`, { key: `${mod}Z` })
                            : tip('取り消せる操作はまだありません'))}>
                        <span aria-hidden="true">↶</span>
                    </button>
                    <button type="button" id="btn-redo" onClick={redo} disabled={!canRedo} aria-label="やり直す"
                        aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y"
                        {...(canRedo
                            ? tip(`取り消した操作（${redoLabel}）をもう一度行います`, { key: `${mod}${mod === '⌘' ? '⇧' : 'Shift+'}Z` })
                            : tip('やり直せる操作はありません'))}>
                        <span aria-hidden="true">↷</span>
                    </button>
                </div>
                <button onClick={() => void projectActions.save(false)} aria-keyshortcuts="Meta+S Control+S"
                    {...tip('トラック・ノート・音声・カルテ・学習の記録を、1 つのファイルにまとめて保存します', { key: `${mod}S` })}>保存</button>
                <button onClick={() => void projectActions.open()} aria-keyshortcuts="Meta+O Control+O"
                    {...tip('保存したプロジェクトを開きます', { key: `${mod}O` })}>開く</button>
                <button id="btn-project-menu" type="button" aria-label="プロジェクトのメニュー" aria-haspopup="menu"
                    aria-expanded={projectMenu !== null} onClick={openProjectMenu}
                    {...tip('新しいプロジェクト、別名で保存、最近使ったプロジェクト')}>▼</button>
                {/* ヘッダのボタンの見た目 (#header のボタンの決まり) を受けないよう、body の直下に出す */}
                {createPortal(<PopupMenu request={projectMenu} onClose={() => setProjectMenu(null)} />, document.body)}
                <button onClick={handleExport} disabled={showProgress}
                    {...tip('再生で鳴る音をまとめて、1 つの WAV ファイルにします')}>WAV 書き出し</button>
                <button onClick={handleExportMidi} {...tip('ピアノロールのノートを MIDI ファイルにします。ほかの音楽ソフトで開けます')}>MIDI 書き出し</button>
                <a href="/tools" target="_blank" {...tip('パート分離や形式の変換など、ファイルを加工する道具を別の窓で開きます')}>ツール</a>
                <a href="/help" target="_blank" {...tip('使い方の説明を別の窓で開きます')}>使い方</a>
            </div>
        </div>
    );
}
