/**
 * bunri DAW — プロジェクトの操作が尋ねる窓（保存していない変更・名前・開く一覧）。画面に 1 つだけ置く（DawPage）。
 * 何を尋ねるかは lib/project-prompts.ts、尋ねる操作は lib/project-actions.ts。
 */
import { useRef, useState, type FormEvent } from 'react';
import { useDialog } from '../lib/dialog';
import { useProjectPrompt, type OpenEntry, type ProjectPrompt } from '../lib/project-prompts';

/** 時刻を「11/12 10:05」の形にする。 */
function shortTime(sec: number | null): string {
    if (!sec) return '';
    return new Date(sec * 1000).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 開く一覧の 1 行（空の状態の「最近使ったプロジェクト」でも使う）。 */
export function OpenEntryRow({ entry, onOpen, onRemove }: { entry: OpenEntry; onOpen: () => void; onRemove?: () => void }) {
    return (
        <li className={'project-entry' + (entry.exists ? '' : ' missing')}>
            <button type="button" className="project-entry-open" onClick={onOpen} disabled={!entry.exists}
                title={entry.exists ? entry.detail : `見つかりません: ${entry.detail}`}>
                <span className="project-entry-name">{entry.name}</span>
                {entry.kind === 'legacy' && <span className="project-badge">以前の形式</span>}
                {!entry.exists && <span className="project-badge warn">見つかりません</span>}
                <span className="project-entry-detail">{entry.detail}</span>
                {entry.time ? <span className="project-entry-time">{shortTime(entry.time)}</span> : null}
            </button>
            {entry.removable && onRemove && (
                <button type="button" className="project-entry-remove" onClick={onRemove}
                    aria-label={`「${entry.name}」を一覧から外す`} title="一覧から外します（ファイルは消しません）">×</button>
            )}
        </li>
    );
}

function UnsavedDialog({ prompt }: { prompt: Extract<ProjectPrompt, { kind: 'unsaved' }> }) {
    const ref = useRef<HTMLDivElement>(null);
    useDialog(ref, true, () => prompt.resolve('cancel'));
    return (
        <div className="project-overlay">
            <div className="project-modal" ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-desc" tabIndex={-1}>
                <h2 id="unsaved-title">保存していない変更があります</h2>
                <p id="unsaved-desc">{prompt.action}前に、いまのプロジェクトを保存しますか。保存しないと、最後に保存してからの変更（トラック・ノート・学習の記録など）は消えます。</p>
                <div className="project-actions">
                    <button type="button" className="action-btn primary" data-autofocus onClick={() => prompt.resolve('save')}>保存</button>
                    <button type="button" className="action-btn secondary danger" onClick={() => prompt.resolve('discard')}>保存しない</button>
                    <button type="button" className="action-btn secondary" onClick={() => prompt.resolve('cancel')}>キャンセル</button>
                </div>
            </div>
        </div>
    );
}

function NameDialog({ prompt }: { prompt: Extract<ProjectPrompt, { kind: 'name' }> }) {
    const ref = useRef<HTMLDivElement>(null);
    const [name, setName] = useState(prompt.initial);
    useDialog(ref, true, () => prompt.resolve(null));
    const submit = (e: FormEvent) => { e.preventDefault(); prompt.resolve(name); };
    return (
        <div className="project-overlay">
            <div className="project-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="name-title" tabIndex={-1}>
                <h2 id="name-title">{prompt.title}</h2>
                <form onSubmit={submit}>
                    <label htmlFor="project-name">プロジェクトの名前</label>
                    <input id="project-name" type="text" value={name} data-autofocus maxLength={80}
                        onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
                    <p className="note-text">開発用のブラウザ起動では、アプリのデータの置き場（projects/）に保存します。</p>
                    <div className="project-actions">
                        <button type="submit" className="action-btn primary">保存</button>
                        <button type="button" className="action-btn secondary" onClick={() => prompt.resolve(null)}>キャンセル</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

function OpenDialog({ prompt }: { prompt: Extract<ProjectPrompt, { kind: 'open' }> }) {
    const ref = useRef<HTMLDivElement>(null);
    const [entries, setEntries] = useState(prompt.entries);
    useDialog(ref, true, () => prompt.resolve(null));
    return (
        <div className="project-overlay">
            <div className="project-modal wide" ref={ref} role="dialog" aria-modal="true" aria-labelledby="open-title" tabIndex={-1}>
                <h2 id="open-title">プロジェクトを開く</h2>
                {entries.length === 0
                    ? <p className="body-text">{prompt.canBrowse ? '最近使ったプロジェクトはまだありません。' : '保存したプロジェクトはまだありません。'}</p>
                    : (
                        <ul className="project-entries" aria-label="最近使ったプロジェクト">
                            {entries.map((entry) => (
                                <OpenEntryRow key={entry.key} entry={entry} onOpen={() => prompt.resolve(entry)}
                                    onRemove={() => { void prompt.onRemove(entry).then(setEntries); }} />
                            ))}
                        </ul>
                    )}
                <div className="project-actions">
                    {prompt.canBrowse && (
                        <button type="button" className="action-btn primary" data-autofocus onClick={() => prompt.resolve('browse')}>ほかのファイルを選ぶ…</button>
                    )}
                    <button type="button" className="action-btn secondary" onClick={() => prompt.resolve(null)}>キャンセル</button>
                </div>
            </div>
        </div>
    );
}

/** いまの問いの窓（問いが無ければ何も出さない）。 */
export default function ProjectDialogs() {
    const prompt = useProjectPrompt();
    if (!prompt) return null;
    if (prompt.kind === 'unsaved') return <UnsavedDialog prompt={prompt} />;
    if (prompt.kind === 'name') return <NameDialog prompt={prompt} />;
    // 問いが替わったら作り直す (前の一覧を残さない)
    return <OpenDialog key={prompt.entries.map(e => e.key).join('\n')} prompt={prompt} />;
}
