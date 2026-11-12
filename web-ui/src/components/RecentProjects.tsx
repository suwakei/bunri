/**
 * bunri DAW — 最近使ったプロジェクト（空の状態の案内に出す一覧）。
 * デスクトップ版は Rust が持つ一覧と以前の形式、開発用のブラウザ起動はデータ置き場の projects/（lib/project-actions.ts）。
 */
import { useEffect, useState } from 'react';
import { listOpenEntries, removeOpenEntry, useProjectActions } from '../lib/project-actions';
import type { OpenEntry } from '../lib/project-prompts';
import { OpenEntryRow } from './ProjectDialogs';

/** 空の状態に出す件数。 */
const SHOWN = 5;

export default function RecentProjects() {
    const { openEntry } = useProjectActions();
    const [entries, setEntries] = useState<OpenEntry[] | null>(null);

    useEffect(() => {
        let stale = false;
        listOpenEntries().then((list) => { if (!stale) setEntries(list); }).catch(() => { if (!stale) setEntries([]); });
        return () => { stale = true; };
    }, []);

    if (!entries || entries.length === 0) return null;
    return (
        <section className="recent-projects" aria-labelledby="recent-title">
            <h3 id="recent-title">最近使ったプロジェクト</h3>
            <ul className="project-entries" aria-label="最近使ったプロジェクト">
                {entries.slice(0, SHOWN).map((entry) => (
                    <OpenEntryRow key={entry.key} entry={entry} onOpen={() => void openEntry(entry)}
                        onRemove={() => { void removeOpenEntry(entry).then(setEntries); }} />
                ))}
            </ul>
        </section>
    );
}
