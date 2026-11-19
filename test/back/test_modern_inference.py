"""新しい分離の音量・左右・区間処理と、workerの進捗・取得契約を確かめる。"""
import json
from pathlib import Path
import sys
import types

import numpy as np
import pytest
import soundfile as sf

import scnet_inference


@pytest.mark.parametrize("length", [1, 15, 43, 150])
def test_SCNetの短音と反射区間でも左右と振幅を保つ(tmp_path, monkeypatch, length):
    # 小さなFFTと、スペクトルを第1パートへそのまま返す偽の推論で前後処理だけを通す。
    for name, value in {"FFT": 16, "HOP": 4, "FRAMES": 11, "SEGMENT": 40}.items():
        monkeypatch.setattr(scnet_inference, name, value)
    seen = []

    class Session:
        def __init__(self, path, **kwargs):
            assert kwargs["providers"] == ["CPUExecutionProvider"]

        def get_inputs(self):
            return [types.SimpleNamespace(name="mix_spec")]

        def run(self, names, inputs):
            encoded = inputs["mix_spec"]
            output = np.zeros((1, 16, 9, 11), dtype=np.float32)
            output[:, :4] = encoded
            return [output]

    fake = types.SimpleNamespace(SessionOptions=types.SimpleNamespace, InferenceSession=Session)
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)
    time = np.arange(length, dtype=np.float32)
    audio = np.column_stack([2.1 * np.sin(time * 0.7) + 0.25, -1.3 * np.cos(time * 0.2) + 0.1])
    if length == 1:
        audio[0] = [2, -1]
    ready = []
    scnet_inference.separate(audio, 44100, tmp_path / "fake.onnx", tmp_path / "out",
                            on_ready=ready.append, on_progress=lambda done, total: seen.append((done, total)))
    got, rate = sf.read(tmp_path / "out" / "drums.wav", dtype="float32", always_2d=True)
    expected = audio - audio.astype(np.float64).mean(axis=1).mean()
    np.testing.assert_allclose(got, expected, rtol=2e-6, atol=4e-7)
    assert rate == 44100 and sf.info(tmp_path / "out" / "drums.wav").subtype == "FLOAT"
    assert ready == ["cpu"] and seen[0][0] == 0 and seen[-1][0] == seen[-1][1]
    assert all(a[0] < b[0] for a, b in zip(seen, seen[1:]))
    assert not list((tmp_path / "out").glob("scnet-work-*"))


def test_SCNetは不正な推論出力を保存しない():
    with pytest.raises(ValueError):
        scnet_inference.decode_segment(np.zeros((1, 1)))


@pytest.mark.parametrize("mps", [False, True])
def test_SubRoformerの保存は音量を変えず進捗を伝える(tmp_path, monkeypatch, mps):
    import torch
    import subroformer_inference

    config_path = tmp_path / "_vendor/subroformer/subroformer/configs/sbroformer_base_4stem_silu.yaml"
    config_path.parent.mkdir(parents=True)
    config_path.touch()
    weights = tmp_path / "weights.safetensors"
    weights.touch()
    monkeypatch.setattr(subroformer_inference, "__file__", str(tmp_path / "subroformer_inference.py"))
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: mps)
    monkeypatch.setattr(torch.mps, "synchronize", lambda: None)
    calls = []

    def load_separator(config_path, weights, **kwargs):
        calls.append(kwargs)
        return object(), types.SimpleNamespace(audio=types.SimpleNamespace(sample_rate=48000, chunk_size=4))

    def separate_audio(model, audio, config, **kwargs):
        for index in range(5):
            end = index + 1 if index < 4 else len(audio[0])
            kwargs["on_chunk"](index, {stem: audio[:, index:end] * 1.25 for stem in subroformer_inference.STEMS})
        assert kwargs["collect_output"] is False

    engine = types.SimpleNamespace(load_separator=load_separator, separate_audio=separate_audio,
                                   resolve_amp_dtype=lambda device: None)
    monkeypatch.setitem(sys.modules, "subroformer.inference.engine", engine)
    audio = np.array([[1.1, -0.8], [0.05, -0.1]] * 4, dtype=np.float32)
    progress = []
    ready = []
    subroformer_inference.separate(audio, 48000, weights, tmp_path / "out", on_ready=ready.append,
                                   on_progress=lambda done, total: progress.append((done, total)))
    for stem in subroformer_inference.STEMS:
        saved, rate = sf.read(tmp_path / "out" / f"{stem}.wav", dtype="float32", always_2d=True)
        np.testing.assert_array_equal(saved, audio * 1.25)
        assert rate == 48000 and sf.info(tmp_path / "out" / f"{stem}.wav").subtype == "FLOAT"
    device = "mps" if mps else "cpu"
    assert calls == [{"device": device, "local_files_only": True}]
    assert ready == [device] and progress == [(index, 5) for index in range(6)]


def test_workerは台帳と違う重みを取得前に拒否する(tmp_path, monkeypatch):
    import _modern_separate_runner as runner
    import modern_models

    monkeypatch.setattr(modern_models, "model_path", lambda model: tmp_path / "expected.onnx")
    monkeypatch.setattr(modern_models, "ensure_model", lambda *args, **kwargs: pytest.fail("取得してはいけません"))
    with pytest.raises(ValueError, match="台帳"):
        runner.run(tmp_path / "input.wav", tmp_path / "out", "scnet", tmp_path / "other.onnx")


def test_workerはモノラルと分離後のピークを保って進捗を出す(tmp_path, monkeypatch):
    import _modern_separate_runner as runner
    import demucs_progress
    import modern_models

    path = tmp_path / "input.wav"
    sf.write(path, np.array([1.4, -1.1, 0.01], dtype=np.float32), 44100, subtype="FLOAT")
    weights = tmp_path / "weights.onnx"
    weights.touch()
    monkeypatch.setenv(demucs_progress.ENV_FLAG, "1")
    monkeypatch.setattr(modern_models, "model_path", lambda model: weights)
    monkeypatch.setattr(modern_models, "MODELS", {"scnet": {"size": 10}})

    def acquire(model, on_bytes):
        on_bytes(10)
        return weights

    monkeypatch.setattr(modern_models, "ensure_model", acquire)
    events = []
    monkeypatch.setattr(demucs_progress, "watch_parent", lambda **kwargs: None)
    monkeypatch.setattr(demucs_progress, "emit", lambda event, **fields: events.append((event, fields)))

    def separate(audio, rate, weights, output_dir, on_ready, on_progress):
        np.testing.assert_array_equal(audio[:, 0], np.array([1.4, -1.1, 0.01], dtype=np.float32))
        np.testing.assert_array_equal(audio[:, 0], audio[:, 1])
        on_ready("cpu")
        on_progress(1, 1)
        return "cpu"

    monkeypatch.setattr(scnet_inference, "separate", separate)
    runner.run(path, tmp_path / "out", "scnet", weights)
    assert [event for event, _ in events] == ["ready", "model_download", "model_ready", "segments"]
    assert events[1][1] == {"done": 10, "total": 10}
    assert json.loads((tmp_path / "out" / "runtime.json").read_text()) == {"model": "scnet", "device": "cpu"}


def test_workerは非有限音声を拒否する(tmp_path):
    import _modern_separate_runner as runner
    source = tmp_path / "bad.wav"
    sf.write(source, [float("nan")], 44100, subtype="FLOAT")
    with pytest.raises(ValueError, match="空でない"):
        runner.load_input(source, tmp_path)


@pytest.mark.parametrize("download_error", [True, False])
def test_workerの失敗は利用者向けイベントで返す(tmp_path, monkeypatch, capsys, download_error):
    import _modern_separate_runner as runner
    import modern_models
    import demucs_progress

    monkeypatch.setattr(sys, "argv", ["worker", "--input", str(tmp_path / "in.wav"), "--out", str(tmp_path / "out"),
                                     "--model", "scnet", "--weights", str(tmp_path / "weights")])
    monkeypatch.setattr("signal.signal", lambda *args: None)

    def fail(*args):
        if download_error:
            raise modern_models.ModelUnavailableError("モデルを取得できませんでした。接続を確かめてください")
        raise RuntimeError("内部の推論例外")

    monkeypatch.setattr(runner, "run", fail)
    with pytest.raises(SystemExit) as error:
        runner.main()
    assert error.value.code == 1
    event = demucs_progress.parse_event(capsys.readouterr().out.strip())
    assert event["event"] == "error"
    assert "接続" in event["message"] if download_error else "SCNet" in event["message"]
    assert "内部の推論例外" not in event["message"]


def test_workerの変換子プロセスを終了時に止める(monkeypatch):
    import _modern_separate_runner as runner
    calls = []
    decoder = types.SimpleNamespace(poll=lambda: None, kill=lambda: calls.append("kill"), wait=lambda: calls.append("wait"))
    monkeypatch.setattr(runner, "_decoder", decoder)
    runner.cleanup_decoder()
    assert calls == ["kill", "wait"]
