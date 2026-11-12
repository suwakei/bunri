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
    { title: '曲を取り込む', desc: '「曲を取り込んで始める」を押して、MP3 や WAV などの曲のファイルを選びます。音声が「原曲」のトラックに置かれます。' },
    { title: 'カルテを見る', desc: '取り込むと、キー・コード進行・構成・ミックスをまとめたカルテが「学ぶ」タブに出ます。コードを押すと、その小節へ移動します。' },
    { title: 'パートに分ける', desc: '「パートに分けて採譜する」で、ボーカル・ベースなどのパートに分けます（数分）。採譜したノートはお手本になります。' },
    { title: '打ち込む', desc: 'パートの「このパートを練習する」を押すと、水色のお手本を重ねたピアノロールが開きます。お手本と原曲を聴きながら、ノートを置きます。' },
    { title: '差分で直す', desc: '「差分」の「お手本と比べる」で、お手本との違いが一覧になります。指摘を押すと、その場所へ移動します。' },
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
                <p className="guide-tip">いまどの段階かは、画面の上の「進み具合」に出ます。曲を使わずに作るときは「自由に作る」を押します。ボタンにマウスを載せると、画面の下端に説明が出ます。</p>
                <button className="action-btn" data-autofocus onClick={closeGuide}>はじめる</button>
            </div>
        </div>
    );
}
