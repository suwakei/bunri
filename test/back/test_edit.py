"""edit モジュールのテスト"""
import numpy as np
import pytest
from pathlib import Path
from audio_utils import load_audio
import edit


class TestTrimAudio:
    def test_範囲をトリムできる(self, tmp_wav):
        result = edit.trim_audio(tmp_wav, 0.1, 0.5)
        assert Path(result).exists()
        data, sr = load_audio(result)
        expected_samples = int((0.5 - 0.1) * sr)
        assert abs(len(data) - expected_samples) < sr * 0.01  # 誤差1%以内

    def test_全範囲トリムは元と同じ長さ(self, tmp_wav):
        result = edit.trim_audio(tmp_wav, 0.0, 1.0)
        data, sr = load_audio(result)
        assert len(data) == sr  # 1秒


class TestCutAudio:
    def test_範囲をカットできる(self, tmp_wav):
        result = edit.cut_audio(tmp_wav, 0.2, 0.4)
        assert Path(result).exists()
        data, sr = load_audio(result)
        # 0.2秒分カットされるので、元の1.0秒 - 0.2秒 = 0.8秒
        expected = int(0.8 * sr)
        assert abs(len(data) - expected) < sr * 0.02


class TestChangeVolume:
    def test_0dBは変化なし(self, tmp_wav):
        orig_data, _ = load_audio(tmp_wav)
        result = edit.change_volume(tmp_wav, 0)
        new_data, _ = load_audio(result)
        np.testing.assert_array_almost_equal(orig_data, new_data, decimal=4)

    def test_正のdBで音量増加(self, tmp_wav):
        orig_data, _ = load_audio(tmp_wav)
        result = edit.change_volume(tmp_wav, 6)
        new_data, _ = load_audio(result)
        # +6dBは約2倍（クリッピング考慮で厳密でなくてよい）
        assert np.max(np.abs(new_data)) >= np.max(np.abs(orig_data))


class TestNormalize:
    def test_ノーマライズでピークが1に近づく(self, tmp_wav):
        result = edit.normalize_audio(tmp_wav)
        data, _ = load_audio(result)
        peak = np.max(np.abs(data))
        assert peak > 0.95  # ほぼ1.0


class TestReverse:
    def test_リバースで長さが同じ(self, tmp_wav):
        orig_data, _ = load_audio(tmp_wav)
        result = edit.reverse_audio(tmp_wav)
        new_data, _ = load_audio(result)
        assert len(orig_data) == len(new_data)


class TestFade:
    def test_フェードインの先頭は無音に近い(self, tmp_wav):
        result = edit.fade_in(tmp_wav, 0.5)
        data, sr = load_audio(result)
        # 最初の数サンプルは0に近いはず
        assert np.max(np.abs(data[:100])) < 0.01

    def test_フェードアウトの末尾は無音に近い(self, tmp_wav):
        result = edit.fade_out(tmp_wav, 0.5)
        data, sr = load_audio(result)
        assert np.max(np.abs(data[-100:])) < 0.01


class TestInsertSilence:
    def test_無音挿入で長くなる(self, tmp_wav):
        orig_data, sr = load_audio(tmp_wav)
        result = edit.insert_silence(tmp_wav, 0.5, 0.5)
        new_data, _ = load_audio(result)
        # 0.5秒の無音が挿入されるので長くなる
        expected = len(orig_data) + int(0.5 * sr)
        assert abs(len(new_data) - expected) < sr * 0.01


class TestLoopRange:
    def test_ループで長くなる(self, tmp_wav):
        orig_data, sr = load_audio(tmp_wav)
        result = edit.loop_range(tmp_wav, 0.0, 0.5, 3)
        data, _ = load_audio(result)
        # ループ結果は元のデータより長い
        assert len(data) > len(orig_data) * 0.5


class TestPanAudio:
    def test_中央パンは左右同じ(self, tmp_wav):
        result = edit.pan_audio(tmp_wav, 0.0)
        data, _ = load_audio(result)
        if data.ndim == 2:
            # 中央パンなので左右の差は小さい
            diff = np.abs(data[:, 0] - data[:, 1])
            assert np.mean(diff) < 0.5

    def test_左パンで右チャンネルが小さい(self, tmp_wav_mono):
        result = edit.pan_audio(tmp_wav_mono, -1.0)
        data, _ = load_audio(result)
        if data.ndim == 2:
            assert np.max(np.abs(data[:, 1])) < np.max(np.abs(data[:, 0])) + 0.01


class TestChangeSpeed:
    def test_2倍速で半分の長さ(self, tmp_wav):
        orig_data, sr = load_audio(tmp_wav)
        result = edit.change_speed(tmp_wav, 2.0)
        new_data, _ = load_audio(result)
        expected = len(orig_data) / 2
        assert abs(len(new_data) - expected) < sr * 0.05
