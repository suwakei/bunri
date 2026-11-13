//! テストで使う素材づくりと、音の測り方。
//!
//! 素材はテストの中で作る (正弦波の WAV と、それを A4 に割り当てた SFZ)。数 GB の本物の
//! 楽器はリポジトリに入れられないので使わない。ビット一致は (クリップがそのまま通る場合を
//! 除いて) 求めず、鳴り始めの位置・音の高さ・音量の大小を見る。
#![allow(dead_code)]

use bunri_audio::{AudioData, Engine, EngineConfig, Instrument, Note, RenderOptions, Song, Track};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const SR: u32 = 48_000;
/// engine の中のブロックの長さ。テストでは、この境目に乗らない位置も使う
pub const BLOCK: usize = 256;

/// テストごとの作業ディレクトリ。テストが終わると消える。
pub struct Workdir(PathBuf);

impl Workdir {
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("bunri-audio-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Workdir(dir)
    }

    pub fn path(&self, file: &str) -> PathBuf {
        self.0.join(file)
    }

    /// 正弦波 (`hz`、山の高さ 0.5、モノラル) の WAV と、それを A4 (ノート番号 69) に割り当てた
    /// SFZ を作り、SFZ の場所を返す。`opcodes` は region に足す指定 (例: `ampeg_release=0.5`)。
    /// 指定が無ければ、離したあと 5 ミリ秒で消える。
    pub fn sine_sfz(&self, name: &str, hz: f64, secs: u32, opcodes: &str) -> PathBuf {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SR,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut w = hound::WavWriter::create(self.path(&format!("{name}.wav")), spec).unwrap();
        for v in sine(SR, hz, 0.5, (SR * secs) as usize) {
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
        let release = if opcodes.contains("ampeg_release") {
            ""
        } else {
            "ampeg_release=0.005"
        };
        let sfz = self.path(&format!("{name}.sfz"));
        std::fs::write(
            &sfz,
            format!("<region> sample={name}.wav pitch_keycenter=69 {release} {opcodes}\n"),
        )
        .unwrap();
        sfz
    }

    /// 440Hz・2 秒の、いちばん普通の楽器。
    pub fn a440(&self) -> PathBuf {
        self.sine_sfz("a440", 440.0, 2, "")
    }
}

impl Drop for Workdir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 正弦波 (`amp` は山の高さ)。
pub fn sine(rate: u32, hz: f64, amp: f64, frames: usize) -> Vec<f32> {
    (0..frames)
        .map(|i| (amp * (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin()) as f32)
        .collect()
}

/// 決まった並びの雑音 (-0.5〜0.5)。位置がずれたり左右が入れ替わったりすれば一致しなくなる。
pub fn noise(seed: u32, frames: usize) -> Vec<f32> {
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    (0..frames)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        })
        .collect()
}

pub fn stereo(rate: u32, left: Vec<f32>, right: Vec<f32>) -> Arc<AudioData> {
    Arc::new(AudioData::new(rate, vec![left, right]).unwrap())
}

pub fn mono(rate: u32, samples: Vec<f32>) -> Arc<AudioData> {
    Arc::new(AudioData::new(rate, vec![samples]).unwrap())
}

/// フレームで書いた位置と長さのノート。120 BPM・48kHz では 1 ティック = 25 フレームなので、
/// 25 の倍数で指定する。
pub fn note(start_frame: u64, length_frames: u64, pitch: u8, velocity: u8) -> Note {
    assert!(
        start_frame.is_multiple_of(25) && length_frames.is_multiple_of(25),
        "25 の倍数で"
    );
    Note {
        start: start_frame / 25,
        length: length_frames / 25,
        pitch,
        velocity,
    }
}

/// SFZ の楽器でノートを鳴らすトラック。
pub fn sampler_track(sfz: &Path, notes: Vec<Note>) -> Track {
    Track {
        instrument: Some(Instrument::Sampler { sfz: sfz.into() }),
        notes,
        ..Track::default()
    }
}

/// トラックを並べた曲 (120 BPM、1 小節目は 0 秒)。
pub fn song(tracks: Vec<Track>) -> Song {
    Song {
        tracks,
        ..Song::default()
    }
}

pub fn engine(song: &Song) -> Engine {
    let config = EngineConfig {
        sample_rate: SR,
        max_block: BLOCK,
    };
    Engine::new(song, &config).expect("engine を組み立てられるはず")
}

/// 曲の頭から `frames` フレームを描画する (余韻は足さない)。
pub fn render_frames(song: &Song, frames: u64) -> AudioData {
    let options = RenderOptions {
        end: Some(frames),
        ..RenderOptions::default()
    };
    bunri_audio::render(&mut engine(song), &options)
}

/// 上向きのゼロ交差を数えて、周波数 (Hz) を推定する。
pub fn estimate_hz(x: &[f32]) -> f64 {
    let crossings = x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
    crossings as f64 * SR as f64 / x.len() as f64
}

pub fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}

/// `x` に含まれる `hz` の成分の、山の高さ (ほかの高さの音が混ざっていても、その成分だけを測る)。
pub fn level_at(x: &[f32], hz: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * hz / SR as f64;
    let (mut re, mut im) = (0.0f64, 0.0f64);
    for (i, v) in x.iter().enumerate() {
        re += *v as f64 * (w * i as f64).cos();
        im += *v as f64 * (w * i as f64).sin();
    }
    2.0 * (re * re + im * im).sqrt() / x.len() as f64
}

/// 最初に音が出るフレーム。
pub fn first_sound(x: &[f32]) -> Option<usize> {
    x.iter().position(|v| v.abs() > 1e-6)
}

/// 2 つの並びの、いちばん大きい差。
pub fn max_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "長さが違う");
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f32::max)
}
