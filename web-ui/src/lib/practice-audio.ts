/**
 * bunri DAW — 練習画面の「速度」のための、伸ばした音声を用意する。
 *
 * パートの音声のうち区間ループの範囲だけを切り出し、音の高さを変えずに伸ばして（lib/stretch.ts の WSOLA）、
 * AudioBuffer にする。計算は Web Worker で行う（使えない環境では、その場で行う）。
 *
 * 同じトラック・同じ区間・同じ速度は、作り直さずに取っておいたものを返す。取っておくのは最後の 3 つまで
 * （50% で 20 秒の区間なら、1 つ 14 MB ほど。低スペックの PC でメモリを使いすぎないように）。
 * 区間の前後に少し余白を付けて伸ばし、伸ばした後で余白を切り落とす（窓の端で音が細らないように）。
 */
import { extractRegion, stretchedLength, wsolaStretch } from './stretch';
import type { Clip, StretchedAudio } from './engine';

/** 区間の前後に付ける余白（秒）。窓（46 ミリ秒）より十分長く取る */
const MARGIN_SEC = 0.1;
/** 取っておく数 */
const CACHE_SIZE = 3;

/** 伸ばした音声を作るのに要る材料。 */
export interface StretchRequest {
    trackId: number;
    clips: Clip[];
    start: number;
    end: number;
    rate: number;
}

/** 伸ばすのにかかった時間（ミリ秒）と、作り直さずに返したか。画面の説明とテストに使う。 */
export interface StretchInfo {
    ms: number;
    cached: boolean;
}

const cache: { key: string; clips: Clip[]; audio: StretchedAudio }[] = [];
let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, { resolve: (c: Float32Array[]) => void; reject: (e: Error) => void }>();

/** 取っておく鍵（トラック・区間・速度）。クリップは中身ではなく同じものかで見る（別に照らし合わせる）。 */
function keyOf(req: Pick<StretchRequest, 'trackId' | 'start' | 'end' | 'rate'>): string {
    return `${req.trackId}:${req.start.toFixed(4)}:${req.end.toFixed(4)}:${req.rate}`;
}

/** クリップの並びが同じか（同じ音声・同じ位置）。 */
function sameClips(a: Clip[], b: Clip[]): boolean {
    return a.length === b.length && a.every((c, i) => c.buffer === b[i].buffer && c.offset === b[i].offset);
}

/** Web Worker を作る。作れない環境（テストの jsdom など）では null。 */
function getWorker(): Worker | null {
    if (worker !== undefined) return worker;
    try {
        if (typeof Worker === 'undefined') { worker = null; return worker; }
        worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ id: number; channels?: Float32Array[]; error?: string }>) => {
            const job = pending.get(event.data.id);
            if (!job) return;
            pending.delete(event.data.id);
            if (event.data.channels) job.resolve(event.data.channels);
            else job.reject(new Error(event.data.error || '速度を変えた音を作れませんでした'));
        };
        worker.onerror = () => {
            // Worker が使えなくなったら、その場で計算するほうへ切り替える
            for (const job of pending.values()) job.reject(new Error('worker'));
            pending.clear();
            worker = null;
        };
    } catch {
        worker = null;
    }
    return worker;
}

/** サンプルを伸ばす（Worker で。使えなければ、その場で）。 */
async function runStretch(channels: Float32Array[], rate: number, sampleRate: number): Promise<Float32Array[]> {
    const w = getWorker();
    if (w) {
        try {
            return await new Promise<Float32Array[]>((resolve, reject) => {
                const id = ++seq;
                pending.set(id, { resolve, reject });
                w.postMessage({ id, channels, rate, sampleRate }, channels.map((c) => c.buffer));
            });
        } catch (e) {
            if ((e as Error).message !== 'worker') throw e;
            // Worker が落ちたときは、その場で計算する (サンプルは移してしまったので、呼ぶ側で作り直す)
            throw new Error('retry');
        }
    }
    // 画面の描画に一度譲ってから計算する (「用意しています」の表示を先に出す)
    await new Promise((r) => setTimeout(r, 0));
    return wsolaStretch(channels, rate, sampleRate);
}

/** 取っておいた音声が在れば、待たずに返す（無ければ null）。区間や速度を戻したとき、100% に落とさずに切り替える。 */
export function peekStretched(req: StretchRequest): StretchedAudio | null {
    const key = keyOf(req);
    return cache.find((c) => c.key === key && sameClips(c.clips, req.clips))?.audio ?? null;
}

/**
 * 区間を、音の高さを変えずに `rate` 倍の速さにした音声を返す。取っておいたものが在ればそれを返す。
 *
 * @param ctx - AudioBuffer を作る AudioContext
 * @param req - トラック・クリップ・区間・速度
 * @param onInfo - かかった時間を受け取る（任意）
 * @returns 伸ばした音声。クリップが区間に掛かっていなければ null
 */
export async function prepareStretched(ctx: BaseAudioContext, req: StretchRequest, onInfo?: (info: StretchInfo) => void): Promise<StretchedAudio | null> {
    const key = keyOf(req);
    const hit = cache.find((c) => c.key === key && sameClips(c.clips, req.clips));
    if (hit) {
        // 最後に使ったものを後ろへ (古いものから捨てる)
        cache.splice(cache.indexOf(hit), 1);
        cache.push(hit);
        onInfo?.({ ms: 0, cached: true });
        return hit.audio;
    }
    const from = Math.max(0, req.start - MARGIN_SEC);
    const marginBefore = req.start - from;
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const extract = () => extractRegion(req.clips, from, req.end + MARGIN_SEC);
    let region = extract();
    if (!region) return null;
    let channels: Float32Array[];
    try {
        channels = await runStretch(region.channels, req.rate, region.sampleRate);
    } catch (e) {
        if ((e as Error).message !== 'retry') throw e;
        region = extract()!;
        channels = wsolaStretch(region.channels, req.rate, region.sampleRate);
    }
    const sampleRate = region.sampleRate;
    // 余白を切り落とす。長さは区間の長さ ÷ 速度にそろえる (再生の周の長さと同じにする)
    const skip = Math.round((marginBefore / req.rate) * sampleRate);
    const length = Math.max(1, stretchedLength(Math.round((req.end - req.start) * sampleRate), req.rate));
    const buffer = ctx.createBuffer(channels.length, length, sampleRate);
    channels.forEach((ch, i) => buffer.getChannelData(i).set(ch.subarray(skip, skip + length)));
    const audio: StretchedAudio = { trackId: req.trackId, start: req.start, end: req.end, rate: req.rate, buffer };
    cache.push({ key, clips: req.clips.slice(), audio });
    while (cache.length > CACHE_SIZE) cache.shift();
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    onInfo?.({ ms: Math.round(ended - started), cached: false });
    return audio;
}

/** 取っておいた音声を全部捨てる（練習画面を離れたとき。メモリを返す）。 */
export function clearStretchCache(): void {
    cache.length = 0;
}
