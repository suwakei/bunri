/**
 * bunri DAW — アシスタントが「ここです」と示せる、画面の場所の一覧。
 *
 * 利用者に「パート分離はどこ？」と聞かれたとき、アシスタントはツール `show_in_app` でその場所を示す。
 * 示すときは、その場所の在るタブを開き、部品を短いあいだ光らせる（lib/assistant-env.ts の `pointAt`）。
 * 押すのは利用者（アシスタントは、ボタンを代わりに押さない。曲のファイルを選ぶ、などは利用者にしかできない）。
 *
 * 名前（`key`）は、台帳（`backend/assistant_tools.json`）の `show_in_app` の `target` の選択肢と同じ。
 * 過不足は、単体テストが台帳を読んで止める。セレクタが実際の画面に在るかは、e2e が確かめる。
 */

/** 場所を示す前に開くタブ。 */
export type LandmarkOpen =
    | { leftTab: 'learn'; learnTab: 'song' | 'chart' | 'guide' | 'coach' }
    | { leftTab: 'sound'; soundTab: 'synth' | 'drum' | 'fx' }
    | { leftTab: 'file' };

/** 示せる場所 1 つ。 */
export interface Landmark {
    /** 画面での名前 */
    label: string;
    /** どこに在るか（アシスタントが、そのまま言える文） */
    where: string;
    /** 光らせる部品の CSS セレクタ（先に見つかったもの） */
    selector: string;
    /** 示す前に開くタブ。ヘッダや中央エリアのように、いつも出ているものには無い */
    open?: LandmarkOpen;
    /** 出ていないことがある場所の、出る条件（見つからなかったときに返す） */
    when?: string;
}

/** 示せる場所。名前は台帳の `target` と同じ。 */
export const LANDMARKS: Record<string, Landmark> = {
    import_song: {
        label: '曲を取り込む', where: '左のパネルの「学ぶ」→「曲とパート」に在る「曲を取り込む」ボタン',
        selector: '#btn-import-song', open: { leftTab: 'learn', learnTab: 'song' },
    },
    separate_parts: {
        label: 'パートに分けて採譜する', where: '左のパネルの「学ぶ」→「曲とパート」に在る「パートに分けて採譜する」ボタン',
        selector: '#learn-parts > button.action-btn', open: { leftTab: 'learn', learnTab: 'song' },
    },
    practice_part: {
        label: 'このパートを練習する', where: '左のパネルの「学ぶ」→「曲とパート」のパートの一覧に在る「このパートを練習する」ボタン',
        selector: '#part-list button[aria-label$="を練習する"]', open: { leftTab: 'learn', learnTab: 'song' },
        when: 'パートに分けると出ます',
    },
    chart: {
        label: 'カルテ', where: '左のパネルの「学ぶ」→「カルテ」（キー・コード進行・構成）',
        selector: '#tab-learn-chart', open: { leftTab: 'learn', learnTab: 'chart' },
    },
    guide: {
        label: '再現ガイド', where: '左のパネルの「学ぶ」→「ガイド」（カルテをもとにした、再現の手順の説明）',
        selector: '#tab-learn-guide', open: { leftTab: 'learn', learnTab: 'guide' },
    },
    coach: {
        label: '差分チェック', where: '左のパネルの「学ぶ」→「差分」（お手本と打ち込みを比べる）',
        selector: '#tab-learn-coach', open: { leftTab: 'learn', learnTab: 'coach' },
    },
    synth: {
        label: 'シンセ', where: '左のパネルの「音作り」→「シンセ」（開いているトラックのノートを、音声にして置く）',
        selector: '#tab-sound-synth', open: { leftTab: 'sound', soundTab: 'synth' },
    },
    drum: {
        label: 'ドラム', where: '左のパネルの「音作り」→「ドラム」（リズムのパターンを、音声にして置く）',
        selector: '#tab-sound-drum', open: { leftTab: 'sound', soundTab: 'drum' },
    },
    fx: {
        label: 'FX（エフェクト）', where: '左のパネルの「音作り」→「FX」（音声のクリップに、EQ・コンプレッサー・リバーブなどをかける）',
        selector: '#tab-sound-fx', open: { leftTab: 'sound', soundTab: 'fx' },
    },
    file_tab: {
        label: 'ファイル', where: '左のパネルの「ファイル」（音声や MIDI ファイルの読み込み、マイク録音、データの整理）',
        selector: '#tab-file', open: { leftTab: 'file' },
    },
    play: { label: '再生', where: '画面の上のヘッダに在る ▶ ボタン（Space キーでも再生できます）', selector: '#btn-play' },
    tempo: { label: 'BPM（テンポ）', where: '画面の上のヘッダに在る BPM の欄', selector: '#transport-bpm' },
    time_signature: { label: '拍子', where: '画面の上のヘッダに在る、拍子の欄', selector: '#transport-meter' },
    metronome: { label: 'メトロノーム', where: '画面の上のヘッダに在る 🔔 ボタン', selector: '#header button[aria-label="メトロノーム"]' },
    undo: { label: '元に戻す', where: '画面の上のヘッダに在る ↶ ボタン（⌘Z でも戻せます）', selector: '#btn-undo' },
    save: { label: '保存', where: '画面の上のヘッダに在る「保存」ボタン（⌘S でも保存できます）', selector: '#header button[aria-keyshortcuts~="Meta+S"]' },
    open_project: { label: '開く', where: '画面の上のヘッダに在る「開く」ボタン（⌘O でも開けます）', selector: '#header button[aria-keyshortcuts~="Meta+O"]' },
    project_menu: { label: 'プロジェクトのメニュー', where: '画面の上のヘッダの「開く」の隣に在る ▼（新しいプロジェクト・別名で保存・最近使ったプロジェクト）', selector: '#btn-project-menu' },
    export_wav: { label: 'WAV 書き出し', where: '画面の上のヘッダに在る「WAV 書き出し」ボタン', selector: '#btn-export-wav' },
    export_midi: { label: 'MIDI 書き出し', where: '画面の上のヘッダに在る「MIDI 書き出し」ボタン', selector: '#btn-export-midi' },
    tools_page: { label: 'ツール', where: '画面の上のヘッダに在る「ツール」（ファイルの変換や加工の道具を、別の窓で開きます）', selector: '#header a[href="/tools"]' },
    help: { label: '使い方', where: '画面の上のヘッダに在る「使い方」（説明を、別の窓で開きます）', selector: '#header a[href="/help"]' },
    activity_log: { label: '記録', where: '画面の下のバーに在る「記録」（アプリの中で起きたことの一覧）', selector: '#activity-toggle' },
    add_track: {
        label: 'トラック追加', where: 'タイムラインの下に在る「+ トラック追加」ボタン',
        selector: '#btn-add-track', when: 'トラックが 1 本も無いあいだと、練習画面のあいだは出ません',
    },
    timeline: { label: 'タイムライン', where: '画面の中央の上半分（トラックと音声のクリップが並ぶところ）', selector: '#timeline-area', when: '練習画面のあいだは出ません' },
    piano_roll: { label: 'ピアノロール', where: '画面の中央の下半分（ノートを置くところ。ダブルクリックでノートを置けます）', selector: '#piano-roll-area' },
    midi_input: {
        label: 'MIDI 入力', where: 'ピアノロールの上のバーに在る「MIDI 入力」ボタン（MIDI キーボードをつなぎます）',
        selector: '#midi-input-bar', when: '練習画面のあいだは、練習画面の「入力」で切り替えます',
    },
    practice_loop: {
        label: '区間ループ', where: '練習画面の下のバーに在る「区間ループ」（くり返す小節の範囲）',
        selector: '#practice-controls [role="group"][aria-label="区間ループ"]', when: '練習画面を開いているあいだだけ出ます',
    },
    practice_speed: {
        label: '速度', where: '練習画面の下のバーに在る「速度」（音の高さを変えずに遅くします。区間ループの中で効きます）',
        selector: '#practice-speed', when: '練習画面を開いているあいだだけ出ます',
    },
    practice_compare: {
        label: '比べる', where: '練習画面の下のバーに在る「比べる」ボタン（お手本と比べて、違うノートに色を付けます）',
        selector: 'button.practice-compare', when: '練習画面を開いているあいだだけ出ます',
    },
};

/** 光らせておく長さ（ミリ秒）。 */
export const POINTER_MS = 5000;
/** 光らせている部品に付けるクラス（styles/global.css）。 */
export const POINTER_CLASS = 'assistant-pointer';

/**
 * 部品を、見えるところまでスクロールして、短いあいだ光らせる。
 *
 * @param element - 光らせる部品
 * @param ms - 光らせておく長さ
 */
export function flashElement(element: Element, ms = POINTER_MS): void {
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // 続けて同じ場所を示したら、アニメーションを頭からやり直す
    element.classList.remove(POINTER_CLASS);
    void (element as HTMLElement).offsetWidth;
    element.classList.add(POINTER_CLASS);
    setTimeout(() => element.classList.remove(POINTER_CLASS), ms);
}
