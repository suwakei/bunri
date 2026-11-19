/** 画面とアシスタントの案内が、録音の条件を取り違えないことを確かめる。 */
import { describe, expect, it } from 'vitest';
import { midiModeGuidance } from '../lib/midi-guidance';

describe('鍵盤の録り方の案内', () => {
    it('カウントが無効なら待つよう案内せず、不明なら条件付きで案内する', () => {
        expect(midiModeGuidance('realtime', false)).not.toContain('カウント');
        expect(midiModeGuidance('realtime', true)).toContain('カウント中は録りません');
        expect(midiModeGuidance('realtime')).toContain('カウントを入れた場合');
    });

    it('練習画面では音だけに戻す操作と、録ったノートを聴く設定を案内する', () => {
        const practice = midiModeGuidance('realtime', true, 'practice');
        expect(practice).toContain('▶ で再生してから弾く');
        expect(practice).toContain('入力を「マウス（鍵盤は音だけ）」');
        expect(practice).toContain('「聴く」を「自分」');
        expect(practice).toContain('また鍵盤の演奏を録ります');
        expect(midiModeGuidance('realtime', true, 'arrange')).not.toContain('マウス');
    });
});
