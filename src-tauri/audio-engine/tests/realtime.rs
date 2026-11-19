//! 音声スレッドでの約束 (`docs/instrument-engine-design.md`「リアルタイム処理の約束ごと」) を確かめる。
//!
//! engine の `process`・`seek`・`is_sounding`・再生中にトラックを動かす口と、transport の
//! `process` (指示の受け取り・engine の差し替え・位置の公開を含む) が、メモリの確保と解放を
//! しないこと。確保の回数を数えるアロケータに差し替えて見る。数えられるのは Rust の側だけで、sfizz (C++) の中の確保は
//! 見えない (sfizz 自身が、リアルタイムのスレッドで確保しない作りになっている)。

mod common;

use bunri_audio::{transport, Clip, CountIn, DrumVoice, Grid, Instrument, PlayOptions, Track};
use common::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    /// 数えているあいだだけ `Some(回数)`
    static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) };
}

struct Counting;

fn count() {
    // スレッドの終わりぎわなど、スレッドごとの変数に触れないときは数えない
    let _ = ALLOCATIONS.try_with(|c| {
        if let Some(n) = c.get() {
            c.set(Some(n + 1));
        }
    });
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        count();
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// `f` のあいだに、このスレッドがメモリを確保・解放した回数。
fn allocations(f: impl FnOnce()) -> usize {
    ALLOCATIONS.with(|c| c.set(Some(0)));
    f();
    ALLOCATIONS.with(|c| c.take()).unwrap()
}

#[test]
fn 数え方が働いている() {
    assert!(allocations(|| drop(std::hint::black_box(vec![0u8; 64]))) >= 2);
    assert_eq!(allocations(|| ()), 0);
}

#[test]
fn 音を作るあいだはメモリを確保しない() {
    let dir = Workdir::new("realtime");
    let s = song(vec![
        sampler_track(
            &dir.a440(),
            vec![note(1000, 9600, 69, 100), note(4800, 9600, 76, 60)],
        ),
        // ドラムのトラック (ドラムの音と、ドラムの行でない高さの三角波。途中へ移ると頭を過ぎた打音は鳴らさない)
        Track {
            instrument: Some(Instrument::ToneDrums {
                kit: vec![
                    (36, DrumVoice::Kick),
                    (38, DrumVoice::Snare),
                    (42, DrumVoice::Hat),
                ],
            }),
            notes: vec![
                note(0, 1200, 36, 100),
                note(2400, 1200, 38, 90),
                note(5975, 1200, 42, 80),
                note(1000, 9600, 60, 100),
            ],
            ..Track::default()
        },
        // ステレオとモノラルのクリップ (モノラルは周波数の変換も通る)。鳴らす範囲とフェードも
        Track {
            clips: vec![
                Clip {
                    audio_start_sec: 0.01,
                    duration_sec: Some(0.1),
                    fade_in_sec: 0.02,
                    fade_out_sec: 0.03,
                    ..Clip::new(stereo(SR, noise(1, 10_000), noise(2, 10_000)), 0.05)
                },
                Clip::new(mono(44_100, noise(3, 10_000)), 0.1),
            ],
            gain_db: -3.0,
            pan: 0.3,
            ..Track::default()
        },
    ]);
    // 組み立てと、作業用のバッファの用意は、数える前に済ませる
    let mut e = engine(&s);
    let (mut l, mut r) = (vec![0f32; 2048], vec![0f32; 2048]);
    let mut loudest = 0f32;

    let n = allocations(|| {
        // 音声デバイスが求める長さはまちまち (engine の中のブロックより長いことも在る)
        for len in [64, 128, 2048, 1, 333, 1024, 2048, 2048, 2048, 2048, 2048] {
            e.process(&mut l[..len], &mut r[..len]);
            loudest = l[..len].iter().fold(loudest, |m, v| m.max(v.abs()));
        }
        // 途中へ移る (またいでいるノートを鳴らし直す) → 続きを作る
        e.seek(6000);
        let sounding_after_seek = e.is_sounding();
        e.process(&mut l, &mut r);
        std::hint::black_box(sounding_after_seek);
        e.seek(0);
        e.process(&mut l, &mut r);
    });
    assert!(loudest > 0.05, "音が出ていない (確かめになっていない)");
    assert_eq!(n, 0, "process / seek の中でメモリを確保・解放した");
}

#[test]
fn 再生中にトラックを動かしてもメモリを確保しない() {
    let dir = Workdir::new("realtime-live");
    let s = song(vec![
        sampler_track(&dir.a440(), vec![note(0, 48_000, 69, 100)]),
        // 仮の音 (三角波): 和音と、またいでいるノートの鳴らし直し
        tone_track(vec![
            note(0, 48_000, 60, 100),
            note(1000, 9600, 64, 80),
            note(1000, 9600, 67, 80),
        ]),
        Track {
            clips: vec![Clip::new(
                stereo(SR, noise(1, 40_000), noise(2, 40_000)),
                0.0,
            )],
            ..Track::default()
        },
    ]);
    let mut e = engine(&s);
    let (mut l, mut r) = (vec![0f32; 2048], vec![0f32; 2048]);
    let mut loudest = 0f32;

    let n = allocations(|| {
        e.process(&mut l, &mut r);
        // 音量とパン (移り変わりの途中で、もう一度変える)
        e.set_track_mix(2, -12.0, 0.5);
        e.process(&mut l[..100], &mut r[..100]);
        e.set_track_mix(2, 3.0, -1.0);
        // 鳴らさない → 鳴らす (またいでいるノートを鳴らし直す)
        for track in 0..3 {
            e.set_track_audible(track, false);
        }
        e.process(&mut l, &mut r);
        for track in 0..3 {
            e.set_track_audible(track, true);
        }
        e.process(&mut l, &mut r);
        loudest = l.iter().fold(loudest, |m, v| m.max(v.abs()));
        // 無い番号は無視する
        e.set_track_mix(9, 0.0, 0.0);
        e.set_track_audible(9, true);
        e.silence();
        e.process(&mut l, &mut r);
    });
    assert!(loudest > 0.05, "音が出ていない (確かめになっていない)");
    assert_eq!(n, 0, "トラックを動かす口の中でメモリを確保・解放した");
}

#[test]
fn 再生の状態を進めるあいだはメモリを確保しない() {
    let dir = Workdir::new("realtime-transport");
    let build = |seed: u32| {
        let s = song(vec![
            sampler_track(&dir.a440(), vec![note(0, 48_000, 69, 100)]),
            tone_track(vec![note(0, 48_000, 60, 100), note(12_000, 9600, 64, 80)]),
            Track {
                clips: vec![Clip::new(
                    stereo(SR, noise(seed, 60_000), noise(seed + 1, 60_000)),
                    0.0,
                )],
                ..Track::default()
            },
        ]);
        Box::new(engine(&s))
    };
    // 組み立てと、指示を積むところまでは、音声スレッドの外の仕事 (数える前に済ませる)。
    // 指示は、音声スレッドが 1 ブロックごとに受け取る
    let (mut controller, mut t) = transport(SR).unwrap();
    let (mut l, mut r) = (vec![0f32; 2048], vec![0f32; 2048]);
    let mut loudest = 0f32;
    let mut total = 0;

    // 鍵盤の試聴 (止まったまま) → 曲を渡す → カウント付き・区間ループ・メトロノームで再生
    controller.live_note_on(72, 100).unwrap();
    controller.live_drum(DrumVoice::Snare, 100).unwrap();
    controller.set_song(build(1), &Grid::default()).unwrap();
    controller
        .play(&PlayOptions {
            token: 1,
            from_sec: 0.2,
            loop_range: Some((0.2, 0.31)),
            count_in: Some(CountIn {
                beats: 2,
                beat_sec: 0.02,
            }),
            metronome: true,
        })
        .unwrap();
    total += allocations(|| {
        // 音声デバイスが求める長さはまちまち
        for len in [64, 128, 2048, 1, 333, 1024, 2048, 2048, 2048, 2048] {
            t.process(&mut l[..len], &mut r[..len]);
            loudest = l[..len].iter().fold(loudest, |m, v| m.max(v.abs()));
        }
    });
    assert!(controller.position().pass >= 1, "区間の頭へ戻っていない");

    // 再生中に: トラックを動かす → 曲を差し替える → 鳴らし直す → 試聴を離す → 止める
    controller.set_track(2, -6.0, 0.3, true).unwrap();
    controller.set_track(1, 0.0, 0.0, false).unwrap();
    controller.set_song(build(7), &Grid::default()).unwrap();
    controller.play(&PlayOptions::default()).unwrap();
    controller.set_metronome(false).unwrap();
    controller.live_note_off(72).unwrap();
    controller.live_all_off().unwrap();
    total += allocations(|| {
        for len in [256, 2048, 100, 2048] {
            t.process(&mut l[..len], &mut r[..len]);
        }
    });
    controller.stop().unwrap();
    total += allocations(|| {
        t.process(&mut l, &mut r);
        t.process(&mut l, &mut r);
    });

    assert!(loudest > 0.05, "音が出ていない (確かめになっていない)");
    assert!(!controller.position().playing);
    assert_eq!(
        total, 0,
        "transport の process の中でメモリを確保・解放した"
    );
    // 差し替えで外した engine は、音声スレッドでは捨てずに送り返してある
    assert_eq!(controller.collect_garbage(), 1);
}

#[test]
fn 試聴用サンプラーの差し替えと演奏でメモリを確保しない() {
    let dir = Workdir::new("realtime-live-sampler");
    let path = dir.a440();
    let make = || {
        let mut sampler = bunri_audio::Sampler::new(SR as f32, 2048);
        sampler.load_file(&path).unwrap();
        Box::new(sampler)
    };
    let (mut controller, mut transport) = transport(SR).unwrap();
    let (mut l, mut r) = ([0.0; 256], [0.0; 256]);
    controller.set_live_sampler(Some(make())).unwrap();
    controller.live_note_on(69, 127).unwrap();
    let mut peak = 0.0f32;
    assert_eq!(
        allocations(|| {
            for _ in 0..8 {
                transport.process(&mut l, &mut r);
                peak = l.iter().fold(peak, |m, v| m.max(v.abs()));
            }
        }),
        0
    );
    assert!(peak > 0.01, "音源の試聴が鳴っていない");
    controller.set_live_sampler(Some(make())).unwrap();
    controller.live_note_on(69, 100).unwrap();
    controller.live_note_off(69).unwrap();
    controller.live_all_off().unwrap();
    assert_eq!(allocations(|| transport.process(&mut l, &mut r)), 0);
    assert_eq!(
        controller.collect_garbage(),
        1,
        "外したサンプラーが音声スレッドから戻っていない"
    );
    controller.set_live_sampler(None).unwrap();
    assert_eq!(allocations(|| transport.process(&mut l, &mut r)), 0);
    assert_eq!(controller.collect_garbage(), 1);
}
