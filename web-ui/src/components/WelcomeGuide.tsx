/**
 * bunri DAW — ウェルカムガイドモーダル
 */
import { useRef, type MouseEvent } from 'react';
import { useDaw } from '../lib/store';
import { useDialog } from '../lib/dialog';

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
    { title: '音声を追加する', desc: '左の「ファイル」タブから WAV ファイルを読み込むか、タイムラインにドラッグ&ドロップします。' },
    { title: '音を作る', desc: '「シンセ」タブで波形を選び、下のピアノロールをダブルクリックしてノートを置きます。「シーケンスをレンダリング」を押すと、音声のクリップになります。' },
    { title: 'ドラムを追加する', desc: '「ドラム」タブでパターンを選んで「ドラム生成 → トラックに追加」を押します。新しい Drum トラックに入ります。' },
    { title: 'タイムラインで配置する', desc: 'クリップをドラッグして好きな位置に移動します。各トラックの M（ミュート）と S（ソロ）で聴き比べられます。' },
    { title: '再生・書き出し', desc: '▶ か Space キーで再生します。「WAV 書き出し」を押すと、全トラックを混ぜた WAV ファイルを保存できます。' },
];

/**
 * 初回起動時に表示するウェルカムガイドモーダル。
 * `showGuide` が false の場合は何もレンダリングしない。
 * オーバーレイ外クリック・Esc キー・「はじめる」ボタンで閉じると、
 * localStorage に既読フラグが保存されて次回以降は表示されない。
 * @returns ガイドモーダルの JSX 要素、非表示時は null
 */
export default function WelcomeGuide(): React.ReactElement | null {
    const { showGuide, closeGuide } = useDaw();
    const modalRef = useRef<HTMLDivElement>(null);
    useDialog(modalRef, showGuide, closeGuide);
    if (!showGuide) return null;

    return (
        <div id="guide-overlay" onClick={(e: MouseEvent<HTMLDivElement>) => { if ((e.target as HTMLDivElement).id === 'guide-overlay') closeGuide(); }}>
            <div id="guide-modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="guide-title" tabIndex={-1}>
                <h2 id="guide-title">bunri DAW へようこそ</h2>
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
                <p className="guide-tip">ボタンやスライダーにマウスを載せると、画面の下端に説明が出ます。</p>
                <button className="action-btn" data-autofocus onClick={closeGuide}>はじめる</button>
            </div>
        </div>
    );
}
