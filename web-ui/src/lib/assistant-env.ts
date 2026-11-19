/**
 * bunri DAW — アシスタントのツールが使う、画面の入口（本物）。
 *
 * ツール（lib/assistant-tools.ts）は、画面の状態に直接は触らず、ここで作る入口（`ToolEnv`）を通して読み書きする。
 * 入口は、利用者が押すボタンと同じ処理を呼ぶ（同じ処理を 2 か所に書かない）:
 *
 * - 再生・停止・小節への移動・テンポ・拍子・練習画面: ストア（`useDaw()`）と学ぶ流れ（`useLearnActions()`）
 * - トラックの追加・名前・削除・開く・ミュート・ソロ・音量・パン: タイムライン（`timelineRef`）
 * - ノートの差し替え: ピアノロール（`pianoRollRef` の `setTrackNotes`。開いていないトラックにも使える）
 * - MIDI 入力: 中央エリアが 1 つだけ持つ仕組み（`midiRef`）
 * - 練習画面の設定と「比べる」: ストア（`updatePractice`）と、練習画面が置く入口（`practiceCompareRef`）
 * - 再現ガイド・差分の説明: 差分の段と同じ組の決め方・材料の組み立て（lib/coach.ts）と、同じ API（lib/guide.ts・lib/coach.ts）
 * - 場所を示す: そのタブを開いて（`setLeftTab` / `openLearn` / `setSoundTab`）、部品を光らせる（lib/assistant-landmarks.ts）
 *
 * 変える入口は、どれも元に戻す履歴に載る（`record`）。アシスタントが動いているあいだは、依頼ごとの記録
 * （lib/assistant.ts が `beginEdit` で開く）の中なので、その 1 つの記録にまとまる。
 *
 * 繰り返しは、ドックを閉じても続く。入口は、描くたびに変わる値（カルテ、練習画面の状態）を、呼ばれたときに読む。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useDaw } from './store';
import { chartIdOfParts, progressFacts, referenceSourceOf, useLearnActions } from './learn';
import engine, { type PianoNote } from './engine';
import { attemptEntryOf, comparedOf, explainChartContext, requestDiff, requestExplanation, resolveCoachPair } from './coach';
import { fetchSavedGuide, requestGuide } from './guide';
import type { AssistantDeps } from './assistant';
import { LANDMARKS, flashElement } from './assistant-landmarks';
import { jobTracker, stageText } from './jobs';
import { exportMidiFile, exportMixWav } from './export-actions';
import { effectedClip } from './fx';
import { useProjectActions } from './project-actions';
import { ToolError, type ToolEnv } from './assistant-tools';

/** 依頼ごとの記録を元に戻した・やり直したときに、動きの記録に残す名前（依頼の文は入れない）。 */
export const ACTIVITY_LABEL = 'アシスタントの依頼';

/** ピアノロールがまだ無いときに使う、長さの上限（CenterArea の `maxSteps` と同じ。999 小節ぶん）。 */
const DEFAULT_MAX_STEPS = 16 * 999;

/**
 * アシスタントの繰り返しに渡す、画面の入口を作る。DAW の画面（`DawProvider` の中）で 1 回だけ呼ぶ。
 * 返すオブジェクトは、描き直しても同じもの。
 */
export function useAssistantDeps(): AssistantDeps {
    const daw = useDaw();
    const learn = useLearnActions();
    const project = useProjectActions();
    // 入口は 1 回だけ作り、呼ばれたときに、いちばん新しい値を読む
    const latest = useRef({ daw, learn, project });
    useEffect(() => { latest.current = { daw, learn, project }; });

    return useMemo((): AssistantDeps => {
        const now = () => latest.current;
        const part = <T,>(value: T | null | undefined, what: string): T => {
            if (!value) throw new ToolError(`${what}の準備ができていません。少し待ってから、もう一度試してください`);
            return value;
        };
        const timeline = () => part(now().daw.timelineRef.current, 'タイムライン');
        const pianoRoll = () => part(now().daw.pianoRollRef.current, 'ピアノロール');

        const env: ToolEnv = {
            grid: () => engine.grid,
            tracks: () => {
                // 開いているトラックのノートは、ピアノロールが手元に写して持っている。読む前に書き戻す
                now().daw.pianoRollRef.current?._saveToEngine?.();
                return engine.tracks;
            },
            activeTrackId: () => now().daw.pianoRollRef.current?.getActiveTrackId?.() ?? null,
            maxSteps: () => now().daw.pianoRollRef.current?.maxSteps ?? DEFAULT_MAX_STEPS,
            playing: () => engine.isPlaying,
            positionSec: () => engine.getCurrentTime(),
            durationSec: () => engine.getTotalDuration(),
            chart: () => now().daw.chart,
            practice: () => {
                const { practiceOpen, practice } = now().daw;
                return { open: practiceOpen, partId: practice?.partId ?? null, trackId: practice?.trackId ?? null };
            },
            play: (fromSec) => now().daw.play(fromSec),
            stop: () => now().daw.stop(),
            seekStep: (step) => now().daw.jumpTo({ step }),
            // テンポと拍子は、利用者が欄で変えたときは履歴に載らない。アシスタントが変えたぶんは、依頼ごと元に戻せるようにする
            setBpm: (bpm) => now().daw.record('テンポを変更', () => now().daw.setBpm(bpm)),
            setBeatsPerBar: (beats) => now().daw.record('拍子を変更', () => now().daw.setBeatsPerBar(beats)),
            addTrack: (name) => {
                const track = timeline().addTrack(name);
                return { id: track.id, name: track.name };
            },
            renameTrack: (id, name) => { timeline().renameTrack(id, name); },
            // 「元に戻す」付きの知らせは出さない (戻すのは、チャットの「元に戻す」。CenterArea の deleteTrack の説明)
            deleteTrack: (id) => { timeline().deleteTrack(id, { toast: false }); },
            selectTrack: (id) => { timeline().selectTrack(id); },
            setMute: (id, on) => { timeline().setMute(id, on); },
            setSolo: (id, on) => { timeline().setSolo(id, on); },
            setGain: (id, db) => { timeline().setGain(id, db); },
            setPan: (id, pan) => { timeline().setPan(id, pan); },
            setTrackNotes: (id, notes, label) => { pianoRoll().setTrackNotes(id, notes, label); },
            openPractice: (partId) => now().learn.practicePart(partId),
            closePractice: () => {
                now().daw.closePractice();
                now().daw.setStatus('アレンジに戻りました');
            },
            midi: () => now().daw.midiRef.current,
            practiceSettings: () => {
                const { practiceOpen, practice } = now().daw;
                if (!practiceOpen || !practice) return null;
                return { loop: { ...practice.loop }, speed: practice.speed, listen: practice.listen, showGhost: practice.showGhost };
            },
            updatePractice: (patch) => now().daw.updatePractice(patch),
            selection: () => {
                const pr = now().daw.pianoRollRef.current;
                const trackId: number | null = pr?.getActiveTrackId?.() ?? null;
                if (!pr || trackId === null || !pr.selection || pr.selection.size === 0) return null;
                // 手元のノートを書き戻してから数える (番号は、トラックの `pianoNotes` の番号と同じになる)
                pr._saveToEngine?.();
                const indices: number[] = [];
                (pr.notes as PianoNote[]).forEach((n, i) => { if (pr.selection.has(n)) indices.push(i); });
                return indices.length > 0 ? { trackId, indices } : null;
            },
            flashNotes: (trackId, indices) => {
                const pr = now().daw.pianoRollRef.current;
                if (!pr || pr.getActiveTrackId?.() !== trackId || indices.length === 0) return;
                pr.flashNotes({ own: indices });
                const first = (pr.notes as PianoNote[])[Math.min(...indices)];
                if (first) { pr.scrollToStep(first.step); pr.scrollToPitch?.(first.note, first.octave); }
            },
            metronome: () => engine.metronomeEnabled,
            setMetronome: (on) => {
                // ヘッダの 🔔 と同じ (エンジンの旗を変えて、画面の表示を合わせる)
                engine.init();
                engine.metronomeEnabled = on;
                now().daw.setMetronomeEnabled(on);
                now().daw.setStatus(on ? 'メトロノーム ON' : 'メトロノーム OFF');
                // 再生中に入れたときは、鳴らし直す (クリック音は、再生を始めるときに用意されるため)
                if (on) engine.restartIfPlaying();
            },
            chartId: () => now().daw.chartId,
            learn: () => {
                const { chart, songFile, coachResult } = now().daw;
                // 「差分で直す」は、打ち込みのあるトラックと比べたときに済む (components/ProgressSteps.tsx と同じ)
                return progressFacts(chart !== null, songFile !== null, coachResult !== null && coachResult.result.summary.attempt_count > 0);
            },
            referenceSource: (trackId) => referenceSourceOf(engine.getTrack(trackId)),
            requestDiff: (reference, attempt, perBar, source, mode) => requestDiff(reference, attempt, perBar, source, mode),
            practiceCompare: async () => (await now().daw.practiceCompareRef.current?.()) ?? null,
            savedGuide: (chartId, sectionId) => fetchSavedGuide(chartId, sectionId),
            requestGuide: (chartId, sectionId, regenerate, model) => requestGuide(chartId, sectionId, regenerate, model),
            coachPair: () => {
                // 差分の段と同じ決め方 (選んでいる組。無ければ、お手本を持つ最初のトラックと、その練習のトラック)
                const { reference, attempt } = resolveCoachPair(env.tracks(), now().daw.coachPair);
                return reference && attempt ? { referenceId: reference.id, attemptId: attempt.id } : null;
            },
            coachDiff: (referenceId, attemptId) => {
                const shown = now().daw.coachResult;
                if (!shown || shown.referenceId !== referenceId || shown.attemptId !== attemptId) return null;
                return comparedOf(shown.result) ? shown.result : null;
            },
            explainChart: (referenceId) => {
                const { chart, chartId, bpm, gridOffset } = now().daw;
                return chart ? explainChartContext(engine.getTrack(referenceId), { chartId, partsChartId: chartIdOfParts(), bpm, gridOffset }) : null;
            },
            requestExplanation: (request, regenerate, model) => requestExplanation(request, regenerate, model),
            linkExplanation: (diff, key) => {
                const entry = attemptEntryOf(diff);
                if (entry !== undefined) now().daw.setAttemptExplanation(entry, key);
            },
            pointAt: async (key) => {
                const landmark = LANDMARKS[key];
                if (!landmark) return { shown: false };
                const { daw } = now();
                if (landmark.open) {
                    if (landmark.open.leftTab === 'learn') daw.openLearn(landmark.open.learnTab);
                    else {
                        daw.setLeftTab(landmark.open.leftTab);
                        if (landmark.open.leftTab === 'sound') daw.setSoundTab(landmark.open.soundTab);
                    }
                }
                // タブを開いた後の描画を待つ。見えている部品 (大きさを持つもの) だけを示す
                const find = () => [...document.querySelectorAll(landmark.selector)]
                    .find((el) => el.getClientRects().length > 0) ?? null;
                const until = Date.now() + 600;
                let element = find();
                while (!element && Date.now() < until) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    element = find();
                }
                if (!element) return { shown: false };
                flashElement(element);
                return { shown: true };
            },
            job: () => {
                const job = jobTracker.getSnapshot().active;
                if (!job) return null;
                return {
                    id: job.id, title: job.title || '処理', filename: job.filename ?? null, state: job.state, stage: stageText(job),
                    progress: typeof job.progress === 'number' ? job.progress : null, elapsedSec: job.elapsed_sec ?? 0,
                    cancelRequested: job.cancel_requested === true,
                };
            },
            cancelJob: (id) => jobTracker.cancel(id),
            hasSongFile: () => now().daw.songFile !== null,
            // 「パートに分けて採譜する」と同じ処理。受け付けられたか (断られたか) が分かったところで返す。
            // 終わるのは数分後なので、待たない (終わると、パートのトラックができる)
            startSeparation: (sensitivity) => new Promise((resolve) => {
                void now().learn.separateParts(sensitivity, resolve).catch((e: unknown) => {
                    resolve({ started: false, reason: String((e as Error)?.message ?? e) });
                });
            }),
            exportWav: async () => {
                now().daw.pianoRollRef.current?._saveToEngine?.();
                const outcome = await exportMixWav();
                now().daw.setStatus(outcome.message, outcome.ok ? 'info' : 'error');
                return outcome;
            },
            exportMidi: () => {
                now().daw.pianoRollRef.current?._saveToEngine?.();
                const outcome = exportMidiFile();
                now().daw.setStatus(outcome.message, outcome.ok ? 'info' : 'error');
                return outcome;
            },
            project: () => ({ name: now().daw.project.name, dirty: now().daw.isDirty }),
            saveProject: () => now().project.save(false),
            moveClip: (trackId, clipIndex, offsetSec) => { timeline().moveClip(trackId, clipIndex, offsetSec); },
            // 「元に戻す」付きの知らせは出さない (deleteTrack と同じ)
            deleteClip: (trackId, clipIndex) => { timeline().deleteClip(trackId, clipIndex, { toast: false }); },
            duplicateClip: (trackId, clipIndex) => { timeline().duplicateClip(trackId, clipIndex); },
            // 端のドラッグ・メニュー・フェードの窓と同じ処理 (タイムラインが、元に戻す履歴に載せて行う)
            trimClip: (trackId, clipIndex, range) => { timeline().trimClip(trackId, clipIndex, range); },
            splitClip: (trackId, clipIndex, atSec) => { timeline().splitClipAt(trackId, clipIndex, atSec); },
            fadeClip: (trackId, clipIndex, fades) => { timeline().setClipFades(trackId, clipIndex, fades); },
            applyEffect: async (trackId, clipIndex, effect, params, label) => {
                const track = engine.getTrack(trackId);
                const clip = track?.clips[clipIndex];
                if (!track || !clip) throw new ToolError('そのクリップが見つかりません。get_project で確かめてください', 'そのクリップが見つかりません');
                // 左のパネルの「FX」と同じ処理 (lib/fx.ts)。かけたクリップに差し替える (元に戻すと、かける前に戻る)
                const next = await effectedClip(clip, effect, params);
                // かけているあいだに、クリップが動いたり消えたりしていたら、差し替えない
                if (engine.getTrack(trackId)?.clips[clipIndex] !== clip) throw new ToolError('かけているあいだにクリップが変わったので、差し替えませんでした。もう一度試してください');
                now().daw.record(`「${label}」を適用`, () => { track.clips[clipIndex] = { ...next, offset: clip.offset }; });
                now().daw.bumpTracks();
                now().daw.setStatus(`「${label}」を適用しました`);
            },
        };
        return {
            env,
            // 記録の名前には、依頼の頭の文字が入る。動きの記録には、利用者が打った文を残さない名前で載せる
            beginEdit: (label) => {
                const commit = now().daw.beginEdit(label, { activityLabel: ACTIVITY_LABEL });
                return (options) => commit(options?.discard ? { discard: true } : undefined);
            },
            topUndoId: () => now().daw.topUndoId(),
            // 読むだけ (ピアノロールの手元のノートを書き戻さない。ドックが描いている途中に呼ばれる)
            suggestionFacts: () => {
                const { daw } = now();
                const pr = daw.pianoRollRef.current;
                const facts = env.learn();
                return {
                    trackCount: engine.tracks.length,
                    imported: facts.imported, hasChart: facts.hasChart, separated: facts.separated, practiced: facts.practiced,
                    practiceOpen: daw.practiceOpen,
                    selectedNotes: pr?.selection?.size ?? 0,
                    openTrackHasNotes: (pr?.notes?.length ?? 0) > 0,
                    jobRunning: jobTracker.getSnapshot().active !== null,
                };
            },
        };
    }, []);
}
