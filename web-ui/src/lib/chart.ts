/**
 * bunri DAW — 楽曲カルテ（第1層）の型定義とヘルパー
 *
 * バックエンドの `song_chart.py` が返す構造に対応する。
 * カルテは第2層（再現ガイド）と第3層（差分コーチ）が参照する唯一の正であり、
 * 画面表示はここからの派生ビューとして作る。
 */

/** ビートグリッド。BPM・ダウンビート・実測ビート列を持つ */
export interface ChartGrid {
    /** テンポ（BPM） */
    bpm: number;
    /** BPM 推定の確信度（0.0〜1.0） */
    bpm_confidence: number;
    /** `"auto"` = 自動検出、`"user"` = ユーザーが補正した値 */
    bpm_source: 'auto' | 'user';
    /** 1拍目の位置（秒） */
    downbeat_offset_sec: number;
    /** 拍子。`[1小節の拍数, 音価]`（例: `[4, 4]`） */
    time_signature: [number, number];
    /** 実測ビート位置（秒）の昇順リスト。テンポ揺れを表現できる */
    beat_times_sec: number[];
    /** ユーザーがグリッドを確認・確定したか */
    user_confirmed: boolean;
}

/** キー（調）の推定結果 */
export interface ChartKey {
    /** 主音の音名。判定できなかった場合は null */
    tonic: string | null;
    /** 長調か短調か。判定できなかった場合は null */
    mode: 'major' | 'minor' | null;
    /** 確信度（0.0〜1.0） */
    confidence: number;
    /** 次点の候補 */
    alternatives: { tonic: string; mode: string; confidence: number }[];
}

/** 構成上のまとまり（セクション） */
export interface ChartSection {
    /** 区間の識別子（`"S1"`, `"S2"`, …） */
    id: string;
    /** ユーザーが確定したラベル。未確定なら null */
    label: string | null;
    /** 自動推定によるラベルの提案。断定ではない */
    suggested_label: string | null;
    /** 提案の確信度（0.0〜1.0） */
    suggested_confidence: number;
    /** 開始小節（1始まり） */
    start_bar: number;
    /** 終了小節（含む） */
    end_bar: number;
    /** 開始位置（秒） */
    start_sec: number;
    /** 終了位置（秒） */
    end_sec: number;
    /** 音響的に似た区間に振られる同じ記号（`"A"`, `"B"`, …） */
    repeat_group: string;
    /** 区間の特徴量 */
    features: { rms_db: number; onset_density: number };
}

/** コードイベント。時間参照は小節・拍の絶対位置で持つ */
export interface ChartChord {
    /** 開始小節（1始まり） */
    bar: number;
    /** 小節内の開始拍（1始まり） */
    beat: number;
    /** 開始ビートの通し番号（0始まり） */
    beat_index: number;
    /** 継続する拍数 */
    beat_count: number;
    /** 開始位置（秒） */
    start_sec: number;
    /** 終了位置（秒） */
    end_sec: number;
    /** ルート音名 */
    root: string;
    /** コード品質（`"maj"`, `"min7"` など） */
    quality: string;
    /** 表示用コード名（例: `"Cmaj7"`） */
    symbol: string;
    /** ディグリー表記（例: `"I"`）。キーが不明なら null */
    degree: string | null;
    /** 確信度（0.0〜1.0） */
    confidence: number;
}

/** 帯域ごとのエネルギー */
export interface SpectrumBand {
    name: string;
    hz: [number, number];
    energy_db: number;
}

/** 曲全体のミックス特性。ステム別の値ではない */
export interface ChartMix {
    loudness_lufs: number | null;
    peak_dbfs: number | null;
    dynamic_range_db: number | null;
    /** 0.0（モノラル）〜1.0（左右に広い）。モノラル音源では null */
    stereo_width: number | null;
    /** 低音が中央にまとまっているか。モノラル音源では null */
    bass_mono: boolean | null;
    reverb_tail_sec: number | null;
    spectrum_bands: SpectrumBand[];
}

/** 楽曲カルテ本体 */
export interface SongChart {
    version: number;
    source: { filename: string; duration_sec: number };
    grid: ChartGrid;
    key: ChartKey;
    sections: ChartSection[];
    chords: ChartChord[];
    mix: ChartMix;
    /** 検出できなかった項目とその理由。値を出さない代わりに理由を示す */
    unavailable: Record<string, string>;
}

/** 波形描画用のピーク配列。カルテ本体には含まれない */
export interface WaveformPeaks {
    points: number;
    duration_sec: number;
    min: number[];
    max: number[];
}

/** 用語辞書。多言語対応の器として言語マップ構造になっている */
export type Glossary = Record<string, Record<string, string>>;

/** `/api/chart` と `/api/chart/regrid` のレスポンス */
export interface ChartResponse {
    chart_id: string;
    chart: SongChart;
    peaks?: WaveformPeaks;
    glossary: Glossary;
}

/** 確信度の3段階 */
export type ConfidenceTier = 'certain' | 'likely' | 'unsure';

/**
 * 確信度の生値を初心者向けの3段階に丸める。
 *
 * 「キーはCメジャー（0.71）」と出されても初心者には判断材料にならないため、
 * 画面表示には段階を使う。バックエンドの `song_chart.confidence_tier` と
 * 同じ閾値を使うこと。
 *
 * @param value - 確信度（0.0〜1.0）。null は最低段階として扱う
 * @returns 3段階のいずれか
 */
export function confidenceTier(value: number | null | undefined): ConfidenceTier {
    if (value === null || value === undefined) return 'unsure';
    if (value >= 0.7) return 'certain';
    if (value >= 0.4) return 'likely';
    return 'unsure';
}

/** 確信度の段階ごとの表示ラベルと色 */
export const TIER_DISPLAY: Record<ConfidenceTier, { label: string; color: string }> = {
    certain: { label: '確実', color: 'var(--secondary)' },
    likely: { label: 'たぶん', color: 'var(--accent)' },
    unsure: { label: '自信なし', color: 'var(--danger)' },
};

/** セクションの提案ラベルを日本語表示にする対応表 */
export const SECTION_LABEL_JA: Record<string, string> = {
    intro: 'イントロ',
    verse: 'Aメロ',
    chorus: 'サビ',
    bridge: 'Bメロ',
    outro: 'アウトロ',
};

/** 帯域名の日本語表示 */
export const BAND_LABEL_JA: Record<string, string> = {
    sub: '重低音',
    low: '低音',
    low_mid: '中低音',
    mid: '中音',
    high_mid: '中高音',
    high: '高音',
};

/**
 * 秒を `M:SS` 形式の文字列にする。
 *
 * @param seconds - 秒数
 * @returns `"1:23"` のような文字列
 */
export function formatTime(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 秒の位置がどの小節・拍に当たるかを実測ビート列から求める。
 *
 * 固定 BPM から計算せず実測列を引くのは、テンポが揺れる楽曲でも
 * 正確な対応を保つため。
 *
 * @param seconds - 位置（秒）
 * @param grid - ビートグリッド
 * @returns `{bar, beat}`（どちらも1始まり）。ビート列が空なら null
 */
export function secondsToBarBeat(seconds: number, grid: ChartGrid): { bar: number; beat: number } | null {
    const beats = grid.beat_times_sec;
    if (!beats.length) return null;

    let index = 0;
    while (index + 1 < beats.length && beats[index + 1] <= seconds) index++;

    const perBar = Math.max(1, grid.time_signature[0]);
    return { bar: Math.floor(index / perBar) + 1, beat: (index % perBar) + 1 };
}
