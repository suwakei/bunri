"""比較用 SubRoformer のコード固定・ハッシュ照合・上書き防止の検証。モデルは取得しない。"""
import hashlib
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

import _bench_subroformer as bench


def test_壊れた重みを読み込む前に拒否する(tmp_path):
    path = tmp_path / "model.safetensors"
    path.write_bytes(b"broken")
    with pytest.raises(ValueError, match="ハッシュ"):
        bench.verify_file(path, bench.WEIGHTS_SHA256)


def test_Git管理の小さい設定ファイルも実体を照合する(tmp_path):
    data = b"sample_rate: 48000\n"
    path = tmp_path / "config.yaml"
    path.write_bytes(data)
    expected = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
    assert bench.verify_file(path, expected, "git") == expected


def test_CoreML取得は固定revisionと全ファイルを照合してモデル直下を返す(tmp_path, monkeypatch):
    hashes = {"config.yaml": ("sha256", "a"), "mask.mlmodelc/weights/weight.bin": ("sha256", "b")}
    monkeypatch.setattr(bench, "COREML_HASHES", hashes)
    downloads, checked = [], []

    def download(**kwargs):
        downloads.append(kwargs)
        return str(tmp_path / kwargs["filename"])

    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=download))
    monkeypatch.setattr(bench, "verify_file", lambda path, digest, algorithm: checked.append((path, digest, algorithm)))
    model_dir = bench.prepare_model("coreml")
    assert model_dir == tmp_path / bench.COREML_DIRECTORY
    assert len(downloads) == len(checked) == 2
    assert all(item["revision"] == bench.MODEL_REVISION for item in downloads)


def test_既存の結果には重みを取得せず拒否する(tmp_path, monkeypatch):
    source = tmp_path / "input.wav"
    source.touch()
    output = tmp_path / "out"
    output.mkdir()
    output.joinpath("other.wav").write_bytes(b"existing")
    monkeypatch.setattr(bench, "verify_source", lambda path: None)
    with pytest.raises(FileExistsError):
        bench.run(source, output, Path("source"))
    assert output.joinpath("other.wav").read_bytes() == b"existing"
