//! sfizz の包み (`Sampler`) を、engine を通さずに確かめる。
//!
//! ノートの位置・高さ・強さなど、音の確かめは engine を通して行う (`tests/engine.rs`)。

mod common;

use bunri_audio::Sampler;
use common::{rms, Workdir, BLOCK, SR};
use std::path::Path;

#[test]
fn 無いファイルは読み込みエラーになる() {
    let mut s = Sampler::new(SR as f32, BLOCK);
    assert!(s
        .load_file(Path::new("/nonexistent/bunri/none.sfz"))
        .is_err());
}

#[test]
fn sfzを読むとregionが数えられる() {
    let dir = Workdir::new("sampler-regions");
    let mut s = Sampler::new(SR as f32, BLOCK);
    s.load_file(&dir.a440()).expect("SFZ を読めるはず");
    assert_eq!(s.num_regions(), 1);
}

#[test]
fn sfzの本文を文字列で渡しても鳴る() {
    let dir = Workdir::new("sampler-string");
    dir.a440();
    let mut s = Sampler::new(SR as f32, BLOCK);
    // 仮のパス (実在しなくてよい) が、サンプルの相対パスの基準になる
    s.load_string(
        &dir.path("virtual.sfz"),
        "<region> sample=a440.wav pitch_keycenter=69",
    )
    .expect("SFZ を読めるはず");
    s.note_on(0, 69, 100);
    let (mut l, mut r) = (vec![0f32; BLOCK], vec![0f32; BLOCK]);
    s.render(&mut l, &mut r);
    assert!(rms(&l) > 0.01 && rms(&r) > 0.01);
    assert_eq!(s.active_voices(), 1);
    s.all_sound_off();
    assert_eq!(s.active_voices(), 0);
}
