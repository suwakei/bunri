//! 仮の音 (三角波)。楽器の素材が入るまで、ノートと鍵盤の試聴をこれで鳴らす。
//!
//! いまの画面 (Web Audio の三角波) と同じ決まりにしてある:
//!
//! - 三角波。山の高さは `0.25 × max(0.2, 強さ / 96)`
//! - 鳴らすと、決まった長さで直線に立ち上がる。離すと、そのときの大きさから決まった長さで
//!   直線に消える (ノートは 10ms / 60ms、鍵盤の試聴は 5ms / 50ms。[`ToneConfig`])
//! - 出力はモノラル。左右への振り分けは使う側が行う
//!
//! 声の数は作るときに決まり、あとから増えない。[`ToneSynth::new`] のあとは、どの関数も
//! メモリの確保と解放・ロック・ファイルの読み書きをしない (音声スレッドから呼べる)。
//!
//! 鳴らす・離すは、次の [`ToneSynth::render`] のブロックの中の位置 (`delay`。フレーム) を
//! 付けて渡す。声は 1 フレームずつ計算するので、ブロックの区切り方を変えても、同じ位置に
//! 同じ指示を渡せば同じ音になる (声 1 つの波形は 1 ビットも変わらない。ブロックの区切りで
//! 空いた声を使い回す順番が変わると、声を足し合わせる順番の違いで最後の桁だけ変わりうる)。

/// 仮の音の設定。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ToneConfig {
    /// 立ち上がりの長さ (秒)
    pub attack_sec: f64,
    /// 離してから消えるまでの長さ (秒)
    pub release_sec: f64,
    /// 同時に鳴らせる声の数。足りなくなったら、いちばん古い声を止めて使う
    pub voices: usize,
}

impl ToneConfig {
    /// トラックのノート用 (立ち上がり 10ms、離してから 60ms)。
    pub const NOTE: ToneConfig = ToneConfig {
        attack_sec: 0.010,
        release_sec: 0.060,
        voices: 64,
    };

    /// 鍵盤の試聴用 (立ち上がり 5ms、離してから 50ms)。
    pub const LIVE: ToneConfig = ToneConfig {
        attack_sec: 0.005,
        release_sec: 0.050,
        voices: 32,
    };
}

/// 強さ (1〜127) から、山の高さを求める (画面側の `noteLevel` と同じ)。
pub fn tone_level(velocity: u8) -> f32 {
    0.25 * (velocity.clamp(1, 127) as f32 / 96.0).max(0.2)
}

/// MIDI ノート番号の周波数 (Hz)。69 (A4) が 440Hz の 12 平均律。
pub fn note_hz(pitch: u8) -> f64 {
    440.0 * 2f64.powf((pitch as f64 - 69.0) / 12.0)
}

/// 「離す指示は無い」の印 (`Voice::release_in`)。
const NO_RELEASE: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// 鳴っていない (空いている声)
    Idle,
    /// 立ち上がりの途中 (何フレーム進んだか)
    Attack(u32),
    /// 立ち上がりきって、押されているあいだ
    Sustain,
    /// 離したあと (何フレーム進んだか)
    Release(u32),
}

/// 声 1 つ。
#[derive(Debug, Clone, Copy)]
struct Voice {
    stage: Stage,
    pitch: u8,
    /// 波の中の位置 (0.0〜1.0)
    phase: f64,
    /// 1 フレームで進む位置
    step: f64,
    /// 山の高さ
    level: f32,
    /// 離した時点の大きさ (0.0〜1.0)。ここから 0 へ下がる
    release_from: f32,
    /// 次のブロックの頭から数えて、鳴り始めるまでのフレーム数
    start_in: u32,
    /// 次のブロックの頭から数えて、離すまでのフレーム数。[`NO_RELEASE`] なら離す指示は無い
    release_in: u32,
    /// 鳴らした順番 (声が足りないとき、古い声から使う)
    order: u64,
}

impl Voice {
    const IDLE: Voice = Voice {
        stage: Stage::Idle,
        pitch: 0,
        phase: 0.0,
        step: 0.0,
        level: 0.0,
        release_from: 0.0,
        start_in: 0,
        release_in: NO_RELEASE,
        order: 0,
    };

    /// 押されている (離す指示がまだ無い) 声か。
    fn is_held(&self) -> bool {
        matches!(self.stage, Stage::Attack(_) | Stage::Sustain) && self.release_in == NO_RELEASE
    }
}

/// 三角波 (-1.0〜1.0)。位置 0 で 0 から上がり始める (鳴り始めに段差ができない)。
fn triangle(phase: f64) -> f32 {
    let v = if phase < 0.25 {
        4.0 * phase
    } else if phase < 0.75 {
        2.0 - 4.0 * phase
    } else {
        4.0 * phase - 4.0
    };
    v as f32
}

/// 三角波の簡単なシンセ。
pub struct ToneSynth {
    sample_rate: f64,
    voices: Vec<Voice>,
    attack_frames: u32,
    release_frames: u32,
    /// 次に鳴らす声に付ける順番
    next_order: u64,
}

impl ToneSynth {
    /// シンセを作る。声のぶんのメモリは、ここで確保する。
    pub fn new(sample_rate: u32, config: &ToneConfig) -> Self {
        assert!(sample_rate > 0, "サンプリング周波数は 1 以上");
        assert!(config.voices > 0, "声の数は 1 以上");
        let frames = |sec: f64| ((sec.max(0.0) * sample_rate as f64).round() as u32).max(1);
        ToneSynth {
            sample_rate: sample_rate as f64,
            voices: vec![Voice::IDLE; config.voices],
            attack_frames: frames(config.attack_sec),
            release_frames: frames(config.release_sec),
            next_order: 0,
        }
    }

    /// ノートを鳴らす。`delay` は次の `render` のブロックの頭からのフレーム数。
    ///
    /// 同じ高さがすでに鳴っていても止めない (重ねて鳴る)。声が空いていなければ、離したあとの
    /// 声のうちいちばん古いもの、それも無ければいちばん古い声を止めて使う。
    pub fn note_on(&mut self, delay: usize, pitch: u8, velocity: u8) {
        if pitch > 127 {
            return;
        }
        let index = self.free_voice();
        let order = self.next_order;
        self.next_order += 1;
        self.voices[index] = Voice {
            stage: Stage::Attack(0),
            pitch,
            phase: 0.0,
            step: note_hz(pitch) / self.sample_rate,
            level: tone_level(velocity),
            release_from: 0.0,
            start_in: delay.min(u32::MAX as usize - 1) as u32,
            release_in: NO_RELEASE,
            order,
        };
    }

    /// その高さで押されている声を、すべて離す。`delay` は `note_on` と同じ。
    pub fn note_off(&mut self, delay: usize, pitch: u8) {
        let delay = delay.min(u32::MAX as usize - 1) as u32;
        for voice in self
            .voices
            .iter_mut()
            .filter(|v| v.pitch == pitch && v.is_held())
        {
            voice.release_in = delay;
        }
    }

    /// 押されている声を、すべて離す (それぞれ、決まった長さで消える)。
    pub fn all_notes_off(&mut self, delay: usize) {
        let delay = delay.min(u32::MAX as usize - 1) as u32;
        for voice in self.voices.iter_mut().filter(|v| v.is_held()) {
            voice.release_in = delay;
        }
    }

    /// 鳴っている音を、消えるのを待たずにすべて止める。
    pub fn all_sound_off(&mut self) {
        for voice in &mut self.voices {
            voice.stage = Stage::Idle;
        }
    }

    /// いま鳴っている声の数 (離したあと、消えるまでのあいだも数える)。
    pub fn active_voices(&self) -> usize {
        self.voices
            .iter()
            .filter(|v| v.stage != Stage::Idle)
            .count()
    }

    /// 次のブロックの音を `out` に **足す** (モノラル)。長さに上限は無い。
    pub fn render_add(&mut self, out: &mut [f32]) {
        let len = out.len();
        let (attack, release) = (self.attack_frames, self.release_frames);
        for voice in self.voices.iter_mut().filter(|v| v.stage != Stage::Idle) {
            let start = voice.start_in as usize;
            let release_at = voice.release_in as usize;
            for sample in out.iter_mut().enumerate().skip(start) {
                let (i, sample) = sample;
                if voice.release_in != NO_RELEASE && i >= release_at {
                    // 離す: そのときの大きさから下がり始める
                    voice.release_from = match voice.stage {
                        Stage::Attack(done) => done as f32 / attack as f32,
                        _ => 1.0,
                    };
                    voice.stage = Stage::Release(0);
                    voice.release_in = NO_RELEASE;
                }
                let envelope = match voice.stage {
                    Stage::Attack(done) => {
                        voice.stage = if done + 1 >= attack {
                            Stage::Sustain
                        } else {
                            Stage::Attack(done + 1)
                        };
                        done as f32 / attack as f32
                    }
                    Stage::Sustain => 1.0,
                    Stage::Release(done) => {
                        if done >= release {
                            voice.stage = Stage::Idle;
                            break;
                        }
                        voice.stage = Stage::Release(done + 1);
                        voice.release_from * (1.0 - done as f32 / release as f32)
                    }
                    Stage::Idle => break,
                };
                *sample += triangle(voice.phase) * voice.level * envelope;
                voice.phase += voice.step;
                if voice.phase >= 1.0 {
                    voice.phase -= 1.0;
                }
            }
            // 次のブロックの頭から数え直す
            voice.start_in = voice
                .start_in
                .saturating_sub(len.min(u32::MAX as usize) as u32);
            if voice.release_in != NO_RELEASE {
                voice.release_in = voice
                    .release_in
                    .saturating_sub(len.min(u32::MAX as usize) as u32);
            }
        }
    }

    /// 次のブロックの音を作る (モノラル)。`out` の中身は上書きする。
    pub fn render(&mut self, out: &mut [f32]) {
        out.fill(0.0);
        self.render_add(out);
    }

    /// 次に使う声の番号。空いている声 → 離したあとのいちばん古い声 → いちばん古い声。
    fn free_voice(&self) -> usize {
        let oldest = |releasing_only: bool| {
            self.voices
                .iter()
                .enumerate()
                .filter(|(_, v)| !releasing_only || matches!(v.stage, Stage::Release(_)))
                .min_by_key(|(_, v)| v.order)
                .map(|(i, _)| i)
        };
        self.voices
            .iter()
            .position(|v| v.stage == Stage::Idle)
            .or_else(|| oldest(true))
            .or_else(|| oldest(false))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    fn synth() -> ToneSynth {
        ToneSynth::new(SR, &ToneConfig::NOTE)
    }

    fn render(synth: &mut ToneSynth, frames: usize) -> Vec<f32> {
        let mut out = vec![0f32; frames];
        synth.render(&mut out);
        out
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0, |m, v| m.max(v.abs()))
    }

    #[test]
    fn 山の高さは強さで決まる() {
        assert!((tone_level(96) - 0.25).abs() < 1e-7);
        assert!((tone_level(127) - 0.25 * 127.0 / 96.0).abs() < 1e-7);
        // 弱すぎる音も、下限 (0.2) より小さくしない
        assert!((tone_level(1) - 0.05).abs() < 1e-7);
        assert!((tone_level(19) - 0.05).abs() < 1e-7);
        // 範囲の外は丸める
        assert_eq!(tone_level(0), tone_level(1));
        assert_eq!(tone_level(200), tone_level(127));
    }

    #[test]
    fn 周波数は十二平均律() {
        assert!((note_hz(69) - 440.0).abs() < 1e-9);
        assert!((note_hz(81) - 880.0).abs() < 1e-9);
        assert!((note_hz(60) - 261.625_565).abs() < 1e-5);
    }

    #[test]
    fn 三角波は山が一で零から上がり始める() {
        assert_eq!(triangle(0.0), 0.0);
        assert_eq!(triangle(0.25), 1.0);
        assert_eq!(triangle(0.5), 0.0);
        assert_eq!(triangle(0.75), -1.0);
        assert!((triangle(0.125) - 0.5).abs() < 1e-7);
        assert!((triangle(0.875) + 0.5).abs() < 1e-7);
    }

    #[test]
    fn 立ち上がりは決まった長さで山の高さに届く() {
        let mut s = synth();
        s.note_on(0, 69, 96);
        let out = render(&mut s, 4800);
        // 鳴り始めは 0。立ち上がり (10ms = 480 フレーム) の半分では、山が半分ほど
        assert_eq!(out[0], 0.0);
        let half = peak(&out[190..290]);
        assert!((half - 0.125).abs() < 0.03, "半分の位置の山: {half}");
        // 立ち上がったあとは、山の高さ 0.25
        let full = peak(&out[480..4800]);
        assert!((full - 0.25).abs() < 0.002, "山の高さ: {full}");
        // 立ち上がりの途中は、まだ届いていない
        assert!(peak(&out[..240]) < 0.14);
    }

    #[test]
    fn 離すと決まった長さで消える() {
        let mut s = synth();
        s.note_on(0, 69, 96);
        s.note_off(2400, 69);
        let out = render(&mut s, 9600);
        // 離す直前までは山の高さのまま
        assert!((peak(&out[1900..2400]) - 0.25).abs() < 0.002);
        // 離してから 60ms (2880 フレーム) の半分では、半分ほど
        let half = peak(&out[2400 + 1390..2400 + 1490]);
        assert!((half - 0.125).abs() < 0.02, "半分の位置の山: {half}");
        // 60ms を過ぎたら、完全に無音で、声も空く
        assert!(out[2400 + 2880..].iter().all(|v| *v == 0.0));
        assert!(peak(&out[2400 + 2700..2400 + 2880]) > 0.0);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn 立ち上がりの途中で離すとそのときの大きさから消える() {
        let mut s = synth();
        s.note_on(0, 69, 96);
        s.note_off(240, 69);
        let out = render(&mut s, 4800);
        // 立ち上がりの半分 (0.125) を超えない
        assert!(peak(&out) < 0.14);
        assert!(peak(&out[240..400]) > 0.08);
        assert!(out[240 + 2880..].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn 鳴り始めと離す位置はブロックの中の位置に従う() {
        let mut s = synth();
        s.note_on(100, 69, 96);
        s.note_off(700, 69);
        let out = render(&mut s, 4800);
        assert!(out[..=100].iter().all(|v| *v == 0.0));
        assert!(out[101] != 0.0);
        // 700 から 60ms で消える
        assert!(out[700 + 2880..].iter().all(|v| *v == 0.0));
        assert!(peak(&out[700 + 2600..700 + 2880]) > 0.0);
    }

    #[test]
    fn ブロックの区切り方を変えても同じ音になる() {
        // 和音と、同じ高さの連打。位置はブロックの境目に乗らない
        let events: [(usize, u8, Option<u8>); 6] = [
            (10, 60, Some(100)),
            (333, 64, Some(40)),
            (1000, 60, None),
            (1000, 60, Some(127)),
            (2500, 64, None),
            (3001, 60, None),
        ];
        let play = |blocks: &[usize]| {
            let mut s = synth();
            let mut out = Vec::new();
            let mut pos = 0;
            let mut next = 0;
            for &len in blocks.iter().cycle() {
                if pos >= 8000 {
                    break;
                }
                while next < events.len() && events[next].0 < pos + len {
                    let (at, pitch, velocity) = events[next];
                    match velocity {
                        Some(v) => s.note_on(at - pos, pitch, v),
                        None => s.note_off(at - pos, pitch),
                    }
                    next += 1;
                }
                out.extend(render(&mut s, len));
                pos += len;
            }
            out.truncate(8000);
            out
        };
        let whole = play(&[8000]);
        assert!(peak(&whole) > 0.2);
        for blocks in [&[64][..], &[256], &[1, 7, 77, 500], &[1024, 3]] {
            assert_eq!(play(blocks), whole, "blocks={blocks:?}");
        }
    }

    #[test]
    fn 音の高さはノート番号に従う() {
        for (pitch, hz) in [(69u8, 440.0), (57, 220.0), (81, 880.0)] {
            let mut s = synth();
            s.note_on(0, pitch, 96);
            let out = render(&mut s, SR as usize);
            let crossings = out.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
            assert!(
                (crossings as f64 - hz).abs() <= 1.0,
                "pitch={pitch}: {crossings}Hz"
            );
        }
    }

    #[test]
    fn 同じ高さを離すと重なっている声がすべて離れる() {
        let mut s = synth();
        s.note_on(0, 60, 96);
        s.note_on(100, 60, 96);
        s.note_on(100, 64, 96);
        render(&mut s, 1000);
        assert_eq!(s.active_voices(), 3);
        s.note_off(0, 60);
        render(&mut s, 4800);
        // 別の高さは鳴り続ける
        assert_eq!(s.active_voices(), 1);
        s.all_notes_off(0);
        render(&mut s, 4800);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn すべて止めるとすぐ無音になる() {
        let mut s = synth();
        s.note_on(0, 60, 96);
        render(&mut s, 1000);
        s.all_sound_off();
        assert_eq!(s.active_voices(), 0);
        assert!(render(&mut s, 1000).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn 声が足りなければ古い声から使う() {
        let config = ToneConfig {
            voices: 2,
            ..ToneConfig::NOTE
        };
        let mut s = ToneSynth::new(SR, &config);
        s.note_on(0, 60, 96);
        s.note_on(0, 64, 96);
        render(&mut s, 1000);
        // 3 つめは、いちばん古い 60 を止めて鳴る
        s.note_on(0, 67, 96);
        assert_eq!(s.active_voices(), 2);
        s.note_off(0, 60);
        render(&mut s, 4800);
        assert_eq!(s.active_voices(), 2, "60 はもう鳴っていないはず");

        // 離したあとの声が在れば、押されている声より先に使う
        s.note_off(0, 67);
        render(&mut s, 10);
        s.note_on(0, 72, 96);
        s.note_off(0, 64);
        render(&mut s, 4800);
        assert_eq!(s.active_voices(), 1, "64 は鳴り続けて離れ、72 が残る");
    }

    #[test]
    fn ブロックより先の位置を指定した音はあとのブロックで鳴る() {
        let mut s = synth();
        s.note_on(300, 69, 96);
        s.note_off(900, 69);
        let mut out = render(&mut s, 256);
        assert!(out.iter().all(|v| *v == 0.0));
        out.extend(render(&mut s, 256));
        out.extend(render(&mut s, 4096));
        assert!(out[..=300].iter().all(|v| *v == 0.0));
        assert!(out[301] != 0.0);
        assert!(out[900 + 2880..].iter().all(|v| *v == 0.0));
    }
}
