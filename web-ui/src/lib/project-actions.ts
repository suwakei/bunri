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
 *
 * 保存していない変更は、ときどき復旧用の写しとして残す（自動保存。lib/autosave.ts）。利用者のファイルは、
 * 利用者が保存したときにだけ書く。落ちたあとの起動では「続きを開きますか」と尋ねる（`useProjectWiring`）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { EMPTY_PROJECT, useDaw, type DawContextType, type ProjectInfo } from './store';
import engine from './engine';
import { SWING_NONE } from './grid';
import { apiFetch, describeError, errorDetail, invokeDesktop, isDesktop, listenDesktop } from './api';
import { applyDocument, buildDocument, resetSections, uploadAudio, type BuildInput, type ProjectDocument } from './project-file';
import { askName, askOpen, askRecovery, askUnsaved, type OpenEntry } from './project-prompts';
import { chartIdOfParts, setChartIdOfParts } from './learn';
import { autosave, openRecoveryCopy, type RecoveryCopy, type RecoveryInfo } from './autosave';
import { health } from './health';
import { notify } from './notice';
import { jobTracker } from './jobs';
import { msSinceMidiMessage } from './useMidiInput';

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

/** 保存の名前の候補（プロジェクトの名前、曲のファイル名、カルテの元のファイル名、無ければ「無題のプロジェクト」）。 */
function suggestName(d: DawContextType): string {
    if (d.project.name) return d.project.name;
    const raw = d.songFile?.name ?? d.chart?.source?.filename ?? '';
    return raw.replace(/\.[^.]+$/, '') || UNTITLED;
}

/** いまの画面から、文書を作る材料を集める（利用者の保存と自動保存で、同じものを書く）。 */
function documentInput(d: DawContextType, name: string): BuildInput {
    return {
        name, createdAt: d.project.createdAt, uuid: d.project.uuid,
        chart: d.chart, chartId: d.chartId, chartPeaks: d.chartPeaks, songFile: d.songFile,
        ghostChoice: d.ghostChoice, coachPair: d.coachPair, coachResult: d.coachResult,
        learnHistory: d.learnHistory, leftTab: d.leftTab, learnTab: d.learnTab,
        openTrackId: d.pianoRollRef.current?.getActiveTrackId?.() ?? null,
        partsUseChart: !!d.chartId && chartIdOfParts() === d.chartId,
    };
}

/**
 * 自動保存: いまのプロジェクトの文書と音声を送り、作業用の写しに書く（復旧用の写しにするのは lib/autosave.ts）。
 * ステータスバーにも、保存済みの印にも、いま開いているプロジェクトの情報にも触らない。
 * @param cancelled - やめるよう言われたか（利用者の保存が始まった、など）
 * @returns 書いた写しと、目印に入れるプロジェクトの名前・場所。途中でやめたら null
 */
async function writeRecoveryCopy(d: DawContextType, cancelled: () => boolean): Promise<RecoveryCopy | null> {
    const base = autosave.baseFor(d.project.token);
    const { name, path, file } = d.project;
    const { doc, audio } = await buildDocument(documentInput(d, suggestName(d)));
    if (cancelled()) return null;
    await uploadAudio(doc, audio, base);
    if (cancelled()) return null;
    const resp = await apiFetch('/api/project/document', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, document: doc }),
    });
    if (!resp.ok) throw new Error(await errorDetail(resp));
    const written = (await resp.json()) as { token: string };
    return { token: written.token, name, path, file };
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
        try {
            await invokeDesktop('recent_project_remove', { path: entry.key.slice('path:'.length) });
        } catch (e) {
            // 外せなかったのに、黙って一覧に残したままにしない (ストアの外から呼ばれるので、知らせを直に出す)
            notify('error', `「${entry.name}」を一覧から外せませんでした。` + describeError(e), { live: true });
        }
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

    const suggestedName = useCallback(() => suggestName(ref.current), []);

    /**
     * 保存する。行き先が決まっていなければ（初めての保存・別名で保存）、デスクトップ版はダイアログ、
     * ブラウザ起動は名前を尋ねる。
     * @returns 保存できたら true（取り消し・失敗なら false）
     */
    const save = useCallback(async (asNew = false): Promise<boolean> => {
        if (saving) { ref.current.setStatus('いま保存しています。終わってからもう一度押してください', 'hint'); return false; }
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
        ref.current.setStatus(`プロジェクト「${name}」を保存しています…`);
        let resume = () => { /* まだ止めていない */ };
        try {
            // 利用者の保存を先に通す。途中の自動保存はやめさせ、止まるのを待つ (同じ音声の預かりを取り合わないように)
            resume = await autosave.hold();
            const d = ref.current;
            const baseline = d.captureBaseline();
            // 自動保存で送った音声は、復旧用の写しに在る。そこから写せば、送り直さずに済む
            const base = autosave.baseFor(d.project.token);
            const { doc, audio } = await buildDocument(documentInput(d, name));
            await uploadAudio(doc, audio, base, (done, total) => {
                ref.current.setStatus(`プロジェクト「${name}」を保存しています…（音声 ${done}/${total}）`);
            });
            const resp = await apiFetch('/api/project/document', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base, document: doc }),
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
            // 保存できたので、復旧用の写しは要らない (次の起動で「続きを開きますか」と尋ねない)
            await autosave.discard();
            ref.current.setStatus(`プロジェクト「${next.name}」を保存しました（${formatBytes(written.size_bytes)}）`);
            return true;
        } catch (e) {
            ref.current.setStatus('プロジェクトを保存できませんでした。' + describeError(e), 'error');
            return false;
        } finally {
            saving = false;
            resume();
        }
    }, [suggestedName]);

    /**
     * 保存していない変更が在れば、どうするか尋ねる。
     * @param action - これからすること（窓の文に出す）
     * @param options.urgent - 窓を閉じる前の確かめ。ほかの問いが出ていても先に出す（lib/project-prompts.ts）
     * @returns 続けてよければ true（保存した、または保存しないと決めた。変更が無い）
     */
    const confirmDiscard = useCallback(async (action: string, options: { urgent?: boolean } = {}): Promise<boolean> => {
        if (!ref.current.isDirty) return true;
        const choice = await askUnsaved(action, options);
        if (choice === 'cancel') return false;
        if (choice === 'save') return save(false);
        return true;
    }, [save]);

    /**
     * 開いた文書を画面に戻す。
     * @param recovered - 前回の続き（復旧用の写し）を開いたか。名前と場所を元のまま戻し、保存していない変更として開く
     */
    const applyOpened = useCallback(async (doc: ProjectDocument, info: Partial<ProjectInfo>, recovered = false) => {
        // 画面を作り直している途中の状態を、自動保存に書かせない
        const resume = await autosave.hold();
        try {
            const d = ref.current;
            const result = await applyDocument(doc, {
                setBpm: d.setBpm, setBeatsPerBar: d.setBeatsPerBar, setGridOffset: d.setGridOffset, setSwing: d.setSwing,
                setChartResult: d.setChartResult, clearChart: d.clearChart, setSongFile: d.setSongFile,
                setGhostChoice: d.setGhostChoice, setCoachPair: d.setCoachPair, setCoachResult: d.setCoachResult,
                setLearnHistory: d.setLearnHistory, setLeftTab: d.setLeftTab, setLearnTab: d.setLearnTab,
                setChartIdOfParts, pianoRoll: d.pianoRollRef.current,
            });
            const legacy = doc.source?.kind === 'legacy';
            d.setProject({
                // 前回の続きは、名前が無かった (まだ保存していなかった) なら、無いまま戻す
                ...EMPTY_PROJECT, name: recovered ? info.name ?? null : info.name ?? doc.meta.name ?? null,
                path: info.path ?? null, file: info.file ?? null,
                token: doc.token ?? null, legacy, createdAt: doc.meta.createdAt ?? null, uuid: doc.meta.uuid ?? null,
            });
            // 開くと、新しい文書になる。元に戻すの履歴は前のプロジェクトのものなので消す
            d.clearHistory();
            // 前回の続きは、まだどこにも保存されていない。保存するまで、保存していない変更のままにする
            if (recovered) d.markUnsaved(); else d.markSaved();
            d.bumpTracks();
            const name = info.name ?? doc.meta.name;
            const missing = result.missingClips > 0
                ? `。音声の無いクリップが ${result.missingClips} 個あります（上の「音声を読み込み直す」で戻せます）`
                : '';
            if (recovered) {
                d.setStatus(`前回の続き（「${info.name ?? UNTITLED}」）を開きました${missing}。まだ保存していないので、残すには保存してください`);
            } else if (legacy) {
                d.setStatus(`以前の形式のプロジェクト「${name}」を読み込みました${missing}。保存すると .bunri になります`);
            } else {
                d.setStatus(`プロジェクト「${name}」を開きました${missing}`);
            }
        } finally {
            resume();
        }
    }, []);

    /** 作業用の写しを開く。 */
    const openToken = useCallback(async (token: string, info: Partial<ProjectInfo>, recovered = false) => {
        const resp = await apiFetch(`/api/project/open/${token}`, { method: 'POST' });
        if (!resp.ok) throw new Error(await errorDetail(resp));
        await applyOpened((await resp.json()) as ProjectDocument, info, recovered);
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
        d.setSwing(SWING_NONE);
        d.setProject(EMPTY_PROJECT);
        d.clearHistory();
        d.markSaved();
        d.openLearn('song');
        d.bumpTracks();
        d.setStatus('新しいプロジェクトにしました');
    }, [confirmDiscard]);

    /**
     * 前回の続き（落ちたときの復旧用の写し）を開くか尋ね、答えのとおりにする。起動したときに 1 回だけ呼ぶ。
     * 開けなかったときは、復旧用の写しを残したまま、もう一度尋ねる（捨てるかどうかは利用者が決める）。
     *
     * 問いは置き換えられない（lib/project-prompts.ts が順番に出す）ので、ふつうは必ず答えが出る。それでも答えが
     * 出ないまま終わったら（思わぬ失敗）、写しを残したまま、前回の写しを上書きしない扱いにする（`startupUnanswered`）。
     */
    const offerRecovery = useCallback(async (info: RecoveryInfo): Promise<void> => {
        let answered = false;
        try {
            for (;;) {
                const choice = await askRecovery(info.name, info.saved_at, ref.current.isDirty);
                if (choice === 'discard') {
                    answered = true;
                    await autosave.startupAnswered(false);
                    ref.current.setStatus('前回の、保存していない変更を捨てました');
                    return;
                }
                ref.current.setStatus('前回の続きを開いています…');
                try {
                    const copy = await openRecoveryCopy();
                    let path = copy.path;
                    if (path && isDesktop()) {
                        // 元のファイルへ保存できるのは、最近使ったプロジェクトに在る場所だけ (Rust は、ほかの場所への書き込みを断る)。
                        // 一覧から外れていたら、場所は戻さない (保存のときに、初めての保存と同じく保存先を尋ねる)
                        const recent = await invokeDesktop<RecentView[]>('recent_projects').catch(() => [] as RecentView[]);
                        if (!recent.some((r) => r.path === path)) path = null;
                    }
                    await openToken(copy.token, { name: copy.name, path, file: copy.file }, true);
                    answered = true;
                    await autosave.startupAnswered(true);
                    return;
                } catch (e) {
                    ref.current.setStatus('前回の続きを開けませんでした。' + describeError(e), 'error');
                }
            }
        } finally {
            if (!answered) autosave.startupUnanswered();
        }
    }, [openToken]);

    return { save, open, openEntry, newProject, confirmDiscard, offerRecovery };
}

/** ドラッグの途中と見なす長さの上限（ミリ秒）。離したことを取りこぼしても、これを過ぎれば自動保存を止めない。 */
const POINTER_HOLD_LIMIT_MS = 60_000;
/**
 * リアルタイム録音で「弾いている最中」と見なす長さ（ミリ秒）。最後に鍵盤を押して（離して）からこれだけ経てば、
 * 弾く手が止まった合間として、再生中と同じ扱いにする。
 */
const MIDI_QUIET_MS = 3_000;
/**
 * 窓を閉じる前に、復旧用の写しを消すのを待つ上限（ミリ秒）。消せなくても、窓は閉じる。
 * 書き途中の自動保存（大きな音声の送信など）は待たない（`autosave.discard`）ので、待つのは消す要求の往復だけ。
 */
const CLOSE_DISCARD_TIMEOUT_MS = 3_000;

/**
 * 自動保存をつなぐ（lib/autosave.ts）。保存していない変更が在るあいだ、変更が落ち着いたら復旧用の写しを残し、
 * 変更が無くなったら消す。起動したときに、前回の続きが残っていれば尋ねる。画面に 1 つだけ置く（`useProjectWiring`）。
 */
function useAutosave(actions: ReturnType<typeof useProjectActions>): void {
    const daw = useDaw();
    const { isDirty, changeMark } = daw;
    const ref = useRef(daw);
    useLayoutEffect(() => { ref.current = daw; });
    const latest = useRef(actions);
    useLayoutEffect(() => { latest.current = actions; });

    // 何を書くか・いまは書かないほうがよいか、を自動保存に教える
    useEffect(() => {
        // ボタンを押しているあいだ (ノートやクリップのドラッグの途中) は書かない。途中の形を書き戻さないため
        let pressedAt: number | null = null;
        const press = () => { pressedAt = Date.now(); };
        const release = () => { pressedAt = null; };
        const move = (e: PointerEvent) => { if (e.buttons === 0) pressedAt = null; };
        window.addEventListener('pointerdown', press, true);
        window.addEventListener('pointerup', release, true);
        window.addEventListener('pointercancel', release, true);
        window.addEventListener('pointermove', move, true);
        window.addEventListener('blur', release);
        const detach = autosave.attach({
            isDirty: () => ref.current.isDirty,
            busy: () => {
                // ドラッグの途中。時間のかかる処理 (パート分離・カルテ) の最中 (処理を担当する部分が手一杯)。
                // 処理を担当する部分に届かない (戻ってから書く)。どれだけ経っても、このあいだは書かない
                if ((pressedAt !== null && Date.now() - pressedAt < POINTER_HOLD_LIMIT_MS)
                    || jobTracker.getSnapshot().active !== null
                    || health.getState().kind !== 'ok') return 'blocked';
                if (!engine.isPlaying) return null;
                // MIDI のリアルタイム録音で弾いている最中 (録音前のカウントを含む)。弾いた位置をずらさないよう、
                // 弾く手が止まった合間を待つ
                const midi = ref.current.midiRef.current;
                if (midi?.connected && midi.mode === 'realtime' && (engine.isCountingIn() || msSinceMidiMessage() < MIDI_QUIET_MS)) return 'recording';
                // 再生中。音の途切れを避けて待つが、区間ループを回し続けていても、決めた時間が過ぎたら書く
                return 'playing';
            },
            capture: () => ref.current.captureBaseline(),
            writeCopy: (cancelled) => writeRecoveryCopy(ref.current, cancelled),
            onFailing: (reason) => ref.current.setStatus(
                `自動保存ができていません。いまの変更を残すには、プロジェクトを保存してください（${reason}）`, 'error'),
        });
        return () => {
            detach();
            window.removeEventListener('pointerdown', press, true);
            window.removeEventListener('pointerup', release, true);
            window.removeEventListener('pointercancel', release, true);
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('blur', release);
        };
    }, []);

    // 変わるたびに、落ち着くのを待ち直す。保存していない変更が無くなったら、復旧用の写しを消す
    // (保存した・元に戻して保存したときと同じになった・保存しないと決めて開いた / 新しくした)
    const wasDirty = useRef(false);
    useEffect(() => {
        if (isDirty) autosave.touched();
        else if (wasDirty.current) void autosave.settled();
        wasDirty.current = isDirty;
    }, [isDirty, changeMark]);

    // 起動したとき: 前回の続きが残っていれば、1 回だけ尋ねる (処理を担当する部分が応えるようになってから)
    useEffect(() => {
        let gone = false;
        void autosave.checkStartup().then((found) => {
            if (gone || !found || !autosave.claimOffer()) return;
            void latest.current.offerRecovery(found);
        });
        return () => { gone = true; };
    }, []);
}

/**
 * 窓の題名と、保存していない変更をデスクトップ版の殻に知らせ、⌘S / ⇧⌘S / ⌘O と、窓を閉じる前の確かめを受ける。
 * 自動保存と、起動したときの「前回の続き」の問いもここでつなぐ。画面に 1 つだけ置く（HeaderBar）。
 */
export function useProjectWiring(actions: ReturnType<typeof useProjectActions>): void {
    const { project, isDirty } = useDaw();
    const title = windowTitle(project.name, isDirty);
    useAutosave(actions);

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
            // 窓を閉じる前の確かめは、ほかの問い (起動したときの「続きを開きますか」、開く一覧など) より先に出す。
            // 出ていた問いは取り下げず、閉じなかったらもう一度出す
            if (await latest.current.confirmDiscard(quit ? 'アプリを終える' : '窓を閉じる', { urgent: true })) {
                // 保存したか、保存しないと決めた。どちらでも、次の起動では「続きを開きますか」と尋ねない。
                // もう自動保存はしない (書き途中のものは待たずに、すぐ消す)
                await Promise.race([autosave.closing(), new Promise((resolve) => setTimeout(resolve, CLOSE_DISCARD_TIMEOUT_MS))]);
                try {
                    await invokeDesktop('close_confirmed', { quit });
                } catch (e) {
                    // 閉じられなかった。窓は残るので、自動保存を続ける
                    autosave.closeAborted();
                    throw e;
                }
            }
        }).then((fn) => { if (gone) fn(); else unlisten = fn; }).catch(() => { /* 窓が閉じる前に尋ねられないだけ */ });
        return () => { gone = true; unlisten?.(); };
    }, []);
}
