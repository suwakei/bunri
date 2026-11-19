/**
 * bunri DAW — 再現ガイド（第2層）のパネル。
 * 「学ぶ」タブの「ガイド」の段に出す。カルテを Claude に渡して「こう作れば再現できる」という手順を作るのは、
 * アシスタント（右のドックのチャット）の仕事。このパネルは、対象（曲全体か区間か）を選んで、アシスタントに頼む入口だけを持つ。
 *
 * - 「アシスタントにガイドを頼む」を押すと、ドックが開き、依頼の文（「再現ガイドを作って」など）が送られる
 *   （ストアの `askAssistant`）。アシスタントはツール `make_guide` でガイドを作り、手順はチャットにカードとして出る
 *   （components/AssistantCards.tsx。手順の場所を押すと、そこへ移動する）
 * - 保存済みのガイドが在れば、作り直さずにそれが出る（ガイドの分の費用はかからない。アシスタントの呼び出しの分はかかる）
 * - Claude の設定（API キー・1 日の上限）は、ドックにだけ在る
 */
import { useState } from 'react';
import { useDaw } from '../lib/store';
import { tip } from '../lib/tooltip';
import { guideRequestText, sectionName } from '../lib/guide';

/**
 * 再現ガイドのパネル。カルテが無いときは、先に曲を取り込むよう案内する。
 */
export default function GuidePanel() {
    const { chart, chartId, openLearn, askAssistant } = useDaw();
    const [focus, setFocus] = useState('');

    if (!chart || !chartId) {
        return (
            <div id="guide-panel" className="panel-content">
                <h3 style={{ marginBottom: 6 }}>再現ガイド</h3>
                <p className="body-text" style={{ color: 'var(--text-mid)' }}>
                    カルテができると、ここで「こう作れば再現できる」という手順を作れます。先に曲を取り込んでください。
                </p>
                <button className="action-btn" onClick={() => openLearn('song')} {...tip('曲を取り込む場所を開きます')}>曲を取り込む</button>
            </div>
        );
    }
    // 選んでいた区間が、カルテを直したあとで無くなっていたら、曲全体にする
    const target = chart.sections.some((s) => s.id === focus) ? focus : '';

    return (
        <div id="guide-panel" className="panel-content">
            <h3 style={{ marginBottom: 6 }}>再現ガイド</h3>
            <p className="panel-desc" style={{ marginBottom: 8 }}>
                カルテの内容を「こう作れば再現できる」という手順に言い換えます。作るのはアシスタント（右のドック）で、手順はチャットに出ます。
            </p>

            <div>
                <label htmlFor="guide-focus">対象</label>
                <select id="guide-focus" value={target} onChange={(e) => setFocus(e.target.value)}
                    {...tip('手順を作る範囲。曲全体か、サビなどの区間を選びます')}>
                    <option value="">曲全体</option>
                    {chart.sections.map((s) => (
                        <option key={s.id} value={s.id}>{sectionName(s)}（{s.start_bar}〜{s.end_bar} 小節）</option>
                    ))}
                </select>
            </div>
            <button className="action-btn" id="guide-ask" onClick={() => askAssistant(guideRequestText(chart, target))}
                {...tip('アシスタントのドックを開いて、この対象の再現ガイドを頼みます。保存済みのガイドが在れば、作り直さずにそれが出ます')}>
                アシスタントにガイドを頼む
            </button>
            <p className="note-text" style={{ marginTop: 6 }}>
                アシスタントは、カルテ（解析結果）を Anthropic の Claude に送ります。音声は送りません。ファイル名も送りません。
                保存済みのガイドが在れば、Claude に作り直させずにそれを出します（作り直すときは、チャットで「作り直して」と頼んでください）。
                API キーと 1 日の上限は、アシスタントのドックの下で設定します。
            </p>
        </div>
    );
}
