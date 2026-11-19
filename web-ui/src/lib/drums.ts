/**
 * bunri DAW — ドラムの決まり（種類と高さの対応、ドラムのトラックの見分け方、差分の比べ方）。
 *
 * ドラムのノートの「高さ」は、音の高さではなく種類（キック・スネアなど）を表す。種類 → 高さの対応は、
 * ここ 1 か所に置く。次のものが、どれもここを見る。
 * - パート分離の結果（`drum_events`）をお手本のノートにするとき（lib/learn.ts の `applyParts`）
 * - ピアノロールの鍵盤の列に、種類の名前を出すとき（components/CenterArea.tsx）
 * - ドラムのトラックのノートを、種類ごとの音で鳴らすとき（lib/engine.ts → lib/drum-sound.ts）
 * - 差分の指摘の文を、音名ではなく種類の名前で書くとき（lib/coach.ts の `issueText`）
 *
 * 高さは GM（General MIDI）のドラムの並びに合わせてある（C4 = 60 の数え方で、キック 36・スネア 38・
 * クローズドハイハット 42・ロータム 45）。MIDI に書き出して、ほかの DAW のドラム音源で鳴らしても、同じ種類になる。
 *
 * 差分は、ドラムのお手本ではリズムだけを比べる（`diffModeOf`。backend/coach_diff.py の `mode="drums"`）。
 * 決まりと根拠は docs/coach-diff-design.md の「ドラムの差分」。
 */
import type { PianoNote, Track } from './engine';
import { normStep } from './grid';

/** 鳴らす音の種類（鍵盤の列の 1 行に当たる）。 */
export type DrumVoice = 'kick' | 'snare' | 'hat' | 'tom';

/** ドラムの 1 行（種類と、置く高さ）。 */
export interface DrumRow {
    voice: DrumVoice;
    /** 音名とオクターブ（ピアノロールの行） */
    note: string;
    octave: number;
    /** MIDI ノート番号（C4 = 60） */
    pitch: number;
    /** 画面に出す名前（docs/ui-terms.md） */
    label: string;
}

/** ドラムの行。低い順。 */
export const DRUM_ROWS: readonly DrumRow[] = [
    { voice: 'kick', note: 'C', octave: 2, pitch: 36, label: 'キック' },
    { voice: 'snare', note: 'D', octave: 2, pitch: 38, label: 'スネア' },
    { voice: 'hat', note: 'F#', octave: 2, pitch: 42, label: 'ハイハット・シンバル' },
    { voice: 'tom', note: 'A', octave: 2, pitch: 45, label: 'タム' },
];

/**
 * 採譜の結果の種類（`/api/decompose` の `drum_events[].type`）→ 行。
 * ドラムを種類ごとに分けて採譜したときは `kick` `snare` `toms` `cymbals`、
 * 分けなかったとき（スペクトル重心の振り分け）は `kick` `snare` `hihat`。
 * ハイハットとシンバルは、同じ行に置く（分けるモデルが、この 2 つを 1 つの音声にまとめて出すため）。
 */
const VOICE_OF_TYPE: Readonly<Record<string, DrumVoice>> = {
    kick: 'kick', snare: 'snare', hihat: 'hat', cymbals: 'hat', toms: 'tom',
};

const ROW_OF_VOICE = new Map(DRUM_ROWS.map((row) => [row.voice, row]));
const ROW_OF_PITCH = new Map(DRUM_ROWS.map((row) => [row.pitch, row]));
const ROW_OF_NAME = new Map(DRUM_ROWS.map((row) => [`${row.note}${row.octave}`, row]));

/** 採譜の結果の種類から、行を引く。知らない種類は null。 */
export function drumRowOfType(type: string): DrumRow | null {
    const voice = Object.prototype.hasOwnProperty.call(VOICE_OF_TYPE, type) ? VOICE_OF_TYPE[type] : undefined;
    return voice ? ROW_OF_VOICE.get(voice) ?? null : null;
}

/** MIDI ノート番号から、行を引く。ドラムの行でなければ null。 */
export function drumRowOfPitch(pitch: number): DrumRow | null {
    return ROW_OF_PITCH.get(pitch) ?? null;
}

/** ノートの高さから、行を引く。ドラムの行でなければ null。 */
export function drumRowOfNote(note: Pick<PianoNote, 'note' | 'octave'>): DrumRow | null {
    return ROW_OF_NAME.get(`${note.note}${note.octave}`) ?? null;
}

/** 採譜の結果のドラムのイベント。 */
export interface DrumEvent {
    type: string;
    /** 位置（ステップ。三連の曲では、三連の位置 = 小数になる） */
    step: number;
    /** 長さ（ステップ）。三連のグリッドで採譜したときに、1 より短い値が付くことが在る。無ければ 1 */
    length?: number;
    velocity?: number;
}

/**
 * 採譜の結果のドラムのイベントを、ノートにする。種類ごとに決まった高さへ置き、長さは 1 ステップ
 * （打音に長さは無い。差分も、ドラムでは長さを比べない。イベントが長さを持っていれば、それを使う）。
 * 位置と長さは 1/60 ステップの倍数にそろえる。強さは、持っていれば写す。知らない種類は置かない。
 */
export function drumEventsToNotes(events: readonly DrumEvent[]): PianoNote[] {
    const notes: PianoNote[] = [];
    for (const event of events) {
        const row = drumRowOfType(event.type);
        if (!row || !Number.isFinite(event.step) || event.step < 0) continue;
        const length = typeof event.length === 'number' && Number.isFinite(event.length) && event.length > 0 ? normStep(event.length) : 1;
        const note: PianoNote = { note: row.note, octave: row.octave, step: normStep(event.step), length: length > 0 ? length : 1 };
        if (typeof event.velocity === 'number' && Number.isFinite(event.velocity)) {
            note.velocity = Math.max(1, Math.min(127, Math.round(event.velocity)));
        }
        notes.push(note);
    }
    return notes;
}

/** ドラムのパートか（パートの名前で見る。`drums`、「その他」を分け直した `other_drums`）。 */
export function isDrumPart(part: string | undefined | null): boolean {
    return !!part && part.includes('drum');
}

/**
 * ドラムのトラックか。ドラムのパートのトラックと、その練習のトラック（練習の相手のパートで決める）。
 * ドラムのトラックでは、鍵盤の列に種類の名前を出し、ノートを種類ごとの音で鳴らし、キーの音・コードの音を出さない。
 *
 * @param track - 調べるトラック
 * @param trackOf - トラック ID からトラックを引く関数（練習の相手を引くのに使う）
 */
export function isDrumTrack(
    track: Pick<Track, 'part' | 'practiceOf'> | null | undefined,
    trackOf?: (id: number) => Pick<Track, 'part'> | undefined,
): boolean {
    if (!track) return false;
    if (isDrumPart(track.part)) return true;
    return track.practiceOf !== undefined && !!trackOf && isDrumPart(trackOf(track.practiceOf)?.part);
}

/**
 * 以前の分け方で作ったドラムのトラックか（お手本を持たず、採譜したリズムが、そのまま打ち込みに置いてある）。
 * そのまま開けて鳴らせるが、練習と差分チェックは、パートを分け直すと使える。
 */
export function isLegacyDrumPart(track: Pick<Track, 'role' | 'part' | 'referenceNotes'> | null | undefined): boolean {
    return !!track && track.role === 'part' && isDrumPart(track.part) && !(track.referenceNotes && track.referenceNotes.length > 0);
}

/** 以前の分け方のドラムで、「このパートを練習する」を押せない理由（押すと、知らせとして出る）。 */
export const LEGACY_DRUM_REASON = 'このドラムは、以前の分け方で作ったもので、お手本を持っていません。もう一度「パートに分ける」を押すと、ドラムもお手本になり、練習と差分チェックが使えます';

/** 差分の比べ方（`/api/coach/diff` の `mode`）。指定しなければ、ふつうの比べ方（高さ・位置・長さ）。 */
export type DiffMode = 'drums';

/**
 * そのお手本と比べるときの、差分の比べ方。お手本がドラムのパートなら `drums`（種類ごとの叩く位置だけを比べる）。
 * 差分チェックの段・練習画面・アシスタントの `check_diff` は、どれもこれで決める（どこから比べても同じ結果にする）。
 *
 * @param reference - お手本を持つトラック
 */
export function diffModeOf(reference: Pick<Track, 'part'> | null | undefined): DiffMode | undefined {
    return reference && isDrumPart(reference.part) ? 'drums' : undefined;
}

/** ドラムの差分の比べ方の説明（差分チェックと練習画面に、決まった文として出す。Claude は呼ばない）。 */
export const DRUM_DIFF_NOTE = 'ドラムは、種類（キック・スネアなど）ごとの叩く位置を比べています。長さは比べません。違う種類の行に置いた打音は、「抜け」と「余分なノート」として出ます。';

/** ドラムの差分で、Claude の説明を出さない理由（説明のボタンの代わりに出す）。 */
export const DRUM_EXPLAIN_NOTE = 'ドラムの差分は、Claude の説明には対応していません（Claude は呼びません。費用はかかりません）。上の件数と指摘の一覧から、抜けている種類と位置を確かめてください。';

/**
 * ノートの呼び名。ドラムの比べ方のときは種類の名前（「キック」）、ドラムの行でなければ音名（「E4」）。
 *
 * @param note - ノート
 * @param mode - 差分の比べ方
 */
export function noteLabel(note: Pick<PianoNote, 'note' | 'octave'>, mode?: DiffMode): string {
    const row = mode === 'drums' ? drumRowOfNote(note) : null;
    return row ? row.label : `${note.note}${note.octave}`;
}
