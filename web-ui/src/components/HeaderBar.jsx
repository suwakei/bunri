/**
 * bunri DAW — ヘッダーバー（トランスポート + アクションボタン）
 */
import { useCallback, useState, useEffect } from 'react';
import { useDaw } from '../lib/store.jsx';
import engine from '../lib/engine.js';

function formatTime(t) {
    const min = Math.floor(t / 60);
    const sec = (t % 60).toFixed(1);
    return `${min}:${sec.padStart(4, '0')}`;
}

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
            } catch {
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
        const totalClips = engine.tracks.reduce((sum, t) => sum + t.clips.length, 0);
        if (totalClips === 0) {
            setStatus('書き出すクリップがありません');
            return;
        }
        await withProgress('ミックスダウン中...', async () => {
            const pr = pianoRollRef.current;
            if (pr) pr._saveToEngine();
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
            })),
            automation: auto ? auto.toJSON() : {},
        };
        const fd = new FormData();
        fd.append('data', JSON.stringify(project));
        await fetch('/api/project/save', { method: 'POST', body: fd });
        setStatus('プロジェクトを保存しました');
    }, [pianoRollRef, automationRef, setStatus]);

    const handleLoad = useCallback(async () => {
        const resp = await fetch('/api/project/list');
        const files = await resp.json();
        if (files.length === 0) { setStatus('保存されたプロジェクトがありません'); return; }
        const name = files[0];
        const projResp = await fetch(`/api/project/load/${name}`);
        const project = await projResp.json();
        engine.bpm = project.bpm || 120;
        engine.beatsPerBar = project.beatsPerBar || 4;
        setBpm(engine.bpm); setBeatsPerBar(engine.beatsPerBar);
        if (project.tracks) {
            project.tracks.forEach((pt, i) => {
                if (engine.tracks[i] && pt.pianoNotes) engine.tracks[i].pianoNotes = pt.pianoNotes;
            });
        }
        const auto = automationRef.current;
        if (auto) auto.fromJSON(project.automation || {});
        const pr = pianoRollRef.current;
        if (pr) pr.switchToTrack(null);
        bumpTracks();
        setStatus(`プロジェクト ${name} を読み込みました（※音声データは再インポートが必要です）`);
    }, [setBpm, setBeatsPerBar, automationRef, pianoRollRef, bumpTracks, setStatus]);

    const h = (text) => ({
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
                <button onClick={() => setShowGuide(true)} {...h('ガイド表示')}>❓</button>
                <a href="/tools" target="_blank" {...h('ツールを別タブで開く')}>ツール</a>
                <a href="/help" target="_blank" {...h('使い方ガイド')}>使い方</a>
            </div>
        </div>
    );
}
