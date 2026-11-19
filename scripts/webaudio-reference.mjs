#!/usr/bin/env node
/**
 * Web Audio の書き出し（`web-ui/src/lib/engine.ts` の `mixdown`）で、決まった曲を WAV にする。
 * Rust の engine の音が、画面の書き出しと同じになっているかを確かめる基準を作る
 * （`src-tauri/audio-engine/tests/webaudio_parity.rs` が、ここで作った WAV と Rust の描画を比べる）。
 *
 * 曲は `src-tauri/audio-engine/tests/fixtures/webaudio/song.json`。クリップの鳴らす範囲とフェード、
 * 小数のステップのノート、ドラムの音を含む。本物の `engine.ts` をそのまま束ねて、Playwright の
 * WebKit（デスクトップ版の WKWebView と同じ系統）と Chromium（開発用のブラウザ起動）の中で書き出す。
 * サーバは立てない（空のページに束ねたスクリプトを入れるだけ）。
 *
 * 使い方（`web-ui/node_modules` に Playwright のブラウザが要る）:
 *   node scripts/webaudio-reference.mjs
 * 書き出した WAV（16bit）は `tests/fixtures/webaudio/{webkit,chromium}.wav`。ドラムの音・クリップの決まり・
 * 曲を変えたら作り直して、一緒に commit する。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webUi = path.join(root, 'web-ui');
const fixtures = path.join(root, 'src-tauri', 'audio-engine', 'tests', 'fixtures', 'webaudio');
const require = createRequire(path.join(webUi, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const playwrightModule = await import(pathToFileURL(require.resolve("playwright")).href);
const playwright = playwrightModule.default ?? playwrightModule;

const spec = JSON.parse(fs.readFileSync(path.join(fixtures, 'song.json'), 'utf8'));

/** 本物の engine.ts を束ねた、ページに入れるスクリプト（`window.BunriParity.render(spec)`）。 */
async function bundle() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunri-parity-'));
    const entry = path.join(dir, 'entry.ts');
    const lib = (name) => JSON.stringify(path.join(webUi, 'src', 'lib', name));
    fs.writeFileSync(entry, `
import engine from ${lib('engine.ts')};
import { DRUM_ROWS } from ${lib('drums.ts')};

/** 種の決まった雑音 (xorshift32。Rust の側のテストと同じ数列)。 */
function noise(seed: number, frames: number, level: number): Float32Array {
    const out = new Float32Array(frames);
    let s = seed >>> 0;
    for (let i = 0; i < frames; i++) {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        out[i] = ((s / 0xffffffff) * 2 - 1) * level;
    }
    return out;
}

function sine(hz: number, frames: number, rate: number, level: number): Float32Array {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) out[i] = Math.sin(2 * Math.PI * hz * i / rate) * level;
    return out;
}

function channel(c: any, frames: number, rate: number): Float32Array {
    return c.noise !== undefined ? noise(c.noise, frames, c.level) : sine(c.sineHz, frames, rate, c.level);
}

export async function render(spec: any): Promise<{ left: number[]; right: number[]; sampleRate: number }> {
    const kit = DRUM_ROWS.map((row) => [row.pitch, row.voice]);
    if (JSON.stringify(kit) !== JSON.stringify(spec.drumKit)) throw new Error('song.json の drumKit が DRUM_ROWS と違う: ' + JSON.stringify(kit));
    engine.init();
    const ctx = engine.ctx!;
    const rate = spec.sampleRate;
    const sources: Record<string, AudioBuffer> = {};
    for (const [name, src] of Object.entries<any>(spec.sources)) {
        const chans = [src.left, src.right].filter(Boolean);
        const buffer = ctx.createBuffer(chans.length, src.frames, rate);
        chans.forEach((c, i) => buffer.copyToChannel(channel(c, src.frames, rate), i));
        sources[name] = buffer;
    }
    engine.tracks = [];
    engine.bpm = spec.bpm;
    engine.beatsPerBar = 4;
    engine.gridOffset = spec.gridOffsetFrames / rate;
    for (const t of spec.tracks) {
        const track = engine.addTrack(t.name);
        engine.updateTrackGain(track.id, t.gainDb);
        engine.updateTrackPan(track.id, t.pan);
        if (t.part) { track.role = 'part'; track.part = t.part; }
        for (const c of t.clips) {
            track.clips.push({
                buffer: sources[c.source], name: c.source, offset: c.offset / rate, duration: c.duration / rate,
                audioStart: c.audioStart / rate, fadeIn: c.fadeIn / rate, fadeOut: c.fadeOut / rate,
            });
        }
        track.pianoNotes = t.notes.map((n: any) => {
            const note: any = { note: n.note, octave: n.octave, step: n.stepUnits / 60, length: n.lengthUnits / 60 };
            if (n.velocity !== undefined) note.velocity = n.velocity;
            return note;
        });
    }
    const out = await engine.mixdown();
    if (!out || out.sampleRate !== rate) throw new Error('書き出せなかった');
    return { left: Array.from(out.getChannelData(0)), right: Array.from(out.getChannelData(1)), sampleRate: out.sampleRate };
}
`);
    const result = await build({
        root: webUi, configFile: false, logLevel: 'silent',
        build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'BunriParity', fileName: 'parity' } },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
    const chunk = outputs.find((o) => o.type === 'chunk');
    if (!chunk) throw new Error('束ねられなかった');
    return chunk.code;
}

/** 16bit の WAV（ステレオ）にする。 */
function wav16(left, right, sampleRate) {
    const frames = left.length;
    const data = Buffer.alloc(frames * 4);
    const pcm = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    for (let i = 0; i < frames; i++) {
        data.writeInt16LE(pcm(left[i]), i * 4);
        data.writeInt16LE(pcm(right[i]), i * 4 + 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

const code = await bundle();
for (const name of ['webkit', 'chromium']) {
    const browser = await playwright[name].launch();
    try {
        const page = await browser.newPage();
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ content: code });
        const out = await page.evaluate((s) => window.BunriParity.render(s), spec);
        const file = path.join(fixtures, `${name}.wav`);
        fs.writeFileSync(file, wav16(out.left, out.right, out.sampleRate));
        console.log(`${name} ${browser.version()}: ${out.left.length} フレーム → ${path.relative(root, file)}`);
    } finally {
        await browser.close();
    }
}
