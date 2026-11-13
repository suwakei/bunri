//! engine に曲を渡し、オフラインで描画した音を確かめる。
//!
//! 設計書 (`docs/instrument-engine-design.md`) が engine に求めること: ノートの位置・長さ・
//! 高さ・強さ、クリップの位置、トラックの音量・パン・ミュート・ソロ、マスター。

mod common;

use bunri_audio::{
    Clip, Engine, EngineConfig, EngineError, Instrument, RenderOptions, Song, Track, TICKS_PER_BEAT,
};
use common::*;
use std::f32::consts::FRAC_1_SQRT_2;
use std::path::PathBuf;
use std::sync::Arc;

/// 音声を 1 つ置いただけのトラック。
fn clip_track(audio: &Arc<bunri_audio::AudioData>, start_sec: f64) -> Track {
    Track {
        clips: vec![Clip {
            audio: Arc::clone(audio),
            start_sec,
        }],
        ..Track::default()
    }
}

/// 曲の頭から終わりまで (余韻は足さない)。
fn render_song(song: &Song) -> bunri_audio::AudioData {
    let options = RenderOptions {
        max_tail_secs: 0.0,
        ..RenderOptions::default()
    };
    bunri_audio::render(&mut engine(song), &options)
}

// ---- ノート ----

#[test]
fn 鳴り始めはブロックの途中でも指定した位置になる() {
    let dir = Workdir::new("onset");
    // ブロック (256) の境目に乗らない位置
    let start = 1000;
    let s = song(vec![sampler_track(
        &dir.a440(),
        vec![note(start, 4800, 69, 100)],
    )]);
    let out = render_frames(&s, 8000);
    for (name, ch) in [("左", out.left()), ("右", out.right())] {
        let first = first_sound(ch).expect("音が出ていない");
        assert!(
            first >= start as usize,
            "{name}: 指定より早く鳴った: {first}"
        );
        assert!(
            first < start as usize + 16,
            "{name}: 鳴り始めが遅すぎる: {first}"
        );
    }
}

#[test]
fn ノートの位置はテンポと一小節目の位置で決まる() {
    let dir = Workdir::new("tempo");
    // 90 BPM、1 小節目は 0.25 秒。2 拍目 = 0.25 + 60/90 秒 = 44000 フレーム
    let s = Song {
        bpm: 90.0,
        offset_sec: 0.25,
        tracks: vec![Track {
            instrument: Some(Instrument::Sampler { sfz: dir.a440() }),
            notes: vec![bunri_audio::Note {
                start: TICKS_PER_BEAT,
                length: TICKS_PER_BEAT / 4,
                pitch: 69,
                velocity: 100,
            }],
            ..Track::default()
        }],
        ..Song::default()
    };
    // 16 分音符 = 60/90/4 秒 = 8000 フレーム。曲の長さはノートの終わり
    let mut e = engine(&s);
    assert_eq!(e.length_frames(), 52_000);
    let out = bunri_audio::render(&mut e, &RenderOptions::default());
    let first = first_sound(out.left()).expect("音が出ていない");
    assert!((44_000..44_016).contains(&first), "鳴り始め: {first}");
}

#[test]
fn ノートは長さのぶんだけ鳴る() {
    let dir = Workdir::new("length");
    let s = song(vec![sampler_track(
        &dir.a440(),
        vec![note(2400, 12_000, 69, 100)],
    )]);
    let out = render_frames(&s, 24_000);
    let l = out.left();
    // 鳴っているあいだは、終わりの直前まで音量が落ちない
    assert!(rms(&l[3000..8000]) > 0.05);
    let last = rms(&l[13_400..14_400]);
    assert!(last > 0.05, "終わりの直前で鳴っていない: {last:.4}");
    // 終わり (14400) のあと、リリース (5 ミリ秒 = 240 フレーム) を過ぎれば静かになる
    let after = rms(&l[15_400..]);
    assert!(after < 1e-3, "終わったあとも鳴っている: {after:.4}");
}

#[test]
fn 音の高さはノート番号に従う() {
    let dir = Workdir::new("pitch");
    let s = song(vec![sampler_track(
        &dir.a440(),
        vec![note(0, 48_000, 69, 100), note(96_000, 48_000, 81, 100)],
    )]);
    let out = render_frames(&s, 144_000);
    let l = out.left();
    // 立ち上がりを避けて、鳴っている途中の 0.5 秒を測る
    let a4 = estimate_hz(&l[4800..4800 + 24_000]);
    let a5 = estimate_hz(&l[96_000 + 4800..96_000 + 4800 + 24_000]);
    assert!((a4 - 440.0).abs() < 3.0, "A4 のはずが {a4:.1}Hz");
    assert!((a5 - 880.0).abs() < 5.0, "A5 のはずが {a5:.1}Hz");
}

#[test]
fn 強く弾くほど大きく鳴る() {
    let dir = Workdir::new("velocity");
    let sfz = dir.a440();
    let measure = |velocity: u8| {
        let s = song(vec![sampler_track(
            &sfz,
            vec![note(0, 24_000, 69, velocity)],
        )]);
        rms(&render_frames(&s, 24_000).left()[4800..])
    };
    let (soft, loud) = (measure(32), measure(127));
    assert!(soft > 0.0);
    assert!(
        loud > soft * 2.0,
        "強さの差が出ていない: soft={soft:.4} loud={loud:.4}"
    );
}

#[test]
fn 同じ高さの連打で次の音が止まらない() {
    let dir = Workdir::new("repeat");
    // 1 つめが終わるフレームと 2 つめが始まるフレームが同じ
    let s = song(vec![sampler_track(
        &dir.a440(),
        vec![note(0, 12_000, 69, 100), note(12_000, 12_000, 69, 100)],
    )]);
    let out = render_frames(&s, 30_000);
    let second = rms(&out.left()[14_000..23_000]);
    assert!(second > 0.05, "2 つめの音が鳴っていない: {second:.4}");
    // 2 つめが終わった後は (リリースを過ぎれば) 静かになる
    assert!(rms(&out.left()[26_000..]) < 1e-3);
}

#[test]
fn 同じ高さのノートが重なっても長いほうは最後まで鳴る() {
    let dir = Workdir::new("overlap");
    // 短いノート (4800〜9600) が、長いノート (0〜24000) の中に収まっている
    let s = song(vec![sampler_track(
        &dir.a440(),
        vec![note(0, 24_000, 69, 100), note(4800, 4800, 69, 100)],
    )]);
    let out = render_frames(&s, 30_000);
    let l = out.left();
    let rest = rms(&l[12_000..23_000]);
    assert!(
        rest > 0.05,
        "短いノートが終わったところで、長いノートまで止まった: {rest:.4}"
    );
    assert!(rms(&l[26_000..]) < 1e-3);
}

#[test]
fn 鳴らないノートも曲の長さには数える() {
    let dir = Workdir::new("silent-notes");
    let s = song(vec![
        // 長さ 0 のノートは鳴らさず、長さにも数えない
        sampler_track(&dir.a440(), vec![note(0, 0, 69, 100)]),
        // 楽器が無いトラックのノートは鳴らないが、曲の長さには数える
        Track {
            notes: vec![note(0, 4800, 69, 100)],
            ..Track::default()
        },
    ]);
    let mut e = engine(&s);
    assert_eq!(e.length_frames(), 4800);
    let out = bunri_audio::render(&mut e, &RenderOptions::default());
    assert_eq!(out.frames(), 4800);
    assert!(rms(out.left()) < 1e-6 && rms(out.right()) < 1e-6);
}

#[test]
fn 書き出しではサンプルの頭より後ろも欠けない() {
    // sfizz はサンプルの頭 (既定 8192 フレーム) だけをメモリに置き、続きはディスクから読む。
    // オフライン描画は実時間よりずっと速いので、読み込みを待たないと続きが無音になる
    let dir = Workdir::new("stream");
    let sfz = dir.sine_sfz("long", 440.0, 20, "");
    let len = SR as u64 * 18;
    let s = song(vec![sampler_track(&sfz, vec![note(0, len, 69, 100)])]);
    let out = render_frames(&s, len);
    // 1 秒ごとに区切って、どの区間も鳴っていること
    for (i, chunk) in out.left()[SR as usize..].chunks(SR as usize).enumerate() {
        let level = rms(chunk);
        assert!(level > 0.05, "{} 秒目が鳴っていない: {level:.4}", i + 1);
    }
}

#[test]
fn トラックごとに別の楽器が鳴る() {
    let dir = Workdir::new("two-instruments");
    // 同じノート (A4) でも、楽器が違えば違う音が出る
    let s = song(vec![
        sampler_track(&dir.a440(), vec![note(0, 24_000, 69, 100)]),
        sampler_track(
            &dir.sine_sfz("e660", 660.0, 2, ""),
            vec![note(0, 24_000, 69, 100)],
        ),
    ]);
    let out = render_frames(&s, 24_000);
    let l = &out.left()[2400..21_600];
    assert!(level_at(l, 440.0) > 0.05, "1 本めの楽器が鳴っていない");
    assert!(level_at(l, 660.0) > 0.05, "2 本めの楽器が鳴っていない");
    assert!(level_at(l, 550.0) < 0.01);
}

#[test]
fn 楽器を読めないとどのトラックかが分かるエラーになる() {
    let dir = Workdir::new("missing-sfz");
    let s = song(vec![
        sampler_track(&dir.a440(), vec![]),
        sampler_track(&PathBuf::from("/nonexistent/bunri/none.sfz"), vec![]),
    ]);
    let config = EngineConfig::default();
    match Engine::new(&s, &config) {
        Err(EngineError::Instrument { track, .. }) => assert_eq!(track, 1),
        Err(other) => panic!("別のエラー: {other}"),
        Ok(_) => panic!("エラーになるはず"),
    }
}

// ---- クリップ ----

#[test]
fn クリップは置いた位置にそのまま入る() {
    let audio = stereo(SR, noise(1, 5000), noise(2, 5000));
    // 0.5 秒 = 24000 フレーム (ブロックの境目に乗らない)
    let s = song(vec![clip_track(&audio, 0.5)]);
    let mut e = engine(&s);
    assert_eq!(e.length_frames(), 29_000);
    let out = bunri_audio::render(&mut e, &RenderOptions::default());
    assert_eq!(out.frames(), 29_000);
    assert_eq!(out.sample_rate(), SR);
    // 音量 0dB・パン中央のステレオのクリップは、1 ビットも変わらない
    assert_eq!(&out.left()[24_000..], audio.left());
    assert_eq!(&out.right()[24_000..], audio.right());
    assert!(out.left()[..24_000].iter().all(|v| *v == 0.0));
    assert!(out.right()[..24_000].iter().all(|v| *v == 0.0));
}

#[test]
fn 周波数が違うクリップも高さと位置と長さが変わらない() {
    // 44.1kHz の 1kHz を 0.5 秒。そのまま 48kHz で鳴らすと、高さが上がり長さが縮む
    let audio = mono(44_100, sine(44_100, 1000.0, 0.5, 22_050));
    let s = song(vec![Track {
        pan: -1.0, // モノラルの素材を左端に振ると、左にそのままの大きさで出る
        ..clip_track(&audio, 0.25)
    }]);
    let out = render_song(&s);
    // 0.25 秒 + 0.5 秒
    assert_eq!(out.frames(), 12_000 + 24_000);
    let body = &out.left()[12_000..];
    let hz = estimate_hz(&body[1000..23_000]);
    assert!((hz - 1000.0).abs() < 3.0, "1kHz のはずが {hz:.1}Hz");
    // 48kHz で直接作った正弦波と重なる (位置がずれていれば合わない)。両端は変換で崩れるので除く
    let want = sine(SR, 1000.0, 0.5, 24_000);
    let diff = max_diff(&body[500..23_500], &want[500..23_500]);
    assert!(diff < 1e-4, "差が大きい: {diff:e}");
    assert!(out.left()[..11_000].iter().all(|v| v.abs() < 1e-6));
}

#[test]
fn 重なったクリップは足し合わされる() {
    let (a, b) = (
        stereo(SR, noise(3, 3000), noise(4, 3000)),
        mono(SR, noise(5, 3000)),
    );
    // 同じトラックにステレオとモノラル、別のトラックにもう 1 つ。1000 フレームずつずらす
    let s = song(vec![
        Track {
            clips: vec![
                Clip {
                    audio: Arc::clone(&a),
                    start_sec: 0.0,
                },
                Clip {
                    audio: Arc::clone(&b),
                    start_sec: 1000.0 / SR as f64,
                },
            ],
            ..Track::default()
        },
        clip_track(&a, 2000.0 / SR as f64),
    ]);
    let out = render_song(&s);
    assert_eq!(out.frames(), 5000);
    let at = |x: &[f32], i: i64| {
        if (0..3000).contains(&i) {
            x[i as usize]
        } else {
            0.0
        }
    };
    let want_left: Vec<f32> = (0..5000i64)
        .map(|i| at(a.left(), i) + FRAC_1_SQRT_2 * at(b.left(), i - 1000) + at(a.left(), i - 2000))
        .collect();
    let want_right: Vec<f32> = (0..5000i64)
        .map(|i| {
            at(a.right(), i) + FRAC_1_SQRT_2 * at(b.left(), i - 1000) + at(a.right(), i - 2000)
        })
        .collect();
    assert!(max_diff(out.left(), &want_left) < 1e-6);
    assert!(max_diff(out.right(), &want_right) < 1e-6);
}

#[test]
fn 負の位置に置いたクリップは頭が切れて0秒から鳴る() {
    let audio = stereo(SR, noise(6, 2000), noise(7, 2000));
    // -0.01 秒 = 480 フレーム前
    let s = song(vec![clip_track(&audio, -0.01)]);
    let out = render_song(&s);
    assert_eq!(out.frames(), 1520);
    assert_eq!(out.left(), &audio.left()[480..]);
}

// ---- 音量・パン・ミュート・ソロ・マスター ----

#[test]
fn トラックの音量はdbで効く() {
    let audio = stereo(SR, noise(8, 2000), noise(9, 2000));
    let s = song(vec![Track {
        gain_db: -20.0,
        ..clip_track(&audio, 0.0)
    }]);
    let out = render_song(&s);
    let want: Vec<f32> = audio.left().iter().map(|v| v * 0.1).collect();
    assert!(max_diff(out.left(), &want) < 1e-6);
    // 上げる方向にも効く (+6dB ≒ 1.995 倍)
    let s = song(vec![Track {
        gain_db: 6.0,
        ..clip_track(&audio, 0.0)
    }]);
    let ratio = rms(render_song(&s).right()) / rms(audio.right());
    assert!((ratio - 1.995).abs() < 0.001, "倍率 {ratio:.4}");
}

#[test]
fn ステレオのクリップを端に振ると片側に寄る() {
    let audio = stereo(SR, noise(10, 2000), noise(11, 2000));
    let both: Vec<f32> = audio
        .left()
        .iter()
        .zip(audio.right())
        .map(|(l, r)| l + r)
        .collect();
    let panned = |pan: f32| {
        render_song(&song(vec![Track {
            pan,
            ..clip_track(&audio, 0.0)
        }]))
    };
    let left = panned(-1.0);
    assert!(max_diff(left.left(), &both) < 1e-6);
    assert!(left.right().iter().all(|v| *v == 0.0));
    let right = panned(1.0);
    assert!(right.left().iter().all(|v| *v == 0.0));
    assert!(max_diff(right.right(), &both) < 1e-6);
    // 半分だけ右に振ると、左が小さくなり、右は元より大きくなる
    let half = panned(0.5);
    assert!(rms(half.left()) < rms(audio.left()) * 0.8);
    assert!(rms(half.right()) > rms(audio.right()) * 1.1);
}

#[test]
fn モノラルのクリップは中央で左右に同じ大きさで出る() {
    let audio = mono(SR, noise(12, 2000));
    let panned = |pan: f32| {
        render_song(&song(vec![Track {
            pan,
            ..clip_track(&audio, 0.0)
        }]))
    };
    // 中央: 左右とも 1/√2 倍 (パワーの合計が元と同じ)
    let center = panned(0.0);
    let want: Vec<f32> = audio.left().iter().map(|v| v * FRAC_1_SQRT_2).collect();
    assert!(max_diff(center.left(), &want) < 1e-6);
    assert!(max_diff(center.right(), &want) < 1e-6);
    // 右端: 右にそのままの大きさ、左は無音
    let right = panned(1.0);
    assert!(right.left().iter().all(|v| *v == 0.0));
    assert!(max_diff(right.right(), audio.left()) < 1e-6);
}

#[test]
fn 音量とパンはサンプラーの音にも効く() {
    let dir = Workdir::new("sampler-mix");
    let sfz = dir.a440();
    let with = |gain_db: f32, pan: f32| {
        let s = song(vec![Track {
            gain_db,
            pan,
            ..sampler_track(&sfz, vec![note(0, 12_000, 69, 100)])
        }]);
        render_frames(&s, 12_000)
    };
    let base = with(0.0, 0.0);
    assert!(rms(base.left()) > 0.05 && rms(base.right()) > 0.05);
    // -12dB ≒ 0.2512 倍
    let quiet = with(-12.0, 0.0);
    let ratio = rms(quiet.left()) / rms(base.left());
    assert!((ratio - 0.2512).abs() < 0.003, "倍率 {ratio:.4}");
    // 左端に振ると、右は無音になり、左は大きくなる
    let left = with(0.0, -1.0);
    assert!(rms(left.right()) < 1e-6);
    assert!(rms(left.left()) > rms(base.left()) * 1.5);
}

#[test]
fn ミュートしたトラックは鳴らない() {
    let dir = Workdir::new("mute");
    let audio = stereo(SR, noise(13, 12_000), noise(14, 12_000));
    let s = song(vec![
        Track {
            mute: true,
            ..sampler_track(&dir.a440(), vec![note(0, 12_000, 69, 100)])
        },
        clip_track(&audio, 0.0),
    ]);
    let out = render_song(&s);
    // 残るのはクリップだけ
    assert_eq!(out.left(), audio.left());
    assert_eq!(out.right(), audio.right());
}

#[test]
fn ソロのトラックが在ればソロだけが鳴る() {
    let dir = Workdir::new("solo");
    let (a, b) = (
        stereo(SR, noise(15, 12_000), noise(16, 12_000)),
        stereo(SR, noise(17, 12_000), noise(18, 12_000)),
    );
    let solo = |audio| Track {
        solo: true,
        ..clip_track(audio, 0.0)
    };
    let s = song(vec![
        sampler_track(&dir.a440(), vec![note(0, 12_000, 69, 100)]),
        solo(&a),
        clip_track(&b, 0.0),
    ]);
    let out = render_song(&s);
    assert_eq!(out.left(), a.left());

    // ソロでも、ミュートしていれば鳴らない (ミュートが強い)。ソロが 2 本なら両方が鳴る
    let s = song(vec![
        Track {
            mute: true,
            ..solo(&a)
        },
        solo(&b),
        clip_track(&a, 0.0),
    ]);
    assert_eq!(render_song(&s).left(), b.left());
}

#[test]
fn マスターの音量は全体に効く() {
    let dir = Workdir::new("master");
    let audio = stereo(SR, noise(19, 12_000), noise(20, 12_000));
    let tracks = vec![
        sampler_track(&dir.a440(), vec![note(0, 12_000, 69, 100)]),
        clip_track(&audio, 0.0),
    ];
    let base = render_song(&song(tracks.clone()));
    let quiet = render_song(&Song {
        master_gain_db: -20.0,
        ..song(tracks)
    });
    let want: Vec<f32> = base.left().iter().map(|v| v * 0.1).collect();
    assert!(max_diff(quiet.left(), &want) < 1e-5);
}

#[test]
fn トラックの音は足し合わされる() {
    let dir = Workdir::new("sum");
    let audio = stereo(SR, noise(21, 24_000), noise(22, 24_000));
    let notes = sampler_track(&dir.a440(), vec![note(2400, 12_000, 69, 100)]);
    let alone = render_frames(&song(vec![notes.clone()]), 24_000);
    let mixed = render_frames(&song(vec![notes, clip_track(&audio, 0.0)]), 24_000);
    // 両方を鳴らした音から、クリップを引くと、ノートだけの音になる
    let rest: Vec<f32> = mixed
        .left()
        .iter()
        .zip(audio.left())
        .map(|(m, c)| m - c)
        .collect();
    assert!(rms(alone.left()) > 0.02);
    let diff = max_diff(&rest, alone.left());
    assert!(diff < 1e-5, "差が大きい: {diff:e}");
}

// ---- engine の動き ----

#[test]
fn processに渡す長さを変えても同じ音になる() {
    let dir = Workdir::new("block-size");
    let audio = stereo(SR, noise(23, 20_000), noise(24, 20_000));
    let s = song(vec![
        sampler_track(&dir.a440(), vec![note(1000, 9600, 69, 100)]),
        clip_track(&audio, 0.1),
    ]);
    let whole = render_frames(&s, 24_000);

    // 再生では、音声デバイスが求める長さ (まちまち) で呼ばれる
    let mut e = engine(&s);
    e.set_offline(true);
    let (mut l, mut r) = (vec![0f32; 24_000], vec![0f32; 24_000]);
    let mut pos = 0;
    for len in [1, 7, 100, 64, 1000, 333, 5000].iter().cycle() {
        let len = (*len).min(24_000 - pos);
        if len == 0 {
            break;
        }
        e.process(&mut l[pos..pos + len], &mut r[pos..pos + len]);
        pos += len;
        assert_eq!(e.position(), pos as u64);
    }
    let diff = max_diff(&l, whole.left()).max(max_diff(&r, whole.right()));
    assert!(diff < 1e-4, "区切り方で音が変わった: {diff:e}");
    let first = first_sound(&l[..4800]).expect("ノートが鳴っていない");
    assert!((1000..1016).contains(&first), "鳴り始め: {first}");
}

#[test]
fn 途中から描画しても位置がずれない() {
    let audio = stereo(SR, noise(25, 30_000), noise(26, 30_000));
    let s = song(vec![clip_track(&audio, 0.1)]);
    let whole = render_song(&s);
    let part = bunri_audio::render(
        &mut engine(&s),
        &RenderOptions {
            start: 10_001,
            end: Some(20_003),
            ..RenderOptions::default()
        },
    );
    assert_eq!(part.frames(), 10_002);
    assert_eq!(part.left(), &whole.left()[10_001..20_003]);
    assert_eq!(part.right(), &whole.right()[10_001..20_003]);
}

#[test]
fn 途中から始めるとまたいでいるノートは鳴り直し終わったノートは鳴らない() {
    let dir = Workdir::new("seek");
    let s = song(vec![sampler_track(
        &dir.a440(),
        vec![
            // 始める位置 (24000) をまたぐ A4
            note(0, 36_000, 69, 100),
            // 始める位置より前に終わる A5
            note(0, 12_000, 81, 100),
            // 始める位置より後に始まる E5 (約 659Hz)
            note(48_000, 12_000, 76, 100),
        ],
    )]);
    let out = bunri_audio::render(
        &mut engine(&s),
        &RenderOptions {
            start: 24_000,
            end: Some(72_000),
            ..RenderOptions::default()
        },
    );
    let l = out.left();
    // またいでいるノートは、始めた位置からすぐ鳴り、元の終わり (36000 → 出力の 12000) で止まる
    let first = first_sound(l).expect("音が出ていない");
    assert!(first < 16, "鳴り始めが遅い: {first}");
    assert!(level_at(&l[1000..11_000], 440.0) > 0.05);
    assert!(rms(&l[13_000..23_000]) < 1e-3, "元の終わりで止まっていない");
    // 終わっていたノートは鳴らない
    assert!(level_at(&l[1000..11_000], 880.0) < 0.005);
    // 後のノートは、元の位置 (48000 → 出力の 24000) で鳴る
    let later = first_sound(&l[23_000..]).expect("後のノートが鳴っていない") + 23_000;
    assert!((24_000..24_016).contains(&later), "鳴り始め: {later}");
    assert!(level_at(&l[25_000..35_000], 659.26) > 0.05);
}

#[test]
fn 曲の終わりのあとの余韻も描画する() {
    let dir = Workdir::new("tail");
    // 離してから 0.5 秒かけて消える楽器
    let sfz = dir.sine_sfz("slow", 440.0, 4, "ampeg_release=0.5");
    let s = song(vec![sampler_track(&sfz, vec![note(0, 24_000, 69, 100)])]);
    let render_with = |max_tail_secs: f64| {
        bunri_audio::render(
            &mut engine(&s),
            &RenderOptions {
                max_tail_secs,
                ..RenderOptions::default()
            },
        )
    };

    // 余韻を足さなければ、曲の長さちょうど
    assert_eq!(render_with(0.0).frames(), 24_000);
    // 上限が短ければ、上限で切る (0.1 秒 = 4800 フレーム)
    assert_eq!(render_with(0.1).frames(), 28_800);

    // 上限が長ければ、音が消えるまで (約 0.5 秒) 続けて止まる
    let out = render_with(10.0);
    let tail = out.frames() - 24_000;
    assert!(
        (SR as usize * 3 / 10..SR as usize * 2).contains(&tail),
        "余韻の長さ: {tail} フレーム"
    );
    let l = out.left();
    assert!(
        rms(&l[24_000..28_800]) > 0.02,
        "離した直後の余韻が入っていない"
    );
    let last = rms(&l[l.len() - 480..]);
    assert!(last < 1e-3, "消える前に切れた: {last:.5}");
}

#[test]
fn 空の曲は長さ0になる() {
    let mut e = engine(&Song::default());
    assert_eq!(e.length_frames(), 0);
    assert!(!e.is_sounding());
    let out = bunri_audio::render(&mut e, &RenderOptions::default());
    assert_eq!(out.frames(), 0);
    // 曲が空でも、process は無音を作り続けられる
    let (mut l, mut r) = (vec![1f32; 1000], vec![1f32; 1000]);
    e.process(&mut l, &mut r);
    assert!(l.iter().chain(r.iter()).all(|v| *v == 0.0));
    assert_eq!(e.position(), 1000);
}
