/**
 * bunri DAW — MIDI ファイルを読み込む欄（左パネルの「ファイル」タブ）。
 *
 * ファイルを選ぶと、その場で中身を読んで（`lib/midi.ts` の `parseMidi`）、MIDI のトラックごとに
 * 読み込み方を選ぶ一覧を出す。「読み込む」を押すまで、プロジェクトは変えない。
 * 読み込みで元のファイルから変わること（16 分音符への丸めなど）は、押す前に一覧の下に出す。
 *
 * 読み込み方と、トラックの作り方は `lib/midi-import.ts`。
 */
import { useCallback, useRef, useState } from 'react';
import { useDaw } from '../lib/store';
import engine from '../lib/engine';
import { parseMidi, type MidiImportResult } from '../lib/midi';
import {
    MIDI_MODE_LABEL, allowedModes, applyMidiImport, defaultModes, importedMessage, isEmptyProject, lossNotices, tempoNotice,
    type MidiImportMode,
} from '../lib/midi-import';

/** 読んだファイルと、トラックごとの読み込み方。 */
interface Loaded {
    fileName: string;
    result: MidiImportResult;
    modes: MidiImportMode[];
}

export default function MidiImport() {
    const { setStatus, bumpTracks, record, bpm, setBpm, setBeatsPerBar } = useDaw();
    const inputRef = useRef<HTMLInputElement>(null);
    const [loaded, setLoaded] = useState<Loaded | null>(null);

    const handleFile = useCallback(async (file: File | undefined) => {
        setLoaded(null);
        if (!file) return;
        try {
            const result = parseMidi(new Uint8Array(await file.arrayBuffer()));
            if (result.tracks.length === 0) {
                setStatus(`${file.name} には、読み込めるノートがありませんでした`, 'error');
                return;
            }
            setLoaded({ fileName: file.name, result, modes: defaultModes(result) });
            setStatus(`${file.name} を読みました。読み込み方を選んで「読み込む」を押してください`);
        } catch (e) {
            const reason = e instanceof Error ? e.message : 'ファイルを読めませんでした';
            setStatus(`${file.name} を読み込めませんでした。${reason}`, 'error');
        }
    }, [setStatus]);

    const setMode = useCallback((index: number, mode: MidiImportMode) => {
        setLoaded((current) => current && { ...current, modes: current.modes.map((m, i) => (i === index ? mode : m)) });
    }, []);

    const handleImport = useCallback(() => {
        if (!loaded) return;
        const outcome = record('MIDI ファイルを読み込む', () => {
            const applied = applyMidiImport(engine, loaded.result, loaded.modes);
            // テンポと拍子は、プロジェクトが空だったときだけ MIDI に合わせる (applyMidiImport が決める)
            if (applied.bpm !== null) setBpm(applied.bpm);
            if (applied.beatsPerBar !== null) setBeatsPerBar(applied.beatsPerBar);
            return applied;
        });
        bumpTracks();
        setStatus(importedMessage(loaded.fileName, outcome));
        setLoaded(null);
        if (inputRef.current) inputRef.current.value = '';
    }, [loaded, record, setBpm, setBeatsPerBar, bumpTracks, setStatus]);

    const chosen = loaded ? loaded.modes.filter((m) => m !== 'skip').length : 0;

    return (
        <div id="midi-import">
            <h3>MIDI ファイルを読み込む</h3>
            <p className="panel-desc">
                ほかのアプリで作った MIDI ファイル（.mid）のノートを読み込みます。新しいトラックのノートにするか、
                <strong style={{ color: 'var(--ghost)' }}>お手本</strong>として重ねて練習に使うかを、MIDI のトラックごとに選べます。
            </p>
            <label htmlFor="file-midi">MIDI ファイル</label>
            <input id="file-midi" type="file" ref={inputRef} accept=".mid,.midi,audio/midi,audio/x-midi"
                onChange={(e) => void handleFile(e.target.files?.[0])} />
            {loaded && (
                <div id="midi-import-plan">
                    <ul id="midi-track-list" aria-label="MIDI ファイルのトラック">
                        {loaded.result.tracks.map((track, i) => (
                            <li key={i} className="part-item">
                                <div className="part-head">
                                    <strong>{track.name}</strong>
                                    <span className="note-text">{track.notes.length} ノート{track.isDrum ? '（ドラム）' : ''}</span>
                                </div>
                                <select aria-label={`「${track.name}」の読み込み方`} value={loaded.modes[i]}
                                    onChange={(e) => setMode(i, e.target.value as MidiImportMode)}>
                                    {allowedModes(track).map((mode) => <option key={mode} value={mode}>{MIDI_MODE_LABEL[mode]}</option>)}
                                </select>
                                {track.isDrum && (
                                    <p className="note-text">ドラムは、ノートの高さが音の高さではなく、打楽器の種類を表します。ピアノロールでは、そのままの高さに並びます。</p>
                                )}
                            </li>
                        ))}
                    </ul>
                    <p className="note-text" id="midi-tempo-notice">{tempoNotice(loaded.result, bpm, isEmptyProject(engine))}</p>
                    <ul className="note-text" id="midi-loss-list" aria-label="読み込みで変わること">
                        {lossNotices(loaded.result, loaded.modes).map((text) => <li key={text}>{text}</li>)}
                    </ul>
                    <button className="action-btn" onClick={handleImport} disabled={chosen === 0}>読み込む</button>
                </div>
            )}
        </div>
    );
}
