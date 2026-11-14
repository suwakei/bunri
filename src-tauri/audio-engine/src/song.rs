//! 曲の内容 (engine に渡すデータ)。
//!
//! 画面が持つ曲 (トラック・ノート・クリップ) を、音を作るのに要る項目だけにしたもの。
//! ここにあるのはデータだけで、音は `engine` が作る。
//!
//! ノートの位置と長さはティック (1 拍 = [`TICKS_PER_BEAT`]) で持つ。秒やフレームへの変換は
//! テンポ (`bpm`) と 1 小節目の位置 (`offset_sec`) で決まり、[`Song::tick_to_frame`] が行う。

use crate::audio::AudioData;
use std::path::PathBuf;
use std::sync::Arc;

/// 1 拍のティック数。16 分音符は 240 ティック。
pub const TICKS_PER_BEAT: u64 = 960;

/// 強さを持たないノートの強さ (画面側の `DEFAULT_VELOCITY` と同じ)。
pub const DEFAULT_VELOCITY: u8 = 96;

/// ノート 1 つ。位置と長さはティック。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Note {
    /// 鳴り始め (1 小節目の 1 拍目からのティック)
    pub start: u64,
    /// 長さ (ティック)。0 のノートは鳴らさない
    pub length: u64,
    /// MIDI ノート番号 (60 = C4)。127 を超えるノートは鳴らさない
    pub pitch: u8,
    /// 強さ (1〜127。範囲の外は丸める)
    pub velocity: u8,
}

/// トラックのノートを鳴らす楽器。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Instrument {
    /// SFZ の楽器 (マルチサンプル)。`sfz` は SFZ ファイルの場所
    Sampler { sfz: PathBuf },
    /// 仮の音 (三角波。`tone`)。楽器の素材が入るまでの代わり。モノラルの素材として扱う
    Tone,
}

/// タイムラインに置いた音声 (取り込んだ原曲・ステム・録音)。
#[derive(Debug, Clone)]
pub struct Clip {
    /// 音声の中身。同じ音声を複数のクリップや engine で共有できる
    pub audio: Arc<AudioData>,
    /// タイムライン上の開始位置 (秒)。負なら、頭が切れた状態で 0 秒から鳴る
    pub start_sec: f64,
}

/// トラック 1 本。
#[derive(Debug, Clone)]
pub struct Track {
    /// ノートを鳴らす楽器。`None` のトラックのノートは鳴らない
    /// (楽器が未指定のときにピアノを当てるのは、engine に渡す側の仕事)
    pub instrument: Option<Instrument>,
    /// ノート (順不同でよい)
    pub notes: Vec<Note>,
    /// 音声のクリップ (順不同でよい)
    pub clips: Vec<Clip>,
    /// 音量 (dB。0 がそのまま)
    pub gain_db: f32,
    /// パン (-1.0 = 左、0.0 = 中央、1.0 = 右。範囲の外は丸める)
    pub pan: f32,
    /// ミュート
    pub mute: bool,
    /// ソロ。ソロのトラックが 1 本でも在れば、ソロのトラックだけが鳴る
    pub solo: bool,
}

impl Default for Track {
    fn default() -> Self {
        Track {
            instrument: None,
            notes: Vec::new(),
            clips: Vec::new(),
            gain_db: 0.0,
            pan: 0.0,
            mute: false,
            solo: false,
        }
    }
}

/// 曲の内容。
#[derive(Debug, Clone)]
pub struct Song {
    /// テンポ (BPM。小数も可)
    pub bpm: f64,
    /// 1 小節目の 1 拍目の位置 (秒)。ティック 0 はここ
    pub offset_sec: f64,
    /// トラック
    pub tracks: Vec<Track>,
    /// マスターの音量 (dB。0 がそのまま)
    pub master_gain_db: f32,
}

impl Default for Song {
    fn default() -> Self {
        Song {
            bpm: 120.0,
            offset_sec: 0.0,
            tracks: Vec::new(),
            master_gain_db: 0.0,
        }
    }
}

impl Song {
    /// ティックの位置を、フレーム (サンプリング周波数の単位) にする。
    ///
    /// いちばん近いフレームに丸める。0 秒より前になる位置は負の値で返る。
    /// ノートの終わりは「始まり + 長さ」のティックから求める (長さをフレームにしてから
    /// 足すと、丸めが積み重なって隣のノートとの境目がずれる)。
    pub fn tick_to_frame(&self, tick: u64, sample_rate: u32) -> i64 {
        let beats = tick as f64 / TICKS_PER_BEAT as f64;
        let sec = self.offset_sec + beats * 60.0 / self.bpm;
        (sec * sample_rate as f64).round() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ティックは拍とテンポでフレームになる() {
        let song = Song::default();
        // 120 BPM、48kHz では 1 拍 = 24000 フレーム、1 ティック = 25 フレーム
        assert_eq!(song.tick_to_frame(0, 48_000), 0);
        assert_eq!(song.tick_to_frame(1, 48_000), 25);
        assert_eq!(song.tick_to_frame(TICKS_PER_BEAT, 48_000), 24_000);
        assert_eq!(song.tick_to_frame(TICKS_PER_BEAT * 4, 44_100), 88_200);
    }

    #[test]
    fn 一小節目の位置のぶんだけ後ろにずれる() {
        let song = Song {
            bpm: 90.0,
            offset_sec: 0.25,
            ..Song::default()
        };
        // 0.25 秒 + 1 拍 (60/90 秒)
        assert_eq!(song.tick_to_frame(0, 48_000), 12_000);
        assert_eq!(song.tick_to_frame(TICKS_PER_BEAT, 48_000), 12_000 + 32_000);
    }

    #[test]
    fn 割り切れない位置はいちばん近いフレームに丸める() {
        // 100 BPM、44.1kHz: 1 ティック = 27.5625 フレーム
        let song = Song {
            bpm: 100.0,
            ..Song::default()
        };
        assert_eq!(song.tick_to_frame(1, 44_100), 28);
        assert_eq!(song.tick_to_frame(2, 44_100), 55);
        // 長い曲の後ろでも、丸めが積み重ならない (10 分 = 1000 拍)
        assert_eq!(
            song.tick_to_frame(TICKS_PER_BEAT * 1000, 44_100),
            44_100 * 600
        );
    }
}
