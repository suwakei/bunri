//! bunri の音のエンジン。
//!
//! 曲の内容 (トラック・ノート・クリップ・楽器) を受け取り、ブロックごとに音を作る。
//! 同じ engine をオフラインで回して、WAV に書き出せる。設計は `docs/instrument-engine-design.md`。
//!
//! - `song`: engine に渡す曲のデータ
//! - `engine`: 曲の内容を持ち、ブロックごとに音を作る
//! - `sampler`: sfizz (SFZ サンプラー) の包み。sfizz とのつなぎはこの中だけ
//! - `tone`: 仮の音 (三角波)。楽器の素材が入るまで、ノートと鍵盤の試聴をこれで鳴らす
//! - `clips`: 取り込んだ音声の再生
//! - `mixer`: トラックの音量・パン・ミュート・ソロ
//! - `render`: engine をオフラインで回す (書き出し)
//! - `audio`: メモリに置いた音声と、WAV の読み書き
//! - `resample`: サンプリング周波数の変換
//! - `transport`: 再生の状態 (位置・区間ループ・カウント・メトロノーム・鍵盤の試聴) を、音声スレッドの
//!   側で進める。画面側の指示はロックの無いキューで受ける
//! - `output`: cpal で音声デバイスに出す
//!
//! ```no_run
//! use bunri_audio::{Engine, EngineConfig, Instrument, Note, RenderOptions, Song, Track, WavFormat};
//! use std::path::Path;
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let song = Song {
//!     bpm: 120.0,
//!     tracks: vec![Track {
//!         instrument: Some(Instrument::Sampler { sfz: "piano.sfz".into() }),
//!         // 1 拍目から 1 拍ぶんの C4
//!         notes: vec![Note { start: 0, length: 960, pitch: 60, velocity: 96 }],
//!         ..Track::default()
//!     }],
//!     ..Song::default()
//! };
//! let mut engine = Engine::new(&song, &EngineConfig::default())?;
//! let audio = bunri_audio::render(&mut engine, &RenderOptions::default());
//! audio.write_wav_file(Path::new("out.wav"), WavFormat::Pcm24)?;
//! # Ok(())
//! # }
//! ```

pub mod audio;
mod clips;
pub mod engine;
pub mod mixer;
pub mod output;
pub mod render;
mod resample;
pub mod sampler;
pub mod song;
pub mod tone;
pub mod transport;

pub use audio::{AudioData, AudioError, WavFormat};
pub use engine::{Engine, EngineConfig, EngineError};
pub use output::{Output, OutputDevice, OutputError, OutputHealth, OutputStats, StreamIssue};
pub use render::{render, RenderOptions};
pub use sampler::{LoadError, Sampler};
pub use song::{Clip, Instrument, Note, Song, Track, DEFAULT_VELOCITY, TICKS_PER_BEAT};
pub use tone::{ToneConfig, ToneSynth};
pub use transport::{
    transport, Controller, CountIn, Grid, PlayOptions, PlaybackPosition, PositionReader, Transport,
    TransportError,
};
