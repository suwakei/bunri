"""ドラム分離モデル（inagoy/drumsep）を、コードを含まない形式（safetensors）に変換する。

配布元のファイル（``49469ca8.th``）は pickle 形式で、Demucs の標準の読み込みは、中に書かれた
コードを実行できる設定（``weights_only=False``）で開く。利用者の PC でそれをしないよう、
あらかじめ safetensors に変換したものを配る。このスクリプトはその変換を行う（開発者が 1 回だけ使う）。

変換のときも、pickle は「重みだけ」の読み方（``weights_only=True``）で開く。参照を許すのは
モデルのクラス ``demucs.hdemucs.HDemucs`` だけで、それ以外を参照するファイルは読めずに失敗する。

出力の形は Demucs 4.1 の ``demucs.hf.load_safetensors_model`` が読む形に合わせてある
（クラス名と初期化の引数を、safetensors のメタデータに JSON で持つ）。

使い方::

    uv run python scripts/convert_drum_model.py 49469ca8.th drumsep-49469ca8.safetensors

配布元: https://github.com/inagoy/drumsep （MIT License, Copyright (c) 2024 Iñaki Goyeneche）
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

# 配布元のファイルの SHA-256。作者の Google ドライブと、ミラー（HuggingFace の vincewin/drumsep）で
# 同じ値になることを 2026-11-11 に確かめた
SOURCE_SHA256 = "aefaa8543c9b9c75e22f5f32b53ab86dfe416457849af1383ff1aef83401423f"


def sha256_of(path):
    """ファイルの SHA-256 を 16 進数の文字列で返す。

    Args:
        path: 調べるファイルのパス。

    Returns:
        str: 16 進数 64 桁。
    """
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def convert(src, dst, expected_sha256=SOURCE_SHA256):
    """pickle 形式のモデルを safetensors に変換する。

    Args:
        src: 配布元のファイル（``.th``）。
        dst: 書き出す safetensors のパス。
        expected_sha256: ``src`` に期待する SHA-256。違えば変換しない。

    Returns:
        dict: ``{"sha256": 出力の SHA-256, "sources": ステム名のリスト, "tensors": テンソルの数}``。

    Raises:
        ValueError: ``src`` のハッシュが期待と違うとき、または中身が想定の形でないとき。
    """
    actual = sha256_of(src)
    if actual != expected_sha256:
        raise ValueError(f"配布元のファイルのハッシュが違います: {actual}（期待: {expected_sha256}）")

    import torch
    from demucs.hdemucs import HDemucs
    from safetensors.torch import save_file

    # 「重みだけ」の読み方。許可したクラス以外を参照する pickle は、ここで失敗する
    with torch.serialization.safe_globals([HDemucs]):
        package = torch.load(str(src), map_location="cpu", weights_only=True)

    if package.get("klass") is not HDemucs:
        raise ValueError("モデルのクラスが HDemucs ではありません")
    args = list(package.get("args") or [])
    kwargs = dict(package.get("kwargs") or {})
    state = package["state"]
    if not all(isinstance(v, torch.Tensor) for v in state.values()):
        raise ValueError("重み以外のものが state に入っています")

    metadata = {
        "klass": "demucs.hdemucs.HDemucs",
        # JSON にできない値が混じっていれば、ここで失敗する
        "args": json.dumps(args),
        "kwargs": json.dumps(kwargs),
        "source": "https://github.com/inagoy/drumsep",
        "source_sha256": actual,
        "license": "MIT",
    }
    save_file({k: v.contiguous() for k, v in state.items()}, str(dst), metadata=metadata)
    return {"sha256": sha256_of(dst), "sources": kwargs.get("sources"), "tensors": len(state)}


def main(argv=None):
    """コマンドラインの入口。"""
    parser = argparse.ArgumentParser(description="drumsep のモデルを safetensors に変換する")
    parser.add_argument("src", type=Path, help="配布元のファイル（49469ca8.th）")
    parser.add_argument("dst", type=Path, help="書き出す safetensors")
    ns = parser.parse_args(argv)
    try:
        info = convert(ns.src, ns.dst)
    except ValueError as e:
        print(f"[エラー] {e}", file=sys.stderr)
        return 1
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
