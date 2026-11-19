/** トラックの音色を選び、使う楽器の素材だけを用意する。 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { describeError, isDesktop } from '../lib/api';
import engine from '../lib/engine';
import { isDrumTrack } from '../lib/drums';
import { DEFAULT_INSTRUMENT_ID, fetchInstruments, instrumentGroups, markPackInstalled, type InstrumentStatus } from '../lib/instruments';
import { JobBusyError, JobCancelledError, jobErrorMessage } from '../lib/jobs';
import { useShowJob } from '../lib/job-focus';
import { useJob } from '../lib/useJob';
import { useDaw } from '../lib/store';
import { blockedBy } from '../lib/notice';
import { tip } from '../lib/tooltip';
import JobCard from './JobCard';

export default function PianoInstrument({ activeTrackId }: { activeTrackId: number | null }) {
    const instrumentSelectId = useId();
    const { setStatus, record, bumpTracks } = useDaw();
    const showJob = useShowJob();
    const [catalog, setCatalog] = useState<InstrumentStatus[] | null>(null);
    const [query, setQuery] = useState('');
    const [error, setError] = useState('');
    const [starting, setStarting] = useState(false);
    const desktop = isDesktop();
    const backend = useSyncExternalStore(engine.subscribeInstrument, engine.instrumentSnapshot, engine.instrumentSnapshot);
    const track = activeTrackId !== null ? engine.getTrack(activeTrackId) : null;
    const legacyDrums = !!track && !track.instrumentId && isDrumTrack(track, (id) => engine.getTrack(id));
    const selectedId = track?.instrumentId ?? (legacyDrums ? '' : DEFAULT_INSTRUMENT_ID);
    const selected = catalog?.find((item) => item.id === selectedId);
    const selection = useRef({ activeTrackId, selectedId });
    useLayoutEffect(() => { selection.current = { activeTrackId, selectedId }; }, [activeTrackId, selectedId]);
    const reportError = useCallback((reason: unknown) => {
        const message = describeError(reason);
        setError(message);
        setStatus('音色を用意できませんでした（' + message + '）', 'error');
    }, [setStatus]);
    const refresh = useCallback(async () => { setCatalog(await fetchInstruments()); setError(''); }, []);
    const reflectInstalled = useCallback(async (installed: InstrumentStatus) => {
        setCatalog((previous) => previous ? markPackInstalled(previous, installed) : previous);
        // 準備中に別のトラックや音色を選んでも、選び直した音色を元に戻さない。
        const target = selection.current;
        const current = target.activeTrackId !== null ? engine.getTrack(target.activeTrackId) : null;
        const currentId = target.selectedId;
        if (desktop && current && currentId === installed.id && !await engine.prepareInstrument(installed.id)) {
            throw new Error('素材を読み込めませんでした。もう一度、音色の状態を確認してください');
        }
        await refresh();
        setStatus(`「${installed.name}」を用意しました。曲は次の再生から反映します`);
    }, [desktop, refresh, setStatus]);
    const { job, busyJob, heavyBusy, active, run, cancel } = useJob('piano-instrument', (finished) => {
        if (finished.state === 'done' && finished.result) void reflectInstalled(finished.result as InstrumentStatus).catch(reportError);
        else if (finished.state === 'error') reportError(new Error(jobErrorMessage(finished)));
        else if (finished.state === 'cancelled') setStatus('音色の準備を中止しました');
    });
    useEffect(() => {
        let active = true;
        void fetchInstruments().then((items) => { if (active) { setCatalog(items); setError(''); } })
            .catch((reason) => { if (active) setError(describeError(reason)); });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        if (!desktop || activeTrackId === null || !selectedId) return;
        let active = true;
        void engine.prepareInstrument(selectedId).then((installed) => {
            if (active && !installed) setStatus('選んだ音色の素材がありません。音色の欄から用意してください', 'hint');
        }).catch((reason) => { if (active) reportError(reason); });
        return () => { active = false; };
    }, [activeTrackId, selectedId, desktop, reportError, setStatus]);

    if (!track) return <div className="piano-instrument">トラックを選ぶと音色を選べます</div>;
    const groups = instrumentGroups(catalog ?? [], query, selectedId);
    const change = (id: string) => {
        record(`「${track.name}」の音色を変更`, () => engine.setTrackInstrument(track.id, id || undefined));
        bumpTracks();
        setError('');
        setStatus(`音色を「${catalog?.find((item) => item.id === id)?.name ?? '従来のドラム'}」に変えました。曲は次の再生から反映します`);
    };
    const install = async () => {
        if (!selected) return;
        setStarting(true);
        try {
            const installed = await run<InstrumentStatus>(`/api/instruments/${encodeURIComponent(selected.id)}/install`, new FormData());
            await reflectInstalled(installed);
        } catch (reason) {
            if (reason instanceof JobCancelledError) setStatus('音色の準備を中止しました');
            else if (reason instanceof JobBusyError) setStatus(reason.message, 'hint');
            else reportError(reason);
        } finally { setStarting(false); }
    };
    const busyReason = heavyBusy ? `「${active?.title || 'ほかの処理'}」が終わるか、中止してから用意してください` : null;
    const sound = legacyDrums ? 'ドラム（従来の合成音）' : selected?.name ?? (catalog ? `見つからない音色（${selectedId}）` : '音色を確認中…');
    return (
        <div className="piano-instrument">
            <details>
                <summary>音色: {sound}{!desktop ? ' — 電子音（開発用のブラウザ）' : backend === 'failed' ? ' — 電子音（音の再生に失敗）' : selected && !selected.installed ? ' — 素材の準備が必要' : ''}</summary>
                <div className="piano-instrument-details">
                    <div className="instrument-picker">
                        <label>音色を探す<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ピアノ、ベース、声…" /></label>
                        <div className="instrument-field"><label htmlFor={instrumentSelectId}>このトラックの音色</label><select id={instrumentSelectId} value={selectedId} onChange={(event) => change(event.target.value)}>
                            {isDrumTrack(track, (id) => engine.getTrack(id)) && <option value="">ドラム（従来の合成音）</option>}
                            {selectedId && !selected && <option value={selectedId}>{catalog ? `見つからない音色（${selectedId}）` : '音色を確認中…'}</option>}
                            {[...groups].map(([category, items]) => <optgroup key={category} label={category}>
                                {items.map((item) => <option key={item.id} value={item.id}>{item.name}{!item.installed ? '（素材が必要）' : ''}</option>)}
                            </optgroup>)}
                        </select></div>
                    </div>
                    <p>選んだ音色は、このトラックの鍵盤の試聴・再生・WAV に使います。曲の音色変更は次の再生から反映します。</p>
                    {desktop && selected && !selected.installed && <p>先に、この音色の素材を用意してください。</p>}
                    {!desktop && <p>開発用のブラウザでは電子音で鳴らします。選んだ音色はプロジェクトに保存され、デスクトップアプリで使えます。</p>}
                    {selected && <>
                        {selected.description && <p>{selected.description}</p>}
                        <p>素材: {selected.packId} / {selected.author} / {selected.license}</p>
                        <p>出典: {selected.sourceUrl}</p>
                        <p>{selected.installed ? '素材は用意できています。同じ素材を使う音色も、ダウンロードせずに選べます。'
                            : selected.downloadBytes > 0 ? `初回に約 ${Math.ceil(selected.downloadBytes / 1_000_000)} MB をダウンロードします。同じ素材を使う音色も一緒に使えるようになります。`
                                : 'アプリの中で音色の素材を作ります。外部からのダウンロードはありません。'}</p>
                    </>}
                    {catalog && !selected && !legacyDrums && <p role="alert">この音色は現在の一覧にありません。選んだ音色のIDは保存したままです。一覧から別の音色を選んでください。</p>}
                    {error && <p role="alert">{error}</p>}
                    {backend === 'failed' && <p role="alert">音の再生を続けられないため、電子音で鳴らしています。アプリを開き直してください。</p>}
                    {!catalog && <button type="button" onClick={() => void refresh().catch(reportError)}>音色の状態を確認</button>}
                    {desktop && selected && !selected.installed && <button type="button" disabled={starting || heavyBusy}
                        {...blockedBy(busyReason || (starting && '音色を用意しています。終わるまでお待ちください'))}
                        {...tip('この音色が使う素材だけを用意します')} onClick={() => void install()}>
                        {selected.downloadBytes > 0 ? '音源をダウンロード' : '音色を用意する'}
                    </button>}
                </div>
            </details>
            <JobCard slot="piano-instrument" job={job} busyJob={busyJob}
                onCancel={() => void cancel().catch(reportError)} onShowBusy={showJob} />
        </div>
    );
}
