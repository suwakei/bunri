/**
 * bunri DAW — Claude を呼ぶパネル（再現ガイド・差分の説明）で共通の部品。
 *
 * - `ClaudeSendNote`: 何を Claude に送るか（音声もファイル名も送らない）と、設定を開くリンク
 * - `ClaudeSettings`: API キーと 1 日の上限の設定（上限は再現ガイドと差分の説明で 1 つの枠）
 * - `UnverifiedTerms`: 説明文に出てきたが、事実（カルテ・差分）に無い音名・コード名の注意
 */
import { useCallback, useState, type ReactNode } from 'react';
import { isDesktop } from '../lib/api';
import { deleteApiKey, saveApiKey, saveGuideSettings, type GuideToday } from '../lib/guide';

/** 何を Claude に送るかの説明と、「API キーと上限の設定」を開くリンク。 */
export function ClaudeSendNote({ children, open, onToggle }: { children: ReactNode; open: boolean; onToggle: () => void }) {
    return (
        <p className="note-text" style={{ marginTop: 6 }}>
            {children}
            {' '}
            <button type="button" onClick={onToggle} aria-expanded={open}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', padding: 0, textDecoration: 'underline' }}>
                API キーと上限の設定
            </button>
        </p>
    );
}

interface ClaudeSettingsProps {
    /** 入力欄の id の頭（同じ画面に 2 つ在っても、見出しと入力欄の結び付きがずれないように）。 */
    idPrefix: string;
    /** 設定の欄を開いているか。 */
    open: boolean;
    /** いまの今日の使用量（上限の欄の placeholder に出す）。 */
    today: GuideToday | null;
    /** 上限を変えたとき（新しい今日の使用量）。 */
    onToday: (today: GuideToday) => void;
    /** API キーを設定したとき・上限を変えたとき（欄を閉じる・失敗の表示を消す、など）。 */
    onSaved: (what: 'key' | 'limit') => void;
}

/** API キーと 1 日の上限の設定の欄。設定した結果の文は、欄を閉じたあとも出す。 */
export function ClaudeSettings({ idPrefix, open, today, onToday, onSaved }: ClaudeSettingsProps) {
    const [keyInput, setKeyInput] = useState('');
    const [keyMessage, setKeyMessage] = useState('');
    const [limitInput, setLimitInput] = useState('');

    const handleSaveKey = useCallback(async () => {
        const key = keyInput.trim();
        if (!key) { setKeyMessage('API キーを入力してください'); return; }
        try {
            await saveApiKey(key);
            setKeyInput('');
            setKeyMessage('API キーを設定しました');
            onSaved('key');
        } catch (e) {
            setKeyMessage('設定できませんでした: ' + String((e as Error)?.message ?? e));
        }
    }, [keyInput, onSaved]);

    const handleDeleteKey = useCallback(async () => {
        try {
            await deleteApiKey();
            setKeyMessage('設定した API キーを消しました');
        } catch (e) {
            setKeyMessage('消せませんでした: ' + String((e as Error)?.message ?? e));
        }
    }, []);

    const handleSaveLimit = useCallback(async () => {
        const text = limitInput.trim();
        const value = text === '' ? null : Number(text);
        if (value !== null && (!Number.isInteger(value) || value < 0)) {
            setKeyMessage('上限は 0 以上の整数で入力してください（空にすると上限なし）');
            return;
        }
        try {
            const saved = await saveGuideSettings({ daily_limit_calls: value });
            onToday(saved.today);
            setLimitInput('');
            setKeyMessage(value === null ? '1 日の上限を無しにしました' : `1 日の上限を ${value} 回にしました`);
            onSaved('limit');
        } catch (e) {
            setKeyMessage('設定できませんでした: ' + String((e as Error)?.message ?? e));
        }
    }, [limitInput, onToday, onSaved]);

    return (
        <>
            {open && (
                <div style={{ marginTop: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <div>
                        <label htmlFor={`${idPrefix}-api-key`}>Claude の API キー</label>
                        <input id={`${idPrefix}-api-key`} type="password" autoComplete="off" value={keyInput}
                            placeholder="sk-ant-…" onChange={(e) => setKeyInput(e.target.value)} />
                    </div>
                    <button className="action-btn" style={{ marginTop: 6 }} onClick={handleSaveKey}>設定する</button>
                    {' '}
                    <button className="action-btn" style={{ marginTop: 6 }} onClick={handleDeleteKey}>設定を消す</button>
                    <p className="note-text" style={{ marginTop: 6 }}>
                        {/* 開発者向けの説明 (API サーバの再起動、環境変数) は、デスクトップアプリでは出さない */}
                        {isDesktop()
                            ? 'この Mac のキーチェーンに保存します。'
                            : '開発用のブラウザ起動では、API サーバを再起動すると消えます（続けて使うなら、環境変数 ANTHROPIC_API_KEY を設定して起動してください）。'}
                    </p>
                    <div style={{ marginTop: 8 }}>
                        <label htmlFor={`${idPrefix}-daily-limit`}>1 日に Claude を呼ぶ回数の上限</label>
                        <input id={`${idPrefix}-daily-limit`} type="number" min={0} step={1} value={limitInput}
                            placeholder={today?.limit_calls != null ? `いまは ${today.limit_calls} 回` : 'いまは上限なし'}
                            onChange={(e) => setLimitInput(e.target.value)} />
                    </div>
                    <button className="action-btn" style={{ marginTop: 6 }} onClick={handleSaveLimit}>上限を変える</button>
                    <p className="note-text" style={{ marginTop: 6 }}>
                        上限に達すると、その日は Claude を呼ばなくなります（保存済みのガイドと説明は見られます）。
                        再現ガイドと差分の説明を合わせて数えます。空にして押すと上限なし。
                    </p>
                </div>
            )}
            {keyMessage && <p className="note-text" role="status" style={{ marginTop: 6 }}>{keyMessage}</p>}
        </>
    );
}

/**
 * 説明文に出てきたが、事実に無い音名・コード名（・小節番号）の注意。無ければ何も出さない。
 *
 * @param source - 何と突き合わせたか（「解析結果」「差分の結果」）
 */
export function UnverifiedTerms({ terms, source, what = '音名・コード名' }: { terms: string[]; source: string; what?: string }) {
    if (terms.length === 0) return null;
    return (
        <p role="note" style={{ fontSize: 12, color: 'var(--warn)', marginTop: 8, lineHeight: 1.6 }}>
            {source}に無い{what}が説明に含まれています: {terms.join('、')}。
            この部分は{source === '解析結果' ? '解析' : source}ではなく、モデルの推測かもしれません。
        </p>
    );
}
