/**
 * bunri DAW — 音楽アシスタント（LLMチャットパネル）
 * 自然言語でピアノロールの提案を受け取り、アクティブトラックに適用する
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useDaw } from '../lib/store';

/**
 * AIアシスタントが提案する単一ノートのデータ構造。
 * ピアノロールの1マスに相当する。
 */
interface AssistantNote {
    /** 音名（例: "C", "D#"） */
    note: string;
    /** オクターブ番号（例: 4 = 中央C） */
    octave: number;
    /** 開始ステップ（16分音符単位のグリッドインデックス） */
    step: number;
    /** ノートの長さ（ステップ数） */
    length: number;
}

/**
 * `/api/assistant/chat` が返すレスポンス全体。
 * 提案ノート列・説明文・使用バックエンドを含む。
 */
interface AssistantResponse {
    /** 提案されたノートの配列 */
    notes: AssistantNote[];
    /** LLMが生成したノートの説明文 */
    explanation: string;
    /** 実際に応答を生成したバックエンド種別 */
    backend: 'local' | 'cloud';
}

/**
 * チャット履歴の1メッセージを表す型。
 * role によってユーザー発言・アシスタント応答・エラーを区別する。
 */
interface ChatMessage {
    /** メッセージの送信者種別 */
    role: 'user' | 'assistant' | 'error';
    /** 表示するテキスト内容 */
    text: string;
    /** role が 'assistant' のときのみ存在する構造化レスポンス */
    response?: AssistantResponse;
}

/**
 * LLMバックエンドの利用可否を示す状態型。
 * `/api/assistant/status` のレスポンスに対応する。
 */
interface AvailabilityStatus {
    /** Ollama ローカルサーバーが起動しているか */
    local: boolean;
    /** クラウドAPIキー（ANTHROPIC_API_KEY）が設定されているか */
    cloud: boolean;
    /** Ollama で利用可能なモデル名の一覧 */
    local_models: string[];
}

/**
 * チャット入力欄に表示するサンプルプロンプトの一覧。
 * クリックすると入力欄にセットされる。
 */
const EXAMPLE_PROMPTS = [
    '4小節のポップスコード進行（Cメジャー）',
    '2小節のシンプルなベースライン（Am）',
    '切ない感じのAメロ',
    '8ビートのドラムパターン',
    'ジャズっぽいウォーキングベース',
];

/**
 * AIアシスタントパネルコンポーネント。
 * ユーザーが自然言語でプロンプトを入力すると、LLMがピアノロールノートを提案する。
 * 提案はアクティブトラックのピアノロールへ「置換」または「末尾追加」で適用できる。
 *
 * @returns AIアシスタントUIのJSX要素
 */
export default function AssistantPanel() {
    const { bpm, setStatus, pianoRollRef, bumpTracks, setHint } = useDaw();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [mode, setMode] = useState<'auto' | 'local' | 'cloud'>('auto');
    const [bars, setBars] = useState(4);
    const [loading, setLoading] = useState(false);
    const [availability, setAvailability] = useState<AvailabilityStatus | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // 起動時にLLMの利用可否を取得
    useEffect(() => {
        fetch('/api/assistant/status')
            .then(r => r.json())
            .then((data: AvailabilityStatus) => setAvailability(data))
            .catch(() => { /* 無視 */ });
    }, []);

    // メッセージ追加時に自動スクロール
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const handleSend = useCallback(async () => {
        if (!input.trim() || loading) return;

        const userMsg = input.trim();
        setMessages(m => [...m, { role: 'user', text: userMsg }]);
        setInput('');
        setLoading(true);

        // 既存ノートを文脈として渡す
        const pr = pianoRollRef.current;
        const contextNotes = pr?.getNotes?.() ?? [];

        const fd = new FormData();
        fd.append('prompt', userMsg);
        fd.append('bpm', String(bpm));
        fd.append('bars', String(bars));
        fd.append('mode', mode);
        fd.append('context_notes', JSON.stringify(contextNotes));

        try {
            const resp = await fetch('/api/assistant/chat', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const data: AssistantResponse = await resp.json();
            setMessages(m => [...m, {
                role: 'assistant',
                text: data.explanation || '提案を生成しました',
                response: data,
            }]);
        } catch (e: unknown) {
            setMessages(m => [...m, {
                role: 'error',
                text: (e as Error).message || 'エラーが発生しました',
            }]);
        } finally {
            setLoading(false);
        }
    }, [input, loading, bpm, bars, mode, pianoRollRef]);

    const handleApply = useCallback((response: AssistantResponse, replace: boolean) => {
        const pr = pianoRollRef.current;
        if (!pr) {
            setStatus('ピアノロールが初期化されていません');
            return;
        }
        if (!pr.getActiveTrackId()) {
            setStatus('先にトラックを選択してピアノロールを開いてください');
            return;
        }

        if (replace) {
            pr.setNotes(response.notes);
        } else {
            // 追記モード: 既存ノートの末尾から追加
            const existing = pr.getNotes();
            const offset = existing.reduce((max: number, n: AssistantNote) =>
                Math.max(max, n.step + n.length), 0);
            const shifted = response.notes.map(n => ({ ...n, step: n.step + offset }));
            pr.setNotes([...existing, ...shifted]);
        }
        bumpTracks();
        setStatus(`${response.notes.length}ノートを${replace ? '置換' : '追加'}しました`);
    }, [pianoRollRef, setStatus, bumpTracks]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSend();
        }
    };

    const backendBadge = (backend: 'local' | 'cloud') => (
        <span style={{
            display: 'inline-block',
            fontSize: 9,
            padding: '1px 6px',
            borderRadius: 8,
            background: backend === 'local' ? 'rgba(78, 205, 196, 0.2)' : 'rgba(212, 164, 76, 0.2)',
            color: backend === 'local' ? '#4ecdc4' : '#d4a44c',
            fontWeight: 600,
            marginLeft: 6,
        }}>
            {backend === 'local' ? 'LOCAL' : 'CLOUD'}
        </span>
    );

    const h = (text: string) => ({
        onMouseEnter: () => setHint(text),
        onMouseLeave: () => setHint(''),
    });

    return (
        <div id="assistant-panel" className="panel-content">
            <h3>AIアシスタント</h3>
            <p className="panel-desc">
                自然言語で伝えると、ピアノロールのノートを提案します。
                生成されるのはノートデータのみ、音色はあなたが選んだGM音源で鳴ります。
            </p>

            {/* バックエンドステータス */}
            {availability && (
                <div style={{
                    fontSize: 10,
                    color: 'var(--text-dim)',
                    padding: '6px 8px',
                    background: 'rgba(0,0,0,0.2)',
                    borderRadius: 4,
                    marginBottom: 8,
                }}>
                    <div>Local: {availability.local
                        ? <span style={{ color: '#4ecdc4' }}>●接続済み ({availability.local_models.join(', ') || 'モデルなし'})</span>
                        : <span style={{ color: '#e74c3c' }}>●未接続 (ollama serve)</span>}
                    </div>
                    <div>Cloud: {availability.cloud
                        ? <span style={{ color: '#4ecdc4' }}>●APIキー設定済み</span>
                        : <span style={{ color: '#e74c3c' }}>●未設定 (ANTHROPIC_API_KEY)</span>}
                    </div>
                </div>
            )}

            <div className="param-row">
                <div>
                    <label>バックエンド</label>
                    <select value={mode} onChange={e => setMode(e.target.value as 'auto' | 'local' | 'cloud')} {...h('ローカル=無料/オフライン, クラウド=高品質')}>
                        <option value="auto">自動選択</option>
                        <option value="local">ローカル (Ollama)</option>
                        <option value="cloud">クラウド (Claude)</option>
                    </select>
                </div>
                <div>
                    <label>小節数</label>
                    <input type="number" min="1" max="16" value={bars}
                        onChange={e => setBars(+e.target.value || 4)} />
                </div>
            </div>

            {/* チャット履歴 */}
            <div
                ref={scrollRef}
                style={{
                    maxHeight: 280,
                    overflowY: 'auto',
                    padding: 8,
                    background: 'rgba(0,0,0,0.15)',
                    borderRadius: 4,
                    margin: '8px 0',
                    fontSize: 11,
                }}
            >
                {messages.length === 0 && (
                    <div style={{ color: 'var(--text-dim)', fontSize: 10, lineHeight: 1.6 }}>
                        例:
                        <ul style={{ marginLeft: 12, marginTop: 4 }}>
                            {EXAMPLE_PROMPTS.map(p => (
                                <li key={p}
                                    style={{ cursor: 'pointer', marginBottom: 2 }}
                                    onClick={() => setInput(p)}
                                >{p}</li>
                            ))}
                        </ul>
                    </div>
                )}
                {messages.map((msg, i) => (
                    <div key={i} style={{ marginBottom: 10 }}>
                        {msg.role === 'user' && (
                            <div style={{
                                color: 'var(--accent)',
                                fontWeight: 600,
                                fontSize: 11,
                                padding: '4px 6px',
                                borderLeft: '2px solid var(--accent)',
                            }}>
                                {msg.text}
                            </div>
                        )}
                        {msg.role === 'assistant' && msg.response && (
                            <div style={{
                                padding: '6px 8px',
                                background: 'rgba(212, 164, 76, 0.08)',
                                borderRadius: 4,
                                marginTop: 4,
                            }}>
                                <div style={{ color: 'var(--text)', marginBottom: 4 }}>
                                    {msg.text}
                                    {backendBadge(msg.response.backend)}
                                </div>
                                <div style={{ color: 'var(--text-dim)', fontSize: 10, marginBottom: 6 }}>
                                    {msg.response.notes.length}ノート
                                </div>
                                <div style={{ display: 'flex', gap: 4 }}>
                                    <button
                                        style={{
                                            flex: 1,
                                            fontSize: 10,
                                            padding: '4px 6px',
                                            background: 'var(--accent)',
                                            color: 'var(--bg-deep)',
                                            border: 'none',
                                            borderRadius: 3,
                                            cursor: 'pointer',
                                            fontWeight: 600,
                                        }}
                                        onClick={() => msg.response && handleApply(msg.response, true)}
                                    >ピアノロールに適用</button>
                                    <button
                                        style={{
                                            flex: 1,
                                            fontSize: 10,
                                            padding: '4px 6px',
                                            background: 'transparent',
                                            color: 'var(--accent)',
                                            border: '1px solid var(--accent)',
                                            borderRadius: 3,
                                            cursor: 'pointer',
                                        }}
                                        onClick={() => msg.response && handleApply(msg.response, false)}
                                    >末尾に追加</button>
                                </div>
                            </div>
                        )}
                        {msg.role === 'error' && (
                            <div style={{
                                color: '#e74c3c',
                                fontSize: 10,
                                padding: '4px 6px',
                                background: 'rgba(231, 76, 60, 0.1)',
                                borderRadius: 4,
                            }}>
                                {msg.text}
                            </div>
                        )}
                    </div>
                ))}
                {loading && (
                    <div style={{ color: 'var(--text-dim)', fontSize: 10, fontStyle: 'italic' }}>
                        生成中...
                    </div>
                )}
            </div>

            {/* 入力欄 */}
            <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="例: 4小節の切ないメロディ&#10;Ctrl+Enter で送信"
                rows={3}
                style={{ resize: 'vertical', minHeight: 50, fontSize: 11 }}
                disabled={loading}
            />
            <button
                className="action-btn"
                onClick={handleSend}
                disabled={loading || !input.trim()}
                {...h('プロンプトを送信してノート提案を受け取る')}
            >
                {loading ? '生成中...' : '送信'}
            </button>
        </div>
    );
}
