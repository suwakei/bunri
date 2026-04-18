"""メトロノーム / BPMユーティリティ"""
import numpy as np

from audio_utils import save_tmp


def _click_sound(sr, freq=1000, duration=0.02):
    """通常拍のクリック音を生成する。

    正弦波に指数減衰エンベロープを掛けた短いクリック音を生成する。

    Args:
        sr: サンプルレート（Hz）。正の整数。
        freq: クリック音の周波数（Hz）。デフォルト 1000 Hz。
        duration: クリック音の長さ（秒）。デフォルト 0.02 秒。

    Returns:
        numpy.ndarray: クリック音の波形配列（shape=(N,), float64）。
    """
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    click = np.sin(2 * np.pi * freq * t) * np.exp(-t * 150)
    return click


def _accent_click(sr, freq=1500, duration=0.025):
    """小節頭（アクセント付き）のクリック音を生成する。

    通常クリックより高い周波数と長めの持続時間を持ち、振幅を 1.3 倍に
    して小節の頭拍を強調する。

    Args:
        sr: サンプルレート（Hz）。正の整数。
        freq: アクセントクリック音の周波数（Hz）。デフォルト 1500 Hz。
        duration: クリック音の長さ（秒）。デフォルト 0.025 秒。

    Returns:
        numpy.ndarray: アクセントクリック音の波形配列（shape=(N,), float64）。
            振幅は通常クリックの 1.3 倍。
    """
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    click = np.sin(2 * np.pi * freq * t) * np.exp(-t * 120)
    return click * 1.3


def generate_metronome(bpm, beats_per_bar, bars, volume):
    """メトロノームのクリック音を生成して WAV ファイルに保存する。

    指定した BPM、拍子、小節数に従ってクリック音を並べた音声を生成する。
    小節の頭拍はアクセント付きクリック（高音・大音量）、それ以外は
    通常クリックを使用する。サンプルレートは固定 44100 Hz。

    Args:
        bpm: テンポ（BPM: beats per minute）。0 より大きい実数。
        beats_per_bar: 1 小節あたりの拍数。例: 4（4/4 拍子）、3（3/4 拍子）。
            int にキャストされる。
        bars: 生成する小節数。正の整数。int にキャストされる。
        volume: 出力音量。0.0（無音）〜 1.0（最大）の実数。

    Returns:
        str: 保存された一時 WAV ファイルのパス（44100 Hz モノラル）。

    Raises:
        ValueError: bpm が 0 以下の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    sr = 44100
    bpm = float(bpm)
    beats_per_bar = int(beats_per_bar)
    bars = int(bars)

    if bpm <= 0:
        raise ValueError("BPMは0より大きくしてください")

    beat_sec = 60.0 / bpm
    total_beats = beats_per_bar * bars
    total_samples = int(total_beats * beat_sec * sr)

    output = np.zeros(total_samples, dtype=np.float64)
    click = _click_sound(sr)
    accent = _accent_click(sr)

    for beat in range(total_beats):
        start = int(beat * beat_sec * sr)
        is_accent = (beat % beats_per_bar == 0)
        sound = accent if is_accent else click

        end = min(start + len(sound), total_samples)
        output[start:end] += sound[:end - start]

    output = output * volume
    output = np.clip(output, -1.0, 1.0).astype(np.float32)
    return save_tmp(output, sr, "metro")


def bpm_to_ms(bpm, note_value="quarter"):
    """BPM と音価から対応するミリ秒を計算する。

    指定した BPM における各音価（全音符・2 分音符・4 分音符・8 分音符・
    16 分音符）の長さをミリ秒で返す。ディレイタイムの計算などに利用できる。

    Args:
        bpm: テンポ（BPM: beats per minute）。0 より大きい実数。
        note_value: 音価を表す文字列。以下のいずれか。
            "whole"      — 全音符（4 拍分）
            "half"       — 2 分音符（2 拍分）
            "quarter"    — 4 分音符（1 拍分）【デフォルト】
            "eighth"     — 8 分音符（0.5 拍分）
            "sixteenth"  — 16 分音符（0.25 拍分）
            未知の値が渡された場合は "quarter" として扱われる。

    Returns:
        float: 指定音価の長さ（ミリ秒）。
    """
    beat_ms = 60000.0 / bpm
    multipliers = {
        "whole": 4.0,
        "half": 2.0,
        "quarter": 1.0,
        "eighth": 0.5,
        "sixteenth": 0.25,
    }
    m = multipliers.get(note_value, 1.0)
    return beat_ms * m
