//! ノートの並びを、オフラインで音にする (書き出しとテスト用)。
//!
//! ノートの開始・終了はフレーム単位で、ブロックの中の位置まで正確に sfizz に渡す
//! (ブロックの頭に丸めない)。リアルタイムの再生も同じ送り方をする予定。

use crate::sampler::Sampler;

/// 鳴らすノート 1 つ。位置と長さはフレーム数 (サンプリング周波数の単位)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Note {
    /// 鳴り始めのフレーム
    pub start: u64,
    /// 長さ (フレーム)。0 のノートは鳴らさない
    pub length: u64,
    /// MIDI ノート番号 (60 = C4)
    pub pitch: u8,
    /// 強さ (1〜127)
    pub velocity: u8,
}

#[derive(Debug, Clone, Copy)]
enum Kind {
    // 同じフレームでは、離す方を先に送る (同じ高さの連打で、次の音を止めてしまわないように)
    Off,
    On(u8),
}

/// `notes` を鳴らし、`total_frames` フレームぶんの左右の音を返す。
///
/// `total_frames` を超える位置のノートは鳴らない。ノートが終わったあとの余韻も
/// `total_frames` の中に収まるぶんだけが入る。
///
/// 描画のあいだはサンプラーをオフラインのモードにする (ディスクからの読み込みを待つ)。
/// 待たないと、実時間より速く回すので、サンプルの頭 (メモリに置いた部分) より後ろが
/// 無音になる。終わったらリアルタイムのモードに戻す。
pub fn render_notes(
    sampler: &mut Sampler,
    notes: &[Note],
    total_frames: usize,
) -> (Vec<f32>, Vec<f32>) {
    let mut events: Vec<(u64, Kind, u8)> = Vec::with_capacity(notes.len() * 2);
    for n in notes.iter().filter(|n| n.length > 0) {
        events.push((n.start, Kind::On(n.velocity), n.pitch));
        events.push((n.start + n.length, Kind::Off, n.pitch));
    }
    events.sort_by_key(|&(frame, kind, _)| (frame, matches!(kind, Kind::On(_))));

    sampler.set_offline(true);
    let block = sampler.max_block();
    let mut left = vec![0f32; total_frames];
    let mut right = vec![0f32; total_frames];
    let mut next = 0usize;
    let mut pos = 0usize;
    while pos < total_frames {
        let len = block.min(total_frames - pos);
        let end = (pos + len) as u64;
        while next < events.len() && events[next].0 < end {
            let (frame, kind, pitch) = events[next];
            let delay = frame.saturating_sub(pos as u64) as usize;
            match kind {
                Kind::On(vel) => sampler.note_on(delay, pitch, vel),
                Kind::Off => sampler.note_off(delay, pitch),
            }
            next += 1;
        }
        sampler.render(&mut left[pos..pos + len], &mut right[pos..pos + len]);
        pos += len;
    }
    sampler.set_offline(false);
    (left, right)
}
