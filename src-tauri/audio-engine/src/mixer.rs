//! トラックの音量・パン・ミュート・ソロ。
//!
//! パンの決まりは、いまの画面側 (Web Audio の `StereoPannerNode`) と同じにしてある
//! (再生を Rust に移したときに、音量が変わらないように)。素材がモノラルかステレオかで
//! 決まりが違う:
//!
//! - モノラル: 左右に等しいパワーで振り分ける。中央では左右とも約 0.707 倍 (-3dB)
//! - ステレオ: 中央ではそのまま。左に振ると、右の音を減らしながら左へ足す (右も同様)
//!
//! Web Audio は、トラックにステレオの素材が 1 つでも在るとモノラルの素材もステレオとして
//! 扱うが、ここでは素材ごとに決める (同じクリップの音量が、隣に何が在るかで変わらない)。

use std::f32::consts::FRAC_PI_2;

/// dB を倍率にする (0dB = 1.0、-6.02dB ≒ 0.5)。負の無限大は 0。
pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// どのトラックが鳴るか。ミュートしたトラックは鳴らず、ソロのトラックが 1 本でも在れば
/// ソロのトラックだけが鳴る (ミュートがソロより強い)。`(mute, solo)` の並びを受け取る。
pub fn audible(tracks: &[(bool, bool)]) -> Vec<bool> {
    let any_solo = tracks.iter().any(|&(_, solo)| solo);
    tracks
        .iter()
        .map(|&(mute, solo)| !mute && (!any_solo || solo))
        .collect()
}

/// トラック 1 本の、素材から出力への倍率 (音量とパンを掛け合わせたもの)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct TrackGains {
    /// ステレオの素材: `出力の左 = ll * 左 + lr * 右`
    pub(crate) ll: f32,
    pub(crate) lr: f32,
    /// ステレオの素材: `出力の右 = rl * 左 + rr * 右`
    pub(crate) rl: f32,
    pub(crate) rr: f32,
    /// モノラルの素材: `出力の左 = ml * 音`、`出力の右 = mr * 音`
    pub(crate) ml: f32,
    pub(crate) mr: f32,
}

impl TrackGains {
    /// 音量 (dB) とパン (-1.0〜1.0。範囲の外は丸める) から倍率を作る。
    pub(crate) fn new(gain_db: f32, pan: f32) -> Self {
        let g = db_to_gain(gain_db);
        let pan = pan.clamp(-1.0, 1.0);
        // モノラル: 左端 0 〜 右端 1 を、四分円の上の位置にする
        let (cos, sin) = quarter_circle((pan + 1.0) / 2.0);
        let (ml, mr) = (g * cos, g * sin);
        // ステレオ: 振った側と逆のチャンネルを、減らしながら振った側へ足す
        let (ll, lr, rl, rr) = if pan <= 0.0 {
            let (cos, sin) = quarter_circle(pan + 1.0);
            (g, g * cos, 0.0, g * sin)
        } else {
            let (cos, sin) = quarter_circle(pan);
            (g * cos, 0.0, g * sin, g)
        };
        TrackGains {
            ll,
            lr,
            rl,
            rr,
            ml,
            mr,
        }
    }
}

/// 四分円の上の位置 `x` (0.0〜1.0) の (cos, sin)。両端はちょうど 0 と 1 にする
/// (f32 の π/2 は真の値より少し大きく、cos がわずかに負になる。中央に置いたステレオの
/// 素材が、1 ビットも変わらずに通るように)。
fn quarter_circle(x: f32) -> (f32, f32) {
    if x <= 0.0 {
        (1.0, 0.0)
    } else if x >= 1.0 {
        (0.0, 1.0)
    } else {
        ((x * FRAC_PI_2).cos(), (x * FRAC_PI_2).sin())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn dbは倍率になる() {
        assert!(close(db_to_gain(0.0), 1.0));
        assert!(close(db_to_gain(-20.0), 0.1));
        assert!(close(db_to_gain(6.0), 1.995_262_3));
        assert_eq!(db_to_gain(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn ミュートとソロで鳴るトラックが決まる() {
        // ソロが無ければ、ミュートしていないトラックが鳴る
        assert_eq!(audible(&[(false, false), (true, false)]), vec![true, false]);
        // ソロが在れば、ソロのトラックだけ
        assert_eq!(
            audible(&[(false, false), (false, true), (false, true)]),
            vec![false, true, true]
        );
        // ソロでも、ミュートしていれば鳴らない
        assert_eq!(audible(&[(false, false), (true, true)]), vec![false, false]);
        assert!(audible(&[]).is_empty());
    }

    #[test]
    fn ステレオの素材は中央でそのまま通る() {
        let g = TrackGains::new(0.0, 0.0);
        assert!(close(g.ll, 1.0) && close(g.rr, 1.0));
        assert!(close(g.lr, 0.0) && close(g.rl, 0.0));
    }

    #[test]
    fn ステレオの素材を端に振ると反対側の音も寄る() {
        let left = TrackGains::new(0.0, -1.0);
        assert!(close(left.ll, 1.0) && close(left.lr, 1.0));
        assert!(close(left.rl, 0.0) && close(left.rr, 0.0));
        let right = TrackGains::new(0.0, 1.0);
        assert!(close(right.ll, 0.0) && close(right.lr, 0.0));
        assert!(close(right.rl, 1.0) && close(right.rr, 1.0));
    }

    #[test]
    fn モノラルの素材はどこに振ってもパワーが同じ() {
        for pan in [-1.0, -0.5, 0.0, 0.3, 1.0] {
            let g = TrackGains::new(0.0, pan);
            assert!(close(g.ml * g.ml + g.mr * g.mr, 1.0), "pan={pan}");
        }
        let center = TrackGains::new(0.0, 0.0);
        assert!(close(center.ml, std::f32::consts::FRAC_1_SQRT_2));
        assert!(close(center.mr, std::f32::consts::FRAC_1_SQRT_2));
        let left = TrackGains::new(0.0, -1.0);
        assert!(close(left.ml, 1.0) && close(left.mr, 0.0));
    }

    #[test]
    fn 音量はすべての倍率にかかり範囲の外のパンは丸める() {
        let g = TrackGains::new(-20.0, 0.0);
        assert!(close(g.ll, 0.1) && close(g.rr, 0.1));
        assert!(close(g.ml, 0.1 * std::f32::consts::FRAC_1_SQRT_2));
        assert_eq!(TrackGains::new(0.0, 5.0), TrackGains::new(0.0, 1.0));
        assert_eq!(TrackGains::new(0.0, -5.0), TrackGains::new(0.0, -1.0));
    }
}
