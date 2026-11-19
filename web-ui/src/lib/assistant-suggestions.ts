/**
 * bunri DAW — アシスタントのドックが空のときに出す、頼み方の例（いまの状況に合わせて選ぶ）。
 *
 * 決まった規則で選ぶ（Claude は呼ばない）。例は 3 つ。押すと入力欄に入る（送るのは利用者）。
 * 状況は、画面の側が読んで渡す（lib/assistant-env.ts の `suggestionFacts`。描いている途中に呼ばれるので、読むだけ）。
 */
/** 出す例の数。 */
export const SUGGESTION_COUNT = 3;

/** 例を選ぶ材料。 */
export interface SuggestionFacts {
    /** トラックの数 */
    trackCount: number;
    /** 曲を取り込んだか */
    imported: boolean;
    /** カルテが在るか */
    hasChart: boolean;
    /** パートに分けたか */
    separated: boolean;
    /** 練習のトラックにノートが在るか */
    practiced: boolean;
    /** 練習画面を開いているか */
    practiceOpen: boolean;
    /** ピアノロールで選んでいるノートの数 */
    selectedNotes: number;
    /** ピアノロールで開いているトラックに、ノートが在るか */
    openTrackHasNotes: boolean;
    /** 時間のかかる処理が動いているか */
    jobRunning: boolean;
}

/**
 * いまの状況に合う、頼み方の例を選ぶ。いま頼めること（選んでいるノート、練習画面）を先に、
 * 次に、学ぶ流れの次の一歩を出す。足りないぶんは、いつでも頼めるもので埋める。
 *
 * @returns 例（`SUGGESTION_COUNT` 個。重なりは無い）
 */
export function suggestionsFor(facts: SuggestionFacts): string[] {
    const picked: string[] = [];
    const add = (...texts: string[]) => { for (const text of texts) if (!picked.includes(text)) picked.push(text); };

    if (facts.jobRunning) add('いま動いている処理は、どこまで進んだ？');
    if (facts.selectedNotes > 0) add('選んだノートを 1 オクターブ上げて', '選んだノートを、だんだん強くして');
    if (facts.practiceOpen) add('お手本と比べて、どこが違うか教えて', 'この区間を 75% の速さでくり返し再生して');

    if (!facts.imported && facts.trackCount === 0) add('曲を取り込むのは、どこから？');
    else if (facts.imported && !facts.separated) add(facts.hasChart ? 'この曲のキーとコード進行を教えて' : '次に何をすればいい？', 'パートに分けて採譜して');
    else if (facts.separated && !facts.practiced) add('ベースの練習画面を開いて', '次に何をすればいい？');
    else if (facts.practiced && !facts.practiceOpen) add('お手本と比べて、どこが違うか教えて');

    if (facts.openTrackHasNotes) add('いまのトラックの 1 小節目を、あと 3 回くり返して', 'いまのトラックのノートを 8 分音符にそろえて');

    // いつでも頼めるもの
    add('いまのプロジェクトの様子を教えて', 'トラックを 1 本追加して、1〜2 小節に C メジャーのベースラインを置いて', 'テンポを 96 にして、1 小節目から再生して');
    return picked.slice(0, SUGGESTION_COUNT);
}
