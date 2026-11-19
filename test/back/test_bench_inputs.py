"""比較入力の選択・照合・上書き防止を確認する。実音源は使わない。"""
import hashlib
import json
from types import SimpleNamespace
import zipfile

import numpy as np
import pytest
import soundfile as sf

import _bench_inputs as inputs


def test_公開曲はtestの辞書順先頭3曲で固定する():
    assert inputs.select_tracks(["train/A.mp4", "test/D.mp4", "test/B.mp4", "test/A.mp4", "test/C.mp4"]) == [
        "test/A.mp4", "test/B.mp4", "test/C.mp4"]


@pytest.mark.parametrize("extra", ["test/../evil.mp4", "test/sub\\evil.mp4", "test/evil\x00.mp4", "test/A.mp4"])
def test_危険なパスと重複は拒否する(extra):
    with pytest.raises(ValueError):
        inputs.select_tracks(["test/A.mp4", "test/B.mp4", "test/C.mp4", extra])


def test_ハッシュはファイルの内容を照合する(tmp_path):
    path = tmp_path / "sample"
    path.write_bytes(b"sample")
    assert inputs.file_hash(path) == hashlib.sha256(b"sample").hexdigest()


def test_既存の出力先は中身を変更せず拒否する(tmp_path):
    (tmp_path / "keep").write_text("keep")
    with pytest.raises(FileExistsError):
        inputs.prepare_inputs("missing.mp3", "missing.zip", tmp_path)
    assert (tmp_path / "keep").read_text() == "keep"


def test_不一致のアーカイブは出力先を作る前に拒否する(tmp_path):
    archive = tmp_path / "bad.zip"
    archive.write_bytes(b"bad")
    destination = tmp_path / "output"
    with pytest.raises(ValueError, match="MD5"):
        inputs.prepare_inputs("missing.mp3", archive, destination)
    assert not destination.exists()


def test_参照和を作り元ファイルと区間の来歴を残す(tmp_path, monkeypatch):
    archive = tmp_path / "sample.zip"
    with zipfile.ZipFile(archive, "w") as target:
        for name in ("C", "B", "A", "D"):
            target.writestr(f"test/{name}.mp4", b"synthetic container")
    local = tmp_path / "local.mp3"
    local.write_bytes(b"synthetic source")
    monkeypatch.setattr(inputs, "ARCHIVE_MD5", inputs.file_hash(archive, "md5"))
    monkeypatch.setattr(inputs.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout='{"format":{"duration":"10"}}'))
    decoded = []

    def decode(source, destination, stream=None, start=None, seconds=None):
        destination.parent.mkdir(parents=True, exist_ok=True)
        sf.write(destination, np.full((20, 2), (stream or 0) * 0.01, dtype=np.float32), 44100, subtype="FLOAT")
        decoded.append((stream, start, seconds))

    monkeypatch.setattr(inputs, "_decode", decode)
    output = tmp_path / "output"
    manifest = inputs.prepare_inputs(local, archive, output)
    assert len(manifest["cases"]) == 5
    assert decoded[:2] == [(None, 0, 10), (None, 0, 10)]
    assert [case["archive_member"] for case in manifest["cases"][2:]] == ["test/A.mp4", "test/B.mp4", "test/C.mp4"]
    linear, _ = sf.read(output / "musdb-test-01" / "linear-mixture.wav")
    np.testing.assert_allclose(linear, 0.1, atol=1e-7)
    assert json.loads((output / "manifest.json").read_text())["cases"][0]["source_sha256"] == inputs.file_hash(local)


def test_途中の失敗では自分が作った出力だけを片付ける(tmp_path, monkeypatch):
    archive = tmp_path / "sample.zip"
    with zipfile.ZipFile(archive, "w") as target:
        for name in ("A", "B", "C"):
            target.writestr(f"test/{name}.mp4", b"synthetic")
    monkeypatch.setattr(inputs, "ARCHIVE_MD5", inputs.file_hash(archive, "md5"))
    monkeypatch.setattr(inputs.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout='{"format":{"duration":"100"}}'))
    monkeypatch.setattr(inputs, "_decode", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("decode")))
    output = tmp_path / "output"
    with pytest.raises(RuntimeError, match="decode"):
        inputs.prepare_inputs("unused.mp3", archive, output)
    assert not output.exists()
