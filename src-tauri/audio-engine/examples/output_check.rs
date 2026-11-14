//! 既定の出力デバイスを実際に開いて、transport を数秒回す。**音は出さない** (作った音に 0 を掛けてから
//! デバイスへ渡す)。
//!
//! 本物のデバイスにつないだときに、コールバックのバッファの長さ・1 回あたりの処理時間・位置が
//! 実時間どおりに進むか・エラーの有無を見るためのもの。
//!
//! ```sh
//! cargo run --release -p bunri-audio --example output_check        # 3 秒
//! cargo run --release -p bunri-audio --example output_check -- 10  # 10 秒
//! ```

use bunri_audio::output::OutputDevice;
use bunri_audio::{
    transport, AudioData, Clip, Engine, EngineConfig, Grid, Instrument, Note, PlayOptions, Song,
    Track, TICKS_PER_BEAT,
};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// デバイスへ渡す前に掛ける値。0 なので、スピーカーからは何も聞こえない。
const OUTPUT_GAIN: f32 = 0.0;

/// コールバックの中から書く記録 (ロック無し)。
#[derive(Default)]
struct Measured {
    /// `Transport::process` にかかった時間の最大と合計 (ナノ秒)
    max_nanos: AtomicU64,
    total_nanos: AtomicU64,
    /// 作った音の山の高さ (0 を掛ける前) と、デバイスへ渡した音の山の高さ (f32 のビット)
    made_peak: AtomicU32,
    sent_peak: AtomicU32,
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0, |m, v| m.max(v.abs()))
}

fn store_max(cell: &AtomicU32, value: f32) {
    if value > f32::from_bits(cell.load(Ordering::Relaxed)) {
        cell.store(value.to_bits(), Ordering::Relaxed);
    }
}

/// 鳴らす曲: 4 分音符の和音 (仮の音) を 4 小節と、雑音のクリップ (ステレオ) を 1 本。
fn demo_song(sample_rate: u32, secs: usize) -> Song {
    let notes = (0..16u64)
        .flat_map(|beat| {
            [60u8, 64, 67, 72].map(|pitch| Note {
                start: beat * TICKS_PER_BEAT,
                length: TICKS_PER_BEAT * 3 / 4,
                pitch,
                velocity: 96,
            })
        })
        .collect();
    let frames = sample_rate as usize * secs;
    let noise = |seed: u32| {
        let mut state = seed;
        (0..frames)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.2
            })
            .collect::<Vec<f32>>()
    };
    let audio = AudioData::new(sample_rate, vec![noise(1), noise(2)]).expect("音声を作れるはず");
    Song {
        tracks: vec![
            Track {
                instrument: Some(Instrument::Tone),
                notes,
                ..Track::default()
            },
            Track {
                clips: vec![Clip {
                    audio: Arc::new(audio),
                    start_sec: 0.0,
                }],
                gain_db: -6.0,
                pan: 0.2,
                ..Track::default()
            },
        ],
        ..Song::default()
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let secs: u64 = match std::env::args().nth(1) {
        Some(arg) => arg.parse()?,
        None => 3,
    };

    let opening = Instant::now();
    let device = match OutputDevice::open_default() {
        Ok(device) => device,
        Err(error) => {
            println!("出力デバイスを開けない: {error}");
            return Ok(());
        }
    };
    let rate = device.sample_rate();
    println!(
        "デバイス: {:?} / {}Hz / {} チャンネル / {}",
        device.name(),
        rate,
        device.channels(),
        device.sample_format()
    );

    let (mut controller, mut transport) = transport(rate)?;
    let config = EngineConfig {
        sample_rate: rate,
        ..EngineConfig::default()
    };
    let engine = Engine::new(&demo_song(rate, secs as usize + 2), &config)?;
    controller.set_song(Box::new(engine), &Grid::default())?;

    let measured = Arc::new(Measured::default());
    let record = Arc::clone(&measured);
    let output = device.start(move |left, right| {
        let started = Instant::now();
        transport.process(left, right);
        let nanos = started.elapsed().as_nanos() as u64;
        record.max_nanos.fetch_max(nanos, Ordering::Relaxed);
        record.total_nanos.fetch_add(nanos, Ordering::Relaxed);
        store_max(&record.made_peak, peak(left).max(peak(right)));
        // 音を出さない: 0 を掛けてから渡す
        for v in left.iter_mut().chain(right.iter_mut()) {
            *v *= OUTPUT_GAIN;
        }
        store_max(&record.sent_peak, peak(left).max(peak(right)));
    })?;
    println!(
        "開くのにかかった時間: {:.0} ms / 頼んだバッファ: {} / 遅れの見積もり: {:.1} ms",
        opening.elapsed().as_secs_f64() * 1e3,
        match output.requested_buffer_frames() {
            Some(frames) => format!("{frames} フレーム"),
            None => "デバイスの既定".into(),
        },
        output.latency_sec() * 1e3
    );

    // メトロノーム付きで再生し、鍵盤の試聴も 1 音押しておく
    controller.live_note_on(76, 100)?;
    controller.play(&PlayOptions {
        token: 1,
        metronome: true,
        ..PlayOptions::default()
    })?;

    // 再生が始まったブロックを待ってから、位置が実時間どおりに進むかを見る
    let deadline = Instant::now() + Duration::from_secs(2);
    let first = loop {
        let position = controller.position();
        if position.playing && position.frame > 0 {
            break position;
        }
        if Instant::now() > deadline {
            println!("再生が始まらなかった (コールバックが呼ばれていない)");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    let mut worst_drift_ms = 0f64;
    let end = Instant::now() + Duration::from_secs(secs);
    let mut last = first;
    while Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
        let position = controller.position();
        // ブロックの頭の位置と、そのブロックを作り始めた時刻の組。時刻の進みと位置の進みを比べる
        let by_clock = position.at.duration_since(first.at).as_secs_f64();
        let by_frames = (position.frame - first.frame) as f64 / rate as f64;
        worst_drift_ms = worst_drift_ms.max((by_frames - by_clock).abs() * 1e3);
        last = position;
    }
    controller.live_note_off(76)?;
    controller.stop()?;
    std::thread::sleep(Duration::from_millis(100));
    let stopped = controller.position();

    let stats = output.stats();
    let by_clock = last.at.duration_since(first.at).as_secs_f64();
    let by_frames = (last.frame - first.frame) as f64 / rate as f64;
    let period_ms = stats.max_buffer as f64 / rate as f64 * 1e3;
    let max_ms = measured.max_nanos.load(Ordering::Relaxed) as f64 / 1e6;
    let mean_ms =
        measured.total_nanos.load(Ordering::Relaxed) as f64 / 1e6 / stats.callbacks.max(1) as f64;
    println!(
        "コールバック: {} 回 / バッファ {}〜{} フレーム ({:.2} ms)",
        stats.callbacks, stats.min_buffer, stats.max_buffer, period_ms
    );
    println!(
        "処理時間: 最大 {:.3} ms (持ち時間の {:.1}%) / 平均 {:.3} ms ({:.1}%)",
        max_ms,
        max_ms / period_ms * 100.0,
        mean_ms,
        mean_ms / period_ms * 100.0
    );
    println!(
        "位置の進み: {:.4} 秒 (時計では {:.4} 秒。差 {:+.2} ms、途中の最大 {:.2} ms)",
        by_frames,
        by_clock,
        (by_frames - by_clock) * 1e3,
        worst_drift_ms
    );
    println!(
        "止めたあと: 再生中 = {} / 位置 {:.3} 秒",
        stopped.playing, stopped.position_sec
    );
    println!(
        "デバイスの知らせ: 途切れ {} 回 / そのほか {} 回 / 最後 {:?} / 開き直しが要る = {}",
        stats.xruns,
        stats.issues - stats.xruns,
        stats.last_issue,
        output.is_broken()
    );
    println!(
        "作った音の山の高さ: {:.3} / デバイスへ渡した音の山の高さ: {} (0 なら無音)",
        f32::from_bits(measured.made_peak.load(Ordering::Relaxed)),
        f32::from_bits(measured.sent_peak.load(Ordering::Relaxed))
    );
    drop(output);
    println!("古い engine の回収: {} 個", controller.collect_garbage());
    Ok(())
}
