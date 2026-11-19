/** 鍵盤の録り方に応じた、画面とアシスタント共通の案内。 */
import type { RecordMode } from './midi-input';

/** カウントの設定が不明なときは、条件付きで説明する。 */
export function midiModeGuidance(mode: RecordMode, countIn?: boolean, context?: 'arrange' | 'practice'): string {
    if (mode === 'off') return '鍵盤を弾くと音だけが鳴り、ノート（一音ぶんの横棒）は増えません。録ったものは ▶ で聴き返せます。';
    if (mode === 'step') return '鍵盤を押すたび、決めた長さのノート（一音ぶんの横棒）を置きます。長押ししても伸びません。押した長さで残すなら「弾いた長さで録る」を選びます。';
    const count = countIn === undefined ? 'カウントを入れた場合、その間は録りません。'
        : countIn ? '最初のカウント中は録りません。' : '';
    const listenMode = context === 'arrange' ? '録り方を「音を鳴らすだけ」'
        : context === 'practice' ? '入力を「マウス（鍵盤は音だけ）」'
            : '録り方を「音を鳴らすだけ」（練習画面では入力を「マウス（鍵盤は音だけ）」）';
    const listen = context === 'arrange' ? '' : '練習画面では「聴く」を「自分」にすると、録ったノートを聴けます。';
    return `▶ で再生してから弾くと、押した長さでノート（一音ぶんの横棒）を残します。位置と長さは、細かい一定の間隔にそろいます。${count}■ で停止したら、${listenMode}に変えてから ▶ で聴き返します。${listen}この録り方のまま再生すると、また鍵盤の演奏を録ります。`;
}
