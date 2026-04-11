"""wav_optimize モジュールのテスト"""
import numpy as np
import pytest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture
def wav_48k_32bit(tmp_path):
    """48kHz / 32bit float のテスト用WAV（動画由来を模擬）"""
    import soundfile as sf
    sr = 48000
    duration = 2.0
    t = np.linspace(0, duration, int(sr * duration), dtype=np.float64)
    # 複数の周波数を含む音声（倍音構造）
    data = 0.3 * np.sin(2 * np.pi * 440 * t) + 0.15 * np.sin(2 * np.pi * 880 * t)
    stereo = np.column_stack([data, data * 0.8])
    path = tmp_path / "test_48k_32bit.wav"
    sf.write(str(path), stereo, sr, subtype='FLOAT')
    return str(path)


@pytest.fixture
def wav_96k_24bit(tmp_path):
    """96kHz / 24bit のテスト用WAV（高解像度を模擬）"""
    import soundfile as sf
    sr = 96000
    duration = 1.0
    t = np.linspace(0, duration, int(sr * duration), dtype=np.float64)
    data = 0.5 * np.sin(2 * np.pi * 440 * t)
    stereo = np.column_stack([data, data])
    path = tmp_path / "test_96k_24bit.wav"
    sf.write(str(path), stereo, sr, subtype='PCM_24')
    return str(path)


@pytest.fixture
def wav_44k_16bit(tmp_path):
    """44.1kHz / 16bit のテスト用WAV（既にCD品質）"""
    import soundfile as sf
    sr = 44100
    duration = 1.0
    t = np.linspace(0, duration, int(sr * duration), dtype=np.float64)
    data = 0.5 * np.sin(2 * np.pi * 440 * t)
    stereo = np.column_stack([data, data])
    path = tmp_path / "test_44k_16bit.wav"
    sf.write(str(path), stereo, sr, subtype='PCM_16')
    return str(path)


class TestGetWavInfo:
    def test_48kHz_32bit情報を取得(self, wav_48k_32bit):
        from wav_optimize import get_wav_info
        info = get_wav_info(wav_48k_32bit)
        assert info["sample_rate"] == 48000
        assert info["channels"] == 2
        assert "FLOAT" in info["bit_depth"]
        assert info["duration_sec"] == pytest.approx(2.0, abs=0.1)
        assert info["file_size_mb"] > 0

    def test_96kHz_24bit情報を取得(self, wav_96k_24bit):
        from wav_optimize import get_wav_info
        info = get_wav_info(wav_96k_24bit)
        assert info["sample_rate"] == 96000
        assert "PCM_24" in info["bit_depth"]

    def test_44kHz_16bit情報を取得(self, wav_44k_16bit):
        from wav_optimize import get_wav_info
        info = get_wav_info(wav_44k_16bit)
        assert info["sample_rate"] == 44100
        assert "PCM_16" in info["bit_depth"]


class TestOptimizeWav:
    def test_48kHz_32bitを44kHz_16bitに変換(self, wav_48k_32bit):
        from wav_optimize import optimize_wav
        result = optimize_wav(wav_48k_32bit, target_sr=44100, target_bit_depth=16)
        assert Path(result["path"]).exists()
        assert result["optimized"]["sample_rate"] == 44100
        assert "PCM_16" in result["optimized"]["bit_depth"]
        # 32bit float → 16bit で容量が減る
        assert result["reduction_pct"] > 0
        assert result["optimized"]["file_size_mb"] < result["original"]["file_size_mb"]

    def test_96kHz_24bitを44kHz_16bitに変換(self, wav_96k_24bit):
        from wav_optimize import optimize_wav
        result = optimize_wav(wav_96k_24bit, target_sr=44100, target_bit_depth=16)
        assert result["optimized"]["sample_rate"] == 44100
        # 96kHz→44.1kHz + 24bit→16bit で大幅削減
        assert result["reduction_pct"] > 50

    def test_同じスペックでも処理できる(self, wav_44k_16bit):
        from wav_optimize import optimize_wav
        result = optimize_wav(wav_44k_16bit, target_sr=44100, target_bit_depth=16)
        assert Path(result["path"]).exists()
        # 同じスペックなので削減率はほぼ0
        assert result["reduction_pct"] < 5

    def test_24bit出力(self, wav_48k_32bit):
        from wav_optimize import optimize_wav
        result = optimize_wav(wav_48k_32bit, target_sr=44100, target_bit_depth=24)
        assert "PCM_24" in result["optimized"]["bit_depth"]

    def test_音声のデュレーションが保持される(self, wav_48k_32bit):
        from wav_optimize import optimize_wav
        result = optimize_wav(wav_48k_32bit, target_sr=44100, target_bit_depth=16)
        # 元が2秒なので最適化後も約2秒
        assert result["optimized"]["duration_sec"] == pytest.approx(2.0, abs=0.1)

    def test_チャンネル数が保持される(self, wav_48k_32bit):
        from wav_optimize import optimize_wav
        result = optimize_wav(wav_48k_32bit, target_sr=44100, target_bit_depth=16)
        assert result["optimized"]["channels"] == result["original"]["channels"]


class TestResampleQuality:
    def test_リサンプル後の周波数が保持される(self, wav_48k_32bit):
        """リサンプル後も440Hzの主要周波数成分が保持されることを確認"""
        from wav_optimize import optimize_wav
        import soundfile as sf
        result = optimize_wav(wav_48k_32bit, target_sr=44100, target_bit_depth=16)
        data, sr = sf.read(result["path"])
        # FFTでピーク周波数を確認
        mono = data[:, 0] if data.ndim > 1 else data
        fft = np.abs(np.fft.rfft(mono))
        freqs = np.fft.rfftfreq(len(mono), 1 / sr)
        peak_freq = freqs[np.argmax(fft[1:]) + 1]  # DC成分を除く
        assert abs(peak_freq - 440) < 5  # 440Hz ± 5Hz

    def test_ディザリングで無音にノイズが載る(self):
        """ディザリングが適用されていることを確認（完全な無音が微小ノイズになる）"""
        from wav_optimize import _dither_and_quantize
        silence = np.zeros(1000, dtype=np.float64)
        dithered = _dither_and_quantize(silence, 16)
        # ディザリングにより完全な0ではなくなる
        assert np.max(np.abs(dithered)) > 0
        # ただし非常に小さい（16bitの1LSB程度）
        assert np.max(np.abs(dithered)) < 0.001
