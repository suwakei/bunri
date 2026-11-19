//! ドラムの音 (種類ごとの簡単な合成音)。ドラムのトラックのノートと、ドラムに向けて弾いた鍵盤の試聴を、これで鳴らす。
//!
//! 画面の `web-ui/src/lib/drum-sound.ts` (`playDrum`) を写したもの。ブラウザ (Web Audio) の再生と書き出し、
//! デスクトップ版の Rust の再生が、同じ音になるようにしてある (テスト `tests/webaudio_parity.rs` が、
//! WebKit と Chromium の書き出しと突き合わせる)。値を変えるときは、両方を一緒に変える。
//!
//! - キック: 下がるサイン波 (150Hz → 48Hz を 90ms で)
//! - タム: 下がるサイン波 (210Hz → 110Hz を 160ms で)
//! - スネア: 1200Hz より上のノイズ + 短いサイン波 (240Hz → 170Hz)
//! - ハイハット・シンバル: 7000Hz より上のノイズ
//!
//! 音量の山は、Web Audio の自動化 (AudioParam) と同じ形: 0.0001 から 2ms で山まで直線に上げ、
//! 鳴る長さの終わりまでに指数で 0.0001 へ下げる。周波数の下がり方も指数。ノイズのフィルタは、
//! Web Audio の `BiquadFilterNode` (highpass、Q = 1dB) と同じ式の 2 次の IIR。ノイズは種の決まった
//! xorshift32 の数列で、画面と 1 ビットも違わない。
//!
//! 打った瞬間の音なので、離す指示は使わない (決まった長さで鳴り終わる)。声の数は作るときに決まり、
//! あとから増えない。[`DrumSynth::new`] のあとは、どの関数もメモリの確保と解放・ロック・ファイルの
//! 読み書きをしない (音声スレッドから呼べる)。

use crate::tone::tone_level;
use std::f64::consts::PI;

/// ドラムの音の種類 (ピアノロールの 1 行に当たる。画面の `DrumVoice`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DrumVoice {
    /// キック
    Kick,
    /// スネア
    Snare,
    /// ハイハット・シンバル
    Hat,
    /// タム
    Tom,
}

impl DrumVoice {
    /// すべての種類。
    pub const ALL: [DrumVoice; 4] = [
        DrumVoice::Kick,
        DrumVoice::Snare,
        DrumVoice::Hat,
        DrumVoice::Tom,
    ];

    /// 画面での名前 (`kick` `snare` `hat` `tom`) から引く。知らない名前は `None`。
    pub fn from_name(name: &str) -> Option<DrumVoice> {
        DrumVoice::ALL.into_iter().find(|v| v.name() == name)
    }

    /// 画面での名前。
    pub fn name(self) -> &'static str {
        match self {
            DrumVoice::Kick => "kick",
            DrumVoice::Snare => "snare",
            DrumVoice::Hat => "hat",
            DrumVoice::Tom => "tom",
        }
    }

    fn index(self) -> usize {
        self as usize
    }

    /// 音の作り (画面の `VOICES` と `playDrum`)。
    fn spec(self) -> VoiceSpec {
        match self {
            DrumVoice::Kick => VoiceSpec {
                gain: 2.4,
                sweep: Some(SweepSpec {
                    from: 150.0,
                    to: 48.0,
                    fall: 0.09,
                    peak: 1.0,
                    duration: 0.28,
                }),
                noise: None,
            },
            DrumVoice::Tom => VoiceSpec {
                gain: 2.0,
                sweep: Some(SweepSpec {
                    from: 210.0,
                    to: 110.0,
                    fall: 0.16,
                    peak: 1.0,
                    duration: 0.32,
                }),
                noise: None,
            },
            DrumVoice::Snare => VoiceSpec {
                gain: 1.6,
                sweep: Some(SweepSpec {
                    from: 240.0,
                    to: 170.0,
                    fall: 0.05,
                    peak: 0.6,
                    duration: 0.09,
                }),
                noise: Some(NoiseSpec {
                    cutoff: 1200.0,
                    duration: 0.18,
                }),
            },
            DrumVoice::Hat => VoiceSpec {
                gain: 0.9,
                sweep: None,
                noise: Some(NoiseSpec {
                    cutoff: 7000.0,
                    duration: 0.06,
                }),
            },
        }
    }
}

/// 下がるサイン波 (画面の `sweep`)。
#[derive(Debug, Clone, Copy)]
struct SweepSpec {
    /// 始まりと行き先の周波数 (Hz)
    from: f64,
    to: f64,
    /// 行き先まで下がる長さ (秒)
    fall: f64,
    /// 山の高さの倍率 (種類の山に対して)
    peak: f64,
    /// 鳴る長さ (秒)
    duration: f64,
}

/// フィルタを通したノイズ (画面の `noise`。フィルタはどれも highpass)。
#[derive(Debug, Clone, Copy)]
struct NoiseSpec {
    /// フィルタの周波数 (Hz)
    cutoff: f64,
    /// 鳴る長さ (秒)
    duration: f64,
}

#[derive(Debug, Clone, Copy)]
struct VoiceSpec {
    /// 種類ごとの音量 (三角波のノートの山の高さに対する倍率)
    gain: f64,
    sweep: Option<SweepSpec>,
    noise: Option<NoiseSpec>,
}

/// 減衰の行き先 (指数で下げるので、0 にはできない。画面の `SILENT`)。
const SILENT: f64 = 0.0001;
/// 山まで上げる長さ (秒)。
const RISE_SEC: f64 = 0.002;
/// 鳴る長さのあとも、音源を止めずに続ける長さ (秒。画面の `duration + 0.01`)。
const STOP_PAD_SEC: f64 = 0.01;
/// ノイズの数列の長さ (秒。画面の `noiseBuffer` と同じ 0.25 秒)。
const NOISE_SEC: f64 = 0.25;
/// ノイズの数列の種 (画面と同じ)。
const NOISE_SEED: u32 = 0x2f6e2b1;
/// Web Audio の `BiquadFilterNode` の Q の既定値 (dB)。
const FILTER_Q_DB: f64 = 1.0;

/// 音量の山 (画面の `envelope`)。`t` は鳴らし始めからの秒。
fn envelope(t: f64, peak: f64, duration: f64) -> f64 {
    let top = peak.max(SILENT);
    if t < RISE_SEC {
        SILENT + (top - SILENT) * (t / RISE_SEC)
    } else if t < duration {
        top * (SILENT / top).powf((t - RISE_SEC) / (duration - RISE_SEC))
    } else {
        SILENT
    }
}

/// 2 次の IIR の係数 (a0 で割ったもの)。
#[derive(Debug, Clone, Copy, PartialEq)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    /// Web Audio の highpass (Audio EQ Cookbook。Q は dB で受け取る) と同じ係数。
    fn highpass(cutoff: f64, q_db: f64, sample_rate: f64) -> Biquad {
        let nyquist = sample_rate / 2.0;
        let normalized = (cutoff / nyquist).clamp(0.0, 1.0);
        if normalized >= 1.0 {
            // ナイキストより上は、すべて止める
            return Biquad {
                b0: 0.0,
                b1: 0.0,
                b2: 0.0,
                a1: 0.0,
                a2: 0.0,
            };
        }
        let theta = PI * normalized;
        let resonance = 10f64.powf(q_db / 20.0);
        let alpha = theta.sin() / (2.0 * resonance);
        let cos = theta.cos();
        let beta = (1.0 + cos) / 2.0;
        let a0 = 1.0 + alpha;
        Biquad {
            b0: beta / a0,
            b1: -2.0 * beta / a0,
            b2: beta / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
        }
    }
}

/// 種の決まったノイズの数列 (画面の `noiseBuffer` と同じ: xorshift32 を -1〜1 にしたもの)。
fn noise_table(sample_rate: u32) -> Vec<f32> {
    let len = ((sample_rate as f64 * NOISE_SEC).round() as usize).max(1);
    let mut seed = NOISE_SEED;
    (0..len)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            ((seed as f64 / u32::MAX as f64) * 2.0 - 1.0) as f32
        })
        .collect()
}

/// 種類ごとの、サンプリング周波数で決まる値。
#[derive(Debug, Clone, Copy)]
struct Prepared {
    spec: VoiceSpec,
    filter: Option<Biquad>,
    /// サイン波とノイズの、鳴らすフレーム数 (鳴る長さ + 止めるまでの 10ms)
    sweep_frames: u32,
    noise_frames: u32,
}

/// 声 1 つ。
#[derive(Debug, Clone, Copy)]
struct Voice {
    active: bool,
    voice: DrumVoice,
    /// 種類の山の高さ (強さで決まる)
    peak: f64,
    /// 次のブロックの頭から数えて、鳴り始めるまでのフレーム数
    start_in: u32,
    /// 鳴らし始めてから進んだフレーム数
    done: u32,
    /// サイン波の位置 (周期を 1 とする)
    phase: f64,
    /// フィルタの状態 (入力と出力の 1 つ前・2 つ前)
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
    /// 鳴らした順番 (声が足りないとき、古い声から使う)
    order: u64,
}

impl Voice {
    const IDLE: Voice = Voice {
        active: false,
        voice: DrumVoice::Kick,
        peak: 0.0,
        start_in: 0,
        done: 0,
        phase: 0.0,
        x1: 0.0,
        x2: 0.0,
        y1: 0.0,
        y2: 0.0,
        order: 0,
    };
}

/// ドラムの合成音のシンセ。
pub struct DrumSynth {
    sample_rate: f64,
    prepared: [Prepared; 4],
    noise: Vec<f32>,
    voices: Vec<Voice>,
    next_order: u64,
}

impl DrumSynth {
    /// 同時に鳴らせる声の既定の数。
    pub const DEFAULT_VOICES: usize = 32;

    /// シンセを作る。ノイズの数列と声のぶんのメモリは、ここで確保する。
    pub fn new(sample_rate: u32, voices: usize) -> Self {
        assert!(sample_rate > 0, "サンプリング周波数は 1 以上");
        assert!(voices > 0, "声の数は 1 以上");
        let sr = sample_rate as f64;
        let frames = |duration: f64| ((duration + STOP_PAD_SEC) * sr).ceil() as u32;
        let prepared = DrumVoice::ALL.map(|voice| {
            let spec = voice.spec();
            Prepared {
                spec,
                filter: spec
                    .noise
                    .map(|n| Biquad::highpass(n.cutoff, FILTER_Q_DB, sr)),
                sweep_frames: spec.sweep.map_or(0, |s| frames(s.duration)),
                noise_frames: spec.noise.map_or(0, |n| frames(n.duration)),
            }
        });
        DrumSynth {
            sample_rate: sr,
            prepared,
            noise: noise_table(sample_rate),
            voices: vec![Voice::IDLE; voices],
            next_order: 0,
        }
    }

    /// 1 回鳴らす。`delay` は次の [`DrumSynth::render_add`] のブロックの頭からのフレーム数。
    /// 強さ (1〜127) から山の高さを決める (三角波のノートと同じ `tone_level` × 種類ごとの倍率)。
    ///
    /// 同じ種類が鳴っていても止めない (重ねて鳴る。画面と同じ)。声が空いていなければ、いちばん古い声を止めて使う。
    pub fn trigger(&mut self, delay: usize, voice: DrumVoice, velocity: u8) {
        let index = self
            .voices
            .iter()
            .position(|v| !v.active)
            .unwrap_or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| v.order)
                    .map_or(0, |(i, _)| i)
            });
        let order = self.next_order;
        self.next_order += 1;
        self.voices[index] = Voice {
            active: true,
            voice,
            peak: tone_level(velocity) as f64 * self.prepared[voice.index()].spec.gain,
            start_in: delay.min(u32::MAX as usize - 1) as u32,
            order,
            ..Voice::IDLE
        };
    }

    /// 鳴っている音を、すべてすぐ止める。
    pub fn all_sound_off(&mut self) {
        for voice in &mut self.voices {
            voice.active = false;
        }
    }

    /// いま鳴っている声の数。
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    /// 次のブロックの音を `out` に **足す** (モノラル)。長さに上限は無い。
    pub fn render_add(&mut self, out: &mut [f32]) {
        let len = out.len();
        let sr = self.sample_rate;
        for voice in self.voices.iter_mut().filter(|v| v.active) {
            let prepared = &self.prepared[voice.voice.index()];
            let end = prepared.sweep_frames.max(prepared.noise_frames);
            let start = voice.start_in as usize;
            for sample in out.iter_mut().skip(start) {
                if voice.done >= end {
                    voice.active = false;
                    break;
                }
                let k = voice.done;
                let t = k as f64 / sr;
                let mut value = 0.0;
                if let Some(sweep) = prepared.spec.sweep.filter(|_| k < prepared.sweep_frames) {
                    let level = envelope(t, voice.peak * sweep.peak, sweep.duration);
                    value += (2.0 * PI * voice.phase).sin() * level;
                    let hz = if t < sweep.fall {
                        sweep.from * (sweep.to / sweep.from).powf(t / sweep.fall)
                    } else {
                        sweep.to
                    };
                    voice.phase += hz / sr;
                    if voice.phase >= 1.0 {
                        voice.phase -= 1.0;
                    }
                }
                if let (Some(noise), Some(f)) = (prepared.spec.noise, prepared.filter) {
                    if k < prepared.noise_frames {
                        let x = self.noise.get(k as usize).copied().unwrap_or(0.0) as f64;
                        let y = f.b0 * x + f.b1 * voice.x1 + f.b2 * voice.x2
                            - f.a1 * voice.y1
                            - f.a2 * voice.y2;
                        voice.x2 = voice.x1;
                        voice.x1 = x;
                        voice.y2 = voice.y1;
                        voice.y1 = y;
                        value += y * envelope(t, voice.peak, noise.duration);
                    }
                }
                *sample += value as f32;
                voice.done += 1;
            }
            if voice.active && voice.done >= end {
                voice.active = false;
            }
            voice.start_in = voice
                .start_in
                .saturating_sub(len.min(u32::MAX as usize) as u32);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    fn render(synth: &mut DrumSynth, frames: usize) -> Vec<f32> {
        let mut out = vec![0f32; frames];
        synth.render_add(&mut out);
        out
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0, |m, v| m.max(v.abs()))
    }

    #[test]
    fn 名前で引ける() {
        for voice in DrumVoice::ALL {
            assert_eq!(DrumVoice::from_name(voice.name()), Some(voice));
        }
        assert_eq!(DrumVoice::from_name("cowbell"), None);
    }

    #[test]
    fn ノイズの数列は画面と同じ() {
        // 画面 (drum-sound.ts の noiseBuffer) で 48kHz の頭の 4 つを出した値
        let table = noise_table(SR);
        assert_eq!(table.len(), 12_000);
        let mut seed: u32 = NOISE_SEED;
        for (i, v) in table.iter().take(4).enumerate() {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            assert_eq!(
                *v,
                ((seed as f64 / 4_294_967_295.0) * 2.0 - 1.0) as f32,
                "i={i}"
            );
        }
        assert!(table.iter().all(|v| (-1.0..=1.0).contains(v)));
    }

    #[test]
    fn 音量の山は直線で上がり指数で下がる() {
        assert!((envelope(0.0, 1.0, 0.1) - SILENT).abs() < 1e-12);
        assert!(
            (envelope(RISE_SEC / 2.0, 1.0, 0.1) - (SILENT + (1.0 - SILENT) / 2.0)).abs() < 1e-12
        );
        assert!((envelope(RISE_SEC, 1.0, 0.1) - 1.0).abs() < 1e-12);
        // 指数の真ん中は、山と行き先の相乗平均
        let mid = RISE_SEC + (0.1 - RISE_SEC) / 2.0;
        assert!((envelope(mid, 1.0, 0.1) - (SILENT).sqrt()).abs() < 1e-9);
        assert_eq!(envelope(0.2, 1.0, 0.1), SILENT);
    }

    #[test]
    fn 種類ごとに決まった長さで鳴り終わる() {
        for voice in DrumVoice::ALL {
            let mut s = DrumSynth::new(SR, 4);
            s.trigger(0, voice, 96);
            let out = render(&mut s, SR as usize);
            let spec = voice.spec();
            let longest = spec
                .sweep
                .map_or(0.0, |s| s.duration)
                .max(spec.noise.map_or(0.0, |n| n.duration));
            let end = ((longest + STOP_PAD_SEC) * SR as f64).ceil() as usize;
            assert!(peak(&out[..end]) > 0.05, "{voice:?}");
            assert!(out[end..].iter().all(|v| *v == 0.0), "{voice:?}");
            assert_eq!(s.active_voices(), 0, "{voice:?}");
        }
    }

    #[test]
    fn キックは強さで山の高さが決まる() {
        let level = |velocity| {
            let mut s = DrumSynth::new(SR, 4);
            s.trigger(0, DrumVoice::Kick, velocity);
            peak(&render(&mut s, 4800))
        };
        let (soft, normal) = (level(48), level(96));
        // 山の高さは tone_level × 2.4 (= 0.6) を超えない
        assert!(normal <= 0.6 + 1e-6 && normal > 0.55, "normal={normal}");
        assert!((soft / normal - 0.5).abs() < 0.01, "soft={soft}");
    }

    #[test]
    fn ブロックの区切り方を変えても同じ音になる() {
        let events = [
            (10usize, DrumVoice::Kick),
            (333, DrumVoice::Snare),
            (1000, DrumVoice::Hat),
            (5000, DrumVoice::Tom),
        ];
        let play = |blocks: &[usize]| {
            let mut s = DrumSynth::new(SR, 8);
            let mut out = Vec::new();
            let (mut pos, mut next) = (0, 0);
            for &len in blocks.iter().cycle() {
                if pos >= 24_000 {
                    break;
                }
                while next < events.len() && events[next].0 < pos + len {
                    s.trigger(events[next].0 - pos, events[next].1, 100);
                    next += 1;
                }
                out.extend(render(&mut s, len));
                pos += len;
            }
            out.truncate(24_000);
            out
        };
        let whole = play(&[24_000]);
        for blocks in [&[64][..], &[256], &[1, 7, 77, 500]] {
            assert_eq!(play(blocks), whole, "blocks={blocks:?}");
        }
    }

    #[test]
    fn 声が足りなければ古い声から使う() {
        let mut s = DrumSynth::new(SR, 2);
        s.trigger(0, DrumVoice::Kick, 96);
        s.trigger(0, DrumVoice::Tom, 96);
        s.trigger(0, DrumVoice::Hat, 96);
        assert_eq!(s.active_voices(), 2);
        // ハイハットは 70ms で終わり、タムが残る (キックは止められた)
        render(&mut s, 4800);
        assert_eq!(s.active_voices(), 1);
        s.all_sound_off();
        assert_eq!(s.active_voices(), 0);
        assert!(render(&mut s, 100).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn ハイパスは低い音を通さない() {
        let f = Biquad::highpass(7000.0, FILTER_Q_DB, SR as f64);
        // 直流の利得は 0、ナイキストの利得は 1
        assert!((f.b0 + f.b1 + f.b2).abs() < 1e-12);
        let nyquist = (f.b0 - f.b1 + f.b2) / (1.0 - f.a1 + f.a2);
        assert!((nyquist - 1.0).abs() < 1e-9, "{nyquist}");
    }
}
