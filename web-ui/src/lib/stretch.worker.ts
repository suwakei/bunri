/**
 * bunri DAW — 音の高さを変えずに速さを変える計算を、画面とは別の糸 (Web Worker) で行う。
 *
 * 計算そのものは lib/stretch.ts。区間が長いと数百ミリ秒かかるので、画面 (ピアノロールの操作や
 * 再生位置の線) を止めないよう、こちらで行う。サンプルは移す (transfer) ので、写しの手間は無い。
 * 同じ生まれの (`'self'` の) スクリプトなので、CSP に足すものは無い。
 */
import { wsolaStretch } from './stretch';

/** 受け取る頼み。 */
interface StretchRequest {
    id: number;
    channels: Float32Array[];
    rate: number;
    sampleRate: number;
}

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<StretchRequest>) => void) | null;
    postMessage: (message: unknown, transfer: Transferable[]) => void;
};

scope.onmessage = (event) => {
    const { id, channels, rate, sampleRate } = event.data;
    try {
        const out = wsolaStretch(channels, rate, sampleRate);
        scope.postMessage({ id, channels: out }, out.map((c) => c.buffer));
    } catch (e) {
        scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) }, []);
    }
};
