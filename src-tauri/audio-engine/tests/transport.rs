//! 再生の状態を進める部品 (`transport`) を、音声デバイス抜きで回して確かめる。
//!
//! 本物のデバイスは使わない。`Transport::process` を、デバイスのコールバックの代わりに
//! テストから直接呼ぶ。

mod common;

use bunri_audio::transport::{CLICK_ACCENT_HZ, CLICK_HZ, CLICK_LEVEL, CLICK_SEC, JOIN_FADE_SEC};
use bunri_audio::{
    transport, Clip, Controller, CountIn, Engine, EngineConfig, Grid, PlayOptions, Song, Track,
    Transport, TransportError,
};
use common::*;
use std::sync::Arc;

/// つなぎ目で上げ下げする長さ (4ms)。
const FADE: usize = (SR as f64 * JOIN_FADE_SEC) as usize;
/// クリックの長さ (50ms)。
const CLICK: usize = (SR as f64 * CLICK_SEC) as usize;
/// 120 BPM の 1 拍。
const BEAT: usize = 24_000;

fn boxed(song: &Song) -> Box<Engine> {
    Box::new(engine(song))
}

/// 曲を渡した状態の transport を作る。
fn setup(song: &Song) -> (Controller, Transport) {
    let (mut controller, transport) = transport(SR).unwrap();
    controller.set_song(boxed(song), &Grid::default()).unwrap();
    (controller, transport)
}

/// `frames` フレームを、`block` フレームずつ作る (デバイスのコールバックの代わり)。
fn run(transport: &mut Transport, frames: usize, block: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut left, mut right) = (vec![0f32; frames], vec![0f32; frames]);
    for (l, r) in left.chunks_mut(block).zip(right.chunks_mut(block)) {
        transport.process(l, r);
    }
    (left, right)
}

/// 決まった並びの雑音 (ステレオ) を 0 秒に置いた曲と、その音声。位置がずれれば一致しなくなる。
fn noise_song(seed: u32, frames: usize) -> (Song, Arc<bunri_audio::AudioData>) {
    let audio = stereo(SR, noise(seed, frames), noise(seed + 100, frames));
    let s = song(vec![Track {
        clips: vec![Clip {
            audio: Arc::clone(&audio),
            start_sec: 0.0,
        }],
        ..Track::default()
    }]);
    (s, audio)
}

fn play_from(from_sec: f64) -> PlayOptions {
    PlayOptions {
        token: 1,
        from_sec,
        ..PlayOptions::default()
    }
}

/// クリックが鳴っている位置 (鳴り始めのフレーム) と、その高さ (Hz) を拾う。
/// クリックのほかに音が無い出力に使う。
fn find_clicks(x: &[f32]) -> Vec<(usize, f64)> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < x.len() {
        if x[i].abs() > 1e-4 {
            // 鳴り始めのフレームは 0 (正弦波の頭) なので、1 つ手前が鳴り始め
            let start = i.saturating_sub(1);
            let end = (start + CLICK).min(x.len());
            let crossings = x[start..end]
                .windows(2)
                .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
                .count();
            found.push((start, crossings as f64 / CLICK_SEC));
            i = start + CLICK;
        } else {
            i += 1;
        }
    }
    found
}

fn assert_clicks(x: &[f32], expected: &[(usize, f64)]) {
    let found = find_clicks(x);
    assert_eq!(
        found.iter().map(|(at, _)| *at).collect::<Vec<_>>(),
        expected.iter().map(|(at, _)| *at).collect::<Vec<_>>(),
        "クリックの位置"
    );
    for ((at, hz), (_, expected_hz)) in found.iter().zip(expected) {
        assert!(
            (hz - expected_hz).abs() <= 40.0,
            "{at} のクリックは {expected_hz}Hz のはずが {hz}Hz"
        );
    }
}

// ---- 再生と停止 ----

#[test]
fn 止まっているあいだは無音() {
    let (s, _) = noise_song(1, 48_000);
    let (controller, mut t) = setup(&s);
    let (l, r) = run(&mut t, 4_096, 256);
    assert_eq!(peak(&l), 0.0);
    assert_eq!(peak(&r), 0.0);
    let position = controller.position();
    assert!(!position.playing && !position.counting_in);
    assert_eq!((position.token, position.frame, position.pass), (0, 0, 0));
    assert_eq!(position.count_in_remaining_frames, 0);
}

#[test]
fn 再生すると指定した位置から鳴る() {
    let (s, audio) = noise_song(1, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller.play(&play_from(0.5)).unwrap();
    let (l, r) = run(&mut t, 8_000, 256);
    // 鳴らし始めは 4ms かけて上げる。そのあとは、クリップの中身がそのまま出る
    let from = 24_000;
    assert_eq!(l[0], 0.0);
    for i in 0..FADE {
        let gain = i as f32 / FADE as f32;
        assert!((l[i] - audio.left()[from + i] * gain).abs() < 1e-6, "i={i}");
        assert!(
            (r[i] - audio.right()[from + i] * gain).abs() < 1e-6,
            "i={i}"
        );
    }
    assert_eq!(l[FADE..], audio.left()[from + FADE..from + 8_000]);
    assert_eq!(r[FADE..], audio.right()[from + FADE..from + 8_000]);

    // 位置は、いちばん新しいブロックの頭 (8000 フレームを 256 ずつ → 最後のブロックは 7936 から)
    let position = controller.position();
    assert!(position.playing && !position.counting_in);
    assert_eq!(position.token, 1);
    assert_eq!(position.frame, from as u64 + 7_936);
    assert!((position.position_sec - (from as f64 + 7_936.0) / SR as f64).abs() < 1e-12);
    assert_eq!(position.pass, 0);
}

#[test]
fn 曲の頭からのループでない再生は上げずに最初のフレームから鳴る() {
    // 頭ちょうどに在るアタック (取り込んだ曲の最初の音) を弱めない
    let (s, audio) = noise_song(3, 48_000);
    let (mut controller, mut t) = setup(&s);
    controller.play(&play_from(0.0)).unwrap();
    let (l, r) = run(&mut t, 2_048, 256);
    assert_ne!(audio.left()[0], 0.0);
    assert_eq!(l[..], audio.left()[..2_048]);
    assert_eq!(r[..], audio.right()[..2_048]);

    // 区間ループなら、頭 (0) から始めても上げる (周の頭と同じ扱い)
    let (mut controller, mut t) = setup(&s);
    controller
        .play(&PlayOptions {
            loop_range: Some((0.0, 0.5)),
            ..play_from(0.0)
        })
        .unwrap();
    let (l, _) = run(&mut t, 2_048, 256);
    assert_eq!(l[0], 0.0);
    assert_eq!(l[FADE..2_048], audio.left()[FADE..2_048]);
}

#[test]
fn 負の位置からの再生は頭から() {
    let (s, audio) = noise_song(1, 48_000);
    let (mut controller, mut t) = setup(&s);
    controller.play(&play_from(-3.0)).unwrap();
    let (l, _) = run(&mut t, 2_000, 500);
    assert_eq!(l[FADE..], audio.left()[FADE..2_000]);
}

#[test]
fn 停止すると音を下げてから無音になり位置はそこで止まる() {
    let (s, audio) = noise_song(1, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller.play(&play_from(0.0)).unwrap();
    run(&mut t, 4_096, 256);

    controller.stop().unwrap();
    let (l, _) = run(&mut t, 4_096, 256);
    // 4ms かけて下げる (最後のフレームが 0)。そのあとは無音
    for (i, v) in l.iter().enumerate().take(FADE) {
        let gain = (FADE - 1 - i) as f32 / FADE as f32;
        assert!((v - audio.left()[4_096 + i] * gain).abs() < 1e-6, "i={i}");
    }
    assert!(l[FADE - 1..].iter().all(|v| *v == 0.0));
    let position = controller.position();
    assert!(!position.playing);
    assert_eq!(position.token, 1);
    assert_eq!(position.frame, 4_096 + FADE as u64);

    // もう一度鳴らせる
    controller
        .play(&PlayOptions {
            token: 2,
            ..play_from(0.25)
        })
        .unwrap();
    let (l, _) = run(&mut t, 2_048, 256);
    assert_eq!(l[FADE..], audio.left()[12_000 + FADE..12_000 + 2_048]);
    assert_eq!(controller.position().token, 2);
}

#[test]
fn 停止するとノートの余韻も残らない() {
    let s = song(vec![tone_track(vec![note(0, 96_000, 69, 96)])]);
    let (mut controller, mut t) = setup(&s);
    controller.play(&play_from(0.0)).unwrap();
    let (l, _) = run(&mut t, 4_096, 256);
    assert!(peak(&l) > 0.1);
    controller.stop().unwrap();
    let (l, _) = run(&mut t, 4_096, 256);
    assert!(l[FADE..].iter().all(|v| *v == 0.0));
}

#[test]
fn 再生中に鳴らし直すと音を下げてから新しい位置で鳴る() {
    let (s, audio) = noise_song(1, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller.play(&play_from(0.0)).unwrap();
    run(&mut t, 1_024, 256);
    controller
        .play(&PlayOptions {
            token: 7,
            ..play_from(1.0)
        })
        .unwrap();
    let (l, _) = run(&mut t, 2_048, 256);
    // 前の位置の音を 4ms で下げ、そこから新しい位置の音を 4ms で上げる
    assert!((l[0] - audio.left()[1_024] * (FADE - 1) as f32 / FADE as f32).abs() < 1e-6);
    assert_eq!(l[FADE - 1], 0.0);
    assert_eq!(l[FADE], 0.0);
    let half = FADE + FADE / 2;
    assert!((l[half] - audio.left()[48_000 + FADE / 2] * 0.5).abs() < 1e-6);
    assert_eq!(
        l[2 * FADE..],
        audio.left()[48_000 + FADE..48_000 + 2_048 - FADE]
    );
    let position = controller.position();
    assert_eq!(position.token, 7);
    assert_eq!(position.frame, 48_000 + 1_792 - FADE as u64);
}

#[test]
fn 曲の終わりを過ぎても止めない() {
    let (s, _) = noise_song(1, 1_000);
    let (mut controller, mut t) = setup(&s);
    controller.play(&play_from(0.0)).unwrap();
    let (l, _) = run(&mut t, 4_096, 256);
    assert_eq!(peak(&l[1_000..]), 0.0);
    let position = controller.position();
    assert!(position.playing);
    assert_eq!(position.frame, 3_840);
}

#[test]
fn 曲を渡していなくても落ちない() {
    let (mut controller, mut t) = transport(SR).unwrap();
    controller.play(&play_from(0.0)).unwrap();
    controller.set_track(0, -6.0, 0.0, false).unwrap();
    let (l, _) = run(&mut t, 1_024, 256);
    assert_eq!(peak(&l), 0.0);
    assert!(controller.position().playing);
    controller.stop().unwrap();
    run(&mut t, 256, 256);
    assert!(!controller.position().playing);
}

// ---- 区間ループ ----

/// 区間ループの出力が、区間の頭から継ぎ目なく続いていることを、1 フレームずつ確かめる。
/// `start_at` は、最初の周が区間のどこから始まるか (区間の頭からのフレーム数)。
fn assert_looped(out: &[f32], clip: &[f32], loop_start: usize, loop_len: usize, start_at: usize) {
    let edge = FADE.min(loop_len / 4);
    let mut exact = 0;
    for (i, v) in out.iter().enumerate() {
        // 区間の中の位置と、いまの周が始まってからのフレーム数
        let in_loop = (start_at + i) % loop_len;
        let since_start = if i < loop_len - start_at { i } else { in_loop };
        let to_end = loop_len - in_loop;
        let gain = (since_start as f32 / edge as f32)
            .min(to_end as f32 / edge as f32)
            .min(1.0);
        let expected = clip[loop_start + in_loop] * gain;
        if gain == 1.0 {
            assert_eq!(*v, expected, "i={i} (区間の中の {in_loop})");
            exact += 1;
        } else {
            assert!((v - expected).abs() < 1e-6, "i={i}: {v} != {expected}");
        }
    }
    assert!(
        exact > out.len() / 2,
        "ほとんどのフレームは、そのまま出るはず"
    );
}

#[test]
fn 区間ループは終わりのフレームでちょうど頭へ戻る() {
    let (s, audio) = noise_song(3, 96_000);
    // 区間は 0.25〜0.75 秒 (12000〜36000 フレーム)。ブロックの長さでは割り切れない
    let (loop_start, loop_len) = (12_000, 24_000);
    for block in [256, 441, 1_000, 5_000] {
        let (mut controller, mut t) = setup(&s);
        controller
            .play(&PlayOptions {
                loop_range: Some((0.25, 0.75)),
                ..play_from(0.25)
            })
            .unwrap();
        // 3 周と少し
        let (l, r) = run(&mut t, loop_len * 3 + 5_000, block);
        assert_looped(&l, audio.left(), loop_start, loop_len, 0);
        assert_looped(&r, audio.right(), loop_start, loop_len, 0);
        // 頭へ戻った直後のフレームは 0、その手前はごく小さい (つなぎ目に段差が無い)
        assert_eq!(l[loop_len], 0.0);
        assert!(l[loop_len - 1].abs() <= 0.5 / FADE as f32);
    }
}

#[test]
fn 区間の途中から始めると最初の周はそこから終わりまで() {
    let (s, audio) = noise_song(3, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller
        .play(&PlayOptions {
            loop_range: Some((0.25, 0.75)),
            ..play_from(0.5)
        })
        .unwrap();
    let (l, _) = run(&mut t, 60_000, 512);
    assert_looped(&l, audio.left(), 12_000, 24_000, 12_000);
}

#[test]
fn 区間の外から始めると区間の頭から() {
    let (s, audio) = noise_song(3, 96_000);
    for from_sec in [0.0, 0.75, 1.5] {
        let (mut controller, mut t) = setup(&s);
        controller
            .play(&PlayOptions {
                loop_range: Some((0.25, 0.75)),
                ..play_from(from_sec)
            })
            .unwrap();
        let (l, _) = run(&mut t, 30_000, 512);
        assert_looped(&l, audio.left(), 12_000, 24_000, 0);
        assert_eq!(controller.position().pass, 1, "from={from_sec}");
    }
}

#[test]
fn 短い区間では上げ下げが区間の四分の一に収まる() {
    let (s, audio) = noise_song(3, 96_000);
    let (mut controller, mut t) = setup(&s);
    // 区間は 400 フレーム (8.3ms)。上げ下げは 100 フレームずつ
    controller
        .play(&PlayOptions {
            loop_range: Some((0.25, 0.25 + 400.0 / SR as f64)),
            ..play_from(0.25)
        })
        .unwrap();
    let (l, _) = run(&mut t, 4_000, 256);
    assert_looped(&l, audio.left(), 12_000, 400, 0);
    assert_eq!(controller.position().pass, 9);
}

#[test]
fn 何周目かは頭へ戻るたびに一つ増える() {
    let (s, _) = noise_song(3, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller
        .play(&PlayOptions {
            loop_range: Some((0.25, 0.75)),
            ..play_from(0.5)
        })
        .unwrap();
    let (loop_start, loop_len, start_at) = (12_000u64, 24_000u64, 12_000u64);
    let (mut l, mut r) = (vec![0f32; 300], vec![0f32; 300]);
    let mut seen_passes = Vec::new();
    for block in 0..400u64 {
        t.process(&mut l, &mut r);
        // ブロックの頭の位置と周の数が、作ったフレームの数と合う (食い違った組を読まない)
        let position = controller.position();
        let total = start_at + block * 300;
        assert_eq!(position.pass, total / loop_len, "block={block}");
        assert_eq!(
            position.frame,
            loop_start + total % loop_len,
            "block={block}"
        );
        assert!((loop_start..loop_start + loop_len).contains(&position.frame));
        if seen_passes.last() != Some(&position.pass) {
            seen_passes.push(position.pass);
        }
    }
    assert_eq!(seen_passes, [0, 1, 2, 3, 4, 5]);

    // 鳴らし直すと、また 0 周目から
    controller
        .play(&PlayOptions {
            token: 2,
            loop_range: Some((0.25, 0.75)),
            ..play_from(0.25)
        })
        .unwrap();
    run(&mut t, 2_000, 500);
    assert_eq!(controller.position().pass, 0);
}

#[test]
fn 区間ループでまたいでいるノートは周の頭で鳴らし直す() {
    // 区間 (0.5〜1.0 秒) の前から後ろまで続くノート
    let s = song(vec![tone_track(vec![note(0, 96_000, 69, 96)])]);
    let (mut controller, mut t) = setup(&s);
    controller
        .play(&PlayOptions {
            loop_range: Some((0.5, 1.0)),
            ..play_from(0.5)
        })
        .unwrap();
    let (l, _) = run(&mut t, 72_000, 512);
    // どの周でも鳴っている。周の頭 (24000 ごと) は 0 から上がる
    for pass in 0..3 {
        let head = pass * 24_000;
        assert_eq!(l[head], 0.0, "pass={pass}");
        assert!(peak(&l[head + 1_000..head + 23_000]) > 0.15, "pass={pass}");
        let hz = estimate_hz(&l[head + 1_000..head + 23_000]);
        assert!((hz - 440.0).abs() < 5.0, "pass={pass}: {hz:.1}Hz");
    }
}

// ---- 録音前のカウント ----

#[test]
fn カウントのあいだは曲が進まずクリックだけが鳴る() {
    let (s, audio) = noise_song(5, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller
        .play(&PlayOptions {
            count_in: Some(CountIn {
                beats: 4,
                beat_sec: 0.5,
            }),
            ..play_from(0.25)
        })
        .unwrap();
    // カウントは 4 拍 = 96000 フレーム。ブロックの長さでは割り切れない
    let count = 4 * BEAT;
    let (mut l, mut r) = (vec![0f32; count + 6_000], vec![0f32; count + 6_000]);
    for (i, (bl, br)) in l.chunks_mut(441).zip(r.chunks_mut(441)).enumerate() {
        t.process(bl, br);
        let position = controller.position();
        assert!(position.playing);
        // 公開するのはブロックの頭の状態。このブロックは、カウントの i × 441 フレームめから作った
        let head = i * 441;
        if head < count {
            // カウントの最中: 位置は始める位置のまま。曲が始まるまでの残りは、ブロックごとに減る
            assert!(position.counting_in, "block={i}");
            assert_eq!(position.frame, 12_000, "block={i}");
            assert_eq!(
                position.count_in_remaining_frames,
                (count - head) as u64,
                "block={i}"
            );
            let sec = (count - head) as f64 / SR as f64;
            assert!((position.count_in_remaining_sec - sec).abs() < 1e-12);
        } else {
            // カウントが終わったあと: 残りは 0 で、位置は「始める位置 + 過ぎたぶん」
            assert!(!position.counting_in, "block={i}");
            assert_eq!(position.count_in_remaining_frames, 0, "block={i}");
            assert_eq!(position.count_in_remaining_sec, 0.0);
            assert_eq!(position.frame, 12_000 + (head - count) as u64, "block={i}");
        }
    }
    assert!(!controller.position().counting_in);

    // カウントのあいだは、クリックだけ (最初の 1 つだけ高い音)
    assert_eq!(l[..count], r[..count]);
    assert_clicks(
        &l[..count],
        &[
            (0, CLICK_ACCENT_HZ),
            (BEAT, CLICK_HZ),
            (2 * BEAT, CLICK_HZ),
            (3 * BEAT, CLICK_HZ),
        ],
    );
    // カウントが終わったフレームから、曲が始める位置から鳴る
    assert_eq!(l[count], 0.0);
    assert_eq!(
        l[count + FADE..],
        audio.left()[12_000 + FADE..12_000 + 6_000]
    );
    assert_eq!(
        r[count + FADE..],
        audio.right()[12_000 + FADE..12_000 + 6_000]
    );
}

#[test]
fn カウントの途中で止めると曲は始まらない() {
    let (s, _) = noise_song(5, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller
        .play(&PlayOptions {
            count_in: Some(CountIn {
                beats: 2,
                beat_sec: 0.5,
            }),
            ..play_from(0.0)
        })
        .unwrap();
    run(&mut t, 30_000, 500);
    controller.stop().unwrap();
    let (l, _) = run(&mut t, 48_000, 500);
    // 鳴っていたクリックの残り (50ms まで) のほかは無音
    assert_eq!(peak(&l[CLICK..]), 0.0);
    let position = controller.position();
    assert!(!position.playing && !position.counting_in);
    assert_eq!(position.frame, 0);
    // 止めたら、残りも 0 に戻る
    assert_eq!(position.count_in_remaining_frames, 0);
}

#[test]
fn カウントのあとの区間ループは頭から数える() {
    let (s, audio) = noise_song(5, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller
        .play(&PlayOptions {
            loop_range: Some((0.25, 0.75)),
            count_in: Some(CountIn {
                beats: 1,
                beat_sec: 0.1,
            }),
            ..play_from(0.25)
        })
        .unwrap();
    let (l, _) = run(&mut t, 4_800 + 50_000, 512);
    assert_looped(&l[4_800..], audio.left(), 12_000, 24_000, 0);
    assert_eq!(controller.position().pass, 2);
}

// ---- メトロノーム ----

#[test]
fn メトロノームは拍の位置で鳴り小節の一拍目だけ高い() {
    // 楽器もクリップも無い曲 (クリックだけが聞こえる)。120 BPM、4 拍子
    let (mut controller, mut t) = setup(&Song::default());
    controller
        .play(&PlayOptions {
            metronome: true,
            ..play_from(0.0)
        })
        .unwrap();
    let (l, r) = run(&mut t, 5 * BEAT, 441);
    assert_eq!(l, r);
    assert_clicks(
        &l,
        &[
            (0, CLICK_ACCENT_HZ),
            (BEAT, CLICK_HZ),
            (2 * BEAT, CLICK_HZ),
            (3 * BEAT, CLICK_HZ),
            (4 * BEAT, CLICK_ACCENT_HZ),
        ],
    );
    // 鳴り始めの山の高さは 0.3 に近く、50ms で終わる
    let head = peak(&l[..64]);
    assert!((0.27..=CLICK_LEVEL).contains(&head), "{head}");
    assert_eq!(peak(&l[CLICK..BEAT]), 0.0);
}

#[test]
fn メトロノームは一小節目の位置と拍子に従う() {
    // 90 BPM (1 拍 = 32000 フレーム)、1 小節目は 0.25 秒 (12000 フレーム)、3 拍子
    let (mut controller, mut t) = transport(SR).unwrap();
    let grid = Grid {
        bpm: 90.0,
        offset_sec: 0.25,
        beats_per_bar: 3,
    };
    let s = Song {
        bpm: 90.0,
        offset_sec: 0.25,
        ..Song::default()
    };
    controller.set_song(boxed(&s), &grid).unwrap();
    // 1 拍目の少し手前から
    controller
        .play(&PlayOptions {
            metronome: true,
            ..play_from(0.2)
        })
        .unwrap();
    let (l, _) = run(&mut t, 110_000, 512);
    let from = 9_600;
    assert_clicks(
        &l,
        &[
            (12_000 - from, CLICK_ACCENT_HZ),
            (44_000 - from, CLICK_HZ),
            (76_000 - from, CLICK_HZ),
            (108_000 - from, CLICK_ACCENT_HZ),
        ],
    );
}

#[test]
fn メトロノームは区間ループで頭へ戻っても拍の位置で鳴る() {
    let (mut controller, mut t) = setup(&Song::default());
    // 区間は 1.75〜2.75 秒 (84000〜132000 フレーム)。中の拍は 96000 (小節の頭) と 120000
    controller
        .play(&PlayOptions {
            metronome: true,
            loop_range: Some((1.75, 2.75)),
            ..play_from(1.75)
        })
        .unwrap();
    let loop_len = 48_000;
    let (l, _) = run(&mut t, 3 * loop_len, 441);
    let mut expected = Vec::new();
    for pass in 0..3 {
        expected.push((pass * loop_len + 12_000, CLICK_ACCENT_HZ));
        expected.push((pass * loop_len + 36_000, CLICK_HZ));
    }
    assert_clicks(&l, &expected);

    // 区間の頭が拍に乗っていれば、頭へ戻るたびにそこでも鳴る。
    // 再生中の鳴らし直しなので、前の音を下げる 4ms のあとに始まる
    controller
        .play(&PlayOptions {
            token: 2,
            metronome: true,
            loop_range: Some((2.0, 2.5)),
            ..play_from(2.0)
        })
        .unwrap();
    let (l, _) = run(&mut t, 3 * BEAT, 441);
    assert_clicks(
        &l,
        &[
            (FADE, CLICK_ACCENT_HZ),
            (FADE + BEAT, CLICK_ACCENT_HZ),
            (FADE + 2 * BEAT, CLICK_ACCENT_HZ),
        ],
    );
}

#[test]
fn メトロノームは再生中に入れたり切ったりできる() {
    let (mut controller, mut t) = setup(&Song::default());
    controller.play(&play_from(0.0)).unwrap();
    // 切ってある
    let (l, _) = run(&mut t, 2 * BEAT, 500);
    assert_eq!(peak(&l), 0.0);
    // 入れると、次の拍から鳴る
    controller.set_metronome(true).unwrap();
    let (l, _) = run(&mut t, 2 * BEAT, 500);
    assert_clicks(&l, &[(0, CLICK_HZ), (BEAT, CLICK_HZ)]);
    // 切ると、鳴らなくなる
    controller.set_metronome(false).unwrap();
    let (l, _) = run(&mut t, 2 * BEAT, 500);
    assert_eq!(peak(&l), 0.0);
    // 止めるとき (拍の位置でも) と、止まっているあいだは鳴らない
    controller.set_metronome(true).unwrap();
    controller.stop().unwrap();
    let (l, _) = run(&mut t, 2 * BEAT, 500);
    assert_eq!(peak(&l), 0.0);
}

#[test]
fn クリックにはトラックの音量もつなぎ目の上げ下げも掛からない() {
    // 音量を大きく下げたトラックと一緒に、拍の位置 (= 鳴らし始め) から再生する
    let (s, audio) = noise_song(5, 96_000);
    let mut s = s;
    s.tracks[0].gain_db = -60.0;
    let (mut controller, mut t) = setup(&s);
    controller
        .play(&PlayOptions {
            metronome: true,
            ..play_from(0.0)
        })
        .unwrap();
    let (l, _) = run(&mut t, 4_800, 256);
    // クリップは -60dB (0.0005 以下)。クリックは、鳴らし始めの上げ (4ms) の最中でも 0.3 近い
    assert!(peak(audio.left()) <= 0.5);
    let head = peak(&l[..64]);
    assert!((0.27..=0.31).contains(&head), "{head}");
}

// ---- engine の差し替え ----

#[test]
fn 再生中に曲を差し替えても位置が保たれる() {
    let (first, first_audio) = noise_song(1, 96_000);
    let (second, second_audio) = noise_song(2, 96_000);
    let (mut controller, mut t) = setup(&first);
    assert_eq!(controller.collect_garbage(), 0);
    controller.play(&play_from(0.0)).unwrap();
    let (l, _) = run(&mut t, 10_240, 256);
    assert_eq!(l[FADE..], first_audio.left()[FADE..10_240]);

    controller
        .set_song(boxed(&second), &Grid::default())
        .unwrap();
    let (l, _) = run(&mut t, 10_240, 256);
    // 前の曲を 4ms で下げ、同じ位置から新しい曲を 4ms で上げる
    for (i, v) in l.iter().enumerate().take(FADE) {
        let gain = (FADE - 1 - i) as f32 / FADE as f32;
        let expected = first_audio.left()[10_240 + i] * gain;
        assert!((v - expected).abs() < 1e-6, "i={i}");
    }
    for i in 0..FADE {
        let gain = i as f32 / FADE as f32;
        let expected = second_audio.left()[10_240 + FADE + i] * gain;
        assert!((l[FADE + i] - expected).abs() < 1e-6, "i={i}");
    }
    // そのあとは、新しい曲の続きが、ずれずに出る
    assert_eq!(
        l[2 * FADE..],
        second_audio.left()[10_240 + 2 * FADE..20_480]
    );
    let position = controller.position();
    assert!(position.playing);
    assert_eq!(position.frame, 20_480 - 256);

    // 古い engine は、音声スレッドの外へ送り返されている
    assert_eq!(controller.collect_garbage(), 1);
    assert_eq!(controller.collect_garbage(), 0);
}

#[test]
fn 止まっているあいだに差し替えた曲は次の再生で鳴る() {
    let (first, _) = noise_song(1, 96_000);
    let (second, second_audio) = noise_song(2, 96_000);
    let (mut controller, mut t) = setup(&first);
    run(&mut t, 512, 256);
    controller
        .set_song(boxed(&second), &Grid::default())
        .unwrap();
    controller.play(&play_from(0.5)).unwrap();
    let (l, _) = run(&mut t, 4_096, 256);
    assert_eq!(
        l[FADE..],
        second_audio.left()[24_000 + FADE..24_000 + 4_096]
    );
    assert_eq!(controller.collect_garbage(), 1);
}

#[test]
fn 続けて届いた差し替えと再生は順番どおりに行う() {
    // 再生中に「差し替え → 鳴らし直し → メトロノーム」を続けて積む (画面の鳴らし直しと同じ並び)
    let (first, _) = noise_song(1, 96_000);
    let (second, second_audio) = noise_song(2, 96_000);
    let (mut controller, mut t) = setup(&first);
    controller.play(&play_from(0.0)).unwrap();
    run(&mut t, 2_048, 256);

    controller
        .set_song(boxed(&second), &Grid::default())
        .unwrap();
    controller
        .play(&PlayOptions {
            token: 2,
            ..play_from(1.0)
        })
        .unwrap();
    controller.set_metronome(false).unwrap();
    let (l, _) = run(&mut t, 4_096, 256);
    // 前の曲を下げ (4ms)、新しい曲に替えて上げ始めたところで、また下げて (4ms)、新しい位置で鳴る
    assert_eq!(
        l[3 * FADE..],
        second_audio.left()[48_000 + FADE..48_000 + 4_096 - 2 * FADE]
    );
    assert_eq!(controller.position().token, 2);
    assert_eq!(controller.collect_garbage(), 1);
}

#[test]
fn 周波数の違うengineは受け取らない() {
    let (mut controller, _t) = transport(44_100).unwrap();
    let (s, _) = noise_song(1, 1_000);
    let result = controller.set_song(boxed(&s), &Grid::default());
    assert_eq!(
        result,
        Err(TransportError::SampleRate {
            engine: 48_000,
            output: 44_100
        })
    );
    let config = EngineConfig {
        sample_rate: 44_100,
        max_block: 256,
    };
    let matching = Box::new(Engine::new(&s, &config).unwrap());
    for bpm in [0.0, f64::NAN, 1e9] {
        let grid = Grid {
            bpm,
            ..Grid::default()
        };
        let engine = Box::new(Engine::new(&s, &config).unwrap());
        assert!(matches!(
            controller.set_song(engine, &grid),
            Err(TransportError::Invalid(_))
        ));
    }
    assert_eq!(controller.set_song(matching, &Grid::default()), Ok(()));
}

// ---- トラックを動かす ----

#[test]
fn 再生中にトラックの音量と鳴らすかを変えられる() {
    let constant = |frames: usize| Track {
        clips: vec![Clip {
            audio: stereo(SR, vec![1.0; frames], vec![1.0; frames]),
            start_sec: 0.0,
        }],
        ..Track::default()
    };
    let s = song(vec![constant(96_000), Track::default()]);
    let (mut controller, mut t) = setup(&s);
    controller.play(&play_from(0.0)).unwrap();
    let (l, _) = run(&mut t, 2_048, 256);
    assert!(l[FADE..].iter().all(|v| *v == 1.0));

    // 音量: 5ms (240 フレーム) で、段差なく移る
    controller.set_track(0, -20.0, 0.0, true).unwrap();
    let (l, _) = run(&mut t, 2_048, 256);
    assert!(l[..240]
        .windows(2)
        .all(|w| w[1] < w[0] && w[0] - w[1] < 0.004));
    assert!(l[240..].iter().all(|v| (*v - 0.1).abs() < 1e-6));

    // 鳴らさない: 5ms で下げて無音
    controller.set_track(0, -20.0, 0.0, false).unwrap();
    let (l, _) = run(&mut t, 2_048, 256);
    assert!(l[..239].iter().all(|v| *v > 0.0));
    assert!(l[239..].iter().all(|v| *v == 0.0));

    // 鳴らす: 音量も一緒に戻す
    controller.set_track(0, 0.0, 0.0, true).unwrap();
    // engine に無いトラックへの指示は無視される
    controller.set_track(9, -60.0, 1.0, false).unwrap();
    let (l, r) = run(&mut t, 2_048, 256);
    assert!(l[..240].windows(2).all(|w| w[1] > w[0]));
    assert!(l[240..].iter().all(|v| *v == 1.0));
    assert_eq!(l, r);
}

// ---- 鍵盤の試聴 ----

#[test]
fn 鍵盤の試聴は再生していなくても左右に同じ音で鳴る() {
    let (mut controller, mut t) = transport(SR).unwrap();
    controller.live_note_on(69, 96).unwrap();
    let (l, r) = run(&mut t, 9_600, 256);
    assert_eq!(l, r);
    assert!(!controller.position().playing);
    // 立ち上がりは 5ms (240 フレーム)。そのあとの山の高さは 0.25 (パンを通さない)
    assert_eq!(l[0], 0.0);
    assert!(peak(&l[..120]) < 0.14);
    let level = peak(&l[240..]);
    assert!((level - 0.25).abs() < 0.002, "山の高さ: {level}");
    let hz = estimate_hz(&l[240..]);
    assert!((hz - 440.0).abs() < 6.0, "A4 のはずが {hz:.1}Hz");

    // 離すと 50ms (2400 フレーム) で消える
    controller.live_note_off(69).unwrap();
    let (l, _) = run(&mut t, 9_600, 256);
    let half = peak(&l[1_150..1_250]);
    assert!((half - 0.125).abs() < 0.02, "消えていく途中: {half}");
    assert!(peak(&l[2_200..2_400]) > 0.0);
    assert!(l[2_400..].iter().all(|v| *v == 0.0));
}

#[test]
fn 鍵盤の試聴の大きさは強さで決まり同じ高さは鳴らし直す() {
    let (mut controller, mut t) = transport(SR).unwrap();
    controller.live_note_on(60, 127).unwrap();
    let (l, _) = run(&mut t, 4_800, 256);
    let level = peak(&l[240..]);
    assert!((level - 0.25 * 127.0 / 96.0).abs() < 0.003, "{level}");

    // 同じ高さをもう一度押す: 前の音は 50ms で消え、新しい音が 0 から立ち上がる
    controller.live_note_on(60, 48).unwrap();
    let (l, _) = run(&mut t, 9_600, 256);
    let level = peak(&l[2_400..]);
    assert!((level - 0.125).abs() < 0.002, "鳴らし直したあと: {level}");

    // 別の高さと重ねて鳴らし、すべて離す
    controller.live_note_on(64, 96).unwrap();
    controller.live_note_on(67, 96).unwrap();
    let (l, _) = run(&mut t, 4_800, 256);
    assert!(peak(&l[240..]) > 0.3);
    controller.live_all_off().unwrap();
    let (l, _) = run(&mut t, 4_800, 256);
    assert!(l[2_400..].iter().all(|v| *v == 0.0));
}

#[test]
fn 鍵盤の試聴は再生や停止に左右されない() {
    let (s, audio) = noise_song(1, 96_000);
    let (mut controller, mut t) = setup(&s);
    controller.live_note_on(69, 96).unwrap();
    controller.play(&play_from(0.0)).unwrap();
    let (l, _) = run(&mut t, 4_800, 256);
    // 曲の音を引くと、試聴の声だけが残る
    let live: Vec<f32> = l[FADE..]
        .iter()
        .zip(&audio.left()[FADE..4_800])
        .map(|(mixed, song)| mixed - song)
        .collect();
    assert!((peak(&live[240..]) - 0.25).abs() < 0.002);

    // 止めても、押しているあいだは鳴り続ける
    controller.stop().unwrap();
    let (l, _) = run(&mut t, 4_800, 256);
    assert!((peak(&l[FADE..]) - 0.25).abs() < 0.002);
    let hz = estimate_hz(&l[FADE..]);
    assert!((hz - 440.0).abs() < 12.0, "{hz:.1}Hz");
}

// ---- 位置の公開と、区切り方 ----

#[test]
fn 位置と一緒に公開する時刻は戻らない() {
    let (s, _) = noise_song(1, 96_000);
    let (mut controller, mut t) = setup(&s);
    let reader = controller.position_reader();
    controller.play(&play_from(0.0)).unwrap();
    let started = std::time::Instant::now();
    let (mut l, mut r) = (vec![0f32; 256], vec![0f32; 256]);
    let mut last = reader.read();
    for block in 0..50u64 {
        t.process(&mut l, &mut r);
        let position = reader.read();
        assert_eq!(position, controller.position());
        assert_eq!(position.frame, block * 256);
        assert!(position.at >= last.at);
        last = position;
    }
    // 時刻は、ブロックを作り始めたときのもの
    assert!(last.at >= started && last.at <= std::time::Instant::now());
}

#[test]
fn 位置は別のスレッドから読んでも食い違わない() {
    let (s, _) = noise_song(1, 96_000);
    let (mut controller, mut t) = setup(&s);
    // 区間ループ (1000 フレーム) を 100 フレームずつ作る: 位置 = 12000 + (作った数 % 1000)、
    // 周 = 作った数 / 1000。読んだ組がこの関係を外れたら、書きかけを読んでいる
    controller
        .play(&PlayOptions {
            token: 42,
            loop_range: Some((0.25, 0.25 + 1_000.0 / SR as f64)),
            ..play_from(0.25)
        })
        .unwrap();
    let reader = controller.position_reader();
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = Arc::clone(&done);
    let checker = std::thread::spawn(move || {
        let mut reads = 0u64;
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            let position = reader.read();
            if position.playing {
                assert_eq!(position.token, 42);
                assert_eq!((position.frame - 12_000) % 100, 0);
                assert!(position.frame < 13_000);
            } else {
                assert_eq!((position.token, position.frame, position.pass), (0, 0, 0));
            }
            reads += 1;
        }
        reads
    });
    let (mut l, mut r) = (vec![0f32; 100], vec![0f32; 100]);
    for block in 0..20_000u64 {
        t.process(&mut l, &mut r);
        let position = controller.position();
        assert_eq!(position.pass, block / 10);
        assert_eq!(position.frame, 12_000 + (block % 10) * 100);
    }
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(checker.join().unwrap() > 0);
}

#[test]
fn デバイスのバッファの長さを変えても同じ音になる() {
    // クリップ・ノート・区間ループ・メトロノーム・カウント・試聴を、まとめて鳴らす。
    // 指示は同じ位置 (4096 フレームごと) で出し、あいだのバッファの長さだけを変える
    let (noise_part, _) = noise_song(9, 96_000);
    let mut s = noise_part;
    s.tracks.push(Track {
        pan: 0.3,
        ..tone_track(vec![
            note(12_000, 9_000, 60, 100),
            note(15_000, 3_000, 64, 70),
            note(30_000, 6_000, 67, 120),
        ])
    });
    let other = song(vec![tone_track(vec![note(0, 96_000, 48, 96)])]);

    let play = |block: usize| {
        let (mut controller, mut t) = setup(&s);
        let mut out = (Vec::new(), Vec::new());
        let mut step = |t: &mut Transport| {
            let (l, r) = run(t, 4_096, block);
            out.0.extend(l);
            out.1.extend(r);
        };
        controller
            .play(&PlayOptions {
                token: 1,
                from_sec: 0.25,
                loop_range: Some((0.25, 0.8)),
                count_in: Some(CountIn {
                    beats: 2,
                    beat_sec: 0.11,
                }),
                metronome: true,
            })
            .unwrap();
        step(&mut t);
        controller.live_note_on(72, 100).unwrap();
        step(&mut t);
        step(&mut t);
        controller.set_track(1, -6.0, -0.5, true).unwrap();
        controller.live_note_off(72).unwrap();
        step(&mut t);
        controller.set_track(0, 0.0, 0.0, false).unwrap();
        for _ in 0..8 {
            step(&mut t);
        }
        controller
            .set_song(boxed(&other), &Grid::default())
            .unwrap();
        step(&mut t);
        step(&mut t);
        controller.stop().unwrap();
        step(&mut t);
        out
    };
    let (left, right) = play(4_096);
    assert!(peak(&left) > 0.3 && peak(&right) > 0.3);
    for block in [64, 128, 256, 441, 512, 1_024, 3_000] {
        let (l, r) = play(block);
        let diff = max_diff(&l, &left).max(max_diff(&r, &right));
        assert!(diff < 1e-6, "block={block}: 差 {diff}");
    }
}
