/**
 * bunri DAW — プロジェクトの文書（`.bunri` に入れる中身）を作る・画面に戻す。
 *
 * プロジェクトが何を含むかの大もとは、元に戻すの控え（lib/project-snapshot.ts の `captureProject`）。
 * トラック・役割・パート・練習の相手・ノート・お手本・クリップ・音量・パン・ミュート・ソロ・グリッドは、
 * 控えから写す（2 つ目の「何を保存するか」の一覧を作らない）。それに、控えに入っていないもの
 * — 音声のバイト列・カルテ・学ぶ流れの状態（重ねるお手本・差分チェックの組と結果）・学習の記録 — を足す。
 *
 * 文書の形（JSON）は sidecar の `bunri_file.write_project` / `read_project` と同じ。表の一覧は
 * docs/song-chart-design.md「プロジェクトの保存（.bunri v2）」。
 *
 * ## 状態の節（練習画面などが自分の状態を足す口）
 *
 * `registerProjectSection(名前, { version, save, load })` で登録すると、保存のときに `save()` の値が
 * 文書の `state[名前]` に入り（版の番号つき）、開いたときに `load(値)` が呼ばれる。値は JSON にできるもの。
 * 登録していない節（新しい版の bunri が書いたもの）は、開いて保存し直しても消さずに残す。
 * 状態を変えたら `useDaw().touchProject()` を呼ぶと、「保存していない変更」の印が付く。
 */
import engine, { cloneNote, type Clip, type PianoNote, type Track } from './engine';
import { apiFetch, errorDetail } from './api';
import { audioBufferToFloatWav, decodeWithSource, rememberSource, sha256Hex, sourceOf } from './audio-sources';
import { captureProject } from './project-snapshot';
import type { SongChart, WaveformPeaks } from './chart';
import { comparedOf, rememberCompared, type ComparedNotes, type DiffResult } from './coach';
import { HISTORY_KINDS, type LearnAttempt } from './learn-history';
import type { CoachPair, CoachResult, GhostChoice, LearnTab, LeftTab } from './store';

/** 文書の形の版（sidecar の `bunri_file.DOCUMENT_VERSION`）。 */
export const DOCUMENT_VERSION = 1;
/** 書き込んだアプリの版（診断用）。 */
export const APP_VERSION = '0.1.0';
/** 学ぶ流れの状態の節の版。 */
export const LEARN_STATE_VERSION = 1;

/** クリップ。`audio` は音声の元のバイト列のハッシュ（音声が無ければ null）。 */
export interface DocClip {
    name: string;
    offset: number;
    duration: number;
    audio: string | null;
}

/** トラック。`practiceOf` は相手のトラックの並びの番号。 */
export interface DocTrack {
    name: string;
    role: Track['role'] | null;
    part: string | null;
    practiceOf: number | null;
    gain: number;
    pan: number;
    mute: boolean;
    solo: boolean;
    notes: PianoNote[];
    /** お手本。お手本を持たないトラックは null（空の配列とは区別する） */
    referenceNotes: PianoNote[] | null;
    clips: DocClip[];
    extra?: Record<string, unknown>;
}

/** カルテ。カルテの中身は `/api/chart` の結果のまま。 */
export interface DocChart {
    chartId: string | null;
    chart: SongChart;
    /** 原曲のファイルのハッシュ（パートに分け直すとき、もう一度送る） */
    audio: string | null;
    audioName: string | null;
    peaks: WaveformPeaks | null;
}

/** 学習の記録 1 件（トラックは並びの番号で指す）。 */
export interface DocHistoryEntry extends Omit<LearnAttempt, 'id' | 'referenceId' | 'attemptId'> {
    referenceTrack: number | null;
    attemptTrack: number | null;
}

/** 状態の節。`version` は節ごとの版。 */
export type DocSection = { version: number } & Record<string, unknown>;

/** プロジェクトの文書。 */
export interface ProjectDocument {
    version: number;
    meta: { name: string; createdAt?: string | null; modifiedAt?: string | null; uuid?: string | null; appVersion?: string | null };
    grid: { bpm: number; beatsPerBar: number; gridOffset: number };
    tracks: DocTrack[];
    chart: DocChart | null;
    state: Record<string, DocSection>;
    history: DocHistoryEntry[];
    /** 保存のときだけ: 写しを入れる Claude の説明の鍵 */
    explanations?: { coach: string[] };
    // ---- 開いたときだけ（sidecar が足す） ----
    /** 作業用の写しの名前 */
    token?: string;
    /** 音声を取る URL の頭（`/api/project/<token>/audio/`） */
    audioBase?: string;
    /** 以前の形式（projects/*.json）から作った文書 */
    source?: { kind: 'legacy'; file: string };
    /** 戻したガイドと説明の写しの数 */
    restored?: { guide: number; coach: number };
}

// ---- 状態の節 ----

/** 練習画面などが、自分の状態をプロジェクトに入れるための登録。 */
export interface ProjectSection {
    /** 節の版。形を変えたら上げ、`load` で古い版を読めるようにする */
    version: number;
    /** 保存するときに呼ぶ。入れる値（JSON にできるもの）を返す。入れるものが無ければ null */
    save: () => Record<string, unknown> | null;
    /** 開いたときに呼ぶ。節が無いプロジェクト（新規・古いもの）では null */
    load: (value: DocSection | null) => void;
}

const sections = new Map<string, ProjectSection>();
/** 開いた文書に在った、登録されていない節（保存し直しても消さない）。 */
let unknownSections: Record<string, DocSection> = {};
/** この画面が自分で持つ節の名前（登録できない）。 */
const RESERVED = new Set(['learn', 'chart_view']);

/**
 * 状態の節を登録する。返す関数を呼ぶと登録を外す。
 * @param name - 節の名前（`practice` など）。`learn` と `chart_view` は使えない
 */
export function registerProjectSection(name: string, section: ProjectSection): () => void {
    if (RESERVED.has(name)) throw new Error(`節の名前「${name}」は使えません`);
    sections.set(name, section);
    return () => { if (sections.get(name) === section) sections.delete(name); };
}

// ---- 音声 ----

/** 保存で送る音声 1 つ。 */
export interface AudioPayload {
    hash: string;
    blob: Blob;
    name: string;
    /** `hash` が `blob` から計算したものか（開いたプロジェクトの音声は、元のハッシュを名乗っている） */
    verified: boolean;
}

const blobHashes = new WeakMap<Blob, Promise<string>>();

function hashOf(blob: Blob): Promise<string> {
    let p = blobHashes.get(blob);
    if (!p) { p = sha256Hex(blob); blobHashes.set(blob, p); }
    return p;
}

/** Blob の音声を送る形にする。 */
export async function payloadForBlob(blob: Blob, name: string): Promise<AudioPayload> {
    return { hash: await hashOf(blob), blob, name, verified: true };
}

/** AudioBuffer の音声を送る形にする（元のバイト列が無ければ、浮動小数の WAV にして覚える）。 */
export async function payloadForBuffer(buffer: AudioBuffer, fallbackName: string): Promise<AudioPayload> {
    let source = sourceOf(buffer);
    if (!source) {
        rememberSource(buffer, audioBufferToFloatWav(buffer), fallbackName.replace(/\.[^.]+$/, '') + '.wav');
        source = sourceOf(buffer)!;
    }
    if (source.hash) return { hash: source.hash, blob: source.blob, name: source.name, verified: false };
    return payloadForBlob(source.blob, source.name);
}

// ---- 作る ----

/** 文書を作るのに要る、画面の状態。 */
export interface BuildInput {
    name: string;
    createdAt?: string | null;
    uuid?: string | null;
    chart: SongChart | null;
    chartId: string | null;
    chartPeaks: WaveformPeaks | null;
    songFile: File | null;
    ghostChoice: GhostChoice;
    coachPair: CoachPair;
    coachResult: CoachResult | null;
    learnHistory: readonly LearnAttempt[];
    leftTab: LeftTab;
    learnTab: LearnTab;
    /** ピアノロールで開いているトラック */
    openTrackId: number | null;
    /** パートを、いまのカルテのグリッドで採譜したか（差分の説明にカルテを添えてよいか） */
    partsUseChart: boolean;
}

/** 学ぶ流れの状態の節（トラックは並びの番号で指す）。 */
export interface LearnState extends DocSection {
    ghostChoice: 'auto' | 'off' | { track: number };
    coachPair: { reference: number | null; attempt: number | null };
    /** `compared` は、比べたときのノートとお手本の出どころ（出どころは、以前の版が保存したものには無い） */
    coachResult: { reference: number; attempt: number; result: DiffResult; compared: ComparedNotes | null } | null;
    partsUseChart: boolean;
    leftTab: LeftTab;
    learnTab: LearnTab;
    openTrack: number | null;
}

/**
 * いまの画面から、保存する文書と、送る音声を作る。
 * トラックの中身は、元に戻すの控え（`captureProject`）から写す。
 */
export async function buildDocument(input: BuildInput): Promise<{ doc: ProjectDocument; audio: Map<string, AudioPayload> }> {
    const snapshot = captureProject(engine);
    const indexOf = new Map<number, number>();
    snapshot.tracks.forEach((t, i) => indexOf.set(t.ref.id, i));
    const idx = (id: number | null | undefined) => (id === null || id === undefined ? null : indexOf.get(id) ?? null);
    const audio = new Map<string, AudioPayload>();
    const add = (p: AudioPayload) => { if (!audio.has(p.hash)) audio.set(p.hash, p); return p.hash; };

    const tracks: DocTrack[] = [];
    for (const t of snapshot.tracks) {
        const clips: DocClip[] = [];
        for (const c of t.clips as Clip[]) {
            const missing = (t.ref.clips.find(x => x.buffer === c.buffer) as Clip | undefined)?.missing;
            clips.push({
                name: c.name, offset: c.offset, duration: c.duration,
                audio: missing ? null : add(await payloadForBuffer(c.buffer, c.name)),
            });
        }
        tracks.push({
            name: t.name, role: t.role ?? null, part: t.part ?? null, practiceOf: idx(t.practiceOf),
            gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo,
            notes: t.notes.map(cloneNote),
            referenceNotes: t.reference ? t.reference.map(cloneNote) : null,
            clips,
        });
    }

    let chart: DocChart | null = null;
    if (input.chart) {
        const song = input.songFile ? add(await payloadForBlob(input.songFile, input.songFile.name)) : null;
        chart = {
            chartId: input.chartId, chart: input.chart, audio: song,
            audioName: input.songFile?.name ?? input.chart.source?.filename ?? null, peaks: input.chartPeaks,
        };
    }

    const result = input.coachResult;
    const compared = result ? comparedOf(result.result) : undefined;
    const learn: LearnState = {
        version: LEARN_STATE_VERSION,
        ghostChoice: typeof input.ghostChoice === 'number'
            ? (idx(input.ghostChoice) === null ? 'auto' : { track: idx(input.ghostChoice)! })
            : input.ghostChoice,
        coachPair: { reference: idx(input.coachPair.referenceId), attempt: idx(input.coachPair.attemptId) },
        coachResult: result && idx(result.referenceId) !== null && idx(result.attemptId) !== null
            ? { reference: idx(result.referenceId)!, attempt: idx(result.attemptId)!, result: result.result, compared: compared ?? null }
            : null,
        partsUseChart: input.partsUseChart,
        leftTab: input.leftTab,
        learnTab: input.learnTab,
        openTrack: idx(input.openTrackId),
    };

    const state: Record<string, DocSection> = { ...unknownSections, learn };
    for (const [name, section] of sections) {
        const value = section.save();
        if (value) state[name] = { ...value, version: section.version };
        else delete state[name];
    }

    const history: DocHistoryEntry[] = input.learnHistory.map(({ id: _id, referenceId, attemptId, ...rest }) => ({
        ...rest, referenceTrack: idx(referenceId), attemptTrack: idx(attemptId),
    }));
    const coachKeys = [...new Set(input.learnHistory.map(a => a.explanationId).filter((k): k is string => !!k))];

    const doc: ProjectDocument = {
        version: DOCUMENT_VERSION,
        meta: { name: input.name, createdAt: input.createdAt ?? null, uuid: input.uuid ?? null, appVersion: APP_VERSION },
        grid: { bpm: snapshot.grid.bpm, beatsPerBar: snapshot.grid.beatsPerBar, gridOffset: snapshot.grid.offsetSec },
        tracks, chart, state, history,
        explanations: { coach: coachKeys },
    };
    return { doc, audio };
}

/** 文書の中の、音声のハッシュを付け替える（開いたプロジェクトの音声を、手元のバイト列のハッシュで送り直すとき）。 */
function remapAudio(doc: ProjectDocument, from: string, to: string): void {
    for (const t of doc.tracks) for (const c of t.clips) if (c.audio === from) c.audio = to;
    if (doc.chart?.audio === from) doc.chart.audio = to;
}

/**
 * 保存に要る音声のうち、sidecar がまだ持っていないものだけを送る。
 * @param base - いま開いている作業用の写し（そこに在る音声は送らない）
 * @param onProgress - 送った数と、送る数
 */
export async function uploadAudio(
    doc: ProjectDocument, audio: Map<string, AudioPayload>, base: string | null,
    onProgress?: (done: number, total: number) => void,
): Promise<void> {
    const hashes = [...new Set([...doc.tracks.flatMap(t => t.clips.map(c => c.audio)), doc.chart?.audio ?? null].filter((h): h is string => !!h))];
    const resp = await apiFetch('/api/project/audio/missing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, hashes }),
    });
    if (!resp.ok) throw new Error('音声を確かめられませんでした。' + await errorDetail(resp));
    const missing = ((await resp.json()) as { missing: string[] }).missing;
    let done = 0;
    for (const claimed of missing) {
        const payload = audio.get(claimed);
        if (!payload) throw new Error('保存する音声が見つかりません');
        let hash = claimed;
        if (!payload.verified) {
            // 開いたプロジェクトの音声で、写しに無くなっていた (整理で消したなど)。手元のバイト列で送り直す
            hash = await hashOf(payload.blob);
            if (hash !== claimed) remapAudio(doc, claimed, hash);
        }
        const put = await apiFetch(`/api/project/audio/${hash}?name=${encodeURIComponent(payload.name)}`, {
            method: 'PUT', body: payload.blob,
        });
        if (!put.ok) throw new Error('音声を送れませんでした。' + await errorDetail(put));
        onProgress?.(++done, missing.length);
    }
}

// ---- 画面に戻す ----

/** 文書を画面に戻すのに要る、状態の setter。 */
export interface ApplyTarget {
    setBpm: (v: number) => void;
    setBeatsPerBar: (v: number) => void;
    setGridOffset: (sec: number) => void;
    setChartResult: (r: { chart_id: string; chart: SongChart; peaks?: WaveformPeaks; glossary: Record<string, Record<string, string>> }) => void;
    clearChart: () => void;
    setSongFile: (f: File | null) => void;
    setGhostChoice: (c: GhostChoice) => void;
    setCoachPair: (p: CoachPair) => void;
    setCoachResult: (r: CoachResult | null) => void;
    setLearnHistory: (list: LearnAttempt[]) => void;
    setLeftTab: (t: LeftTab) => void;
    setLearnTab: (t: LearnTab) => void;
    setChartIdOfParts: (id: string | null) => void;
    /** ピアノロール（開いているトラックを閉じる・開く） */
    pianoRoll: { switchToTrack?: (id: number | null) => void } | null;
}

/** 戻した結果。 */
export interface ApplyResult {
    tracks: number;
    /** 音声の無いクリップの数（以前の形式、か音声を読めなかった） */
    missingClips: number;
}

/** 音声の無いクリップの、無音の置き場所（小さくするため 8 kHz のモノラル）。 */
function placeholderBuffer(duration: number): AudioBuffer {
    const rate = 8000;
    return engine.ctx!.createBuffer(1, Math.max(1, Math.round(Math.max(0, duration) * rate)), rate);
}

/** 同時に取ってくる音声の数（大きな WAV を一度にたくさんデコードしない）。 */
const FETCH_CONCURRENCY = 3;

async function fetchAudio(doc: ProjectDocument): Promise<Map<string, { buffer: AudioBuffer; blob: Blob; media: string }>> {
    const names = new Map<string, string>();
    for (const t of doc.tracks) for (const c of t.clips) if (c.audio && !names.has(c.audio)) names.set(c.audio, c.name);
    if (doc.chart?.audio && !names.has(doc.chart.audio)) names.set(doc.chart.audio, doc.chart.audioName ?? 'song');
    const out = new Map<string, { buffer: AudioBuffer; blob: Blob; media: string }>();
    if (!doc.audioBase || names.size === 0) return out;
    const queue = [...names.entries()];
    const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
            const [hash, name] = next;
            try {
                const resp = await apiFetch(doc.audioBase + hash);
                if (!resp.ok) continue;
                const media = resp.headers.get('content-type') ?? '';
                const bytes = await resp.arrayBuffer();
                const blob = new Blob([bytes], { type: media });
                const buffer = await decodeWithSource(engine.ctx!, bytes, name, hash);
                out.set(hash, { buffer, blob, media });
            } catch (e) {
                console.warn(`音声を読めませんでした（${name}）:`, e);
            }
        }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
    return out;
}

/**
 * 文書を画面に戻す。いまのトラックは全部外してから作り直す（呼ぶ前に、保存していない変更を確かめること）。
 * カルテの解析も Claude の呼び出しもしない（カルテは文書の中身をそのまま使い、ガイドと説明は sidecar が
 * 写しを保存の置き場へ戻してあるので、それぞれの段が保存済みとして取ってくる）。
 */
export async function applyDocument(doc: ProjectDocument, target: ApplyTarget): Promise<ApplyResult> {
    engine.init();
    engine.stop();
    target.pianoRoll?.switchToTrack?.(null);
    const fetched = await fetchAudio(doc);

    for (const t of [...engine.tracks]) engine.removeTrack(t.id);
    target.setBpm(doc.grid.bpm || 120);
    target.setBeatsPerBar(doc.grid.beatsPerBar || 4);
    target.setGridOffset(doc.grid.gridOffset || 0);

    let missingClips = 0;
    const created: Track[] = [];
    for (const dt of doc.tracks) {
        const track = engine.addTrack(dt.name || undefined);
        if (dt.role) track.role = dt.role;
        if (dt.part) track.part = dt.part;
        engine.updateTrackGain(track.id, Number(dt.gain) || 0);
        engine.updateTrackPan(track.id, Number(dt.pan) || 0);
        if (dt.mute && !track.mute) engine.toggleMute(track.id);
        track.solo = !!dt.solo;
        track.pianoNotes = (dt.notes ?? []).map(n => ({ ...n }));
        track.referenceNotes = dt.referenceNotes ? dt.referenceNotes.map(n => ({ ...n })) : undefined;
        track.clips = (dt.clips ?? []).map((c): Clip => {
            const got = c.audio ? fetched.get(c.audio) : undefined;
            if (got) return { buffer: got.buffer, offset: c.offset, name: c.name, duration: c.duration || got.buffer.duration };
            missingClips++;
            return { buffer: placeholderBuffer(c.duration), offset: c.offset, name: c.name, duration: c.duration, missing: true };
        });
        created.push(track);
    }
    doc.tracks.forEach((dt, i) => {
        if (typeof dt.practiceOf === 'number' && created[dt.practiceOf]) created[i].practiceOf = created[dt.practiceOf].id;
    });
    const idOf = (index: number | null | undefined) => (typeof index === 'number' && created[index] ? created[index].id : null);

    // カルテ（解析しない）。用語の辞書だけ、カルテの API から取る
    const chartId = doc.chart?.chartId ?? null;
    if (doc.chart && chartId) {
        let glossary: Record<string, Record<string, string>> = {};
        try {
            const resp = await apiFetch(`/api/chart/${encodeURIComponent(chartId)}`);
            if (resp.ok) glossary = (await resp.json()).glossary ?? {};
        } catch { /* 用語の説明が出ないだけ */ }
        target.setChartResult({ chart_id: chartId, chart: doc.chart.chart, peaks: doc.chart.peaks ?? undefined, glossary });
    } else {
        target.clearChart();
    }

    // 原曲のファイル（パートに分け直すとき、もう一度送る）
    const songIndex = created.findIndex(t => t.role === 'song');
    const songHash = doc.chart?.audio ?? (songIndex >= 0 ? doc.tracks[songIndex].clips[0]?.audio ?? null : null);
    const song = songHash ? fetched.get(songHash) : undefined;
    if (song) {
        const base = (doc.chart?.audioName ?? 'song').replace(/\.[^.]+$/, '');
        const name = song.media.includes('wav') ? `${base}.wav` : (doc.chart?.audioName ?? base);
        target.setSongFile(new File([song.blob], name, { type: song.media }));
    } else {
        target.setSongFile(null);
    }

    // 学ぶ流れの状態
    const learn = doc.state?.learn as LearnState | undefined;
    if (learn) {
        const ghost = learn.ghostChoice;
        target.setGhostChoice(typeof ghost === 'object' && ghost ? (idOf(ghost.track) ?? 'auto') : (ghost === 'off' ? 'off' : 'auto'));
        target.setCoachPair({ referenceId: idOf(learn.coachPair?.reference), attemptId: idOf(learn.coachPair?.attempt) });
        const r = learn.coachResult;
        const refId = r ? idOf(r.reference) : null, attId = r ? idOf(r.attempt) : null;
        if (r && refId !== null && attId !== null) {
            if (r.compared) rememberCompared(r.result, r.compared);
            target.setCoachResult({ referenceId: refId, attemptId: attId, result: r.result });
        } else {
            target.setCoachResult(null);
        }
        target.setChartIdOfParts(learn.partsUseChart && chartId ? chartId : null);
        if (learn.leftTab) target.setLeftTab(learn.leftTab);
        if (learn.learnTab) target.setLearnTab(learn.learnTab);
    } else {
        target.setGhostChoice('auto');
        target.setCoachPair({ referenceId: null, attemptId: null });
        target.setCoachResult(null);
        target.setChartIdOfParts(null);
    }

    // 学習の記録
    target.setLearnHistory((doc.history ?? []).map((h, i): LearnAttempt => {
        const counts = {} as LearnAttempt['counts'];
        for (const kind of HISTORY_KINDS) counts[kind] = Number(h.counts?.[kind]) || 0;
        return {
            id: i + 1, recordedAt: h.recordedAt, referenceId: idOf(h.referenceTrack), attemptId: idOf(h.attemptTrack),
            part: h.part ?? null, startBar: h.startBar, endBar: h.endBar, referenceCount: h.referenceCount,
            matched: h.matched, matchRate: h.matchRate, counts, explanationId: h.explanationId ?? null,
        };
    }));

    // 状態の節（練習画面など）。登録していない節は、保存し直すときにそのまま残す
    unknownSections = {};
    for (const [name, value] of Object.entries(doc.state ?? {})) {
        if (RESERVED.has(name)) continue;
        if (!sections.has(name)) unknownSections[name] = value;
    }
    for (const [name, section] of sections) section.load(doc.state?.[name] ?? null);

    const open = idOf(learn?.openTrack);
    if (open !== null) target.pianoRoll?.switchToTrack?.(open);
    // 開いた音声を、裏で Rust の engine に送り始める (デスクトップ版。前のプロジェクトの音声は捨てる)
    engine.syncNative();
    return { tracks: created.length, missingClips };
}

/** 新しいプロジェクトにするとき、登録した節に「無い」を知らせ、残していた節を忘れる。 */
export function resetSections(): void {
    unknownSections = {};
    for (const section of sections.values()) section.load(null);
}

/** 音声の無いクリップ（以前の形式から開いた、か音声を読めなかった）。 */
export function missingClips(): { track: Track; index: number; clip: Clip }[] {
    const out: { track: Track; index: number; clip: Clip }[] = [];
    for (const track of engine.tracks) track.clips.forEach((clip, index) => { if (clip.missing) out.push({ track, index, clip }); });
    return out;
}
