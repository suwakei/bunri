/**
 * bunri DAW — 左パネルの「学ぶ」タブ。
 *
 * 学ぶ流れ（曲を取り込む → カルテを見る → パートに分ける → 打ち込む → 差分で直す）を、
 * 4 つの段に分けて置く。1 本の長い縦の並びにすると、差分の一覧にたどり着くまで毎回カルテと
 * ガイドを通り過ぎることになるため。
 *
 * - 曲とパート: 曲を取り込む、パートに分ける、パートごとの「このパートを練習する」
 * - カルテ: 楽曲カルテ（第1層）
 * - ガイド: 再現ガイド（第2層）
 * - 差分: 差分チェック（第3層の土台）
 *
 * 画面の文は docs/ui-terms.md の決まりに合わせる。
 */
import { useState } from 'react';
import { useDaw, type LearnTab } from '../lib/store';
import engine from '../lib/engine';
import { isDrumPart, partTracks, practiceTrackOf, SONG_ACCEPT, useLearnActions } from '../lib/learn';
import SubTabs from './SubTabs';
import { tabPanelProps, type TabDef } from '../lib/tabs';
import ChartPanel from './ChartPanel';
import JobCard from './JobCard';
import { useJob } from '../lib/useJob';
import { useShowJob } from '../lib/job-focus';
import { jobErrorMessage, type Job } from '../lib/jobs';
import type { ChartResponse } from '../lib/chart';
import type { DecomposeResult } from '../lib/learn';
import GuidePanel from './GuidePanel';
import CoachPanel from './CoachPanel';

const LEARN_TABS: TabDef<LearnTab>[] = [
    { key: 'song', label: '曲とパート' },
    { key: 'chart', label: 'カルテ' },
    { key: 'guide', label: 'ガイド' },
    { key: 'coach', label: '差分' },
];

/**
 * 原曲のファイルを選ぶ欄。画面に 1 つだけ置き、「曲を取り込んで始める」（中央の空の状態）と
 * 「曲を取り込む」（このタブ）の両方から開く。選ぶと、すぐに取り込みが始まる。
 */
export function SongPicker() {
    const { songPickerRef, autoBpm } = useDaw();
    const { importSong } = useLearnActions();
    return (
        <input type="file" id="song-file" className="visually-hidden" aria-label="原曲のファイル" tabIndex={-1}
            accept={SONG_ACCEPT} ref={songPickerRef}
            onChange={(e) => {
                const file = e.target.files?.[0];
                // 同じファイルをもう一度選んでも取り込めるよう、欄は空に戻す
                e.target.value = '';
                if (file) void importSong(file, { autoBpm });
            }} />
    );
}

/**
 * 「曲とパート」の段。曲を取り込み、パートに分け、練習するパートを選ぶ。
 */
function SongPanel() {
    const { songFile, openSongPicker, showProgress, autoBpm, setAutoBpm, trackVersion, chart, setStatus } = useDaw();
    const { separateParts, practicePart, adoptReference, finishChart, applyParts } = useLearnActions();
    const showJob = useShowJob();
    /** 画面を開き直す前に始めた処理（つなぎ直したもの）が終わったとき。結果をこの画面に当てる。 */
    const attachedEnd = (name: string, apply: (job: Job) => void) => (job: Job) => {
        if (job.state === 'done') apply(job);
        else if (job.state === 'cancelled') setStatus(`${name}を中止しました`);
        else setStatus(jobErrorMessage(job), 'error');
    };
    const songJob = useJob('learn-song', attachedEnd('カルテの作成', (job) => finishChart(job.result as ChartResponse)));
    const partsJob = useJob('learn-parts', attachedEnd('パート分離', (job) => void applyParts(job.result as DecomposeResult)));
    // 重い処理は同時に 1 つ。どこかで動いている間は、始めるボタンを押せなくする
    const blocked = showProgress || songJob.heavyBusy;
    const [sensitivity, setSensitivity] = useState(0.5);
    // 「お手本をノートとして取り込む」を確かめているパート (トラック ID)
    const [confirming, setConfirming] = useState<number | null>(null);
    void trackVersion;
    const parts = partTracks();
    const songTrack = engine.tracks.find(t => t.role === 'song');

    return (
        <div id="song-panel" className="panel-content">
            <h3>曲を取り込む</h3>
            <p className="panel-desc">
                曲のファイルを取り込むと、音声を「原曲」のトラックに置き、キー・コード進行・構成・ミックスを調べて
                <strong>カルテ</strong>を作ります（数秒〜十数秒）。
            </p>
            {(songFile || songTrack) && (
                <p className="body-text" id="song-current">
                    取り込んだ曲: <strong>{songFile?.name ?? songTrack?.clips[0]?.name ?? SONG_TRACK_LABEL}</strong>
                    {chart ? '（カルテあり）' : ''}
                </p>
            )}
            <button className="action-btn" id="btn-import-song" onClick={openSongPicker} disabled={blocked}>
                {songFile ? '別の曲を取り込む' : '曲を取り込む'}
            </button>
            <label htmlFor="file-auto-bpm" style={{ marginTop: 8 }}>
                <input id="file-auto-bpm" type="checkbox" checked={autoBpm}
                    onChange={e => setAutoBpm(e.target.checked)} style={{ marginRight: 4 }} />
                BPM を自動で検出する
            </label>
            <JobCard slot="learn-song" job={songJob.job} busyJob={songJob.busyJob} onCancel={() => void songJob.cancel()}
                onShowBusy={showJob} hint="待っている間も、原曲のトラックは再生できます。" />

            <div className="panel-section" id="learn-parts">
                <h3>パートに分ける</h3>
                <p className="panel-desc">
                    原曲をパート（ボーカル・ドラム・ベースなど）に分け、パートごとにノートを採譜して
                    <strong style={{ color: 'var(--ghost)' }}>お手本</strong>を作ります。お手本はピアノロールに水色で重なり、
                    自分の打ち込みは空のまま始まります。
                </p>
                <label htmlFor="file-transcribe-sensitivity">採譜の感度（{sensitivity}）</label>
                <input id="file-transcribe-sensitivity" type="range" min="0.1" max="1" step="0.05"
                    value={sensitivity} onChange={e => setSensitivity(+e.target.value)} />
                <button className="action-btn" onClick={() => void separateParts(sensitivity)} disabled={blocked || !songFile}>
                    {parts.length > 0 ? 'パートに分け直す（数分かかります）' : 'パートに分けて採譜する（数分かかります）'}
                </button>
                <JobCard slot="learn-parts" job={partsJob.job} busyJob={partsJob.busyJob} onCancel={() => void partsJob.cancel()}
                    onShowBusy={showJob} hint="待っている間も、カルテやガイドは読めます（「カルテ」「ガイド」の段）。" />
                {!songFile && <p className="note-text" style={{ marginTop: 4 }}>先に曲を取り込んでください。</p>}
                {songFile && parts.length > 0 && (
                    <p className="note-text" style={{ marginTop: 4 }}>分け直すと、いまのパートと練習のトラック（打ち込んだノートも）は、新しいものに入れ替わります。</p>
                )}

                {parts.length > 0 && (
                    <ul id="part-list" aria-label="パートの一覧">
                        {parts.map(part => {
                            const refCount = part.referenceNotes?.length ?? 0;
                            const practice = practiceTrackOf(part.id);
                            const drum = isDrumPart(part.part);
                            return (
                                <li key={part.id} className="part-item" data-part={part.part}>
                                    <div className="part-head">
                                        <strong>{part.name}</strong>
                                        <span className="note-text">
                                            {drum ? 'ドラム（差分チェックの対象外）'
                                                : refCount > 0 ? `お手本 ${refCount} ノート${practice ? ` / 打ち込み ${practice.pianoNotes.length} ノート` : ''}`
                                                    : '採譜できたノートがありません'}
                                        </span>
                                    </div>
                                    {refCount > 0 && (
                                        <div className="part-actions">
                                            <button type="button" className="action-btn primary" disabled={showProgress || partsJob.job !== null}
                                                aria-label={`「${part.name}」を練習する`}
                                                onClick={() => practicePart(part.id)}>
                                                このパートを練習する
                                            </button>
                                            {confirming === part.id ? (
                                                <div className="inline-confirm" role="group" aria-label="お手本をノートとして取り込むか確かめる">
                                                    <p className="note-text">
                                                        お手本のノートを「{part.name}」の打ち込みに写します。写すと、差分チェックは 100% から始まります。
                                                    </p>
                                                    <button type="button" className="link-btn" onClick={() => { adoptReference(part.id); setConfirming(null); }}>写す</button>
                                                    <button type="button" className="link-btn" onClick={() => setConfirming(null)}>やめる</button>
                                                </div>
                                            ) : (
                                                <button type="button" className="link-btn" onClick={() => setConfirming(part.id)}
                                                    aria-label={`「${part.name}」のお手本をノートとして取り込む`}>
                                                    お手本をノートとして取り込む
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}

/** 原曲のファイル名が分からないときの呼び名。 */
const SONG_TRACK_LABEL = '原曲';

/**
 * 「学ぶ」タブの中身。4 つの段を切り替える。
 */
export default function LearnPanel() {
    const { learnTab, setLearnTab } = useDaw();
    return (
        <div id="learn-panel">
            <SubTabs idPrefix="learn" label="学ぶの段" tabs={LEARN_TABS} active={learnTab} onSelect={setLearnTab}
                className="sub-tabs" id="learn-tabs" />
            <div {...tabPanelProps('learn', 'song', learnTab, 'sub-panel')}><SongPanel /></div>
            <div {...tabPanelProps('learn', 'chart', learnTab, 'sub-panel')}><ChartPanel /></div>
            <div {...tabPanelProps('learn', 'guide', learnTab, 'sub-panel')}><GuidePanel /></div>
            <div {...tabPanelProps('learn', 'coach', learnTab, 'sub-panel')}><CoachPanel /></div>
        </div>
    );
}
