"""metronome モジュールのテスト"""
import pytest
from pathlib import Path
from audio_utils import load_audio


class TestGenerateMetronome:
    def test_メトロノームを生成(self):
        from metronome import generate_metronome
        result = generate_metronome(120, 4, 2, 0.7)
        assert Path(result).exists()
        data, sr = load_audio(result)
        assert sr == 44100
        # 120BPM, 4拍子, 2小節 → 4秒
        expected_duration = 4.0
        actual_duration = len(data) / sr
        assert abs(actual_duration - expected_duration) < 0.1

    def test_異なるBPMで生成(self):
        from metronome import generate_metronome
        result = generate_metronome(60, 4, 1, 0.5)
        data, sr = load_audio(result)
        # 60BPM, 4拍子, 1小節 → 4秒
        assert abs(len(data) / sr - 4.0) < 0.1

    def test_3拍子(self):
        from metronome import generate_metronome
        result = generate_metronome(120, 3, 2, 0.5)
        data, sr = load_audio(result)
        # 120BPM, 3拍子, 2小節 → 3秒
        assert abs(len(data) / sr - 3.0) < 0.1


class TestBpmToMs:
    def test_120BPMの4分音符は500ms(self):
        from metronome import bpm_to_ms
        assert bpm_to_ms(120) == pytest.approx(500.0)

    def test_60BPMは1000ms(self):
        from metronome import bpm_to_ms
        assert bpm_to_ms(60) == pytest.approx(1000.0)
