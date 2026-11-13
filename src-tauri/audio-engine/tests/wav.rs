//! WAV の読み書きと、曲を WAV に書き出すところまでを確かめる。

mod common;

use bunri_audio::{AudioData, AudioError, Clip, RenderOptions, Track, WavFormat};
use common::*;
use std::path::Path;

#[test]
fn 浮動小数で書いて読むと元のまま() {
    let dir = Workdir::new("wav-float");
    // 1.0 を超える値も切らない
    let mut left = noise(1, 1000);
    left[0] = 1.5;
    let audio = AudioData::new(44_100, vec![left, noise(2, 1000)]).unwrap();
    let path = dir.path("out.wav");
    audio.write_wav_file(&path, WavFormat::Float32).unwrap();
    assert_eq!(AudioData::from_wav_file(&path).unwrap(), audio);
}

#[test]
fn 整数で書くと1段ぶんの誤差に収まり範囲の外は端に切る() {
    let dir = Workdir::new("wav-int");
    let mut samples = noise(3, 1000);
    samples[0] = 1.7;
    samples[1] = -1.7;
    samples[2] = 0.0;
    let audio = AudioData::new(48_000, vec![samples.clone()]).unwrap();
    for (format, bits) in [(WavFormat::Pcm16, 16), (WavFormat::Pcm24, 24)] {
        let path = dir.path(&format!("out{bits}.wav"));
        audio.write_wav_file(&path, format).unwrap();
        let spec = hound::WavReader::open(&path).unwrap().spec();
        assert_eq!(
            (spec.channels, spec.sample_rate, spec.bits_per_sample),
            (1, 48_000, bits)
        );
        let read = AudioData::from_wav_file(&path).unwrap();
        assert!(!read.is_stereo());
        let step = 1.0 / (1u32 << (bits - 1)) as f32;
        // 範囲の外は、折り返さずに端の値になる
        assert!((read.left()[0] - 1.0).abs() <= step);
        assert!((read.left()[1] + 1.0).abs() <= step);
        assert_eq!(read.left()[2], 0.0);
        let diff = max_diff(&read.left()[3..], &samples[3..]);
        assert!(diff <= step, "{bits}bit: 差 {diff:e}");
    }
}

#[test]
fn 整数のwavは範囲を1に合わせて読む() {
    let dir = Workdir::new("wav-read-int");
    let path = dir.path("in.wav");
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 44_100,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&path, spec).unwrap();
    for v in [16_384i16, -32_768, 0, 8192] {
        w.write_sample(v).unwrap();
    }
    w.finalize().unwrap();
    let audio = AudioData::from_wav_file(&path).unwrap();
    assert_eq!(audio.sample_rate(), 44_100);
    // 左右が交互に並んでいる
    assert_eq!(audio.left(), &[0.5, 0.0]);
    assert_eq!(audio.right(), &[-1.0, 0.25]);
}

#[test]
fn 読めないファイルはエラーになる() {
    let dir = Workdir::new("wav-errors");
    assert!(matches!(
        AudioData::from_wav_file(Path::new("/nonexistent/bunri/none.wav")),
        Err(AudioError::File(_))
    ));
    let broken = dir.path("broken.wav");
    std::fs::write(&broken, b"not a wav file").unwrap();
    assert!(matches!(
        AudioData::from_wav_file(&broken),
        Err(AudioError::File(_))
    ));
    // 3 チャンネル以上は受け取らない
    let surround = dir.path("surround.wav");
    let spec = hound::WavSpec {
        channels: 3,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&surround, spec).unwrap();
    for _ in 0..3 {
        w.write_sample(0i16).unwrap();
    }
    w.finalize().unwrap();
    assert_eq!(
        AudioData::from_wav_file(&surround),
        Err(AudioError::Channels(3))
    );
    // 書けない場所
    let audio = AudioData::new(48_000, vec![vec![0.0; 10]]).unwrap();
    assert!(matches!(
        audio.write_wav_file(Path::new("/nonexistent/bunri/out.wav"), WavFormat::Pcm16),
        Err(AudioError::File(_))
    ));
}

#[test]
fn 曲をwavに書き出せる() {
    // ファイルから読んだクリップと、楽器で鳴らすノートを重ねた曲を、WAV にする
    let dir = Workdir::new("wav-song");
    let clip_path = dir.path("clip.wav");
    AudioData::new(44_100, vec![sine(44_100, 1000.0, 0.25, 44_100); 2])
        .unwrap()
        .write_wav_file(&clip_path, WavFormat::Pcm24)
        .unwrap();
    let clip = std::sync::Arc::new(AudioData::from_wav_file(&clip_path).unwrap());

    let s = song(vec![
        Track {
            clips: vec![Clip {
                audio: clip,
                start_sec: 0.5,
            }],
            ..Track::default()
        },
        // 0.25 秒から 0.5 秒ぶんの A4
        sampler_track(&dir.a440(), vec![note(12_000, 24_000, 69, 100)]),
    ]);
    let audio = bunri_audio::render(&mut engine(&s), &RenderOptions::default());
    let out_path = dir.path("song.wav");
    audio.write_wav_file(&out_path, WavFormat::Pcm16).unwrap();

    // 書き出したファイルを、engine とは別に読んで確かめる
    let mut reader = hound::WavReader::open(&out_path).unwrap();
    let spec = reader.spec();
    assert_eq!(
        (spec.channels, spec.sample_rate, spec.bits_per_sample),
        (2, SR, 16)
    );
    // クリップの終わり (0.5 + 1.0 秒) が曲の終わり
    assert_eq!(reader.duration(), SR * 3 / 2);
    let left: Vec<f32> = reader
        .samples::<i16>()
        .step_by(2)
        .map(|v| v.unwrap() as f32 / 32_768.0)
        .collect();
    // 0.25 秒までは無音、そこからノート (440Hz)、0.5 秒からクリップ (1kHz) が重なる
    assert!(rms(&left[..11_000]) < 1e-4);
    assert!(level_at(&left[13_000..23_000], 440.0) > 0.05);
    assert!(level_at(&left[13_000..23_000], 1000.0) < 0.005);
    let clip_level = level_at(&left[25_000..35_000], 1000.0);
    assert!(
        (clip_level - 0.25).abs() < 0.005,
        "クリップの大きさ: {clip_level:.4}"
    );
    assert!(level_at(&left[25_000..35_000], 440.0) > 0.05);
    // ノートが終わった後 (0.75 秒〜) はクリップだけ
    assert!(level_at(&left[40_000..60_000], 440.0) < 0.005);
}
