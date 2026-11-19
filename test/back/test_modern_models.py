"""モデルの取得・破損検出・状態APIを、ネットワークへ出ずに確かめる。"""
import hashlib

import pytest

import modern_models


@pytest.fixture
def tiny_model(tmp_path, monkeypatch):
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    content = b"verified model"
    monkeypatch.setitem(modern_models.MODELS, "scnet", {
        "file": "test.onnx", "url": "https://example.invalid/model", "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    })
    return content


def test_取得前は未準備で使用量を返す(tiny_model):
    import model_cache
    assert model_cache.model_status("scnet") == {"model": "scnet", "cached": False, "missing": 1, "download_bytes": len(tiny_model)}


def test_サイズとハッシュを照合して配置し二度目は取得しない(tiny_model):
    calls = []
    done = []

    def fetch(url, destination, progress):
        calls.append(url)
        destination.write_bytes(tiny_model)
        progress(len(tiny_model))

    result = modern_models.ensure_model("scnet", fetch=fetch, on_bytes=done.append)
    assert result.read_bytes() == tiny_model
    assert done == [len(tiny_model)] and modern_models.model_status("scnet")["cached"]
    assert modern_models.ensure_model("scnet", fetch=fetch) == result
    assert len(calls) == 1
    assert not modern_models.partial_path("scnet").exists()


def test_同じサイズでも破損していれば取り直す(tiny_model):
    path = modern_models.model_path("scnet")
    path.write_bytes(b"x" * len(tiny_model))
    assert modern_models.is_cached("scnet")
    def fetch(url, destination, progress):
        destination.write_bytes(tiny_model)
    modern_models.ensure_model("scnet", fetch=fetch)
    assert path.read_bytes() == tiny_model


def test_ハッシュ不一致は使わず書きかけを削除する(tiny_model):
    def fetch(url, destination, progress):
        destination.write_bytes(b"x" * len(tiny_model))
    with pytest.raises(modern_models.ModelUnavailableError, match="一致"):
        modern_models.ensure_model("scnet", fetch=fetch)
    assert not modern_models.model_path("scnet").exists()
    assert not modern_models.partial_path("scnet").exists()


def test_通信失敗の理由を返し書きかけを削除する(tiny_model):
    def fetch(url, destination, progress):
        destination.write_bytes(b"partial")
        raise OSError("connection lost")
    with pytest.raises(modern_models.ModelUnavailableError, match="ネットワーク"):
        modern_models.ensure_model("scnet", fetch=fetch)
    assert not modern_models.partial_path("scnet").exists()


def test_取得途中の中止もそのまま伝え書きかけを削除する(tiny_model):
    from background_jobs import JobCancelled
    def fetch(url, destination, progress):
        destination.write_bytes(b"partial")
        raise JobCancelled()
    with pytest.raises(JobCancelled):
        modern_models.ensure_model("scnet", fetch=fetch)
    assert not modern_models.partial_path("scnet").exists()
