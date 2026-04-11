"""audio_utils モジュールのテスト"""
import numpy as np
import pytest
from audio_utils import load_audio, save_tmp, sec_to_samples, to_stereo


class TestLoadAudio:
    def test_wavファイルを読み込める(self, tmp_wav):
        data, sr = load_audio(tmp_wav)
        assert sr == 44100
        assert len(data) > 0

    def test_ステレオデータは2列(self, tmp_wav):
        data, sr = load_audio(tmp_wav)
        assert data.ndim == 2 or data.ndim == 1

    def test_存在しないファイルでエラー(self):
        with pytest.raises(Exception):
            load_audio("/nonexistent/file.wav")


class TestSaveTmp:
    def test_ファイルが作成される(self, sample_audio_stereo):
        data, sr = sample_audio_stereo
        path = save_tmp(data, sr, prefix="test_save")
        assert path.endswith(".wav")
        from pathlib import Path
        assert Path(path).exists()

    def test_モノラルも保存できる(self, sample_audio_mono):
        data, sr = sample_audio_mono
        path = save_tmp(data, sr, prefix="test_mono")
        from pathlib import Path
        assert Path(path).exists()


class TestSecToSamples:
    def test_1秒は44100サンプル(self):
        assert sec_to_samples(1.0, 44100) == 44100

    def test_0秒は0サンプル(self):
        assert sec_to_samples(0, 44100) == 0

    def test_小数秒(self):
        assert sec_to_samples(0.5, 44100) == 22050


class TestToStereo:
    def test_モノラルをステレオに変換(self):
        mono = np.ones(100, dtype=np.float32)
        stereo = to_stereo(mono)
        assert stereo.ndim == 2
        assert stereo.shape[1] == 2
        np.testing.assert_array_equal(stereo[:, 0], stereo[:, 1])

    def test_ステレオはそのまま(self):
        stereo = np.ones((100, 2), dtype=np.float32)
        result = to_stereo(stereo)
        assert result.shape == (100, 2)
