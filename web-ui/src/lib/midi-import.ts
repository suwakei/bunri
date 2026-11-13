/**
 * bunri DAW — MIDI ファイルを読み込んで、トラックにする。
 *
 * ファイルを読むのは `lib/midi.ts` の `parseMidi`。ここは、その結果を「どのトラックを、どう読み込むか」に
 * 当てはめる部分と、読み込みで元のファイルから変わること（丸めなど）を画面の文にする部分。
 *
 * 読み込み方は、MIDI のトラックごとに 3 つ:
 * - 新しいトラック（`track`）: ノートを、新しいトラックの打ち込みにする
 * - お手本（`reference`）: ノートを、新しいトラックのお手本にする。打ち込みは空のまま。
 *   「学ぶ」タブのパートの一覧に出て、「このパートを練習する」で練習画面と差分チェックに使える
 * - 読み込まない（`skip`）
 */
import type { AudioEngine, PianoNote, Track } from './engine';
import { MIDI_PART } from './engine';
import type { MidiImportResult, MidiImportTrack } from './midi';

/** MIDI のトラック 1 本の読み込み方。 */
export type MidiImportMode = 'track' | 'reference' | 'skip';

/** 読み込み方の名前（選択肢の文）。 */
export const MIDI_MODE_LABEL: Record<MidiImportMode, string> = {
    track: '新しいトラックにする',
    reference: 'お手本として読み込む',
    skip: '読み込まない',
};

/** ピアノロールに表示できる高さ（C0〜B8）。 */
const MIN_OCTAVE = 0;
const MAX_OCTAVE = 8;

/**
 * 既定の読み込み方。ドラムのチャンネルは「読み込まない」、ほかは「新しいトラック」。
 *
 * ドラムのチャンネルは、ノートの高さが音程ではなく打楽器の種類を表す。ピアノロールに置いても
 * 意味の違う高さに並ぶので、頼まれない限り読み込まない。お手本にもできない（差分チェックの対象外）。
 */
export function defaultModes(result: MidiImportResult): MidiImportMode[] {
    return result.tracks.map((t) => (t.isDrum ? 'skip' : 'track'));
}

/** そのトラックで選べる読み込み方（ドラムは、お手本にできない）。 */
export function allowedModes(track: MidiImportTrack): MidiImportMode[] {
    return track.isDrum ? ['track', 'skip'] : ['track', 'reference', 'skip'];
}

/** プロジェクトが空か（クリップも、打ち込みも、お手本も無い）。空のときだけ、MIDI のテンポと拍子を反映する。 */
export function isEmptyProject(engine: Pick<AudioEngine, 'tracks'>): boolean {
    return engine.tracks.every((t) => t.clips.length === 0 && t.pianoNotes.length === 0 && !(t.referenceNotes && t.referenceNotes.length > 0));
}

/**
 * MIDI の拍子を、アプリの拍子の選択肢（1 小節の拍数）にする。選択肢に無い拍子は null。
 * @returns 4（4/4）、3（3/4）、6（6/8）のいずれか、または null
 */
export function beatsPerBarOf(signature: [number, number] | null): number | null {
    if (!signature) return null;
    const [numerator, denominator] = signature;
    if (denominator === 4 && (numerator === 4 || numerator === 3)) return numerator;
    if (denominator === 8 && numerator === 6) return 6;
    return null;
}

/** 読み込みの前に画面に出す、テンポの扱いの文。 */
export function tempoNotice(result: MidiImportResult, currentBpm: number, empty: boolean): string {
    if (result.bpm === null) return `この MIDI ファイルにはテンポが書かれていません。いまのテンポ（${currentBpm} BPM）で並べます`;
    if (empty) return `テンポを、MIDI ファイルの ${result.bpm} BPM に合わせます`;
    if (Math.abs(result.bpm - currentBpm) < 0.01) return `テンポは、いまと同じ ${currentBpm} BPM です`;
    return `MIDI ファイルは ${result.bpm} BPM ですが、いまのテンポ（${currentBpm} BPM）は変えません。ノートは、小節と拍の位置を保って並びます`;
}

/**
 * 読み込みで、元のファイルから変わること・落ちることを、画面に出す文にする。
 * 「読み込まない」にしたトラックのぶんは数えない（読み込まないものの丸めを知らせても、判断の材料にならない）。
 *
 * @param result - `parseMidi` の結果
 * @param modes - トラックごとの読み込み方
 * @returns 文のリスト（上から順に出す）
 */
export function lossNotices(result: MidiImportResult, modes: MidiImportMode[]): string[] {
    const notices: string[] = [];
    const chosen = result.tracks.filter((_, i) => modes[i] !== 'skip');
    const sum = (key: 'rounded' | 'merged' | 'unterminated') => chosen.reduce((total, track) => total + track[key], 0);
    const rounded = sum('rounded'), merged = sum('merged'), unterminated = sum('unterminated');
    const { tempoChanges } = result.loss;
    if (rounded > 0) notices.push(`16 分音符に合わせて、位置か長さを丸めたノートが ${rounded} 個あります（3 連符や細かい音符は、近い位置に寄ります）`);
    if (merged > 0) notices.push(`丸めると同じ位置に重なるノートを、1 つにまとめました（${merged} 個）`);
    if (unterminated > 0) notices.push(`止める合図の無いノートを、トラックの終わりまで伸ばしました（${unterminated} 個）`);
    if (tempoChanges > 0) notices.push(`途中のテンポの変化（${tempoChanges} 回）は反映されません。最初のテンポを使います`);
    const outOfRange = chosen.reduce((count, track) => count + track.notes.filter((n) => n.octave < MIN_OCTAVE || n.octave > MAX_OCTAVE).length, 0);
    if (outOfRange > 0) notices.push(`ピアノロールに表示できる高さ（C0〜B8）の外のノートが ${outOfRange} 個あります（読み込みますが、表示されず、鳴りません）`);
    notices.push('音の強さ（ベロシティ）は読み込みません。どのノートも同じ強さで鳴ります');
    return notices;
}

/** 読み込んだ結果（知らせの文に使う）。 */
export interface MidiImportOutcome {
    /** 作ったトラック。 */
    created: Track[];
    /** そのうち、お手本として読み込んだ本数。 */
    references: number;
    /** テンポを MIDI に合わせたなら、その値。 */
    bpm: number | null;
    /** 拍子を MIDI に合わせたなら、1 小節の拍数。 */
    beatsPerBar: number | null;
}

const plain = (notes: PianoNote[]): PianoNote[] => notes.map((n) => ({ note: n.note, octave: n.octave, step: n.step, length: n.length }));

/**
 * 読み込み方に従って、トラックを作る。テンポと拍子は、プロジェクトが空のときだけ決めて返す
 * （実際に変えるのは呼び出し側。画面の状態と一緒に変える必要があるため）。
 *
 * @param engine - トラックを足す先
 * @param result - `parseMidi` の結果
 * @param modes - トラックごとの読み込み方
 * @returns 作ったトラックと、合わせるテンポ・拍子
 */
export function applyMidiImport(engine: AudioEngine, result: MidiImportResult, modes: MidiImportMode[]): MidiImportOutcome {
    const empty = isEmptyProject(engine);
    const outcome: MidiImportOutcome = {
        created: [], references: 0,
        bpm: empty ? result.bpm : null,
        beatsPerBar: empty ? beatsPerBarOf(result.timeSignature) : null,
    };
    result.tracks.forEach((source, i) => {
        const mode = modes[i] ?? 'skip';
        if (mode === 'skip' || !allowedModes(source).includes(mode)) return;
        const track = engine.addTrack(source.name);
        if (mode === 'reference') {
            // パート分離で作るパートのトラックと同じ形にする (お手本を持ち、打ち込みは空)
            track.role = 'part';
            track.part = MIDI_PART;
            track.referenceNotes = plain(source.notes);
            track.pianoNotes = [];
            outcome.references += 1;
        } else {
            track.pianoNotes = plain(source.notes);
        }
        outcome.created.push(track);
    });
    return outcome;
}

/** 読み込んだ後の知らせの文。 */
export function importedMessage(fileName: string, outcome: MidiImportOutcome): string {
    const count = outcome.created.length;
    const tracks = outcome.references === 0 ? `${count} 本のトラック`
        : outcome.references === count ? `${count} 本のお手本`
            : `${count} 本のトラック（うちお手本 ${outcome.references} 本）`;
    const next = outcome.references > 0 ? '。お手本は「学ぶ」タブの「曲とパート」に出ます。「このパートを練習する」で始められます' : '';
    return `${fileName} から ${tracks}を読み込みました${next}`;
}
