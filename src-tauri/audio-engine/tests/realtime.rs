//! 音声スレッドでの約束 (`docs/instrument-engine-design.md`「リアルタイム処理の約束ごと」) を確かめる。
//!
//! `process`・`seek`・`is_sounding` が、メモリの確保と解放をしないこと。確保の回数を数える
//! アロケータに差し替えて見る。数えられるのは Rust の側だけで、sfizz (C++) の中の確保は
//! 見えない (sfizz 自身が、リアルタイムのスレッドで確保しない作りになっている)。

mod common;

use bunri_audio::{Clip, Track};
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
        // ステレオとモノラルのクリップ (モノラルは周波数の変換も通る)
        Track {
            clips: vec![
                Clip {
                    audio: stereo(SR, noise(1, 10_000), noise(2, 10_000)),
                    start_sec: 0.05,
                },
                Clip {
                    audio: mono(44_100, noise(3, 10_000)),
                    start_sec: 0.1,
                },
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
