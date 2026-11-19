//! 取り込んだ音声 (原曲・ステム・録音) の、タイムライン上での再生。
//!
//! engine と周波数が違う音声は、曲を組み立てるときに engine の周波数へ変換しておく
//! (`AudioData::resampled`)。ブロックごとの処理では重なる部分を足すだけで、補間も
//! メモリの確保もしない。
//!
//! クリップは、音声の中の鳴らす範囲 (`audio_start_sec`・`duration_sec`) と、頭と終わりの直線のフェード
//! (`fade_in_sec`・`fade_out_sec`) を持つ。決まりは画面の `web-ui/src/lib/clip.ts` と同じ:
//!
//! - 鳴らす長さは、音声の残り (`音声の長さ - audio_start_sec`) に収める
//! - フェードインは鳴らす長さに、フェードアウトはフェードインと重ならないところまでに収める
//! - フェードの音量は、クリップの頭から数えた位置 `t` (秒) で決まる (`fade_gain`)。途中から鳴らしても、
//!   フェードの途中の音量から始まる。Web Audio の書き出し (`linearRampToValueAtTime`) と同じ直線
//!
//! 範囲の頭と長さはフレームに丸める (Web Audio はフレームの間の位置から読み始めることが在るので、
//! 1 フレームより細かい違いは出る)。フェードの音量は、丸める前の秒で計算する。

use crate::audio::{AudioData, AudioError};
use crate::song::Clip;
use std::sync::Arc;

/// フェードの音量 (0〜1。画面の `fadeGain` と同じ式)。
///
/// - `t`: クリップの頭から数えた位置 (秒)
/// - `length`: 鳴らす長さ (秒)
/// - `fade_in` / `fade_out`: フェードの長さ (秒。範囲に収めたもの)
pub(crate) fn fade_gain(t: f64, length: f64, fade_in: f64, fade_out: f64) -> f64 {
    let mut gain: f64 = 1.0;
    if fade_in > 0.0 && t < fade_in {
        gain = (t / fade_in).max(0.0);
    }
    if fade_out > 0.0 && t > length - fade_out {
        gain = gain.min(((length - t) / fade_out).max(0.0));
    }
    gain
}

/// engine の中で鳴らす形にしたクリップ。音声は engine の周波数になっている。
pub(crate) struct PlacedClip {
    audio: Arc<AudioData>,
    /// タイムライン上の開始位置 (フレーム)。負なら頭が切れる
    start: i64,
    /// 音声の中の、鳴らし始めるフレーム
    from: usize,
    /// 鳴らすフレーム数
    len: usize,
    /// 1 フレームの長さ (秒)
    frame_sec: f64,
    /// 鳴らす長さ (秒。フェードアウトの終わり)
    length_sec: f64,
    /// フェードの長さ (秒。範囲に収めたもの。0 なら掛けない)
    fade_in: f64,
    fade_out: f64,
}

impl PlacedClip {
    /// クリップの音声を engine の周波数 `sample_rate` に合わせ、範囲とフェードを決めて置く。
    ///
    /// 周波数が同じなら音声を共有する (写さない)。違えば変換した音声を新しく作る。
    pub(crate) fn new(clip: &Clip, sample_rate: u32) -> Result<Self, AudioError> {
        let audio = if clip.audio.sample_rate() == sample_rate {
            Arc::clone(&clip.audio)
        } else {
            Arc::new(clip.audio.resampled(sample_rate)?)
        };
        let sr = sample_rate as f64;
        let total = audio.frames();
        let total_sec = total as f64 / sr;
        let audio_start = clip.audio_start_sec.max(0.0);
        let from = ((audio_start * sr).round() as usize).min(total);
        // 鳴らす長さ (秒) は、音声の残りに収める (画面の `playLength`)
        let rest_sec = (total_sec - audio_start).max(0.0);
        let length_sec = clip
            .duration_sec
            .map_or(rest_sec, |d| d.max(0.0))
            .min(rest_sec);
        let len = ((length_sec * sr).round() as usize).min(total - from);
        let fade_in = clip.fade_in_sec.max(0.0).min(length_sec);
        let fade_out = clip.fade_out_sec.max(0.0).min(length_sec - fade_in);
        let start = (clip.start_sec * sr).round() as i64;
        Ok(PlacedClip {
            audio,
            start,
            from,
            len,
            frame_sec: 1.0 / sr,
            length_sec,
            fade_in,
            fade_out,
        })
    }

    /// 鳴り終わる位置 (フレーム)。
    pub(crate) fn end(&self) -> i64 {
        self.start.saturating_add(self.len as i64)
    }

    /// ステレオの音声か。
    pub(crate) fn is_stereo(&self) -> bool {
        self.audio.is_stereo()
    }

    /// タイムラインの `[pos, pos + len)` と、このクリップの重なりを求める。
    /// (出力の中の開始位置, クリップの頭から数えた開始位置, 長さ) を返す。重ならなければ `None`。
    fn overlap(&self, pos: u64, len: usize) -> Option<(usize, usize, usize)> {
        let pos = pos as i64;
        let from = pos.max(self.start);
        let to = (pos + len as i64).min(self.end());
        (from < to).then(|| {
            (
                (from - pos) as usize,
                (from - self.start) as usize,
                (to - from) as usize,
            )
        })
    }

    /// クリップの頭から数えて `into` フレームからの `out.len()` フレームに、フェードが掛かるか。
    fn faded(&self, into: usize, n: usize) -> bool {
        let from = into as f64 * self.frame_sec;
        let to = (into + n) as f64 * self.frame_sec;
        (self.fade_in > 0.0 && from < self.fade_in)
            || (self.fade_out > 0.0 && to > self.length_sec - self.fade_out)
    }

    /// `input` (クリップの頭から `into` フレームの位置から) を `out` に足す。フェードが掛かるところは音量を掛ける。
    fn add_faded(&self, out: &mut [f32], input: &[f32], into: usize) {
        if !self.faded(into, out.len()) {
            add(out, input);
            return;
        }
        for (k, (o, i)) in out.iter_mut().zip(input).enumerate() {
            let t = (into + k) as f64 * self.frame_sec;
            *o += i * fade_gain(t, self.length_sec, self.fade_in, self.fade_out) as f32;
        }
    }

    /// ステレオのクリップの、`[pos, pos + left.len())` と重なる部分を `left` / `right` に足す。
    pub(crate) fn add_stereo(&self, pos: u64, left: &mut [f32], right: &mut [f32]) {
        if let Some((dst, into, n)) = self.overlap(pos, left.len()) {
            let src = self.from + into;
            self.add_faded(
                &mut left[dst..dst + n],
                &self.audio.left()[src..src + n],
                into,
            );
            self.add_faded(
                &mut right[dst..dst + n],
                &self.audio.right()[src..src + n],
                into,
            );
        }
    }

    /// モノラルのクリップの、`[pos, pos + out.len())` と重なる部分を `out` に足す。
    pub(crate) fn add_mono(&self, pos: u64, out: &mut [f32]) {
        if let Some((dst, into, n)) = self.overlap(pos, out.len()) {
            let src = self.from + into;
            self.add_faded(
                &mut out[dst..dst + n],
                &self.audio.left()[src..src + n],
                into,
            );
        }
    }
}

fn add(out: &mut [f32], input: &[f32]) {
    for (o, i) in out.iter_mut().zip(input) {
        *o += i;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    fn audio(frames: usize) -> Arc<AudioData> {
        let samples = (1..=frames).map(|i| i as f32).collect();
        Arc::new(AudioData::new(SR, vec![samples]).unwrap())
    }

    /// 1, 2, 3, … の音声を、`start` フレームに置いたクリップ。
    fn clip(frames: usize, start: i64) -> PlacedClip {
        PlacedClip::new(&Clip::new(audio(frames), start as f64 / SR as f64), SR).unwrap()
    }

    #[test]
    fn 重なる部分だけを足す() {
        // クリップは 100〜104 フレームに 1, 2, 3, 4
        let c = clip(4, 100);
        let mut out = [10.0f32; 8];
        c.add_mono(98, &mut out);
        assert_eq!(out, [10.0, 10.0, 11.0, 12.0, 13.0, 14.0, 10.0, 10.0]);

        // ブロックがクリップの途中から始まる
        let mut out = [0.0f32; 2];
        c.add_mono(102, &mut out);
        assert_eq!(out, [3.0, 4.0]);

        // 重ならないブロックは変えない
        for pos in [0, 96, 104, 500] {
            let mut out = [0.0f32; 4];
            c.add_mono(pos, &mut out);
            assert_eq!(out, [0.0; 4], "pos={pos}");
        }
    }

    #[test]
    fn 負の位置に置いたクリップは頭が切れる() {
        let c = clip(4, -2);
        let mut out = [0.0f32; 4];
        c.add_mono(0, &mut out);
        assert_eq!(out, [3.0, 4.0, 0.0, 0.0]);
    }

    #[test]
    fn 鳴らす範囲だけを鳴らす() {
        // 音声の 3 フレーム目 (値 4) から 3 フレームぶんを、10 フレームに置く
        let c = Clip {
            audio_start_sec: 3.0 / SR as f64,
            duration_sec: Some(3.0 / SR as f64),
            ..Clip::new(audio(10), 10.0 / SR as f64)
        };
        let c = PlacedClip::new(&c, SR).unwrap();
        assert_eq!(c.end(), 13);
        let mut out = [0.0f32; 6];
        c.add_mono(9, &mut out);
        assert_eq!(out, [0.0, 4.0, 5.0, 6.0, 0.0, 0.0]);
        // 途中から鳴らすと、範囲の中のその位置から
        let mut out = [0.0f32; 2];
        c.add_mono(11, &mut out);
        assert_eq!(out, [5.0, 6.0]);
    }

    #[test]
    fn 長さは音声の残りに収める() {
        let c = Clip {
            audio_start_sec: 8.0 / SR as f64,
            duration_sec: Some(1.0),
            ..Clip::new(audio(10), 0.0)
        };
        let c = PlacedClip::new(&c, SR).unwrap();
        assert_eq!(c.end(), 2);
        // 音声より後ろから鳴らすクリップは、何も鳴らさない
        let c = Clip {
            audio_start_sec: 1.0,
            ..Clip::new(audio(10), 0.0)
        };
        let c = PlacedClip::new(&c, SR).unwrap();
        assert_eq!(c.end(), 0);
        let mut out = [0.0f32; 4];
        c.add_mono(0, &mut out);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn フェードは画面と同じ直線() {
        // 長さ 1 秒、フェードイン 0.25 秒、フェードアウト 0.5 秒
        assert_eq!(fade_gain(0.0, 1.0, 0.25, 0.5), 0.0);
        assert!((fade_gain(0.125, 1.0, 0.25, 0.5) - 0.5).abs() < 1e-12);
        assert_eq!(fade_gain(0.4, 1.0, 0.25, 0.5), 1.0);
        assert!((fade_gain(0.75, 1.0, 0.25, 0.5) - 0.5).abs() < 1e-12);
        assert_eq!(fade_gain(1.0, 1.0, 0.25, 0.5), 0.0);
        // フェードが無ければ 1
        assert_eq!(fade_gain(0.0, 1.0, 0.0, 0.0), 1.0);
        // 重なるフェードは、小さいほう
        assert!((fade_gain(0.5, 1.0, 1.0, 1.0) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn フェードはクリップの中の位置で決まる() {
        // 1 の続く音声 8 フレーム。フェードイン 4 フレーム・フェードアウト 2 フレーム
        let ones = Arc::new(AudioData::new(SR, vec![vec![1.0; 8]]).unwrap());
        let f = 1.0 / SR as f64;
        let c = Clip {
            fade_in_sec: 4.0 * f,
            fade_out_sec: 2.0 * f,
            ..Clip::new(ones, 0.0)
        };
        let c = PlacedClip::new(&c, SR).unwrap();
        let mut whole = [0.0f32; 8];
        c.add_mono(0, &mut whole);
        assert_near(&whole, &[0.0, 0.25, 0.5, 0.75, 1.0, 1.0, 1.0, 0.5]);
        // ブロックを分けても、途中から鳴らしても同じ
        let mut split = [0.0f32; 8];
        for at in (0..8).step_by(3) {
            let n = 3.min(8 - at);
            c.add_mono(at as u64, &mut split[at..at + n]);
        }
        assert_eq!(split, whole);
    }

    #[test]
    fn フェードの長さは範囲に収める() {
        let ones = Arc::new(AudioData::new(SR, vec![vec![1.0; 4]]).unwrap());
        let f = 1.0 / SR as f64;
        // フェードインが長さより長い・フェードアウトはもう残りが無い
        let c = Clip {
            fade_in_sec: 10.0 * f,
            fade_out_sec: 10.0 * f,
            ..Clip::new(ones, 0.0)
        };
        let c = PlacedClip::new(&c, SR).unwrap();
        let mut out = [0.0f32; 4];
        c.add_mono(0, &mut out);
        assert_near(&out, &[0.0, 0.25, 0.5, 0.75]);
    }

    fn assert_near(actual: &[f32], expected: &[f32]) {
        assert_eq!(actual.len(), expected.len());
        for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
            assert!((a - e).abs() < 1e-6, "{i}: {actual:?} != {expected:?}");
        }
    }
}
