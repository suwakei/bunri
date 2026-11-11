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


@pytest.fixture(scope="session")
def chord_song(tmp_path_factory):
    """楽曲カルテ検証用の合成音源。

    120BPM 4/4、キー C メジャー、C→G→Am→F を1小節ずつ12小節。
    曲頭に 0.35 秒の無音を置き、ダウンビートが 0 でないケースを再現する。
    静かなイントロ4小節と大きい8小節でセクション境界も作る。

    Returns:
        tuple[str, dict]: ``(wav_path, truth)``。``truth`` は検証用の真値
        （``bpm`` / ``offset`` / ``tonic`` / ``mode`` / ``progression`` / ``bars``）。
    """
    import soundfile as sf

    SR, BPM = 44100, 120.0
    beat = 60.0 / BPM
    bar = beat * 4
    offset = 0.35
    bars = 12
    prog = {"C": [60, 64, 67], "G": [55, 59, 62], "Am": [57, 60, 64], "F": [53, 57, 60]}
    seq = ["C", "G", "Am", "F"]

    def hz(m):
        return 440.0 * 2 ** ((m - 69) / 12)

    n = int((offset + bars * bar + 1.0) * SR)
    left, right = np.zeros(n), np.zeros(n)

    for index in range(bars):
        notes = prog[seq[index % 4]]
        gain = 0.4 if index < 4 else 1.0
        start, length = int((offset + index * bar) * SR), int(bar * SR)
        t = np.arange(length) / SR
        env = np.minimum(1.0, t * 40) * (1 - 0.35 * (t / bar))
        for i, midi in enumerate(notes):
            wave = np.sin(2*np.pi*hz(midi)*t) + 0.28*np.sin(2*np.pi*hz(midi)*2*t)
            pan = 0.5 + (i - 1) * 0.18
            seg = 0.11 * gain * wave * env
            left[start:start+length] += seg * (1 - pan)
            right[start:start+length] += seg * pan
        # ルートの2オクターブ下をモノラル中央に。ベース音はコード判定の手がかり
        bass = 0.20 * gain * np.sin(2*np.pi*hz(notes[0]-24)*t) * env
        left[start:start+length] += bass
        right[start:start+length] += bass
        if index >= 4:
            for b in range(4):
                ks, d = int((offset + index*bar + b*beat) * SR), int(0.09 * SR)
                tt = np.arange(d) / SR
                kick = 0.5 * np.sin(2*np.pi*np.linspace(110, 45, d)*tt) * np.exp(-tt*32)
                if b == 0:
                    kick *= 1.5
                left[ks:ks+d] += kick
                right[ks:ks+d] += kick

    audio = np.column_stack([left, right])
    audio /= max(1e-9, np.max(np.abs(audio)) / 0.89)
    path = tmp_path_factory.mktemp("chart") / "chord_song.wav"
    sf.write(str(path), audio, SR)

    return str(path), {
        "bpm": BPM, "offset": offset, "tonic": "C", "mode": "major",
        "progression": seq, "bars": bars,
    }


@pytest.fixture
def silent_wav(tmp_path):
    """完全な無音の WAV。解析が破綻せず unavailable に落ちることの確認用。"""
    import soundfile as sf
    path = tmp_path / "silence.wav"
    sf.write(str(path), np.zeros((44100 * 3, 2)), 44100)
    return str(path)


@pytest.fixture
def noise_wav(tmp_path):
    """ホワイトノイズの WAV。調性が無い音源でキーを断定しないことの確認用。"""
    import soundfile as sf
    path = tmp_path / "noise.wav"
    sf.write(str(path), np.random.RandomState(0).randn(44100 * 3, 2) * 0.2, 44100)
    return str(path)
