/**
 * bunri DAW — エフェクト（音声のクリップにかける加工）の定義と、かける処理。
 *
 * 左パネルの「音作り」→「FX」（components/LeftPanel.tsx）と、アシスタントのツール `apply_effect`
 * （lib/assistant-tools-app.ts）が、同じ定義と同じ処理を使う。
 *
 * かける処理は API（`/api/effects/{種類}`）が行う。ここは、クリップを WAV にして送り、返ってきた音声を
 * クリップにする（元のクリップは書き換えない。差し替えるのは呼ぶ側で、元に戻す履歴に載せて行う）。
 *
 * ## 縮めたクリップとの関係
 *
 * エフェクトは、クリップの**見えている範囲だけ**にかける（縮めて隠したところは送らない）。結果は新しい音声になり、
 * かけた後のクリップは、その音声の頭から全体を鳴らす（`audioStart` は 0 に戻る。縮める前の範囲へは、端を引いても
 * 戻らない。戻すときは「元に戻す」）。フェードは、音声に焼き込まずにクリップの設定として残す（かけた後も、
 * つまみで変えられる。長さが変わるエフェクトでは、新しい長さに収める）。同じ音声を指すほかのクリップ（分割の
 * もう片方・複製）は変わらない。
 */
import engine, { type Clip } from './engine';
import { apiFetch, errorDetail } from './api';
import { decodeWithSource } from './audio-sources';
import { audioStartOf, fadeInOf, fadeOutOf, playLength, setClipFades } from './clip';

/**
 * FX パネルで表示・操作する単一パラメータの定義。
 * `FX_PARAMS` 定数の各エントリーに対応する。
 *
 * @property id - API に送信するパラメータキー（例: `"threshold"`）
 * @property label - UI 上に表示するラベル文字列（例: `"しきい値 (dB)"`）
 * @property hint - つまみにマウスを載せたときに出す説明（ツールチップ）
 * @property min - スライダーの最小値
 * @property max - スライダーの最大値
 * @property step - スライダーのステップ幅
 * @property def - デフォルト値（エフェクト切り替え時に適用される）
 */
export interface FxParamDef {
    id: string;
    label: string;
    hint: string;
    min: number;
    max: number;
    step: number;
    def: number;
}

/**
 * エフェクト種別ごとのパラメータ定義マップ。
 * キーは `/api/effects/{name}` のパス部分（`"eq"`, `"reverb"` など）と一致する。
 * 値は空配列の場合、追加パラメータなし（例: `"normalize"`）。
 */
// ---- FXパラメータ定義 ----
export const FX_PARAMS: Record<string, FxParamDef[]> = {
    eq: [
        { id: 'low', label: '低域 (dB)', hint: '低い音（ベースやキックのあたり）を強める・弱める', min: -12, max: 12, step: 1, def: 0 },
        { id: 'mid', label: '中域 (dB)', hint: '真ん中の高さの音（歌やギターのあたり）を強める・弱める', min: -12, max: 12, step: 1, def: 0 },
        { id: 'high', label: '高域 (dB)', hint: '高い音（シンバルや息の音のあたり）を強める・弱める', min: -12, max: 12, step: 1, def: 0 },
    ],
    compressor: [
        { id: 'threshold', label: 'しきい値 (dB)', hint: 'この大きさを超えた音を抑えます。下げるほど、多くの音が抑えられます', min: -40, max: 0, step: 1, def: -20 },
        { id: 'ratio', label: '圧縮比', hint: '超えたぶんをどれだけ抑えるか。大きいほど強く抑えます', min: 1, max: 20, step: 0.5, def: 4 },
    ],
    reverb: [
        { id: 'room_size', label: '部屋の広さ', hint: '響きの長さ。大きいほど、広い部屋のように長く響きます', min: 0, max: 1, step: 0.05, def: 0.5 },
        { id: 'wet', label: 'エフェクト音の量', hint: '響きをどれだけ混ぜるか。0 で元の音だけになります', min: 0, max: 1, step: 0.05, def: 0.3 },
    ],
    delay: [
        { id: 'delay_ms', label: '遅れの時間 (ms)', hint: 'やまびこが返ってくるまでの時間（ミリ秒）', min: 50, max: 2000, step: 10, def: 300 },
        { id: 'feedback', label: '繰り返しの量', hint: 'やまびこが何度も繰り返す度合い。大きいほど長く続きます', min: 0, max: 0.9, step: 0.05, def: 0.4 },
        { id: 'wet', label: 'エフェクト音の量', hint: 'やまびこをどれだけ混ぜるか。0 で元の音だけになります', min: 0, max: 1, step: 0.05, def: 0.3 },
    ],
    normalize: [],
    pitch_shift: [
        { id: 'semitones', label: '半音', hint: '音の高さを半音単位で上げ下げします（12 で 1 オクターブ）', min: -12, max: 12, step: 1, def: 0 },
    ],
    time_stretch: [
        { id: 'rate', label: '速度', hint: '音の高さを変えずに速さを変えます（2 で 2 倍速、長さは半分）', min: 0.25, max: 3, step: 0.05, def: 1 },
    ],
};

/**
 * エフェクトの日本語の名前。キーは `FX_PARAMS` と同じ。
 * 選択肢と、適用したときの知らせに使う（識別子の `pitch_shift` などを画面に出さない）。
 */
export const FX_LABELS: Record<string, string> = {
    eq: 'EQ（3 バンド）',
    compressor: 'コンプレッサー',
    reverb: 'リバーブ',
    delay: 'ディレイ',
    normalize: 'ノーマライズ',
    pitch_shift: 'ピッチシフト',
    time_stretch: 'タイムストレッチ',
};

/** その種類のパラメータの既定の値。 */
export function defaultFxParams(fxType: string): Record<string, number> {
    const defs: Record<string, number> = {};
    (FX_PARAMS[fxType] || []).forEach((p) => { defs[p.id] = p.def; });
    return defs;
}

/**
 * クリップの見えている範囲の音声。縮めていないクリップは、音声をそのまま返す（写さない）。
 * 縮めたクリップは、その範囲だけを写した新しい音声を返す（フェードは掛けない）。
 */
export function visibleBuffer(clip: Clip): AudioBuffer {
    const { buffer } = clip;
    const first = Math.round(audioStartOf(clip) * buffer.sampleRate);
    const frames = Math.min(buffer.length - first, Math.round(playLength(clip) * buffer.sampleRate));
    if (!Number.isFinite(first) || !Number.isFinite(frames) || (first <= 0 && frames >= buffer.length)) return buffer;
    engine.init();
    const out = engine.ctx!.createBuffer(buffer.numberOfChannels, Math.max(1, frames), buffer.sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(first, first + Math.max(0, frames)));
    }
    return out;
}

/**
 * クリップにエフェクトをかけた、新しいクリップを作る（位置は同じ。名前の後ろに種類を足す）。
 * 元のクリップもトラックも書き換えない。かけるのは見えている範囲だけで、フェードはクリップの設定として残す
 * （このファイルの頭の「縮めたクリップとの関係」）。
 *
 * @param clip - かける前のクリップ
 * @param fxType - 種類（`FX_PARAMS` のキー）
 * @param params - パラメータ
 * @throws かけられなかった場合（理由つき）
 */
export async function effectedClip(clip: Clip, fxType: string, params: Record<string, number>): Promise<Clip> {
    engine.init();
    const wavBlob = engine._audioBufferToWav(visibleBuffer(clip));
    const fd = new FormData();
    fd.append('file', wavBlob, 'clip.wav');
    fd.append('params', JSON.stringify(params));
    const resp = await apiFetch(`/api/effects/${fxType}`, { method: 'POST', body: fd });
    if (!resp.ok) throw new Error(await errorDetail(resp));
    const buf = await (await resp.blob()).arrayBuffer();
    // 元のバイト列を覚えておく (プロジェクトの保存で、そのまま入れる。lib/audio-sources.ts)
    const buffer = await decodeWithSource(engine.ctx!, buf, `${clip.name}[${fxType}].wav`);
    const next: Clip = { buffer, offset: clip.offset, name: `${clip.name}[${fxType}]`, duration: buffer.duration };
    // フェードは残す (新しい長さに収める)。フェードの無いクリップには、項目を付けない
    return setClipFades(next, { fadeIn: fadeInOf(clip), fadeOut: fadeOutOf(clip) });
}
