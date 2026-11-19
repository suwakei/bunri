//! engine の、ドラムのトラックとクリップの鳴らす範囲・フェード・小数のステップ (main の PR #78 で画面に入ったもの)。
//!
//! 画面 (Web Audio) との突き合わせは `tests/webaudio_parity.rs`。ここでは engine の決まりを確かめる:
//! ドラムの高さはドラムの音・ほかの高さは三角波、途中から鳴らすときドラムは頭を過ぎたら鳴らさない、
//! 小数のステップの位置、周波数を変換したクリップの範囲。

mod common;

use bunri_audio::{Clip, DrumSynth, DrumVoice, Instrument, Note, RenderOptions, Song, Track};
use common::*;
use std::f32::consts::FRAC_1_SQRT_2;

const KIT: [(u8, DrumVoice); 2] = [(36, DrumVoice::Kick), (42, DrumVoice::Hat)];

fn drum_track(notes: Vec<Note>) -> Track {
    Track {
        instrument: Some(Instrument::ToneDrums { kit: KIT.to_vec() }),
        notes,
        ..Track::default()
    }
}

/// DrumSynth だけで、`at` フレームに 1 回鳴らした音 (モノラル)。
fn drum_alone(voice: DrumVoice, velocity: u8, at: usize, frames: usize) -> Vec<f32> {
    let mut synth = DrumSynth::new(SR, 4);
    let mut out = vec![0f32; frames];
    synth.trigger(at, voice, velocity);
    synth.render_add(&mut out);
    out
}

/// `from` フレームから `frames` フレームを描く。
fn render_from(song: &Song, from: u64, frames: u64) -> bunri_audio::AudioData {
    let options = RenderOptions {
        start: from,
        end: Some(from + frames),
        ..RenderOptions::default()
    };
    bunri_audio::render(&mut engine(song), &options)
}

#[test]
fn ドラムの高さはドラムの音で鳴らしノートの長さを待たない() {
    // キックを 1 ステップ (6000 フレーム) だけ。音はノートの終わりを過ぎても 0.29 秒鳴る
    let s = song(vec![drum_track(vec![note(1000, 6000, 36, 96)])]);
    let out = render_frames(&s, 20_000);
    let expected = drum_alone(DrumVoice::Kick, 96, 1000, 20_000);
    // パンが中央のモノラルの素材は、左右とも 0.707 倍
    for (i, (l, e)) in out.left().iter().zip(&expected).enumerate() {
        assert!(
            (l - e * FRAC_1_SQRT_2).abs() < 1e-6,
            "{i}: {l} != {}",
            e * FRAC_1_SQRT_2
        );
    }
    assert!(
        peak(&out.left()[7000..14_000]) > 0.001,
        "ノートの終わりのあとも鳴る"
    );
}

#[test]
fn ドラムのトラックでもドラムの行でない高さは三角波() {
    let s = song(vec![drum_track(vec![note(0, 24_000, 69, 96)])]);
    let tone = song(vec![tone_track(vec![note(0, 24_000, 69, 96)])]);
    let a = render_frames(&s, 30_000);
    let b = render_frames(&tone, 30_000);
    assert_eq!(a.left(), b.left());
}

#[test]
fn 小数のステップのドラムはその位置で鳴る() {
    // 120 BPM・48kHz で 1 ティック = 25 フレーム。8 分の三連 (4/3 ステップ = 320 ティック) は 8000 フレーム、
    // 32 分 (0.5 ステップ = 120 ティック) は 3000 フレーム、1/60 ステップ (4 ティック) は 100 フレーム
    for (ticks, frame) in [(320u64, 8000usize), (120, 3000), (4, 100)] {
        let s = song(vec![drum_track(vec![Note {
            start: ticks,
            length: 120,
            pitch: 42,
            velocity: 96,
        }])]);
        let out = render_frames(&s, 12_000);
        let expected = drum_alone(DrumVoice::Hat, 96, frame, 12_000);
        assert!(
            max_diff(
                out.left(),
                &expected
                    .iter()
                    .map(|v| v * FRAC_1_SQRT_2)
                    .collect::<Vec<_>>()
            ) < 1e-6,
            "ticks={ticks}"
        );
        assert_eq!(
            first_sound(out.left()),
            first_sound(&expected),
            "ticks={ticks}"
        );
    }
}

#[test]
fn 途中から鳴らすときドラムは頭を過ぎていたら鳴らさない() {
    // キック (ドラム) と A4 (三角波) が、どちらも 0 フレームから 2 秒
    let s = song(vec![drum_track(vec![
        note(0, 96_000, 36, 96),
        note(0, 96_000, 69, 96),
    ])]);
    let kick_only = song(vec![drum_track(vec![note(0, 96_000, 36, 96)])]);
    // 0.1 秒の位置から: キックは鳴らさない (三角波だけが鳴り直す)
    assert_eq!(peak(render_from(&kick_only, 4800, 4800).left()), 0.0);
    assert!(peak(render_from(&s, 4800, 4800).left()) > 0.1);
    // 頭から 3ms (5ms の幅の中) の位置からは、キックをその位置から鳴らす (丸めでわずかに後ろへずれても落とさない)
    let out = render_from(&kick_only, 144, 4800);
    let expected = drum_alone(DrumVoice::Kick, 96, 0, 4800);
    assert!(
        max_diff(
            out.left(),
            &expected
                .iter()
                .map(|v| v * FRAC_1_SQRT_2)
                .collect::<Vec<_>>()
        ) < 1e-6
    );
    // ちょうど頭からなら、ふつうに鳴る
    assert!(peak(render_from(&kick_only, 0, 4800).left()) > 0.3);
}

#[test]
fn 周波数を変換するクリップも鳴らす範囲とフェードを持つ() {
    // 44.1kHz の 1 秒の音声の、0.5 秒目から 0.25 秒ぶんを、0.1 秒に置く (engine は 48kHz)
    let audio = mono(44_100, vec![0.5; 44_100]);
    let clip = Clip {
        audio_start_sec: 0.5,
        duration_sec: Some(0.25),
        fade_in_sec: 0.05,
        fade_out_sec: 0.1,
        ..Clip::new(audio, 0.1)
    };
    let s = song(vec![Track {
        clips: vec![clip],
        ..Track::default()
    }]);
    let e = engine(&s);
    // 終わりは 0.1 + 0.25 秒 = 16800 フレーム
    assert_eq!(e.length_frames(), 16_800);
    let out = render_frames(&s, 20_000);
    let l = out.left();
    let level = 0.5 * FRAC_1_SQRT_2;
    assert_eq!(peak(&l[..4800]), 0.0);
    // フェードインの真ん中 (0.025 秒) で半分、フェードの外はそのまま、フェードアウトの真ん中で半分
    assert!(
        (l[4800 + 1200] - level * 0.5).abs() < 1e-3,
        "{}",
        l[4800 + 1200]
    );
    assert!((l[4800 + 6000] - level).abs() < 1e-3);
    assert!((l[4800 + 12_000 - 2400] - level * 0.5).abs() < 1e-3);
    assert_eq!(peak(&l[16_800..]), 0.0);
}

#[test]
fn 曲の値が正しくなければ断る() {
    let audio = mono(SR, vec![0.5; 100]);
    for bad in [
        Clip {
            fade_in_sec: -1.0,
            ..Clip::new(audio.clone(), 0.0)
        },
        Clip {
            audio_start_sec: f64::NAN,
            ..Clip::new(audio.clone(), 0.0)
        },
        Clip {
            duration_sec: Some(-0.5),
            ..Clip::new(audio.clone(), 0.0)
        },
    ] {
        let s = song(vec![Track {
            clips: vec![bad],
            ..Track::default()
        }]);
        assert!(bunri_audio::Engine::new(&s, &bunri_audio::EngineConfig::default()).is_err());
    }
}
