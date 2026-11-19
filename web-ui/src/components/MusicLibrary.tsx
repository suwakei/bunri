/** music/ に置いた曲を、ファイル選択画面を開かずに取り込みます。 */
import { useEffect, useRef, useState } from 'react';
import { listMusic, readMusic, type MusicEntry } from '../lib/music';
import { useDaw } from '../lib/store';
import { useLearnActions } from '../lib/learn';
import { tip } from '../lib/tooltip';
import { describeError } from '../lib/api';

export default function MusicLibrary() {
    const { autoBpm, openLearn, setStatus } = useDaw();
    const { importSong } = useLearnActions();
    const [entries, setEntries] = useState<MusicEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const alive = useRef(true);
    const importing = useRef(false);

    async function refresh() {
        setLoading(true);
        setError('');
        try { const list = await listMusic(); if (alive.current) setEntries(list); }
        catch (e) {
            if (alive.current) { setError(describeError(e)); setStatus(describeError(e), 'error'); }
        } finally { if (alive.current) setLoading(false); }
    }

    useEffect(() => {
        alive.current = true;
        void refresh();
        return () => { alive.current = false; };
        // 一覧は最初の表示と「一覧を更新」で読みます。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function select(name: string) {
        if (importing.current) return;
        importing.current = true;
        setBusy(true);
        try {
            const file = await readMusic(name);
            openLearn('song');
            await importSong(file, { autoBpm });
        } catch (e) { setStatus(describeError(e), 'error'); }
        finally { importing.current = false; if (alive.current) setBusy(false); }
    }

    return (
        <section className="music-library" aria-labelledby="music-library-title" aria-busy={loading || busy}>
            <div className="music-library-heading">
                <h3 id="music-library-title">music の曲</h3>
                <button type="button" className="action-btn secondary" disabled={loading || busy} onClick={() => void refresh()}
                    {...tip('music フォルダに追加した曲を、一覧に読み直します')}>一覧を更新</button>
            </div>
            <p>曲名を押すと取り込みが始まります。</p>
            {loading ? <p role="status">曲の一覧を読み込んでいます…</p>
                : error ? <p role="alert">{error}</p>
                    : entries.length === 0 ? <p>music フォルダに曲がありません。MP3・WAV などを置いて、一覧を更新してください。</p>
                        : <ul aria-label="music の曲">
                            {entries.map(({ name }) => <li key={name}>
                                <button type="button" className="action-btn secondary" disabled={busy} onClick={() => void select(name)}
                                    {...tip('この曲を原曲として取り込み、カルテを作ります')}>{name}</button>
                            </li>)}
                        </ul>}
            {busy && <p role="status">曲を取り込んでいます…</p>}
        </section>
    );
}
