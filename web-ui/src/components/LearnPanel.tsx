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
import engine, { MIDI_PART } from '../lib/engine';
import { isDrumPart, partTracks, practiceTrackOf, SONG_ACCEPT, useLearnActions } from '../lib/learn';
import SubTabs from './SubTabs';
import { tabPanelProps, type TabDef } from '../lib/tabs';
import ChartPanel from './ChartPanel';
import JobCard from './JobCard';
import { useJob } from '../lib/useJob';
import { useShowJob } from '../lib/job-focus';
import { jobErrorMessage, type Job } from '../lib/jobs';
import { tip } from '../lib/tooltip';
import GuidePanel from './GuidePanel';
import CoachPanel from './CoachPanel';

const LEARN_TABS: TabDef<LearnTab>[] = [
    { key: 'song', label: '曲とパート', tip: '曲を取り込み、パートに分けます' },
    { key: 'chart', label: 'カルテ', tip: '曲のキー・コード進行・構成・音の作りを見ます' },
    { key: 'guide', label: 'ガイド', tip: 'カルテをもとに、似せて作るための手順を書き出します' },
    { key: 'coach', label: '差分', tip: '打ち込みをお手本と比べて、違うところを見つけます' },
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
    const songJob = useJob('learn-song', attachedEnd('カルテの作成', (job) => { finishChart(job.result); }));
    const partsJob = useJob('learn-parts', attachedEnd('パート分離', (job) => void applyParts(job.result)));
    // 重い処理は同時に 1 つ。どこかで動いている間は、始めるボタンを押せなくする
    const blocked = showProgress || songJob.heavyBusy;
    const [sensitivity, setSensitivity] = useState(0.5);
    // 「お手本をノートとして取り込む」を確かめているパート (トラック ID)
    const [confirming, setConfirming] = useState<number | null>(null);
    void trackVersion;
    const parts = partTracks();
    // 原曲から分けたパートと、MIDI ファイルから読み込んだお手本。「分け直す」で入れ替わるのは前者だけ
    const separated = parts.filter(p => p.part !== MIDI_PART);
    const fromMidi = parts.length - separated.length;
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
            <button className="action-btn" id="btn-import-song" onClick={openSongPicker} disabled={blocked}
                {...tip(songFile
                    ? '別の曲のファイルを選んで、取り込み直します'
                    : '教材にする曲のファイル（MP3・WAV など）を選びます。取り込むと、カルテを自動で作ります')}>
                {songFile ? '別の曲を取り込む' : '曲を取り込む'}
            </button>
            <label htmlFor="file-auto-bpm" style={{ marginTop: 8 }}>
                <input id="file-auto-bpm" type="checkbox" checked={autoBpm}
                    onChange={e => setAutoBpm(e.target.checked)} style={{ marginRight: 4 }}
                    {...tip('取り込んだ曲の速さを調べて、BPM に入れます。外すと、いまの BPM のままです')} />
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
                    value={sensitivity} onChange={e => setSensitivity(+e.target.value)}
                    {...tip('上げると小さな音まで拾ってお手本にします。余分なノートが多いときは下げてください')} />
                <button className="action-btn" onClick={() => void separateParts(sensitivity)} disabled={blocked || !songFile}
                    {...tip(!songFile
                        ? '先に曲を取り込んでください'
                        : separated.length > 0
                            ? (fromMidi > 0
                                ? 'もう一度パートに分けます。いまのパートと練習のトラックは、新しいものに入れ替わります。MIDI ファイルから読み込んだお手本は残ります'
                                : 'もう一度パートに分けます。いまのパートと練習のトラックは、新しいものに入れ替わります')
                            : '原曲をボーカル・ドラム・ベースなどに分けて、パートごとにお手本を作ります')}>
                    {separated.length > 0 ? 'パートに分け直す（数分かかります）' : 'パートに分けて採譜する（数分かかります）'}
                </button>
                <JobCard slot="learn-parts" job={partsJob.job} busyJob={partsJob.busyJob} onCancel={() => void partsJob.cancel()}
                    onShowBusy={showJob} hint="待っている間も、カルテやガイドは読めます（「カルテ」「ガイド」の段）。" />
                {!songFile && <p className="note-text" style={{ marginTop: 4 }}>先に曲を取り込んでください。</p>}
                {songFile && separated.length > 0 && (
                    <p className="note-text" style={{ marginTop: 4 }}>分け直すと、いまのパートと練習のトラック（打ち込んだノートも）は、新しいものに入れ替わります。{fromMidi > 0 && 'MIDI ファイルから読み込んだお手本と、その練習のトラックは残ります。'}</p>
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
                                                {...tip('お手本を薄く重ねたピアノロールを開きます。お手本を見ながら、自分でノートを置いていきます')}
                                                onClick={() => practicePart(part.id)}>
                                                このパートを練習する
                                            </button>
                                            {confirming === part.id ? (
                                                <div className="inline-confirm" role="group" aria-label="お手本をノートとして取り込むか確かめる">
                                                    <p className="note-text">
                                                        お手本のノートを「{part.name}」の打ち込みに写します。写すと、差分チェックは 100% から始まります。
                                                    </p>
                                                    <button type="button" className="link-btn" onClick={() => { adoptReference(part.id); setConfirming(null); }}
                                                        {...tip('お手本を打ち込みに写します。元に戻すで戻せます')}>写す</button>
                                                    <button type="button" className="link-btn" onClick={() => setConfirming(null)}
                                                        {...tip('写さずに閉じます')}>やめる</button>
                                                </div>
                                            ) : (
                                                <button type="button" className="link-btn" onClick={() => setConfirming(part.id)}
                                                    {...tip('お手本のノートを、そのまま自分の打ち込みに写します。写したものを手で直していくときに使います')}
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
