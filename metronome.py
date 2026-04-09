"""メトロノーム / BPMユーティリティ"""
import numpy as np

from audio_utils import save_tmp


def _click_sound(sr, freq=1000, duration=0.02):
    """クリック音を生成"""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    click = np.sin(2 * np.pi * freq * t) * np.exp(-t * 150)
    return click


def _accent_click(sr, freq=1500, duration=0.025):
    """アクセント付きクリック音（小節頭）"""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    click = np.sin(2 * np.pi * freq * t) * np.exp(-t * 120)
    return click * 1.3


def generate_metronome(bpm, beats_per_bar, bars, volume):
    """
    メトロノームのクリック音を生成。

    bpm: テンポ
    beats_per_bar: 拍子（1小節の拍数）
    bars: 小節数
    volume: 音量 (0.0~1.0)
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
    """BPMと音価からミリ秒を計算"""
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
