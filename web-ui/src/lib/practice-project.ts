/**
 * bunri DAW — 練習画面の状態を、プロジェクト（`.bunri`）に入れる。
 *
 * 状態の節 `practice`（lib/project-file.ts の `registerProjectSection`）として登録する。中身は
 * lib/practice.ts の `practiceToSection` / `practiceFromSection`（トラックは並びの番号で持つ）。
 *
 * - 保存: パートと練習のトラック・区間ループ・速度・聴く・お手本・入力。練習画面を一度も開いていなければ入れない
 * - 開く: 状態は戻すが、**練習画面は開かない**（アレンジで開く）。理由:
 *   - 開いた直後は、音声が見つからないトラックの知らせなど、プロジェクト全体を見てもらいたい
 *     （練習画面はタイムラインと左パネルを隠す）
 *   - 練習画面を開くと、入力が MIDI なら鍵盤につなぎにいき、速度が 100% でなければ音声を伸ばし始める。
 *     利用者が何もしていないうちに、それをしない
 *   - 区間はタイムラインの目盛りに出るので、どこを練習していたかは見える。「このパートを練習する」か
 *     「練習画面」を押すと、同じ区間・速度から続けられる
 * - トラックが見つからない（番号が範囲の外・お手本が無い）節は、無かったことにする（練習画面の状態を持たない）
 * - 新しいプロジェクトにすると、状態を消す
 *
 * 保存していない変更の印は、利用者が設定を変えたとき（store の `updatePractice`）に付く。開く・閉じる・再生では付けない。
 */
import { useEffect, useRef } from 'react';
import { useDaw } from './store';
import engine from './engine';
import { registerProjectSection } from './project-file';
import { PRACTICE_SECTION_VERSION, practiceFromSection, practiceToSection } from './practice';

/** 練習画面の状態を、プロジェクトの節として登録する（DAW の画面に 1 つ）。 */
export function usePracticeProjectSection(): void {
    const { practice, restorePractice } = useDaw();
    // 保存はいつ呼ばれるか分からないので、最新の状態を控えておく
    const latest = useRef(practice);
    useEffect(() => {
        latest.current = practice;
    }, [practice]);
    useEffect(() => registerProjectSection('practice', {
        version: PRACTICE_SECTION_VERSION,
        save: () => (latest.current ? practiceToSection(latest.current, engine.tracks) : null),
        load: (value) => {
            const next = practiceFromSection(value, engine.tracks);
            latest.current = next;
            restorePractice(next);
        },
    }), [restorePractice]);
}
