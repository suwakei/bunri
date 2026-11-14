//! engine をオフラインで回して音声にする (書き出しとテスト用)。
//!
//! 再生と同じ [`Engine::process`] を回すので、聞いた音と書き出した音が食い違わない。
//! WAV にするには、結果の [`AudioData::write_wav_file`] を使う。

use crate::audio::AudioData;
use crate::engine::Engine;

/// 一度に `process` へ渡す長さ (フレーム)。engine が中でさらに区切る
const CHUNK: usize = 4096;

/// 描画する範囲。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RenderOptions {
    /// 範囲の頭 (フレーム)
    pub start: u64,
    /// 範囲の終わり (フレーム)。`None` は曲の終わりまで
    pub end: Option<u64>,
    /// 曲の終わりまで描画するとき、そのあとの余韻 (離したあとの響き) を、音が消えるまで
    /// 続ける長さの上限 (秒)。0 なら曲の終わりちょうどで切る。`end` を指定したときは
    /// 使わない (範囲ちょうどで切る)
    pub max_tail_secs: f64,
}

impl Default for RenderOptions {
    /// 曲の頭から終わりまで。余韻は 10 秒まで。
    fn default() -> Self {
        RenderOptions {
            start: 0,
            end: None,
            max_tail_secs: 10.0,
        }
    }
}

/// engine をオフラインで回し、`options` の範囲の音声 (ステレオ) を返す。
///
/// 描画のあいだは engine をオフラインのモードにする (ディスクからの読み込みを待つ)。
/// 待たないと、実時間より速く回すので、サンプルの頭 (メモリに置いた部分) より後ろが
/// 無音になる。終わったらリアルタイムのモードに戻す。engine の位置は、描画した範囲の
/// 終わりに進む。
pub fn render(engine: &mut Engine, options: &RenderOptions) -> AudioData {
    let end = options.end.unwrap_or(engine.length_frames());
    let frames = end.saturating_sub(options.start) as usize;
    let mut left = vec![0f32; frames];
    let mut right = vec![0f32; frames];

    engine.set_offline(true);
    engine.seek(options.start);
    for (l, r) in left.chunks_mut(CHUNK).zip(right.chunks_mut(CHUNK)) {
        engine.process(l, r);
    }

    if options.end.is_none() && frames > 0 {
        let max_tail = (options.max_tail_secs.max(0.0) * engine.sample_rate() as f64) as usize;
        let mut tail = 0;
        while tail < max_tail && engine.is_sounding() {
            let len = CHUNK.min(max_tail - tail);
            let at = left.len();
            left.resize(at + len, 0.0);
            right.resize(at + len, 0.0);
            engine.process(&mut left[at..], &mut right[at..]);
            tail += len;
        }
    }
    engine.set_offline(false);

    AudioData::new(engine.sample_rate(), vec![left, right])
        .expect("engine の周波数は組み立てのときに確かめてある")
}
