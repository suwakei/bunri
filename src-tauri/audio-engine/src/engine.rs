//! 曲の内容を持ち、ブロックごとに音を作る。
//!
//! 再生・試聴・書き出しは、どれもこの [`Engine`] を通す (聞いた音と書き出した音が
//! 食い違わないように)。書き出しは `render` が同じ `process` をオフラインで回す。
//!
//! # 音声スレッドでの約束
//!
//! [`Engine::new`] は重い (SFZ を読み、クリップの周波数を変換し、メモリを確保する) ので、
//! 音声スレッドの外で呼ぶ。出来上がった `Engine` は音声スレッドへ移せる (`Send`)。
//!
//! [`Engine::process`]・[`Engine::seek`]・[`Engine::is_sounding`]・[`Engine::silence`] と、
//! 再生中にトラックを動かす [`Engine::set_track_mix`]・[`Engine::set_track_audible`] は、
//! メモリの確保と解放・ロック・ファイルの読み書き・ログ出力をしない (テスト
//! `tests/realtime.rs` が、Rust の側でメモリを確保していないことを確かめる)。ただしオフラインのモード
//! ([`Engine::set_offline`]) のあいだは、sfizz がディスクからの読み込みを待つので、
//! リアルタイムの再生では使わない。
//!
//! `Engine` を捨てるとメモリの解放が起きる。音声スレッドでは捨てず、別のスレッドへ
//! 送り返してから捨てる。

use crate::audio::{AudioError, SAMPLE_RATE_RANGE};
use crate::clips::PlacedClip;
use crate::mixer::{audible, db_to_gain, GainRamp, TrackGains};
use crate::sampler::{LoadError, Sampler};
use crate::song::{Instrument, Note, Song};
use crate::tone::{ToneConfig, ToneSynth};
use std::fmt;

/// 1 回に作るブロックの上限 (フレーム)。sfizz はノートを鳴らしたブロックの中を、
/// メモリに置いたサンプルの頭 (既定 8192 フレーム) だけで鳴らす。ブロックが長いと
/// 頭が足りなくなって声が途中で終わるので、十分に短くしておく
/// (高い音は速く読み進む。1024 なら 3 オクターブ上まで足りる)
pub const MAX_BLOCK_LIMIT: usize = 1024;

/// 再生中にトラックの音量・パン・鳴らすかを変えたとき、倍率を移す長さ (秒)。
/// 急に変えると「ぷつっ」と鳴るので、短い直線で移す
const MIX_RAMP_SEC: f64 = 0.005;

/// engine の設定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineConfig {
    /// 出力のサンプリング周波数 (Hz)
    pub sample_rate: u32,
    /// 中で一度に作るブロックの最大のフレーム数 (1〜[`MAX_BLOCK_LIMIT`])。
    /// `process` にはこれより長いバッファも渡せる (中で区切る)
    pub max_block: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            sample_rate: 48_000,
            max_block: 512,
        }
    }
}

/// engine を組み立てられなかったときのエラー。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// 設定の値が範囲の外
    InvalidConfig(String),
    /// 曲の内容に、音にできない値がある (テンポが 0、数値が NaN など)
    InvalidSong(String),
    /// トラック (`track` は 0 始まりの番号) の楽器を読めなかった
    Instrument { track: usize, error: LoadError },
    /// トラックのクリップ (どちらも 0 始まりの番号) の音声を使えなかった
    Clip {
        track: usize,
        clip: usize,
        error: AudioError,
    },
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::InvalidConfig(why) => write!(f, "engine の設定が正しくない: {why}"),
            EngineError::InvalidSong(why) => write!(f, "曲の内容が正しくない: {why}"),
            EngineError::Instrument { track, error } => {
                write!(f, "トラック {} の楽器: {error}", track + 1)
            }
            EngineError::Clip { track, clip, error } => {
                write!(f, "トラック {} のクリップ {}: {error}", track + 1, clip + 1)
            }
        }
    }
}

impl std::error::Error for EngineError {}

/// サンプラーに送る出来事 1 つ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Event {
    frame: u64,
    pitch: u8,
    kind: EventKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventKind {
    Off,
    /// 鳴らす (強さ)
    On(u8),
}

/// ノートが鳴っている区間。途中から再生するときに、またいでいるノートを探すのに使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    start: u64,
    /// 離す位置。同じ高さのノートが重なっているときは、最後の 1 つが終わる位置
    end: u64,
    pitch: u8,
    velocity: u8,
}

/// トラックのノートを鳴らすもの。
enum Source {
    /// SFZ の楽器。ステレオの素材として混ぜる
    Sampler(Sampler),
    /// 仮の音 (三角波)。モノラルの素材として混ぜる
    Tone(ToneSynth),
}

impl Source {
    fn note_on(&mut self, delay: usize, pitch: u8, velocity: u8) {
        match self {
            Source::Sampler(sampler) => sampler.note_on(delay, pitch, velocity),
            Source::Tone(tone) => tone.note_on(delay, pitch, velocity),
        }
    }

    fn note_off(&mut self, delay: usize, pitch: u8) {
        match self {
            Source::Sampler(sampler) => sampler.note_off(delay, pitch),
            Source::Tone(tone) => tone.note_off(delay, pitch),
        }
    }

    fn all_sound_off(&mut self) {
        match self {
            Source::Sampler(sampler) => sampler.all_sound_off(),
            Source::Tone(tone) => tone.all_sound_off(),
        }
    }

    fn active_voices(&self) -> usize {
        match self {
            Source::Sampler(sampler) => sampler.active_voices(),
            Source::Tone(tone) => tone.active_voices(),
        }
    }
}

/// トラック 1 本ぶんの状態。
struct TrackState {
    source: Option<Source>,
    /// 位置の順に並べた出来事
    events: Vec<Event>,
    /// 次に送る出来事
    next_event: usize,
    spans: Vec<Span>,
    stereo_clips: Vec<PlacedClip>,
    mono_clips: Vec<PlacedClip>,
    /// 音量とパンから決まる倍率 (鳴らしているときの行き先)
    mix: TrackGains,
    /// いま掛けている倍率 (移り変わりの途中のことが在る)
    ramp: GainRamp,
    /// 鳴らすトラックか (ミュートとソロの結果。再生中に [`Engine::set_track_audible`] で変わる)
    audible: bool,
    /// 音を作っているか。鳴らさない側に変えた直後は、倍率が 0 に着くまで作り続ける
    running: bool,
}

impl TrackState {
    /// `frame` から鳴らし始められるようにする: 鳴っている音を止め、次に送る出来事を合わせ、
    /// `frame` をまたいでいるノート (前から鳴っていて、まだ終わっていないもの) を鳴らし直す。
    fn restart_at(&mut self, frame: u64) {
        let Some(source) = self.source.as_mut() else {
            return;
        };
        source.all_sound_off();
        self.next_event = self.events.partition_point(|e| e.frame < frame);
        for span in &self.spans {
            if span.start < frame && frame < span.end {
                source.note_on(0, span.pitch, span.velocity);
            }
        }
    }
}

/// 曲 1 つぶんの音を作る engine。
pub struct Engine {
    sample_rate: u32,
    max_block: usize,
    tracks: Vec<TrackState>,
    master: f32,
    /// 倍率を移す長さ (フレーム)
    ramp_frames: u32,
    /// 次に作るフレームの位置
    position: u64,
    /// 曲の長さ (いちばん後ろのクリップかノートの終わり)
    length: u64,
    // トラックの音をいったん受ける作業用のバッファ (`max_block` フレーム)
    bus_left: Vec<f32>,
    bus_right: Vec<f32>,
    bus_mono: Vec<f32>,
}

impl Engine {
    /// 曲の内容から engine を組み立てる。位置は曲の頭 (0)。
    ///
    /// 楽器 (SFZ) を読み込み、engine と周波数が違うクリップを変換する。時間がかかり、
    /// メモリも確保するので、音声スレッドでは呼ばない。
    pub fn new(song: &Song, config: &EngineConfig) -> Result<Self, EngineError> {
        if !SAMPLE_RATE_RANGE.contains(&config.sample_rate) {
            return Err(EngineError::InvalidConfig(format!(
                "サンプリング周波数 {}Hz は扱えない",
                config.sample_rate
            )));
        }
        if !(1..=MAX_BLOCK_LIMIT).contains(&config.max_block) {
            return Err(EngineError::InvalidConfig(format!(
                "ブロックの長さは 1〜{MAX_BLOCK_LIMIT} フレーム (指定は {})",
                config.max_block
            )));
        }
        validate(song)?;

        let mute_solo: Vec<(bool, bool)> = song.tracks.iter().map(|t| (t.mute, t.solo)).collect();
        let audible = audible(&mute_solo);
        let mut length = 0u64;
        let mut tracks = Vec::with_capacity(song.tracks.len());
        for (index, (track, audible)) in song.tracks.iter().zip(audible).enumerate() {
            let (events, spans, notes_end) = schedule(song, &track.notes, config.sample_rate);
            length = length.max(notes_end);

            let source = match &track.instrument {
                Some(Instrument::Sampler { sfz }) => {
                    let mut sampler = Sampler::new(config.sample_rate as f32, config.max_block);
                    sampler
                        .load_file(sfz)
                        .map_err(|error| EngineError::Instrument {
                            track: index,
                            error,
                        })?;
                    Some(Source::Sampler(sampler))
                }
                Some(Instrument::Tone) => Some(Source::Tone(ToneSynth::new(
                    config.sample_rate,
                    &ToneConfig::NOTE,
                ))),
                None => None,
            };

            let (mut stereo_clips, mut mono_clips) = (Vec::new(), Vec::new());
            for (clip_index, clip) in track.clips.iter().enumerate() {
                let placed = PlacedClip::new(&clip.audio, clip.start_sec, config.sample_rate)
                    .map_err(|error| EngineError::Clip {
                        track: index,
                        clip: clip_index,
                        error,
                    })?;
                length = length.max(placed.end().max(0) as u64);
                if placed.is_stereo() {
                    stereo_clips.push(placed);
                } else {
                    mono_clips.push(placed);
                }
            }

            let mix = TrackGains::new(track.gain_db, track.pan);
            tracks.push(TrackState {
                // 楽器が無いトラックのノートは鳴らさない
                events: if source.is_some() { events } else { Vec::new() },
                spans: if source.is_some() { spans } else { Vec::new() },
                source,
                next_event: 0,
                stereo_clips,
                mono_clips,
                mix,
                ramp: GainRamp::settled_at(if audible { mix } else { TrackGains::SILENT }),
                audible,
                running: audible,
            });
        }

        Ok(Engine {
            sample_rate: config.sample_rate,
            max_block: config.max_block,
            tracks,
            master: db_to_gain(song.master_gain_db),
            ramp_frames: ((config.sample_rate as f64 * MIX_RAMP_SEC).round() as u32).max(1),
            position: 0,
            length,
            bus_left: vec![0.0; config.max_block],
            bus_right: vec![0.0; config.max_block],
            bus_mono: vec![0.0; config.max_block],
        })
    }

    /// 出力のサンプリング周波数 (Hz)。
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// 次に作るフレームの位置。
    pub fn position(&self) -> u64 {
        self.position
    }

    /// 曲の長さ (フレーム)。いちばん後ろのクリップかノートの終わり。ミュートしたトラックと、
    /// 楽器が無いトラックのノートも数える。余韻 (離したあとの響き) は含まない。
    pub fn length_frames(&self) -> u64 {
        self.length
    }

    /// トラックの数。
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// 位置を `frame` に移す。鳴っている音は止める。
    ///
    /// 移った先をまたいでいるノート (前から鳴っていて、まだ終わっていないもの) は、
    /// 移った先から鳴らし直す (いまの画面側の再生と同じ)。トラックの音量・パン・鳴らすかの
    /// 移り変わりの途中だったら、行き先の値にしてから始める。
    pub fn seek(&mut self, frame: u64) {
        self.position = frame;
        for track in &mut self.tracks {
            track.ramp = GainRamp::settled_at(if track.audible {
                track.mix
            } else {
                TrackGains::SILENT
            });
            track.running = track.audible;
            if track.running {
                track.restart_at(frame);
            } else if let Some(source) = track.source.as_mut() {
                source.all_sound_off();
            }
        }
    }

    /// 鳴っている音 (ノートと、離したあとの余韻) をすべて止める。位置は変えない。
    /// 再生を止めるときに呼ぶ。続きを鳴らすには [`Engine::seek`] で位置を決め直す。
    pub fn silence(&mut self) {
        for source in self.tracks.iter_mut().filter_map(|t| t.source.as_mut()) {
            source.all_sound_off();
        }
    }

    /// トラック (`track` は 0 始まりの番号) の音量 (dB) とパン (-1.0〜1.0) を変える。
    ///
    /// 短い直線で移す (急に変えると「ぷつっ」と鳴る)。無い番号と、数値でない値は無視する。
    pub fn set_track_mix(&mut self, track: usize, gain_db: f32, pan: f32) {
        let ramp_frames = self.ramp_frames;
        let Some(track) = self.tracks.get_mut(track) else {
            return;
        };
        if gain_db.is_nan() || pan.is_nan() {
            return;
        }
        let mix = TrackGains::new(gain_db, pan);
        if mix == track.mix {
            return;
        }
        track.mix = mix;
        if track.audible {
            track.ramp.retarget(mix, ramp_frames);
        }
    }

    /// トラック (`track` は 0 始まりの番号) を鳴らすかを変える。無い番号は無視する。
    ///
    /// 曲を組み立てたときのミュートとソロの結果を、トラックごとに上書きする (ほかのトラックの
    /// ソロは見ない。どれを鳴らすかは、呼ぶ側が決める)。
    ///
    /// - 鳴らす側に変えたら、いまの位置をまたいでいるノートを鳴らし直し、次に送る出来事の
    ///   位置を合わせて、短い直線で音量を上げる
    /// - 鳴らさない側に変えたら、短い直線で音量を下げてから、鳴っている音を止める
    pub fn set_track_audible(&mut self, track: usize, audible: bool) {
        let (ramp_frames, position) = (self.ramp_frames, self.position);
        let Some(track) = self.tracks.get_mut(track) else {
            return;
        };
        if track.audible == audible {
            return;
        }
        track.audible = audible;
        if audible {
            // 下げている途中 (まだ音を作っている) なら、そのまま上げ直す
            if !track.running {
                track.restart_at(position);
                track.running = true;
            }
            track.ramp.retarget(track.mix, ramp_frames);
        } else {
            track.ramp.retarget(TrackGains::SILENT, ramp_frames);
        }
    }

    /// まだ音が鳴っているか (ノートを離したあとの余韻を含む)。クリップは数えない
    /// (クリップは曲の長さの中で終わる)。
    pub fn is_sounding(&self) -> bool {
        self.tracks
            .iter()
            .filter(|t| t.running)
            .filter_map(|t| t.source.as_ref())
            .any(|s| s.active_voices() > 0)
    }

    /// オフラインのモード (書き出し用) を切り替える。
    ///
    /// 有効のあいだは、`process` のたびにサンプルの読み込みが終わるのを待つ。実時間より
    /// 速く回しても音の続きが欠けないが、待つので、リアルタイムの再生では無効にしておく。
    pub fn set_offline(&mut self, offline: bool) {
        for source in self.tracks.iter_mut().filter_map(|t| t.source.as_mut()) {
            // 仮の音は計算で作るので、待つものが無い
            if let Source::Sampler(sampler) = source {
                sampler.set_offline(offline);
            }
        }
    }

    /// いまの位置から `left.len()` フレームぶんの音を作り、位置を進める。
    ///
    /// `left` と `right` は同じ長さ。中身は上書きする。長さに上限は無い
    /// (`max_block` ごとに区切って作る)。曲の終わりを過ぎても作り続けられる
    /// (余韻が鳴り、やがて無音になる)。
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        assert_eq!(left.len(), right.len(), "左右の長さが違う");
        for (l, r) in left
            .chunks_mut(self.max_block)
            .zip(right.chunks_mut(self.max_block))
        {
            self.process_block(l, r);
        }
    }

    /// `max_block` 以下の 1 ブロックを作る。
    fn process_block(&mut self, left: &mut [f32], right: &mut [f32]) {
        let len = left.len();
        let pos = self.position;
        let end = pos + len as u64;
        let bus_left = &mut self.bus_left[..len];
        let bus_right = &mut self.bus_right[..len];
        let bus_mono = &mut self.bus_mono[..len];
        left.fill(0.0);
        right.fill(0.0);

        for track in self.tracks.iter_mut().filter(|t| t.running) {
            // このブロックに入る出来事を、ブロックの中の位置 (フレーム) を付けて送る
            if let Some(source) = track.source.as_mut() {
                while let Some(event) = track.events.get(track.next_event) {
                    if event.frame >= end {
                        break;
                    }
                    let delay = event.frame.saturating_sub(pos) as usize;
                    match event.kind {
                        EventKind::On(velocity) => source.note_on(delay, event.pitch, velocity),
                        EventKind::Off => source.note_off(delay, event.pitch),
                    }
                    track.next_event += 1;
                }
            }

            // ステレオの素材: サンプラーと、ステレオのクリップ
            let mut stereo = false;
            if let Some(Source::Sampler(sampler)) = track.source.as_mut() {
                sampler.render(bus_left, bus_right);
                stereo = true;
            }
            if !track.stereo_clips.is_empty() {
                if !stereo {
                    bus_left.fill(0.0);
                    bus_right.fill(0.0);
                    stereo = true;
                }
                for clip in &track.stereo_clips {
                    clip.add_stereo(pos, bus_left, bus_right);
                }
            }
            if stereo {
                mix_stereo(left, right, bus_left, bus_right, &track.ramp);
            }

            // モノラルの素材: 仮の音と、モノラルのクリップ (パンの決まりがステレオと違う。`mixer`)
            let mut mono = false;
            if let Some(Source::Tone(tone)) = track.source.as_mut() {
                tone.render(bus_mono);
                mono = true;
            }
            if !track.mono_clips.is_empty() {
                if !mono {
                    bus_mono.fill(0.0);
                    mono = true;
                }
                for clip in &track.mono_clips {
                    clip.add_mono(pos, bus_mono);
                }
            }
            if mono {
                mix_mono(left, right, bus_mono, &track.ramp);
            }

            track.ramp.advance(len);
            // 鳴らさない側に変えたトラックは、音量が 0 に着いたところで音を止める
            if !track.audible && track.ramp.is_settled() {
                track.running = false;
                if let Some(source) = track.source.as_mut() {
                    source.all_sound_off();
                }
            }
        }

        if self.master != 1.0 {
            for v in left.iter_mut().chain(right.iter_mut()) {
                *v *= self.master;
            }
        }
        self.position = end;
    }
}

/// ステレオの素材 (`bus_left` / `bus_right`) を、トラックの倍率を掛けて出力に足す。
fn mix_stereo(
    left: &mut [f32],
    right: &mut [f32],
    bus_left: &[f32],
    bus_right: &[f32],
    ramp: &GainRamp,
) {
    let frames = left.iter_mut().zip(right.iter_mut());
    let bus = bus_left.iter().zip(bus_right.iter());
    if ramp.is_settled() {
        let g = ramp.target();
        for ((l, r), (bl, br)) in frames.zip(bus) {
            *l += g.ll * bl + g.lr * br;
            *r += g.rl * bl + g.rr * br;
        }
    } else {
        // 倍率を移している途中は、フレームごとに倍率を求める
        for (i, ((l, r), (bl, br))) in frames.zip(bus).enumerate() {
            let g = ramp.at(i);
            *l += g.ll * bl + g.lr * br;
            *r += g.rl * bl + g.rr * br;
        }
    }
}

/// モノラルの素材 (`bus`) を、トラックの倍率を掛けて出力に足す。
fn mix_mono(left: &mut [f32], right: &mut [f32], bus: &[f32], ramp: &GainRamp) {
    let frames = left.iter_mut().zip(right.iter_mut());
    if ramp.is_settled() {
        let g = ramp.target();
        for ((l, r), m) in frames.zip(bus) {
            *l += g.ml * m;
            *r += g.mr * m;
        }
    } else {
        for (i, ((l, r), m)) in frames.zip(bus).enumerate() {
            let g = ramp.at(i);
            *l += g.ml * m;
            *r += g.mr * m;
        }
    }
}

/// 曲の内容に、音にできない値が無いか確かめる。
fn validate(song: &Song) -> Result<(), EngineError> {
    let invalid = |why: String| Err(EngineError::InvalidSong(why));
    if !(song.bpm.is_finite() && song.bpm > 0.0) {
        return invalid(format!("テンポ {} は使えない", song.bpm));
    }
    if !song.offset_sec.is_finite() {
        return invalid("1 小節目の位置が数値でない".into());
    }
    if song.master_gain_db.is_nan() {
        return invalid("マスターの音量が数値でない".into());
    }
    for (i, track) in song.tracks.iter().enumerate() {
        if track.gain_db.is_nan() || track.pan.is_nan() {
            return invalid(format!("トラック {} の音量かパンが数値でない", i + 1));
        }
        if track.clips.iter().any(|c| !c.start_sec.is_finite()) {
            return invalid(format!("トラック {} のクリップの位置が数値でない", i + 1));
        }
    }
    Ok(())
}

/// ノートの並びを、サンプラーに送る出来事 (位置の順) と、鳴っている区間にする。
/// ノートの終わりのうち、いちばん後ろの位置 (フレーム) も返す。
///
/// - 同じフレームでは、離す方を先に送る (同じ高さの連打で、次の音を止めてしまわないように)
/// - 同じ高さのノートが重なっているあいだは離さない。最後の 1 つが終わるところで離す
///   (sfizz は「その高さを離す」としか受け取れず、先に終わったノートが、まだ続くノートまで
///   止めてしまうため)
/// - 0 秒より前に始まるノートは、0 秒から鳴らす。0 秒より前に終わるノートは鳴らさない
fn schedule(song: &Song, notes: &[Note], sample_rate: u32) -> (Vec<Event>, Vec<Span>, u64) {
    let mut spans: Vec<Span> = Vec::with_capacity(notes.len());
    for note in notes.iter().filter(|n| n.length > 0 && n.pitch <= 127) {
        let start = song.tick_to_frame(note.start, sample_rate).max(0);
        let end = song.tick_to_frame(note.start.saturating_add(note.length), sample_rate);
        if end > start {
            spans.push(Span {
                start: start as u64,
                end: end as u64,
                pitch: note.pitch,
                velocity: note.velocity.clamp(1, 127),
            });
        }
    }
    let notes_end = spans.iter().map(|s| s.end).max().unwrap_or(0);

    // (位置, 鳴らすか, spans の番号)。同じ位置では離す方 (false) が先に来る
    let mut edges: Vec<(u64, bool, usize)> = Vec::with_capacity(spans.len() * 2);
    for (i, span) in spans.iter().enumerate() {
        edges.push((span.start, true, i));
        edges.push((span.end, false, i));
    }
    edges.sort_by_key(|&(frame, on, _)| (frame, on));

    let mut events = Vec::with_capacity(edges.len());
    // 高さごとの、いま鳴っているノートの数と、離す位置がまだ決まっていないノート
    let mut held = [0usize; 128];
    let mut open: Vec<Vec<usize>> = vec![Vec::new(); 128];
    for (frame, on, i) in edges {
        let pitch = spans[i].pitch;
        let p = pitch as usize;
        if on {
            held[p] += 1;
            open[p].push(i);
            events.push(Event {
                frame,
                pitch,
                kind: EventKind::On(spans[i].velocity),
            });
        } else {
            held[p] -= 1;
            if held[p] == 0 {
                for j in open[p].drain(..) {
                    spans[j].end = frame;
                }
                events.push(Event {
                    frame,
                    pitch,
                    kind: EventKind::Off,
                });
            }
        }
    }
    (events, spans, notes_end)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    /// 120 BPM、48kHz では 1 ティック = 25 フレーム。フレームで書いた位置をティックにする
    fn note(start_frame: u64, length_frames: u64, pitch: u8) -> Note {
        Note {
            start: start_frame / 25,
            length: length_frames / 25,
            pitch,
            velocity: 100,
        }
    }

    fn on(frame: u64, pitch: u8) -> Event {
        Event {
            frame,
            pitch,
            kind: EventKind::On(100),
        }
    }

    fn off(frame: u64, pitch: u8) -> Event {
        Event {
            frame,
            pitch,
            kind: EventKind::Off,
        }
    }

    #[test]
    fn 出来事は位置の順に並ぶ() {
        let notes = [note(5000, 1000, 64), note(1000, 2000, 60)];
        let (events, spans, end) = schedule(&Song::default(), &notes, SR);
        assert_eq!(
            events,
            vec![on(1000, 60), off(3000, 60), on(5000, 64), off(6000, 64)]
        );
        assert_eq!(spans.len(), 2);
        assert_eq!(end, 6000);
    }

    #[test]
    fn 同じ位置では離す方が先() {
        let notes = [note(1000, 1000, 60), note(2000, 1000, 60)];
        let (events, ..) = schedule(&Song::default(), &notes, SR);
        assert_eq!(
            events,
            vec![on(1000, 60), off(2000, 60), on(2000, 60), off(3000, 60)]
        );
    }

    #[test]
    fn 同じ高さが重なるあいだは離さない() {
        // 2 つめが 1 つめの中に収まっている。2 つめの終わりで離すと 1 つめまで止まる
        let notes = [note(0, 4000, 60), note(1000, 1000, 60)];
        let (events, spans, end) = schedule(&Song::default(), &notes, SR);
        assert_eq!(events, vec![on(0, 60), on(1000, 60), off(4000, 60)]);
        // どちらも、離す位置は最後の 1 つの終わり
        assert!(spans.iter().all(|s| s.end == 4000));
        assert_eq!(end, 4000);

        // 違う高さは互いに関わらない
        let notes = [note(0, 4000, 60), note(1000, 1000, 62)];
        let (events, ..) = schedule(&Song::default(), &notes, SR);
        assert_eq!(
            events,
            vec![on(0, 60), on(1000, 62), off(2000, 62), off(4000, 60)]
        );
    }

    #[test]
    fn 鳴らせないノートは除く() {
        let notes = [
            Note {
                length: 0,
                ..note(0, 1000, 60)
            },
            note(0, 1000, 200),
        ];
        let (events, spans, end) = schedule(&Song::default(), &notes, SR);
        assert!(events.is_empty() && spans.is_empty());
        assert_eq!(end, 0);
    }

    #[test]
    fn 強さは範囲に丸める() {
        let notes = [
            Note {
                velocity: 0,
                ..note(0, 1000, 60)
            },
            Note {
                velocity: 200,
                ..note(2000, 1000, 60)
            },
        ];
        let (events, ..) = schedule(&Song::default(), &notes, SR);
        assert_eq!(events[0].kind, EventKind::On(1));
        assert_eq!(events[2].kind, EventKind::On(127));
    }

    #[test]
    fn ゼロ秒より前のノートはゼロ秒から鳴らす() {
        // 1 小節目が -0.05 秒 (2400 フレーム前) に在る
        let song = Song {
            offset_sec: -0.05,
            ..Song::default()
        };
        let notes = [note(0, 1000, 60), note(1000, 2400, 62)];
        let (events, ..) = schedule(&song, &notes, SR);
        // 1 つめは 0 秒より前に終わるので鳴らさない。2 つめは 0 秒から、元の終わりまで
        assert_eq!(events, vec![on(0, 62), off(1000, 62)]);
    }

    #[test]
    fn 設定と曲の値を確かめる() {
        let config = EngineConfig::default();
        let bad_block = EngineConfig {
            max_block: 0,
            ..config
        };
        assert!(matches!(
            Engine::new(&Song::default(), &bad_block),
            Err(EngineError::InvalidConfig(_))
        ));
        let too_long = EngineConfig {
            max_block: MAX_BLOCK_LIMIT + 1,
            ..config
        };
        assert!(matches!(
            Engine::new(&Song::default(), &too_long),
            Err(EngineError::InvalidConfig(_))
        ));
        let bad_rate = EngineConfig {
            sample_rate: 0,
            ..config
        };
        assert!(matches!(
            Engine::new(&Song::default(), &bad_rate),
            Err(EngineError::InvalidConfig(_))
        ));
        for bpm in [0.0, -120.0, f64::NAN, f64::INFINITY] {
            let song = Song {
                bpm,
                ..Song::default()
            };
            assert!(
                matches!(
                    Engine::new(&song, &config),
                    Err(EngineError::InvalidSong(_))
                ),
                "bpm={bpm}"
            );
        }
    }

    #[test]
    fn 音声スレッドへ移せる() {
        fn assert_send<T: Send>() {}
        assert_send::<Engine>();
    }
}
