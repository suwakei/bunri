/**
 * bunri DAW — 練習画面（「入力 → 比べる → 直す」を 1 つの画面で回す）。
 *
 * 「このパートを練習する」か、練習のトラックの見出し・メニューの「練習画面」で開く。開いているあいだは、
 * タイムライン・左パネル・進み具合の段を隠し、ピアノロールを大きく出す（ピアノロールは同じ部品のまま。
 * 隠すのは CSS で、外さない。再生エンジンとピアノロールの状態を作り直さないため）。
 *
 * ```
 * ← アレンジに戻る   練習: ベース（song.mp3）                         一致 72%
 * 構成 │ Aメロ │ サビ                                          │ この区間の指摘
 * コード│ Am │ F │ C │ G                                         │ ▸ 5 小節 1 拍目: E2 が抜けています
 * 小節 │ 5 │ 6 │ 7 │ 8                                          │ 凡例
 * [ピアノロール: お手本 + 自分のノート + 差分の色]                  │ [ガイドを読む]
 * ▶ ■  区間ループ [5〜8 小節]  速度 [75%]  聴く ◉パート ○自分 ○両方
 * お手本 [見せる|隠す]  入力 [マウス|MIDI ステップ|MIDI リアルタイム]  [比べる]
 * ```
 *
 * 練習画面だけの設定（区間ループ・速度・聴く・お手本）は、トラックを書き換えない。
 * 聴くは再生エンジンの一時的な上書き（`listenOverride`）で、トラックのミュート・ソロは変えない。
 * どれも元に戻す履歴に残らず、アレンジに戻ると元の状態に戻る。設定そのものはプロジェクトの保存に入る
 * （状態の節 `practice`。lib/practice-project.ts。開き直したときは、練習画面は開かずに設定だけ戻す）。
 *
 * 「比べる」たびに、学習の記録（lib/learn-history.ts）に 1 件足す（比べた区間つき）。見出しの「前回より +8%」は、
 * 同じお手本・同じ練習のトラック・同じ区間の 1 つ前の記録との差。
 *
 * 画面の部品は 4 つ（見出し・段・右の一覧・下の操作）に分かれ、中央エリアの中の別々の場所に置く。
 * 状態は `PracticeProvider` が持ち、部品はそこから読む。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useDaw } from '../lib/store';
import { tip } from '../lib/tooltip';
import engine, { type PianoNote, type Track } from '../lib/engine';
import { describeError } from '../lib/api';
import { KIND_LABEL, hasVelocityDiff, issueText, requestDiff, velocityNotesOf, type DiffIssue, type DiffResult, type VelocityFinding } from '../lib/coach';
import { SECTION_LABEL_JA } from '../lib/chart';
import { secToStep, stepsPerBar } from '../lib/grid';
import { isDialogOpen, isTypingTarget, modKeyLabel } from '../lib/keys';
import { sameNotes } from '../lib/project-snapshot';
import { clearStretchCache, peekStretched, prepareStretched } from '../lib/practice-audio';
import {
    MARK_LABEL, SPEEDS, issuesInOrder, listenTrackIds, loopSeconds, loopSteps, markNotes, matchRate, noteMarkLabel,
    notesInRange, notesOfIssue, shiftLoop, secondsToLoop, speedLabel,
    type InputMode, type ListenMode, type NoteMark, type PracticeLoop, type StepRange,
} from '../lib/practice';
import { PART_LABELS, referenceSourceOf } from '../lib/learn';
import { attemptFromDiff, barRangeOf, deltaText, useMatchSummary } from '../lib/learn-history';
import { RealtimeSettings, StepLengthSelect } from './MidiInputBar';
import VelocityFindings from './VelocityFindings';
import { midiUnavailableText, type MidiInputController } from '../lib/useMidiInput';
import { cursorLabel } from '../lib/midi-input';

/** 最後に比べた結果（練習画面の中だけ。保存しない。記録は学習の記録に残る）。 */
interface CompareState {
    result: DiffResult;
    /** 比べた範囲（区間ループ。無ければ全体） */
    range: StepRange | null;
    /** 比べた範囲の小節（学習の記録の範囲。区間ループが無ければ、お手本のノートの最初から最後まで） */
    bars: BarRange;
    /** 比べたときの打ち込み（中身が変わったら「もう一度比べて」） */
    attempt: PianoNote[];
    reference: PianoNote[];
    marks: { own: (NoteMark | null)[]; ghost: (NoteMark | null)[] };
}

/** 小節の範囲（1 始まり、どちらも含む）。 */
type BarRange = { startBar: number; endBar: number };

/** 速度の用意の状態。 */
type SpeedStatus =
    | { kind: 'normal' }
    | { kind: 'preparing' }
    | { kind: 'ready'; seconds: number | null; ms: number | null }
    | { kind: 'needs-loop' }
    | { kind: 'error'; message: string };

interface PracticeContextValue {
    midi: MidiInputController;
    part: Track | undefined;
    track: Track | undefined;
    compare: CompareState | null;
    /** 比べた後にノートか区間を変えたか */
    stale: 'notes' | 'range' | null;
    busy: boolean;
    error: string;
    runCompare: () => Promise<void>;
    /** 選んでいる指摘（一覧の指摘か、押したノートの指摘） */
    selectedIssue: DiffIssue | null;
    /** 押したノートの説明（一覧に無い「合っている」ノートも） */
    pressedNote: string | null;
    selectIssue: (issue: DiffIssue) => void;
    /** 選んでいる強さの違いのまとまり（MIDI ファイルから読み込んだお手本のときだけ在る） */
    selectedFinding: VelocityFinding | null;
    selectFinding: (finding: VelocityFinding) => void;
    speedStatus: SpeedStatus;
    playing: boolean;
    togglePlay: () => void;
    stopPlay: () => void;
    setLoop: (loop: PracticeLoop) => void;
}

const PracticeContext = createContext<PracticeContextValue | null>(null);

function usePractice(): PracticeContextValue {
    const ctx = useContext(PracticeContext);
    if (!ctx) throw new Error('usePractice must be used within PracticeProvider');
    return ctx;
}

/** ふだんの画面（アレンジ）の見え方の控え。練習画面から戻るときに戻す。 */
interface ArrangeView {
    activeTrackId: number | null;
    pianoLeft: number;
    pianoTop: number;
    stepWidth: number;
    noteHeight: number;
    timelineLeft: number;
    timelineTop: number;
    ghostChoice: ReturnType<typeof useDaw>['ghostChoice'];
    midiMode: MidiInputController['mode'];
}

/** 構成の区間の名前（確定した名前、無ければ提案に「？」、それも無ければ記号）。 */
function sectionName(section: { label: string | null; suggested_label: string | null; repeat_group: string }): string {
    if (section.label) return section.label;
    if (section.suggested_label) return `${SECTION_LABEL_JA[section.suggested_label] ?? section.suggested_label}？`;
    return section.repeat_group;
}

/**
 * 練習画面の状態と、再生エンジン・ピアノロールとのつなぎを持つ。中央エリア全体を囲む。
 * 練習画面を閉じているあいだは何もしない（ふだんの画面の見え方を控えておくだけ）。
 */
export function PracticeProvider({ midi, children }: { midi: MidiInputController; children: ReactNode }) {
    const {
        practice, practiceOpen, updatePractice, closePractice, pianoRollRef, timelineRef, setStatus, isPlaying, setIsPlaying,
        bumpTracks, trackVersion, ghostChoice, setGhostChoice, bpm, beatsPerBar, gridOffset, setCoachResult, recordLearnAttempt,
    } = useDaw();
    const [compare, setCompare] = useState<CompareState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [selectedIssue, setSelectedIssue] = useState<DiffIssue | null>(null);
    const [pressedNote, setPressedNote] = useState<string | null>(null);
    const [selectedFinding, setSelectedFinding] = useState<VelocityFinding | null>(null);
    const [speedStatus, setSpeedStatus] = useState<SpeedStatus>({ kind: 'normal' });
    // ノートを変えたら描き直す (「もう一度比べて」を出す)
    const [notesVersion, setNotesVersion] = useState(0);
    const arrangeRef = useRef<ArrangeView | null>(null);
    const lastScrollRef = useRef({ pianoLeft: 0, pianoTop: 0, timelineLeft: 0, timelineTop: 0 });
    const openRef = useRef(practiceOpen);
    openRef.current = practiceOpen;
    void trackVersion;

    const part = practice ? engine.getTrack(practice.partId) : undefined;
    const track = practice ? engine.getTrack(practice.trackId) : undefined;
    const grid = useMemo(() => ({ bpm, beatsPerBar, offsetSec: gridOffset }), [bpm, beatsPerBar, gridOffset]);
    const loop = practice?.loop;
    const loopKey = loop ? `${loop.enabled ? 1 : 0}:${loop.startBar}:${loop.endBar}` : '';

    // ふだんの画面のスクロール位置を、見るたびに控えておく。練習画面に入った後 (タイムラインを隠した後) では読めないため
    useEffect(() => {
        const pr = pianoRollRef.current, tl = timelineRef.current;
        const onScroll = () => {
            if (openRef.current) return;
            lastScrollRef.current = {
                pianoLeft: pr?.wrap?.scrollLeft ?? 0, pianoTop: pr?.wrap?.scrollTop ?? 0,
                timelineLeft: tl?.scroller?.scrollLeft ?? 0, timelineTop: tl?.scroller?.scrollTop ?? 0,
            };
        };
        onScroll();
        pr?.wrap?.addEventListener('scroll', onScroll, { passive: true });
        tl?.scroller?.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            pr?.wrap?.removeEventListener('scroll', onScroll);
            tl?.scroller?.removeEventListener('scroll', onScroll);
        };
    }, [pianoRollRef, timelineRef]);

    // ---- 入る・戻る ----
    useEffect(() => {
        if (!practiceOpen || !practice) return;
        const pr = pianoRollRef.current, tl = timelineRef.current;
        const zoom = pr?.zoomState?.() ?? { stepWidth: 20, noteHeight: 14 };
        arrangeRef.current = {
            activeTrackId: pr?.getActiveTrackId?.() ?? null,
            ...lastScrollRef.current,
            stepWidth: zoom.stepWidth, noteHeight: zoom.noteHeight,
            ghostChoice, midiMode: midi.mode,
        };
        if (pr && pr.getActiveTrackId() !== practice.trackId) {
            pr.switchToTrack(practice.trackId);
            bumpTracks();
        }
        if (pr) {
            pr.onNotePressed = (index: number, mark: NoteMark | null) => {
                const note = pr.notes?.[index];
                if (!note) return;
                setPressedNote(mark ? noteMarkLabel(note, mark) : null);
                setSelectedIssue(mark?.issues[0] ?? null);
            };
        }
        const offNotes = pr?.onNotesEdited?.(() => setNotesVersion((v) => v + 1));
        // 区間の頭から聴けるように
        if (!engine.isPlaying && practice.loop.enabled) engine.playOffset = loopSeconds(practice.loop, engine.grid).start;
        return () => {
            offNotes?.();
            const saved = arrangeRef.current;
            arrangeRef.current = null;
            if (pr) {
                pr.onNotePressed = null;
                pr.setDiffMarks(null);
                pr.setLoopRange(null);
            }
            // 練習画面だけの設定を外す (プロジェクトのミュート・ソロに従う再生に戻す)
            engine.setListenOverride(null);
            engine.setLoopRange(null);
            engine.setTempo(1, null);
            clearStretchCache();
            midi.setPracticeHooks(null);
            setCompare(null);
            setSelectedIssue(null);
            setPressedNote(null);
            setSpeedStatus({ kind: 'normal' });
            if (!saved) return;
            setGhostChoice(saved.ghostChoice);
            if (midi.connected) midi.setMode(saved.midiMode);
            if (pr && saved.activeTrackId !== pr.getActiveTrackId() && (saved.activeTrackId === null || engine.getTrack(saved.activeTrackId))) {
                pr.switchToTrack(saved.activeTrackId);
            }
            // タイムラインを出し直した後 (CSS が戻った後) に、大きさとスクロールの位置を戻す
            requestAnimationFrame(() => {
                pr?.setZoom?.(saved.stepWidth, saved.noteHeight);
                if (pr?.wrap) { pr.wrap.scrollLeft = saved.pianoLeft; pr.wrap.scrollTop = saved.pianoTop; }
                const scroller = tl?.scroller;
                if (scroller) { scroller.scrollLeft = saved.timelineLeft; scroller.scrollTop = saved.timelineTop; }
            });
            bumpTracks();
        };
        // 入る・戻るときだけ走らせる (中の値は入ったときのものを控える)
    }, [practiceOpen, practice?.partId, practice?.trackId]); // eslint-disable-line react-hooks/exhaustive-deps

    // パートか練習のトラックが無くなったら (元に戻したときなど)、練習画面を閉じる
    useEffect(() => {
        if (practiceOpen && practice && (!part || !track)) {
            closePractice();
            setStatus('練習のトラックが無くなったので、練習画面を閉じました');
        }
    }, [practiceOpen, practice, part, track, closePractice, setStatus]);

    // ---- 聴く (一時的な上書き。プロジェクトのミュート・ソロは変えない) ----
    useEffect(() => {
        if (!practiceOpen || !practice) return;
        engine.setListenOverride(listenTrackIds(practice));
    }, [practiceOpen, practice?.listen, practice?.partId, practice?.trackId]); // eslint-disable-line react-hooks/exhaustive-deps
    // 元に戻すと音量のつなぎが書き戻されるので、上書きを当て直す
    useEffect(() => {
        if (practiceOpen) for (const t of engine.tracks) engine.applyTrackGain(t);
    }, [practiceOpen, trackVersion]);

    // ---- お手本を見せる・隠す ----
    useEffect(() => {
        if (!practiceOpen || !practice) return;
        setGhostChoice(practice.showGhost ? 'auto' : 'off');
    }, [practiceOpen, practice?.showGhost, setGhostChoice]); // eslint-disable-line react-hooks/exhaustive-deps

    // ---- 区間ループ ----
    useEffect(() => {
        const pr = pianoRollRef.current, tl = timelineRef.current;
        if (!practice) { tl?.setLoopRange?.(null); return; }
        const seconds = loopSeconds(practice.loop, grid);
        // タイムラインには、練習画面を閉じた後も区間を描く (どこを練習していたかが分かるように)
        tl?.setLoopRange?.(seconds);
        if (!practiceOpen) return;
        engine.setLoopRange(practice.loop.enabled ? seconds : null);
        pr?.setLoopRange?.(practice.loop.enabled ? loopSteps(practice.loop, grid) : null);
    }, [practiceOpen, loopKey, grid, practice, pianoRollRef, timelineRef]);

    // ---- 速度 ----
    useEffect(() => {
        if (!practiceOpen || !practice) return;
        const rate = practice.speed;
        if (rate === 1) { engine.setTempo(1, null); setSpeedStatus({ kind: 'normal' }); return; }
        if (!practice.loop.enabled) { engine.setTempo(1, null); setSpeedStatus({ kind: 'needs-loop' }); return; }
        const partTrack = engine.getTrack(practice.partId);
        // パートの音声を鳴らさないなら (聴く = 自分)、伸ばす音声は要らない。ノートの間隔だけを伸ばす
        if (!partTrack || practice.listen === 'self' || partTrack.clips.length === 0) {
            engine.setTempo(rate, null);
            setSpeedStatus({ kind: 'ready', seconds: null, ms: null });
            return;
        }
        const { start, end } = loopSeconds(practice.loop, grid);
        const request = { trackId: partTrack.id, clips: partTrack.clips.slice(), start, end, rate };
        const cached = peekStretched(request);
        if (cached) {
            engine.setTempo(rate, cached);
            setSpeedStatus({ kind: 'ready', seconds: cached.buffer.duration, ms: 0 });
            return;
        }
        // 用意できるまでは 100% で鳴らす (高さを変えて遅くすることはしない)
        engine.setTempo(1, null);
        setSpeedStatus({ kind: 'preparing' });
        engine.init();
        let cancelled = false;
        let ms: number | null = null;
        prepareStretched(engine.ctx!, request, (info) => { ms = info.ms; })
            .then((audio) => {
                if (cancelled) return;
                engine.setTempo(rate, audio);
                setSpeedStatus({ kind: 'ready', seconds: audio?.buffer.duration ?? null, ms });
            })
            .catch((e) => {
                if (cancelled) return;
                engine.setTempo(1, null);
                setSpeedStatus({ kind: 'error', message: describeError(e) });
            });
        return () => { cancelled = true; };
    }, [practiceOpen, practice?.speed, practice?.listen, loopKey, grid]); // eslint-disable-line react-hooks/exhaustive-deps

    // ---- 入力 (MIDI は中央エリアの 1 つを使う) ----
    useEffect(() => {
        if (!practiceOpen || !practice) return;
        midi.setPracticeHooks({
            bounds: () => (practice.loop.enabled ? loopSteps(practice.loop, engine.grid) : null),
            addNote: (note, mode) => {
                if (mode !== 'realtime') return false;
                const pr = pianoRollRef.current;
                if (!pr) return false;
                // 重ねて録る。同じ高さ・同じ位置のノートは重ねない (同じ所を何度弾いても、余分なノートが増えない)
                if ((pr.notes as PianoNote[]).some((n) => n.note === note.note && n.octave === note.octave && n.step === note.step)) return true;
                // 1 周ごとに記録を分ける (元に戻すと、最後の 1 周ぶんが消える)
                const pass = engine.getLoopPass() ?? 0;
                pr._addNote(note.note, note.octave, note.step, note.length, {
                    label: `MIDI 入力の録音（${pass + 1} 周目）`, coalesceKey: `practice-take:${engine.startTime}:${pass}`, coalesceMs: 600_000,
                    velocity: note.velocity,
                });
                return true;
            },
        });
    }, [practiceOpen, practice, midi, pianoRollRef]);

    useEffect(() => {
        if (!practiceOpen || !practice) return;
        const want = practice.input;
        if (want === 'mouse') { if (midi.connected) midi.setMode('off'); return; }
        let cancelled = false;
        void (async () => {
            const ok = midi.connected || await midi.connect();
            if (cancelled) return;
            // つながらなければマウスに戻す (画面が自分で直したので、保存していない変更の印は付けない)
            if (!ok) { updatePractice({ input: 'mouse' }, { touch: false }); return; }
            midi.setMode(want === 'midi-step' ? 'step' : 'realtime');
            if (want === 'midi-step' && practice.loop.enabled) midi.setCursor(loopSteps(practice.loop, engine.grid).start);
        })();
        return () => { cancelled = true; };
    }, [practiceOpen, practice?.input]); // eslint-disable-line react-hooks/exhaustive-deps

    // ---- 比べる ----
    const stale: 'notes' | 'range' | null = useMemo(() => {
        void notesVersion; void trackVersion;
        if (!compare || !track) return null;
        if (!sameNotes(track.pianoNotes, compare.attempt)) return 'notes';
        const range = practice?.loop.enabled ? loopSteps(practice.loop, grid) : null;
        const same = (range === null && compare.range === null)
            || (range !== null && compare.range !== null && range.start === compare.range.start && range.end === compare.range.end);
        return same ? null : 'range';
    }, [compare, track, practice, grid, notesVersion, trackVersion]);

    // 古くなった色は消す (ノートを変えたときはピアノロールが自分で消す。区間を変えたときはここで)
    useEffect(() => {
        if (stale) pianoRollRef.current?.setDiffMarks?.(null);
    }, [stale, pianoRollRef]);

    const runCompare = useCallback(async () => {
        const pr = pianoRollRef.current;
        if (!practice || !part || !track) return;
        pr?._saveToEngine?.();
        const range = practice.loop.enabled ? loopSteps(practice.loop, engine.grid) : null;
        const reference = part.referenceNotes ?? [];
        const attempt = track.pianoNotes ?? [];
        const refIn = notesInRange(reference, range);
        if (refIn.length === 0) {
            setError(range ? 'この区間にはお手本のノートがありません。区間を変えてから比べてください' : 'お手本のノートがありません');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const per = stepsPerBar(engine.grid);
            // 強さを比べるのは、MIDI ファイルから読み込んだお手本のときだけ (採譜したお手本の強さは当てにならない)
            const source = referenceSourceOf(part);
            const result = await requestDiff(refIn, notesInRange(attempt, range), per, source);
            const marks = markNotes(result, attempt, reference, range);
            const bars = range ? { startBar: practice.loop.startBar, endBar: practice.loop.endBar } : barRangeOf(reference, per);
            setCompare({ result, range, bars, attempt, reference, marks });
            // 学習の記録に 1 件足す。一致率は、範囲の中のお手本のうち合っていたノートの割合 (差分の accuracy)
            recordLearnAttempt(attemptFromDiff(result, {
                referenceId: part.id, attemptId: track.id, part: part.part ?? track.part ?? null,
                reference: refIn, stepsPerBar: per, range: bars,
            }));
            setSelectedIssue(null);
            setSelectedFinding(null);
            setPressedNote(null);
            pr?.setDiffMarks?.({ ...marks, label: noteMarkLabel });
            // 差分チェック (左パネル) と進み具合には、曲全体で比べた結果を渡す (区間だけの結果を全体のものとして見せない)
            const full = range ? await requestDiff(reference, attempt, per, source) : result;
            setCoachResult({ referenceId: part.id, attemptId: track.id, result: full });
            const rate = matchRate(result);
            setStatus(`比べました（${range ? `${practice.loop.startBar}〜${practice.loop.endBar} 小節` : '曲全体'}、一致 ${rate}%）`);
        } catch (e) {
            setError(describeError(e));
        } finally {
            setBusy(false);
        }
    }, [practice, part, track, pianoRollRef, setCoachResult, setStatus, recordLearnAttempt]);

    const selectIssue = useCallback((issue: DiffIssue) => {
        const pr = pianoRollRef.current;
        setSelectedIssue(issue);
        setSelectedFinding(null);
        setPressedNote(null);
        if (!pr || !compare) return;
        pr.flashNotes(notesOfIssue(issue, compare.marks));
        const anchor = issue.expected ?? issue.actual;
        if (anchor) {
            pr.scrollToStep(anchor.step);
            pr.scrollToPitch?.(anchor.note, anchor.octave);
        }
    }, [pianoRollRef, compare]);

    /** 強さの違いのまとまりを選ぶ。当たるノートを選んで光らせ（「強さ」の欄で変えられる）、最初のノートへ動かす。 */
    const selectFinding = useCallback((finding: VelocityFinding) => {
        const pr = pianoRollRef.current;
        const velocity = compare?.result.velocity;
        setSelectedFinding(finding);
        setSelectedIssue(null);
        setPressedNote(null);
        if (!pr || !compare || !velocity) return;
        pr.flashNotes(velocityNotesOf(finding, velocity, compare.attempt, compare.reference));
        const anchor = velocity.notes[finding.notes[0]]?.actual;
        if (anchor) {
            pr.scrollToStep(anchor.step);
            pr.scrollToPitch?.(anchor.note, anchor.octave);
        }
    }, [pianoRollRef, compare]);

    // ---- 再生 ----
    const togglePlay = useCallback(() => {
        engine.init();
        pianoRollRef.current?._saveToEngine?.();
        if (engine.isPlaying) { engine.pause(); setIsPlaying(false); setStatus('一時停止'); }
        else { engine.play(); setIsPlaying(true); setStatus('再生中…'); }
    }, [pianoRollRef, setIsPlaying, setStatus]);

    const stopPlay = useCallback(() => {
        engine.stop();
        // 止めたら区間の頭へ (次の再生も区間の頭から)
        if (practice?.loop.enabled) engine.playOffset = loopSeconds(practice.loop, engine.grid).start;
        setIsPlaying(false);
        setStatus('停止');
    }, [practice, setIsPlaying, setStatus]);

    const setLoop = useCallback((next: PracticeLoop) => updatePractice({ loop: next }), [updatePractice]);

    // ---- キーボード (Space はヘッダが受け持つ。ここは L・[・]・Esc) ----
    useEffect(() => {
        if (!practiceOpen || !practice) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
            if (isTypingTarget(e.target) || isDialogOpen() || document.querySelector('[role="menu"]')) return;
            if (e.key === 'Escape') { e.preventDefault(); closePractice(); setStatus('アレンジに戻りました'); }
            else if (e.key === 'l' || e.key === 'L') {
                e.preventDefault();
                setLoop({ ...practice.loop, enabled: !practice.loop.enabled });
                setStatus(practice.loop.enabled ? '区間ループを止めました' : `区間ループ: ${practice.loop.startBar}〜${practice.loop.endBar} 小節`);
            } else if (e.key === '[' || e.key === ']') {
                e.preventDefault();
                const next = shiftLoop(practice.loop, e.key === '[' ? -1 : 1);
                setLoop(next);
                setStatus(`区間: ${next.startBar}〜${next.endBar} 小節`);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [practiceOpen, practice, closePractice, setLoop, setStatus]);

    const value: PracticeContextValue = {
        midi, part, track, compare, stale, busy, error, runCompare, selectedIssue, pressedNote, selectIssue,
        selectedFinding, selectFinding,
        speedStatus, playing: isPlaying, togglePlay, stopPlay, setLoop,
    };
    return <PracticeContext.Provider value={value}>{children}</PracticeContext.Provider>;
}

// ---- 見出し ----

/**
 * 比べる範囲の小節（学習の記録の範囲）。区間ループが入っていればその区間、無ければお手本のノートの最初から最後まで
 * （差分チェックのパネルで曲全体を比べた記録と同じ範囲になる）。
 */
function compareBars(loop: PracticeLoop | undefined, reference: readonly PianoNote[] | undefined, beatsPerBar: number): BarRange | undefined {
    if (!loop) return undefined;
    if (loop.enabled) return { startBar: loop.startBar, endBar: loop.endBar };
    return reference?.length ? barRangeOf(reference.slice(), stepsPerBar({ beatsPerBar })) : undefined;
}

/** 前回との差の印（▲ 上がった / ▼ 下がった）と、色の種類。 */
function deltaMark(delta: number | null): { arrow: string; cls: string } {
    if (delta === null || delta === 0) return { arrow: '', cls: '' };
    return delta > 0 ? { arrow: '▲', cls: ' up' } : { arrow: '▼', cls: ' down' };
}

/** 練習画面の見出し（アレンジに戻る・何を練習しているか・一致と前回との差）。 */
export function PracticeHeader() {
    const { closePractice, songFile, setStatus, practice, beatsPerBar } = useDaw();
    const { part, track, compare, stale } = usePractice();
    const rate = matchRate(compare?.result ?? null);
    const partName = part ? (part.part ? PART_LABELS[part.part] ?? part.name : part.name) : '';
    // 「前回より +8%」: 同じお手本・同じ練習のトラック・同じ範囲の、1 つ前の記録との差 (学習の記録から)。
    // 比べた後は比べた範囲、まだ比べていなければいまの区間の記録を見る (開き直したプロジェクトでも、前回の値が分かる)
    const bars = compare?.bars ?? compareBars(practice?.loop, part?.referenceNotes, beatsPerBar);
    const summary = useMatchSummary(track?.id, part?.id, bars);
    const previous = compare && summary ? summary.deltaPercent : null;
    const mark = deltaMark(previous);
    return (
        <div id="practice-header" role="region" aria-label="練習画面" data-tip-side="bottom">
            <button type="button" className="practice-back" onClick={() => { closePractice(); setStatus('アレンジに戻りました'); }}
                {...tip('タイムラインと左パネルのある、ふだんの画面に戻ります', { key: 'Esc' })} aria-keyshortcuts="Escape">
                ← アレンジに戻る
            </button>
            <h2 className="practice-title">
                練習: {partName}{songFile ? <span className="practice-song">（{songFile.name}）</span> : null}
            </h2>
            <div className={'practice-match' + (stale ? ' stale' : '')} aria-live="polite"
                {...tip('比べた範囲のお手本のうち、高さが同じで、位置のずれが 16 分音符 2 つぶん以内だったノートの割合')}>
                {rate === null ? (
                    <span className="area-hint">
                        一致 —（まだ比べていません{summary ? `。${practice?.loop.enabled ? 'この区間の' : ''}前回の記録は ${summary.percent}%` : ''}）
                    </span>
                ) : (
                    <>
                        <span className="practice-match-label">一致</span>
                        <strong data-testid="match-rate">{rate}%</strong>
                        {compare && summary && (
                            <span className={'practice-match-delta' + mark.cls} data-testid="match-delta">
                                {mark.arrow && <span aria-hidden="true">{mark.arrow}</span>}{deltaText(summary)}
                            </span>
                        )}
                        {stale && <span className="area-hint">（前のノートで比べた結果）</span>}
                    </>
                )}
            </div>
        </div>
    );
}

// ---- 構成・コード・小節の段 ----

/** ピアノロールの横の見え方（PianoRollEngine.viewState）。 */
interface PianoView {
    stepWidth: number;
    scrollLeft: number;
    totalSteps: number;
    clientWidth: number;
    keysWidth: number;
}

/**
 * 構成・コード・小節の段。ピアノロールと同じ横の位置に並べ、ピアノロールと一緒にスクロールする。
 * 位置は秒からステップに直して出す（lib/grid.ts）。カルテのグリッドをそのまま使っていれば、カルテの N 小節と
 * ピアノロールの N 小節は同じ時刻なので、コードの枠の左端は小節の線にそろう。
 * 小節の段をドラッグすると、区間ループの範囲が決まる。構成の区間を押すと、その区間が区間ループになる。
 */
export function PracticeBands() {
    const { pianoRollRef, chart, practice, bpm, beatsPerBar, gridOffset, setStatus } = useDaw();
    const { setLoop } = usePractice();
    const [view, setView] = useState<PianoView>({ stepWidth: 20, scrollLeft: 0, totalSteps: 128, clientWidth: 0, keysWidth: 52 });
    const bandsRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ from: number; to: number } | null>(null);
    const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
    const grid = useMemo(() => ({ bpm, beatsPerBar, offsetSec: gridOffset }), [bpm, beatsPerBar, gridOffset]);

    // ピアノロールの横のスクロールに合わせて、段の中身を動かす (描き直さずに transform だけ変える)
    useEffect(() => {
        const pr = pianoRollRef.current;
        if (!pr?.onView) return;
        const apply = (v: PianoView) => {
            bandsRef.current?.querySelectorAll<HTMLElement>('.band-inner').forEach((el) => { el.style.transform = `translateX(${-v.scrollLeft}px)`; });
            setView((prev) => (prev.stepWidth === v.stepWidth && prev.totalSteps === v.totalSteps && prev.keysWidth === v.keysWidth
                && prev.clientWidth === v.clientWidth ? prev : v));
        };
        apply(pr.viewState());
        return pr.onView(apply);
    }, [pianoRollRef]);
    useEffect(() => {
        const left = pianoRollRef.current?.wrap?.scrollLeft ?? 0;
        bandsRef.current?.querySelectorAll<HTMLElement>('.band-inner').forEach((el) => { el.style.transform = `translateX(${-left}px)`; });
    });

    const sw = view.stepWidth;
    const per = stepsPerBar(grid);
    const bars = Math.ceil(view.totalSteps / per);
    const width = view.totalSteps * sw;
    const x = (sec: number) => secToStep(sec, grid) * sw;
    const loop = practice?.loop;

    const barAt = (clientX: number, el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const step = (clientX - rect.left + (pianoRollRef.current?.wrap?.scrollLeft ?? 0)) / sw;
        return Math.max(1, Math.floor(step / per) + 1);
    };
    const onBarDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0 || !loop) return;
        e.preventDefault();
        const bar = barAt(e.clientX, e.currentTarget);
        dragRef.current = { from: bar, to: bar };
        setDrag(dragRef.current);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 取れなくても、段の上では動かせる */ }
    };
    const onBarMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        const bar = barAt(e.clientX, e.currentTarget);
        if (bar === dragRef.current.to) return;
        dragRef.current = { ...dragRef.current, to: bar };
        setDrag(dragRef.current);
    };
    const onBarUp = () => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!d || !loop) return;
        const next = { startBar: Math.min(d.from, d.to), endBar: Math.max(d.from, d.to), enabled: true };
        setLoop(next);
        setStatus(`区間: ${next.startBar}〜${next.endBar} 小節`);
    };

    const shown = drag ? { startBar: Math.min(drag.from, drag.to), endBar: Math.max(drag.from, drag.to) } : loop;
    const labelStyle = { width: view.keysWidth, minWidth: view.keysWidth };
    const trackStyle = view.clientWidth ? { width: view.clientWidth } : undefined;
    const inner = (children: ReactNode) => <div className="band-inner" style={{ width }}>{children}</div>;

    return (
        <div id="practice-bands" ref={bandsRef} data-tip-side="top">
            <div className="band-row" data-band="section">
                <div className="band-label" style={labelStyle}>構成</div>
                <div className="band-track" style={trackStyle}>
                    {inner(chart ? chart.sections.map((s) => {
                        const loopOf = secondsToLoop(s.start_sec, s.end_sec, grid);
                        const name = sectionName(s);
                        return (
                            <button key={s.id} type="button" className="band-cell band-section"
                                style={{ left: x(s.start_sec), width: Math.max(2, x(s.end_sec) - x(s.start_sec)) }}
                                aria-label={`「${name}」（${loopOf.startBar}〜${loopOf.endBar} 小節）を区間にする`}
                                {...tip(`${name}（${loopOf.startBar}〜${loopOf.endBar} 小節）\n押すと、この区間をくり返し練習できるようにします`)}
                                onClick={() => { setLoop(loopOf); setStatus(`区間: 「${name}」（${loopOf.startBar}〜${loopOf.endBar} 小節）`); }}>
                                {name}<span className="band-sub">（{loopOf.startBar}–{loopOf.endBar}）</span>
                            </button>
                        );
                    }) : null)}
                    {!chart && <span className="band-empty">カルテがありません</span>}
                </div>
            </div>
            <div className="band-row" data-band="chord">
                <div className="band-label" style={labelStyle}>コード</div>
                <div className="band-track" style={trackStyle}>
                    {inner(chart ? chart.chords.map((c, i) => (
                        <div key={i} className="band-cell band-chord" data-bar={c.bar} data-beat={c.beat}
                            style={{ left: x(c.start_sec), width: Math.max(2, x(c.end_sec) - x(c.start_sec)) }}
                            {...tip(`${c.bar} 小節 ${c.beat} 拍目: ${c.symbol}`)}>
                            {c.symbol}
                        </div>
                    )) : null)}
                </div>
            </div>
            <div className="band-row" data-band="bar">
                <div className="band-label" style={labelStyle}>小節</div>
                <div className="band-track bar-track" style={trackStyle} role="group"
                    aria-label="小節（ドラッグすると、その範囲が区間ループになります）"
                    {...tip('ドラッグした範囲を、くり返し練習する区間にします')}
                    onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                    {inner(
                        <>
                            {shown && (
                                <div className={'loop-range' + (loop?.enabled || drag ? '' : ' off')} aria-hidden="true"
                                    style={{ left: (shown.startBar - 1) * per * sw, width: (shown.endBar - shown.startBar + 1) * per * sw }} />
                            )}
                            {Array.from({ length: bars }, (_, i) => (
                                <div key={i} className="band-cell band-bar" data-bar={i + 1}
                                    style={{ left: i * per * sw, width: per * sw }}>
                                    {(sw * per >= 24 || (i + 1) % 4 === 1) ? i + 1 : ''}
                                </div>
                            ))}
                        </>,
                    )}
                </div>
            </div>
        </div>
    );
}

// ---- 右の一覧 ----

/** 凡例（色と模様と名前。色だけに頼らない）。 */
function Legend() {
    const items: { cls: string; label: string }[] = [
        { cls: 'diff-ok', label: MARK_LABEL.ok },
        { cls: 'diff-pitch', label: `${MARK_LABEL.pitch}（斜線）` },
        { cls: 'diff-rhythm', label: `${MARK_LABEL.rhythm}（点線の縁、‹ 早い / › 遅い）` },
        { cls: 'diff-extra', label: `${MARK_LABEL.extra}（×）` },
        { cls: 'ghost-missing', label: `${MARK_LABEL.missing}（赤い破線のお手本）` },
    ];
    return (
        <ul className="practice-legend" aria-label="色の見方">
            {items.map((it) => (
                <li key={it.cls}><span className={`legend-swatch ${it.cls}`} aria-hidden="true" />{it.label}</li>
            ))}
        </ul>
    );
}

/** 右の一覧（この区間の指摘・押したノートの説明・凡例・ガイドを読む）。 */
export function PracticeSide() {
    const { practice, closePractice, openLearn, setStatus } = useDaw();
    const { compare, stale, error, selectedIssue, pressedNote, selectIssue, selectedFinding, selectFinding, runCompare, busy } = usePractice();
    const listRef = useRef<HTMLUListElement | null>(null);
    const issues = useMemo(() => (compare ? issuesInOrder(compare.result) : []), [compare]);

    // 押したノートの指摘を、一覧の見えるところへ
    useEffect(() => {
        if (!selectedIssue || !listRef.current) return;
        listRef.current.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
    }, [selectedIssue]);

    const where = practice?.loop.enabled ? `${practice.loop.startBar}〜${practice.loop.endBar} 小節` : '曲全体';
    // 説明は、この欄の外 (左、ピアノロールの側) に出す。指摘の一覧を隠さないため
    return (
        <aside id="practice-side" aria-label="この区間の指摘" data-tip-side="left" data-tip-box="">
            <h3>{compare?.range ? 'この区間の指摘' : '指摘'}<span className="area-hint">（{where}）</span></h3>
            {error && <p role="alert" className="error-text">{error}</p>}
            {stale && (
                <div className="practice-stale" role="status">
                    <p>{stale === 'notes' ? 'ノートを変えたので、もう一度比べてください' : '区間を変えたので、もう一度比べてください'}</p>
                    <button type="button" className="action-btn" onClick={() => void runCompare()} disabled={busy}
                        {...tip('いまのノートで、もう一度お手本と比べます')}>もう一度比べる</button>
                </div>
            )}
            {!compare && !error && (
                <p className="body-text practice-hint">
                    お手本（水色）を見ながらノートを置き、下の「比べる」を押すと、違うところに色が付きます。
                </p>
            )}
            {pressedNote && <p className="practice-pressed" role="status">選んだノート: {pressedNote}</p>}
            {compare && !stale && (issues.length === 0 ? (
                <p className="body-text">
                    {hasVelocityDiff(compare.result) ? 'この範囲の高さ・位置・長さは、お手本どおりです。' : 'この範囲は、お手本どおりです。'}
                </p>
            ) : (
                <>
                    <p className="practice-counts">
                        {(['missing', 'pitch', 'octave', 'extra', 'timing', 'length'] as const)
                            .filter((k) => compare.result.summary[k] > 0).map((k) => `${KIND_LABEL[k]} ${compare.result.summary[k]}`).join(' / ')}
                    </p>
                    <ul className="practice-issues" ref={listRef} aria-label="指摘の一覧（押すと、そのノートを選びます）">
                        {issues.map((issue, i) => (
                            <li key={i}>
                                <button type="button" className={`issue-btn issue-${issue.kind}`} aria-current={issue === selectedIssue ? 'true' : undefined}
                                    onClick={() => selectIssue(issue)} {...tip('ピアノロールで、このノートを選んで光らせます')}>
                                    {issueText(issue)}
                                </button>
                            </li>
                        ))}
                    </ul>
                </>
            ))}
            {compare && !stale && <VelocityFindings velocity={compare.result.velocity} onSelect={selectFinding} selected={selectedFinding} />}
            <Legend />
            <button type="button" className="action-btn secondary practice-guide"
                onClick={() => { closePractice(); openLearn('guide'); setStatus('アレンジに戻って、再現ガイドを開きました'); }}
                {...tip('ふだんの画面に戻って、左パネルの「ガイド」を開きます')}>
                ガイドを読む
            </button>
        </aside>
    );
}

// ---- 下の操作 ----

/** 区間ループの小節の欄（数字を打って Enter か、欄を離れたときに決める）。 */
function BarInput({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
    // 打っている途中の文字 (決めるまでは、区間を変えない)。null なら、いまの値を出す
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft === null) return;
        const v = parseInt(draft, 10);
        setDraft(null);
        if (Number.isFinite(v) && v >= 1 && v !== value) onCommit(v);
    };
    return (
        <input type="number" min={1} className="bar-input" aria-label={label} value={draft ?? String(value)}
            {...tip(`${label}。数字を入れて Enter で決まります`)}
            onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
    );
}

/** 練習画面の下の操作（再生・区間ループ・速度・聴く・お手本・入力・比べる）。 */
export function PracticeControls() {
    const { practice, updatePractice, beatsPerBar, setStatus } = useDaw();
    const { midi, playing, togglePlay, stopPlay, setLoop, speedStatus, runCompare, busy, part } = usePractice();
    if (!practice) return null;
    const { loop } = practice;
    const listen: { key: ListenMode; label: string }[] = [
        { key: 'part', label: 'パート' }, { key: 'self', label: '自分' }, { key: 'both', label: '両方' },
    ];
    const inputs: { key: InputMode; label: string }[] = [
        { key: 'mouse', label: 'マウス' }, { key: 'midi-step', label: 'MIDI ステップ' }, { key: 'midi-realtime', label: 'MIDI リアルタイム' },
    ];
    const speedText = (() => {
        switch (speedStatus.kind) {
            case 'preparing': return `${speedLabel(practice.speed)} の音を用意しています…（それまでは 100% で鳴らします）`;
            case 'ready': return `${speedLabel(practice.speed)}（音の高さはそのまま）`;
            case 'needs-loop': return '速度は区間ループの中で効きます。区間ループを入れてください';
            case 'error': return `速度を変えた音を作れませんでした（${speedStatus.message}）。100% で鳴らします`;
            default: return '';
        }
    })();
    return (
        <div id="practice-controls" role="toolbar" aria-label="練習の操作" data-tip-side="top">
            <div className="practice-row">
                <button type="button" className="practice-transport" onClick={togglePlay} aria-label={playing ? '一時停止' : '再生'}
                    {...tip(playing ? '一時停止します' : '区間の頭から鳴らします。区間ループ中は、くり返し鳴ります', { key: 'Space' })} aria-keyshortcuts="Space">{playing ? '⏸' : '▶'}</button>
                <button type="button" className="practice-transport" onClick={stopPlay} aria-label="停止" {...tip('止めて、区間の頭に戻ります')}>■</button>

                <span className="practice-group" role="group" aria-label="区間ループ">
                    <label className="practice-check" {...tip('決めた区間だけを、くり返し鳴らします', { key: 'L' })}>
                        <input type="checkbox" checked={loop.enabled} aria-keyshortcuts="L"
                            onChange={(e) => setLoop({ ...loop, enabled: e.target.checked })} />
                        区間ループ
                    </label>
                    <BarInput label="区間の始まりの小節" value={loop.startBar}
                        onCommit={(v) => setLoop({ ...loop, startBar: v, endBar: Math.max(v, loop.endBar) })} />
                    <span aria-hidden="true">〜</span>
                    <BarInput label="区間の終わりの小節" value={loop.endBar}
                        onCommit={(v) => setLoop({ ...loop, endBar: Math.max(loop.startBar, v) })} />
                    <span className="area-hint">小節</span>
                    <button type="button" className="practice-mini" aria-label="区間を 1 小節前へ" {...tip('区間を 1 小節前へずらします', { key: '[' })} aria-keyshortcuts="["
                        onClick={() => setLoop(shiftLoop(loop, -1))} disabled={loop.startBar <= 1}>‹</button>
                    <button type="button" className="practice-mini" aria-label="区間を 1 小節後ろへ" {...tip('区間を 1 小節後ろへずらします', { key: ']' })} aria-keyshortcuts="]"
                        onClick={() => setLoop(shiftLoop(loop, 1))}>›</button>
                </span>

                <span className="practice-group">
                    <label htmlFor="practice-speed">速度</label>
                    <select id="practice-speed" value={practice.speed}
                        {...tip('ゆっくり鳴らして聴き取りやすくします。音の高さは変わりません。区間ループの中で効きます')}
                        onChange={(e) => updatePractice({ speed: Number(e.target.value) })}
                        data-stretched-sec={speedStatus.kind === 'ready' && speedStatus.seconds !== null ? speedStatus.seconds.toFixed(3) : undefined}>
                        {SPEEDS.map((s) => <option key={s} value={s}>{speedLabel(s)}</option>)}
                    </select>
                    {speedText && <span className={'area-hint practice-speed-status' + (speedStatus.kind === 'error' ? ' error-text' : '')}
                        role="status" data-state={speedStatus.kind}>{speedText}</span>}
                </span>

                <span className="practice-group" role="radiogroup" aria-label="聴く">
                    <span className="practice-group-label" aria-hidden="true">聴く</span>
                    {listen.map((l) => (
                        <label key={l.key} className="practice-radio"
                            {...tip(l.key === 'part' ? '原曲のこのパートの音だけを鳴らします' : l.key === 'self' ? '自分が置いたノートだけを鳴らします' : 'パートの音と自分のノートを重ねて鳴らします')}>
                            <input type="radio" name="practice-listen" checked={practice.listen === l.key}
                                onChange={() => updatePractice({ listen: l.key })} />
                            {l.label}
                        </label>
                    ))}
                </span>
            </div>
            <div className="practice-row">
                <span className="practice-group" role="radiogroup" aria-label="お手本">
                    <span className="practice-group-label" aria-hidden="true">お手本</span>
                    {[true, false].map((v) => (
                        <label key={String(v)} className="practice-radio"
                            {...tip(v ? 'お手本を水色で薄く重ねて見せます' : 'お手本を隠して、耳だけを頼りに打ち込みます')}>
                            <input type="radio" name="practice-ghost" checked={practice.showGhost === v}
                                onChange={() => updatePractice({ showGhost: v })} />
                            {v ? '見せる' : '隠す'}
                        </label>
                    ))}
                </span>

                <span className="practice-group" role="radiogroup" aria-label="入力">
                    <span className="practice-group-label" aria-hidden="true">入力</span>
                    {inputs.map((it) => (
                        <label key={it.key} className="practice-radio"
                            {...tip(it.key === 'mouse' ? 'ピアノロールをダブルクリックして、ノートを置きます'
                                : !midi.available ? midiUnavailableText()
                                    : it.key === 'midi-step' ? '鍵盤を弾くたびに、区間の頭から 1 つずつノートを置きます'
                                        : '再生しながら弾いたとおりに置きます。区間ループ中は 1 周ごとに重ねて録り、元に戻すと最後の 1 周ぶんが消えます')}>
                            <input type="radio" name="practice-input" checked={practice.input === it.key}
                                disabled={it.key !== 'mouse' && !midi.available}
                                onChange={() => updatePractice({ input: it.key })} />
                            {it.label}
                        </label>
                    ))}
                    {practice.input === 'midi-step' && midi.connected && (
                        <>
                            <StepLengthSelect midi={midi} />
                            <span className="area-hint">次の位置: {cursorLabel(midi.cursor, beatsPerBar)}</span>
                            <button type="button" className="practice-mini" {...tip('次にノートを置く位置を、区間の頭に戻します')} onClick={() => {
                                midi.setCursor(loop.enabled ? loopSteps(loop, { beatsPerBar }).start : 0);
                                setStatus('ステップ入力の位置を、区間の頭に戻しました');
                            }}>区間の頭へ</button>
                        </>
                    )}
                    {practice.input === 'midi-realtime' && midi.connected && (
                        <RealtimeSettings midi={midi} />
                    )}
                    {practice.input !== 'mouse' && midi.connected && (
                        <span className="area-hint">{midi.devices.length > 0 ? midi.devices.join(' / ') : '鍵盤が見つかりません'}</span>
                    )}
                </span>

                <button type="button" className="action-btn primary practice-compare" onClick={() => void runCompare()} disabled={busy || !part}
                    {...tip(loop.enabled ? '区間の中のノートをお手本と比べて、違うところに色を付けます' : '曲全体のノートをお手本と比べて、違うところに色を付けます')}>
                    {busy ? '比べています…' : '比べる'}
                </button>
            </div>
            <span className="visually-hidden">{`ショートカット: Space 再生、L 区間ループ、[ ] 区間を動かす、Esc アレンジに戻る、${modKeyLabel()}Z 元に戻す`}</span>
        </div>
    );
}
