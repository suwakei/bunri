//! サンプリング周波数の変換 (窓をかけた sinc で補間する)。
//!
//! 取り込んだ音声 (44.1kHz が多い) を、engine の周波数に合わせるのに使う。変換は曲を
//! 組み立てるとき (音声スレッドの外) に、音声全体に対して一度だけ行う。再生のたびに
//! 補間しないので、音声スレッドの負荷は増えない。
//!
//! 出力の n 番目のフレームは、入力の `n * from / to` の位置をちょうど指す
//! (フィルタによる遅れを持たない)。原曲と打ち込みを重ねて聞くので、位置はずらさない。
//!
//! 品質: 低いほうの周波数のナイキストの 90% までは平坦 (44.1kHz なら約 19.8kHz)、
//! ナイキストより上は約 -100dB。

/// 片側のゼロ交差の数 (低いほうの周波数で数える)。多いほど遷移の幅が狭くなる
const ZEROS: usize = 64;
/// カイザー窓の形。10.06 で阻止域が約 -100dB
const KAISER_BETA: f64 = 10.06;
/// 遮断周波数を、低いほうのナイキストの何倍に置くか。`ZEROS` とこの値の組で、
/// 阻止域の端がちょうどナイキストに来る
const ROLLOFF: f64 = 0.95;
/// 位相ごとに係数を持つ上限。周波数の比が単純でないとき (位相がこれより多いとき) は、
/// この数に区切って隣の位相と線形に補間する
const MAX_PHASES: u64 = 2048;

/// 周波数の組ごとに作る変換器。係数の表を持つので、チャンネルごとに使い回す。
pub(crate) struct Resampler {
    /// 出力側の比 (`to / gcd`)
    up: u64,
    /// 入力側の比 (`from / gcd`)
    down: u64,
    /// 係数の片側の長さ (入力のフレーム数)
    half: usize,
    /// 表の位相の数。表は `phases + 1` 行 (最後の行は位相 1.0 = 次のフレームの位相 0 と同じ形)
    phases: u64,
    /// 位相が表の行にちょうど乗るか (乗らなければ隣の行と補間する)
    exact: bool,
    /// `(phases + 1)` 行 × `2 * half` 個の係数
    table: Vec<f32>,
}

impl Resampler {
    /// `from` Hz の音声を `to` Hz にする変換器を作る。
    pub(crate) fn new(from: u32, to: u32) -> Self {
        assert!(from > 0 && to > 0, "周波数は 1 以上");
        let g = gcd(from as u64, to as u64);
        let (up, down) = (to as u64 / g, from as u64 / g);
        // 下げるときは、出力のナイキストに合わせて遮断周波数を下げ、係数をそのぶん長くする
        let ratio = (up as f64 / down as f64).min(1.0);
        let half = (ZEROS as f64 / ratio).ceil() as usize;
        // 遮断周波数 (入力の周波数を 1 としたときの値。0.5 が入力のナイキスト)
        let fc = 0.5 * ratio * ROLLOFF;
        let exact = up <= MAX_PHASES;
        let phases = if exact { up } else { MAX_PHASES };

        let taps = 2 * half;
        let mut table = Vec::with_capacity((phases as usize + 1) * taps);
        let i0_beta = bessel_i0(KAISER_BETA);
        let mut row = vec![0f64; taps];
        for j in 0..=phases {
            let frac = j as f64 / phases as f64;
            for (a, v) in row.iter_mut().enumerate() {
                // この係数がかかる入力フレームと、求めたい位置との距離
                let t = a as f64 - (half as f64 - 1.0) - frac;
                let u = t / half as f64;
                let window = if u.abs() < 1.0 {
                    bessel_i0(KAISER_BETA * (1.0 - u * u).sqrt()) / i0_beta
                } else {
                    0.0
                };
                *v = 2.0 * fc * sinc(2.0 * fc * t) * window;
            }
            // 直流の利得をちょうど 1 にする (位相ごとのわずかな揺れを消す)
            let sum: f64 = row.iter().sum();
            table.extend(row.iter().map(|v| (v / sum) as f32));
        }
        Resampler {
            up,
            down,
            half,
            phases,
            exact,
            table,
        }
    }

    /// 変換後のフレーム数 (端数は切り上げる)。
    pub(crate) fn output_len(&self, input_len: usize) -> usize {
        (input_len as u64 * self.up).div_ceil(self.down) as usize
    }

    /// 1 チャンネルぶんを変換する。入力の外側は無音として扱う。
    pub(crate) fn process(&self, input: &[f32]) -> Vec<f32> {
        let taps = 2 * self.half;
        let len = input.len() as i64;
        let mut out = Vec::with_capacity(self.output_len(input.len()));
        for n in 0..self.output_len(input.len()) as u64 {
            let at = n * self.down;
            let (index, rem) = ((at / self.up) as i64, at % self.up);
            let (row, blend) = if self.exact {
                (rem as usize, 0.0)
            } else {
                let x = rem as f64 * self.phases as f64 / self.up as f64;
                (x.floor() as usize, (x - x.floor()) as f32)
            };
            // 係数の 0 番目がかかる入力フレーム。入力の外にはみ出す分は使わない
            let first = index - (self.half as i64 - 1);
            let a0 = (-first).clamp(0, taps as i64) as usize;
            let a1 = (len - first).clamp(0, taps as i64) as usize;
            if a0 >= a1 {
                out.push(0.0);
                continue;
            }
            let x = &input[(first + a0 as i64) as usize..(first + a1 as i64) as usize];
            let coeff = |r: usize| &self.table[r * taps + a0..r * taps + a1];
            let mut y = dot(coeff(row), x);
            if blend > 0.0 {
                y += blend * (dot(coeff(row + 1), x) - y);
            }
            out.push(y);
        }
        out
    }
}

/// 内積。8 本に分けて足し、コンパイラが SIMD にできる形にする。
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f32; 8];
    let ((ca, ra), (cb, rb)) = (a.as_chunks::<8>(), b.as_chunks::<8>());
    for (x, y) in ca.iter().zip(cb) {
        for ((s, p), q) in acc.iter_mut().zip(x).zip(y) {
            *s += p * q;
        }
    }
    let tail: f32 = ra.iter().zip(rb).map(|(p, q)| p * q).sum();
    acc.iter().sum::<f32>() + tail
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let px = std::f64::consts::PI * x;
        px.sin() / px
    }
}

/// 第 1 種の変形ベッセル関数 (0 次)。カイザー窓に使う。
fn bessel_i0(x: f64) -> f64 {
    let half = x / 2.0;
    let (mut term, mut sum) = (1.0f64, 1.0f64);
    for k in 1..200 {
        term *= (half / k as f64).powi(2);
        sum += term;
        if term < sum * 1e-16 {
            break;
        }
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn sine(rate: u32, hz: f64, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| (0.5 * (2.0 * PI * hz * i as f64 / rate as f64).sin()) as f32)
            .collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    /// 変換した正弦波と、変換後の周波数で直接作った正弦波の、いちばん大きい差。
    /// 両端は入力の外を無音として扱うぶん崩れるので、`edge` フレームずつ除く。
    fn max_error(from: u32, to: u32, hz: f64, edge: usize) -> f64 {
        let out = Resampler::new(from, to).process(&sine(from, hz, from as usize / 2));
        let want = sine(to, hz, out.len());
        out[edge..out.len() - edge]
            .iter()
            .zip(&want[edge..])
            .map(|(a, b)| (*a as f64 - *b as f64).abs())
            .fold(0.0, f64::max)
    }

    #[test]
    fn 変換後のフレーム数は周波数の比になる() {
        let r = Resampler::new(44_100, 48_000);
        assert_eq!(r.output_len(44_100), 48_000);
        assert_eq!(r.output_len(147), 160);
        // 端数は切り上げる
        assert_eq!(r.output_len(1), 2);
        assert_eq!(r.process(&[0.0; 441]).len(), 480);
    }

    #[test]
    fn 上げても位置と高さと大きさが変わらない() {
        // 位置がずれたり高さが変わったりすれば、直接作った正弦波と合わなくなる
        let err = max_error(44_100, 48_000, 1000.0, 400);
        assert!(err < 1e-4, "差が大きい: {err:e}");
    }

    #[test]
    fn 高い音も削らない() {
        // 44.1kHz の 18kHz (ナイキストの 82%) は平坦な範囲の中
        let err = max_error(44_100, 48_000, 18_000.0, 400);
        assert!(err < 1e-4, "差が大きい: {err:e}");
    }

    #[test]
    fn 下げても位置と高さと大きさが変わらない() {
        let err = max_error(96_000, 44_100, 1000.0, 400);
        assert!(err < 1e-4, "差が大きい: {err:e}");
    }

    #[test]
    fn 下げるときは折り返す高さの音を消す() {
        // 30kHz は 48kHz では表せない (消さないと 18kHz に折り返して聞こえる)
        let out = Resampler::new(96_000, 48_000).process(&sine(96_000, 30_000.0, 48_000));
        let level = rms(&out[400..out.len() - 400]);
        assert!(level < 0.5 * 1e-4, "折り返しが残っている: {level:e}");
    }

    #[test]
    fn 比が単純でない周波数でも合う() {
        // 44101 と 48000 は互いに素。位相を区切って補間する経路を通る
        assert!(!Resampler::new(44_101, 48_000).exact);
        let err = max_error(44_101, 48_000, 1000.0, 400);
        assert!(err < 1e-4, "差が大きい: {err:e}");
    }

    #[test]
    fn 一定の値はそのまま通る() {
        let out = Resampler::new(44_100, 48_000).process(&[0.25; 4410]);
        for v in &out[400..out.len() - 400] {
            assert!((v - 0.25).abs() < 1e-6, "直流の利得が 1 でない: {v}");
        }
    }

    #[test]
    fn 空の入力は空になる() {
        assert!(Resampler::new(44_100, 48_000).process(&[]).is_empty());
    }
}
