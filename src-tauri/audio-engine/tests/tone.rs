//! 仮の音 (三角波) を engine で鳴らしたときの音と、再生中にトラックを動かす口を確かめる。
//!
//! 音の決まりは、いまの画面 (Web Audio) と合わせてある: 三角波、山の高さ
//! `0.25 × max(0.2, 強さ / 96)`、立ち上がり 10ms、離してから 60ms で消える、モノラルの素材。

mod common;

use bunri_audio::{Clip, Engine, EngineConfig, Song, Track};
use common::*;
use std::f32::consts::FRAC_1_SQRT_2;

/// 立ち上がり (10ms) と、離してから消えるまで (60ms) のフレーム数。
const ATTACK: usize = 480;
const RELEASE: usize = 2880;
/// 再生中に倍率を移す長さ (5ms)。
const RAMP: usize = 240;

/// `engine` を `blocks` の長さで順に回し (足りなくなったら繰り返す)、`frames` フレームを作る。
fn run(engine: &mut Engine, frames: usize, blocks: &[usize]) -> (Vec<f32>, Vec<f32>) {
    let (mut left, mut right) = (vec![0f32; frames], vec![0f32; frames]);
    let mut done = 0;
    for len in blocks.iter().cycle() {
        if done >= frames {
            break;
        }
        let len = (*len).min(frames - done);
        engine.process(&mut left[done..done + len], &mut right[done..done + len]);
        done += len;
    }
    (left, right)
}

/// 一定の値 (1.0) が続くモノラルの音声を置いたトラック。倍率の動きが、そのまま出力に出る。
fn constant_track(frames: usize) -> Track {
    Track {
        clips: vec![Clip {
            audio: mono(SR, vec![1.0; frames]),
            start_sec: 0.0,
        }],
        ..Track::default()
    }
}

// ---- 仮の音 ----

#[test]
fn 仮の音は決まった高さと大きさで鳴りモノラルの素材としてパンを通る() {
    // 中央: 左右に同じ音。モノラルの素材なので、左右とも -3dB
    let s = song(vec![tone_track(vec![note(0, 48_000, 69, 96)])]);
    let out = render_frames(&s, 48_000);
    assert_eq!(out.left(), out.right());
    let level = peak(&out.left()[ATTACK..40_000]);
    assert!(
        (level - 0.25 * FRAC_1_SQRT_2).abs() < 0.002,
        "山の高さ: {level}"
    );
    let hz = estimate_hz(&out.left()[ATTACK..ATTACK + 24_000]);
    assert!((hz - 440.0).abs() < 3.0, "A4 のはずが {hz:.1}Hz");

    // 左いっぱい: 左にそのままの大きさ、右は無音
    let s = song(vec![Track {
        pan: -1.0,
        ..tone_track(vec![note(0, 48_000, 69, 96)])
    }]);
    let out = render_frames(&s, 48_000);
    let level = peak(&out.left()[ATTACK..40_000]);
    assert!((level - 0.25).abs() < 0.002, "山の高さ: {level}");
    assert_eq!(peak(out.right()), 0.0);
}

#[test]
fn 仮の音の大きさは強さで決まる() {
    let measure = |velocity: u8| {
        let s = song(vec![Track {
            pan: -1.0,
            ..tone_track(vec![note(0, 24_000, 81, velocity)])
        }]);
        peak(&render_frames(&s, 24_000).left()[ATTACK..20_000])
    };
    for (velocity, expected) in [
        (96, 0.25),
        (127, 0.25 * 127.0 / 96.0),
        (48, 0.125),
        (1, 0.05),
    ] {
        let level = measure(velocity);
        assert!(
            (level - expected).abs() < 0.003,
            "強さ {velocity}: 山の高さ {level} (期待 {expected})"
        );
    }
}

#[test]
fn 仮の音は立ち上がりと離したあとの消え方が決まっている() {
    // ブロック (256) の境目に乗らない位置
    let (start, length) = (2_500usize, 12_000usize);
    let s = song(vec![Track {
        pan: -1.0,
        ..tone_track(vec![note(start as u64, length as u64, 69, 96)])
    }]);
    let out = render_frames(&s, 24_000);
    let l = out.left();
    // 鳴り始めより前は無音。鳴り始めは 0 から上がる
    assert!(l[..=start].iter().all(|v| *v == 0.0));
    assert!(l[start + 1] != 0.0);
    // 立ち上がり (10ms) の半分では、山は半分ほど。立ち上がったあとは 0.25
    let half = peak(&l[start + 190..start + 290]);
    assert!((half - 0.125).abs() < 0.03, "立ち上がりの途中: {half}");
    assert!((peak(&l[start + ATTACK..start + length]) - 0.25).abs() < 0.002);
    // ノートの終わりで離す。そこから 60ms の半分では半分ほど、60ms を過ぎたら無音
    let end = start + length;
    let half = peak(&l[end + RELEASE / 2 - 50..end + RELEASE / 2 + 50]);
    assert!((half - 0.125).abs() < 0.02, "消えていく途中: {half}");
    assert!(peak(&l[end + RELEASE - 200..end + RELEASE]) > 0.0);
    assert!(l[end + RELEASE..].iter().all(|v| *v == 0.0));
}

#[test]
fn 仮の音は曲の長さと余韻に数えられる() {
    let s = song(vec![tone_track(vec![note(0, 4_800, 69, 96)])]);
    let mut e = engine(&s);
    assert_eq!(e.length_frames(), 4_800);
    // 曲の終わりまで書き出すと、離したあとの響き (60ms) が消えるまで続く
    let out = bunri_audio::render(&mut e, &bunri_audio::RenderOptions::default());
    assert!(out.frames() >= 4_800 + RELEASE, "frames={}", out.frames());
    assert!(out.frames() < 4_800 + RELEASE + 8_192);
    assert!(peak(&out.left()[4_800 + RELEASE..]) == 0.0);
    assert!(!e.is_sounding());
}

#[test]
fn 仮の音はブロックの区切り方を変えても同じ音になる() {
    // 和音・連打・重なり・位置がブロックの境目に乗らないノートと、モノラルのクリップ
    let s = song(vec![
        tone_track(vec![
            note(25, 6_000, 60, 100),
            note(1_000, 3_000, 64, 60),
            note(1_000, 3_000, 67, 127),
            note(6_025, 2_000, 60, 80),
            note(7_000, 5_000, 72, 96),
        ]),
        Track {
            clips: vec![Clip {
                audio: mono(SR, noise(5, 9_000)),
                start_sec: 0.01,
            }],
            pan: 0.4,
            ..tone_track(vec![note(500, 9_000, 48, 96)])
        },
    ]);
    let frames = 16_000;
    let render_with = |max_block: usize, blocks: &[usize]| {
        let config = EngineConfig {
            sample_rate: SR,
            max_block,
        };
        run(&mut Engine::new(&s, &config).unwrap(), frames, blocks)
    };
    let (left, right) = render_with(256, &[frames]);
    assert!(peak(&left) > 0.3 && peak(&right) > 0.3);
    for (max_block, blocks) in [
        (64, &[frames][..]),
        (100, &[512]),
        (1024, &[128]),
        (256, &[1, 7, 77, 333]),
        (1, &[1000]),
    ] {
        let (l, r) = render_with(max_block, blocks);
        // 声を足し合わせる順番の違いで、最後の桁だけ変わりうる
        let diff = max_diff(&l, &left).max(max_diff(&r, &right));
        assert!(
            diff < 1e-6,
            "max_block={max_block} blocks={blocks:?}: 差 {diff}"
        );
    }
}

#[test]
fn 仮の音も途中から再生するとまたいでいるノートを鳴らし直す() {
    let s = song(vec![tone_track(vec![
        note(0, 4_800, 60, 96),
        note(0, 48_000, 69, 96),
    ])]);
    let mut e = engine(&s);
    // 1 つめのノートは終わっていて、2 つめの途中
    e.seek(24_000);
    let (l, _) = run(&mut e, 12_000, &[256]);
    assert!(peak(&l[ATTACK..]) > 0.15);
    let hz = estimate_hz(&l[ATTACK..]);
    assert!((hz - 440.0).abs() < 5.0, "A4 だけのはずが {hz:.1}Hz");
    // 元のノートの終わり (48000) で離れる
    let (l, _) = run(&mut e, 24_000, &[256]);
    assert!(l[12_000 + RELEASE..].iter().all(|v| *v == 0.0));
}

// ---- 再生中にトラックを動かす ----

#[test]
fn 音量を変えると短い直線で移る() {
    let s = song(vec![constant_track(20_000)]);
    let mut e = engine(&s);
    // モノラルの素材は、中央で左右とも 0.707
    let (before, _) = run(&mut e, 1_000, &[256]);
    assert!(before.iter().all(|v| (*v - FRAC_1_SQRT_2).abs() < 1e-6));

    e.set_track_mix(0, -20.0, 0.0);
    let (l, r) = run(&mut e, 2_000, &[256]);
    assert_eq!(l, r);
    let target = 0.1 * FRAC_1_SQRT_2;
    // 5ms (240 フレーム) かけて、段差なく下がる
    let step = (FRAC_1_SQRT_2 - target) / RAMP as f32;
    assert!((before[999] - l[0] - step).abs() < 1e-6);
    for w in l[..RAMP].windows(2) {
        assert!(
            (w[0] - w[1] - step).abs() < 1e-6,
            "段差: {} → {}",
            w[0],
            w[1]
        );
    }
    assert!((l[RAMP / 2 - 1] - (FRAC_1_SQRT_2 + target) / 2.0).abs() < 1e-5);
    assert!(l[RAMP - 1..].iter().all(|v| (*v - target).abs() < 1e-6));
}

#[test]
fn パンを変えると短い直線で移る() {
    let s = song(vec![constant_track(20_000)]);
    let mut e = engine(&s);
    run(&mut e, 1_000, &[256]);
    e.set_track_mix(0, 0.0, -1.0);
    let (l, r) = run(&mut e, 2_000, &[100]);
    // 左は 0.707 → 1.0、右は 0.707 → 0。どちらも戻らずに進む
    assert!(l[..RAMP].windows(2).all(|w| w[1] > w[0]));
    assert!(r[..RAMP].windows(2).all(|w| w[1] < w[0]));
    assert!(l[RAMP - 1..].iter().all(|v| *v == 1.0));
    assert!(r[RAMP - 1..].iter().all(|v| *v == 0.0));
}

#[test]
fn 鳴らさない側に変えると音を下げてから止める() {
    let s = song(vec![Track {
        pan: -1.0,
        ..tone_track(vec![note(0, 96_000, 69, 96)])
    }]);
    let mut e = engine(&s);
    run(&mut e, 4_800, &[256]);
    assert!(e.is_sounding());

    e.set_track_audible(0, false);
    let (l, r) = run(&mut e, 4_800, &[256]);
    // 5ms のあいだは、まだ鳴っている (だんだん小さくなる)。そのあとは無音
    assert!(peak(&l[..RAMP / 2]) > peak(&l[RAMP / 2..RAMP]));
    assert!(peak(&l[..RAMP / 2]) > 0.1);
    assert!(l[RAMP..].iter().all(|v| *v == 0.0));
    assert_eq!(peak(&r), 0.0);
    // 鳴っていた声も止まっている
    assert!(!e.is_sounding());
}

#[test]
fn 鳴らす側に変えるとまたいでいるノートを鳴らし直し続きの位置が合う() {
    // 長いノート (A4) の途中で鳴らし始める。そのあとに、別のノート (A5) が来る
    let later = 36_000usize;
    let track = Track {
        pan: -1.0,
        mute: true,
        ..tone_track(vec![
            note(0, 4_800, 60, 96),
            note(0, 30_000, 69, 96),
            note(later as u64, 6_000, 81, 96),
        ])
    };
    let s = song(vec![track]);
    let mut e = engine(&s);
    let (l, _) = run(&mut e, 12_000, &[256]);
    assert_eq!(peak(&l), 0.0, "ミュートしたトラックは鳴らない");
    assert!(!e.is_sounding());

    // 12000 で鳴らし始める: またいでいる A4 が、そこから鳴る (終わった C4 は鳴らない)
    e.set_track_audible(0, true);
    let (l, _) = run(&mut e, 36_000, &[256]);
    assert_eq!(l[0], 0.0);
    assert!(peak(&l[..ATTACK]) > 0.1);
    let hz = estimate_hz(&l[ATTACK..12_000]);
    assert!((hz - 440.0).abs() < 5.0, "A4 のはずが {hz:.1}Hz");
    // A4 は元の終わり (30000) で離れ、A5 は元の位置 (36000) で鳴り始める
    let (a4_end, a5_start) = (30_000 - 12_000, later - 12_000);
    assert!(l[a4_end + RELEASE..=a5_start].iter().all(|v| *v == 0.0));
    assert!(l[a5_start + 1] != 0.0);
    let hz = estimate_hz(&l[a5_start + ATTACK..a5_start + 5_000]);
    assert!((hz - 880.0).abs() < 10.0, "A5 のはずが {hz:.1}Hz");
}

#[test]
fn 下げている途中で鳴らす側に戻すと途切れずに上がり直す() {
    let s = song(vec![constant_track(20_000)]);
    let mut e = engine(&s);
    run(&mut e, 1_000, &[256]);
    e.set_track_audible(0, false);
    let (down, _) = run(&mut e, RAMP / 2, &[64]);
    e.set_track_audible(0, true);
    let (up, _) = run(&mut e, 1_000, &[64]);
    // 半分まで下がったところから、段差なく上がる
    let lowest = down[RAMP / 2 - 1];
    assert!((lowest - FRAC_1_SQRT_2 / 2.0).abs() < 1e-3, "{lowest}");
    assert!((up[0] - lowest).abs() < 0.01);
    assert!(up[..RAMP].windows(2).all(|w| w[1] >= w[0]));
    assert!(up[RAMP..].iter().all(|v| (*v - FRAC_1_SQRT_2).abs() < 1e-6));
}

#[test]
fn 位置を移すと移り変わりの途中でも行き先の値から始まる() {
    let s = song(vec![constant_track(20_000), constant_track(20_000)]);
    let mut e = engine(&s);
    run(&mut e, 1_000, &[256]);
    // どちらも移り変わりの途中で、位置を移す
    e.set_track_audible(0, false);
    e.set_track_mix(1, -20.0, -1.0);
    e.seek(5_000);
    let (l, r) = run(&mut e, 1_000, &[256]);
    // 1 本めは鳴らず、2 本めは左に 0.1
    assert!(l.iter().all(|v| (*v - 0.1).abs() < 1e-6));
    assert!(r.iter().all(|v| *v == 0.0));
}

#[test]
fn 倍率の移り変わりもブロックの区切り方に依らない() {
    let s = song(vec![
        Track {
            clips: vec![Clip {
                audio: stereo(SR, noise(1, 20_000), noise(2, 20_000)),
                start_sec: 0.0,
            }],
            ..tone_track(vec![note(0, 20_000, 57, 96)])
        },
        constant_track(20_000),
    ]);
    // 同じ位置 (1024 の倍数) で同じ指示を出し、あいだの区切り方だけを変える
    let play = |blocks: &[usize]| {
        let mut e = engine(&s);
        let mut out = run(&mut e, 1_024, blocks);
        let mut step = |e: &mut Engine| {
            let (l, r) = run(e, 1_024, blocks);
            out.0.extend(l);
            out.1.extend(r);
        };
        e.set_track_mix(0, -6.0, 0.5);
        e.set_track_audible(1, false);
        step(&mut e);
        e.set_track_audible(1, true);
        step(&mut e);
        e.set_track_audible(0, false);
        e.set_track_mix(1, 3.0, -0.7);
        step(&mut e);
        step(&mut e);
        out
    };
    let (left, right) = play(&[1_024]);
    for blocks in [&[64][..], &[100], &[1, 7, 77, 300]] {
        let (l, r) = play(blocks);
        let diff = max_diff(&l, &left).max(max_diff(&r, &right));
        assert!(diff < 1e-6, "blocks={blocks:?}: 差 {diff}");
    }
}

#[test]
fn 無いトラックと数値でない値は無視する() {
    let s = song(vec![constant_track(20_000)]);
    let mut e = engine(&s);
    assert_eq!(e.track_count(), 1);
    e.set_track_mix(5, -20.0, 0.0);
    e.set_track_audible(5, false);
    e.set_track_mix(0, f32::NAN, 0.0);
    e.set_track_mix(0, 0.0, f32::NAN);
    let (l, _) = run(&mut e, 1_000, &[256]);
    assert!(l.iter().all(|v| (*v - FRAC_1_SQRT_2).abs() < 1e-6));

    // 楽器もクリップも無い曲でも、落ちない
    let mut empty = engine(&Song::default());
    empty.set_track_audible(0, true);
    empty.silence();
    assert_eq!(empty.track_count(), 0);
}

#[test]
fn すべて止めると余韻も残らない() {
    let s = song(vec![tone_track(vec![note(0, 96_000, 69, 96)])]);
    let mut e = engine(&s);
    run(&mut e, 4_800, &[256]);
    assert!(e.is_sounding());
    e.silence();
    assert!(!e.is_sounding());
    // 位置は変わらない。続きを作っても、止めたノートは鳴らない
    assert_eq!(e.position(), 4_800);
    let (l, _) = run(&mut e, 4_800, &[256]);
    assert_eq!(peak(&l), 0.0);
}
