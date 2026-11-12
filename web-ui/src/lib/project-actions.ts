/**
 * bunri DAW — プロジェクトの保存・別名で保存・開く・最近使ったプロジェクト・新規、と保存していない変更の確かめ。
 *
 * 置き場は 2 通り（どちらも sidecar はデータ置き場の外を読み書きしない。docs/desktop-architecture.md「プロジェクトのファイル」）。
 *
 * - デスクトップ版: 保存・開くはネイティブのダイアログ（Rust）。sidecar が作業用の写し（work/）に書いたものを、
 *   Rust が選ばれた場所へ写す。最近使ったプロジェクトは Rust がデータ置き場に持つ
 * - 開発用のブラウザ起動（Tauri が無い）: 名前を尋ね、データ置き場の projects/ に置く。一覧もそこから作る
 *
 * 以前の形式（projects/*.json）は、どちらでも開く一覧に「以前の形式」として出す（音声は無い）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { EMPTY_PROJECT, useDaw, type ProjectInfo } from './store';
import engine from './engine';
import { apiFetch, describeError, errorDetail, invokeDesktop, isDesktop, listenDesktop } from './api';
import { applyDocument, buildDocument, resetSections, uploadAudio, type ProjectDocument } from './project-file';
import { askName, askOpen, askUnsaved, type OpenEntry } from './project-prompts';
import { chartIdOfParts, setChartIdOfParts } from './learn';

/** まだ名前の無いプロジェクトの呼び名。 */
export const UNTITLED = '無題のプロジェクト';

/** デスクトップ版の、最近使ったプロジェクト 1 件（src-tauri/src/project.rs の RecentView）。 */
interface RecentView { path: string; name: string; exists: boolean; opened_at: number }
/** デスクトップ版の、開いたファイル。 */
interface OpenedFile { path: string; name: string; token: string }
/** データ置き場の projects/ の 1 件（backend/project_store.py の library_list）。 */
interface LibraryItem { file: string; name: string; kind: 'bunri' | 'legacy'; modified: number; size_bytes: number }

/** 保存の途中か（保存を 2 つ同時に走らせない）。 */
let saving = false;

/** 大きさを「12.3 MB」の形にする。 */
export function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

/** 窓の題名（「曲名 ● — bunri」。● は保存していない変更が在るしるし）。 */
export function windowTitle(name: string | null, dirty: boolean): string {
    return `${name || UNTITLED}${dirty ? ' ●' : ''} — bunri`;
}

async function library(): Promise<LibraryItem[]> {
    const resp = await apiFetch('/api/project/library');
    if (!resp.ok) throw new Error(await errorDetail(resp));
    return ((await resp.json()) as { projects: LibraryItem[] }).projects;
}

/** 開く一覧の中身を作る（デスクトップ版: 最近使ったプロジェクト + 以前の形式。ブラウザ起動: projects/ の全部）。 */
export async function listOpenEntries(): Promise<OpenEntry[]> {
    const entries: OpenEntry[] = [];
    if (isDesktop()) {
        const recent = await invokeDesktop<RecentView[]>('recent_projects');
        for (const r of recent) {
            entries.push({ key: `path:${r.path}`, name: r.name, detail: r.path, kind: 'bunri', exists: r.exists, removable: true, time: r.opened_at });
        }
    }
    let items: LibraryItem[] = [];
    try { items = await library(); } catch { /* 以前の形式が出ないだけ */ }
    for (const it of items) {
        if (isDesktop() && it.kind !== 'legacy') continue;
        entries.push({
            key: `file:${it.file}`, name: it.name, detail: it.kind === 'legacy' ? '以前の形式（音声は入っていません）' : formatBytes(it.size_bytes),
            kind: it.kind, exists: true, removable: false, time: Math.round(it.modified),
        });
    }
    return entries;
}

/** 一覧から外す（デスクトップ版の最近使ったプロジェクトだけ。ファイルは消さない）。外したあとの一覧を返す。 */
export async function removeOpenEntry(entry: OpenEntry): Promise<OpenEntry[]> {
    if (entry.removable && entry.key.startsWith('path:')) {
        await invokeDesktop('recent_project_remove', { path: entry.key.slice('path:'.length) });
    }
    return listOpenEntries();
}

/**
 * プロジェクトの操作。ヘッダのメニュー・空の状態の一覧・ショートカットから使う。
 */
export function useProjectActions() {
    const daw = useDaw();
    // 操作は非同期で長いので、最新の状態を ref で読む (古い描画の値で保存しないように)
    const ref = useRef(daw);
    useLayoutEffect(() => { ref.current = daw; });

    /** 保存の名前の候補（曲のファイル名、カルテの元のファイル名、無ければ「無題のプロジェクト」）。 */
    const suggestedName = useCallback(() => {
        const d = ref.current;
        if (d.project.name) return d.project.name;
        const raw = d.songFile?.name ?? d.chart?.source?.filename ?? '';
        return raw.replace(/\.[^.]+$/, '') || UNTITLED;
    }, []);

    /**
     * 保存する。行き先が決まっていなければ（初めての保存・別名で保存）、デスクトップ版はダイアログ、
     * ブラウザ起動は名前を尋ねる。
     * @returns 保存できたら true（取り消し・失敗なら false）
     */
    const save = useCallback(async (asNew = false): Promise<boolean> => {
        if (saving) { ref.current.setStatus('いま保存しています。終わってからもう一度押してください'); return false; }
        const d0 = ref.current;
        d0.pianoRollRef.current?._saveToEngine?.();
        let path = d0.project.path, file = d0.project.file, name = suggestedName();
        const firstTime = isDesktop() ? !path : !file;
        if (asNew || firstTime || d0.project.legacy) {
            if (isDesktop()) {
                try {
                    path = await invokeDesktop<string | null>('project_pick_save', { suggestedName: name });
                } catch (e) {
                    d0.setStatus('保存先を選べませんでした。' + describeError(e), 'error');
                    return false;
                }
                if (!path) return false;
                name = path.split('/').pop()!.replace(/\.bunri$/i, '');
            } else {
                const typed = await askName(asNew ? '別名で保存' : 'プロジェクトを保存', name);
                if (typed === null) return false;
                name = typed.trim() || UNTITLED;
                file = null;
            }
        }

        saving = true;
        const d = ref.current;
        const baseline = d.captureBaseline();
        d.setStatus(`プロジェクト「${name}」を保存しています…`);
        try {
            const { doc, audio } = await buildDocument({
                name, createdAt: d.project.createdAt, uuid: d.project.uuid,
                chart: d.chart, chartId: d.chartId, chartPeaks: d.chartPeaks, songFile: d.songFile,
                ghostChoice: d.ghostChoice, coachPair: d.coachPair, coachResult: d.coachResult,
                learnHistory: d.learnHistory, leftTab: d.leftTab, learnTab: d.learnTab,
                openTrackId: d.pianoRollRef.current?.getActiveTrackId?.() ?? null,
                partsUseChart: !!d.chartId && chartIdOfParts() === d.chartId,
            });
            await uploadAudio(doc, audio, d.project.token, (done, total) => {
                ref.current.setStatus(`プロジェクト「${name}」を保存しています…（音声 ${done}/${total}）`);
            });
            const resp = await apiFetch('/api/project/document', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base: d.project.token, document: doc }),
            });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const written = (await resp.json()) as { token: string; size_bytes: number };

            const next: ProjectInfo = {
                ...ref.current.project, name, token: written.token, legacy: false,
                createdAt: doc.meta.createdAt ?? ref.current.project.createdAt ?? new Date().toISOString(),
            };
            if (isDesktop()) {
                const saved = await invokeDesktop<{ path: string; name: string }>('project_commit', { token: written.token, path });
                next.path = saved.path;
                next.name = saved.name;
            } else {
                const body = file ? { token: written.token, file } : { token: written.token, name };
                const lib = await apiFetch('/api/project/library/save', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                });
                if (!lib.ok) throw new Error(await errorDetail(lib));
                const placed = (await lib.json()) as { file: string; name: string };
                next.file = placed.file;
                next.name = placed.name;
            }
            ref.current.setProject(next);
            ref.current.markSaved(baseline);
            ref.current.setStatus(`プロジェクト「${next.name}」を保存しました（${formatBytes(written.size_bytes)}）`);
            return true;
        } catch (e) {
            ref.current.setStatus('プロジェクトを保存できませんでした。' + describeError(e), 'error');
            return false;
        } finally {
            saving = false;
        }
    }, [suggestedName]);

    /**
     * 保存していない変更が在れば、どうするか尋ねる。
     * @param action - これからすること（窓の文に出す）
     * @returns 続けてよければ true（保存した、または保存しないと決めた。変更が無い）
     */
    const confirmDiscard = useCallback(async (action: string): Promise<boolean> => {
        if (!ref.current.isDirty) return true;
        const choice = await askUnsaved(action);
        if (choice === 'cancel') return false;
        if (choice === 'save') return save(false);
        return true;
    }, [save]);

    /** 開いた文書を画面に戻す。 */
    const applyOpened = useCallback(async (doc: ProjectDocument, info: Partial<ProjectInfo>) => {
        const d = ref.current;
        const result = await applyDocument(doc, {
            setBpm: d.setBpm, setBeatsPerBar: d.setBeatsPerBar, setGridOffset: d.setGridOffset,
            setChartResult: d.setChartResult, clearChart: d.clearChart, setSongFile: d.setSongFile,
            setGhostChoice: d.setGhostChoice, setCoachPair: d.setCoachPair, setCoachResult: d.setCoachResult,
            setLearnHistory: d.setLearnHistory, setLeftTab: d.setLeftTab, setLearnTab: d.setLearnTab,
            setChartIdOfParts, pianoRoll: d.pianoRollRef.current,
        });
        const legacy = doc.source?.kind === 'legacy';
        d.setProject({
            ...EMPTY_PROJECT, name: info.name ?? doc.meta.name ?? null, path: info.path ?? null, file: info.file ?? null,
            token: doc.token ?? null, legacy, createdAt: doc.meta.createdAt ?? null, uuid: doc.meta.uuid ?? null,
        });
        // 開くと、新しい文書になる。元に戻すの履歴は前のプロジェクトのものなので消す
        d.clearHistory();
        d.markSaved();
        d.bumpTracks();
        const name = info.name ?? doc.meta.name;
        const missing = result.missingClips > 0
            ? `。音声の無いクリップが ${result.missingClips} 個あります（上の「音声を読み込み直す」で戻せます）`
            : '';
        if (legacy) {
            d.setStatus(`以前の形式のプロジェクト「${name}」を読み込みました${missing}。保存すると .bunri になります`);
        } else {
            d.setStatus(`プロジェクト「${name}」を開きました${missing}`);
        }
    }, []);

    /** 作業用の写しを開く。 */
    const openToken = useCallback(async (token: string, info: Partial<ProjectInfo>) => {
        const resp = await apiFetch(`/api/project/open/${token}`, { method: 'POST' });
        if (!resp.ok) throw new Error(await errorDetail(resp));
        await applyOpened((await resp.json()) as ProjectDocument, info);
    }, [applyOpened]);

    /** 一覧の 1 件を開く（保存していない変更を確かめてから）。 */
    const openEntry = useCallback(async (entry: OpenEntry): Promise<void> => {
        const d = ref.current;
        if (!entry.exists) { d.setStatus(`「${entry.name}」が見つかりません。移動したか、消した可能性があります`, 'error'); return; }
        if (!(await confirmDiscard('別のプロジェクトを開く'))) return;
        d.setStatus(`「${entry.name}」を開いています…`);
        try {
            if (entry.key.startsWith('path:')) {
                const opened = await invokeDesktop<OpenedFile>('project_open_recent', { path: entry.key.slice('path:'.length) });
                await openToken(opened.token, { name: opened.name, path: opened.path });
                return;
            }
            const file = entry.key.slice('file:'.length);
            const resp = await apiFetch('/api/project/library/open', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }),
            });
            if (!resp.ok) throw new Error(await errorDetail(resp));
            const got = (await resp.json()) as { token?: string; document?: ProjectDocument };
            if (got.document) await applyOpened(got.document, { name: entry.name });
            else if (got.token) await openToken(got.token, { name: entry.name, file: entry.kind === 'bunri' ? file : null });
        } catch (e) {
            ref.current.setStatus(`「${entry.name}」を開けませんでした。` + describeError(e), 'error');
        }
    }, [confirmDiscard, openToken, applyOpened]);

    /** 「開く」。一覧から選ぶ（デスクトップ版は「ほかのファイルを選ぶ…」でダイアログも出せる）。 */
    const open = useCallback(async (): Promise<void> => {
        let entries: OpenEntry[];
        try {
            entries = await listOpenEntries();
        } catch (e) {
            ref.current.setStatus('プロジェクトの一覧を読めませんでした。' + describeError(e), 'error');
            return;
        }
        const choice = await askOpen(entries, isDesktop(), removeOpenEntry);
        if (!choice) return;
        if (choice !== 'browse') { await openEntry(choice); return; }
        if (!(await confirmDiscard('別のプロジェクトを開く'))) return;
        try {
            const opened = await invokeDesktop<OpenedFile | null>('project_pick_open');
            if (!opened) return;
            ref.current.setStatus(`「${opened.name}」を開いています…`);
            await openToken(opened.token, { name: opened.name, path: opened.path });
        } catch (e) {
            ref.current.setStatus('プロジェクトを開けませんでした。' + describeError(e), 'error');
        }
    }, [openEntry, confirmDiscard, openToken]);

    /** 新しいプロジェクトにする（保存していない変更を確かめてから）。 */
    const newProject = useCallback(async (): Promise<void> => {
        if (!(await confirmDiscard('新しいプロジェクトにする'))) return;
        const d = ref.current;
        engine.stop();
        d.setIsPlaying(false);
        d.pianoRollRef.current?.switchToTrack?.(null);
        for (const t of [...engine.tracks]) engine.removeTrack(t.id);
        d.clearChart();
        d.setSongFile(null);
        d.setGhostChoice('auto');
        d.setCoachPair({ referenceId: null, attemptId: null });
        d.setLearnHistory([]);
        setChartIdOfParts(null);
        resetSections();
        d.setBpm(120);
        d.setBeatsPerBar(4);
        d.setGridOffset(0);
        d.setProject(EMPTY_PROJECT);
        d.clearHistory();
        d.markSaved();
        d.openLearn('song');
        d.bumpTracks();
        d.setStatus('新しいプロジェクトにしました');
    }, [confirmDiscard]);

    return { save, open, openEntry, newProject, confirmDiscard };
}

/**
 * 窓の題名と、保存していない変更をデスクトップ版の殻に知らせ、⌘S / ⇧⌘S / ⌘O と、窓を閉じる前の確かめを受ける。
 * 画面に 1 つだけ置く（HeaderBar）。
 */
export function useProjectWiring(actions: ReturnType<typeof useProjectActions>): void {
    const { project, isDirty } = useDaw();
    const title = windowTitle(project.name, isDirty);

    useEffect(() => {
        document.title = title;
        if (isDesktop()) void invokeDesktop('document_state', { dirty: isDirty, title }).catch(() => { /* 題名が変わらないだけ */ });
    }, [title, isDirty]);

    const latest = useRef(actions);
    useLayoutEffect(() => { latest.current = actions; });

    // ⌘S 保存 / ⇧⌘S 別名で保存 / ⌘O 開く。窓 (確かめなど) が開いているあいだは受けない
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
            if (document.querySelector('[aria-modal="true"]')) return;
            const key = (e.key || '').toLowerCase();
            if (key === 's' || e.code === 'KeyS') {
                e.preventDefault();
                void latest.current.save(e.shiftKey);
            } else if (!e.shiftKey && (key === 'o' || e.code === 'KeyO')) {
                e.preventDefault();
                void latest.current.open();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    // 窓を閉じる・⌘Q の前に、Rust が尋ねてくる (保存していない変更が在るときだけ)
    useEffect(() => {
        if (!isDesktop()) return;
        let unlisten: (() => void) | null = null;
        let gone = false;
        void listenDesktop<{ quit?: boolean }>('close-requested', async (payload) => {
            const quit = !!payload?.quit;
            if (await latest.current.confirmDiscard(quit ? 'アプリを終える' : '窓を閉じる')) {
                await invokeDesktop('close_confirmed', { quit });
            }
        }).then((fn) => { if (gone) fn(); else unlisten = fn; }).catch(() => { /* 窓が閉じる前に尋ねられないだけ */ });
        return () => { gone = true; unlisten?.(); };
    }, []);
}
