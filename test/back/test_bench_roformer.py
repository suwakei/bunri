"""実験用 RoFormer の入力条件と、推論せず確認できる範囲のテスト。"""
import hashlib

import pytest

from _bench_roformer import chunk_starts, verify_artifact


def test_末尾まで覆いチャンク間に隙間がない():
    starts = chunk_starts(1001, 300, 150)
    assert starts == [0, 150, 300, 450, 600, 701]
    assert starts[-1] + 300 == 1001
    assert all(b <= a + 300 for a, b in zip(starts, starts[1:]))


def test_短い音声でも一つのチャンクを用意する():
    assert chunk_starts(10, 300, 150) == [0]


@pytest.mark.parametrize("args", [(0, 300, 150), (100, 0, 1), (100, 300, 0), (100, 300, 301)])
def test_不正な長さや刻みを拒否する(args):
    with pytest.raises(ValueError):
        chunk_starts(*args)


def test_モデルが改変されていれば読み込む前に拒否する(tmp_path):
    path = tmp_path / "model.safetensors"
    path.write_bytes(b"original")
    digest = hashlib.sha256(b"original").hexdigest()
    verify_artifact(path, digest)
    path.write_bytes(b"changed")
    with pytest.raises(ValueError, match="SHA-256"):
        verify_artifact(path, digest)
