/**
 * bunri DAW — データの整理（アプリのデータの置き場の使用量と、一時ファイルの整理）。
 *
 * 消すのは、置き場の中の作業用の一時ファイル（取り込んだ音声の写し・分離や加工の結果・カルテの作業ファイル・
 * 作業中のプロジェクトの写し）だけ。保存したプロジェクト（.bunri）は音声とカルテを中に持っているので、消しても開ける。
 * いま開いているプロジェクトとカルテ、保存したガイドと説明、利用者が選んだ場所のファイルには触らない
 * （何を消すかの決まりは backend/project_store.py の `cleanup`）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useDaw } from '../lib/store';
import { apiFetch, describeError, errorDetail } from '../lib/api';
import { formatBytes } from '../lib/project-actions';

interface Usage {
    data_dir: string;
    total_bytes: number;
    categories: { key: string; label: string; bytes: number; files: number; cleanable: boolean }[];
}

export default function DataCleanup() {
    const { project, chartId, setStatus } = useDaw();
    const [usage, setUsage] = useState<Usage | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');

    const load = useCallback(async () => {
        try {
            const resp = await apiFetch('/api/storage');
            if (resp.ok) setUsage(await resp.json());
        } catch { /* 使用量が出ないだけ */ }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const cleanup = useCallback(async () => {
        setBusy(true);
        setMessage('');
        try {
            const resp = await apiFetch('/api/storage/cleanup', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keep_tokens: project.token ? [project.token] : [], keep_charts: chartId ? [chartId] : [] }),
            });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const result = await resp.json() as { removed_files: number; freed_bytes: number; usage: Usage };
            setUsage(result.usage);
            const text = result.removed_files > 0
                ? `一時ファイルを ${result.removed_files} 個消しました（${formatBytes(result.freed_bytes)} 空きました）`
                : '消せる一時ファイルはありませんでした（5 分以内に作ったものは残します）';
            setMessage(text);
            setStatus(text);
        } catch (e) {
            setMessage('整理できませんでした。' + describeError(e));
        } finally {
            setBusy(false);
        }
    }, [project.token, chartId, setStatus]);

    return (
        <section id="data-cleanup" aria-labelledby="data-cleanup-title">
            <h3 id="data-cleanup-title">データの整理</h3>
            <p className="panel-desc">
                アプリのデータの置き場にたまる一時ファイルを消します。保存したプロジェクト（.bunri）は音声とカルテを中に持っているので、消しても開けます。
                いま開いているプロジェクト、保存したガイドと説明、自分で選んだ場所に保存したファイルは消しません。
            </p>
            {usage && (
                <table className="usage-table">
                    <tbody>
                        {usage.categories.map((c) => (
                            <tr key={c.key}>
                                <th scope="row">{c.label}</th>
                                <td>{formatBytes(c.bytes)}</td>
                            </tr>
                        ))}
                        <tr><th scope="row">合計</th><td>{formatBytes(usage.total_bytes)}</td></tr>
                    </tbody>
                </table>
            )}
            <button type="button" className="action-btn" onClick={cleanup} disabled={busy}>
                {busy ? '整理しています…' : '一時ファイルを整理する'}
            </button>
            {message && <p className="note-text" role="status">{message}</p>}
        </section>
    );
}
