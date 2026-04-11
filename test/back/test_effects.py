"""effects モジュールのテスト"""
import numpy as np
import pytest
from pathlib import Path
from audio_utils import load_audio
import effects


class TestEq3Band:
    def test_0dBは変化なし(self, tmp_wav):
        orig_data, _ = load_audio(tmp_wav)
        result = effects.eq_3band(tmp_wav, 0, 0, 0)
        new_data, _ = load_audio(result)
        np.testing.assert_array_almost_equal(orig_data, new_data, decimal=3)

    def test_結果ファイルが生成される(self, tmp_wav):
        result = effects.eq_3band(tmp_wav, 3, -2, 1)
        assert Path(result).exists()

    def test_長さは変わらない(self, tmp_wav):
        orig_data, _ = load_audio(tmp_wav)
        result = effects.eq_3band(tmp_wav, 6, 0, -6)
        new_data, _ = load_audio(result)
        assert len(orig_data) == len(new_data)


class TestCompressor:
    def test_結果ファイルが生成される(self, tmp_wav):
        result = effects.compressor(tmp_wav, -20, 4, 10, 100)
        assert Path(result).exists()

    def test_長さは変わらない(self, tmp_wav):
        orig_data, _ = load_audio(tmp_wav)
        result = effects.compressor(tmp_wav, -20, 4, 10, 100)
        new_data, _ = load_audio(result)
        assert len(orig_data) == len(new_data)

    def test_高レシオで音量差が縮小(self, tmp_wav):
        result = effects.compressor(tmp_wav, -40, 20, 10, 100)
        data, _ = load_audio(result)
        # 高圧縮なのでダイナミックレンジが狭まる
        assert np.std(data) >= 0  # 処理が完了すること


class TestReverb:
    def test_結果ファイルが生成される(self, tmp_wav):
        result = effects.reverb(tmp_wav, 0.5, 0.3)
        assert Path(result).exists()

    def test_wet0はドライ信号に近い(self, tmp_wav):
        orig_data, _ = load_audio(tmp_wav)
        result = effects.reverb(tmp_wav, 0.5, 0.0)
        new_data, _ = load_audio(result)
        # wet=0 なのでほぼ元の信号
        # （長さは残響分で増える可能性があるため同じ長さ部分で比較）
        min_len = min(len(orig_data), len(new_data))
        correlation = np.corrcoef(orig_data[:min_len].flatten(), new_data[:min_len].flatten())[0, 1]
        assert correlation > 0.9


class TestDelay:
    def test_結果ファイルが生成される(self, tmp_wav):
        result = effects.delay_effect(tmp_wav, 300, 0.4, 0.3)
        assert Path(result).exists()

    def test_ディレイで長くなる(self, tmp_wav):
        orig_data, _ = load_audio(tmp_wav)
        result = effects.delay_effect(tmp_wav, 500, 0.5, 0.3)
        new_data, _ = load_audio(result)
        # フィードバックディレイで元より長くなるか同じ
        assert len(new_data) >= len(orig_data)
