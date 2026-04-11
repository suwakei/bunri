"""pitch_time モジュールのテスト"""
import numpy as np
import pytest
from pathlib import Path
from audio_utils import load_audio
import pitch_time


class TestPitchShift:
    def test_0半音は変化なし(self, tmp_wav):
        orig_data, sr = load_audio(tmp_wav)
        result = pitch_time.pitch_shift(tmp_wav, 0)
        new_data, _ = load_audio(result)
        # 0半音シフトなので長さはほぼ同じ
        assert abs(len(new_data) - len(orig_data)) < sr * 0.1

    def test_結果ファイルが生成される(self, tmp_wav):
        result = pitch_time.pitch_shift(tmp_wav, 3)
        assert Path(result).exists()

    def test_負の半音も動作する(self, tmp_wav):
        result = pitch_time.pitch_shift(tmp_wav, -5)
        assert Path(result).exists()
        data, _ = load_audio(result)
        assert len(data) > 0


class TestTimeStretch:
    def test_rate1は変化なし(self, tmp_wav):
        orig_data, sr = load_audio(tmp_wav)
        result = pitch_time.time_stretch(tmp_wav, 1.0)
        new_data, _ = load_audio(result)
        assert abs(len(new_data) - len(orig_data)) < sr * 0.1

    def test_rate2で半分の長さ(self, tmp_wav):
        orig_data, sr = load_audio(tmp_wav)
        result = pitch_time.time_stretch(tmp_wav, 2.0)
        new_data, _ = load_audio(result)
        expected = len(orig_data) / 2
        assert abs(len(new_data) - expected) < sr * 0.2

    def test_rate05で倍の長さ(self, tmp_wav):
        orig_data, sr = load_audio(tmp_wav)
        result = pitch_time.time_stretch(tmp_wav, 0.5)
        new_data, _ = load_audio(result)
        expected = len(orig_data) * 2
        assert abs(len(new_data) - expected) < sr * 0.3
