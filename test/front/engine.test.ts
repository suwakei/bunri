/**
 * AudioEngine ユニットテスト
 * WebAudio API はブラウザ依存のため、ロジック部分を中心にテスト
 */
import { describe, it, expect, beforeEach } from 'vitest';

// engine.ts はブラウザの AudioContext に依存するため、
// モジュールレベルのインスタンス生成前に AudioContext をモック
class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    connect() { return this; }
    disconnect() {}
}

class MockStereoPannerNode {
    pan = { value: 0 };
    connect() { return this; }
    disconnect() {}
}

class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return new MockStereoPannerNode() as unknown as StereoPannerNode; }
    createOscillator() {
        return {
            type: 'sine', frequency: { value: 440 },
            connect: () => {}, start: () => {}, stop: () => {},
        };
    }
    createBufferSource() {
        return {
            buffer: null, connect: () => {}, start: () => {}, stop: () => {},
        };
    }
    async decodeAudioData(_buf: ArrayBuffer) {
        return { duration: 1, numberOfChannels: 2, sampleRate: 44100, length: 44100, getChannelData: () => new Float32Array(44100) } as unknown as AudioBuffer;
    }
}

// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

// engine モジュールをインポート（モック後）
const { default: engine } = await import('../../web-ui/src/lib/engine');

describe('AudioEngine', () => {
    beforeEach(() => {
        // テストごとにエンジンをリセット
        engine.tracks = [];
        engine.isPlaying = false;
        engine.isRecording = false;
        engine.playOffset = 0;
        engine.bpm = 120;
        engine.beatsPerBar = 4;
        engine.activeSources = [];
        engine.soloTrackId = null;
    });

    describe('init', () => {
        it('AudioContext を作成する', () => {
            engine.ctx = null;
            engine.masterGain = null;
            engine.init();
            expect(engine.ctx).not.toBeNull();
            expect(engine.masterGain).not.toBeNull();
        });

        it('二重初期化しない', () => {
            engine.init();
            const ctx = engine.ctx;
            engine.init();
            expect(engine.ctx).toBe(ctx);
        });
    });

    describe('addTrack', () => {
        it('トラックを追加して返す', () => {
            engine.init();
            const track = engine.addTrack('Test Track');
            expect(track.name).toBe('Test Track');
            expect(track.id).toBeGreaterThan(0);
            expect(track.clips).toEqual([]);
            expect(track.pianoNotes).toEqual([]);
            expect(track.gain).toBe(0);
            expect(track.pan).toBe(0);
            expect(track.mute).toBe(false);
            expect(track.solo).toBe(false);
        });

        it('名前省略時はデフォルト名', () => {
            engine.init();
            const t = engine.addTrack();
            expect(t.name).toMatch(/^Track \d+$/);
        });

        it('複数トラックのID は一意', () => {
            engine.init();
            const t1 = engine.addTrack('A');
            const t2 = engine.addTrack('B');
            expect(t1.id).not.toBe(t2.id);
            expect(engine.tracks.length).toBe(2);
        });
    });

    describe('removeTrack', () => {
        it('指定IDのトラックを削除', () => {
            engine.init();
            const t1 = engine.addTrack('A');
            engine.addTrack('B');
            engine.removeTrack(t1.id);
            expect(engine.tracks.length).toBe(1);
            expect(engine.tracks[0].name).toBe('B');
        });

        it('存在しないIDでもエラーにならない', () => {
            engine.init();
            engine.addTrack('A');
            engine.removeTrack(9999);
            expect(engine.tracks.length).toBe(1);
        });
    });

    describe('getTrack', () => {
        it('IDでトラックを取得', () => {
            engine.init();
            const t = engine.addTrack('Target');
            const found = engine.getTrack(t.id);
            expect(found).toBeDefined();
            expect(found!.name).toBe('Target');
        });

        it('存在しないIDはundefined', () => {
            expect(engine.getTrack(9999)).toBeUndefined();
        });
    });

    describe('toggleMute', () => {
        it('ミュートのトグル', () => {
            engine.init();
            const t = engine.addTrack('T');
            expect(t.mute).toBe(false);
            engine.toggleMute(t.id);
            expect(t.mute).toBe(true);
            engine.toggleMute(t.id);
            expect(t.mute).toBe(false);
        });
    });

    describe('クリップ管理', () => {
        it('addClipFromBuffer でクリップ追加', async () => {
            engine.init();
            const t = engine.addTrack('T');
            const mockBuffer = { duration: 2.5 } as AudioBuffer;
            const clip = await engine.addClipFromBuffer(t.id, mockBuffer, 'test-clip', 1.0);
            expect(clip).toBeDefined();
            expect(clip!.name).toBe('test-clip');
            expect(clip!.offset).toBe(1.0);
            expect(clip!.duration).toBe(2.5);
            expect(t.clips.length).toBe(1);
        });

        it('moveClip でオフセット変更', async () => {
            engine.init();
            const t = engine.addTrack('T');
            await engine.addClipFromBuffer(t.id, { duration: 1 } as AudioBuffer, 'c');
            engine.moveClip(t.id, 0, 5.0);
            expect(t.clips[0].offset).toBe(5.0);
        });

        it('moveClip で負の値は0にクランプ', async () => {
            engine.init();
            const t = engine.addTrack('T');
            await engine.addClipFromBuffer(t.id, { duration: 1 } as AudioBuffer, 'c');
            engine.moveClip(t.id, 0, -3);
            expect(t.clips[0].offset).toBe(0);
        });

        it('removeClip でクリップ削除', async () => {
            engine.init();
            const t = engine.addTrack('T');
            await engine.addClipFromBuffer(t.id, { duration: 1 } as AudioBuffer, 'c1');
            await engine.addClipFromBuffer(t.id, { duration: 2 } as AudioBuffer, 'c2');
            engine.removeClip(t.id, 0);
            expect(t.clips.length).toBe(1);
            expect(t.clips[0].name).toBe('c2');
        });
    });

    describe('再生時間計算', () => {
        it('クリップなし → duration 0', () => {
            expect(engine.getTotalDuration()).toBe(0);
        });

        it('クリップあり → 正しい duration', async () => {
            engine.init();
            const t = engine.addTrack('T');
            await engine.addClipFromBuffer(t.id, { duration: 3 } as AudioBuffer, 'c', 2.0);
            expect(engine.getTotalDuration()).toBe(5.0); // offset 2 + duration 3
        });

        it('ピアノノートを含む duration', () => {
            engine.init();
            const t = engine.addTrack('T');
            t.pianoNotes = [{ note: 'C', octave: 4, step: 0, length: 16 }];
            // step 0, length 16 → 16 * (60/120/4) = 16 * 0.125 = 2.0秒
            expect(engine.getTotalDuration()).toBe(2.0);
        });
    });

    describe('getCurrentTime', () => {
        it('停止中は playOffset を返す', () => {
            engine.isPlaying = false;
            engine.playOffset = 3.5;
            expect(engine.getCurrentTime()).toBe(3.5);
        });
    });

    describe('play / stop / pause', () => {
        it('play で isPlaying = true', () => {
            engine.init();
            engine.play();
            expect(engine.isPlaying).toBe(true);
        });

        it('stop で isPlaying = false, playOffset = 0', () => {
            engine.init();
            engine.play();
            engine.stop();
            expect(engine.isPlaying).toBe(false);
            expect(engine.playOffset).toBe(0);
        });

        it('pause で isPlaying = false, playOffset 保持', () => {
            engine.init();
            engine.playOffset = 5;
            engine.play();
            engine.pause();
            expect(engine.isPlaying).toBe(false);
            expect(engine.playOffset).toBeGreaterThanOrEqual(5);
        });
    });
});

describe('NOTE_FREQ', () => {
    it('A4 = 440Hz', async () => {
        const { NOTE_FREQ } = await import('../../web-ui/src/lib/engine');
        expect(NOTE_FREQ['A4']).toBeCloseTo(440, 1);
    });

    it('C4 ≈ 261.63Hz', async () => {
        const { NOTE_FREQ } = await import('../../web-ui/src/lib/engine');
        expect(NOTE_FREQ['C4']).toBeCloseTo(261.63, 0);
    });
});
