/**
 * bunri DAW — 動きの記録（lib/activity.ts）を、画面とネイティブ側につなぐ。アプリの起動時に 1 回呼ぶ。
 *
 * - 画面全体の操作を拾って記録する: クリック、欄の値の変更、キー（文字を打つ欄の中のキーは拾わない）、
 *   捕まえられなかった例外。部品ごとに記録の呼び出しを書かなくても、どのボタンを押したかが残る
 * - デスクトップ版では、記録の 1 行ごとにネイティブ側へ送って、ファイルに残してもらう（`activity_record`）。
 *   ネイティブ側で起きたこと（MIDI の受信）と、エージェントが外から足した行は、イベント `activity` で受け取って
 *   画面の一覧に入れる
 *
 * 開発用のブラウザ起動では、画面の中の一覧にだけ残す（ファイルは無い）。
 */
import { invokeDesktop, isDesktop, listenDesktop } from './api';
import { describeChange, describeElement, describeKey, recordActivity, setActivityForward } from './activity';

let started = false;

/** 文字を打つ欄か（この中のキーは記録しない。打った文字を残さないため）。 */
function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLTextAreaElement || (target as HTMLElement).isContentEditable) return true;
    if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'range', 'button', 'submit', 'file'].includes(target.type);
    return false;
}

/** 画面全体の操作を拾う仕掛けを入れる。戻り値を呼ぶと外す（テスト用）。 */
export function installActivityListeners(doc: Document = document): () => void {
    const view = doc.defaultView;
    /** 記録の対象か。動きの記録の一覧そのもの（`data-activity-ignore`）の中の操作は、記録しない。 */
    const counted = (target: EventTarget | null): target is Element =>
        target instanceof Element && target.closest('[data-activity-ignore]') === null;
    const onClick = (e: Event) => {
        if (counted(e.target)) recordActivity('click', describeElement(e.target));
    };
    const onChange = (e: Event) => {
        if (counted(e.target)) recordActivity('change', describeChange(e.target));
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.repeat || isTyping(e.target) || !counted(e.target)) return;
        const key = describeKey(e);
        if (key) recordActivity('key', key);
    };
    const onError = (e: Event) => {
        const event = e as ErrorEvent;
        recordActivity('error', String(event.message || event.error || '例外'));
    };
    const onRejection = (e: Event) => {
        const reason = (e as PromiseRejectionEvent).reason as { message?: unknown } | undefined;
        recordActivity('error', '捕まえられなかった失敗: ' + String(reason?.message ?? reason));
    };
    // 部品が伝わりを止めていても拾えるよう、伝わる前（capture）に見る
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('change', onChange, true);
    doc.addEventListener('keydown', onKey, true);
    view?.addEventListener('error', onError);
    view?.addEventListener('unhandledrejection', onRejection);
    return () => {
        doc.removeEventListener('click', onClick, true);
        doc.removeEventListener('change', onChange, true);
        doc.removeEventListener('keydown', onKey, true);
        view?.removeEventListener('error', onError);
        view?.removeEventListener('unhandledrejection', onRejection);
    };
}

/**
 * 動きの記録を始める。何度呼んでも、始めるのは 1 回だけ。
 *
 * ネイティブ側とのつなぎに失敗しても、画面の中の一覧には残る（アプリの起動は止めない）。
 */
export function startActivity(): void {
    if (started) return;
    started = true;
    installActivityListeners();
    if (!isDesktop()) return;
    setActivityForward((tag, message) => {
        void invokeDesktop<void>('activity_record', { tag, message }).catch(() => { /* 書けなくても、画面の一覧には残っている */ });
    });
    void listenDesktop<{ tag: string; message: string }>('activity', (entry) => {
        recordActivity(String(entry.tag), String(entry.message), { local: true });
    }).catch(() => { /* 受け取れなくても、ファイルには残っている */ });
}

/** 記録のファイルの場所（デスクトップ版だけ。無ければ null）。 */
export async function activityFilePath(): Promise<string | null> {
    if (!isDesktop()) return null;
    try {
        return (await invokeDesktop<{ path: string | null }>('activity_info')).path;
    } catch {
        return null;
    }
}
