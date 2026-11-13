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
import engine, { MIDI_PART, cloneNote, type PianoNote, type Track } from './engine';
import { apiFetch, describeError, errorDetail } from './api';
import { modelDownloadNotice } from './models';
import { JobBusyError, JobCancelledError, jobErrorMessage, jobTracker, type Job } from './jobs';
import { isChartResponse } from './chart';
import { decodeWithSource } from './audio-sources';

/** カルテの作成のジョブが終わったのに、結果にカルテが入っていなかったときの知らせ。 */
export const CHART_RESULT_INVALID = 'カルテの作成は終わりましたが、結果にカルテが入っていませんでした。もう一度取り込んでください';

/** 原曲のトラックの名前。 */
export const SONG_TRACK_NAME = '原曲';

/** 取り込める曲のファイルの拡張子（ファイル選択の欄の accept）。 */
export const SONG_ACCEPT = '.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff';

/** トラックに読み込める音声ファイルか（拡張子で見る。最後はデコードできるかで決まる）。 */
export function isAudioFileName(name: string): boolean {
    return /\.(wav|mp3|flac|ogg|oga|m4a|aac|aif|aiff|webm)$/i.test(name);
}

/**
 * いまのパートのトラックを、どのカルテのグリッドで採譜したか（カルテの ID）。カルテ無しで分けたなら null。
 * 差分の説明（`/api/coach/explain`）にカルテを添えてよいか（お手本と同じ曲のカルテか）を決めるのに使う。
 * 別の曲を取り込むとカルテは入れ替わるが、パートは前の曲のまま残るので、ID を比べて見分ける。
 */
let partsChartId: string | null = null;

/** いまのパートのトラックを採譜したときのカルテの ID（カルテ無しで分けた、またはまだ分けていなければ null）。 */
export function chartIdOfParts(): string | null {
    return partsChartId;
}

/** パートを採譜したときのカルテの ID を設定する（プロジェクトを開いたとき。lib/project-file.ts）。 */
export function setChartIdOfParts(id: string | null): void {
    partsChartId = id;
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

/** ジョブの結果（`unknown`）が、`/api/decompose` の結果の形か（パートの表を持つか）。 */
export function isDecomposeResult(value: unknown): value is DecomposeResult {
    if (!value || typeof value !== 'object') return false;
    const stems = (value as { stems?: unknown }).stems;
    return !!stems && typeof stems === 'object' && !Array.isArray(stems);
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
        setStatus, bumpTracks, pianoRollRef, bpm, setBpm, beatsPerBar,
        setChartResult, openLearn, applyChartGrid, setGridOffset, songFile, setSongFile,
        setGhostChoice, setCoachPair, setLeftTab, chart, chartId, record, recordAsync, openPractice,
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
        // 変換した WAV を元のバイト列として覚える (プロジェクトの保存で、そのまま入れる)
        const buffer = await decodeWithSource(engine.ctx!, await resp.arrayBuffer(), file.name.replace(/\.[^.]+$/, '') + '.wav');
        await engine.addClipFromBuffer(trackId, buffer, file.name, offsetSec);
    }, []);

    /**
     * カルテの結果を画面に当てる。テンポ・拍子・1 小節目の位置をカルテに合わせ、カルテの段を開く。
     * 曲の取り込みの最後と、画面を開き直す前に始めたカルテの作成が終わったとき（つなぎ直し）に使う。
     *
     * ジョブの結果は形を確かめてから当てる（`isChartResponse`）。形が違えば（カルテの入っていない結果）、
     * 何も変えずに失敗として知らせる（例外にすると、取り込みが「解析しています…」のまま止まる）。
     *
     * @param result - `/api/chart` のジョブの結果
     * @param placed - 原曲の音声をタイムラインに置けたか（置けなかったら、その旨を添える）
     * @returns カルテを当てたら true
     */
    const finishChart = useCallback((result: unknown, placed = true): boolean => {
        if (!isChartResponse(result)) {
            setStatus(CHART_RESULT_INVALID, 'error');
            return false;
        }
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
        return true;
    }, [setChartResult, applyChartGrid, openLearn, bumpTracks, setStatus]);

    /**
     * 原曲を取り込む。カルテの作成（時間のかかる処理。進み具合は「曲とパート」の段に出る）を始め、
     * その間に音声を「原曲」のトラックに置く。カルテができたら「学ぶ」タブのカルテを開く
     * （結果がどこに出たかを探させない）。
     *
     * ほかの重い処理が動いていて始められなかったときは、トラックには何もしない（断られた旨を出す）。
     *
     * @param file - 曲のファイル（mp3 / flac / m4a / wav など）
     * @param options.autoBpm - true ならテンポと拍子（3 拍子か 4 拍子か）を自動で検出する
     *   （false なら、いまの BPM と拍子で解析する）
     */
    const importSong = useCallback(async (file: File, options: { autoBpm?: boolean } = {}) => {
        const autoBpm = options.autoBpm ?? true;
        const fd = new FormData();
        fd.append('file', file);
        fd.append('bpm', autoBpm ? '0' : String(bpm));
        // 0 は「自動で決める」。テンポを自動で取るなら、拍子もいまの設定 (既定の 4/4) を押し付けない
        fd.append('beats_per_bar', autoBpm ? '0' : String(beatsPerBar));
        let job: Job;
        try {
            job = await jobTracker.start('learn-song', '/api/chart', fd);
        } catch (e) {
            setStatus(e instanceof JobBusyError ? e.message : describeError(e), 'error');
            return;
        }
        setSongFile(file);
        setStatus(`原曲を解析しています…（${file.name}）`);
        engine.init();

        // 1. 原曲のトラック。在れば中身を入れ替える (2 本目は作らない)。カルテの作成と並べて行う。元に戻せる
        let placed = true;
        await recordAsync('原曲を取り込む', async () => {
            let song = engine.tracks.find(t => t.role === 'song');
            if (!song) {
                song = engine.addTrack(SONG_TRACK_NAME);
                song.role = 'song';
                // 原曲はいちばん上に置く
                engine.tracks = [song, ...engine.tracks.filter(t => t !== song)];
            }
            song.clips = [];
            try {
                await placeAudio(song.id, file, 0);
            } catch {
                placed = false;
            }
        });
        bumpTracks();

        // 2. カルテ
        const final = await jobTracker.wait(job.id);
        if (final.state === 'done') finishChart(final.result, placed);
        else if (final.state === 'cancelled') setStatus('カルテの作成を中止しました。原曲はトラックに置いてあります。もう一度取り込むと、カルテを作り直せます');
        else setStatus(jobErrorMessage(final), 'error');
    }, [placeAudio, setSongFile, bumpTracks, bpm, beatsPerBar, finishChart, setStatus, recordAsync]);

    /**
     * パート分離の結果を、トラックにする。パートごとに、パートの音声とお手本を持つトラックを作る。
     * 前に分けたパート（と練習のトラック）は入れ替える。
     * パートに分けたときの最後と、画面を開き直す前に始めたパート分離が終わったとき（つなぎ直し）に使う。
     *
     * 結果の形は確かめてから当てる（`isDecomposeResult`。理由は `finishChart` と同じ）。
     *
     * @param result - `/api/decompose` のジョブの結果
     */
    const applyParts = useCallback(async (result: unknown) => {
        if (!isDecomposeResult(result)) {
            setStatus('パート分離は終わりましたが、結果にパートが入っていませんでした。いまのパートはそのままです', 'error');
            return;
        }
        // パートのトラックの入れ替えは、まとめて元に戻せる。記録を開くのは結果が届いてから
        // (ジョブの間ずっと開いておくと、その間のほかの操作がこの記録に混ざるため)
        let created = 0, withReference = 0;
        await recordAsync('パートに分ける', async () => {
            if (result.bpm && Math.abs(result.bpm - engine.bpm) > 1e-6) setBpm(result.bpm);
            if (typeof result.grid_offset_sec === 'number') setGridOffset(result.grid_offset_sec);

            // 前に分けたパートは入れ替える (2 回押しても、同じパートが 2 本ずつにならない)。
            // MIDI ファイルから読み込んだお手本と、その練習のトラックは、原曲から作ったものではないので残す
            const fromMidi = new Set(engine.tracks.filter(t => t.role === 'part' && t.part === MIDI_PART).map(t => t.id));
            const replaced = (t: Track) => (t.role === 'part' && !fromMidi.has(t.id))
                || (t.role === 'practice' && !(t.practiceOf !== undefined && fromMidi.has(t.practiceOf)));
            for (const old of engine.tracks.filter(replaced)) {
                if (pianoRollRef.current?.getActiveTrackId() === old.id) pianoRollRef.current.switchToTrack(null);
                engine.removeTrack(old.id);
            }

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
                    // 採譜が出した強さも残す (「お手本をノートとして取り込む」で打ち込みに写したとき、強弱が付く)
                    track.referenceNotes = stem.notes.map(cloneNote);
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
        });
        setCoachPair({ referenceId: null, attemptId: null });
        bumpTracks();
        openLearn('song');
        setStatus(`パートに分けました（${created} パート、お手本 ${withReference} パート）。練習するパートの「このパートを練習する」を押してください`);
    }, [setBpm, setGridOffset, pianoRollRef, setCoachPair, bumpTracks, openLearn, setStatus, recordAsync]);

    /**
     * 原曲をパートに分けて採譜する（時間のかかる処理。進み具合は「パートに分ける」の下に出る）。
     * パートごとに、パートの音声とお手本を持つトラックを作る（`applyParts`）。
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
        const usedChart = chart ? chartId : null;

        const notice = await modelDownloadNotice('htdemucs_6s');
        setStatus(`原曲をパートに分けています…（${file.name}）パート分離 → 採譜 → 楽器の推定。数分かかります。${notice}`);
        try {
            const result = await jobTracker.run<unknown>('learn-parts', '/api/decompose', fd);
            partsChartId = usedChart;
            await applyParts(result);
        } catch (e) {
            if (e instanceof JobCancelledError) setStatus('パート分離を中止しました。いまのパートはそのままです');
            else setStatus(describeError(e), 'error');
        }
    }, [songFile, chart, chartId, applyChartGrid, setStatus, applyParts]);

    /**
     * そのパートを練習する。1 回の操作で、次をまとめて行う。
     * - 練習のトラックを選ぶ（無ければ作り、パートのトラックの隣に置く）
     * - そのトラックをピアノロールで開き、そのパートのお手本を重ねる
     * - お手本のノートが在る高さと小節まで、ピアノロールをスクロールする
     * - 差分チェックの組を「お手本 = このパート、打ち込み = 練習のトラック」にする
     * - パートの音声と練習のトラックを鳴るようにする（原曲のミュート・ソロは利用者に任せる）
     * - 練習画面（components/PracticeView.tsx）を開く
     *
     * @param partId - パートのトラックの ID
     */
    const practicePart = useCallback((partId: number) => {
        const part = engine.getTrack(partId);
        if (!part || !part.referenceNotes?.length) return;
        // 練習のトラックを作ること、ミュート・ソロを変えることは、まとめて元に戻せる
        const practice = record(`「${part.name}」を練習する`, () => {
            let target = practiceTrackOf(partId);
            if (!target) {
                target = engine.addTrack(`${part.name}の練習`);
                target.role = 'practice';
                target.part = part.part;
                target.practiceOf = part.id;
                engine.moveTrackAfter(target.id, part.id);
            }
            // パートの音声と、練習のトラックを鳴らす。ソロが在るなら、この 2 本もソロにする
            if (part.mute) engine.toggleMute(part.id);
            if (target.mute) engine.toggleMute(target.id);
            if (engine.tracks.some(t => t.solo)) { part.solo = true; target.solo = true; }
            return target;
        });

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
        openPractice(part.id, practice.id);
        setStatus(`「${part.name}」を練習します。水色のお手本を見ながら「${practice.name}」にノートを置き、「比べる」で確かめてください`);
    }, [setGhostChoice, setCoachPair, pianoRollRef, bumpTracks, setStatus, record, openPractice]);

    /**
     * お手本を、そのパートのトラックの打ち込みとして写す（採譜を自由に直したい人向け）。
     * 写すと差分チェックは 100% から始まる。呼ぶ前に、画面で確かめてもらう。元に戻せる（それまでの打ち込みに戻る）。
     *
     * @param partId - パートのトラックの ID
     */
    const adoptReference = useCallback((partId: number) => {
        const part = engine.getTrack(partId);
        if (!part || !part.referenceNotes?.length) return;
        const pr = pianoRollRef.current;
        // 開いているトラックのノートを書き戻してから写す (写した後に古い表示で上書きしない)
        pr?._saveToEngine?.();
        record(`「${part.name}」のお手本をノートとして取り込む`, () => {
            part.pianoNotes = part.referenceNotes!.map(n => ({ ...n }));
            if (part.mute) engine.toggleMute(part.id);
        });
        setCoachPair({ referenceId: part.id, attemptId: part.id });
        if (pr) {
            pr.switchToTrack(null);
            pr.switchToTrack(part.id);
        }
        bumpTracks();
        setStatus(`「${part.name}」のお手本を、ノートとして取り込みました（${part.pianoNotes.length} ノート）。元に戻すと、それまでの打ち込みに戻ります`);
    }, [pianoRollRef, setCoachPair, bumpTracks, setStatus, record]);

    /** 自由に作る: 空のトラックを 1 本作って、ピアノロールで開く。 */
    const startFree = useCallback(() => {
        const track = record('トラックを追加', () => engine.addTrack());
        pianoRollRef.current?.switchToTrack(track.id);
        setLeftTab('sound');
        bumpTracks();
        setStatus(`「${track.name}」を作りました。下のピアノロールをダブルクリックするとノートを置けます`);
    }, [pianoRollRef, setLeftTab, bumpTracks, setStatus, record]);

    return { importSong, finishChart, separateParts, applyParts, practicePart, adoptReference, startFree, placeAudio };
}
