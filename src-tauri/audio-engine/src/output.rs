//! cpal で、音声デバイスに音を出す。
//!
//! 既定の出力デバイスを開き ([`OutputDevice::open_default`])、デバイスが音を求めるたびに
//! 渡された関数を呼ぶ ([`OutputDevice::start`])。関数には、ふつう
//! [`Transport::process`](crate::transport::Transport::process) を渡す。
//!
//! ```no_run
//! use bunri_audio::output::OutputDevice;
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let device = OutputDevice::open_default()?;
//! // engine と transport は、デバイスの周波数で作る
//! let (controller, mut transport) = bunri_audio::transport(device.sample_rate())?;
//! let output = device.start(move |left, right| transport.process(left, right))?;
//! // output を持っているあいだ鳴る。捨てると止まる
//! # drop((controller, output));
//! # Ok(())
//! # }
//! ```
//!
//! - デバイスのチャンネル数に合わせる: 1 なら左右を足して半分に、2 ならそのまま、3 以上なら
//!   先頭の 2 つに出して残りは無音
//! - サンプルの形式は、デバイスの既定のもの (浮動小数・整数) に変換する
//! - コールバックの中では、メモリの確保と解放・ロック・ログ出力をしない (作業用のバッファは、
//!   開くときに確保する)
//! - デバイスが外れるなどしてストリームが使えなくなったら、[`Output::is_broken`] が `true` に
//!   なる。そのときは `Output` を捨てて、開き直す (周波数が変わることが在るので、engine と
//!   transport も作り直す)
//!
//! cpal 0.18 の `Stream` は、どの OS でも `Send` + `Sync` なので、[`Output`] はそのまま別の
//! スレッドへ渡せる (ストリームを持つためだけのスレッドは要らない)。

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, ErrorKind, FromSample, OutputCallbackInfo, SampleFormat, SizedSample, StreamConfig,
    SupportedBufferSize, I24, U24,
};
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 頼むバッファの長さ (フレーム)。48kHz で 5.3 ミリ秒。デバイスが受け付けなければ、デバイスの
/// 既定の長さ (mac ではふつう 512) で開く。試作では 64 でも途切れなかったが、余裕を見ている
pub const PREFERRED_BUFFER_FRAMES: u32 = 256;

/// コールバック 1 回で、まとめて作る長さの上限 (フレーム)。これより長いバッファを求められたら、
/// 区切って作る
const SCRATCH_FRAMES: usize = 8192;

/// 開いたあと、最初のコールバックを待つ長さ (遅れの見積もりを、そこで受け取る)
const FIRST_CALLBACK_WAIT: Duration = Duration::from_millis(500);

/// 音声デバイスを開けなかったときのエラー。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputError {
    /// 出力デバイスが 1 つも無い
    NoDevice,
    /// デバイスの設定を読めなかった・使えない設定だった
    Config(String),
    /// ストリームを開けなかった・始められなかった
    Stream(String),
}

impl fmt::Display for OutputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OutputError::NoDevice => write!(f, "音声の出力デバイスが見つからない"),
            OutputError::Config(why) => write!(f, "音声の出力デバイスの設定を使えない: {why}"),
            OutputError::Stream(why) => write!(f, "音声の出力を始められない: {why}"),
        }
    }
}

impl std::error::Error for OutputError {}

/// ストリームから知らされた出来事の種類 ([`OutputStats::last_error`])。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamIssue {
    /// 音が間に合わなかった (途切れた)
    Xrun,
    /// 既定の出力デバイスが替わった (ストリームは新しいデバイスで続いている)
    DeviceChanged,
    /// 音声スレッドの優先度を上げられなかった (鳴るが、途切れやすい)
    RealtimeDenied,
    /// デバイスが無くなった (開き直しが要る)
    DeviceLost,
    /// ストリームの設定が無効になった (開き直しが要る)
    Invalidated,
    /// そのほか
    Other,
}

impl StreamIssue {
    fn from_kind(kind: ErrorKind) -> Self {
        match kind {
            ErrorKind::Xrun => StreamIssue::Xrun,
            ErrorKind::DeviceChanged => StreamIssue::DeviceChanged,
            ErrorKind::RealtimeDenied => StreamIssue::RealtimeDenied,
            ErrorKind::DeviceNotAvailable => StreamIssue::DeviceLost,
            ErrorKind::StreamInvalidated => StreamIssue::Invalidated,
            _ => StreamIssue::Other,
        }
    }

    /// 開き直さないと鳴らない出来事か。
    fn is_fatal(self) -> bool {
        matches!(self, StreamIssue::DeviceLost | StreamIssue::Invalidated)
    }

    fn code(self) -> u8 {
        match self {
            StreamIssue::Xrun => 1,
            StreamIssue::DeviceChanged => 2,
            StreamIssue::RealtimeDenied => 3,
            StreamIssue::DeviceLost => 4,
            StreamIssue::Invalidated => 5,
            StreamIssue::Other => 6,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        Some(match code {
            1 => StreamIssue::Xrun,
            2 => StreamIssue::DeviceChanged,
            3 => StreamIssue::RealtimeDenied,
            4 => StreamIssue::DeviceLost,
            5 => StreamIssue::Invalidated,
            6 => StreamIssue::Other,
            _ => return None,
        })
    }
}

/// コールバックと、ストリームのエラーの知らせが書き込む値。どれもロック無しで読み書きする。
#[derive(Default)]
struct Status {
    callbacks: AtomicU64,
    frames: AtomicU64,
    min_buffer: AtomicU32,
    max_buffer: AtomicU32,
    /// コールバックが呼ばれてから、その音がデバイスから出るまでの見積もり (ナノ秒)
    latency_nanos: AtomicU64,
    broken: AtomicBool,
    xruns: AtomicU64,
    issues: AtomicU64,
    last_issue: AtomicU8,
}

/// 動いているストリームの様子。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputStats {
    /// コールバックが呼ばれた回数
    pub callbacks: u64,
    /// 作ったフレームの数
    pub frames: u64,
    /// コールバック 1 回のバッファの長さ (フレーム) の、いちばん短かったものと長かったもの。
    /// まだ呼ばれていなければ 0
    pub min_buffer: u32,
    pub max_buffer: u32,
    /// 音が間に合わなかった回数 (デバイスが知らせた数)
    pub xruns: u64,
    /// ストリームから知らされた出来事の数 (上の `xruns` を含む)
    pub issues: u64,
    /// いちばん新しい出来事
    pub last_issue: Option<StreamIssue>,
}

/// 開く前の出力デバイス (どのデバイスを、どの設定で開くかが決まった状態)。
pub struct OutputDevice {
    device: cpal::Device,
    config: cpal::SupportedStreamConfig,
    name: String,
}

impl OutputDevice {
    /// 既定の出力デバイスを、そのデバイスの既定の設定で開く準備をする。
    pub fn open_default() -> Result<Self, OutputError> {
        let device = cpal::default_host()
            .default_output_device()
            .ok_or(OutputError::NoDevice)?;
        let config = device
            .default_output_config()
            .map_err(|e| OutputError::Config(e.to_string()))?;
        if config.channels() == 0 {
            return Err(OutputError::Config("チャンネルが 1 つも無い".into()));
        }
        let name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_default();
        Ok(OutputDevice {
            device,
            config,
            name,
        })
    }

    /// 出力のサンプリング周波数 (Hz)。engine と transport は、この周波数で作る。
    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate()
    }

    /// 出力のチャンネル数。
    pub fn channels(&self) -> u16 {
        self.config.channels()
    }

    /// デバイスの名前 (分からなければ空)。
    pub fn name(&self) -> &str {
        &self.name
    }

    /// サンプルの形式 (`f32`、`i16` など)。
    pub fn sample_format(&self) -> String {
        self.config.sample_format().to_string()
    }

    /// ストリームを開いて、鳴らし始める。
    ///
    /// `render(left, right)` は、デバイスが音を求めるたびに音声スレッドから呼ばれる。`left` と
    /// `right` は同じ長さで、中身を上書きして返す。この中で、メモリの確保と解放・ロック・
    /// ファイルの読み書き・ログ出力をしてはいけない。
    pub fn start<F>(self, render: F) -> Result<Output, OutputError>
    where
        F: FnMut(&mut [f32], &mut [f32]) + Send + 'static,
    {
        let format = self.config.sample_format();
        let buffer_size = self.pick_buffer_size(format);
        let config = StreamConfig {
            buffer_size,
            ..self.config.config()
        };
        let status = Arc::new(Status::default());
        let callback = Callback {
            render,
            left: vec![0.0; SCRATCH_FRAMES],
            right: vec![0.0; SCRATCH_FRAMES],
            channels: config.channels as usize,
            status: Arc::clone(&status),
        };
        let stream = match format {
            SampleFormat::F32 => self.build::<f32, F>(config, callback),
            SampleFormat::F64 => self.build::<f64, F>(config, callback),
            SampleFormat::I8 => self.build::<i8, F>(config, callback),
            SampleFormat::I16 => self.build::<i16, F>(config, callback),
            SampleFormat::I24 => self.build::<I24, F>(config, callback),
            SampleFormat::I32 => self.build::<i32, F>(config, callback),
            SampleFormat::I64 => self.build::<i64, F>(config, callback),
            SampleFormat::U8 => self.build::<u8, F>(config, callback),
            SampleFormat::U16 => self.build::<u16, F>(config, callback),
            SampleFormat::U24 => self.build::<U24, F>(config, callback),
            SampleFormat::U32 => self.build::<u32, F>(config, callback),
            SampleFormat::U64 => self.build::<u64, F>(config, callback),
            other => {
                return Err(OutputError::Config(format!(
                    "サンプルの形式 {other} には対応していない"
                )))
            }
        }
        .map_err(|e| OutputError::Stream(e.to_string()))?;
        stream
            .play()
            .map_err(|e| OutputError::Stream(e.to_string()))?;

        // 最初のコールバックを待つ (バッファの長さと遅れの見積もりが、そこで分かる)。
        // 来なくても失敗にはしない (見積もりが 0 のままになるだけ)
        let deadline = Instant::now() + FIRST_CALLBACK_WAIT;
        while status.callbacks.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }

        Ok(Output {
            stream,
            status,
            sample_rate: config.sample_rate,
            channels: config.channels,
            sample_format: format.to_string(),
            name: self.name,
            requested_buffer: match buffer_size {
                BufferSize::Fixed(frames) => Some(frames),
                BufferSize::Default => None,
            },
        })
    }

    /// 頼むバッファの長さを決める。[`PREFERRED_BUFFER_FRAMES`] を受け付けるデバイスならそれを、
    /// 受け付けなければデバイスの既定の長さを使う。
    ///
    /// 受け付けるかは、音を出さない仮のストリームを作って確かめる (範囲の中でも断られることが
    /// 在り、本番のストリームは `render` を渡してしまうと作り直せないため)。
    fn pick_buffer_size(&self, format: SampleFormat) -> BufferSize {
        let in_range = match *self.config.buffer_size() {
            SupportedBufferSize::Range { min, max } => {
                (min..=max).contains(&PREFERRED_BUFFER_FRAMES)
            }
            SupportedBufferSize::Unknown => false,
        };
        if !in_range {
            return BufferSize::Default;
        }
        let fixed = BufferSize::Fixed(PREFERRED_BUFFER_FRAMES);
        let config = StreamConfig {
            buffer_size: fixed,
            ..self.config.config()
        };
        // 始めない (play を呼ばない) ので、音は出ない
        let probe = self
            .device
            .build_output_stream_raw(config, format, |_, _| {}, |_| {}, None);
        match probe {
            Ok(_) => fixed,
            Err(_) => BufferSize::Default,
        }
    }

    fn build<T, F>(
        &self,
        config: StreamConfig,
        mut callback: Callback<F>,
    ) -> Result<cpal::Stream, cpal::Error>
    where
        T: SizedSample + FromSample<f32>,
        F: FnMut(&mut [f32], &mut [f32]) + Send + 'static,
    {
        let status = Arc::clone(&callback.status);
        self.device.build_output_stream(
            config,
            move |data: &mut [T], info: &OutputCallbackInfo| callback.run(data, info),
            // デバイスの知らせ。音声スレッドから呼ばれることも在るので、値を書くだけにする
            move |error: cpal::Error| {
                let issue = StreamIssue::from_kind(error.kind());
                status.issues.fetch_add(1, Ordering::Relaxed);
                status.last_issue.store(issue.code(), Ordering::Relaxed);
                if issue == StreamIssue::Xrun {
                    status.xruns.fetch_add(1, Ordering::Relaxed);
                }
                if issue.is_fatal() {
                    status.broken.store(true, Ordering::Relaxed);
                }
            },
            None,
        )
    }
}

/// コールバックが持つもの。
struct Callback<F> {
    render: F,
    left: Vec<f32>,
    right: Vec<f32>,
    channels: usize,
    status: Arc<Status>,
}

impl<F: FnMut(&mut [f32], &mut [f32])> Callback<F> {
    /// デバイスのバッファ (チャンネルが交互に並ぶ) を埋める。
    fn run<T: SizedSample + FromSample<f32>>(&mut self, data: &mut [T], info: &OutputCallbackInfo) {
        let channels = self.channels.max(1);
        let frames = data.len() / channels;
        let timestamp = info.timestamp();
        let latency = timestamp.playback.duration_since(timestamp.callback);
        let status = &self.status;
        status.latency_nanos.store(
            latency.as_nanos().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        let frames_u32 = frames.min(u32::MAX as usize) as u32;
        if status.callbacks.fetch_add(1, Ordering::Relaxed) == 0 {
            status.min_buffer.store(frames_u32, Ordering::Relaxed);
        } else {
            status.min_buffer.fetch_min(frames_u32, Ordering::Relaxed);
        }
        status.max_buffer.fetch_max(frames_u32, Ordering::Relaxed);
        status.frames.fetch_add(frames as u64, Ordering::Relaxed);

        // ふつうは 1 回で全部作る。作業用のバッファより長いときだけ区切る
        for chunk in data.chunks_mut(SCRATCH_FRAMES * channels) {
            let len = chunk.len() / channels;
            let (left, right) = (&mut self.left[..len], &mut self.right[..len]);
            (self.render)(left, right);
            write_interleaved(chunk, channels, left, right);
        }
    }
}

/// 左右の音を、デバイスのチャンネル数と形式に合わせて書く。
fn write_interleaved<T: SizedSample + FromSample<f32>>(
    out: &mut [T],
    channels: usize,
    left: &[f32],
    right: &[f32],
) {
    let frames = out.chunks_exact_mut(channels).zip(left.iter().zip(right));
    match channels {
        // モノラル: 左右を足して半分に
        1 => {
            for (frame, (l, r)) in frames {
                frame[0] = T::from_sample((l + r) * 0.5);
            }
        }
        // 2 チャンネル以上: 先頭の 2 つに左右。残りは無音
        _ => {
            for (frame, (l, r)) in frames {
                frame[0] = T::from_sample(*l);
                frame[1] = T::from_sample(*r);
                for extra in &mut frame[2..] {
                    *extra = T::EQUILIBRIUM;
                }
            }
        }
    }
}

/// 鳴っている出力。持っているあいだ鳴り、捨てると止まる。
pub struct Output {
    stream: cpal::Stream,
    status: Arc<Status>,
    sample_rate: u32,
    channels: u16,
    sample_format: String,
    name: String,
    requested_buffer: Option<u32>,
}

impl Output {
    /// 出力のサンプリング周波数 (Hz)。
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// 出力のチャンネル数。
    pub fn channels(&self) -> u16 {
        self.channels
    }

    /// サンプルの形式 (`f32`、`i16` など)。
    pub fn sample_format(&self) -> &str {
        &self.sample_format
    }

    /// デバイスの名前 (分からなければ空)。
    pub fn device_name(&self) -> &str {
        &self.name
    }

    /// 頼んだバッファの長さ (フレーム)。デバイスの既定の長さで開いたなら `None`。
    /// 実際に求められた長さは [`Output::stats`] で分かる。
    pub fn requested_buffer_frames(&self) -> Option<u32> {
        self.requested_buffer
    }

    /// 音を作ってから耳に届くまでの遅れの見積もり (秒)。バッファの長さ + デバイスの遅れ。
    ///
    /// コールバックのたびにデバイスが知らせる値 (既定のデバイスが替わると変わる)。まだ 1 回も
    /// 呼ばれていなければ、バッファの長さだけから見積もる。それも分からなければ 0。
    pub fn latency_sec(&self) -> f64 {
        if self.status.callbacks.load(Ordering::Relaxed) > 0 {
            return self.status.latency_nanos.load(Ordering::Relaxed) as f64 / 1e9;
        }
        self.stream
            .buffer_size()
            .map(|frames| frames as f64 / self.sample_rate as f64)
            .unwrap_or(0.0)
    }

    /// デバイスが外れるなどして、ストリームが使えなくなったか。`true` なら、捨てて開き直す。
    pub fn is_broken(&self) -> bool {
        self.status.broken.load(Ordering::Relaxed)
    }

    /// 動いているストリームの様子。
    pub fn stats(&self) -> OutputStats {
        let status = &self.status;
        OutputStats {
            callbacks: status.callbacks.load(Ordering::Relaxed),
            frames: status.frames.load(Ordering::Relaxed),
            min_buffer: status.min_buffer.load(Ordering::Relaxed),
            max_buffer: status.max_buffer.load(Ordering::Relaxed),
            xruns: status.xruns.load(Ordering::Relaxed),
            issues: status.issues.load(Ordering::Relaxed),
            last_issue: StreamIssue::from_code(status.last_issue.load(Ordering::Relaxed)),
        }
    }

    /// ストリームが使えなくなったかを、別のスレッドから見るための口。
    pub fn health(&self) -> OutputHealth {
        OutputHealth {
            status: Arc::clone(&self.status),
        }
    }
}

/// ストリームが使えなくなったかを見る口。複製して、別のスレッドへ渡せる。
#[derive(Clone)]
pub struct OutputHealth {
    status: Arc<Status>,
}

impl OutputHealth {
    /// デバイスが外れるなどして、ストリームが使えなくなったか。
    pub fn is_broken(&self) -> bool {
        self.status.broken.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 二チャンネルにはそのまま書く() {
        let mut out = [9.0f32; 6];
        write_interleaved(&mut out, 2, &[0.1, 0.2, 0.3], &[-0.1, -0.2, -0.3]);
        assert_eq!(out, [0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
    }

    #[test]
    fn モノラルには左右を足して半分にして書く() {
        let mut out = [9.0f32; 3];
        write_interleaved(&mut out, 1, &[0.5, 1.0, -0.5], &[0.5, 0.0, 0.5]);
        assert_eq!(out, [0.5, 0.5, 0.0]);
    }

    #[test]
    fn 三チャンネル以上は先頭の二つに書いて残りは無音() {
        let mut out = [9.0f32; 8];
        write_interleaved(&mut out, 4, &[0.1, 0.2], &[0.3, 0.4]);
        assert_eq!(out, [0.1, 0.3, 0.0, 0.0, 0.2, 0.4, 0.0, 0.0]);
    }

    #[test]
    fn 整数の形式には範囲を合わせて書き範囲の外は端に切る() {
        let mut out = [0i16; 6];
        write_interleaved(&mut out, 2, &[0.0, 0.5, 2.0], &[-0.5, -1.0, -2.0]);
        assert_eq!(out, [0, -16_384, 16_384, -32_768, 32_767, -32_768]);
        // 符号なしは、真ん中 (32768) が無音
        let mut out = [0u16; 4];
        write_interleaved(&mut out, 2, &[0.0, 0.5], &[-0.5, 2.0]);
        assert_eq!(out, [32_768, 16_384, 49_152, 65_535]);
        // 余ったチャンネルも、その形式の無音にする
        let mut out = [7u16; 3];
        write_interleaved(&mut out, 3, &[0.0], &[0.0]);
        assert_eq!(out, [32_768, 32_768, 32_768]);
    }

    #[test]
    fn コールバックは長いバッファを区切って全部埋め様子を記録する() {
        use cpal::{OutputStreamTimestamp, StreamInstant};

        let status = Arc::new(Status::default());
        let mut calls = Vec::new();
        let mut next = 0f32;
        let mut callback = Callback {
            // 左には通し番号、右にはその負の値を書く
            render: |left: &mut [f32], right: &mut [f32]| {
                calls.push(left.len());
                for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                    *l = next;
                    *r = -next;
                    next += 1.0;
                }
            },
            left: vec![0.0; SCRATCH_FRAMES],
            right: vec![0.0; SCRATCH_FRAMES],
            channels: 2,
            status: Arc::clone(&status),
        };
        let timestamp = OutputStreamTimestamp {
            callback: StreamInstant::new(1, 0),
            playback: StreamInstant::new(1, 12_000_000),
        };
        let info = OutputCallbackInfo::new(timestamp);

        let mut small = vec![0f32; 256 * 2];
        callback.run(&mut small, &info);
        let frames = SCRATCH_FRAMES + 100;
        let mut large = vec![0f32; frames * 2];
        callback.run(&mut large, &info);
        drop(callback);

        assert_eq!(calls, [256, SCRATCH_FRAMES, 100]);
        assert_eq!(&small[..4], [0.0, -0.0, 1.0, -1.0]);
        for (i, frame) in large.chunks(2).enumerate() {
            let expected = (256 + i) as f32;
            assert_eq!(frame, [expected, -expected], "frame={i}");
        }
        assert_eq!(status.callbacks.load(Ordering::Relaxed), 2);
        assert_eq!(status.frames.load(Ordering::Relaxed), 256 + frames as u64);
        assert_eq!(status.min_buffer.load(Ordering::Relaxed), 256);
        assert_eq!(status.max_buffer.load(Ordering::Relaxed), frames as u32);
        assert_eq!(status.latency_nanos.load(Ordering::Relaxed), 12_000_000);
    }

    #[test]
    fn 開き直しが要る出来事だけを見分ける() {
        assert!(StreamIssue::from_kind(ErrorKind::DeviceNotAvailable).is_fatal());
        assert!(StreamIssue::from_kind(ErrorKind::StreamInvalidated).is_fatal());
        for kind in [
            ErrorKind::Xrun,
            ErrorKind::DeviceChanged,
            ErrorKind::RealtimeDenied,
            ErrorKind::DeviceBusy,
        ] {
            assert!(!StreamIssue::from_kind(kind).is_fatal(), "{kind:?}");
        }
        for issue in [
            StreamIssue::Xrun,
            StreamIssue::DeviceChanged,
            StreamIssue::RealtimeDenied,
            StreamIssue::DeviceLost,
            StreamIssue::Invalidated,
            StreamIssue::Other,
        ] {
            assert_eq!(StreamIssue::from_code(issue.code()), Some(issue));
        }
        assert_eq!(StreamIssue::from_code(0), None);
    }

    #[test]
    fn 出力は別のスレッドへ渡せる() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Output>();
        assert_send_sync::<OutputHealth>();
    }
}
