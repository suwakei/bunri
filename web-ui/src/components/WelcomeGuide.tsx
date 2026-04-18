/**
 * bunri DAW — ウェルカムガイドモーダル
 */
import type { MouseEvent } from 'react';
import { useDaw } from '../lib/store';

/**
 * ウェルカムガイドの1ステップを表すデータ型。
 */
interface GuideStep {
    /** ステップのタイトル */
    title: string;
    /** ステップの説明文 */
    desc: string;
}

const STEPS: GuideStep[] = [
    { title: '音声を追加する', desc: '左の「ファイル」タブからWAVを読み込むか、タイムライン上にドラッグ&ドロップします。' },
    { title: '音を作る', desc: '「シンセ」タブで波形を選び、下のピアノロールにダブルクリックでノートを配置。「シーケンスをレンダリング」で音声化されます。' },
    { title: 'ドラムを追加する', desc: '「ドラム」タブでパターンとBPMを選んで生成。自動でDrumトラックに追加されます。' },
    { title: 'タイムラインで配置する', desc: 'クリップをドラッグして好きな位置に移動。各トラックの M（ミュート）S（ソロ）で聴き比べ。' },
    { title: '再生・書き出し', desc: '▶で再生、「書出」ボタンで全トラックをミックスしたWAVをダウンロードできます。' },
];

/**
 * 初回起動時に表示するウェルカムガイドモーダル。
 * `showGuide` が false の場合は何もレンダリングしない。
 * オーバーレイ外クリックまたは「はじめる」ボタンで閉じると、
 * localStorage に既読フラグが保存されて次回以降は表示されない。
 * @returns ガイドモーダルの JSX 要素、非表示時は null
 */
export default function WelcomeGuide(): React.ReactElement | null {
    const { showGuide, closeGuide } = useDaw();
    if (!showGuide) return null;

    return (
        <div id="guide-overlay" onClick={(e: MouseEvent<HTMLDivElement>) => { if ((e.target as HTMLDivElement).id === 'guide-overlay') closeGuide(); }}>
            <div id="guide-modal">
                <h2>bunri DAW へようこそ</h2>
                <div className="guide-steps">
                    {STEPS.map((step, i) => (
                        <div className="guide-step" key={i}>
                            <div className="guide-num">{i + 1}</div>
                            <div>
                                <strong>{step.title}</strong>
                                <p>{step.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>
                <p className="guide-tip">各ボタンやスライダーにマウスを乗せると、画面下部に説明が表示されます。</p>
                <button className="action-btn" onClick={closeGuide}>はじめる</button>
            </div>
        </div>
    );
}
