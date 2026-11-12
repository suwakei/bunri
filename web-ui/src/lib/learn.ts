/**
 * bunri DAW — 学ぶ流れ（曲を取り込む → カルテを見る → パートに分ける → 打ち込む → 差分で直す）。
 *
 * 画面のあちこち（左パネルの「学ぶ」タブ、中央の空の状態、進み具合の段、トラックの見出し）から
 * 同じ操作を呼べるよう、操作をここに集めてある。
 *
 * トラックの役割（engine.ts の `Track.role`）:
 * - 原曲のトラック（`song`）: 取り込んだ曲の音声を置く
 * - パートのトラック（`part`）: パート分離で作る。パートの音声と、採譜したお手本（`referenceNotes`）を持つ。
 *   打ち込み（`pianoNotes`）は空のまま渡す（お手本を最初から打ち込みにすると、差分が最初から 100% になる）
 * - 練習のトラック（`practice`）: 「このパートを練習する」で作る。利用者が打ち込む
 *
 * 画面の文は docs/ui-terms.md の決まりに合わせる。
 */
import { useCallback } from 'react';
import { useDaw } from './store';
import engine, { type PianoNote, type Track } from './engine';
import { apiFetch, errorDetail } from './api';
import { modelDownloadNotice } from './models';
import type { ChartResponse } from './chart';

/** 原曲のトラックの名前。 */
export const SONG_TRACK_NAME = '原曲';

/** 取り込める曲のファイルの拡張子（ファイル選択の欄の accept）。 */
export const SONG_ACCEPT = '.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff';

/** トラックに読み込める音声ファイルか（拡張子で見る。最後はデコードできるかで決まる）。 */
export function isAudioFileName(name: string): boolean {
    return /\.(wav|mp3|flac|ogg|oga|m4a|aac|aif|aiff|webm)$/i.test(name);
}

/** パートの名前（API の識別子）から、画面に出す名前へ。 */
export const PART_LABELS: Record<string, string> = {
    vocals: 'ボーカル',
    drums: 'ドラム',
    bass: 'ベース',
    guitar: 'ギター',
    piano: 'ピアノ',
    other: 'その他',
};

/** ドラムのパートか。ドラムは差分チェックの対象外（種類ごとに決まった高さへ置いた近似のため）。 */
export function isDrumPart(part: string | undefined): boolean {
    return !!part && part.includes('drum');
}

/**
 * `/api/decompose` の結果の 1 パート。API の側では「ステム」と呼んでいる。
 */
export interface DecomposeStem {
    audio_url?: string;
    notes?: Array<{ note: string; octave: number; step: number; length: number; velocity?: number }>;
    drum_events?: Array<{ type: string; step: number; velocity: number }>;
    gm_program: number | null;
    mix: { volume_db: number; pan: number; reverb_wet: number };
}

/** `/api/decompose` の結果。`grid_offset_sec` は、ノートのステップ 0 を置いた位置（秒）。 */
export interface DecomposeResult {
    bpm: number;
    grid_offset_sec?: number;
    stems: Record<string, DecomposeStem>;
}

/** パートのトラック（パート分離で作ったもの）。トラックの並び順。 */
export function partTracks(): Track[] {
    return engine.tracks.filter(t => t.role === 'part');
}

/** お手本を持つパートのトラックの、練習のトラック（まだ無ければ undefined）。 */
export function practiceTrackOf(partId: number): Track | undefined {
    return engine.tracks.find(t => t.role === 'practice' && t.practiceOf === partId);
}

/**
 * そのトラックで重ねるお手本を持つトラック（既定の重ね方）。
 * お手本を持つトラックなら自分、練習のトラックなら、そのパートのトラック。
 */
export function referenceTrackFor(track: Track | undefined): Track | undefined {
    if (!track) return undefined;
    if (track.referenceNotes && track.referenceNotes.length > 0) return track;
    if (track.role === 'practice' && track.practiceOf !== undefined) {
        const part = engine.getTrack(track.practiceOf);
        if (part?.referenceNotes && part.referenceNotes.length > 0) return part;
    }
    return undefined;
}

/** ノートの並びの、真ん中の高さ（MIDI ノート番号の中央値）のノート。 */
function middleNote(notes: PianoNote[]): PianoNote | undefined {
    if (notes.length === 0) return undefined;
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const sorted = notes.slice().sort((a, b) => (a.octave * 12 + names.indexOf(a.note)) - (b.octave * 12 + names.indexOf(b.note)));
    return sorted[Math.floor(sorted.length / 2)];
}

// ---- 進み具合 ----

/** 5 つの段階の識別子。 */
export type StepKey = 'import' | 'chart' | 'separate' | 'practice' | 'diff';

/** 段階の状態。done: 済んだ / current: いまの段階 / todo: まだ */
export type StepState = 'done' | 'current' | 'todo';

/** 段階の定義（番号つきの名前）。 */
export const LEARN_STEPS: { key: StepKey; num: string; label: string }[] = [
    { key: 'import', num: '①', label: '曲を取り込む' },
    { key: 'chart', num: '②', label: 'カルテを見る' },
    { key: 'separate', num: '③', label: 'パートに分ける' },
    { key: 'practice', num: '④', label: '打ち込む' },
    { key: 'diff', num: '⑤', label: '差分で直す' },
];

/** 段階が済んだかを決める材料。 */
export interface ProgressFacts {
    /** 原曲のトラックが在るか、原曲のファイルを取り込んだか */
    imported: boolean;
    /** カルテが在るか */
    hasChart: boolean;
    /** パートに分けたか（パートのトラックが在るか） */
    separated: boolean;
    /** 練習のトラック（お手本を見ながら打ち込むトラック）にノートが在るか */
    practiced: boolean;
    /** 差分チェックで比べたか */
    diffed: boolean;
}

/** いまのトラックとカルテから、段階の材料を集める。 */
export function progressFacts(hasChart: boolean, hasSongFile: boolean, diffed: boolean): ProgressFacts {
    const tracks = engine.tracks;
    return {
        imported: hasSongFile || tracks.some(t => t.role === 'song'),
        hasChart,
        separated: tracks.some(t => t.role === 'part'),
        practiced: tracks.some(t => (t.role === 'practice' || (t.role === 'part' && (t.referenceNotes?.length ?? 0) > 0))
            && (t.pianoNotes?.length ?? 0) > 0),
        diffed,
    };
}

/**
 * 各段階の状態を決める。済んだものは done、済んでいない最初のものが current、残りは todo。
 * 段階は順に進むとは限らない（カルテ無しでパートに分けることもできる）ので、それぞれ実際の状態から決める。
 */
export function stepStates(facts: ProgressFacts): Record<StepKey, StepState> {
    const done: Record<StepKey, boolean> = {
        import: facts.imported,
        chart: facts.hasChart,
        separate: facts.separated,
        practice: facts.practiced,
        diff: facts.diffed,
    };
    const current = LEARN_STEPS.find(s => !done[s.key])?.key;
    const states = {} as Record<StepKey, StepState>;
    for (const s of LEARN_STEPS) states[s.key] = done[s.key] ? 'done' : s.key === current ? 'current' : 'todo';
    return states;
}

// ---- 操作 ----

/**
 * 学ぶ流れの操作をまとめたフック。
 */
export function useLearnActions() {
    const {
        setStatus, withProgress, bumpTracks, pianoRollRef, bpm, setBpm, beatsPerBar,
        setChartResult, openLearn, applyChartGrid, setGridOffset, songFile, setSongFile,
        setGhostChoice, setCoachPair, setLeftTab, chart,
    } = useDaw();

    /**
     * 音声ファイルを、ブラウザでデコードしてトラックに置く。デコードできなければ、
     * API の変換（ffmpeg）で WAV にしてから置く。どちらもできなければ例外。
     */
    const placeAudio = useCallback(async (trackId: number, file: File, offsetSec = 0) => {
        try {
            await engine.addClipFromFile(trackId, file, offsetSec);
            return;
        } catch {
            // このブラウザ (WebView) では読めない形式。API で WAV に変換してみる
        }
        const fd = new FormData();
        fd.append('file', file);
        const resp = await apiFetch('/api/convert/wav', { method: 'POST', body: fd });
        if (!resp.ok) throw new Error(await errorDetail(resp));
        const buffer = await engine.ctx!.decodeAudioData(await resp.arrayBuffer());
        await engine.addClipFromBuffer(trackId, buffer, file.name, offsetSec);
    }, []);

    /**
     * 原曲を取り込む。音声を「原曲」のトラックに置き、カルテを作る。
     * 終わったら「学ぶ」タブのカルテを開く（結果がどこに出たかを探させない）。
     *
     * @param file - 曲のファイル（mp3 / flac / m4a / wav など）
     * @param options.autoBpm - true ならテンポを自動で検出する（false なら、いまの BPM で解析する）
     */
    const importSong = useCallback(async (file: File, options: { autoBpm?: boolean } = {}) => {
        const autoBpm = options.autoBpm ?? true;
        setSongFile(file);
        engine.init();

        // 1. 原曲のトラック。在れば中身を入れ替える (2 本目は作らない)
        let song = engine.tracks.find(t => t.role === 'song');
        if (!song) {
            song = engine.addTrack(SONG_TRACK_NAME);
            song.role = 'song';
            // 原曲はいちばん上に置く
            engine.tracks = [song, ...engine.tracks.filter(t => t !== song)];
        }
        song.clips = [];
        let placed = true;
        try {
            await placeAudio(song.id, file, 0);
        } catch {
            placed = false;
        }
        bumpTracks();

        // 2. カルテ
        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', autoBpm ? '0' : String(bpm));
        fd.append('beats_per_bar', String(beatsPerBar));
        await withProgress(`原曲を解析しています…（${file.name}）`, async () => {
            const resp = await apiFetch('/api/chart', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const result: ChartResponse = await resp.json();
            setChartResult(result);
            // テンポ・拍子・1 小節目の位置を、カルテに合わせる (カルテとピアノロールの小節番号をそろえる)
            const applied = applyChartGrid(result.chart);
            openLearn('chart');
            bumpTracks();
            const key = result.chart.key.tonic
                ? `キー ${result.chart.key.tonic} ${result.chart.key.mode === 'minor' ? 'マイナー' : 'メジャー'}`
                : 'キー不明';
            const notes: string[] = [];
            if (!placed) notes.push('原曲の音声はこのアプリで再生できない形式だったので、タイムラインには置いていません（WAV に変換してから取り込むと置けます）');
            if (!applied) notes.push('テンポと小節の位置は、パートに分けたときのままにしました');
            setStatus(`カルテを作りました（${key} / ${result.chart.chords.length} コード）${notes.length ? '。' + notes.join('。') : ''}`,
                placed ? 'info' : 'error');
        });
    }, [placeAudio, setSongFile, bumpTracks, bpm, beatsPerBar, withProgress, setChartResult, applyChartGrid, openLearn, setStatus]);

    /**
     * 原曲をパートに分けて採譜する。パートごとに、パートの音声とお手本を持つトラックを作る。
     * 打ち込み（ピアノロールのノート）は空のまま。お手本は水色で重ねて見せる。
     * ドラムは以前どおり、採譜したリズムをノートとして置く（差分チェックの対象外）。
     *
     * パートのトラックはミュートして作る（原曲と重なって音が大きくなるため）。
     * 「このパートを練習する」で、そのパートだけ鳴らす。
     *
     * @param sensitivity - 採譜の感度（0.1〜1）
     */
    const separateParts = useCallback(async (sensitivity: number) => {
        const file = songFile;
        if (!file) { setStatus('先に曲を取り込んでください（「曲を取り込む」）', 'error'); return; }

        // カルテが在れば、カルテのグリッド (テンポと 1 小節目の位置) に載せて採譜する。
        // カルテとピアノロールの小節番号が同じ時刻を指すように (docs/coach-diff-design.md)。
        // パートは作り直すので、前のお手本に合わせてグリッドを据え置く必要は無い
        if (chart) applyChartGrid(chart, { force: true });
        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', chart ? String(engine.bpm) : '0');
        fd.append('grid_offset', chart ? String(engine.gridOffset) : '0');
        fd.append('sensitivity', String(sensitivity));

        const notice = await modelDownloadNotice('htdemucs_6s');
        await withProgress(
            `原曲をパートに分けています…（${file.name}）パート分離 → 採譜 → 楽器の推定。数分かかります。${notice}`,
            async () => {
                const resp = await apiFetch('/api/decompose', { method: 'POST', body: fd });
                if (!resp.ok) throw new Error(await errorDetail(resp));
                const result: DecomposeResult = await resp.json();
                if (result.bpm && Math.abs(result.bpm - engine.bpm) > 1e-6) setBpm(result.bpm);
                if (typeof result.grid_offset_sec === 'number') setGridOffset(result.grid_offset_sec);

                // 前に分けたパートは入れ替える (2 回押しても、同じパートが 2 本ずつにならない)
                for (const old of engine.tracks.filter(t => t.role === 'part' || t.role === 'practice')) {
                    if (pianoRollRef.current?.getActiveTrackId() === old.id) pianoRollRef.current.switchToTrack(null);
                    engine.removeTrack(old.id);
                }

                let created = 0, withReference = 0;
                for (const [stemName, stem] of Object.entries(result.stems)) {
                    const label = PART_LABELS[stemName] || stemName;
                    const track = engine.addTrack(label);
                    track.role = 'part';
                    track.part = stemName;
                    created++;
                    if (stem.mix) {
                        engine.updateTrackGain(track.id, stem.mix.volume_db);
                        engine.updateTrackPan(track.id, stem.mix.pan);
                    }
                    if (stem.audio_url) {
                        try {
                            await engine.addClipFromUrl(track.id, stem.audio_url, label, 0);
                        } catch (e) {
                            console.warn(`${stemName} の音声を読み込めませんでした:`, e);
                        }
                    }
                    if (stem.notes && stem.notes.length > 0) {
                        // お手本として控える。打ち込みは空のまま (自分で打ち込んで、差分チェックで比べる)
                        track.referenceNotes = stem.notes.map(n => ({ note: n.note, octave: n.octave, step: n.step, length: n.length }));
                        track.pianoNotes = [];
                        withReference++;
                    }
                    if (stem.drum_events && stem.drum_events.length > 0) {
                        // ドラムは以前どおり、種類ごとに決まった高さのノートとして置く (お手本にはしない)
                        const drumMap: Record<string, { note: string; octave: number }> = {
                            kick: { note: 'C', octave: 2 },
                            snare: { note: 'D', octave: 2 },
                            hihat: { note: 'F#', octave: 2 },
                        };
                        track.pianoNotes = stem.drum_events.map(e => ({ ...(drumMap[e.type] || drumMap.kick), step: e.step, length: 1 }));
                    }
                    // 原曲と重なると音が大きくなるので、パートは最初はミュートしておく
                    if (engine.tracks.some(t => t.role === 'song')) {
                        if (!track.mute) engine.toggleMute(track.id);
                    }
                }
                setCoachPair({ referenceId: null, attemptId: null });
                bumpTracks();
                openLearn('song');
                setStatus(`パートに分けました（${created} パート、お手本 ${withReference} パート）。練習するパートの「このパートを練習する」を押してください`);
            },
        );
    }, [songFile, chart, applyChartGrid, setStatus, withProgress, setBpm, setGridOffset, pianoRollRef, setCoachPair, bumpTracks, openLearn]);

    /**
     * そのパートを練習する。1 回の操作で、次をまとめて行う。
     * - 練習のトラックを選ぶ（無ければ作り、パートのトラックの隣に置く）
     * - そのトラックをピアノロールで開き、そのパートのお手本を重ねる
     * - お手本のノートが在る高さと小節まで、ピアノロールをスクロールする
     * - 差分チェックの組を「お手本 = このパート、打ち込み = 練習のトラック」にする
     * - パートの音声と練習のトラックを鳴るようにする（原曲のミュート・ソロは利用者に任せる）
     *
     * @param partId - パートのトラックの ID
     */
    const practicePart = useCallback((partId: number) => {
        const part = engine.getTrack(partId);
        if (!part || !part.referenceNotes?.length) return;
        let practice = practiceTrackOf(partId);
        if (!practice) {
            practice = engine.addTrack(`${part.name}の練習`);
            practice.role = 'practice';
            practice.part = part.part;
            practice.practiceOf = part.id;
            engine.moveTrackAfter(practice.id, part.id);
        }
        // パートの音声と、練習のトラックを鳴らす。ソロが在るなら、この 2 本もソロにする
        if (part.mute) engine.toggleMute(part.id);
        if (practice.mute) engine.toggleMute(practice.id);
        if (engine.tracks.some(t => t.solo)) { part.solo = true; practice.solo = true; }

        setGhostChoice('auto');
        setCoachPair({ referenceId: part.id, attemptId: practice.id });
        const pr = pianoRollRef.current;
        if (pr) {
            pr.switchToTrack(practice.id);
            pr.setGhostNotes(part.referenceNotes);
            // お手本の在る高さと、最初のノートの小節まで動かす
            const middle = middleNote(part.referenceNotes);
            if (middle) pr.scrollToPitch?.(middle.note, middle.octave, true);
            const first = Math.min(...part.referenceNotes.map(n => n.step));
            pr.scrollToStep(Math.max(0, first));
        }
        bumpTracks();
        setStatus(`「${part.name}」を練習します。水色のお手本を見ながら「${practice.name}」にノートを置き、終わったら「差分チェック」で比べてください`);
    }, [setGhostChoice, setCoachPair, pianoRollRef, bumpTracks, setStatus]);

    /**
     * お手本を、そのパートのトラックの打ち込みとして写す（採譜を自由に直したい人向け）。
     * 写すと差分チェックは 100% から始まる。呼ぶ前に、画面で確かめてもらう。
     *
     * @param partId - パートのトラックの ID
     */
    const adoptReference = useCallback((partId: number) => {
        const part = engine.getTrack(partId);
        if (!part || !part.referenceNotes?.length) return;
        const pr = pianoRollRef.current;
        // 開いているトラックのノートを書き戻してから写す (写した後に古い表示で上書きしない)
        pr?._saveToEngine?.();
        part.pianoNotes = part.referenceNotes.map(n => ({ ...n }));
        if (part.mute) engine.toggleMute(part.id);
        setCoachPair({ referenceId: part.id, attemptId: part.id });
        if (pr) {
            pr.switchToTrack(null);
            pr.switchToTrack(part.id);
        }
        bumpTracks();
        setStatus(`「${part.name}」のお手本を、ノートとして取り込みました（${part.pianoNotes.length} ノート）`);
    }, [pianoRollRef, setCoachPair, bumpTracks, setStatus]);

    /** 自由に作る: 空のトラックを 1 本作って、ピアノロールで開く。 */
    const startFree = useCallback(() => {
        const track = engine.addTrack();
        pianoRollRef.current?.switchToTrack(track.id);
        setLeftTab('sound');
        bumpTracks();
        setStatus(`「${track.name}」を作りました。下のピアノロールをダブルクリックするとノートを置けます`);
    }, [pianoRollRef, setLeftTab, bumpTracks, setStatus]);

    return { importSong, separateParts, practicePart, adoptReference, startFree, placeAudio };
}
