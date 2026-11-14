//! 再生の状態を、音声スレッドの側で進める。
//!
//! [`transport`] が 2 つの部品を作る:
//!
//! - [`Transport`]: 音声スレッドが持つ。engine を抱え、[`Transport::process`] が呼ばれるたびに
//!   指示を受け取り、位置を進め、音を作る
//! - [`Controller`]: 画面の側 (音声スレッドの外) が持つ。指示をロックの無いキューに積む
//!
//! どちらも Tauri と音声デバイス (cpal) を知らない。テストは `process` を直接回す。
//!
//! # 受け持つこと
//!
//! - **再生と停止**。止まっているあいだは無音 (鍵盤の試聴の声と、その余韻だけが鳴る)。
//!   曲の終わりを過ぎても止めない (止めるのは画面)
//! - **engine の差し替え**。組み立ては音声スレッドの外で済ませ、出来上がった engine を
//!   受け取る。古い engine は音声スレッドでは捨てず、別のキューで送り返す
//!   ([`Controller::collect_garbage`] が捨てる)。再生中に差し替えたら、同じ位置から続ける
//! - **区間ループ**。区間の終わりのフレームで、ちょうど頭へ戻る (ブロックの途中でも。隙間なし)
//! - **録音前のカウント**。曲を進めずにクリックだけを鳴らし、そのあと曲が始まる
//! - **メトロノーム**。位置が拍をまたいだらクリックを鳴らす
//! - **鍵盤の試聴**。再生していなくても鳴る
//! - **位置の公開**。ブロックの頭の位置と、そのときの時刻を、ロック無しで読める形で書く
//!
//! # つなぎ目
//!
//! 曲の音 (engine の出力) が不連続になるところでは、短い直線 ([`JOIN_FADE_SEC`]) で上げ下げして
//! 「ぷつっ」を消す。クリックと鍵盤の試聴には掛けない。
//!
//! - 鳴らし始め・区間の頭へ戻った直後: 0 から上げる。曲の頭 (0 フレーム) からの、ループでない
//!   再生だけは上げない (頭ちょうどに在るアタックを弱めないため)
//! - 区間の終わりの手前: 0 へ下げる (終わりの位置は先に分かっている)
//! - 再生中の停止・鳴らし直し・engine の差し替え: 先に下げきってから行う。そのあいだ
//!   ([`JOIN_FADE_SEC`] だけ) は、あとに続く指示も待たせる (順番は変わらない)
//!
//! # 音声スレッドでの約束
//!
//! [`Transport::process`] は、メモリの確保と解放・ロック・ファイルの読み書き・ログ出力をしない
//! (テスト `tests/realtime.rs` が確かめる)。時刻は `Instant::now()` で読む (確保もロックもしない)。

use crate::audio::SAMPLE_RATE_RANGE;
use crate::engine::Engine;
use crate::tone::{ToneConfig, ToneSynth};
use rtrb::{Consumer, Producer, PushError, RingBuffer};
use std::f64::consts::TAU;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// つなぎ目で上げ下げする長さ (秒)。画面側の `LOOP_FADE` と同じ。
pub const JOIN_FADE_SEC: f64 = 0.004;

/// 小節の 1 拍目 (カウントは最初の 1 つ) のクリックの高さ (Hz)。
pub const CLICK_ACCENT_HZ: f64 = 1500.0;
/// ほかの拍のクリックの高さ (Hz)。
pub const CLICK_HZ: f64 = 1000.0;
/// クリックの鳴り始めの山の高さ。ここから [`CLICK_SEC`] で [`CLICK_END_LEVEL`] まで指数で減る。
pub const CLICK_LEVEL: f32 = 0.3;
/// クリックの鳴り終わりの山の高さ。
pub const CLICK_END_LEVEL: f32 = 0.001;
/// クリックの長さ (秒)。
pub const CLICK_SEC: f64 = 0.05;

/// 指示のキューの長さ。音声スレッドは 1 ブロックごとに全部受け取るので、これだけ溜まるのは
/// 音声スレッドが止まっているとき
const COMMAND_CAPACITY: usize = 256;
/// 一度に作る長さの上限 (フレーム)。作業用のバッファの長さ
const SEGMENT: usize = 2048;
/// 同時に鳴らせるクリックの数 (1 つは 50ms なので、ふつうは重ならない)
const CLICK_VOICES: usize = 4;
/// 扱う位置の上限 (秒)。これより先は、値が壊れているとみなす
const MAX_POSITION_SEC: f64 = 1_000_000.0;
/// カウントの拍数の上限。
const MAX_COUNT_IN_BEATS: u32 = 64;
/// 1 拍の長さの下限 (秒)。これより短い拍は、値が壊れているとみなす
const MIN_BEAT_SEC: f64 = 0.001;

/// 拍の位置を決める値 (メトロノームが使う)。拍は `offset_sec + k × 60 / bpm` (k は負も在る)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    /// テンポ (BPM)
    pub bpm: f64,
    /// 1 小節目の 1 拍目の位置 (秒)
    pub offset_sec: f64,
    /// 1 小節の拍数。`k` がこの倍数の拍が、小節の 1 拍目 (高い音)
    pub beats_per_bar: u32,
}

impl Default for Grid {
    fn default() -> Self {
        Grid {
            bpm: 120.0,
            offset_sec: 0.0,
            beats_per_bar: 4,
        }
    }
}

/// 録音前のカウント。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CountIn {
    /// クリックの数。0 ならカウントしない
    pub beats: u32,
    /// 1 拍の長さ (秒)
    pub beat_sec: f64,
}

/// 再生の始め方。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlayOptions {
    /// 再生のたびに呼ぶ側が増やす番号。位置と一緒にそのまま返す
    pub token: u64,
    /// 始める位置 (秒)。負は 0 にする。区間ループの外なら、区間の頭にする
    pub from_sec: f64,
    /// 区間ループ (頭, 終わり。秒)。終わりに着いたら頭へ戻る
    pub loop_range: Option<(f64, f64)>,
    /// 録音前のカウント
    pub count_in: Option<CountIn>,
    /// メトロノームを鳴らすか
    pub metronome: bool,
}

impl Default for PlayOptions {
    fn default() -> Self {
        PlayOptions {
            token: 0,
            from_sec: 0.0,
            loop_range: None,
            count_in: None,
            metronome: false,
        }
    }
}

/// 指示を渡せなかったときのエラー。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// 値が範囲の外 (数値でない、区間の終わりが頭より前、など)
    Invalid(String),
    /// engine の周波数が、出力の周波数と違う
    SampleRate { engine: u32, output: u32 },
    /// 指示のキューが一杯 (音声スレッドが指示を受け取っていない)
    QueueFull,
    /// 音声スレッドの側が、もう居ない
    Disconnected,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::Invalid(why) => write!(f, "再生の指示が正しくない: {why}"),
            TransportError::SampleRate { engine, output } => write!(
                f,
                "engine の周波数 ({engine}Hz) が、出力の周波数 ({output}Hz) と違う"
            ),
            TransportError::QueueFull => {
                write!(f, "音声の出力が指示を受け取っていない (止まっている)")
            }
            TransportError::Disconnected => write!(f, "音声の出力が閉じている"),
        }
    }
}

impl std::error::Error for TransportError {}

/// 音声スレッドが公開した、ブロックの頭の状態。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaybackPosition {
    /// いまの再生の番号 ([`PlayOptions::token`])。一度も再生していなければ 0
    pub token: u64,
    /// 再生中か (カウントの最中も `true`)
    pub playing: bool,
    /// 録音前のカウントの最中か (位置は始める位置のまま)
    pub counting_in: bool,
    /// ブロックの頭から、カウントが終わって曲が始まるまでの残り (フレーム)。カウントの最中で
    /// なければ 0。読む側は、`at` からこの長さが過ぎたら、次の知らせを待たずに「曲が始まった」と
    /// 分かる (位置は、始める位置 + 過ぎたぶん)
    pub count_in_remaining_frames: u64,
    /// 上の残りを秒にしたもの
    pub count_in_remaining_sec: f64,
    /// ブロックの頭の位置 (フレーム)。区間ループでは区間の中の位置
    pub frame: u64,
    /// ブロックの頭の位置 (秒)
    pub position_sec: f64,
    /// 区間ループの何周目か (0 始まり)。ループでなければ 0
    pub pass: u64,
    /// このブロックを作り始めた時刻
    pub at: Instant,
}

/// フレームにした拍の決まり。
#[derive(Debug, Clone, Copy)]
struct BeatGrid {
    bpm: f64,
    offset_sec: f64,
    beats_per_bar: i64,
}

/// フレームにしたカウント。
#[derive(Debug, Clone, Copy)]
struct CountInFrames {
    beats: u32,
    /// 1 拍の長さ (フレーム。端数あり)
    beat_frames: f64,
    /// カウント全体の長さ (フレーム)
    total: u64,
}

/// フレームにした再生の指示。
struct PlayCommand {
    token: u64,
    from: u64,
    loop_range: Option<(u64, u64)>,
    count_in: Option<CountInFrames>,
    metronome: bool,
}

/// 音声スレッドへの指示。
enum Command {
    SetSong {
        engine: Box<Engine>,
        grid: BeatGrid,
    },
    Play(PlayCommand),
    Stop,
    SetTrack {
        track: usize,
        gain_db: f32,
        pan: f32,
        audible: bool,
    },
    SetMetronome(bool),
    LiveNoteOn {
        pitch: u8,
        velocity: u8,
    },
    LiveNoteOff {
        pitch: u8,
    },
    LiveAllOff,
}

/// 位置の公開に使う、ロックの無い置き場 (seqlock)。
///
/// 書く側 (音声スレッド) は、書く前と後に `seq` を 1 ずつ進める。読む側は、読む前と後の `seq` が
/// 同じ偶数のときだけ値を使う (書いている途中の、食い違った値を使わない)。書く側は決して待たない。
struct PositionCell {
    seq: AtomicU64,
    token: AtomicU64,
    frame: AtomicU64,
    pass: AtomicU64,
    /// ビット 0 = 再生中、ビット 1 = カウントの最中
    flags: AtomicU64,
    /// カウントが終わるまでの残り (フレーム)。カウントの最中でなければ 0
    count_remaining: AtomicU64,
    /// 始まり ([`Shared::epoch`]) からのナノ秒
    at_nanos: AtomicU64,
}

const FLAG_PLAYING: u64 = 1;
const FLAG_COUNTING_IN: u64 = 2;

/// 両側が持つもの。
struct Shared {
    position: PositionCell,
    /// 時刻を数える始まり
    epoch: Instant,
}

/// 画面の側 (音声スレッドの外) から、再生を動かす。
pub struct Controller {
    sample_rate: u32,
    commands: Producer<Command>,
    garbage: Consumer<Box<Engine>>,
    shared: Arc<Shared>,
}

/// 位置を読む口。複製して、別のスレッドへ渡せる。
#[derive(Clone)]
pub struct PositionReader {
    sample_rate: u32,
    shared: Arc<Shared>,
}

/// 再生の状態を進める部品。音声スレッドが持つ。
pub struct Transport {
    sample_rate: u32,
    commands: Consumer<Command>,
    garbage: Producer<Box<Engine>>,
    shared: Arc<Shared>,

    engine: Option<Box<Engine>>,
    grid: BeatGrid,
    metronome: bool,

    playing: bool,
    token: u64,
    /// 次に作る曲の位置 (フレーム)
    position: u64,
    loop_range: Option<(u64, u64)>,
    pass: u64,
    /// カウントの最中なら、その内容と、進んだフレーム数
    count: Option<(CountInFrames, u64)>,

    /// つなぎ目で上げ下げする長さ (フレーム)
    fade_frames: u32,
    /// いまの上げ (と、区間の終わりの下げ) の長さ。短い区間では `fade_frames` より短い
    edge_frames: u32,
    /// 鳴らし始めてからのフレーム数 (`edge_frames` で頭打ち)
    since_start: u32,
    /// 下げきってから行う指示
    pending: Option<Command>,
    /// 下げきるまでの残り (フレーム)
    fade_out_left: u32,

    clicks: Clicks,
    live: ToneSynth,
    song_left: Vec<f32>,
    song_right: Vec<f32>,
    mono: Vec<f32>,
}

/// 出力の周波数 `sample_rate` で、再生を動かす口と、音声スレッドが持つ部品を作る。
pub fn transport(sample_rate: u32) -> Result<(Controller, Transport), TransportError> {
    if !SAMPLE_RATE_RANGE.contains(&sample_rate) {
        return Err(TransportError::Invalid(format!(
            "サンプリング周波数 {sample_rate}Hz は扱えない"
        )));
    }
    let (command_tx, command_rx) = RingBuffer::new(COMMAND_CAPACITY);
    // 送り返す engine は、積まれた差し替えの数より多くならない
    let (garbage_tx, garbage_rx) = RingBuffer::new(COMMAND_CAPACITY + 2);
    let shared = Arc::new(Shared {
        position: PositionCell {
            seq: AtomicU64::new(0),
            token: AtomicU64::new(0),
            frame: AtomicU64::new(0),
            pass: AtomicU64::new(0),
            flags: AtomicU64::new(0),
            count_remaining: AtomicU64::new(0),
            at_nanos: AtomicU64::new(0),
        },
        epoch: Instant::now(),
    });
    let fade_frames = ((sample_rate as f64 * JOIN_FADE_SEC).round() as u32).max(1);
    let controller = Controller {
        sample_rate,
        commands: command_tx,
        garbage: garbage_rx,
        shared: Arc::clone(&shared),
    };
    let transport = Transport {
        sample_rate,
        commands: command_rx,
        garbage: garbage_tx,
        shared,
        engine: None,
        grid: BeatGrid::from(&Grid::default()),
        metronome: false,
        playing: false,
        token: 0,
        position: 0,
        loop_range: None,
        pass: 0,
        count: None,
        fade_frames,
        edge_frames: fade_frames,
        since_start: fade_frames,
        pending: None,
        fade_out_left: 0,
        clicks: Clicks::new(sample_rate),
        live: ToneSynth::new(sample_rate, &ToneConfig::LIVE),
        song_left: vec![0.0; SEGMENT],
        song_right: vec![0.0; SEGMENT],
        mono: vec![0.0; SEGMENT],
    };
    Ok((controller, transport))
}

impl From<&Grid> for BeatGrid {
    fn from(grid: &Grid) -> Self {
        BeatGrid {
            bpm: grid.bpm,
            offset_sec: grid.offset_sec,
            beats_per_bar: grid.beats_per_bar.max(1) as i64,
        }
    }
}

impl BeatGrid {
    /// `k` 番目の拍の位置 (フレーム。0 秒より前は負)。ノートの位置 (`Song::tick_to_frame`) と
    /// 同じ式で求める (拍の頭のノートとクリックが、同じフレームに来る)。
    fn beat_frame(&self, k: i64, sample_rate: u32) -> f64 {
        ((self.offset_sec + k as f64 * 60.0 / self.bpm) * sample_rate as f64).round()
    }

    /// 曲の位置 `[pos, pos + len)` に入る拍を、(範囲の頭からのフレーム数, 小節の 1 拍目か) で渡す。
    fn for_beats(
        &self,
        pos: u64,
        len: usize,
        sample_rate: u32,
        mut found: impl FnMut(usize, bool),
    ) {
        let (from, to) = (pos as f64, pos as f64 + len as f64);
        let beats = (from / sample_rate as f64 - self.offset_sec) * self.bpm / 60.0;
        // 丸めで 1 つずれても拾えるよう、1 つ手前から見る
        let mut k = beats.floor() as i64 - 1;
        loop {
            let frame = self.beat_frame(k, sample_rate);
            if frame >= to {
                break;
            }
            if frame >= from {
                found(
                    (frame - from) as usize,
                    k.rem_euclid(self.beats_per_bar) == 0,
                );
            }
            k += 1;
        }
    }
}

impl Controller {
    /// 出力のサンプリング周波数 (Hz)。engine は、この周波数で組み立てる。
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// 曲を差し替える。`engine` は、音声スレッドの外で組み立てたもの。
    ///
    /// 再生中なら、同じ位置から新しい曲で続ける。古い engine は、音声スレッドが送り返して
    /// きたものを [`Controller::collect_garbage`] が捨てる。
    pub fn set_song(&mut self, engine: Box<Engine>, grid: &Grid) -> Result<(), TransportError> {
        if engine.sample_rate() != self.sample_rate {
            return Err(TransportError::SampleRate {
                engine: engine.sample_rate(),
                output: self.sample_rate,
            });
        }
        if !(grid.bpm.is_finite() && grid.bpm > 0.0 && 60.0 / grid.bpm >= MIN_BEAT_SEC) {
            return Err(TransportError::Invalid(format!(
                "テンポ {} は使えない",
                grid.bpm
            )));
        }
        if !(grid.offset_sec.is_finite() && grid.offset_sec.abs() <= MAX_POSITION_SEC) {
            return Err(TransportError::Invalid(format!(
                "1 小節目の位置 {} 秒は使えない",
                grid.offset_sec
            )));
        }
        // 前に送り返されてきた engine は、ここ (音声スレッドの外) で捨てる
        self.collect_garbage();
        self.send(Command::SetSong {
            engine,
            grid: BeatGrid::from(grid),
        })
    }

    /// いま渡してある曲を鳴らす (鳴っていたら、止めて鳴らし直す)。
    pub fn play(&mut self, options: &PlayOptions) -> Result<(), TransportError> {
        let rate = self.sample_rate as f64;
        let invalid = |why: String| Err(TransportError::Invalid(why));
        let frame = |sec: f64| (sec * rate).round() as u64;
        if !(options.from_sec.is_finite() && options.from_sec <= MAX_POSITION_SEC) {
            return invalid(format!("始める位置 {} 秒は使えない", options.from_sec));
        }
        let loop_range = match options.loop_range {
            None => None,
            Some((start, end)) => {
                let ok = start.is_finite() && end.is_finite() && start >= 0.0;
                if !(ok && end <= MAX_POSITION_SEC && frame(end) > frame(start)) {
                    return invalid(format!("区間 {start}〜{end} 秒は使えない"));
                }
                Some((frame(start), frame(end)))
            }
        };
        let count_in = match options.count_in {
            Some(count) if count.beats > 0 => {
                let ok = count.beat_sec.is_finite()
                    && (MIN_BEAT_SEC..=60.0).contains(&count.beat_sec)
                    && count.beats <= MAX_COUNT_IN_BEATS;
                if !ok {
                    return invalid(format!(
                        "カウント ({} 拍、1 拍 {} 秒) は使えない",
                        count.beats, count.beat_sec
                    ));
                }
                let beat_frames = count.beat_sec * rate;
                Some(CountInFrames {
                    beats: count.beats,
                    beat_frames,
                    total: ((count.beats as f64 * beat_frames).round() as u64).max(1),
                })
            }
            _ => None,
        };
        self.send(Command::Play(PlayCommand {
            token: options.token,
            from: frame(options.from_sec.max(0.0)),
            loop_range,
            count_in,
            metronome: options.metronome,
        }))
    }

    /// 止めて、鳴っている曲の音を消す (鍵盤の試聴の声は止めない)。
    pub fn stop(&mut self) -> Result<(), TransportError> {
        self.send(Command::Stop)
    }

    /// トラック (`track` は engine の中の 0 始まりの番号) の音量 (dB)・パン・鳴らすかを変える。
    /// engine に無い番号は無視される。
    pub fn set_track(
        &mut self,
        track: usize,
        gain_db: f32,
        pan: f32,
        audible: bool,
    ) -> Result<(), TransportError> {
        if gain_db.is_nan() || pan.is_nan() {
            return Err(TransportError::Invalid(
                "トラックの音量かパンが数値でない".into(),
            ));
        }
        self.send(Command::SetTrack {
            track,
            gain_db,
            pan,
            audible,
        })
    }

    /// メトロノームを鳴らすかを変える。
    pub fn set_metronome(&mut self, enabled: bool) -> Result<(), TransportError> {
        self.send(Command::SetMetronome(enabled))
    }

    /// 鍵盤の試聴: 押す。同じ高さがすでに鳴っていたら、鳴らし直す。再生していなくても鳴る。
    pub fn live_note_on(&mut self, pitch: u8, velocity: u8) -> Result<(), TransportError> {
        if pitch > 127 {
            return Err(TransportError::Invalid(format!(
                "ノート番号 {pitch} は使えない"
            )));
        }
        self.send(Command::LiveNoteOn { pitch, velocity })
    }

    /// 鍵盤の試聴: 離す。鳴っていなければ何も起きない。
    pub fn live_note_off(&mut self, pitch: u8) -> Result<(), TransportError> {
        self.send(Command::LiveNoteOff { pitch })
    }

    /// 鍵盤の試聴: 押している音をすべて離す。
    pub fn live_all_off(&mut self) -> Result<(), TransportError> {
        self.send(Command::LiveAllOff)
    }

    /// 音声スレッドが送り返してきた古い engine を、ここ (呼んだスレッド) で捨てる。
    /// 捨てた数を返す。ときどき呼ぶ (呼ばなくても、次の [`Controller::set_song`] が捨てる)。
    pub fn collect_garbage(&mut self) -> usize {
        let mut dropped = 0;
        while let Ok(engine) = self.garbage.pop() {
            drop(engine);
            dropped += 1;
        }
        dropped
    }

    /// いちばん新しいブロックの頭の状態。
    pub fn position(&self) -> PlaybackPosition {
        self.shared.read(self.sample_rate)
    }

    /// 位置を読む口 (別のスレッドへ渡せる)。
    pub fn position_reader(&self) -> PositionReader {
        PositionReader {
            sample_rate: self.sample_rate,
            shared: Arc::clone(&self.shared),
        }
    }

    fn send(&mut self, command: Command) -> Result<(), TransportError> {
        if self.commands.is_abandoned() {
            return Err(TransportError::Disconnected);
        }
        // 積めなかった指示 (engine を含むことが在る) は、ここで捨てる
        self.commands
            .push(command)
            .map_err(|PushError::Full(_)| TransportError::QueueFull)
    }
}

impl PositionReader {
    /// いちばん新しいブロックの頭の状態。
    pub fn read(&self) -> PlaybackPosition {
        self.shared.read(self.sample_rate)
    }
}

impl Shared {
    fn read(&self, sample_rate: u32) -> PlaybackPosition {
        let cell = &self.position;
        loop {
            let before = cell.seq.load(Ordering::SeqCst);
            if before & 1 == 1 {
                // 書いている最中。すぐ終わるので、回って待つ
                std::hint::spin_loop();
                continue;
            }
            let token = cell.token.load(Ordering::SeqCst);
            let frame = cell.frame.load(Ordering::SeqCst);
            let pass = cell.pass.load(Ordering::SeqCst);
            let flags = cell.flags.load(Ordering::SeqCst);
            let count_remaining = cell.count_remaining.load(Ordering::SeqCst);
            let at_nanos = cell.at_nanos.load(Ordering::SeqCst);
            if cell.seq.load(Ordering::SeqCst) != before {
                continue;
            }
            return PlaybackPosition {
                token,
                playing: flags & FLAG_PLAYING != 0,
                counting_in: flags & FLAG_COUNTING_IN != 0,
                count_in_remaining_frames: count_remaining,
                count_in_remaining_sec: count_remaining as f64 / sample_rate as f64,
                frame,
                position_sec: frame as f64 / sample_rate as f64,
                pass,
                at: self.epoch + Duration::from_nanos(at_nanos),
            };
        }
    }
}

impl Transport {
    /// 出力のサンプリング周波数 (Hz)。
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// `left.len()` フレームぶんの音を作る。`left` と `right` は同じ長さ。中身は上書きする。
    ///
    /// 音声デバイスのコールバックから、1 回につき 1 度呼ぶ (位置と一緒に公開する時刻が、
    /// 呼ばれた時刻になる)。長さに上限は無い。
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        assert_eq!(left.len(), right.len(), "左右の長さが違う");
        let now = self.shared.epoch.elapsed();
        left.fill(0.0);
        right.fill(0.0);

        self.receive();
        self.publish(now);
        let mut done = 0;
        while done < left.len() {
            let len = self.segment_len(left.len() - done);
            self.render(&mut left[done..done + len], &mut right[done..done + len]);
            done += len;
            // 下げきってから行う指示が済んだら、待たせていた続きを受け取る
            self.receive();
        }
    }

    /// 届いている指示を受け取る。下げきるのを待っている指示が在るあいだは、受け取らない。
    fn receive(&mut self) {
        while self.pending.is_none() {
            let Ok(command) = self.commands.pop() else {
                break;
            };
            let discontinuity = matches!(
                command,
                Command::SetSong { .. } | Command::Play(_) | Command::Stop
            );
            if discontinuity && self.song_sounding() {
                // 曲の音が途切れる指示は、先に音を下げきってから行う
                self.pending = Some(command);
                self.fade_out_left = self.fade_frames;
            } else {
                self.apply(command);
            }
        }
    }

    /// 曲の音 (engine の出力) を作っているか。
    fn song_sounding(&self) -> bool {
        self.playing && self.count.is_none() && self.engine.is_some()
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::SetSong { engine, grid } => {
                self.grid = grid;
                if let Some(old) = self.engine.replace(engine) {
                    self.discard(old);
                }
                // 再生中なら、同じ位置から続ける (カウントの最中は、曲が始まるときに位置を合わせる)
                if self.playing && self.count.is_none() {
                    self.start_song();
                }
            }
            Command::Play(play) => {
                self.playing = true;
                self.token = play.token;
                self.metronome = play.metronome;
                self.loop_range = play.loop_range;
                self.pass = 0;
                self.position = match play.loop_range {
                    Some((start, end)) if !(start..end).contains(&play.from) => start,
                    _ => play.from,
                };
                self.count = play.count_in.map(|count| (count, 0));
                if self.count.is_none() {
                    self.start_song();
                }
            }
            Command::Stop => {
                self.playing = false;
                self.count = None;
                if let Some(engine) = self.engine.as_mut() {
                    engine.silence();
                }
            }
            Command::SetTrack {
                track,
                gain_db,
                pan,
                audible,
            } => {
                if let Some(engine) = self.engine.as_mut() {
                    engine.set_track_mix(track, gain_db, pan);
                    engine.set_track_audible(track, audible);
                }
            }
            Command::SetMetronome(enabled) => self.metronome = enabled,
            Command::LiveNoteOn { pitch, velocity } => {
                self.live.note_off(0, pitch);
                self.live.note_on(0, pitch, velocity);
            }
            Command::LiveNoteOff { pitch } => self.live.note_off(0, pitch),
            Command::LiveAllOff => self.live.all_notes_off(0),
        }
    }

    /// 曲を、いまの位置から鳴らし始める (engine の位置を合わせ、音を 0 から上げる)。
    fn start_song(&mut self) {
        if let Some(engine) = self.engine.as_mut() {
            engine.seek(self.position);
        }
        self.edge_frames = match self.loop_range {
            // 短い区間では、上げ下げが区間の 1/4 を超えないようにする (画面側と同じ)
            Some((start, end)) => (self.fade_frames as u64).min((end - start) / 4).max(1) as u32,
            None => self.fade_frames,
        };
        // 曲の頭 (0 フレーム) からの、ループでない再生は上げない。頭ちょうどに在るアタック
        // (取り込んだ曲の最初の音) を弱めないため。それより前に音は無いので、不連続にもならない
        self.since_start = if self.loop_range.is_none() && self.position == 0 {
            self.edge_frames
        } else {
            0
        };
    }

    /// 古い engine を、捨てる側へ送り返す (音声スレッドでは捨てない)。
    fn discard(&mut self, engine: Box<Engine>) {
        if let Err(PushError::Full(engine)) = self.garbage.push(engine) {
            // 送り返す先が一杯 (キューの長さの決め方から、起きないはず)。ここで捨てると
            // メモリの解放で音が途切れるので、捨てずに置き去りにする
            debug_assert!(false, "古い engine を送り返せなかった");
            std::mem::forget(engine);
        }
    }

    /// ブロックの頭の状態を公開する。
    fn publish(&self, now: Duration) {
        let cell = &self.shared.position;
        let mut flags = 0;
        if self.playing {
            flags |= FLAG_PLAYING;
        }
        let mut count_remaining = 0;
        if let Some((count, done)) = &self.count {
            flags |= FLAG_COUNTING_IN;
            count_remaining = count.total.saturating_sub(*done);
        }
        let seq = cell.seq.load(Ordering::SeqCst);
        cell.seq.store(seq.wrapping_add(1), Ordering::SeqCst);
        cell.token.store(self.token, Ordering::SeqCst);
        cell.frame.store(self.position, Ordering::SeqCst);
        cell.pass.store(self.pass, Ordering::SeqCst);
        cell.flags.store(flags, Ordering::SeqCst);
        cell.count_remaining
            .store(count_remaining, Ordering::SeqCst);
        cell.at_nanos.store(
            now.as_nanos().min(u64::MAX as u128) as u64,
            Ordering::SeqCst,
        );
        cell.seq.store(seq.wrapping_add(2), Ordering::SeqCst);
    }

    /// 次に、状態を変えずに続けて作れる長さ (フレーム。1 以上 `remaining` 以下)。
    /// 区間の終わり・カウントの終わり・下げきる位置で区切る。
    fn segment_len(&self, remaining: usize) -> usize {
        let mut len = remaining.min(SEGMENT) as u64;
        if self.pending.is_some() {
            len = len.min(self.fade_out_left as u64);
        }
        if self.playing {
            if let Some((count, done)) = &self.count {
                len = len.min(count.total - done);
            } else if let Some((_, end)) = self.loop_range {
                len = len.min(end - self.position);
            }
        }
        len.max(1) as usize
    }

    /// 状態が変わらない 1 区切りの音を `left` / `right` に足し (呼ぶ前に 0 にしてある)、状態を進める。
    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let len = left.len();
        let rate = self.sample_rate;

        if self.playing {
            if let Some((count, done)) = &self.count {
                // 録音前のカウント: 曲を進めずに、クリックだけを鳴らす
                let (from, to) = (*done as f64, (*done + len as u64) as f64);
                let first = ((from / count.beat_frames).floor() as u32).saturating_sub(1);
                for beat in first..count.beats {
                    let frame = (beat as f64 * count.beat_frames).round();
                    if frame >= to {
                        break;
                    }
                    if frame >= from {
                        self.clicks.trigger((frame - from) as usize, beat == 0);
                    }
                }
            } else {
                self.render_song(left, right);
                // 止める・鳴らし直す前の下げのあいだ (4ms) に来た拍は、鳴らさない
                let ending = matches!(self.pending, Some(Command::Stop | Command::Play(_)));
                if self.metronome && !ending {
                    let clicks = &mut self.clicks;
                    self.grid
                        .for_beats(self.position, len, rate, |delay, accent| {
                            clicks.trigger(delay, accent)
                        });
                }
            }
        }
        self.clicks.render_add(left, right);

        // 鍵盤の試聴 (左右に同じ音)
        if self.live.active_voices() > 0 {
            let mono = &mut self.mono[..len];
            self.live.render(mono);
            for ((l, r), m) in left.iter_mut().zip(right.iter_mut()).zip(mono.iter()) {
                *l += m;
                *r += m;
            }
        }

        // 状態を進める
        if self.playing {
            if let Some((count, done)) = self.count.as_mut() {
                *done += len as u64;
                if *done >= count.total {
                    self.count = None;
                    self.start_song();
                }
            } else {
                self.position += len as u64;
                self.since_start = self
                    .since_start
                    .saturating_add(len as u32)
                    .min(self.edge_frames);
                if let Some((start, end)) = self.loop_range {
                    if self.position >= end {
                        // 区間の終わり: ちょうど頭へ戻る
                        self.position = start;
                        self.pass += 1;
                        self.start_song();
                    }
                }
            }
        }
        if self.pending.is_some() {
            self.fade_out_left = self.fade_out_left.saturating_sub(len as u32);
            if self.fade_out_left == 0 {
                if let Some(command) = self.pending.take() {
                    self.apply(command);
                }
            }
        }
    }

    /// 曲の音 (engine の出力) を作り、つなぎ目の上げ下げを掛けて足す。
    fn render_song(&mut self, left: &mut [f32], right: &mut [f32]) {
        let len = left.len();
        let Some(engine) = self.engine.as_mut() else {
            return;
        };
        let song_left = &mut self.song_left[..len];
        let song_right = &mut self.song_right[..len];
        engine.process(song_left, song_right);

        let edge = self.edge_frames;
        // 区間の終わりまでの残り (この区切りの頭で)。ループでなければ、下げは無い
        let to_loop_end = self
            .loop_range
            .map(|(_, end)| end - self.position)
            .unwrap_or(u64::MAX);
        let fading_out = self.pending.is_some();
        let steady =
            self.since_start >= edge && to_loop_end >= len as u64 + edge as u64 && !fading_out;
        let frames = left.iter_mut().zip(right.iter_mut());
        let song = song_left.iter().zip(song_right.iter());
        if steady {
            // 上げ下げの外: そのまま足す (1 ビットも変えない)
            for ((l, r), (sl, sr)) in frames.zip(song) {
                *l += sl;
                *r += sr;
            }
            return;
        }
        let (since_start, fade_frames, fade_out_left) =
            (self.since_start, self.fade_frames, self.fade_out_left);
        for (i, ((l, r), (sl, sr))) in frames.zip(song).enumerate() {
            let mut gain = 1.0f32;
            // 鳴らし始めの上げ: 最初のフレームが 0
            let risen = since_start as u64 + i as u64;
            if risen < edge as u64 {
                gain = gain.min(risen as f32 / edge as f32);
            }
            // 区間の終わりの下げ: 終わりのフレーム (次の周の頭) が 0
            let left_in_loop = to_loop_end.saturating_sub(i as u64);
            if left_in_loop < edge as u64 {
                gain = gain.min(left_in_loop as f32 / edge as f32);
            }
            // 停止・鳴らし直し・差し替えの前の下げ: 最後のフレームが 0
            if fading_out {
                let left_to_fade = (fade_out_left as u64).saturating_sub(i as u64 + 1);
                gain = gain.min(left_to_fade as f32 / fade_frames as f32);
            }
            *l += sl * gain;
            *r += sr * gain;
        }
    }
}

/// クリックの声 1 つ。
#[derive(Debug, Clone, Copy)]
struct ClickVoice {
    /// 残りの長さ (フレーム)。0 なら鳴っていない
    left: u32,
    /// 次のブロックの頭から数えて、鳴り始めるまでのフレーム数
    delay: u32,
    phase: f64,
    step: f64,
    level: f32,
}

/// メトロノームとカウントのクリック (正弦波。指数で減る)。
struct Clicks {
    voices: [ClickVoice; CLICK_VOICES],
    sample_rate: f64,
    /// クリックの長さ (フレーム)
    frames: u32,
    /// 1 フレームごとに山の高さに掛ける値
    decay: f32,
    /// 声が空いていないときに、次に使う声
    next: usize,
}

impl Clicks {
    fn new(sample_rate: u32) -> Self {
        let frames = ((sample_rate as f64 * CLICK_SEC).round() as u32).max(1);
        let decay = ((CLICK_END_LEVEL / CLICK_LEVEL) as f64).powf(1.0 / frames as f64) as f32;
        Clicks {
            voices: [ClickVoice {
                left: 0,
                delay: 0,
                phase: 0.0,
                step: 0.0,
                level: 0.0,
            }; CLICK_VOICES],
            sample_rate: sample_rate as f64,
            frames,
            decay,
            next: 0,
        }
    }

    /// クリックを鳴らす。`delay` は次の `render_add` のブロックの頭からのフレーム数。
    fn trigger(&mut self, delay: usize, accent: bool) {
        let index = self
            .voices
            .iter()
            .position(|v| v.left == 0)
            .unwrap_or(self.next);
        self.next = (index + 1) % CLICK_VOICES;
        let hz = if accent { CLICK_ACCENT_HZ } else { CLICK_HZ };
        self.voices[index] = ClickVoice {
            left: self.frames,
            delay: delay.min(u32::MAX as usize) as u32,
            phase: 0.0,
            step: hz / self.sample_rate,
            level: CLICK_LEVEL,
        };
    }

    /// 鳴っているクリックを、左右に同じ大きさで足す。
    fn render_add(&mut self, left: &mut [f32], right: &mut [f32]) {
        let len = left.len();
        let decay = self.decay;
        for voice in self.voices.iter_mut().filter(|v| v.left > 0) {
            let start = voice.delay as usize;
            voice.delay = voice
                .delay
                .saturating_sub(len.min(u32::MAX as usize) as u32);
            for (l, r) in left.iter_mut().zip(right.iter_mut()).skip(start) {
                if voice.left == 0 {
                    break;
                }
                let sample = (voice.phase * TAU).sin() as f32 * voice.level;
                *l += sample;
                *r += sample;
                voice.phase += voice.step;
                if voice.phase >= 1.0 {
                    voice.phase -= 1.0;
                }
                voice.level *= decay;
                voice.left -= 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    fn beats(grid: &Grid, pos: u64, len: usize) -> Vec<(usize, bool)> {
        let mut found = Vec::new();
        BeatGrid::from(grid).for_beats(pos, len, SR, |delay, accent| found.push((delay, accent)));
        found
    }

    #[test]
    fn 拍は一小節目の位置から同じ間隔で並ぶ() {
        // 120 BPM: 1 拍 = 24000 フレーム。4 拍子
        let grid = Grid::default();
        assert_eq!(beats(&grid, 0, 256), vec![(0, true)]);
        assert_eq!(beats(&grid, 1, 256), vec![]);
        assert_eq!(beats(&grid, 23_900, 256), vec![(100, false)]);
        // 範囲の終わりちょうどの拍は、次の範囲のもの
        assert_eq!(beats(&grid, 23_744, 256), vec![]);
        assert_eq!(beats(&grid, 24_000, 256), vec![(0, false)]);
        // 5 拍目は次の小節の 1 拍目
        assert_eq!(beats(&grid, 96_000 - 10, 256), vec![(10, true)]);
        // 長い範囲には、拍がいくつも入る
        assert_eq!(
            beats(&grid, 0, 96_001),
            vec![
                (0, true),
                (24_000, false),
                (48_000, false),
                (72_000, false),
                (96_000, true)
            ]
        );
    }

    #[test]
    fn 一小節目より前の拍も同じ間隔で鳴り小節の頭は負の側でも合う() {
        // 1 小節目が 1.25 秒 (60000 フレーム)。3 拍子
        let grid = Grid {
            bpm: 120.0,
            offset_sec: 1.25,
            beats_per_bar: 3,
        };
        // 0 秒より後ろの最初の拍は k = -2 (12000 フレーム)。k = -3 (-12000) は鳴らない
        assert_eq!(
            beats(&grid, 0, 60_001),
            vec![(12_000, false), (36_000, false), (60_000, true)]
        );
        // k = -3 が小節の頭になる位置
        let grid = Grid {
            offset_sec: 1.75,
            ..grid
        };
        assert_eq!(
            beats(&grid, 0, 40_000),
            vec![(12_000, true), (36_000, false)]
        );
    }

    #[test]
    fn 割り切れないテンポでも拍はノートと同じフレームに来る() {
        let grid = Grid {
            bpm: 97.3,
            offset_sec: 0.123,
            beats_per_bar: 4,
        };
        let song = crate::Song {
            bpm: grid.bpm,
            offset_sec: grid.offset_sec,
            ..crate::Song::default()
        };
        let found = beats(&grid, 0, SR as usize * 20);
        assert!(found.len() > 30);
        for (k, (frame, accent)) in found.iter().enumerate() {
            let tick = k as u64 * crate::TICKS_PER_BEAT;
            assert_eq!(*frame as i64, song.tick_to_frame(tick, SR), "k={k}");
            assert_eq!(*accent, k % 4 == 0);
        }
        // 細かく区切っても、同じ拍が 1 回ずつ見つかる
        let mut pieces = Vec::new();
        let mut pos = 0u64;
        for len in [1usize, 63, 64, 257, 1000].iter().cycle() {
            if pos >= SR as u64 * 20 {
                break;
            }
            let len = (*len as u64).min(SR as u64 * 20 - pos) as usize;
            pieces.extend(
                beats(&grid, pos, len)
                    .into_iter()
                    .map(|(delay, accent)| (pos as usize + delay, accent)),
            );
            pos += len as u64;
        }
        assert_eq!(pieces, found);
    }

    #[test]
    fn クリックは決まった高さと長さで指数で減る() {
        let mut clicks = Clicks::new(SR);
        clicks.trigger(100, true);
        let (mut l, mut r) = (vec![0f32; 4800], vec![0f32; 4800]);
        clicks.render_add(&mut l, &mut r);
        assert_eq!(l, r);
        assert!(l[..=100].iter().all(|v| *v == 0.0));
        // 50ms (2400 フレーム) で終わる
        assert!(l[100 + 2400..].iter().all(|v| *v == 0.0));
        // 1500Hz: 上向きのゼロ交差が 50ms で 75 回
        let crossings = l.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((74..=76).contains(&crossings), "{crossings}");
        // 鳴り始めの山は 0.3 に近く、終わりぎわは 0.001 に近い
        let peak = |x: &[f32]| x.iter().fold(0f32, |m, v| m.max(v.abs()));
        let head = peak(&l[100..140]);
        assert!((0.27..=0.3).contains(&head), "{head}");
        let tail = peak(&l[100 + 2360..100 + 2400]);
        assert!((0.0009..0.0012).contains(&tail), "{tail}");
        // 半分の時間で、山は幾何平均 (√(0.3 × 0.001) ≒ 0.0173) になる
        let middle = peak(&l[100 + 1180..100 + 1220]);
        assert!((0.016..0.019).contains(&middle), "{middle}");
    }

    #[test]
    fn 範囲の外の値は指示にしない() {
        let (mut controller, _transport) = transport(SR).unwrap();
        let play = |c: &mut Controller, options: PlayOptions| c.play(&options);
        let base = PlayOptions::default();
        for from_sec in [f64::NAN, f64::INFINITY, 1e9] {
            let result = play(&mut controller, PlayOptions { from_sec, ..base });
            assert!(
                matches!(result, Err(TransportError::Invalid(_))),
                "{from_sec}"
            );
        }
        for loop_range in [(1.0, 1.0), (2.0, 1.0), (-1.0, 1.0), (0.0, f64::NAN)] {
            let options = PlayOptions {
                loop_range: Some(loop_range),
                ..base
            };
            assert!(
                matches!(
                    play(&mut controller, options),
                    Err(TransportError::Invalid(_))
                ),
                "{loop_range:?}"
            );
        }
        for (beats, beat_sec) in [(4, 0.0), (4, f64::NAN), (4, 1000.0), (1000, 0.5)] {
            let options = PlayOptions {
                count_in: Some(CountIn { beats, beat_sec }),
                ..base
            };
            assert!(
                matches!(
                    play(&mut controller, options),
                    Err(TransportError::Invalid(_))
                ),
                "{beats} {beat_sec}"
            );
        }
        // 0 拍のカウントは「カウント無し」
        let options = PlayOptions {
            count_in: Some(CountIn {
                beats: 0,
                beat_sec: f64::NAN,
            }),
            ..base
        };
        assert_eq!(play(&mut controller, options), Ok(()));
        assert!(matches!(
            controller.set_track(0, f32::NAN, 0.0, true),
            Err(TransportError::Invalid(_))
        ));
        assert!(matches!(
            controller.live_note_on(128, 100),
            Err(TransportError::Invalid(_))
        ));
        assert!(transport(0).is_err());
    }

    #[test]
    fn 音声スレッドの側が居なくなったら指示は失敗する() {
        let (mut controller, transport) = transport(SR).unwrap();
        assert_eq!(controller.stop(), Ok(()));
        drop(transport);
        assert_eq!(controller.stop(), Err(TransportError::Disconnected));
    }

    #[test]
    fn 指示が溜まりすぎたら失敗する() {
        let (mut controller, _transport) = transport(SR).unwrap();
        for _ in 0..COMMAND_CAPACITY {
            assert_eq!(controller.set_metronome(true), Ok(()));
        }
        assert_eq!(
            controller.set_metronome(true),
            Err(TransportError::QueueFull)
        );
    }

    #[test]
    fn 両側をスレッドへ移せる() {
        fn assert_send<T: Send>() {}
        assert_send::<Transport>();
        assert_send::<Controller>();
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<PositionReader>();
    }
}
