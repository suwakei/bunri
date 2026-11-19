//! Rust の engine の音が、画面の Web Audio の書き出し (`web-ui/src/lib/engine.ts` の `mixdown`) と同じになるかを確かめる。
//!
//! 曲は `tests/fixtures/webaudio/song.json` (クリップの鳴らす範囲とフェード・分割した 2 つのクリップ・パン・
//! 小数のステップのドラムのノート)。基準の WAV は `scripts/webaudio-reference.mjs` が、本物の `engine.ts` を
//! WebKit (デスクトップ版の WKWebView と同じ系統) と Chromium (開発用のブラウザ起動) で書き出したもの。
//! デスクトップ版の再生 (Rust) で聴く音と、書き出す音 (Web Audio) が食い違わないことを、ここで押さえる。
//!
//! 仮の音 (三角波) は、画面と消え方が違う (設計書「いまの画面と音が違うところ」) ので、この曲には入れていない。

use bunri_audio::{
    render, AudioData, Clip, DrumVoice, Engine, EngineConfig, Instrument, Note, RenderOptions,
    Song, Track,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/webaudio")
        .join(name)
}

fn spec() -> Value {
    let text = std::fs::read_to_string(fixture("song.json")).expect("song.json を読めない");
    serde_json::from_str(&text).expect("song.json が JSON でない")
}

fn num(v: &Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("{key} が数でない: {v}"))
}

/// 種の決まった雑音 (xorshift32。生成スクリプトと同じ数列)。
fn noise(seed: u32, frames: usize, level: f64) -> Vec<f32> {
    let mut s = seed;
    (0..frames)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            ((s as f64 / u32::MAX as f64 * 2.0 - 1.0) * level) as f32
        })
        .collect()
}

fn channel(c: &Value, frames: usize, rate: f64) -> Vec<f32> {
    let level = num(c, "level");
    if let Some(seed) = c["noise"].as_u64() {
        noise(seed as u32, frames, level)
    } else {
        let hz = num(c, "sineHz");
        (0..frames)
            .map(|i| ((2.0 * std::f64::consts::PI * hz * i as f64 / rate).sin() * level) as f32)
            .collect()
    }
}

/// song.json を、画面の `native-audio.ts` の `buildSong` と同じ形で engine の曲にする。
fn song(spec: &Value) -> (Song, u32) {
    let rate = num(spec, "sampleRate");
    let mut sources = HashMap::new();
    for (name, src) in spec["sources"].as_object().unwrap() {
        let frames = src["frames"].as_u64().unwrap() as usize;
        let channels = ["left", "right"]
            .iter()
            .filter(|k| !src[**k].is_null())
            .map(|k| channel(&src[*k], frames, rate))
            .collect();
        sources.insert(
            name.clone(),
            Arc::new(AudioData::new(rate as u32, channels).unwrap()),
        );
    }
    let kit: Vec<(u8, DrumVoice)> = spec["drumKit"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e[0].as_u64().unwrap() as u8,
                DrumVoice::from_name(e[1].as_str().unwrap()).unwrap(),
            )
        })
        .collect();
    let names = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    let tracks = spec["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let clips = t["clips"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| Clip {
                    audio_start_sec: num(c, "audioStart") / rate,
                    duration_sec: Some(num(c, "duration") / rate),
                    fade_in_sec: num(c, "fadeIn") / rate,
                    fade_out_sec: num(c, "fadeOut") / rate,
                    ..Clip::new(
                        Arc::clone(&sources[c["source"].as_str().unwrap()]),
                        num(c, "offset") / rate,
                    )
                })
                .collect();
            let notes: Vec<Note> = t["notes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| {
                    let index = names
                        .iter()
                        .position(|x| *x == n["note"].as_str().unwrap())
                        .unwrap();
                    let octave = n["octave"].as_u64().unwrap() as usize;
                    Note {
                        // 1/60 ステップ = 4 ティック (画面は step × 240 を丸める)
                        start: n["stepUnits"].as_u64().unwrap() * 4,
                        length: n["lengthUnits"].as_u64().unwrap() * 4,
                        pitch: ((octave + 1) * 12 + index) as u8,
                        velocity: n["velocity"].as_u64().unwrap_or(96) as u8,
                    }
                })
                .collect();
            let drums = t["part"].as_str().is_some_and(|p| p.contains("drum"));
            Track {
                instrument: match (notes.is_empty(), drums) {
                    (true, _) => None,
                    (false, false) => Some(Instrument::Tone),
                    (false, true) => Some(Instrument::ToneDrums { kit: kit.clone() }),
                },
                notes,
                clips,
                gain_db: num(t, "gainDb") as f32,
                pan: num(t, "pan") as f32,
                ..Track::default()
            }
        })
        .collect();
    (
        Song {
            bpm: num(spec, "bpm"),
            offset_sec: num(spec, "gridOffsetFrames") / rate,
            tracks,
            master_gain_db: 0.0,
        },
        rate as u32,
    )
}

fn rust_render() -> AudioData {
    let (song, rate) = song(&spec());
    let config = EngineConfig {
        sample_rate: rate,
        ..EngineConfig::default()
    };
    let mut engine = Engine::new(&song, &config).unwrap();
    render(&mut engine, &RenderOptions::default())
}

/// 2 つの音の差。区間ごとの、いちばん大きい差と、差の二乗平均 (基準の二乗平均に対する比)。
struct Diff {
    max: f32,
    max_at: usize,
    relative_rms: f64,
}

fn diff(ours: &[f32], reference: &[f32]) -> Diff {
    let n = reference.len().min(ours.len());
    let (mut max, mut max_at, mut err, mut energy) = (0f32, 0, 0f64, 0f64);
    for i in 0..n {
        let d = (ours[i] - reference[i]).abs();
        if d > max {
            max = d;
            max_at = i;
        }
        err += (d as f64).powi(2);
        energy += (reference[i] as f64).powi(2);
    }
    Diff {
        max,
        max_at,
        relative_rms: (err / energy.max(1e-12)).sqrt(),
    }
}

/// クリップの終わりのフレーム (曲の中の位置)。
fn clip_ends(spec: &Value) -> Vec<usize> {
    spec["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| t["clips"].as_array().unwrap().iter())
        .map(|c| (num(c, "offset") + num(c, "duration")) as usize)
        .collect()
}

/// `skip` のフレームを 0 にした写し (比べないフレーム)。
fn without(samples: &[f32], skip: &[usize]) -> Vec<f32> {
    let mut out = samples.to_vec();
    for &i in skip.iter().filter(|i| **i < samples.len()) {
        out[i] = 0.0;
    }
    out
}

fn check(browser: &str, skip: &[usize]) {
    let reference = AudioData::from_wav_file(&fixture(&format!("{browser}.wav")))
        .unwrap_or_else(|e| panic!("{browser}.wav を読めない: {e}"));
    let ours = rust_render();
    assert_eq!(reference.sample_rate(), ours.sample_rate());
    // Web Audio は曲の終わり (いちばん後ろのクリップかノートの終わり) で切る。Rust は余韻まで描くので、長さは同じか長い
    assert!(
        ours.frames() >= reference.frames(),
        "{browser}: Rust の描画が短い"
    );
    for (side, (o, r)) in [
        ("左", (ours.left(), reference.left())),
        ("右", (ours.right(), reference.right())),
    ] {
        let d = diff(&without(o, skip), &without(r, skip));
        eprintln!(
            "{browser} {side}: 最大の差 {:.5} ({} フレーム目)、差の二乗平均 {:.4}%",
            d.max,
            d.max_at,
            d.relative_rms * 100.0
        );
        // 基準は 16bit (量子化の差は 1/32768 ≒ 0.00003)。ドラムのサイン波とフィルタは、ブラウザごとの作り
        // (波形の表の補間・自動化の計算の精度) の違いが少し出るので、そのぶんを許す
        assert!(
            d.max < MAX_DIFF,
            "{browser} {side}: 最大の差 {} ({} フレーム目) が大きすぎる",
            d.max,
            d.max_at
        );
        assert!(
            d.relative_rms < MAX_RELATIVE_RMS,
            "{browser} {side}: 差の二乗平均 {:.4}% が大きすぎる",
            d.relative_rms * 100.0
        );
    }
}

/// 許す差。いちばん大きい音 (キックの山) は 0.75 ほど。
const MAX_DIFF: f32 = 0.01;
const MAX_RELATIVE_RMS: f64 = 0.01;

#[test]
fn webkit_の書き出しと同じ音になる() {
    // デスクトップ版の書き出しは WKWebView (WebKit) が行う。すべてのフレームを比べる
    check("webkit", &[]);
}

#[test]
fn chromium_の書き出しと同じ音になる() {
    // Chromium は、鳴らす長さ (秒) をフレームにするときの丸めで、クリップの終わりに 1 フレーム多く鳴らすことが在る
    // (この曲では、0.3 秒のクリップの終わりの 24255 フレーム目。WebKit と Rust は鳴らさない)。そこは比べない
    check("chromium", &clip_ends(&spec()));
}

#[test]
fn クリップの範囲とフェードはサンプル単位で画面の式どおり() {
    // 1 本目のトラック (分割した 2 つのステレオのクリップ。音量 -3dB、パンは中央) だけを描き、
    // すべてのフレームを、画面の lib/clip.ts の式 (鳴らす範囲 × 直線のフェード) で作った値と比べる
    let spec = spec();
    let (mut song, rate) = song(&spec);
    song.tracks.truncate(1);
    let config = EngineConfig {
        sample_rate: rate,
        ..EngineConfig::default()
    };
    let mut engine = Engine::new(&song, &config).unwrap();
    let out = render(&mut engine, &RenderOptions::default());
    let g = 10f32.powf(-3.0 / 20.0);
    let mut expected_l = vec![0f32; out.frames()];
    let mut expected_r = vec![0f32; out.frames()];
    for (clip, c) in song.tracks[0]
        .clips
        .iter()
        .zip(spec["tracks"][0]["clips"].as_array().unwrap())
    {
        let (offset, start, duration) = (
            num(c, "offset") as usize,
            num(c, "audioStart") as usize,
            num(c, "duration") as usize,
        );
        let f = 1.0 / rate as f64;
        let (length, fade_in, fade_out) = (
            duration as f64 * f,
            num(c, "fadeIn") * f,
            num(c, "fadeOut") * f,
        );
        for k in 0..duration {
            // 画面の fadeGain
            let t = k as f64 * f;
            let mut gain = 1.0f64;
            if fade_in > 0.0 && t < fade_in {
                gain = t / fade_in;
            }
            if fade_out > 0.0 && t > length - fade_out {
                gain = gain.min((length - t) / fade_out);
            }
            expected_l[offset + k] += clip.audio.left()[start + k] * gain as f32 * g;
            expected_r[offset + k] += clip.audio.right()[start + k] * gain as f32 * g;
        }
    }
    let (dl, dr) = (
        diff(out.left(), &expected_l),
        diff(out.right(), &expected_r),
    );
    assert!(dl.max < 1e-6, "左: {} ({} フレーム目)", dl.max, dl.max_at);
    assert!(dr.max < 1e-6, "右: {} ({} フレーム目)", dr.max, dr.max_at);
    // 2 つのクリップのあいだ (1 つめの終わり 22050 〜 2 つめの頭 26460) は鳴らない
    assert!(out.left()[22050..26460].iter().all(|v| *v == 0.0));
}
