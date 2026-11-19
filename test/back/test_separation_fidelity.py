"""分離後の音量・ステレオと、明示した場合だけの再分離を確かめる。"""
import numpy as np
import pytest
import soundfile as sf

import demucs_progress
import separate


@pytest.mark.parametrize(
    ("encoding", "bits", "subtype", "tolerance"),
    [("PCM_F", 32, "FLOAT", 0), ("PCM_F", 64, "DOUBLE", 0), ("PCM_S", 24, "PCM_24", 2 ** -23)],
)
def test_保存パッチは指定した精度と左右の振幅を保つ(tmp_path, encoding, bits, subtype, tolerance):
    import torch
    from _demucs_runner import _soundfile_save

    audio = np.array([[0.25, -0.5, 0.125], [-0.25, 0.5, -0.125]], dtype=np.float32)
    path = tmp_path / "stereo.wav"
    _soundfile_save(path, torch.from_numpy(audio), 44100, encoding=encoding, bits_per_sample=bits)
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    assert sf.info(path).subtype == subtype
    assert rate == 44100
    np.testing.assert_allclose(data.T, audio, rtol=0, atol=tolerance)


def test_浮動小数点保存はフルスケールを超える分離音も縮めず切らない(tmp_path):
    import torch
    from _demucs_runner import _soundfile_save

    audio = np.array([[1.4, -1.25], [-0.75, 0.5]], dtype=np.float32)
    path = tmp_path / "peaks.wav"
    _soundfile_save(path, torch.from_numpy(audio), 44100, encoding="PCM_F", bits_per_sample=32)
    data, _ = sf.read(path, dtype="float32", always_2d=True)
    np.testing.assert_array_equal(data.T, audio)


def test_Demucs本体の保存経路でも浮動小数点の振幅を保持する(tmp_path):
    import torch
    import _demucs_runner  # noqa: F401
    from demucs.api import save_audio

    audio = np.array([[1.4, -1.25, 0.01], [-0.75, 0.5, -0.02]], dtype=np.float32)
    path = tmp_path / "demucs-peaks.wav"
    save_audio(torch.from_numpy(audio), path, samplerate=44100, as_float=True, clip="none")
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    assert sf.info(path).subtype == "FLOAT"
    assert rate == 44100
    np.testing.assert_array_equal(data.T, audio)


@pytest.mark.parametrize("mp3", [False, True])
def test_分離保存ではWAVの音量比を保ちMP3には既存のクリップ対策を残す(tmp_path, monkeypatch, mp3):
    from demucs.separate import get_parser

    source = tmp_path / "source.wav"
    sf.write(source, np.zeros((10, 2)), 44100)
    observed = []

    def run(cmd, **kwargs):
        # 実際の Demucs の引数として受け付けられることも確かめる。
        observed.append(get_parser().parse_args(cmd[2:]))
        return 0

    monkeypatch.setattr(demucs_progress, "run", run)
    separate.separate_audio(str(source), output_dir=str(tmp_path / "out"), mp3_output=mp3)
    args = observed[0]
    assert args.mp3 is mp3
    assert args.float32 is (not mp3)
    assert args.clip_mode == ("rescale" if mp3 else "none")


@pytest.mark.parametrize("kind", ["逆相", "短い音", "小さい音"])
def test_弱い音や短い音と左右逆相の音を無音として落とさない(tmp_path, kind):
    data = np.zeros((44100 * 3, 2), dtype=np.float32)
    if kind == "逆相":
        data[:, 0] = 0.01
        data[:, 1] = -0.01
    elif kind == "短い音":
        data[70000:70010, 0] = 0.01
    else:
        data[:] = 0.0002
    path = tmp_path / "quiet.wav"
    sf.write(path, data, 44100, subtype="FLOAT")
    assert not separate._is_silent(path)


def test_完全な無音は引き続き除外する(tmp_path):
    path = tmp_path / "silence.wav"
    sf.write(path, np.zeros((100, 2)), 44100, subtype="FLOAT")
    assert separate._is_silent(path)


@pytest.mark.parametrize("model", ["htdemucs", "htdemucs_ft", "htdemucs_6s"])
def test_選んだモデルで一度だけ分離しその他をそのまま残す(tmp_path, monkeypatch, model):
    other = tmp_path / "other.wav"
    sf.write(other, np.full((100, 2), 0.1), 44100, subtype="FLOAT")
    calls = []

    def fake_separate(input_path, **kwargs):
        calls.append(kwargs)
        return {"other": other}

    monkeypatch.setattr(separate, "separate_audio", fake_separate)
    result = separate.deep_separate("source.wav", model=model)
    assert result == {"other": other}
    assert len(calls) == 1
    assert calls[0]["model"] == model
    stages = dict(separate.deep_separate_stages(model=model))
    assert "separate_other" not in stages
    assert ("6" if model == "htdemucs_6s" else "4") in stages["separate"]


def test_未知のモデルは処理や追加モデル取得の前に拒否する(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("処理を始めてはいけません")

    monkeypatch.setattr(separate, "_ensure_drum_model", forbidden)
    monkeypatch.setattr(separate, "separate_audio", forbidden)
    with pytest.raises(ValueError, match="非対応"):
        separate.deep_separate("source.wav", model="unknown", split_drums=True)
    with pytest.raises(ValueError, match="非対応"):
        separate.deep_separate_stages(model="unknown")
