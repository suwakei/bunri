//! SFZ の楽器を読み込み、決まったフレーズを engine で WAV に書き出す (素材の評価用)。
//!
//! ```sh
//! cargo run --release -p bunri-audio --example render_sfz -- <楽器.sfz> <出力.wav> [重ねる音声.wav]
//! /usr/bin/time -l cargo run ...   # メモリ (maximum resident set size) も見るとき
//! ```
//!
//! フレーズ: 弱いドミソ → 強いドミソ → 低音 → 高音の連打 (強さを上げていく)。
//! 3 つめの引数に WAV を渡すと、別のトラックのクリップとして頭から重ねる
//! (周波数が違えば engine の周波数に変換される)。
use bunri_audio::{
    AudioData, Clip, Engine, EngineConfig, Instrument, Note, RenderOptions, Song, Track, WavFormat,
    TICKS_PER_BEAT,
};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

/// フレーズのテンポ。120 BPM では 1 秒 = 2 拍
const BPM: f64 = 120.0;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(sfz), Some(out)) = (args.get(1), args.get(2)) else {
        eprintln!("使い方: render_sfz <楽器.sfz> <出力.wav> [重ねる音声.wav]");
        std::process::exit(2);
    };
    let fail = |e: &dyn std::fmt::Display| -> ! {
        eprintln!("{e}");
        std::process::exit(1);
    };

    let ticks = |sec: f64| (sec * BPM / 60.0 * TICKS_PER_BEAT as f64).round() as u64;
    let mut notes = Vec::new();
    for (at, velocity) in [(0.0, 30u8), (2.0, 120)] {
        for pitch in [60u8, 64, 67] {
            notes.push(Note {
                start: ticks(at),
                length: ticks(1.5),
                pitch,
                velocity,
            });
        }
    }
    notes.push(Note {
        start: ticks(4.0),
        length: ticks(2.0),
        pitch: 33,
        velocity: 90,
    });
    for (i, velocity) in [50u8, 70, 90, 110].into_iter().enumerate() {
        notes.push(Note {
            start: ticks(4.5 + 0.25 * i as f64),
            length: ticks(0.2),
            pitch: 84,
            velocity,
        });
    }

    let mut tracks = vec![Track {
        instrument: Some(Instrument::Sampler { sfz: sfz.into() }),
        notes,
        ..Track::default()
    }];
    if let Some(clip) = args.get(3) {
        let audio = AudioData::from_wav_file(Path::new(clip)).unwrap_or_else(|e| fail(&e));
        tracks.push(Track {
            clips: vec![Clip {
                audio: Arc::new(audio),
                start_sec: 0.0,
            }],
            ..Track::default()
        });
    }
    let song = Song {
        bpm: BPM,
        tracks,
        ..Song::default()
    };

    let config = EngineConfig::default();
    let t = Instant::now();
    let mut engine = Engine::new(&song, &config).unwrap_or_else(|e| fail(&e));
    println!(
        "組み立て (楽器の読み込みとクリップの変換): {:.2} 秒",
        t.elapsed().as_secs_f64()
    );

    let t = Instant::now();
    let audio = bunri_audio::render(&mut engine, &RenderOptions::default());
    let cpu = t.elapsed().as_secs_f64();
    let secs = audio.frames() as f64 / audio.sample_rate() as f64;
    let peak = audio
        .left()
        .iter()
        .chain(audio.right())
        .fold(0f32, |m, v| m.max(v.abs()));
    println!(
        "描画: 音 {secs:.1} 秒 (余韻を含む) を {cpu:.3} 秒で (実時間の {:.0} 倍)、ピーク {peak:.3}",
        secs / cpu
    );

    audio
        .write_wav_file(Path::new(out), WavFormat::Float32)
        .unwrap_or_else(|e| fail(&e));
    println!("書き出し: {out}");
}
