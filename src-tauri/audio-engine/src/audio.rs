//! メモリに置いた音声 (PCM) と、WAV ファイルの読み書き。
//!
//! クリップの中身 (取り込んだ原曲・ステム・録音) にも、描画の結果にも同じ [`AudioData`] を使う。

use crate::resample::Resampler;
use std::fmt;
use std::path::Path;

/// 扱うサンプリング周波数の範囲 (Hz)。壊れたヘッダの値で、変換の係数が巨大にならないようにする
pub const SAMPLE_RATE_RANGE: std::ops::RangeInclusive<u32> = 1_000..=768_000;

/// 音声を受け取れなかった・読み書きできなかったときのエラー。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioError {
    /// チャンネル数が 1 でも 2 でもない
    Channels(usize),
    /// 左右の長さが違う
    LengthMismatch,
    /// サンプリング周波数が扱える範囲 ([`SAMPLE_RATE_RANGE`]) に無い
    SampleRate(u32),
    /// ファイルの読み書きに失敗した (ファイルが無い、WAV として読めない など)
    File(String),
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AudioError::Channels(n) => {
                write!(f, "チャンネル数 {n} の音声は扱えない (1 か 2 のみ)")
            }
            AudioError::LengthMismatch => write!(f, "左右のチャンネルの長さが違う"),
            AudioError::SampleRate(r) => write!(f, "サンプリング周波数 {r}Hz は扱えない"),
            AudioError::File(e) => write!(f, "音声ファイルを読み書きできなかった: {e}"),
        }
    }
}

impl std::error::Error for AudioError {}

/// WAV に書き出すときのサンプルの形式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WavFormat {
    /// 整数 16bit (CD と同じ)
    Pcm16,
    /// 整数 24bit
    Pcm24,
    /// 浮動小数 32bit (engine の出力をそのまま。1.0 を超えた値も切らない)
    Float32,
}

/// メモリに置いた音声 (モノラルかステレオ、32bit の浮動小数)。作ったあとは変えない。
#[derive(Debug, Clone, PartialEq)]
pub struct AudioData {
    sample_rate: u32,
    channels: Vec<Vec<f32>>,
}

impl AudioData {
    /// チャンネルごとのサンプルから作る。チャンネルは 1 つ (モノラル) か 2 つ (左・右)。
    pub fn new(sample_rate: u32, channels: Vec<Vec<f32>>) -> Result<Self, AudioError> {
        if !SAMPLE_RATE_RANGE.contains(&sample_rate) {
            return Err(AudioError::SampleRate(sample_rate));
        }
        if channels.is_empty() || channels.len() > 2 {
            return Err(AudioError::Channels(channels.len()));
        }
        if channels.iter().any(|c| c.len() != channels[0].len()) {
            return Err(AudioError::LengthMismatch);
        }
        Ok(AudioData {
            sample_rate,
            channels,
        })
    }

    /// WAV ファイルを読む (整数の 8〜32bit と、浮動小数の 32bit)。
    pub fn from_wav_file(path: &Path) -> Result<Self, AudioError> {
        let file_error = |e: hound::Error| AudioError::File(format!("{}: {e}", path.display()));
        let mut reader = hound::WavReader::open(path).map_err(file_error)?;
        let spec = reader.spec();
        let count = spec.channels as usize;
        if count == 0 || count > 2 {
            return Err(AudioError::Channels(count));
        }
        let interleaved: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => reader
                .samples::<f32>()
                .collect::<Result<_, _>>()
                .map_err(file_error)?,
            hound::SampleFormat::Int => {
                if !(1..=32).contains(&spec.bits_per_sample) {
                    return Err(AudioError::File(format!(
                        "{}: {}bit の WAV は読めない",
                        path.display(),
                        spec.bits_per_sample
                    )));
                }
                let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
                reader
                    .samples::<i32>()
                    .map(|s| s.map(|v| v as f32 * scale))
                    .collect::<Result<_, _>>()
                    .map_err(file_error)?
            }
        };
        let frames = interleaved.len() / count;
        let channels = (0..count)
            .map(|c| (0..frames).map(|i| interleaved[i * count + c]).collect())
            .collect();
        AudioData::new(spec.sample_rate, channels)
    }

    /// WAV ファイルに書き出す。同じ名前のファイルは置き換える。
    ///
    /// 整数の形式では、-1.0〜1.0 を超えた値を端の値に切る (折り返さない)。
    pub fn write_wav_file(&self, path: &Path, format: WavFormat) -> Result<(), AudioError> {
        let file_error = |e: hound::Error| AudioError::File(format!("{}: {e}", path.display()));
        let (bits_per_sample, sample_format) = match format {
            WavFormat::Pcm16 => (16, hound::SampleFormat::Int),
            WavFormat::Pcm24 => (24, hound::SampleFormat::Int),
            WavFormat::Float32 => (32, hound::SampleFormat::Float),
        };
        let spec = hound::WavSpec {
            channels: self.channels.len() as u16,
            sample_rate: self.sample_rate,
            bits_per_sample,
            sample_format,
        };
        let mut writer = hound::WavWriter::create(path, spec).map_err(file_error)?;
        // 整数の形式の、いちばん大きい値 (16bit なら 32767)
        let full_scale = ((1i64 << (bits_per_sample - 1)) - 1) as f32;
        for frame in 0..self.frames() {
            for channel in &self.channels {
                let v = channel[frame];
                match format {
                    WavFormat::Float32 => writer.write_sample(v),
                    WavFormat::Pcm16 | WavFormat::Pcm24 => {
                        writer.write_sample((v.clamp(-1.0, 1.0) * full_scale).round() as i32)
                    }
                }
                .map_err(file_error)?;
            }
        }
        writer.finalize().map_err(file_error)
    }

    /// サンプリング周波数 (Hz)。
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// 長さ (フレーム数)。
    pub fn frames(&self) -> usize {
        self.channels[0].len()
    }

    /// ステレオか (モノラルなら `false`)。
    pub fn is_stereo(&self) -> bool {
        self.channels.len() == 2
    }

    /// 左のチャンネル (モノラルなら、ただ 1 つのチャンネル)。
    pub fn left(&self) -> &[f32] {
        &self.channels[0]
    }

    /// 右のチャンネル (モノラルなら、左と同じもの)。
    pub fn right(&self) -> &[f32] {
        &self.channels[self.channels.len() - 1]
    }

    /// サンプリング周波数を `sample_rate` に変えた音声を作る。
    ///
    /// 長さ (秒) と音の高さは変わらない。位置もずれない (n 番目のフレームは、元の
    /// 同じ時刻を指す)。長い音声では時間がかかるので、音声スレッドでは呼ばない。
    pub fn resampled(&self, sample_rate: u32) -> Result<AudioData, AudioError> {
        if !SAMPLE_RATE_RANGE.contains(&sample_rate) {
            return Err(AudioError::SampleRate(sample_rate));
        }
        if sample_rate == self.sample_rate {
            return Ok(self.clone());
        }
        let resampler = Resampler::new(self.sample_rate, sample_rate);
        Ok(AudioData {
            sample_rate,
            channels: self.channels.iter().map(|c| resampler.process(c)).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn チャンネル数と長さと周波数を確かめる() {
        assert_eq!(AudioData::new(48_000, vec![]), Err(AudioError::Channels(0)));
        assert_eq!(
            AudioData::new(48_000, vec![vec![0.0]; 3]),
            Err(AudioError::Channels(3))
        );
        assert_eq!(
            AudioData::new(48_000, vec![vec![0.0; 2], vec![0.0; 3]]),
            Err(AudioError::LengthMismatch)
        );
        assert_eq!(
            AudioData::new(0, vec![vec![0.0]]),
            Err(AudioError::SampleRate(0))
        );
        let mono = AudioData::new(44_100, vec![vec![0.5; 10]]).unwrap();
        assert!(!mono.is_stereo());
        assert_eq!(mono.frames(), 10);
        assert_eq!(mono.left(), mono.right());
    }

    #[test]
    fn 周波数を変えると長さの秒数が保たれる() {
        let one_sec = AudioData::new(44_100, vec![vec![0.0; 44_100]; 2]).unwrap();
        let converted = one_sec.resampled(48_000).unwrap();
        assert_eq!(converted.sample_rate(), 48_000);
        assert_eq!(converted.frames(), 48_000);
        assert!(converted.is_stereo());
        // 同じ周波数なら中身は変わらない
        assert_eq!(one_sec.resampled(44_100).unwrap(), one_sec);
        assert_eq!(one_sec.resampled(1), Err(AudioError::SampleRate(1)));
    }
}
