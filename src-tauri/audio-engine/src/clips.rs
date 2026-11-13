//! 取り込んだ音声 (原曲・ステム・録音) の、タイムライン上での再生。
//!
//! engine と周波数が違う音声は、曲を組み立てるときに engine の周波数へ変換しておく
//! (`AudioData::resampled`)。ブロックごとの処理では重なる部分を足すだけで、補間も
//! メモリの確保もしない。

use crate::audio::{AudioData, AudioError};
use std::sync::Arc;

/// engine の中で鳴らす形にしたクリップ。音声は engine の周波数になっている。
pub(crate) struct PlacedClip {
    audio: Arc<AudioData>,
    /// タイムライン上の開始位置 (フレーム)。負なら頭が切れる
    start: i64,
}

impl PlacedClip {
    /// `audio` を engine の周波数 `sample_rate` に合わせ、`start_sec` に置く。
    ///
    /// 周波数が同じなら音声を共有する (写さない)。違えば変換した音声を新しく作る。
    pub(crate) fn new(
        audio: &Arc<AudioData>,
        start_sec: f64,
        sample_rate: u32,
    ) -> Result<Self, AudioError> {
        let audio = if audio.sample_rate() == sample_rate {
            Arc::clone(audio)
        } else {
            Arc::new(audio.resampled(sample_rate)?)
        };
        let start = (start_sec * sample_rate as f64).round() as i64;
        Ok(PlacedClip { audio, start })
    }

    /// 鳴り終わる位置 (フレーム)。
    pub(crate) fn end(&self) -> i64 {
        self.start.saturating_add(self.audio.frames() as i64)
    }

    /// ステレオの音声か。
    pub(crate) fn is_stereo(&self) -> bool {
        self.audio.is_stereo()
    }

    /// タイムラインの `[pos, pos + len)` と、このクリップの重なりを求める。
    /// (出力の中の開始位置, 音声の中の開始位置, 長さ) を返す。重ならなければ `None`。
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

    /// ステレオのクリップの、`[pos, pos + left.len())` と重なる部分を `left` / `right` に足す。
    pub(crate) fn add_stereo(&self, pos: u64, left: &mut [f32], right: &mut [f32]) {
        if let Some((dst, src, n)) = self.overlap(pos, left.len()) {
            add(&mut left[dst..dst + n], &self.audio.left()[src..src + n]);
            add(&mut right[dst..dst + n], &self.audio.right()[src..src + n]);
        }
    }

    /// モノラルのクリップの、`[pos, pos + out.len())` と重なる部分を `out` に足す。
    pub(crate) fn add_mono(&self, pos: u64, out: &mut [f32]) {
        if let Some((dst, src, n)) = self.overlap(pos, out.len()) {
            add(&mut out[dst..dst + n], &self.audio.left()[src..src + n]);
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

    fn clip(frames: usize, start: i64) -> PlacedClip {
        let samples = (1..=frames).map(|i| i as f32).collect();
        PlacedClip {
            audio: Arc::new(AudioData::new(48_000, vec![samples]).unwrap()),
            start,
        }
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
}
