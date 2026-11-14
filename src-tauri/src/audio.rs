//! 音の再生。画面の再生・停止・位置・区間ループ・メトロノーム・録音前のカウント・鍵盤の試聴を、
//! ネイティブの engine (`bunri-audio`) で鳴らす。
//!
//! ここは Tauri の command / event と engine をつなぐだけで、音は作らない。
//!
//! - 音を作るのは `bunri_audio::Engine`、再生の状態を進めるのは `bunri_audio::Transport`
//!   (どちらも音声スレッドの中)。デバイスへ出すのは `bunri_audio::output` (cpal)
//! - 画面からの指示は、`bunri_audio::Controller` がロックの無いキューに積む。音声スレッドは
//!   ロックを取らない
//! - 曲の内容は、再生を始める前に画面が丸ごと渡す ([`audio_set_song`])。engine の組み立ては
//!   音声スレッドの外で済ませ、出来上がったものを差し替える。古い engine も音声スレッドの外で捨てる
//! - クリップの音声は、画面がデコードした PCM を先に受け取っておく ([`audio_clip_put`])。
//!   engine の周波数への変換は一度だけ行い、変換したものを覚えておく
//! - 再生位置は、専用のスレッドが event [`POSITION_EVENT`] で画面へ送る
//! - デバイスが外れるなどして出力が使えなくなったら、次の command で開き直す。周波数が変わることが
//!   在るので、engine も作り直す (そのために、最後に渡された曲を覚えておく)
//!
//! command の名前と引数、event の形、音の決まりは、画面側 (`web-ui/src/lib`) との取り決め。
//! 変えるときは、両側を一緒に変える。設計は `docs/instrument-engine-design.md`。

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bunri_audio::output::OutputDevice;
use bunri_audio::{
    AudioData, Clip, Controller, CountIn, Engine, EngineConfig, Grid, Instrument, Note,
    PlayOptions, PlaybackPosition, PositionReader, Song, Track, DEFAULT_VELOCITY,
};
use serde::{Deserialize, Deserializer, Serialize};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Runtime, State, WebviewWindow};

/// 再生位置を知らせる event の名前。中身は [`PositionEvent`]。
pub const POSITION_EVENT: &str = "audio://position";

/// 再生中に位置を送る間隔 (1 秒に 30 回ほど)。
const POSITION_INTERVAL: Duration = Duration::from_millis(33);
/// 再生・停止の指示のあと、音声スレッドが受け取ったかを見に行く間隔と、見に行き続ける長さ
/// (始まり・止まりを、遅れずに知らせるため)。
const KICK_INTERVAL: Duration = Duration::from_millis(4);
const KICK_WINDOW: Duration = Duration::from_millis(300);
/// 再生を頼んだのに、音声スレッドがまだ受け取っていないあいだ、見に行く間隔と、見に行き続ける長さ。
/// 開き直した直後のデバイス (Bluetooth など) は、最初のコールバックまで時間がかかることが在る。
/// そのあいだに眠ってしまうと、始まっても event が 1 つも出ない
const AWAIT_INTERVAL: Duration = Duration::from_millis(50);
const AWAIT_LIMIT: Duration = Duration::from_secs(5);

/// 位置を送るスレッドが、見に行く間隔。テストでは短くする。
#[derive(Debug, Clone, Copy)]
struct ReportTimings {
    /// 再生中に位置を送る間隔
    interval: Duration,
    /// 指示のあと、細かく見に行く間隔と長さ
    kick_interval: Duration,
    kick_window: Duration,
    /// 頼んだ再生が始まるのを待つあいだ、見に行く間隔と、待つ長さの上限
    await_interval: Duration,
    await_limit: Duration,
}

impl Default for ReportTimings {
    fn default() -> Self {
        ReportTimings {
            interval: POSITION_INTERVAL,
            kick_interval: KICK_INTERVAL,
            kick_window: KICK_WINDOW,
            await_interval: AWAIT_INTERVAL,
            await_limit: AWAIT_LIMIT,
        }
    }
}

/// 音声 1 本の大きさの上限 (バイト。float32 のサンプル)。48kHz のステレオで約 93 分。
/// 壊れたヘッダで、巨大なメモリを確保しないようにする
const MAX_CLIP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 1 回に受け取る塊の上限 (バイト)。画面は 8MB 程度までに分けて送る
const MAX_CHUNK_BYTES: usize = 32 * 1024 * 1024;

// ---- 画面から受け取る形 ----

/// 曲の内容 ([`audio_set_song`])。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongPayload {
    /// テンポ (速度を掛けたあとの値)
    bpm: f64,
    /// 1 小節目の 1 拍目の位置 (秒。負のことも在る)
    offset_sec: f64,
    /// 拍子 (メトロノームの 1 拍目を決める)
    beats_per_bar: f64,
    tracks: Vec<TrackPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackPayload {
    /// 画面のトラック ID
    id: f64,
    #[serde(deserialize_with = "db_or_silent")]
    gain_db: f64,
    pan: f64,
    /// ミュート・ソロ・「聴く」・トラック単体の再生を、画面が判定した結果
    audible: bool,
    #[serde(default)]
    notes: Vec<NotePayload>,
    #[serde(default)]
    clips: Vec<ClipPayload>,
}

#[derive(Debug, Clone, Deserialize)]
struct NotePayload {
    /// 位置と長さ (ティック。1 拍 = 960)
    start: f64,
    length: f64,
    /// MIDI ノート番号
    pitch: f64,
    /// 強さ (1〜127)。無ければ 96
    velocity: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipPayload {
    /// [`audio_clip_put`] で送った音声の id
    clip: f64,
    /// 置く位置 (秒)
    start_sec: f64,
}

/// 区間ループ ([`audio_play`])。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopPayload {
    start_sec: f64,
    end_sec: f64,
}

/// 録音前のカウント ([`audio_play`])。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountInPayload {
    beats: f64,
    beat_sec: f64,
}

/// 音量 (dB)。JavaScript の `-Infinity` (音量 0) は JSON では `null` になるので、無音として受け取る。
fn db_or_silent<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(deserializer)?.unwrap_or(f64::NEG_INFINITY))
}

// ---- 画面へ返す形 ----

/// [`audio_init`] の結果。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    /// 出力のサンプリング周波数 (Hz)
    sample_rate: u32,
    /// 音を作ってから耳に届くまでの遅れの見積もり (秒。バッファの長さ + デバイスの遅れ)
    output_latency_sec: f64,
}

/// [`audio_clip_put`] の結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ClipPutResult {
    /// 音声が全部そろったか
    complete: bool,
}

/// event [`POSITION_EVENT`] の中身。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionEvent {
    /// [`audio_play`] の token
    token: u64,
    playing: bool,
    /// 録音前のカウントの最中 (`position_sec` は始める位置のまま)
    counting_in: bool,
    /// `at_ms` の時点で音声スレッドが作っていた位置 (秒)。区間ループでは区間の中の位置
    position_sec: f64,
    /// `position_sec` を測った時刻 (Unix エポックからのミリ秒)
    at_ms: f64,
    /// 区間ループの何周目か (0 始まり)
    pass: u64,
    /// `at_ms` の時点で、カウントが終わって曲が始まるまでの残り (秒)。カウントの最中でなければ 0。
    /// 画面は、`at_ms` からこの長さが過ぎたら、次の event を待たずに「曲が始まった」として
    /// 位置を「始める位置 + 過ぎたぶん」で補える (カウントの終わりを、event の間隔ぶん遅れて知らない)
    count_in_remaining_sec: f64,
}

// ---- 曲の組み立て (Tauri 抜きで試せる部分) ----

/// 画面から受け取った曲を、engine に渡す形にしたもの。
struct BuiltSong {
    song: Song,
    grid: Grid,
    /// engine の中のトラックの番号 → 画面のトラック ID
    track_ids: Vec<i64>,
}

/// 整数として届くはずの値 (ID・ティック) を確かめる。
fn whole(value: f64, what: &str) -> Result<i64, String> {
    // 2^53 までは、f64 が整数をそのまま表せる
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        Ok(value as i64)
    } else {
        Err(format!("{what} が整数ではありません: {value}"))
    }
}

/// 画面から受け取った曲を、engine に渡す形にする。`clip` は、id から音声を引く。
///
/// - ノートの在るトラックには、仮の音 (三角波) を当てる (楽器の素材が入るまで)
/// - 鳴らすかは画面が決めてあるので、鳴らさないトラックはミュートとして渡す (ソロは使わない)
/// - 鳴らせないノート (長さが 0、高さが範囲の外) は、engine が飛ばす。ここでは、数値でない値だけを断る
fn build_song(
    payload: &SongPayload,
    clip: impl Fn(u32) -> Option<Arc<AudioData>>,
) -> Result<BuiltSong, String> {
    let beats_per_bar = payload.beats_per_bar.round();
    if !(1.0..=1024.0).contains(&beats_per_bar) {
        return Err(format!("拍子が正しくありません: {}", payload.beats_per_bar));
    }
    let mut tracks = Vec::with_capacity(payload.tracks.len());
    let mut track_ids = Vec::with_capacity(payload.tracks.len());
    for (index, track) in payload.tracks.iter().enumerate() {
        let label = format!("トラック {}", index + 1);
        track_ids.push(whole(track.id, &format!("{label} の ID"))?);

        let mut notes = Vec::with_capacity(track.notes.len());
        for note in &track.notes {
            let values = [note.start, note.length, note.pitch];
            let velocity = note.velocity.unwrap_or(DEFAULT_VELOCITY as f64);
            if values.iter().any(|v| !v.is_finite()) || !velocity.is_finite() {
                return Err(format!("{label} のノートに数値でない値が在ります"));
            }
            if note.start < 0.0 || note.length <= 0.0 || !(0.0..=127.0).contains(&note.pitch) {
                continue;
            }
            notes.push(Note {
                start: note.start.round() as u64,
                length: note.length.round() as u64,
                pitch: note.pitch.round() as u8,
                velocity: velocity.round().clamp(1.0, 127.0) as u8,
            });
        }

        let mut clips = Vec::with_capacity(track.clips.len());
        for placed in &track.clips {
            let id = whole(placed.clip, &format!("{label} のクリップの ID"))?;
            let audio = u32::try_from(id)
                .ok()
                .and_then(&clip)
                .ok_or_else(|| format!("クリップ {id} の音声がまだ届いていません"))?;
            clips.push(Clip {
                audio,
                start_sec: placed.start_sec,
            });
        }

        tracks.push(Track {
            instrument: (!notes.is_empty()).then_some(Instrument::Tone),
            notes,
            clips,
            gain_db: track.gain_db as f32,
            pan: track.pan as f32,
            mute: !track.audible,
            solo: false,
        });
    }
    Ok(BuiltSong {
        song: Song {
            bpm: payload.bpm,
            offset_sec: payload.offset_sec,
            tracks,
            master_gain_db: 0.0,
        },
        grid: Grid {
            bpm: payload.bpm,
            offset_sec: payload.offset_sec,
            beats_per_bar: beats_per_bar as u32,
        },
        track_ids,
    })
}

// ---- クリップの音声の置き場 ----

/// [`audio_clip_put`] の 1 回ぶん。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClipChunk<'a> {
    id: u32,
    sample_rate: u32,
    channels: usize,
    /// 音声の全体のフレーム数
    frames: usize,
    /// この塊の先頭のフレーム位置
    offset: usize,
    /// Float32 リトルエンディアン。チャンネルごとに並ぶ
    body: &'a [u8],
}

/// 受け取っている途中の音声。
struct PendingClip {
    sample_rate: u32,
    frames: usize,
    channels: Vec<Vec<f32>>,
}

/// クリップの音声 (id → 音声) と、受け取っている途中のもの。
#[derive(Default)]
struct ClipStore {
    ready: HashMap<u32, Arc<AudioData>>,
    pending: HashMap<u32, PendingClip>,
}

impl ClipStore {
    /// 塊を 1 つ受け取る。音声が全部そろったら `true`。
    ///
    /// 塊は先頭から順に、重ならずに届く約束。位置 0 の塊が来たら、その id を最初からやり直す。
    /// 約束に合わない塊は断り、受け取りかけを捨てる (次は位置 0 から送り直してもらう)。
    fn put(&mut self, chunk: ClipChunk<'_>) -> Result<bool, String> {
        if chunk.id == 0 {
            return Err("クリップの ID は 1 以上です".into());
        }
        if !(1..=2).contains(&chunk.channels) {
            return Err(format!(
                "チャンネル数 {} の音声は受け取れません (1 か 2)",
                chunk.channels
            ));
        }
        if !bunri_audio::audio::SAMPLE_RATE_RANGE.contains(&chunk.sample_rate) {
            return Err(format!(
                "サンプリング周波数 {}Hz の音声は受け取れません",
                chunk.sample_rate
            ));
        }
        let frame_bytes = chunk.channels * 4;
        if (chunk.frames as u64).saturating_mul(frame_bytes as u64) > MAX_CLIP_BYTES {
            return Err(format!("音声が長すぎます ({} フレーム)", chunk.frames));
        }
        if chunk.body.len() > MAX_CHUNK_BYTES || !chunk.body.len().is_multiple_of(frame_bytes) {
            return Err(format!(
                "音声の塊の大きさが正しくありません ({} バイト)",
                chunk.body.len()
            ));
        }
        let count = chunk.body.len() / frame_bytes;

        if chunk.offset == 0 {
            let mut channels = Vec::with_capacity(chunk.channels);
            for _ in 0..chunk.channels {
                let mut samples = Vec::new();
                samples
                    .try_reserve_exact(chunk.frames)
                    .map_err(|_| "音声を置くメモリが足りません".to_string())?;
                channels.push(samples);
            }
            self.pending.insert(
                chunk.id,
                PendingClip {
                    sample_rate: chunk.sample_rate,
                    frames: chunk.frames,
                    channels,
                },
            );
        }
        let Some(pending) = self.pending.get_mut(&chunk.id) else {
            return Err(format!(
                "クリップ {} は、先頭の塊がまだ届いていません",
                chunk.id
            ));
        };
        let filled = pending.channels[0].len();
        let fits = pending.sample_rate == chunk.sample_rate
            && pending.frames == chunk.frames
            && pending.channels.len() == chunk.channels
            && chunk.offset == filled
            && filled + count <= pending.frames;
        if !fits {
            self.pending.remove(&chunk.id);
            return Err(format!(
                "クリップ {} の塊が順番どおりではありません (位置 {}、届いているのは {} フレームまで)",
                chunk.id, chunk.offset, filled
            ));
        }
        for (channel, bytes) in pending
            .channels
            .iter_mut()
            .zip(chunk.body.chunks_exact(count.max(1) * 4))
        {
            let (samples, _) = bytes.as_chunks::<4>();
            channel.extend(samples.iter().map(|b| f32::from_le_bytes(*b)));
        }
        if filled + count < pending.frames {
            return Ok(false);
        }

        let Some(pending) = self.pending.remove(&chunk.id) else {
            return Ok(false);
        };
        let audio = AudioData::new(pending.sample_rate, pending.channels)
            .map_err(|e| format!("クリップ {} の音声を使えません: {e}", chunk.id))?;
        self.ready.insert(chunk.id, Arc::new(audio));
        Ok(true)
    }

    /// もう使わない音声を捨てる (受け取りかけも)。知らない id は無視する。
    fn drop_ids(&mut self, ids: &[i64]) {
        for id in ids.iter().filter_map(|id| u32::try_from(*id).ok()) {
            self.ready.remove(&id);
            self.pending.remove(&id);
        }
    }

    fn get(&self, id: u32) -> Option<Arc<AudioData>> {
        self.ready.get(&id).cloned()
    }
}

// ---- 出力と、位置を送るスレッド ----

/// 開いている出力。持っているあいだ鳴り、捨てると止まる (音声スレッドも止まる)。
///
/// 本物は [`bunri_audio::Output`] (cpal のストリーム)。テストでは、デバイスを開かない代わりのものを使う。
trait OutputPort: Send {
    /// 音を作ってから耳に届くまでの遅れの見積もり (秒)
    fn latency_sec(&self) -> f64;
    /// 出力が使えなくなったか (デバイスが外れたなど) を答える関数
    fn broken(&self) -> Broken;
}

impl OutputPort for bunri_audio::Output {
    fn latency_sec(&self) -> f64 {
        bunri_audio::Output::latency_sec(self)
    }

    fn broken(&self) -> Broken {
        let health = self.health();
        Arc::new(move || health.is_broken())
    }
}

/// 出力を開く関数。開いた出力と、そこへ指示を渡す口を返す。引数は「音を出さないか」。
type Opener = Box<dyn Fn(bool) -> Result<(Box<dyn OutputPort>, Controller), String> + Send + Sync>;

/// 既定の出力デバイスを開き、音声スレッドを始める。`silent` なら、作った音に 0 を掛けてから渡す。
fn open_default_device(silent: bool) -> Result<(Box<dyn OutputPort>, Controller), String> {
    let device = OutputDevice::open_default().map_err(|e| e.to_string())?;
    let (controller, mut transport) =
        bunri_audio::transport(device.sample_rate()).map_err(|e| e.to_string())?;
    let output = device
        .start(move |left, right| {
            transport.process(left, right);
            if silent {
                left.fill(0.0);
                right.fill(0.0);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok((Box::new(output), controller))
}

/// 開いている出力と、そこへ指示を渡す口。
struct Session {
    output: Box<dyn OutputPort>,
    broken: Broken,
    controller: Controller,
    /// いま渡してある曲の、engine の中のトラックの番号 → 画面のトラック ID。曲が無ければ `None`
    track_ids: Option<Vec<i64>>,
    /// 開き直すたびに変わる番号 (曲を組み立てているあいだに開き直されたことに気づくため)
    generation: u64,
}

/// 出力が使えなくなったか (デバイスが外れたなど) を答える関数。
type Broken = Arc<dyn Fn() -> bool + Send + Sync>;

/// 位置を送るスレッドと分け合うもの。
#[derive(Default)]
struct Watch {
    state: Mutex<WatchState>,
    wake: Condvar,
}

#[derive(Default)]
struct WatchState {
    /// いまの出力の位置を読む口と、出力が使えなくなったかを見る口
    source: Option<(PositionReader, Broken)>,
    /// `source` を差し替えるたびに変わる番号
    generation: u64,
    /// 位置を送る先の窓 (最後に [`audio_play`] を呼んだ窓)
    label: Option<String>,
    /// 再生・停止の指示が出た (すぐ見に行く)
    kicked: bool,
    /// 頼んだ再生の番号 (token)。音声スレッドが受け取ったのを見るまで、眠らずに見に行く。
    /// 止める指示で `None` に戻る
    awaiting: Option<u64>,
    /// `awaiting` を書き換えた (スレッドが、待ち始めた時刻を取り直す)
    awaiting_changed: bool,
    /// アプリを終える
    stop: bool,
}

struct Inner {
    session: Mutex<Option<Session>>,
    clips: Mutex<ClipStore>,
    /// 最後に渡された曲。出力を開き直したときに、engine を作り直すのに使う
    last_song: Mutex<Option<SongPayload>>,
    watch: Arc<Watch>,
    reporter: Mutex<Option<JoinHandle<()>>>,
    next_generation: Mutex<u64>,
    /// 出力を開く関数 (テストでは、デバイスを開かないものに差し替える)
    opener: Opener,
    /// 出力に 0 を掛けて、音を出さない (窓を自動操作するテスト用)
    silent: bool,
}

/// 音の再生の状態。Tauri の state として管理する。
pub struct AudioState {
    inner: Arc<Inner>,
}

/// ロックを取る。前に持っていたスレッドが panic していても、中身をそのまま使う
/// (ここで持つ値は、途中で止まっても壊れた状態にならない)。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl AudioState {
    /// 位置を送るスレッドを始める (出力デバイスは、[`audio_init`] が呼ばれるまで開かない)。
    pub fn new<R: Runtime>(app: AppHandle<R>) -> Self {
        Self::with_opener(app, Box::new(open_default_device))
    }

    /// 出力の開き方を指定して作る。
    fn with_opener<R: Runtime>(app: AppHandle<R>, opener: Opener) -> Self {
        let watch = Arc::new(Watch::default());
        let inner = Arc::new(Inner {
            session: Mutex::new(None),
            clips: Mutex::new(ClipStore::default()),
            last_song: Mutex::new(None),
            watch: Arc::clone(&watch),
            reporter: Mutex::new(None),
            next_generation: Mutex::new(1),
            opener,
            silent: output_silent(),
        });
        // スレッドは Inner を弱く持つ (終了のとき、こちらが先に片付けられるように)
        let weak = Arc::downgrade(&inner);
        let spawned = thread::Builder::new()
            .name("audio-position".into())
            .spawn(move || {
                report_positions(&watch, ReportTimings::default(), |event, label| {
                    let _ = app.emit_to(label, POSITION_EVENT, event);
                    // ついでに、音声スレッドが送り返してきた古い engine を捨てる
                    if let Some(inner) = weak.upgrade() {
                        if let Ok(mut session) = inner.session.try_lock() {
                            if let Some(session) = session.as_mut() {
                                session.controller.collect_garbage();
                            }
                        }
                    }
                })
            });
        match spawned {
            Ok(handle) => *lock(&inner.reporter) = Some(handle),
            // 位置が届かないだけで、音は鳴る。画面は event が来ないことで気づける
            Err(e) => eprintln!("[audio] 位置を送るスレッドを作れません: {e}"),
        }
        AudioState { inner }
    }

    /// 窓 `label` が無くなったときに呼ぶ。メインの窓 (`is_main`) か、再生を頼んだ窓なら、再生を止め、
    /// 鍵盤の試聴で押している音を離す (操作する画面が無くなったあとも鳴り続けないように)。
    pub fn window_destroyed(&self, label: &str, is_main: bool) {
        self.inner.window_destroyed(label, is_main);
    }

    /// 音声スレッドと、位置を送るスレッドを止める。アプリを終えるときに呼ぶ。
    pub fn shutdown(&self) {
        {
            let mut state = lock(&self.inner.watch.state);
            state.stop = true;
            state.source = None;
        }
        self.inner.watch.wake.notify_all();
        if let Some(handle) = lock(&self.inner.reporter).take() {
            let _ = handle.join();
        }
        // 出力を捨てると、ストリームが閉じて音声スレッドが止まる
        *lock(&self.inner.session) = None;
    }
}

/// テスト用のビルドで、環境変数 `BUNRI_E2E_AUDIO_SILENT=1` が在れば音を出さない。
#[cfg(feature = "e2e")]
fn output_silent() -> bool {
    crate::e2e::audio_silent()
}

#[cfg(not(feature = "e2e"))]
fn output_silent() -> bool {
    false
}

impl Inner {
    /// 出力が開いていて使える状態にして、`f` に渡す。開いていない・使えなくなっているときは、
    /// 開く (開き直す)。
    fn with_session<T>(
        &self,
        f: impl FnOnce(&mut Session) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = lock(&self.session);
        if guard.as_ref().is_none_or(|s| (s.broken)()) {
            // 前の出力を先に閉じる (同じデバイスを 2 つ開いたままにしない)
            *guard = None;
            *guard = Some(self.open()?);
        }
        match guard.as_mut() {
            Some(session) => f(session),
            None => Err("音声の出力を開けませんでした".into()),
        }
    }

    /// 出力が開いていて使えるときだけ `f` に渡す。開いていない・使えなくなっているときは、
    /// 何もしない (止める・動かす相手が居ない。開き直すのは、鳴らす指示が来たとき)。
    fn if_session(&self, f: impl FnOnce(&mut Session) -> Result<(), String>) -> Result<(), String> {
        match lock(&self.session).as_mut() {
            Some(session) if !(session.broken)() => f(session),
            _ => Ok(()),
        }
    }

    /// 出力を開く。前に渡された曲が在れば、新しい出力へ渡し直す。
    fn open(&self) -> Result<Session, String> {
        let (output, mut controller) = (self.opener)(self.silent)?;
        let broken = output.broken();
        let generation = {
            let mut next = lock(&self.next_generation);
            *next += 1;
            *next
        };
        {
            let mut state = lock(&self.watch.state);
            state.source = Some((controller.position_reader(), Arc::clone(&broken)));
            state.generation = generation;
        }
        self.watch.wake.notify_all();

        // 開き直したときは、最後に渡された曲を新しい周波数で組み立て直す。
        // 失敗しても出力は使える (次の audio_set_song が渡し直す)
        let mut track_ids = None;
        if let Some(payload) = lock(&self.last_song).clone() {
            match self
                .build_engine(&payload, controller.sample_rate())
                .and_then(|(engine, built)| {
                    controller
                        .set_song(engine, &built.grid)
                        .map(|()| built.track_ids)
                        .map_err(|e| e.to_string())
                }) {
                Ok(ids) => track_ids = Some(ids),
                Err(e) => eprintln!("[audio] 開き直したあと、曲を渡し直せません: {e}"),
            }
        }
        Ok(Session {
            output,
            broken,
            controller,
            track_ids,
            generation,
        })
    }

    /// クリップ `id` の音声を、周波数 `rate` にしたものを返す。
    ///
    /// 周波数が違えば、ここで一度だけ変換して、変換したもので置き換える (元の周波数のものは
    /// 持ち続けない)。次からは、engine の組み立てのたびに変換し直さずに済む。
    fn clip_at_rate(&self, id: u32, rate: u32) -> Result<Option<Arc<AudioData>>, String> {
        let Some(audio) = lock(&self.clips).get(id) else {
            return Ok(None);
        };
        if audio.sample_rate() == rate {
            return Ok(Some(audio));
        }
        // 長い音声では時間がかかる (4 分のステレオで 0.45 秒)。置き場のロックは持たずに行う
        let converted = Arc::new(
            audio
                .resampled(rate)
                .map_err(|e| format!("クリップ {id} の音声を変換できません: {e}"))?,
        );
        let mut clips = lock(&self.clips);
        // 変換しているあいだに、送り直されたり捨てられたりしていたら、置き換えない
        if clips
            .ready
            .get(&id)
            .is_some_and(|now| Arc::ptr_eq(now, &audio))
        {
            clips.ready.insert(id, Arc::clone(&converted));
        }
        Ok(Some(converted))
    }

    /// 曲を、周波数 `rate` の engine に組み立てる。音声スレッドの外で呼ぶ。
    fn build_engine(
        &self,
        payload: &SongPayload,
        rate: u32,
    ) -> Result<(Box<Engine>, BuiltSong), String> {
        // 先に、使うクリップを engine の周波数にそろえる (そろえたものを置き場に覚えさせる)
        let mut clips = HashMap::new();
        for placed in payload.tracks.iter().flat_map(|t| &t.clips) {
            let Ok(id) = u32::try_from(whole(placed.clip, "クリップの ID")?) else {
                continue;
            };
            if let Some(audio) = self.clip_at_rate(id, rate)? {
                clips.insert(id, audio);
            }
        }
        let built = build_song(payload, |id| clips.get(&id).cloned())?;
        let config = EngineConfig {
            sample_rate: rate,
            ..EngineConfig::default()
        };
        let engine = Engine::new(&built.song, &config).map_err(|e| e.to_string())?;
        Ok((Box::new(engine), built))
    }

    fn init(&self) -> Result<InitResult, String> {
        self.with_session(|session| {
            Ok(InitResult {
                sample_rate: session.controller.sample_rate(),
                output_latency_sec: session.output.latency_sec(),
            })
        })
    }

    fn set_song(&self, payload: SongPayload) -> Result<(), String> {
        // 組み立てには時間がかかることが在るので、出力のロックを持たずに行う。そのあいだに出力が
        // 開き直されて周波数が変わっていたら、やり直す
        for _ in 0..3 {
            let (rate, generation) =
                self.with_session(|s| Ok((s.controller.sample_rate(), s.generation)))?;
            let (engine, built) = self.build_engine(&payload, rate)?;
            let sent = self.with_session(|session| {
                if session.generation != generation {
                    return Ok(false);
                }
                session
                    .controller
                    .set_song(engine, &built.grid)
                    .map_err(|e| e.to_string())?;
                session.track_ids = Some(built.track_ids);
                Ok(true)
            })?;
            if sent {
                *lock(&self.last_song) = Some(payload);
                return Ok(());
            }
        }
        Err("音声の出力が落ち着かず、曲を渡せませんでした".into())
    }

    fn play(&self, label: &str, options: PlayOptions) -> Result<(), String> {
        self.with_session(|session| {
            if session.track_ids.is_none() {
                return Err("曲がまだ渡されていません (先に audio_set_song を呼びます)".into());
            }
            session.controller.play(&options).map_err(|e| e.to_string())
        })?;
        {
            let mut state = lock(&self.watch.state);
            state.label = Some(label.to_string());
            // 音声スレッドがこの再生を受け取るまで、位置を送るスレッドを眠らせない
            state.awaiting = Some(options.token);
            state.awaiting_changed = true;
        }
        self.kick();
        Ok(())
    }

    /// 止めて、鳴っている音を消す。`live` なら、鍵盤の試聴で押している音も離す。
    /// 出力が開いていない・使えなくなっているときは、何もしない。
    fn stop(&self, live: bool) -> Result<(), String> {
        let stopped = self.if_session(|session| {
            session.controller.stop().map_err(|e| e.to_string())?;
            if live {
                session
                    .controller
                    .live_all_off()
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        });
        {
            // 始まるのを待っていた再生は、もう待たない
            let mut state = lock(&self.watch.state);
            state.awaiting = None;
            state.awaiting_changed = true;
        }
        self.kick();
        stopped
    }

    /// 窓 `label` が無くなった。メインの窓か、再生を頼んだ窓なら、音を止める。
    ///
    /// ほかの窓 (ツール・使い方) が開いたままだとアプリは終わらないので、[`AudioState::shutdown`] は
    /// 呼ばれない。止めないと、再生や押したままの試聴が、操作する画面の無いまま鳴り続ける。
    fn window_destroyed(&self, label: &str, is_main: bool) {
        let asked = {
            let mut state = lock(&self.watch.state);
            let asked = state.label.as_deref() == Some(label);
            if asked {
                // 位置を送る先が無くなった
                state.label = None;
            }
            asked
        };
        if !(is_main || asked) {
            return;
        }
        if let Err(e) = self.stop(true) {
            eprintln!("[audio] 窓が閉じたあと、音を止められません: {e}");
        }
    }

    /// 位置を送るスレッドに、すぐ見に行かせる。
    fn kick(&self) {
        lock(&self.watch.state).kicked = true;
        self.watch.wake.notify_all();
    }
}

/// 位置を読んだ結果を、画面へ送る形にする。
fn position_event(position: &PlaybackPosition, broken: bool) -> PositionEvent {
    // 測った時刻 (単調な時計) を、いまの時刻との差から Unix の時刻に直す
    let age = Instant::now().saturating_duration_since(position.at);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1e3)
        .unwrap_or(0.0);
    PositionEvent {
        token: position.token,
        // 出力が使えなくなったら、鳴っていない (画面が位置を進め続けないように)
        playing: position.playing && !broken,
        counting_in: position.counting_in && !broken,
        position_sec: position.position_sec,
        at_ms: now_ms - age.as_secs_f64() * 1e3,
        pass: position.pass,
        count_in_remaining_sec: if broken {
            0.0
        } else {
            position.count_in_remaining_sec
        },
    }
}

/// 次に位置を送るかを決める。`since_last` は、前に送ってからの時間。
///
/// - 状態 (再生中か・カウント中か・再生の番号) が変わったら、すぐ送る (始まり・止まりを 1 回ずつ)
/// - 再生しているあいだは、`interval` ごとに送る
/// - 止まっているあいだは送らない
fn should_emit(
    last: Option<&PositionEvent>,
    now: &PositionEvent,
    since_last: Duration,
    interval: Duration,
) -> bool {
    let Some(last) = last else {
        return now.playing;
    };
    let state = |e: &PositionEvent| (e.token, e.playing, e.counting_in);
    // 眠りから少し早く起きても 1 回飛ばさないよう、間隔には余裕を見る
    let due = since_last + Duration::from_millis(3) >= interval;
    state(last) != state(now) || (now.playing && due)
}

/// 位置を送るスレッドの本体。`emit(中身, 送る先の窓)` で画面へ送る。
///
/// - 再生しているあいだは、`timings.interval` ごとに送る
/// - 止まっているあいだは眠り、再生・停止の指示 ([`Inner::kick`]) で起きる。起きてしばらくは細かく
///   見に行く (始まり・止まりを、遅れずに知らせるため)
/// - 再生を頼まれたのに、音声スレッドがまだ受け取っていないあいだは、眠らずに見に行き続ける
///   (上限は `timings.await_limit`)。開き直した直後のデバイスで最初のコールバックが遅くても、
///   始まったことを知らせられる
fn report_positions(
    watch: &Watch,
    timings: ReportTimings,
    mut emit: impl FnMut(PositionEvent, &str),
) {
    let mut last: Option<PositionEvent> = None;
    let mut last_sent = Instant::now();
    let mut generation = 0;
    let mut kicked_until: Option<Instant> = None;
    // 始まるのを待っている再生の番号と、待つのをやめる時刻
    let mut awaiting: Option<(u64, Instant)> = None;
    let mut state = lock(&watch.state);
    loop {
        if state.stop {
            return;
        }
        if std::mem::take(&mut state.kicked) {
            kicked_until = Some(Instant::now() + timings.kick_window);
        }
        if std::mem::take(&mut state.awaiting_changed) {
            awaiting = state
                .awaiting
                .map(|token| (token, Instant::now() + timings.await_limit));
        }
        let label = state.label.clone();
        let source = state.source.clone();
        let source_generation = state.generation;
        drop(state);

        match label {
            // 送る先の窓が無い (まだ再生していない・再生を頼んだ窓が閉じた): 何も送らない
            None => last = None,
            Some(label) => {
                // 出力が開き直された: 前の出力で鳴っていた再生は、止まったと知らせる
                if source_generation != generation {
                    generation = source_generation;
                    if let Some(stopped) = last.take().filter(|e| e.playing) {
                        emit(
                            PositionEvent {
                                playing: false,
                                counting_in: false,
                                count_in_remaining_sec: 0.0,
                                ..stopped
                            },
                            &label,
                        );
                    }
                }
                if let Some((reader, broken)) = source {
                    let event = position_event(&reader.read(), broken());
                    // 音声スレッドが、頼んだ再生を受け取った (もう止まっていても、受け取ってはいる)
                    if awaiting.is_some_and(|(token, _)| token == event.token) {
                        awaiting = None;
                    }
                    if should_emit(last.as_ref(), &event, last_sent.elapsed(), timings.interval) {
                        emit(event, &label);
                        last = Some(event);
                        last_sent = Instant::now();
                    }
                }
            }
        }

        let now = Instant::now();
        if awaiting.is_some_and(|(_, until)| now >= until) {
            awaiting = None;
        }
        let playing = last.is_some_and(|e| e.playing);
        let kicked = kicked_until.is_some_and(|until| now < until);
        // 次に見に行くまでの長さ。`None` なら、次の指示まで眠る
        let wait = if kicked {
            Some(timings.kick_interval)
        } else if playing {
            Some(timings.interval)
        } else if awaiting.is_some() {
            Some(timings.await_interval)
        } else {
            None
        };
        state = lock(&watch.state);
        if state.stop || state.kicked || state.awaiting_changed {
            continue;
        }
        state = match wait {
            Some(wait) => watch
                .wake
                .wait_timeout(state, wait)
                .map(|(guard, _)| guard)
                .unwrap_or_else(|e| e.into_inner().0),
            None => watch.wake.wait(state).unwrap_or_else(|e| e.into_inner()),
        };
    }
}

// ---- command ----

/// 重い処理 (デバイスを開く、周波数の変換、engine の組み立て) を、メインスレッドでも
/// 非同期のスレッドでもない、待ってよいスレッドで動かす。
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("音声の処理が途中で止まりました: {e}"))?
}

/// 出力デバイスを開き、音声スレッドを始める (済みなら何もしない)。
#[tauri::command]
pub async fn audio_init(state: State<'_, AudioState>) -> Result<InitResult, String> {
    let inner = Arc::clone(&state.inner);
    blocking(move || inner.init()).await
}

/// ヘッダの値 (10 進の整数) を読む。
fn header_number<T: std::str::FromStr>(request: &Request<'_>, name: &str) -> Result<T, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.trim().parse().ok())
        .ok_or_else(|| format!("ヘッダ {name} が在りません (か、整数ではありません)"))
}

/// クリップの音声 (画面がデコードした PCM) を、分けて受け取る。
///
/// 本体は生のバイト列 (Float32 リトルエンディアン。チャンネルごとに並ぶ)。どの音声の、どの位置の
/// 塊かはヘッダで渡す (`x-clip-id` / `x-sample-rate` / `x-channels` / `x-frames` / `x-offset`)。
#[tauri::command(async)]
pub fn audio_clip_put(
    request: Request<'_>,
    state: State<'_, AudioState>,
) -> Result<ClipPutResult, String> {
    // Tauri は、バイト列をそのまま運べないとき (IPC の専用の経路が使えないとき) に、数の配列の
    // JSON に直して運ぶ。どちらで届いても受け取る
    let from_json;
    let body: &[u8] = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(value) => {
            from_json = serde_json::from_value::<Vec<u8>>(value.clone())
                .map_err(|_| "音声の本体がバイト列ではありません".to_string())?;
            &from_json
        }
    };
    let chunk = ClipChunk {
        id: header_number(&request, "x-clip-id")?,
        sample_rate: header_number(&request, "x-sample-rate")?,
        channels: header_number(&request, "x-channels")?,
        frames: header_number(&request, "x-frames")?,
        offset: header_number(&request, "x-offset")?,
        body,
    };
    let complete = lock(&state.inner.clips).put(chunk)?;
    Ok(ClipPutResult { complete })
}

/// もう使わないクリップの音声を捨てる。知らない id は無視する。
#[tauri::command(async)]
pub fn audio_clip_drop(ids: Vec<i64>, state: State<'_, AudioState>) {
    lock(&state.inner.clips).drop_ids(&ids);
}

/// 曲の内容を渡す。engine を組み立て、音声スレッドに渡して差し替える (組み立て終わってから返る)。
#[tauri::command]
pub async fn audio_set_song(song: SongPayload, state: State<'_, AudioState>) -> Result<(), String> {
    let inner = Arc::clone(&state.inner);
    blocking(move || inner.set_song(song)).await
}

/// いま渡してある曲を `from_sec` から鳴らす (鳴っていたら止めて鳴らし直す)。
/// 再生位置は、呼んだ窓へ event [`POSITION_EVENT`] で送る。
#[tauri::command]
pub async fn audio_play<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AudioState>,
    token: u64,
    from_sec: f64,
    r#loop: Option<LoopPayload>,
    count_in: Option<CountInPayload>,
    metronome: bool,
) -> Result<(), String> {
    let options = PlayOptions {
        token,
        from_sec,
        loop_range: r#loop.map(|range| (range.start_sec, range.end_sec)),
        count_in: match count_in {
            Some(count) => Some(CountIn {
                beats: u32::try_from(whole(count.beats, "カウントの拍数")?)
                    .map_err(|_| format!("カウントの拍数が正しくありません: {}", count.beats))?,
                beat_sec: count.beat_sec,
            }),
            None => None,
        },
        metronome,
    };
    let inner = Arc::clone(&state.inner);
    let label = window.label().to_string();
    blocking(move || inner.play(&label, options)).await
}

/// 止めて、鳴っている音を消す。
#[tauri::command(async)]
pub fn audio_stop(state: State<'_, AudioState>) -> Result<(), String> {
    state.inner.stop(false)
}

/// 再生中のトラックの音量・パン・鳴らすかを変える。いまの engine に無い id は無視する。
#[tauri::command(async)]
pub fn audio_set_track(
    state: State<'_, AudioState>,
    id: f64,
    gain_db: serde_json::Value,
    pan: f64,
    audible: bool,
) -> Result<(), String> {
    let id = whole(id, "トラックの ID")?;
    let gain_db = gain_db_value(&gain_db)?;
    state.inner.if_session(|session| {
        let index = session
            .track_ids
            .as_ref()
            .and_then(|ids| ids.iter().position(|known| *known == id));
        match index {
            Some(index) => session
                .controller
                .set_track(index, gain_db as f32, pan as f32, audible)
                .map_err(|e| e.to_string()),
            None => Ok(()),
        }
    })
}

/// 音量 (dB) の値を読む。JavaScript の `-Infinity` (音量 0) は JSON では `null` で届くので、
/// 無音として受け取る。
fn gain_db_value(value: &serde_json::Value) -> Result<f64, String> {
    match value {
        serde_json::Value::Null => Ok(f64::NEG_INFINITY),
        other => other
            .as_f64()
            .ok_or_else(|| format!("音量が数値ではありません: {other}")),
    }
}

/// メトロノームを鳴らすかを変える。
#[tauri::command(async)]
pub fn audio_set_metronome(state: State<'_, AudioState>, enabled: bool) -> Result<(), String> {
    state.inner.if_session(|session| {
        session
            .controller
            .set_metronome(enabled)
            .map_err(|e| e.to_string())
    })
}

/// 鍵盤の試聴 (再生していなくても鳴る)。`velocity` が 0 なら離す。
#[tauri::command(async)]
pub fn audio_live_note(
    state: State<'_, AudioState>,
    pitch: f64,
    velocity: f64,
) -> Result<(), String> {
    if !(pitch.is_finite() && (0.0..=127.0).contains(&pitch.round()) && velocity.is_finite()) {
        return Err(format!(
            "ノートが正しくありません (高さ {pitch}、強さ {velocity})"
        ));
    }
    let pitch = pitch.round() as u8;
    let velocity = velocity.round().clamp(0.0, 127.0) as u8;
    if velocity == 0 {
        // 離す: 出力が開いていなければ、鳴っている音も無い
        return state.inner.if_session(|session| {
            session
                .controller
                .live_note_off(pitch)
                .map_err(|e| e.to_string())
        });
    }
    state.inner.with_session(|session| {
        session
            .controller
            .live_note_on(pitch, velocity)
            .map_err(|e| e.to_string())
    })
}

/// 鍵盤の試聴で押している音を、すべて離す。
#[tauri::command(async)]
pub fn audio_live_all_off(state: State<'_, AudioState>) -> Result<(), String> {
    state
        .inner
        .if_session(|session| session.controller.live_all_off().map_err(|e| e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn payload(json: serde_json::Value) -> SongPayload {
        serde_json::from_value(json).expect("曲の JSON を読めるはず")
    }

    fn audio(rate: u32, frames: usize) -> Arc<AudioData> {
        Arc::new(AudioData::new(rate, vec![vec![0.25; frames]]).unwrap())
    }

    // ---- 曲の組み立て ----

    #[test]
    fn 画面の曲をengineの曲にする() {
        let p = payload(serde_json::json!({
            "bpm": 97.5,
            "offsetSec": -0.25,
            "beatsPerBar": 3,
            "tracks": [
                {
                    "id": 7, "gainDb": -6, "pan": 0.5, "audible": true,
                    "notes": [
                        { "start": 0, "length": 240, "pitch": 60, "velocity": 100 },
                        { "start": 960, "length": 480, "pitch": 64 }
                    ],
                    "clips": []
                },
                {
                    "id": 1731500000000i64, "gainDb": 0, "pan": -1, "audible": false,
                    "notes": [],
                    "clips": [{ "clip": 3, "startSec": 1.5 }]
                }
            ]
        }));
        let clip = audio(48_000, 100);
        let built = build_song(&p, |id| (id == 3).then(|| Arc::clone(&clip))).unwrap();

        assert_eq!(built.song.bpm, 97.5);
        assert_eq!(built.song.offset_sec, -0.25);
        assert_eq!(built.song.master_gain_db, 0.0);
        assert_eq!(
            built.grid,
            Grid {
                bpm: 97.5,
                offset_sec: -0.25,
                beats_per_bar: 3
            }
        );
        assert_eq!(built.track_ids, [7, 1_731_500_000_000]);

        // ノートの在るトラックには仮の音を当てる。強さが無ければ 96
        let first = &built.song.tracks[0];
        assert_eq!(first.instrument, Some(Instrument::Tone));
        assert_eq!(
            first.notes,
            [
                Note {
                    start: 0,
                    length: 240,
                    pitch: 60,
                    velocity: 100
                },
                Note {
                    start: 960,
                    length: 480,
                    pitch: 64,
                    velocity: 96
                }
            ]
        );
        assert_eq!((first.gain_db, first.pan), (-6.0, 0.5));
        assert!(!first.mute && !first.solo);

        // 鳴らさないトラックはミュートとして渡す。クリップは、送ってある音声をそのまま使う
        let second = &built.song.tracks[1];
        assert_eq!(second.instrument, None);
        assert!(second.mute && !second.solo);
        assert_eq!(second.clips.len(), 1);
        assert!(Arc::ptr_eq(&second.clips[0].audio, &clip));
        assert_eq!(second.clips[0].start_sec, 1.5);

        // そのまま engine を組み立てられる
        let engine = Engine::new(&built.song, &EngineConfig::default()).unwrap();
        assert_eq!(engine.track_count(), 2);
    }

    #[test]
    fn 届いていないクリップが在れば断る() {
        let p = payload(serde_json::json!({
            "bpm": 120, "offsetSec": 0, "beatsPerBar": 4,
            "tracks": [{
                "id": 1, "gainDb": 0, "pan": 0, "audible": true,
                "notes": [], "clips": [{ "clip": 9, "startSec": 0 }]
            }]
        }));
        let error = build_song(&p, |_| None).err().unwrap();
        assert!(error.contains("クリップ 9"), "{error}");
    }

    #[test]
    fn 鳴らせないノートは飛ばし数値でない値は断る() {
        let track = |notes: serde_json::Value| {
            payload(serde_json::json!({
                "bpm": 120, "offsetSec": 0, "beatsPerBar": 4,
                "tracks": [{ "id": 1, "gainDb": 0, "pan": 0, "audible": true, "notes": notes }]
            }))
        };
        let p = track(serde_json::json!([
            { "start": 0, "length": 0, "pitch": 60 },
            { "start": -240, "length": 240, "pitch": 60 },
            { "start": 0, "length": 240, "pitch": 128 },
            { "start": 0, "length": 240, "pitch": -1 },
            { "start": 239.6, "length": 240.4, "pitch": 60, "velocity": 500 },
            { "start": 0, "length": 240, "pitch": 61, "velocity": 0 }
        ]));
        let built = build_song(&p, |_| None).unwrap();
        assert_eq!(
            built.song.tracks[0].notes,
            [
                Note {
                    start: 240,
                    length: 240,
                    pitch: 60,
                    velocity: 127
                },
                Note {
                    start: 0,
                    length: 240,
                    pitch: 61,
                    velocity: 1
                }
            ]
        );
        // 鳴らせるノートが 1 つも無ければ、楽器を当てない
        let p = track(serde_json::json!([{ "start": 0, "length": 0, "pitch": 60 }]));
        assert_eq!(
            build_song(&p, |_| None).unwrap().song.tracks[0].instrument,
            None
        );

        // JSON には NaN を書けないので、値を直に作る
        let mut p = track(serde_json::json!([{ "start": 0, "length": 240, "pitch": 60 }]));
        p.tracks[0].notes[0].start = f64::NAN;
        assert!(build_song(&p, |_| None).is_err());
    }

    #[test]
    fn 整数でないidと範囲の外の拍子は断る() {
        let with = |id: f64, beats: f64| {
            payload(serde_json::json!({
                "bpm": 120, "offsetSec": 0, "beatsPerBar": beats,
                "tracks": [{ "id": id, "gainDb": 0, "pan": 0, "audible": true }]
            }))
        };
        assert!(build_song(&with(1.0, 4.0), |_| None).is_ok());
        assert!(build_song(&with(1.5, 4.0), |_| None).is_err());
        assert!(build_song(&with(1.0, 0.0), |_| None).is_err());
        assert!(build_song(&with(1.0, 1e9), |_| None).is_err());
    }

    #[test]
    fn 音量のnullは無音として受け取る() {
        // JavaScript の -Infinity は、JSON.stringify で null になる
        let p = payload(serde_json::json!({
            "bpm": 120, "offsetSec": 0, "beatsPerBar": 4,
            "tracks": [{ "id": 1, "gainDb": null, "pan": 0, "audible": true }]
        }));
        let built = build_song(&p, |_| None).unwrap();
        assert_eq!(built.song.tracks[0].gain_db, f32::NEG_INFINITY);
        assert!(Engine::new(&built.song, &EngineConfig::default()).is_ok());
    }

    #[test]
    fn テンポが使えない曲はengineが断る() {
        let p = payload(serde_json::json!({
            "bpm": 0, "offsetSec": 0, "beatsPerBar": 4, "tracks": []
        }));
        let built = build_song(&p, |_| None).unwrap();
        assert!(Engine::new(&built.song, &EngineConfig::default()).is_err());
    }

    // ---- クリップの音声の置き場 ----

    fn bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    fn chunk(id: u32, channels: usize, frames: usize, offset: usize, body: &[u8]) -> ClipChunk<'_> {
        ClipChunk {
            id,
            sample_rate: 44_100,
            channels,
            frames,
            offset,
            body,
        }
    }

    #[test]
    fn 音声は分けて届いてもそろったところで使える() {
        let mut store = ClipStore::default();
        // ステレオ 5 フレームを、2 + 3 フレームに分ける。塊の中はチャンネルごとに並ぶ
        let first = bytes(&[1.0, 2.0, -1.0, -2.0]);
        let second = bytes(&[3.0, 4.0, 5.0, -3.0, -4.0, -5.0]);
        assert_eq!(store.put(chunk(1, 2, 5, 0, &first)), Ok(false));
        assert!(store.get(1).is_none(), "そろうまでは使えない");
        assert_eq!(store.put(chunk(1, 2, 5, 2, &second)), Ok(true));

        let audio = store.get(1).unwrap();
        assert_eq!(audio.sample_rate(), 44_100);
        assert!(audio.is_stereo());
        assert_eq!(audio.left(), [1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(audio.right(), [-1.0, -2.0, -3.0, -4.0, -5.0]);
        assert!(store.pending.is_empty());
    }

    #[test]
    fn モノラルと一度に届く音声と空の音声() {
        let mut store = ClipStore::default();
        assert_eq!(
            store.put(chunk(2, 1, 3, 0, &bytes(&[0.5, 0.25, 0.125]))),
            Ok(true)
        );
        let audio = store.get(2).unwrap();
        assert!(!audio.is_stereo());
        assert_eq!(audio.left(), [0.5, 0.25, 0.125]);
        // 長さ 0 の音声も、そろったことにする
        assert_eq!(store.put(chunk(3, 2, 0, 0, &[])), Ok(true));
        assert_eq!(store.get(3).unwrap().frames(), 0);
    }

    #[test]
    fn 位置0の塊が来たら最初からやり直す() {
        let mut store = ClipStore::default();
        assert_eq!(store.put(chunk(1, 1, 4, 0, &bytes(&[9.0, 9.0]))), Ok(false));
        // 送り直し: 前の受け取りかけは捨てる
        assert_eq!(store.put(chunk(1, 1, 3, 0, &bytes(&[1.0, 2.0]))), Ok(false));
        assert_eq!(store.put(chunk(1, 1, 3, 2, &bytes(&[3.0]))), Ok(true));
        assert_eq!(store.get(1).unwrap().left(), [1.0, 2.0, 3.0]);

        // そろったあとに送り直しても、そろうまでは前の音声が使える
        assert_eq!(store.put(chunk(1, 1, 2, 0, &bytes(&[7.0]))), Ok(false));
        assert_eq!(store.get(1).unwrap().left(), [1.0, 2.0, 3.0]);
        assert_eq!(store.put(chunk(1, 1, 2, 1, &bytes(&[8.0]))), Ok(true));
        assert_eq!(store.get(1).unwrap().left(), [7.0, 8.0]);
    }

    #[test]
    fn 約束に合わない塊は断る() {
        let mut store = ClipStore::default();
        let two = bytes(&[1.0, 2.0]);
        // 先頭が届いていない
        assert!(store.put(chunk(1, 1, 4, 2, &two)).is_err());
        // 飛んでいる・重なっている・はみ出す
        assert_eq!(store.put(chunk(1, 1, 4, 0, &two)), Ok(false));
        assert!(store.put(chunk(1, 1, 4, 3, &two)).is_err());
        assert!(store.pending.is_empty(), "断ったら受け取りかけを捨てる");
        assert_eq!(store.put(chunk(1, 1, 4, 0, &two)), Ok(false));
        assert!(store.put(chunk(1, 1, 4, 1, &two)).is_err());
        assert_eq!(store.put(chunk(1, 1, 3, 0, &two)), Ok(false));
        assert!(store.put(chunk(1, 1, 3, 2, &two)).is_err());
        // 途中で形が変わる
        assert_eq!(store.put(chunk(1, 1, 4, 0, &two)), Ok(false));
        assert!(store.put(chunk(1, 1, 5, 2, &two)).is_err());
        // 値そのものが使えない
        assert!(store.put(chunk(0, 1, 2, 0, &two)).is_err());
        assert!(store.put(chunk(1, 3, 2, 0, &two)).is_err());
        assert!(store.put(chunk(1, 0, 2, 0, &two)).is_err());
        assert!(store.put(chunk(1, 2, 2, 0, &bytes(&[1.0]))).is_err());
        assert!(store.put(chunk(1, 1, 2, 0, &[0, 0, 0])).is_err());
        assert!(store
            .put(ClipChunk {
                sample_rate: 10,
                ..chunk(1, 1, 2, 0, &two)
            })
            .is_err());
        assert!(store.put(chunk(1, 2, usize::MAX / 16, 0, &[])).is_err());
        assert!(store.ready.is_empty());
    }

    #[test]
    fn 捨てた音声は使えなくなり知らないidは無視する() {
        let mut store = ClipStore::default();
        store.put(chunk(1, 1, 1, 0, &bytes(&[1.0]))).unwrap();
        store.put(chunk(2, 1, 1, 0, &bytes(&[1.0]))).unwrap();
        store.put(chunk(3, 1, 2, 0, &bytes(&[1.0]))).unwrap();
        store.drop_ids(&[1, 3, 99, -5, i64::MAX]);
        assert!(store.get(1).is_none());
        assert!(store.get(2).is_some());
        assert!(store.pending.is_empty(), "受け取りかけも捨てる");
    }

    // ---- 位置を送る ----

    fn event(token: u64, playing: bool) -> PositionEvent {
        PositionEvent {
            token,
            playing,
            counting_in: false,
            position_sec: 1.0,
            at_ms: 0.0,
            pass: 0,
            count_in_remaining_sec: 0.0,
        }
    }

    /// 間隔を省いた `should_emit` (本番と同じ間隔)。
    fn should_emit(
        last: Option<&PositionEvent>,
        now: &PositionEvent,
        since_last: Duration,
    ) -> bool {
        super::should_emit(last, now, since_last, POSITION_INTERVAL)
    }

    #[test]
    fn 位置は再生中は決まった間隔で止まったら一度だけ送る() {
        let (soon, due) = (Duration::from_millis(4), POSITION_INTERVAL);
        // 一度も再生していなければ送らない。始まったら、すぐ送る
        assert!(!should_emit(None, &event(0, false), due));
        assert!(should_emit(None, &event(1, true), soon));
        // 再生中は、間隔が空いたら送る (始まり・止まりを早く見つけるために細かく見に行っても、送りすぎない)
        assert!(!should_emit(Some(&event(1, true)), &event(1, true), soon));
        assert!(should_emit(Some(&event(1, true)), &event(1, true), due));
        // 止まったら、すぐ 1 回。そのあとは送らない
        assert!(should_emit(Some(&event(1, true)), &event(1, false), soon));
        assert!(!should_emit(Some(&event(1, false)), &event(1, false), due));
        // 鳴らし直し (番号が変わる) と、カウントの終わりも、すぐ送る
        assert!(should_emit(Some(&event(1, true)), &event(2, true), soon));
        let counting = PositionEvent {
            counting_in: true,
            ..event(2, true)
        };
        assert!(should_emit(Some(&counting), &event(2, true), soon));
        // 見に行くあいだに始まって止まった再生も、止まったことを 1 回知らせる
        assert!(should_emit(Some(&event(1, false)), &event(2, false), soon));
    }

    #[test]
    fn 位置の時刻はunixのミリ秒になり出力が使えなければ止まったと知らせる() {
        let (controller, mut transport) = bunri_audio::transport(48_000).unwrap();
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1e3;
        transport.process(&mut [0.0; 64], &mut [0.0; 64]);
        let position = PlaybackPosition {
            token: 5,
            playing: true,
            counting_in: true,
            frame: 24_000,
            position_sec: 0.5,
            pass: 2,
            ..controller.position()
        };
        let event = position_event(&position, false);
        let after = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1e3;
        assert!(
            event.at_ms >= before - 1.0 && event.at_ms <= after + 1.0,
            "{} は {before}〜{after} の外",
            event.at_ms
        );
        assert_eq!(
            (event.token, event.playing, event.counting_in, event.pass),
            (5, true, true, 2)
        );
        assert_eq!(event.position_sec, 0.5);

        let broken = position_event(&position, true);
        assert!(!broken.playing && !broken.counting_in);
        assert_eq!(broken.token, 5);

        // 画面が読む名前 (camelCase) で送る
        let json = serde_json::to_value(event).unwrap();
        for key in [
            "token",
            "playing",
            "countingIn",
            "positionSec",
            "atMs",
            "pass",
            "countInRemainingSec",
        ] {
            assert!(json.get(key).is_some(), "{key} が無い: {json}");
        }
        assert_eq!(
            json.as_object().unwrap().len(),
            7,
            "知らないキーが在る: {json}"
        );
        assert_eq!(json["countInRemainingSec"], 0.0);
    }

    #[test]
    fn カウントの残りは位置と一緒に送り出力が使えなければ0にする() {
        let (mut controller, mut transport) = bunri_audio::transport(48_000).unwrap();
        controller
            .play(&PlayOptions {
                token: 2,
                from_sec: 1.5,
                count_in: Some(CountIn {
                    beats: 2,
                    beat_sec: 0.5,
                }),
                ..PlayOptions::default()
            })
            .unwrap();
        let (mut left, mut right) = ([0f32; 480], [0f32; 480]);
        // カウントは 1 秒。ブロック (10ms) ごとに、残りが 10ms ずつ減る
        for block in 0..3 {
            transport.process(&mut left, &mut right);
            let event = position_event(&controller.position(), false);
            assert!(event.playing && event.counting_in);
            assert_eq!(event.position_sec, 1.5);
            let expected = 1.0 - block as f64 * 0.01;
            assert!(
                (event.count_in_remaining_sec - expected).abs() < 1e-9,
                "block={block}: {}",
                event.count_in_remaining_sec
            );
        }
        let broken = position_event(&controller.position(), true);
        assert_eq!(broken.count_in_remaining_sec, 0.0);
        // カウントが終わったら 0
        for _ in 0..100 {
            transport.process(&mut left, &mut right);
        }
        let event = position_event(&controller.position(), false);
        assert!(event.playing && !event.counting_in);
        assert_eq!(event.count_in_remaining_sec, 0.0);
        assert!(event.position_sec > 1.5);
    }

    #[test]
    fn 音量の値はnullなら無音で数値でなければ断る() {
        assert_eq!(gain_db_value(&serde_json::json!(-6.5)), Ok(-6.5));
        assert_eq!(gain_db_value(&serde_json::json!(0)), Ok(0.0));
        assert_eq!(
            gain_db_value(&serde_json::Value::Null),
            Ok(f64::NEG_INFINITY)
        );
        assert!(gain_db_value(&serde_json::json!("loud")).is_err());
    }

    /// 位置を送るスレッドを、本物の transport (音声デバイスは無し) につないで動かす。
    /// 音声スレッドの代わりに、テストが `process` を回す。
    #[test]
    fn 位置を送るスレッドは始まりと止まりを知らせて眠る() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (mut controller, mut transport) = bunri_audio::transport(48_000).unwrap();
        let watch = Arc::new(Watch::default());
        let (tx, rx) = mpsc::channel::<(PositionEvent, String)>();
        let thread_watch = Arc::clone(&watch);
        let reporter = thread::spawn(move || {
            report_positions(&thread_watch, ReportTimings::default(), |event, label| {
                let _ = tx.send((event, label.to_string()));
            })
        });
        let kick = || {
            lock(&watch.state).kicked = true;
            watch.wake.notify_all();
        };
        let quiet = Duration::from_millis(150);
        let soon = Duration::from_secs(5);
        let (mut left, mut right) = ([0f32; 256], [0f32; 256]);
        // 音声スレッドの代わり: 指示を受け取らせて、位置を公開させる
        let mut block = |controller: &Controller| {
            transport.process(&mut left, &mut right);
            controller.position()
        };

        // 出力が開いていない・送る先の窓が決まっていないあいだは、何も送らない
        kick();
        assert!(rx.recv_timeout(quiet).is_err());
        let broken = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&broken);
        {
            let mut state = lock(&watch.state);
            state.source = Some((
                controller.position_reader(),
                Arc::new(move || flag.load(Ordering::Relaxed)),
            ));
            state.generation = 1;
        }
        kick();
        assert!(rx.recv_timeout(quiet).is_err());
        lock(&watch.state).label = Some("main".into());
        kick();
        // 止まっているあいだも送らない
        assert!(rx.recv_timeout(quiet).is_err());

        // 再生を始めると、その窓へ送り始める
        controller
            .play(&PlayOptions {
                token: 3,
                from_sec: 1.0,
                ..PlayOptions::default()
            })
            .unwrap();
        assert!(block(&controller).playing);
        kick();
        let (first, label) = rx.recv_timeout(soon).expect("始まりの知らせが来ない");
        assert_eq!(label, "main");
        assert!(first.playing && !first.counting_in);
        assert_eq!((first.token, first.pass), (3, 0));
        assert_eq!(first.position_sec, 1.0);
        // 再生しているあいだは、送り続ける (位置は進む)
        block(&controller);
        block(&controller);
        let later = loop {
            let (event, _) = rx.recv_timeout(soon).expect("再生中の知らせが来ない");
            if event.position_sec > first.position_sec {
                break event;
            }
        };
        assert!(later.playing);
        assert_eq!(later.position_sec, 1.0 + 512.0 / 48_000.0);
        assert!(later.at_ms >= first.at_ms);

        // 止めると 1 回知らせて、そのあとは送らない
        controller.stop().unwrap();
        block(&controller);
        assert!(!block(&controller).playing);
        kick();
        let stopped = loop {
            let (event, _) = rx.recv_timeout(soon).expect("止まりの知らせが来ない");
            if !event.playing {
                break event;
            }
        };
        assert_eq!(stopped.token, 3);
        assert!(rx.recv_timeout(quiet).is_err(), "止まったあとも送っている");

        // 再生中に出力が使えなくなったら、止まったと知らせる
        controller
            .play(&PlayOptions {
                token: 4,
                ..PlayOptions::default()
            })
            .unwrap();
        block(&controller);
        kick();
        let (event, _) = rx.recv_timeout(soon).unwrap();
        assert!(event.playing && event.token == 4);
        broken.store(true, Ordering::Relaxed);
        let lost = loop {
            let (event, _) = rx.recv_timeout(soon).expect("使えなくなった知らせが来ない");
            if !event.playing {
                break event;
            }
        };
        assert_eq!(lost.token, 4);
        assert!(rx.recv_timeout(quiet).is_err());

        // 再生中に出力が開き直されたら、前の再生は止まったと知らせる
        broken.store(false, Ordering::Relaxed);
        kick();
        let (event, _) = rx.recv_timeout(soon).unwrap();
        assert!(event.playing && event.token == 4);
        let (replacement, _unused) = bunri_audio::transport(48_000).unwrap();
        {
            let mut state = lock(&watch.state);
            state.source = Some((replacement.position_reader(), Arc::new(|| false)));
            state.generation = 2;
        }
        kick();
        let reopened = loop {
            let (event, _) = rx.recv_timeout(soon).expect("開き直しの知らせが来ない");
            if !event.playing {
                break event;
            }
        };
        assert_eq!(reopened.token, 4);
        // 新しい出力は、まだ何も鳴らしていない
        assert!(rx.recv_timeout(quiet).is_err());

        // アプリを終えるときは、眠っていてもすぐ終わる
        lock(&watch.state).stop = true;
        watch.wake.notify_all();
        reporter.join().unwrap();
    }

    /// 再生を頼んでから、音声スレッドが受け取るまでが長い (開き直した直後のデバイスなど) 場合。
    #[test]
    fn 頼んだ再生が遅れて始まっても知らせ待つ上限を過ぎたら眠る() {
        let (mut controller, mut transport) = bunri_audio::transport(48_000).unwrap();
        let watch = Arc::new(Watch::default());
        {
            let mut state = lock(&watch.state);
            state.source = Some((controller.position_reader(), Arc::new(|| false)));
            state.generation = 1;
            state.label = Some("main".into());
        }
        // 細かく見に行くのは 60ms だけ。始まるのを待つのは 1.5 秒まで
        let timings = ReportTimings {
            kick_window: Duration::from_millis(60),
            await_interval: Duration::from_millis(20),
            await_limit: Duration::from_millis(1_500),
            ..ReportTimings::default()
        };
        let (tx, rx) = mpsc::channel::<PositionEvent>();
        let thread_watch = Arc::clone(&watch);
        let reporter = thread::spawn(move || {
            report_positions(&thread_watch, timings, |event, _| {
                let _ = tx.send(event);
            })
        });
        // `Inner::play` と同じ: 頼んだ再生の番号を知らせて、起こす
        let ask = |token: u64| {
            let mut state = lock(&watch.state);
            state.awaiting = Some(token);
            state.awaiting_changed = true;
            state.kicked = true;
            drop(state);
            watch.wake.notify_all();
        };
        let (mut left, mut right) = ([0f32; 256], [0f32; 256]);
        let play = |controller: &mut Controller, token: u64| {
            let options = PlayOptions {
                token,
                ..PlayOptions::default()
            };
            controller.play(&options).unwrap();
        };

        // 再生を頼んだが、音声スレッドは 400ms のあいだ動かない (細かく見に行く 60ms は、とうに過ぎる)
        play(&mut controller, 7);
        ask(7);
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
        // 動き出したら、次に見に行ったとき (20ms ごと) に知らせる
        transport.process(&mut left, &mut right);
        let started = rx
            .recv_timeout(Duration::from_millis(1_000))
            .expect("遅れて始まった再生の知らせが来ない");
        assert!(started.playing);
        assert_eq!(started.token, 7);

        // 止める指示のあとは、待つのをやめて眠る
        controller.stop().unwrap();
        transport.process(&mut left, &mut right);
        transport.process(&mut left, &mut right);
        {
            let mut state = lock(&watch.state);
            state.awaiting = None;
            state.awaiting_changed = true;
            state.kicked = true;
        }
        watch.wake.notify_all();
        let stopped = loop {
            let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            if !event.playing {
                break event;
            }
        };
        assert_eq!(stopped.token, 7);

        // 上限 (1.5 秒) を過ぎても始まらなければ、待つのをやめる: そのあとで始まっても、
        // 次の指示までは知らせない (止まっているあいだ、見に行き続けない)
        play(&mut controller, 8);
        ask(8);
        assert!(rx.recv_timeout(Duration::from_millis(1_900)).is_err());
        transport.process(&mut left, &mut right);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        // 次の指示で起きれば、そこで知らせる
        lock(&watch.state).kicked = true;
        watch.wake.notify_all();
        let late = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(late.playing && late.token == 8);

        lock(&watch.state).stop = true;
        watch.wake.notify_all();
        reporter.join().unwrap();
    }

    // ---- command を、IPC の口から呼ぶ (窓もデバイスも無し) ----

    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use tauri::ipc::CallbackFn;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::webview::InvokeRequest;
    use tauri::{Listener, Manager};

    /// デバイスを開かない代わりの出力。音声スレッドの代わりに、テストが `process` を回す。
    struct FakeOutput {
        broken: Arc<AtomicBool>,
    }

    impl OutputPort for FakeOutput {
        fn latency_sec(&self) -> f64 {
            0.0125
        }

        fn broken(&self) -> Broken {
            let broken = Arc::clone(&self.broken);
            Arc::new(move || broken.load(Ordering::Relaxed))
        }
    }

    /// 開かれた出力 1 つぶん (音声スレッドが持つ部品と、「使えなくなった」の印)。
    struct Opened {
        transport: bunri_audio::Transport,
        broken: Arc<AtomicBool>,
    }

    /// アプリ (窓の代わりの偽物) と、偽の出力。
    struct Rig {
        _app: tauri::App<MockRuntime>,
        window: WebviewWindow<MockRuntime>,
        /// 次に開く出力の周波数。0 なら「デバイスが無い」
        next_rate: Arc<AtomicU32>,
        opened: Arc<Mutex<Vec<Opened>>>,
        events: mpsc::Receiver<serde_json::Value>,
    }

    fn rig() -> Rig {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                audio_init,
                audio_clip_put,
                audio_clip_drop,
                audio_set_song,
                audio_play,
                audio_stop,
                audio_set_track,
                audio_set_metronome,
                audio_live_note,
                audio_live_all_off
            ])
            .build(mock_context(noop_assets()))
            .expect("テスト用のアプリを作れるはず");
        let next_rate = Arc::new(AtomicU32::new(48_000));
        let opened: Arc<Mutex<Vec<Opened>>> = Arc::default();
        let (rate, list) = (Arc::clone(&next_rate), Arc::clone(&opened));
        let opener: Opener = Box::new(move |_silent| {
            let rate = rate.load(Ordering::Relaxed);
            if rate == 0 {
                return Err("音声の出力デバイスが見つからない".into());
            }
            let (controller, transport) =
                bunri_audio::transport(rate).map_err(|e| e.to_string())?;
            let broken = Arc::new(AtomicBool::new(false));
            lock(&list).push(Opened {
                transport,
                broken: Arc::clone(&broken),
            });
            Ok((Box::new(FakeOutput { broken }), controller))
        });
        app.manage(AudioState::with_opener(app.handle().clone(), opener));
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("テスト用の窓を作れるはず");
        let (tx, events) = mpsc::channel();
        window.listen(POSITION_EVENT, move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).expect("event は JSON"));
        });
        Rig {
            _app: app,
            window,
            next_rate,
            opened,
            events,
        }
    }

    impl Rig {
        fn request(
            &self,
            cmd: &str,
            body: InvokeBody,
            headers: &[(&'static str, &str)],
        ) -> Result<serde_json::Value, String> {
            let mut map = tauri::http::HeaderMap::new();
            for (name, value) in headers {
                map.insert(*name, value.parse().expect("ヘッダの値"));
            }
            let request = InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("URL"),
                body,
                headers: map,
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            };
            get_ipc_response(&self.window, request)
                .map(|body| body.deserialize().expect("応答は JSON"))
                .map_err(|error| {
                    error
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or(error.to_string())
                })
        }

        /// 画面と同じ形 (JSON の引数) で command を呼ぶ。
        fn invoke(&self, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
            self.request(cmd, InvokeBody::Json(args), &[])
        }

        /// クリップの音声を 1 塊送る (画面の `invoke('audio_clip_put', Uint8Array, { headers })`)。
        fn put_clip(
            &self,
            id: u32,
            rate: u32,
            channels: usize,
            frames: usize,
            offset: usize,
            samples: &[f32],
        ) -> Result<serde_json::Value, String> {
            self.request(
                "audio_clip_put",
                InvokeBody::Raw(bytes(samples)),
                &[
                    ("x-clip-id", &id.to_string()),
                    ("x-sample-rate", &rate.to_string()),
                    ("x-channels", &channels.to_string()),
                    ("x-frames", &frames.to_string()),
                    ("x-offset", &offset.to_string()),
                ],
            )
        }

        /// いちばん新しい出力で、音声スレッドの代わりに `blocks` ブロック (256 フレームずつ) を作る。
        /// 作った音 (左) を返す。
        fn process(&self, blocks: usize) -> Vec<f32> {
            let mut opened = lock(&self.opened);
            let transport = &mut opened.last_mut().expect("出力が開いているはず").transport;
            let mut out = Vec::new();
            let (mut left, mut right) = ([0f32; 256], [0f32; 256]);
            for _ in 0..blocks {
                transport.process(&mut left, &mut right);
                out.extend_from_slice(&left);
            }
            out
        }

        fn opened_count(&self) -> usize {
            lock(&self.opened).len()
        }

        fn clip(&self, id: u32) -> Option<Arc<AudioData>> {
            let state = self.window.state::<AudioState>();
            let clip = lock(&state.inner.clips).get(id);
            clip
        }

        /// 条件に合う位置の event が届くまで待つ。
        fn wait_event(
            &self,
            what: &str,
            accept: impl Fn(&serde_json::Value) -> bool,
        ) -> serde_json::Value {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match self.events.recv_timeout(left) {
                    Ok(event) if accept(&event) => return event,
                    Ok(_) => continue,
                    Err(_) => panic!("event が届かない: {what}"),
                }
            }
        }
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0, |m, v| m.max(v.abs()))
    }

    /// ノートの在るトラック (ID 11) と、クリップ `clip` を置いたトラック (ID 22) の曲。
    fn two_track_song(clip: u32) -> serde_json::Value {
        serde_json::json!({ "song": {
            "bpm": 120, "offsetSec": 0, "beatsPerBar": 4,
            "tracks": [
                {
                    "id": 11, "gainDb": 0, "pan": -1, "audible": true,
                    "notes": [{ "start": 0, "length": 9600, "pitch": 69, "velocity": 96 }],
                    "clips": []
                },
                {
                    "id": 22, "gainDb": 0, "pan": -1, "audible": true,
                    "notes": [],
                    "clips": [{ "clip": clip, "startSec": 0 }]
                }
            ]
        }})
    }

    #[test]
    fn 出力を開く前は鳴らす指示だけがデバイスを開く() {
        let rig = rig();
        // 止める・動かすだけの指示は、開いていなければ何もしない
        assert_eq!(
            rig.invoke("audio_stop", serde_json::json!({})),
            Ok(serde_json::Value::Null)
        );
        let track = serde_json::json!({ "id": 1, "gainDb": -6, "pan": 0, "audible": true });
        assert!(rig.invoke("audio_set_track", track).is_ok());
        assert!(rig
            .invoke(
                "audio_set_metronome",
                serde_json::json!({ "enabled": true })
            )
            .is_ok());
        assert!(rig
            .invoke("audio_live_all_off", serde_json::json!({}))
            .is_ok());
        let release = serde_json::json!({ "pitch": 60, "velocity": 0 });
        assert!(rig.invoke("audio_live_note", release).is_ok());
        assert!(rig
            .invoke("audio_clip_drop", serde_json::json!({ "ids": [1, 2] }))
            .is_ok());
        assert_eq!(rig.opened_count(), 0);

        // 開く。もう一度呼んでも、開き直さない
        let init = rig.invoke("audio_init", serde_json::json!({})).unwrap();
        assert_eq!(
            init,
            serde_json::json!({ "sampleRate": 48_000, "outputLatencySec": 0.0125 })
        );
        assert_eq!(
            rig.invoke("audio_init", serde_json::json!({})).unwrap(),
            init
        );
        assert_eq!(rig.opened_count(), 1);

        // 曲を渡す前の再生は断る
        let play = serde_json::json!({
            "token": 1, "fromSec": 0, "loop": null, "countIn": null, "metronome": false
        });
        let error = rig.invoke("audio_play", play).unwrap_err();
        assert!(error.contains("曲がまだ渡されていません"), "{error}");
    }

    #[test]
    fn 出力デバイスを開けなければ理由を返す() {
        let rig = rig();
        rig.next_rate.store(0, Ordering::Relaxed);
        let error = rig.invoke("audio_init", serde_json::json!({})).unwrap_err();
        assert!(error.contains("出力デバイスが見つからない"), "{error}");
        let press = serde_json::json!({ "pitch": 60, "velocity": 100 });
        assert!(rig.invoke("audio_live_note", press.clone()).is_err());
        // デバイスがつながったら、次の呼び出しで開ける
        rig.next_rate.store(44_100, Ordering::Relaxed);
        assert!(rig.invoke("audio_live_note", press).is_ok());
        assert_eq!(rig.opened_count(), 1);
    }

    #[test]
    fn 音声の塊は生のバイト列とヘッダで届く() {
        let rig = rig();
        let complete = |done: bool| Ok(serde_json::json!({ "complete": done }));
        // ステレオ 3 フレームを 2 + 1 に分ける。塊の中はチャンネルごとに並ぶ
        assert_eq!(
            rig.put_clip(4, 44_100, 2, 3, 0, &[1.0, 2.0, -1.0, -2.0]),
            complete(false)
        );
        assert_eq!(
            rig.put_clip(4, 44_100, 2, 3, 2, &[3.0, -3.0]),
            complete(true)
        );
        let audio = rig.clip(4).unwrap();
        assert_eq!(audio.sample_rate(), 44_100);
        assert_eq!(audio.left(), [1.0, 2.0, 3.0]);
        assert_eq!(audio.right(), [-1.0, -2.0, -3.0]);
        // 出力デバイスは開かない (音声を受け取るだけ)
        assert_eq!(rig.opened_count(), 0);

        // 専用の経路が使えず、数の配列の JSON で届いたときも受け取る
        let as_json = serde_json::json!(bytes(&[0.5, 0.25]));
        let headers = [
            ("x-clip-id", "6"),
            ("x-sample-rate", "48000"),
            ("x-channels", "1"),
            ("x-frames", "2"),
            ("x-offset", "0"),
        ];
        assert_eq!(
            rig.request("audio_clip_put", InvokeBody::Json(as_json), &headers),
            complete(true)
        );
        assert_eq!(rig.clip(6).unwrap().left(), [0.5, 0.25]);

        // ヘッダが足りない・数でない・順番が違う塊は断る
        let raw = || InvokeBody::Raw(bytes(&[0.0]));
        let error = rig
            .request("audio_clip_put", raw(), &headers[..4])
            .unwrap_err();
        assert!(error.contains("x-offset"), "{error}");
        let mut bad = headers;
        bad[2] = ("x-channels", "two");
        assert!(rig.request("audio_clip_put", raw(), &bad).is_err());
        assert!(rig.put_clip(7, 48_000, 1, 4, 2, &[0.0, 0.0]).is_err());

        // 捨てる
        assert!(rig
            .invoke("audio_clip_drop", serde_json::json!({ "ids": [4, 999] }))
            .is_ok());
        assert!(rig.clip(4).is_none());
        assert!(rig.clip(6).is_some());
    }

    #[test]
    fn 曲を渡して再生し位置を窓へ送る() {
        let rig = rig();
        rig.invoke("audio_init", serde_json::json!({})).unwrap();
        // 24kHz のクリップ (0.1 秒の一定の値)。出力は 48kHz なので、曲を渡すときに一度だけ変換する
        rig.put_clip(5, 24_000, 1, 2_400, 0, &vec![0.5; 2_400])
            .unwrap();
        // 届いていないクリップを使う曲は断る
        let error = rig.invoke("audio_set_song", two_track_song(8)).unwrap_err();
        assert!(error.contains("クリップ 8"), "{error}");

        assert_eq!(
            rig.invoke("audio_set_song", two_track_song(5)),
            Ok(serde_json::Value::Null)
        );
        let converted = rig.clip(5).unwrap();
        assert_eq!(
            (converted.sample_rate(), converted.frames()),
            (48_000, 4_800)
        );
        // もう一度渡しても、変換し直さない (同じ音声を使い回す)
        rig.invoke("audio_set_song", two_track_song(5)).unwrap();
        assert!(Arc::ptr_eq(&rig.clip(5).unwrap(), &converted));
        rig.process(1);

        // 区間ループ (0〜0.05 秒) で再生する
        let play = serde_json::json!({
            "token": 9, "fromSec": 0.01,
            "loop": { "startSec": 0, "endSec": 0.05 },
            "countIn": null, "metronome": false
        });
        assert_eq!(rig.invoke("audio_play", play), Ok(serde_json::Value::Null));
        let out = rig.process(8);
        // クリップ (0.5。左いっぱい) とノート (山 0.25) が鳴っている
        assert!(peak(&out[1_024..]) > 0.5, "{}", peak(&out));
        let event = rig.wait_event("再生中", |e| e["playing"] == true);
        assert_eq!(event["token"], 9);
        assert_eq!(event["countingIn"], false);
        let position = event["positionSec"].as_f64().unwrap();
        assert!((0.0..0.05).contains(&position), "{position}");
        assert!(event["atMs"].as_f64().unwrap() > 1.6e12);
        // 何周かすると、周の数が進む
        rig.process(20);
        rig.wait_event("2 周目より後ろ", |e| e["pass"].as_u64() >= Some(2));

        // 再生中にトラックを動かす: クリップのトラックを無音に、ノートのトラックを鳴らさない
        let mute_clip = serde_json::json!({ "id": 22, "gainDb": null, "pan": -1, "audible": true });
        let mute_notes = serde_json::json!({ "id": 11, "gainDb": 0, "pan": -1, "audible": false });
        // いまの曲に無い ID は無視する
        let unknown = serde_json::json!({ "id": 999, "gainDb": 0, "pan": 0, "audible": false });
        for args in [mute_clip, mute_notes, unknown] {
            assert_eq!(
                rig.invoke("audio_set_track", args),
                Ok(serde_json::Value::Null)
            );
        }
        let out = rig.process(8);
        assert_eq!(peak(&out[1_024..]), 0.0);

        // 止めると、止まったことを 1 回知らせる
        assert_eq!(
            rig.invoke("audio_stop", serde_json::json!({})),
            Ok(serde_json::Value::Null)
        );
        rig.process(2);
        let stopped = rig.wait_event("停止", |e| e["playing"] == false);
        assert_eq!(stopped["token"], 9);
        assert_eq!(rig.opened_count(), 1);
    }

    #[test]
    fn カウントとメトロノームの引数が届く() {
        let rig = rig();
        let empty = serde_json::json!({ "song": {
            "bpm": 120, "offsetSec": 0, "beatsPerBar": 4, "tracks": []
        }});
        rig.invoke("audio_set_song", empty).unwrap();
        // カウント 2 拍 (1 拍 0.06 秒 = 2880 フレーム)。0.5 秒 (2 拍目の位置) から
        let play = serde_json::json!({
            "token": 3, "fromSec": 0.5, "loop": null,
            "countIn": { "beats": 2, "beatSec": 0.06 }, "metronome": true
        });
        rig.invoke("audio_play", play).unwrap();
        let click = |x: &[f32]| (0.25..=0.3).contains(&peak(x));
        // 曲は空なので、鳴っているのはカウントのクリック (山 0.3) だけ。0 と 2880 フレームで鳴る
        let out = rig.process(12);
        assert!(click(&out[..64]), "{}", peak(&out[..64]));
        assert_eq!(peak(&out[2_400..2_880]), 0.0);
        assert!(click(&out[2_880..2_944]), "{}", peak(&out[2_880..2_944]));
        let event = rig.wait_event("カウント中", |e| e["countingIn"] == true);
        assert_eq!(event["playing"], true);
        assert_eq!(event["positionSec"], 0.5);
        // 曲が始まるまでの残り (カウントは 0.12 秒) も一緒に届く
        let remaining = event["countInRemainingSec"].as_f64().unwrap();
        assert!(remaining > 0.0 && remaining <= 0.12, "{remaining}");
        // カウントが終わる (5760 フレーム) と曲が進み、そこが拍の位置なのでメトロノームが鳴る
        let out = rig.process(12);
        assert_eq!(peak(&out[2_400..2_688]), 0.0);
        assert!(click(&out[2_688..2_752]), "{}", peak(&out[2_688..2_752]));
        let event = rig.wait_event("カウントのあと", |e| {
            e["countingIn"] == false && e["positionSec"].as_f64() > Some(0.5)
        });
        assert_eq!(event["countInRemainingSec"], 0.0);
        // メトロノームを切ると、次の拍 (1.0 秒) では鳴らない
        let off = serde_json::json!({ "enabled": false });
        rig.invoke("audio_set_metronome", off).unwrap();
        let out = rig.process(100);
        assert_eq!(peak(&out[2_400..]), 0.0);

        // 整数でない拍数は断る
        let bad = serde_json::json!({
            "token": 4, "fromSec": 0, "loop": null,
            "countIn": { "beats": 1.5, "beatSec": 0.5 }, "metronome": false
        });
        assert!(rig.invoke("audio_play", bad).is_err());
        // 終わりが頭より前の区間も断る
        let bad = serde_json::json!({
            "token": 4, "fromSec": 0, "loop": { "startSec": 2, "endSec": 1 },
            "countIn": null, "metronome": false
        });
        assert!(rig.invoke("audio_play", bad).is_err());
    }

    #[test]
    fn 鍵盤の試聴は出力を開いて鳴らし強さ0で離す() {
        let rig = rig();
        let note = |pitch: f64, velocity: f64| {
            rig.invoke(
                "audio_live_note",
                serde_json::json!({ "pitch": pitch, "velocity": velocity }),
            )
        };
        assert_eq!(note(69.0, 96.0), Ok(serde_json::Value::Null));
        assert_eq!(rig.opened_count(), 1);
        let out = rig.process(8);
        assert!((peak(&out[240..]) - 0.25).abs() < 0.002, "{}", peak(&out));
        // 離すと 50ms (2400 フレーム) で消える
        assert_eq!(note(69.0, 0.0), Ok(serde_json::Value::Null));
        let out = rig.process(12);
        assert!(peak(&out[..1_200]) > 0.1);
        assert_eq!(peak(&out[2_400..]), 0.0);
        // 全部離す
        note(60.0, 100.0).unwrap();
        note(64.0, 100.0).unwrap();
        rig.process(4);
        rig.invoke("audio_live_all_off", serde_json::json!({}))
            .unwrap();
        assert_eq!(peak(&rig.process(12)[2_400..]), 0.0);
        // 範囲の外の高さは断る
        assert!(note(128.0, 100.0).is_err());
        assert!(note(-1.0, 100.0).is_err());
    }

    #[test]
    fn メインの窓か再生を頼んだ窓が無くなったら音を止める() {
        let rig = rig();
        rig.put_clip(5, 48_000, 1, 48_000, 0, &vec![0.5; 48_000])
            .unwrap();
        rig.invoke("audio_set_song", two_track_song(5)).unwrap();
        let play = |token: u64| {
            let args = serde_json::json!({
                "token": token, "fromSec": 0, "loop": null, "countIn": null, "metronome": false
            });
            rig.invoke("audio_play", args).unwrap();
        };
        let press = serde_json::json!({ "pitch": 72, "velocity": 100 });
        let state = rig.window.state::<AudioState>();
        let playing = || {
            lock(&state.inner.session)
                .as_ref()
                .unwrap()
                .controller
                .position()
                .playing
        };

        // 再生して、試聴の音も押したままにする
        play(1);
        rig.invoke("audio_live_note", press.clone()).unwrap();
        assert!(peak(&rig.process(8)) > 0.5);
        rig.wait_event("再生中", |e| e["playing"] == true && e["token"] == 1);

        // 関係の無い窓 (ツールなど) が閉じても、鳴り続ける
        state.window_destroyed("window-3", false);
        assert!(peak(&rig.process(8)) > 0.5);
        assert!(playing());

        // メインの窓が無くなったら、再生を止め、押したままの試聴も離す (50ms で消える)
        state.window_destroyed("main", true);
        let out = rig.process(16);
        assert!(!playing());
        assert_eq!(peak(&out[2_600..]), 0.0, "窓が無くなったあとも鳴っている");
        // 位置を送る先も無くなったので、もう送らない
        while rig.events.try_recv().is_ok() {}
        assert!(rig.events.recv_timeout(Duration::from_millis(150)).is_err());

        // 再生を頼んだ窓が (メインでなくても) 無くなったら、止める
        play(2);
        rig.invoke("audio_live_note", press).unwrap();
        assert!(peak(&rig.process(8)) > 0.5);
        state.window_destroyed("main", false);
        let out = rig.process(16);
        assert!(!playing());
        assert_eq!(peak(&out[2_600..]), 0.0);

        // 別の窓 (ツールなど) が頼んだ再生も、メインの窓が無くなったら止める
        let options = PlayOptions {
            token: 3,
            ..PlayOptions::default()
        };
        state.inner.play("window-3", options).unwrap();
        assert!(peak(&rig.process(8)) > 0.5);
        assert!(playing());
        state.window_destroyed("main", true);
        rig.process(2);
        assert!(!playing());
        // 頼んだ窓は残っているので、送る先はそのまま (止まったことを、その窓へ知らせる)
        assert_eq!(
            lock(&state.inner.watch.state).label.as_deref(),
            Some("window-3")
        );

        // 出力を開いていないアプリで窓が無くなっても、デバイスを開かない
        let idle = self::rig();
        idle.window
            .state::<AudioState>()
            .window_destroyed("main", true);
        assert_eq!(idle.opened_count(), 0);
    }

    #[test]
    fn 出力が使えなくなったら次の再生で開き直して曲を渡し直す() {
        let rig = rig();
        rig.put_clip(5, 48_000, 1, 4_800, 0, &vec![0.5; 4_800])
            .unwrap();
        rig.invoke("audio_set_song", two_track_song(5)).unwrap();
        let play = |token: u64| {
            rig.invoke(
                "audio_play",
                serde_json::json!({
                    "token": token, "fromSec": 0, "loop": null, "countIn": null, "metronome": false
                }),
            )
        };
        play(1).unwrap();
        assert!(peak(&rig.process(4)) > 0.5);
        rig.wait_event("再生中", |e| e["playing"] == true && e["token"] == 1);

        // デバイスが外れた: 再生は止まったと知らせる
        lock(&rig.opened)[0].broken.store(true, Ordering::Relaxed);
        let lost = rig.wait_event("使えなくなった", |e| e["playing"] == false);
        assert_eq!(lost["token"], 1);

        // 使えなくなった出力には、止める・動かす指示を積まない (受け取る相手が居ない)
        for _ in 0..300 {
            assert_eq!(
                rig.invoke("audio_stop", serde_json::json!({})),
                Ok(serde_json::Value::Null)
            );
        }
        assert_eq!(rig.opened_count(), 1);

        // 次の再生で開き直す。新しいデバイスは 44.1kHz
        rig.next_rate.store(44_100, Ordering::Relaxed);
        play(2).unwrap();
        assert_eq!(rig.opened_count(), 2);
        // 曲は渡し直してあり (クリップは新しい周波数に変換してある)、新しい出力で鳴る
        let converted = rig.clip(5).unwrap();
        assert_eq!(
            (converted.sample_rate(), converted.frames()),
            (44_100, 4_410)
        );
        assert!(peak(&rig.process(4)) > 0.5);
        rig.wait_event("開き直したあと", |e| {
            e["playing"] == true && e["token"] == 2
        });
        let init = rig.invoke("audio_init", serde_json::json!({})).unwrap();
        assert_eq!(init["sampleRate"], 44_100);
        assert_eq!(rig.opened_count(), 2);
    }
}
