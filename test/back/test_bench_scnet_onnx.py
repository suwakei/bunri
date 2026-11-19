"""SCNet比較の出力先を、利用者の結果を上書きせずに扱うテスト。"""
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
import pytest
import soundfile as sf

import _bench_scnet_onnx as bench
from _bench_scnet_onnx import validate_output_dir


def test_新しい出力先や計測ログだけの出力先を使える(tmp_path):
    validate_output_dir(tmp_path / "new")
    (tmp_path / "process.log").write_text("計測中")
    (tmp_path / "benchmark.json").write_text("{}")
    validate_output_dir(tmp_path)


@pytest.mark.parametrize("name", ["bass.wav", "metadata.json"])
def test_既存の分離音声や結果を上書きしない(tmp_path, name):
    (tmp_path / name).write_bytes(b"existing")
    with pytest.raises(FileExistsError):
        validate_output_dir(tmp_path)


def test_Nodeとの配列受け渡しとWAV保存で左右や振幅を変えない(tmp_path, monkeypatch):
    source_dir = tmp_path / "source"
    package = source_dir / "node_modules" / "onnxruntime-node" / "package.json"
    package.parent.mkdir(parents=True)
    package.write_text('{"version": "test"}')
    model_dir = tmp_path / "models"
    model_path = model_dir / "scnet" / "scnet.int8.onnx"
    model_path.parent.mkdir(parents=True)
    model_path.write_bytes(b"model")
    monkeypatch.setattr(bench, "WEIGHTS_SHA", hashlib.sha256(b"model").hexdigest())
    audio = np.array([[1.2, -0.5], [-1.1, 0.2], [0.0001, -0.0002]], dtype=np.float32)
    input_path = tmp_path / "input.wav"
    sf.write(input_path, audio, 44100, subtype="FLOAT")

    def command_output(cmd, **kwargs):
        return "test-node" if cmd[0] == "node" else bench.CODE_REVISION

    def run(cmd, **kwargs):
        if cmd[0] == "git":
            return subprocess.CompletedProcess(cmd, 0)
        # 本物の推論の代わりに、Nodeへ渡す配列をそのまま返す。
        assert cmd[0] == "node"
        raw = np.fromfile(cmd[4], dtype="<f4")
        temporary = Path(cmd[5])
        for stem in bench.STEMS:
            raw.tofile(temporary / f"{stem}.f32")
        (temporary / "timing.json").write_text(json.dumps({
            "sample_rate": 44100, "load_seconds": 1, "separation_seconds": 2,
        }))
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(bench.subprocess, "check_output", command_output)
    monkeypatch.setattr(bench.subprocess, "run", run)
    out = tmp_path / "outputs"
    result = bench.run(input_path, out, source_dir, model_dir)
    assert result["sample_rate"] == 44100
    for stem in bench.STEMS:
        actual, rate = sf.read(out / f"{stem}.wav", dtype="float32", always_2d=True)
        assert rate == 44100 and sf.info(out / f"{stem}.wav").subtype == "FLOAT"
        np.testing.assert_array_equal(actual, audio)
