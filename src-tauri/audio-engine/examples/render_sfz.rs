//! SFZ の楽器を読み込み、決まったフレーズを WAV に書き出す (素材の評価用)。
//!
//! ```sh
//! cargo run --release -p bunri-audio --example render_sfz -- <楽器.sfz> <出力.wav>
//! /usr/bin/time -l cargo run ...   # メモリ (maximum resident set size) も見るとき
//! ```
//!
//! フレーズ: 弱いドミソ → 強いドミソ → 低音 → 高音の連打 (強さを上げていく)。
use bunri_audio::{render_notes, Note, Sampler};
use std::path::Path;
use std::time::Instant;

const SR: u32 = 48_000;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(sfz), Some(out)) = (args.get(1), args.get(2)) else {
        eprintln!("使い方: render_sfz <楽器.sfz> <出力.wav>");
        std::process::exit(2);
    };

    let mut s = Sampler::new(SR as f32, 512);
    let t = Instant::now();
    if let Err(e) = s.load_file(Path::new(sfz)) {
        eprintln!("{e}");
        std::process::exit(1);
    }
    println!(
        "読み込み: {:.2} 秒、region {}、頭を持つサンプル {}",
        t.elapsed().as_secs_f64(),
        s.num_regions(),
        s.preloaded_samples()
    );

    let sec = |x: f64| (x * SR as f64) as u64;
    let mut notes = Vec::new();
    for (at, vel) in [(0.0, 30u8), (2.0, 120)] {
        for p in [60u8, 64, 67] {
            notes.push(Note {
                start: sec(at),
                length: sec(1.5),
                pitch: p,
                velocity: vel,
            });
        }
    }
    notes.push(Note {
        start: sec(4.0),
        length: sec(2.0),
        pitch: 33,
        velocity: 90,
    });
    for (i, vel) in [50u8, 70, 90, 110].into_iter().enumerate() {
        notes.push(Note {
            start: sec(4.5 + 0.25 * i as f64),
            length: sec(0.2),
            pitch: 84,
            velocity: vel,
        });
    }

    let total = sec(8.0) as usize;
    let t = Instant::now();
    let (l, r) = render_notes(&mut s, &notes, total);
    let cpu = t.elapsed().as_secs_f64();
    let peak = l.iter().chain(r.iter()).fold(0f32, |m, v| m.max(v.abs()));
    println!(
        "描画: 音 8.0 秒を {cpu:.3} 秒で (実時間の {:.0} 倍)、ピーク {peak:.3}",
        8.0 / cpu
    );

    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: SR,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(out, spec).expect("WAV を作れない");
    for (a, b) in l.iter().zip(r.iter()) {
        w.write_sample(*a).unwrap();
        w.write_sample(*b).unwrap();
    }
    w.finalize().unwrap();
    println!("書き出し: {out}");
}
