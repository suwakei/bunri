/** 打ち込んだノートの音色と、ピアノの録音素材を用意する入口。 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch, describeError, errorDetail, isDesktop } from '../lib/api';
import engine from '../lib/engine';
import { isDrumTrack } from '../lib/drums';
import { JobBusyError, JobCancelledError, jobErrorMessage } from '../lib/jobs';
import { useShowJob } from '../lib/job-focus';
import { useJob } from '../lib/useJob';
import { useDaw } from '../lib/store';
import { blockedBy } from '../lib/notice';
import { tip } from '../lib/tooltip';
import JobCard from './JobCard';

interface PianoStatus {
    installed: boolean;
    downloadBytes: number;
    author: string;
    license: string;
    sourceUrl: string;
}

async function fetchPiano(): Promise<PianoStatus> {
    const resp = await apiFetch('/api/instruments/piano');
    if (!resp.ok) throw new Error(await errorDetail(resp));
    return await resp.json() as PianoStatus;
}

export default function PianoInstrument({ activeTrackId }: { activeTrackId: number | null }) {
    const { setStatus } = useDaw();
    const showJob = useShowJob();
    const [piano, setPiano] = useState<PianoStatus | null>(null);
    const [error, setError] = useState('');
    const [starting, setStarting] = useState(false);
    const desktop = isDesktop();
    const instrument = useSyncExternalStore(engine.subscribeInstrument, engine.instrumentSnapshot, engine.instrumentSnapshot);
    const refresh = useCallback(async () => {
        const next = await fetchPiano();
        setPiano(next);
        setError('');
    }, []);
    const reflectPiano = useCallback(async () => {
        if (!await engine.preparePiano()) throw new Error('ピアノ音源を読み込めませんでした。もう一度ダウンロードしてください');
        await refresh();
        setStatus('グランドピアノを用意しました。次の再生と鍵盤の試聴から使えます');
    }, [refresh, setStatus]);
    const reportError = useCallback((reason: unknown) => {
        const message = describeError(reason);
        setError(message);
        setStatus('ピアノ音源を用意できませんでした（' + message + '）', 'error');
    }, [setStatus]);
    const { job, busyJob, heavyBusy, active, run, cancel } = useJob('piano-instrument', (finished) => {
        if (finished.state === 'done') void reflectPiano().catch(reportError);
        else if (finished.state === 'error') reportError(new Error(jobErrorMessage(finished)));
        else if (finished.state === 'cancelled') setStatus('ピアノ音源のダウンロードを中止しました');
    });
    useEffect(() => {
        let active = true;
        if (desktop) void fetchPiano().then((next) => {
            if (active) { setPiano(next); setError(''); }
        }).catch((reason) => { if (active) setError(describeError(reason)); });
        return () => { active = false; };
    }, [desktop]);

    if (activeTrackId === null) return null;
    const track = engine.getTrack(activeTrackId);
    if (track && isDrumTrack(track, (id) => engine.getTrack(id))) return null;
    if (!desktop) return <div className="piano-instrument">音色: 電子音（開発用のブラウザ）</div>;

    const install = async () => {
        setStarting(true);
        try {
            await run<PianoStatus>('/api/instruments/piano/install', new FormData());
            await reflectPiano();
        } catch (reason) {
            if (reason instanceof JobCancelledError) setStatus('ピアノ音源のダウンロードを中止しました');
            else if (reason instanceof JobBusyError) setStatus(reason.message, 'hint');
            else reportError(reason);
        } finally {
            setStarting(false);
        }
    };
    const busyReason = heavyBusy ? `「${active?.title || 'ほかの処理'}」が終わるか、中止してからダウンロードしてください` : null;
    const sound = instrument === 'piano' ? 'グランドピアノ'
        : instrument === 'failed' ? '電子音（ピアノの再生に失敗）'
            : piano?.installed ? 'グランドピアノ（再生時に読み込み）' : '電子音';
    return (
        <div className="piano-instrument">
            <details>
                <summary>音色: {sound}{!piano?.installed && ' — ピアノ音源を用意する'}</summary>
                <div className="piano-instrument-details">
                    <p>ピアノの録音を使って、打ち込んだノートと鍵盤の試聴を鳴らします。WAV の書き出しにも同じ音源を使います。</p>
                    {piano && <>
                        <p>Salamander Grand Piano / {piano.author} / {piano.license} · 再構成: kinwie / 調律: Markus Fiedler</p>
                        <p>配布元: {piano.sourceUrl}</p>
                        <p>ライセンス: https://creativecommons.org/licenses/by/3.0/</p>
                    </>}
                    {!piano?.installed && piano && <p>初回に約 {Math.ceil(piano.downloadBytes / 1_000_000)} MB をダウンロードします。次からはダウンロードせずに使えます。</p>}
                    {error && <p role="alert">{error}</p>}
                    {instrument === 'failed' && <p role="alert">ピアノの再生を続けられないため、電子音で鳴らしています。アプリを開き直してください。</p>}
                    {!piano && <button type="button" onClick={() => void refresh().catch(reportError)}>音源の状態を確認</button>}
                    {piano && !piano.installed && <button type="button" disabled={starting || heavyBusy}
                        {...blockedBy(busyReason || (starting && 'ピアノ音源を用意しています。終わるまでお待ちください'))}
                        {...tip('ピアノの録音素材をダウンロードし、再生と鍵盤の試聴に使います')} onClick={() => void install()}>
                        ピアノ音源をダウンロード
                    </button>}
                </div>
            </details>
            <JobCard slot="piano-instrument" job={job} busyJob={busyJob}
                onCancel={() => void cancel().catch(reportError)} onShowBusy={showJob} />
        </div>
    );
}
