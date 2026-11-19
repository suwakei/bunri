/**
 * bunri DAW — アシスタントの会話を、プロジェクト（`.bunri`）に入れる。
 *
 * 状態の節 `assistant`（lib/project-file.ts の `registerProjectSection`）として登録する。中身は
 * lib/assistant-history.ts の `itemsToSaved` / `itemsFromSection`。
 *
 * - 保存: 画面に並んでいるもの（利用者の文・アシスタントの文・操作ログの行・知らせ・再現ガイドと差分の説明のカード）。新しいほうから 300 個まで。
 *   **Claude に送る会話（思考のブロックやツールの結果の中身）は入れない**。会話が空なら、節を入れない
 * - 開く: 並びを戻す。Claude に送る会話は空から始まり、次の依頼の頭に、戻した並びから作った「これまでの記録」を付ける
 *   （トラックの ID は開き直すたびに変わるので、前の会話のツールの結果は使わせない）
 * - 新しいプロジェクトにする・会話を保存していないプロジェクトを開くと、会話を空にする（会話は、プロジェクトごと）
 * - 「新しい会話」を押すと、それまでの会話は履歴（`archive`）へ移り、履歴ごと保存される。履歴から消した会話は、
 *   次の保存で、プロジェクトからも消える
 *
 * 会話が増えただけでは、保存していない変更の印は付けない（質問しただけで「保存しますか」と尋ねないように）。
 * 会話は、プロジェクトを保存したときに、そのときのものが入る。
 */
import { useEffect } from 'react';
import { registerProjectSection } from './project-file';
import { assistantSession } from './assistant';
import { ASSISTANT_SECTION_VERSION, archiveFromSection, archiveToSaved, itemsFromSection } from './assistant-history';

/** アシスタントの会話を、プロジェクトの節として登録する（DAW の画面に 1 つ）。 */
export function useAssistantProjectSection(): void {
    useEffect(() => registerProjectSection('assistant', {
        version: ASSISTANT_SECTION_VERSION,
        save: () => {
            const items = assistantSession.saved();
            const archive = archiveToSaved(assistantSession.archived());
            if (items.length === 0 && archive.length === 0) return null;
            return archive.length > 0 ? { items, archive } : { items };
        },
        load: (value) => {
            assistantSession.restore(itemsFromSection(value), archiveFromSection(value, assistantSession.nextItemId));
        },
    }), []);
}
