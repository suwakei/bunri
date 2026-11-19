/**
 * クリップの範囲とフェードの、保存と読み出し (lib/project-file.ts)。自動保存と復旧も、同じ文書 (`buildDocument` /
 * `applyDocument`) を通る。以前のクリップ (項目が無い) は、これまでと同じに開く。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
import type * as PF from '../lib/project-file';

expect.extend(matchers);

class MockNode {
    gain = { value: 1 };
    pan = { value: 0 };
    connect() { return this; }
}
/** `seconds` 秒の AudioBuffer もどき。 */
function fakeBuffer(seconds: number, rate = 8000): AudioBuffer {
    const data = new Float32Array(Math.max(1, Math.round(seconds * rate)));
    return { duration: data.length / rate, sampleRate: rate, numberOfChannels: 1, length: data.length, getChannelData: () => data } as unknown as AudioBuffer;
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockNode() as unknown as GainNode; }
    createStereoPanner() { return new MockNode() as unknown as StereoPannerNode; }
    createBuffer(_ch: number, length: number, rate: number) { return fakeBuffer(length / rate, rate); }
    /** デコードすると、バイト数 ÷ 100 を長さ (秒) にした音声を返す。 */
    async decodeAudioData(bytes: ArrayBuffer) { return fakeBuffer(bytes.byteLength / 100); }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { default: engine } = await import('../lib/engine');
const { rememberSource } = await import('../lib/audio-sources');
const pf = await import('../lib/project-file');
const { setClipFades, splitClip, trimClipStart } = await import('../lib/clip');
const ClipFadeDialog = (await import('../components/ClipFadeDialog')).default;

beforeEach(() => {
    cleanup();
    engine.init();
    engine.tracks = [];
    engine.bpm = 120; engine.beatsPerBar = 4; engine.gridOffset = 0;
});
afterEach(() => vi.unstubAllGlobals());

function buildInput(): Parameters<typeof pf.buildDocument>[0] {
    return {
        name: '曲', chart: null, chartId: null, chartPeaks: null, songFile: null, ghostChoice: 'auto',
        coachPair: { referenceId: null, attemptId: null }, coachResult: null, learnHistory: [],
        leftTab: 'learn', learnTab: 'coach', openTrackId: null, partsUseChart: false,
    };
}

function applyTarget(): PF.ApplyTarget {
    return {
        setBpm: (v) => { engine.bpm = v; }, setBeatsPerBar: (v) => { engine.beatsPerBar = v; }, setGridOffset: (v) => { engine.gridOffset = v; },
        setChartResult: vi.fn(), clearChart: vi.fn(), setSongFile: vi.fn(), setGhostChoice: vi.fn(), setCoachPair: vi.fn(),
        setCoachResult: vi.fn(), setLearnHistory: vi.fn(), setLeftTab: vi.fn(), setLearnTab: vi.fn(), setChartIdOfParts: vi.fn(),
        pianoRoll: null,
    };
}

/** 音声を取りに来たら、`bytes` バイトの中身を返す (デコードすると `bytes / 100` 秒になる)。 */
function stubAudio(bytes: number) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
        url.startsWith('/api/project/tok/audio/')
            ? new Response(new Uint8Array(bytes), { headers: { 'content-type': 'audio/wav' } })
            : new Response('', { status: 404 })
    )));
}

const docWith = (clips: PF.DocClip[]): PF.ProjectDocument => ({
    version: 1, meta: { name: '曲' }, grid: { bpm: 120, beatsPerBar: 4, gridOffset: 0 },
    tracks: [{ name: 'Track 1', role: null, part: null, practiceOf: null, gain: 0, pan: 0, mute: false, solo: false, notes: [], referenceNotes: null, clips }],
    chart: null, state: {}, history: [], token: 'tok', audioBase: '/api/project/tok/audio/',
});

describe('文書を作る', () => {
    it('縮めた範囲とフェードが入る。分割した 2 つは同じ音声を指し、音声は 1 つだけ送る', async () => {
        const track = engine.addTrack('Track 1');
        const buffer = fakeBuffer(10);
        rememberSource(buffer, new Blob(['ten-seconds-of-audio']), 'take.wav');
        // 頭を 2 秒縮め、フェードを付けてから、6 秒の位置で分ける
        const edited = setClipFades(trimClipStart({ buffer, offset: 1, name: 'take.wav', duration: 10 }, 3), { fadeIn: 0.5, fadeOut: 1.5 });
        track.clips.push(...splitClip(edited, 6)!);
        // 何もしていないクリップ (以前のクリップと同じ形)
        track.clips.push({ buffer: fakeBuffer(2), offset: 20, name: 'old.wav', duration: 2 });

        const { doc, audio } = await pf.buildDocument(buildInput());
        const [left, right, old] = doc.tracks[0].clips;
        expect(left).toMatchObject({ name: 'take.wav', offset: 3, duration: 3, audioStart: 2, fadeIn: 0.5, fadeOut: 0 });
        expect(right).toMatchObject({ name: 'take.wav', offset: 6, duration: 5, audioStart: 5, fadeIn: 0, fadeOut: 1.5 });
        expect(old).toMatchObject({ offset: 20, duration: 2, audioStart: 0, fadeIn: 0, fadeOut: 0 });
        // 保存の重複排除 (ハッシュ) がそのまま効く: 分割しても、音声は増えない
        expect(left.audio).toBe(right.audio);
        expect(audio.size).toBe(2);
    });
});

describe('文書を画面に戻す', () => {
    it('範囲とフェードが戻る。保存 → 開く で、同じクリップになる (自動保存と復旧も、この往復)', async () => {
        const track = engine.addTrack('Track 1');
        const buffer = fakeBuffer(10);
        rememberSource(buffer, new Blob(['x'.repeat(1000)]), 'take.wav');
        const edited = setClipFades(trimClipStart({ buffer, offset: 1, name: 'take.wav', duration: 10 }, 3), { fadeIn: 0.5, fadeOut: 1.5 });
        track.clips.push(...splitClip(edited, 6)!);
        const before = track.clips.map(({ buffer: _buffer, ...rest }) => rest);

        const { doc } = await pf.buildDocument(buildInput());
        // sidecar を通ったものとして開く (JSON で往復させ、音声は 10 秒ぶんを返す)
        stubAudio(1000);
        const opened = { ...(JSON.parse(JSON.stringify(doc)) as PF.ProjectDocument), token: 'tok', audioBase: '/api/project/tok/audio/' };
        const out = await pf.applyDocument(opened, applyTarget());
        expect(out).toEqual({ tracks: 1, missingClips: 0 });
        const clips = engine.tracks[0].clips;
        expect(clips.map(({ buffer: _buffer, ...rest }) => rest)).toEqual(before);
        // 開いた後も、2 つは同じ音声を指す (音声は 1 回だけ取ってくる)
        expect(clips[0].buffer).toBe(clips[1].buffer);
        expect(clips[0].buffer.duration).toBe(10);
    });

    it('以前のプロジェクトのクリップ (項目が無い) は、これまでどおり音声の全体を鳴らすクリップになる', async () => {
        stubAudio(300);
        await pf.applyDocument(docWith([
            { name: 'old.wav', offset: 1.5, duration: 3, audio: 'a'.repeat(64) },
            // 長さを持たない (0 の) クリップは、音声の全体
            { name: 'zero.wav', offset: 5, duration: 0, audio: 'a'.repeat(64) },
        ]), applyTarget());
        const [old, zero] = engine.tracks[0].clips;
        // 範囲とフェードの項目は付かない (以前のクリップと、項目の有無まで同じ)
        expect(Object.keys(old).sort()).toEqual(['buffer', 'duration', 'name', 'offset']);
        expect(old).toMatchObject({ offset: 1.5, duration: 3, name: 'old.wav' });
        expect(zero).toMatchObject({ offset: 5, duration: 3 });
    });

    it('範囲が音声の長さを超えていたら、音声に収める。形の違う値は 0 として読む', async () => {
        stubAudio(300);
        await pf.applyDocument(docWith([
            { name: 'long.wav', offset: 0, duration: 9, audio: 'a'.repeat(64), audioStart: 1, fadeIn: 0.5, fadeOut: 8 },
            { name: 'odd.wav', offset: 4, duration: 2, audio: 'a'.repeat(64), audioStart: -3, fadeIn: Number.NaN, fadeOut: 'x' as unknown as number },
        ]), applyTarget());
        const [long, odd] = engine.tracks[0].clips;
        // 音声は 3 秒。1 秒目から鳴らすので、長さは 2 秒まで。フェードは、その中に収まる
        expect(long).toMatchObject({ audioStart: 1, duration: 2, fadeIn: 0.5, fadeOut: 1.5 });
        expect(Object.keys(odd).sort()).toEqual(['buffer', 'duration', 'name', 'offset']);
    });

    it('音声の無いクリップは、範囲とフェードを残したまま、無音の置き場所になる', async () => {
        stubAudio(300);
        const out = await pf.applyDocument(docWith([
            { name: 'lost.wav', offset: 2, duration: 4, audio: null, audioStart: 3, fadeIn: 1, fadeOut: 0 },
        ]), applyTarget());
        expect(out.missingClips).toBe(1);
        const [lost] = engine.tracks[0].clips;
        expect(lost).toMatchObject({ missing: true, offset: 2, duration: 4, audioStart: 3, fadeIn: 1 });
        // 置き場所は、鳴らし始め + 長さ の長さを持つ (範囲が、置き場所の中に収まる)
        expect(lost.buffer.duration).toBeCloseTo(7, 3);
        expect(engine.getTotalDuration()).toBe(6);
    });

    it('同じ音声を指す音声の無いクリップ (分割したもの) は、置き場所を 1 つ共有する (まとめて読み込み直せる)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        const created = vi.spyOn(engine.ctx!, 'createBuffer');
        const out = await pf.applyDocument(docWith([
            { name: 'take.wav', offset: 0, duration: 2, audio: 'b'.repeat(64) },
            { name: 'take.wav', offset: 2, duration: 3, audio: 'b'.repeat(64), audioStart: 2 },
            { name: 'take.wav', offset: 6, duration: 1, audio: 'b'.repeat(64), audioStart: 9 },
            { name: 'other.wav', offset: 0, duration: 1, audio: 'c'.repeat(64) },
        ]), applyTarget());
        expect(out.missingClips).toBe(4);
        const [a, b, c, other] = engine.tracks[0].clips;
        expect(a.buffer).toBe(b.buffer);
        expect(a.buffer).toBe(c.buffer);
        expect(other.buffer).not.toBe(a.buffer);
        // 共有する置き場所は、いちばん後ろまで鳴らすクリップの範囲 (9 + 1 秒) を持つ
        expect(a.buffer.duration).toBeCloseTo(10, 3);
        expect(created).toHaveBeenCalledTimes(2);
        created.mockRestore();
    });

    it('分割したクリップの 1 つで音声を読み込み直すと、同じ音声を指すクリップも一緒に戻る', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        await pf.applyDocument(docWith([
            { name: 'take.wav', offset: 0, duration: 2, audio: 'b'.repeat(64) },
            { name: 'take.wav', offset: 2, duration: 3, audio: 'b'.repeat(64), audioStart: 2 },
            { name: 'other.wav', offset: 6, duration: 1, audio: 'c'.repeat(64) },
        ]), applyTarget());
        const { DawProvider } = await import('../lib/store');
        const MissingAudioBar = (await import('../components/MissingAudioBar')).default;
        render(<DawProvider><MissingAudioBar /></DawProvider>);
        expect(screen.getByRole('region', { name: '音声の無いクリップ' })).toHaveTextContent('音声の無いクリップが 3 個あります');
        const input = screen.getAllByLabelText(/「take\.wav」に読み込む音声のファイル/)[0];
        // 10 秒の音声 (デコードすると、バイト数 ÷ 100 秒)
        fireEvent.change(input, { target: { files: [new File([new Uint8Array(1000)], 'take.wav', { type: 'audio/wav' })] } });
        await screen.findByText(/音声の無いクリップが 1 個あります/);
        const [a, b, other] = engine.tracks[0].clips;
        expect(a.missing).toBeUndefined();
        expect(b.missing).toBeUndefined();
        expect(a.buffer).toBe(b.buffer);
        expect(b).toMatchObject({ offset: 2, duration: 3, audioStart: 2 });
        expect(other.missing).toBe(true);
    });

    it('秒数が極端に大きい (壊れた) クリップがあっても、プロジェクトのほかの部分は開ける', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        expect(pf.MAX_CLIP_SEC).toBe(6 * 60 * 60);
        const doc = docWith([
            { name: 'broken.wav', offset: 1, duration: 1e12, audio: 'd'.repeat(64), audioStart: 1e15, fadeIn: 1e9 },
            { name: 'ok.wav', offset: 0, duration: 2, audio: null, audioStart: 1 },
        ]);
        doc.tracks.push({ ...doc.tracks[0], name: 'Lead', clips: [], notes: [{ note: 'C', octave: 4, step: 0, length: 4 }] });
        const out = await pf.applyDocument(doc, applyTarget());
        expect(out).toEqual({ tracks: 2, missingClips: 2 });
        const [broken, ok] = engine.tracks[0].clips;
        // 上限を超える値は、形の違う値と同じく 0 (無い) として読む
        expect(broken).toMatchObject({ missing: true, offset: 1, duration: 0 });
        expect(broken.audioStart).toBeUndefined();
        expect(broken.fadeIn).toBeUndefined();
        expect(ok).toMatchObject({ missing: true, duration: 2, audioStart: 1 });
        expect(engine.tracks[1].pianoNotes).toHaveLength(1);
    });

    it('置き場所を作れなくても (メモリが足りないなど)、プロジェクトは開ける', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        const original = engine.ctx!.createBuffer.bind(engine.ctx!);
        const created = vi.spyOn(engine.ctx!, 'createBuffer').mockImplementation((ch, length, rate) => {
            if (length > 8000 * 60) throw new RangeError('Array buffer allocation failed');
            return original(ch, length, rate);
        });
        const out = await pf.applyDocument(docWith([
            { name: 'long.wav', offset: 0, duration: 3 * 60 * 60, audio: 'e'.repeat(64) },
        ]), applyTarget());
        expect(out.missingClips).toBe(1);
        expect(engine.tracks[0].clips[0]).toMatchObject({ missing: true, duration: 3 * 60 * 60 });
        created.mockRestore();
    });
});

describe('フェードの長さを秒で決める窓', () => {
    /** 4 秒のクリップ (フェードイン 0.5 秒) を 1 つ置いて、窓を開く。 */
    function open() {
        const track = engine.addTrack('Track 1');
        track.clips.push({ buffer: fakeBuffer(4), offset: 0, name: 'take.wav', duration: 4, fadeIn: 0.5 });
        const setFades = vi.fn(() => true);
        const onClose = vi.fn();
        render(<ClipFadeDialog target={{ trackId: track.id, clipIndex: 0 }} timelineRef={{ current: { container: null, setClipFades: setFades } }} onClose={onClose} />);
        return { track, setFades, onClose };
    }

    it('いまの長さが入っていて、秒を打って決めると、その長さでフェードを付ける', () => {
        const { track, setFades, onClose } = open();
        expect(screen.getByRole('dialog', { name: 'クリップ「take.wav」のフェード' })).toBeInTheDocument();
        const fadeIn = screen.getByLabelText('フェードイン（秒）') as HTMLInputElement;
        const fadeOut = screen.getByLabelText('フェードアウト（秒）') as HTMLInputElement;
        expect([fadeIn.value, fadeOut.value]).toEqual(['0.5', '0']);
        // 開いたとき、最初の欄にフォーカスが在る (キーボードだけで使える)
        expect(document.activeElement).toBe(fadeIn);
        fireEvent.change(fadeIn, { target: { value: '1.25' } });
        fireEvent.change(fadeOut, { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: 'フェードを決める' }));
        expect(setFades).toHaveBeenCalledWith(track.id, 0, { fadeIn: 1.25, fadeOut: 2 });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('合計がクリップの長さを超える・数でない値は、決めずに理由を出す。空の欄は 0 (外す)', () => {
        const { track, setFades, onClose } = open();
        const fadeIn = screen.getByLabelText('フェードイン（秒）'), fadeOut = screen.getByLabelText('フェードアウト（秒）');
        fireEvent.change(fadeIn, { target: { value: '3' } });
        fireEvent.change(fadeOut, { target: { value: '1.5' } });
        fireEvent.click(screen.getByRole('button', { name: 'フェードを決める' }));
        expect(screen.getByRole('alert')).toHaveTextContent('フェードインとフェードアウトを合わせて、クリップの長さ（4 秒）までにしてください');
        expect(setFades).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        // 直すと、理由の文は消える
        fireEvent.change(fadeIn, { target: { value: '' } });
        expect(screen.queryByRole('alert')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'フェードを決める' }));
        expect(setFades).toHaveBeenCalledWith(track.id, 0, { fadeIn: 0, fadeOut: 1.5 });
    });

    it('触っていない欄は送らない (丸めて出した値で、ドラッグで付けた細かいフェードを書き換えない)', () => {
        // 4 秒のクリップを、0.125 秒と 3.875 秒のフェードで埋めている。窓には 0.13 と 3.88 (小数 2 桁) と出る
        const track = engine.addTrack('Track 1');
        track.clips.push({ buffer: fakeBuffer(4), offset: 0, name: 'take.wav', duration: 4, fadeIn: 0.125, fadeOut: 3.875 });
        const setFades = vi.fn(() => true);
        const onClose = vi.fn();
        const view = render(<ClipFadeDialog target={{ trackId: track.id, clipIndex: 0 }} timelineRef={{ current: { container: null, setClipFades: setFades } }} onClose={onClose} />);
        const fadeIn = screen.getByLabelText('フェードイン（秒）') as HTMLInputElement;
        const fadeOut = screen.getByLabelText('フェードアウト（秒）') as HTMLInputElement;
        expect([fadeIn.value, fadeOut.value]).toEqual(['0.13', '3.88']);
        // 何も変えずに決める: 丸めた合計 (4.01 秒) で断らない。何も変えない
        fireEvent.click(screen.getByRole('button', { name: 'フェードを決める' }));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(setFades).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
        view.unmount();

        // フェードインだけ変える: フェードアウトは送らない (3.875 秒のまま)。合計は、元のフェードアウトで確かめる
        render(<ClipFadeDialog target={{ trackId: track.id, clipIndex: 0 }} timelineRef={{ current: { container: null, setClipFades: setFades } }} onClose={onClose} />);
        fireEvent.change(screen.getByLabelText('フェードイン（秒）'), { target: { value: '0.1' } });
        fireEvent.click(screen.getByRole('button', { name: 'フェードを決める' }));
        expect(setFades).toHaveBeenCalledWith(track.id, 0, { fadeIn: 0.1 });
        cleanup();

        // フェードアウトだけ 3.9 秒にすると、元のフェードイン (0.125 秒) と合わせて長さを超えるので断る
        setFades.mockClear();
        render(<ClipFadeDialog target={{ trackId: track.id, clipIndex: 0 }} timelineRef={{ current: { container: null, setClipFades: setFades } }} onClose={onClose} />);
        fireEvent.change(screen.getByLabelText('フェードアウト（秒）'), { target: { value: '3.9' } });
        fireEvent.click(screen.getByRole('button', { name: 'フェードを決める' }));
        expect(screen.getByRole('alert')).toHaveTextContent('クリップの長さ（4 秒）までにしてください');
        expect(setFades).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText('フェードアウト（秒）'), { target: { value: '3.875' } });
        fireEvent.click(screen.getByRole('button', { name: 'フェードを決める' }));
        expect(setFades).toHaveBeenCalledWith(track.id, 0, { fadeOut: 3.875 });
    });

    it('Esc とキャンセルは、何も変えずに閉じる', () => {
        const { setFades, onClose } = open();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(setFades).not.toHaveBeenCalled();
    });
});
