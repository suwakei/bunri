/**
 * bunri DAW — MIDI キーボード入力の仕組み（つなぐ・鳴らす・録る）。
 *
 * 中央エリアが 1 つだけ持ち、ふだんのピアノロールの見出し（components/MidiInputBar.tsx）と、
 * 練習画面の「入力」（components/PracticeView.tsx）の両方から使う（MIDI の処理を二重にしない）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaw } from './store';
import engine, { type PianoNote } from './engine';
import { secToStep } from './grid';
import { describeError, isDesktop } from './api';
import { MidiNoteRecorder, cursorLabel, parseMidiMessage, pickMidiSource, pitchToNote, type MidiSource, type RecordMode } from './midi-input';
import { recordActivity } from './activity';
import { dismissNotice, notify } from './notice';
import { isSnapId, realtimeQuantum, stepCell, stepText } from './snap';

/** ステップ入力の長さの値: ピアノロールで選んだ刻みに従う（刻み 1 つぶんのノートを置いて、隣の位置へ進む）。 */
export const STEP_FOLLOWS_SNAP = 0;

/** 練習画面が、録る範囲と置き方を差し替えるための口（`useMidiInput` の `setPracticeHooks`）。 */
export interface MidiPracticeHooks {
    /** 録る範囲（ステップ。区間ループ）。無ければ null */
    bounds: () => { start: number; end: number } | null;
    /**
     * ノートを置く。置いたら true（false なら、ふだんの置き方で置く）。
     * 練習画面のリアルタイム録音は、重ねて録り、1 周ごとに記録を分ける
     */
    addNote: (note: PianoNote, mode: RecordMode) => boolean;
}

/** MIDI 入力の操作（`useMidiInput` が返す）。 */
export interface MidiInputController {
    /** この環境で MIDI 入力が使えるか */
    available: boolean;
    connected: boolean;
    /** つながっている機器の名前 */
    devices: string[];
    mode: RecordMode;
    setMode: (mode: RecordMode) => void;
    /** ステップ入力で置くノートの長さ（ステップ）。`STEP_FOLLOWS_SNAP`（0）なら、ピアノロールで選んだ刻みに従う（既定） */
    stepLength: number;
    setStepLength: (length: number) => void;
    /** ステップ入力の、次に置く位置 */
    cursor: number;
    setCursor: (step: number) => void;
    /** 入力を開く。開けたら true */
    connect: () => Promise<boolean>;
    disconnect: () => Promise<void>;
    /** 練習画面の口を付ける（null で外す） */
    setPracticeHooks: (hooks: MidiPracticeHooks | null) => void;
    /** リアルタイム録音の前に、1 小節ぶんのカウントを入れるか */
    countIn: boolean;
    setCountIn: (on: boolean) => void;
    /** リアルタイム録音で、弾いた位置を前へ戻す量（ミリ秒）。自分で決めていなければ、音の出力の遅れから決めた値 */
    latencyMs: number;
    /** 遅れの補正を、自分で決めずに任せているか */
    latencyAuto: boolean;
    /** 遅れの補正を決める（null で、任せる） */
    setLatencyMs: (ms: number | null) => void;
}

/** 最後に鍵盤のメッセージ（押した・離した）が届いた時刻（`Date.now()`。まだ届いていなければ 0）。 */
let lastMessageAt = 0;

/** 鍵盤のメッセージが届いたことを覚える。 */
export function noteMidiMessage(): void {
    lastMessageAt = Date.now();
}

/**
 * 最後に鍵盤のメッセージが届いてから経った時間（ミリ秒。まだ届いていなければ Infinity）。
 * 自動保存（lib/autosave.ts）が、リアルタイム録音で弾いている最中を避けるのに使う。
 */
export function msSinceMidiMessage(): number {
    return lastMessageAt === 0 ? Infinity : Date.now() - lastMessageAt;
}

/** 設定の置き場（ブラウザの保存領域）。 */
const COUNT_IN_KEY = 'bunri-midi-count-in';
const LATENCY_KEY = 'bunri-midi-latency-ms';
/** 「MIDI 機器がつながっています」を、もう知らせたか（アプリを開いているあいだに 1 回だけ出す）。 */
let portsAnnounced = false;
/** 出ている「MIDI 機器がつながっています」の知らせの番号（MIDI 入力を始めたら閉じる）。 */
let portsNoticeId: number | null = null;
/** MIDI 入力の始め方を、もう知っているか（一度始めた・知らせを閉じた）の置き場。知っていれば、知らせを出さない。 */
const MIDI_INTRO_KEY = 'bunri-midi-intro-seen';
/** テスト用: 「MIDI 機器がつながっています」を、もう一度出せるようにする。 */
export function resetMidiPortsAnnouncement(): void {
    portsAnnounced = false;
    portsNoticeId = null;
    writeSetting(MIDI_INTRO_KEY, null);
}
/** 遅れの補正の上限（ミリ秒）。 */
export const MAX_LATENCY_MS = 500;

function readSetting(key: string): string | null {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function writeSetting(key: string, value: string | null): void {
    try {
        if (value === null) globalThis.localStorage?.removeItem(key);
        else globalThis.localStorage?.setItem(key, value);
    } catch { /* 保存できない環境では、その場かぎりの設定にする */ }
}

/**
 * MIDI キーボード入力の仕組み（つなぐ・鳴らす・録る）。中央エリアが 1 つだけ持つ。
 */
export function useMidiInput(): MidiInputController {
    const { pianoRollRef, setStatus, bumpTracks, beatsPerBar } = useDaw();
    const [available] = useState(() => pickMidiSource() !== null);
    const [connected, setConnected] = useState(false);
    const [devices, setDevices] = useState<string[]>([]);
    const [mode, setModeState] = useState<RecordMode>('step');
    // ステップ入力の 1 歩。既定は、ピアノロールで選んだ刻みに従う (STEP_FOLLOWS_SNAP)。決まった長さも選べる
    const [stepLength, setStepLengthState] = useState(STEP_FOLLOWS_SNAP);
    const stepLengthRef = useRef(STEP_FOLLOWS_SNAP);
    const [cursor, setCursorState] = useState(0);
    const sourceRef = useRef<MidiSource | null>(null);
    const recorderRef = useRef<MidiNoteRecorder | null>(null);
    const hooksRef = useRef<MidiPracticeHooks | null>(null);
    /** いま知らせてある「ノートを置けない理由」(同じ理由が続くあいだは、もう一度は知らせない) */
    const blockedHintRef = useRef<string | null>(null);
    const [countIn, setCountInState] = useState(() => readSetting(COUNT_IN_KEY) !== '0');
    // 遅れの補正。null は「任せる」(音の出力の遅れから決める)
    const [manualLatency, setManualLatency] = useState<number | null>(() => {
        const saved = Number(readSetting(LATENCY_KEY));
        return readSetting(LATENCY_KEY) !== null && Number.isFinite(saved) ? Math.max(0, Math.min(MAX_LATENCY_MS, saved)) : null;
    });
    const [autoLatency, setAutoLatency] = useState(0);
    /** いま効いている遅れの補正（秒）と、処理中のメッセージが届いてから経った時間（秒）。録る部品が見にいく */
    const latencyRef = useRef(0);
    const messageAgeRef = useRef(0);
    // 動きの記録に、ノートを置いた位置を「小節・拍」で出すため
    const beatsPerBarRef = useRef(beatsPerBar);
    beatsPerBarRef.current = beatsPerBar;
    latencyRef.current = (manualLatency ?? autoLatency) / 1000;

    // 録り方を決める部品。ピアノロールと再生位置を、呼ばれたときに見にいく
    if (recorderRef.current === null) {
        recorderRef.current = new MidiNoteRecorder({
            position: () => {
                const sec = engine.getPlayPosition();
                if (sec === null) return null;
                // 弾いた位置を、遅れのぶんだけ前へ戻す。聞こえた音に合わせて弾くと、音が耳に届くまでの遅れと、
                // 鍵盤からここに届くまでの遅れのぶんだけ、再生位置は先へ進んでいる
                const played = sec - latencyRef.current - messageAgeRef.current;
                // ステップ 0 は 1 小節目の位置 (engine.gridOffset)。それより前 (弱起) は 1 小節目の頭にする
                return Math.max(0, secToStep(played, engine.grid));
            },
            // 元に戻せる。リアルタイム録音は、弾き続けているあいだのノートを 1 つの記録にまとめる
            addNote: (n) => {
                const recordMode = recorderRef.current?.mode ?? 'off';
                if (hooksRef.current?.addNote(n, recordMode)) return;
                pianoRollRef.current?._addNote(n.note, n.octave, n.step, n.length, recordMode === 'realtime'
                    ? { label: 'MIDI 入力の録音', coalesceKey: 'midi-realtime', coalesceMs: 4000, velocity: n.velocity }
                    : { label: 'MIDI 入力でノートを追加', velocity: n.velocity });
            },
            // ピアノロールは打ち込むと伸びるので、末尾の制限は「伸ばせる上限」にする
            get totalSteps() { return pianoRollRef.current?.maxSteps ?? pianoRollRef.current?.totalSteps ?? 128; },
            get minOctave() { return pianoRollRef.current?.octaveRange?.[0] ?? 0; },
            get maxOctave() { return pianoRollRef.current?.octaveRange?.[1] ?? 9; },
            bounds: () => hooksRef.current?.bounds() ?? null,
            // ステップ入力の 1 歩は、選んだ刻み (三連なら三連の位置を 1 つずつ。スウィングなら、ずらした位置)。
            // 決まった長さを選んでいるあいだは、その長さずつ進む
            cell: (at) => {
                const snap = pianoRollRef.current?.snap;
                return stepLengthRef.current > 0 || !snap ? null : stepCell(snap, at);
            },
            // リアルタイム録音は、選んだ刻みが 16 分より細かいか三連のときはその刻みに、そうでなければ 16 分音符にそろえる
            quantum: () => {
                const id = pianoRollRef.current?.snapId?.();
                return isSnapId(id) ? realtimeQuantum(id) : 1;
            },
        });
    }

    const handleMessage = useCallback((bytes: ArrayLike<number>, receivedAt?: number) => {
        const event = parseMidiMessage(bytes);
        const recorder = recorderRef.current;
        if (!event || !recorder) return;
        noteMidiMessage();
        // 機器から届いた時刻が分かれば、ここで処理するまでの待ちも、遅れとして差し引く (長すぎる値は信用しない)
        const age = typeof receivedAt === 'number' ? (performance.now() - receivedAt) / 1000 : 0;
        messageAgeRef.current = age > 0 && age < 0.5 ? age : 0;

        // 弾いた音は、録るかどうかに関係なく鳴らす
        // ドラムのトラックを開いているあいだは、ドラムの行の鍵盤は種類ごとの音で鳴る (再生と同じ音)
        if (event.type === 'on') engine.liveNoteOn(event.pitch, event.velocity, { drums: pianoRollRef.current?.drumMode === true });
        else engine.liveNoteOff(event.pitch);
        // 動きの記録 (lib/activity.ts): 鍵盤の操作と、その結果ノートが置かれたか
        const { note, octave } = pitchToNote(event.pitch);
        recordActivity('midi', event.type === 'on' ? `押した ${note}${octave}（強さ ${event.velocity}）` : `離した ${note}${octave}`);

        if (recorder.mode === 'off') return;
        // ノートを置けない理由は、同じ理由が続くあいだは 1 回だけ知らせる (音を探して弾き続けているあいだ、知らせが居座らないように)。
        // ノートを置けたとき・録り方を変えたとき・つなぎ直したときに、もう一度知らせられるようにする
        const hintOnce = (reason: string, text: string) => {
            if (blockedHintRef.current === reason) return;
            blockedHintRef.current = reason;
            setStatus(text, 'hint');
        };
        if (pianoRollRef.current?.getActiveTrackId?.() == null) {
            if (event.type === 'on') hintOnce('no-track', 'MIDI 入力: 先に、ノートを入れるトラックをクリックして選んでください（いまは音が鳴るだけで、ノートは置かれません）');
            return;
        }
        const result = recorder.handle(event);
        if (result.kind === 'added') {
            const placed = result.note;
            recordActivity('midi', `ノートを置いた ${placed.note}${placed.octave}（位置 ${cursorLabel(placed.step, Math.max(1, Number(beatsPerBarRef.current) || 4))}・ステップ ${stepText(placed.step)}、長さ ${stepText(placed.length)}、強さ ${placed.velocity ?? '無し'}）`);
            bumpTracks();
            blockedHintRef.current = null;
        } else if (result.kind === 'skipped' && result.reason === 'stopped' && engine.isCountingIn()) {
            // 録音前のカウントの間に弾いた音は、録らない (知らせも出さない。カウントが終われば録り始める)
        } else if (result.kind === 'skipped') {
            const inLoop = hooksRef.current?.bounds() != null;
            hintOnce(result.reason, {
                range: 'MIDI 入力: この高さはピアノロールの範囲の外なので、ノートを置けません。鍵盤のオクターブを切り替えて、範囲の中の高さで弾いてください',
                end: inLoop ? 'MIDI 入力: 区間の終わりまで入力しました（「区間の頭へ」で戻ります）' : 'MIDI 入力: ピアノロールの末尾まで入力しました',
                stopped: 'MIDI 入力: リアルタイム録音は、再生してから弾いてください（止まっているあいだは録りません。1 音ずつ置くなら、録り方を「ステップ入力」にします）',
            }[result.reason]);
        }
        setCursorState(recorder.cursor);
    }, [pianoRollRef, setStatus, bumpTracks]);

    const connect = useCallback(async () => {
        const source = pickMidiSource();
        if (!source) return false;
        // 開き直すとき (再検出) は、前の入力を先に閉じる。閉じないと、前の受け口が残って、1 回の打鍵が 2 回届く
        const previous = sourceRef.current;
        sourceRef.current = null;
        if (previous) { try { await previous.stop(); } catch { /* 閉じる途中の失敗は無視する */ } }
        blockedHintRef.current = null;
        try {
            await source.start(handleMessage, (names) => {
                recordActivity('midi', names.length > 0 ? `MIDI 入力を開いた（${names.join(' / ')}）` : 'MIDI 入力を開いたが、鍵盤が見つからない');
                setDevices(names);
                // つないだあと、何ができるかを出す。鍵盤が無いときは、弾いても何も起きない理由を知らせる
                if (names.length > 0) {
                    setStatus(`MIDI 入力を始めました（${names.join(' / ')}）。弾くと音が鳴ります。ノートを置くには、トラックを選んでから弾きます`);
                    // 始め方は、もう分かっている。「つながっています」の知らせは閉じ、次からは出さない
                    writeSetting(MIDI_INTRO_KEY, '1');
                    if (portsNoticeId !== null) { dismissNotice(portsNoticeId); portsNoticeId = null; }
                } else setStatus('MIDI 鍵盤が見つかりません。鍵盤をつないで電源を入れてから、「再検出」を押してください', 'hint');
            });
            sourceRef.current = source;
            setConnected(true);
            // 音の出力の遅れは、音を出す準備ができてから分かる
            engine.init();
            const readLatency = () => setAutoLatency(Math.min(MAX_LATENCY_MS, Math.round(engine.outputLatencySec() * 1000)));
            readLatency();
            // デスクトップ版では、Rust が出力デバイスを開き終わってから、その遅れに読み直す
            if (engine.usesNativeAudio()) void engine.audioReady().then(readLatency);
            return true;
        } catch (e) {
            setStatus('MIDI 入力を開けませんでした。鍵盤がつながっているかを確かめて、もう一度押してください（' + describeError(e) + '）', 'error');
            return false;
        }
    }, [handleMessage, setStatus]);

    // MIDI 機器がつながっているのに、MIDI 入力を始めていないとき: 入力を始めるまでは、弾いても何も届かない (音も鳴らない)。
    // 「つないだのに何も起きない」の理由を、画面を開いたときに 1 回だけ知らせる (調べられるのは、デスクトップ版だけ)。
    // 一度でも MIDI 入力を始めたか、知らせを ✕ で閉じたあとは、もう出さない (`MIDI_INTRO_KEY`)
    const connectedRef = useRef(false);
    connectedRef.current = connected;
    useEffect(() => {
        const source = portsAnnounced || readSetting(MIDI_INTRO_KEY) === '1' ? null : pickMidiSource();
        if (!source?.ports) return;
        let cancelled = false;
        void source.ports().then((names) => {
            if (cancelled || portsAnnounced || names.length === 0 || connectedRef.current) return;
            portsAnnounced = true;
            // 利用者の操作への答えではないので、ステータスバーの文 (「準備完了」など) は変えずに、知らせだけを出す
            recordActivity('midi', `つながっている MIDI 機器を見つけた（${names.join(' / ')}）。MIDI 入力は、まだ始めていない`);
            portsNoticeId = notify('hint', `MIDI 機器（${names.join(' / ')}）がつながっています。まだ、鍵盤を弾いても何も起きません。「MIDI 入力」を押すと、弾いて音を鳴らしたり、ノートを置いたりできます`, {
                live: true,
                // ✕ で閉じたら、次からは出さない (MIDI を使わない人に、開くたびに出さない)
                onDismiss: () => writeSetting(MIDI_INTRO_KEY, '1'),
                action: { label: 'MIDI 入力を始める', run: () => void connect(), tip: 'つないだ MIDI 鍵盤で音を鳴らしたり、ノートを置いたりできるようにします' },
            });
        }).catch(() => { /* 調べられなければ、知らせないだけにする */ });
        return () => { cancelled = true; };
    }, [connect]);

    const disconnect = useCallback(async () => {
        const source = sourceRef.current;
        sourceRef.current = null;
        setConnected(false);
        setDevices([]);
        engine.liveAllNotesOff();
        recordActivity('midi', 'MIDI 入力を止めた');
        try { await source?.stop(); } catch { /* 閉じる途中の失敗は無視する */ }
    }, []);

    // 画面を離れるときは入力を閉じ、鳴っている音を止める
    useEffect(() => () => {
        engine.liveAllNotesOff();
        void sourceRef.current?.stop().catch(() => {});
    }, []);

    const setMode = useCallback((next: RecordMode) => {
        blockedHintRef.current = null;
        setModeState(next);
        recorderRef.current?.setMode(next);
    }, []);

    const setStepLength = useCallback((length: number) => {
        const value = Number.isFinite(length) && length > 0 ? length : STEP_FOLLOWS_SNAP;
        setStepLengthState(value);
        stepLengthRef.current = value;
        // 刻みに従うあいだは、録る部品の長さは使われない (刻みが分からないときの控えとして、4 分音符にしておく)
        if (recorderRef.current) recorderRef.current.stepLength = value > 0 ? value : 4;
    }, []);

    const setCursor = useCallback((step: number) => {
        if (recorderRef.current) recorderRef.current.cursor = step;
        setCursorState(step);
    }, []);

    const setPracticeHooks = useCallback((hooks: MidiPracticeHooks | null) => { hooksRef.current = hooks; }, []);

    const setCountIn = useCallback((on: boolean) => {
        setCountInState(on);
        writeSetting(COUNT_IN_KEY, on ? '1' : '0');
    }, []);

    const setLatencyMs = useCallback((ms: number | null) => {
        const value = ms === null || !Number.isFinite(ms) ? null : Math.max(0, Math.min(MAX_LATENCY_MS, Math.round(ms)));
        setManualLatency(value);
        writeSetting(LATENCY_KEY, value === null ? null : String(value));
    }, []);

    // リアルタイム録音を選んでいるあいだは、再生の前に 1 小節ぶんのカウントを入れる (再生エンジンが鳴らす)
    useEffect(() => {
        engine.countInBeats = connected && mode === 'realtime' && countIn ? Math.max(1, Number(beatsPerBar) || 4) : 0;
        return () => { engine.countInBeats = 0; };
    }, [connected, mode, countIn, beatsPerBar]);

    // 最初の録り方を、録る部品にも伝えておく
    useEffect(() => { recorderRef.current?.setMode(mode); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return {
        available, connected, devices, mode, setMode, stepLength, setStepLength, cursor, setCursor, connect, disconnect, setPracticeHooks,
        countIn, setCountIn, latencyMs: manualLatency ?? autoLatency, latencyAuto: manualLatency === null, setLatencyMs,
    };
}

/** MIDI 入力が使えない環境で出す文。 */
export function midiUnavailableText(): string {
    // 対応するブラウザの案内は、開発用のブラウザ起動のときだけ出す
    return isDesktop()
        ? 'MIDI 入力は、この環境では使えません'
        : 'MIDI 入力はこのブラウザでは使えません（Chrome / Edge、またはデスクトップ版で使えます）';
}

