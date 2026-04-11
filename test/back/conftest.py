"""バックエンドテスト共通フィクスチャ"""
import sys
from pathlib import Path
import pytest
import numpy as np

# プロジェクトルートをパスに追加
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture
def sample_audio_mono():
    """モノラル1秒のテスト用音声データ（440Hz サイン波）"""
    sr = 44100
    t = np.linspace(0, 1, sr, dtype=np.float32)
    data = 0.5 * np.sin(2 * np.pi * 440 * t)
    return data, sr


@pytest.fixture
def sample_audio_stereo():
    """ステレオ1秒のテスト用音声データ"""
    sr = 44100
    t = np.linspace(0, 1, sr, dtype=np.float32)
    left = 0.5 * np.sin(2 * np.pi * 440 * t)
    right = 0.5 * np.sin(2 * np.pi * 880 * t)
    data = np.column_stack([left, right])
    return data, sr


@pytest.fixture
def tmp_wav(sample_audio_stereo, tmp_path):
    """一時WAVファイルのパスを返す"""
    import soundfile as sf
    data, sr = sample_audio_stereo
    path = tmp_path / "test.wav"
    sf.write(str(path), data, sr)
    return str(path)


@pytest.fixture
def tmp_wav_mono(sample_audio_mono, tmp_path):
    """モノラル一時WAVファイルのパスを返す"""
    import soundfile as sf
    data, sr = sample_audio_mono
    path = tmp_path / "test_mono.wav"
    sf.write(str(path), data, sr)
    return str(path)
