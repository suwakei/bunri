//! sfizz を通して、決めた入力に対して音が合っているかを確かめる。
//!
//! 素材はテストの中で作る (440Hz の正弦波の WAV と、それを A4 に割り当てた SFZ)。
//! ビット一致は求めず、鳴り始めの位置・音の高さ・音量の大小を見る。

use bunri_audio::{render_notes, Note, Sampler};
use std::path::{Path, PathBuf};

const SR: u32 = 48_000;
const BLOCK: usize = 256;

/// テストごとの作業ディレクトリに、正弦波の素材と SFZ を作る。SFZ の仮のパスを返す。
fn sine_instrument(name: &str) -> PathBuf {
    sine_instrument_secs(name, 2)
}

/// `sine_instrument` の長さ (秒) を指定できる版。
fn sine_instrument_secs(name: &str, secs: u32) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bunri-audio-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SR,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(dir.join("sine.wav"), spec).unwrap();
    for i in 0..SR * secs {
        let t = i as f32 / SR as f32;
        w.write_sample(0.5 * (2.0 * std::f32::consts::PI * 440.0 * t).sin())
            .unwrap();
    }
    w.finalize().unwrap();
    dir.join("test.sfz")
}

fn load_sine(name: &str) -> Sampler {
    let sfz = sine_instrument(name);
    let mut s = Sampler::new(SR as f32, BLOCK);
    s.load_string(
        &sfz,
        "<region> sample=sine.wav pitch_keycenter=69 ampeg_release=0.005",
    )
    .expect("SFZ を読めるはず");
    s
}

/// 上向きのゼロ交差を数えて、周波数 (Hz) を推定する。
fn estimate_hz(x: &[f32]) -> f64 {
    let crossings = x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
    crossings as f64 * SR as f64 / x.len() as f64
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}

#[test]
fn 無いファイルは読み込みエラーになる() {
    let mut s = Sampler::new(SR as f32, BLOCK);
    assert!(s
        .load_file(Path::new("/nonexistent/bunri/none.sfz"))
        .is_err());
}

#[test]
fn sfzを読むとregionが数えられる() {
    let s = load_sine("regions");
    assert_eq!(s.num_regions(), 1);
}

#[test]
fn 鳴り始めはブロックの途中でも指定したフレームになる() {
    let mut s = load_sine("onset");
    // ブロック (256) の境目に乗らない位置
    let start = 1000;
    let (l, _r) = render_notes(
        &mut s,
        &[Note {
            start,
            length: 4800,
            pitch: 69,
            velocity: 100,
        }],
        8000,
    );
    let first = l
        .iter()
        .position(|v| v.abs() > 1e-6)
        .expect("音が出ていない");
    assert!(first >= start as usize, "指定より早く鳴った: {first}");
    assert!(first < start as usize + 16, "鳴り始めが遅すぎる: {first}");
}

#[test]
fn 音の高さはノート番号に従う() {
    let mut s = load_sine("pitch");
    let notes = [
        Note {
            start: 0,
            length: SR as u64,
            pitch: 69,
            velocity: 100,
        },
        Note {
            start: SR as u64 * 2,
            length: SR as u64,
            pitch: 81,
            velocity: 100,
        },
    ];
    let (l, _r) = render_notes(&mut s, &notes, SR as usize * 3);
    // 立ち上がりを避けて、鳴っている途中の 0.5 秒を測る
    let a4 = estimate_hz(&l[4800..4800 + 24000]);
    let a5 = estimate_hz(&l[96000 + 4800..96000 + 4800 + 24000]);
    assert!((a4 - 440.0).abs() < 3.0, "A4 のはずが {a4:.1}Hz");
    assert!((a5 - 880.0).abs() < 5.0, "A5 のはずが {a5:.1}Hz");
}

#[test]
fn 強く弾くほど大きく鳴る() {
    let measure = |vel: u8, name: &str| {
        let mut s = load_sine(name);
        let (l, _r) = render_notes(
            &mut s,
            &[Note {
                start: 0,
                length: 24000,
                pitch: 69,
                velocity: vel,
            }],
            24000,
        );
        rms(&l[4800..])
    };
    let soft = measure(32, "vel-soft");
    let loud = measure(127, "vel-loud");
    assert!(soft > 0.0);
    assert!(
        loud > soft * 2.0,
        "強さの差が出ていない: soft={soft:.4} loud={loud:.4}"
    );
}

#[test]
fn 同じ高さの連打で次の音が止まらない() {
    let mut s = load_sine("repeat");
    // 1 つめが終わるフレームと 2 つめが始まるフレームが同じ
    let notes = [
        Note {
            start: 0,
            length: 12000,
            pitch: 69,
            velocity: 100,
        },
        Note {
            start: 12000,
            length: 12000,
            pitch: 69,
            velocity: 100,
        },
    ];
    let (l, _r) = render_notes(&mut s, &notes, 30000);
    let second = rms(&l[14000..23000]);
    assert!(second > 0.05, "2 つめの音が鳴っていない: {second:.4}");
    // 2 つめが終わった後は (リリースを過ぎれば) 静かになる
    assert!(rms(&l[26000..]) < 1e-3);
}

#[test]
fn 長さ0のノートは鳴らさない() {
    let mut s = load_sine("zero");
    let (l, _r) = render_notes(
        &mut s,
        &[Note {
            start: 0,
            length: 0,
            pitch: 69,
            velocity: 100,
        }],
        4800,
    );
    assert!(rms(&l) < 1e-6);
}

#[test]
fn 書き出しではサンプルの頭より後ろも欠けない() {
    // 頭だけをメモリに置き (1024 フレーム。1 ブロックより長い必要がある)、続きはディスクから
    // 読ませる。オフライン描画は実時間よりずっと速いので、読み込みを待たないと続きが無音になる
    let sfz = sine_instrument_secs("stream", 20);
    let mut s = Sampler::new(SR as f32, BLOCK);
    s.set_preload_size(1024);
    s.load_string(
        &sfz,
        "<region> sample=sine.wav pitch_keycenter=69 ampeg_release=0.005",
    )
    .unwrap();
    let len = SR as u64 * 18;
    let (l, _r) = render_notes(
        &mut s,
        &[Note {
            start: 0,
            length: len,
            pitch: 69,
            velocity: 100,
        }],
        len as usize,
    );
    // 1 秒ごとに区切って、どの区間も鳴っていること
    for (i, chunk) in l[SR as usize..].chunks(SR as usize).enumerate() {
        let level = rms(chunk);
        assert!(level > 0.05, "{} 秒目が鳴っていない: {level:.4}", i + 1);
    }
}
