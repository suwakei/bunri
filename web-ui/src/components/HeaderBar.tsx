/**
 * bunri DAW — ヘッダーバー（トランスポート + アクションボタン）
 */
import { useCallback, useState, useEffect } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { apiFetch, errorDetail } from '../lib/api';
import { notesToMidi } from '../lib/midi';

/**
 * プロジェクトデータの構造を表すインターフェース。
 * API の `/api/project/save` / `/api/project/load/{name}` でやり取りされる。
 *
 * @property bpm - テンポ（Beats Per Minute）
 * @property beatsPerBar - 1小節あたりの拍数
 * @property tracks - トラックごとのピアノロールノート配列を含むトラック情報
 * @property pianoRollNotes - 旧形式の互換フィールド（単一ピアノロールノート列）
 * @property automation - オートメーションポイントのシリアライズ済みデータ
 */
interface ProjectData {
    bpm?: number;
    beatsPerBar?: number;
    tracks?: Array<{
        name?: string;
        gain?: number;
        pan?: number;
        mute?: boolean;
        pianoNotes?: Array<{ note: string; octave: number; step: number; length: number }>;
        referenceNotes?: Array<{ note: string; octave: number; step: number; length: number }>;
    }>;
    pianoRollNotes?: Array<{ note: string; octave: number; step: number; length: number }>;
    automation?: Record<string, unknown>;
}

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
 * プロジェクト操作ボタン（保存・読込・WAV書き出し・ガイド）を提供する。
 *
 * @returns ヘッダー全体の `<div id="header">` 要素
 */
export default function HeaderBar() {
    const {
        bpm, setBpm, beatsPerBar, setBeatsPerBar,
        isPlaying, setIsPlaying, setStatus,
        metronomeEnabled, setMetronomeEnabled,
        withProgress, bumpTracks, pianoRollRef, automationRef,
        setHint, showGuide, setShowGuide,
    } = useDaw();

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
            setStatus('再生中...');
        }
        bumpTracks();
    }, [pianoRollRef, setIsPlaying, setStatus, bumpTracks]);

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
                setStatus('録音中...');
            } catch (_e) {
                setStatus('マイクにアクセスできません');
            }
        } else {
            const buffer = await engine.stopRecording();
            engine.pause();
            setIsPlaying(false);
            let recTrack = engine.tracks.find(t => t.name.includes('Rec'));
            if (!recTrack) recTrack = engine.addTrack('Rec');
            await engine.addClipFromBuffer(recTrack.id, buffer, 'recording');
            bumpTracks();
            setStatus('録音完了');
        }
    }, [pianoRollRef, setIsPlaying, setStatus, bumpTracks]);

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
            setStatus('書き出すものがありません。クリップかノートを置いてください');
            return;
        }
        await withProgress('ミックスダウン中...', async () => {
            const blob = await engine.exportWav();
            if (!blob) { setStatus('書き出しに失敗しました'); return; }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'bunri_mix.wav'; a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
            setStatus('WAVファイルを書き出しました');
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
            setStatus('MIDIファイルを書き出しました');
        } catch (e) {
            setStatus((e as Error).message === '書き出せるノートがありません'
                ? '書き出すノートがありません。ピアノロールにノートを置いてください'
                : 'MIDIの書き出しに失敗しました: ' + (e as Error).message);
        }
    }, [setStatus, pianoRollRef]);

    const handleSave = useCallback(async () => {
        const pr = pianoRollRef.current;
        if (pr) pr.getNotes();
        const auto = automationRef.current;
        const project = {
            bpm: engine.bpm, beatsPerBar: engine.beatsPerBar,
            tracks: engine.tracks.map(t => ({
                name: t.name, gain: t.gain, pan: t.pan, mute: t.mute,
                clips: t.clips.map(c => ({ name: c.name, offset: c.offset, duration: c.duration })),
                pianoNotes: t.pianoNotes || [],
                referenceNotes: t.referenceNotes,
            })),
            automation: auto ? auto.toJSON() : {},
        };
        const fd = new FormData();
        fd.append('data', JSON.stringify(project));
        const resp = await apiFetch('/api/project/save', { method: 'POST', body: fd });
        if (!resp.ok) { setStatus('エラー: プロジェクトを保存できませんでした（' + await errorDetail(resp) + '）'); return; }
        setStatus('プロジェクトを保存しました');
    }, [pianoRollRef, automationRef, setStatus]);

    const handleLoad = useCallback(async () => {
        const resp = await apiFetch('/api/project/list');
        const files = await resp.json();
        if (files.length === 0) { setStatus('保存されたプロジェクトがありません'); return; }
        const name = files[0];
        const projResp = await apiFetch(`/api/project/load/${name}`);
        const project: ProjectData = await projResp.json();
        engine.bpm = project.bpm || 120;
        engine.beatsPerBar = project.beatsPerBar || 4;
        setBpm(engine.bpm); setBeatsPerBar(engine.beatsPerBar);
        // ピアノロールは、トラックを読み込む「前」に閉じる。ピアノロールは別のトラックへ移るとき、
        // 画面に出しているノートを、開いていたトラックへ書き戻す。読み込んだ後に閉じると、
        // 開いていたトラックのノートが、読み込んだ内容ではなく、画面に出ていた古い内容に戻ってしまう
        const pr = pianoRollRef.current;
        if (pr) pr.switchToTrack(null);
        if (project.tracks) {
            project.tracks.forEach((pt, i) => {
                // 保存したときのほうがトラックが多ければ、足りないぶんを作る
                // (作らないと、3 本目以降のノートが読み込まれずに消える)
                const track = engine.tracks[i] ?? engine.addTrack(pt.name);
                if (pt.name) track.name = pt.name;
                if (typeof pt.gain === 'number') engine.updateTrackGain(track.id, pt.gain);
                if (typeof pt.pan === 'number') engine.updateTrackPan(track.id, pt.pan);
                if (typeof pt.mute === 'boolean' && pt.mute !== track.mute) engine.toggleMute(track.id);
                if (pt.pianoNotes) track.pianoNotes = pt.pianoNotes;
                if (pt.referenceNotes) track.referenceNotes = pt.referenceNotes;
            });
        }
        const auto = automationRef.current;
        if (auto) auto.fromJSON(project.automation || {});
        bumpTracks();
        setStatus(`プロジェクト ${name} を読み込みました（※音声データは再インポートが必要です）`);
    }, [setBpm, setBeatsPerBar, automationRef, pianoRollRef, bumpTracks, setStatus]);

    const h = (text: string) => ({
        onMouseEnter: () => setHint(text),
        onMouseLeave: () => setHint(''),
    });

    return (
        <div id="header">
            <h1>bunri DAW</h1>
            <div id="transport">
                <label>BPM</label>
                <input type="number" value={bpm} min="20" max="300"
                    onChange={e => setBpm(e.target.value)}
                    {...h('テンポ（BPM）。曲の速さを指定します')} />
                <label>拍子</label>
                <select value={beatsPerBar} onChange={e => setBeatsPerBar(e.target.value)}
                    {...h('1小節の拍数')}>
                    <option value="4">4/4</option>
                    <option value="3">3/4</option>
                    <option value="6">6/8</option>
                </select>
                <button id="btn-play" title="再生/一時停止" onClick={handlePlay}
                    {...h('再生/一時停止を切り替えます')}>
                    {isPlaying ? '⏸' : '▶'}
                </button>
                <button title="停止" onClick={handleStop} {...h('停止して先頭に戻ります')}>■</button>
                <button title="録音" onClick={handleRecord}
                    className={engine.isRecording ? 'active' : ''}
                    style={engine.isRecording ? { color: '#e74c3c' } : {}}
                    {...h('マイクから録音')}>●</button>
                <button title="メトロノーム" onClick={handleMetronome}
                    className={metronomeEnabled ? 'active' : ''}
                    {...h('メトロノームON/OFF')}>🔔</button>
                <TimeDisplay />
            </div>
            <div>
                <button onClick={handleSave} {...h('プロジェクト保存')}>保存</button>
                <button onClick={handleLoad} {...h('プロジェクト読込')}>読込</button>
                <button onClick={handleExport} {...h('WAV書き出し')}>書出</button>
                <button onClick={handleExportMidi} {...h('ピアノロールのノートを MIDI ファイルとして書き出す')}>MIDI</button>
                <button onClick={() => setShowGuide(true)} {...h('ガイド表示')}>❓</button>
                <a href="/tools" target="_blank" {...h('ツールを別タブで開く')}>ツール</a>
                <a href="/help" target="_blank" {...h('使い方ガイド')}>使い方</a>
            </div>
        </div>
    );
}
