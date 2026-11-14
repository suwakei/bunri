"""ドラム分離モデル（inagoy/drumsep）を、コードを含まない形式（safetensors）に変換する。

配布元のファイル（``49469ca8.th``）は pickle 形式で、Demucs の標準の読み込みは、中に書かれた
コードを実行できる設定（``weights_only=False``）で開く。利用者の PC でそれをしないよう、
あらかじめ safetensors に変換したものを配る。このスクリプトはその変換を行う（開発者が 1 回だけ使う）。

変換のときも、pickle は「重みだけ」の読み方（``weights_only=True``）で開く。参照を許すのは
モデルのクラス ``demucs.hdemucs.HDemucs`` だけで、それ以外を参照するファイルは読めずに失敗する。

出力の形は Demucs 4.1 の ``demucs.hf.load_safetensors_model`` が読む形に合わせてある
（クラス名と初期化の引数を、safetensors のメタデータに JSON で持つ）。

同じ入力からは、誰がいつ変換しても、1 バイトも違わないファイルができる（配るファイルのハッシュを
``backend/stem_models.py`` に固定してあるので、変換をやり直して同じハッシュになることを確かめられる）。
safetensors の書き出し（``save_file``）は、メタデータのキーの並び順が実行のたびに変わる。
そのままだと、中身が同じでもハッシュが毎回変わるので、書き出したあとでヘッダだけを決まった形に
組み直している（``canonical_header``）。重みのデータ部のバイト列には触らない。組み直したファイルは
safetensors で読み直し、メタデータの中身とすべての重みが元と同じことを確かめてから置く。

使い方::

    uv run python scripts/convert_drum_model.py 49469ca8.th drumsep-49469ca8.safetensors

最後に、できたファイルの SHA-256 と大きさを表示する。

配布元: https://github.com/inagoy/drumsep （MIT License, Copyright (c) 2024 Iñaki Goyeneche）
"""
import argparse
import hashlib
import json
import os
import struct
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


def canonical_header(header):
    """safetensors のヘッダ（JSON）を、決まった形に組み直す。

    safetensors の書き出しは、メタデータ（``__metadata__``）のキーの並び順が実行のたびに変わる。
    ここで並びを固定して、同じ中身なら同じバイト列になるようにする。

    - 先頭に ``__metadata__``。キーは名前の昇順
    - 続けてテンソル。データ部に並んでいる順（``data_offsets`` の昇順）。1 件のキーは
      ``dtype`` ``shape`` ``data_offsets`` の順
    - 空白を入れない JSON（UTF-8）。末尾を半角の空白で埋めて、長さを 8 の倍数にする
      （データ部の先頭を 8 バイト境界にそろえる、safetensors の決まり）

    値（メタデータの文字列、テンソルの型・形・位置）は変えない。

    Args:
        header (bytes): 元のヘッダ（ファイルの 9 バイト目から、ヘッダ長ぶん）。

    Returns:
        bytes: 組み直したヘッダ。

    Raises:
        ValueError: ヘッダが想定の形でないとき。
    """
    obj = json.loads(header)
    metadata = obj.pop("__metadata__", None)
    if not isinstance(metadata, dict) or not all(isinstance(v, str) for v in metadata.values()):
        raise ValueError("ヘッダのメタデータが想定の形ではありません")
    for name, info in obj.items():
        if not isinstance(info, dict) or set(info) != {"dtype", "shape", "data_offsets"}:
            raise ValueError(f"ヘッダのテンソルの記述が想定の形ではありません: {name}")
    ordered = {"__metadata__": {key: metadata[key] for key in sorted(metadata)}}
    for name in sorted(obj, key=lambda k: (obj[k]["data_offsets"], k)):
        info = obj[name]
        ordered[name] = {"dtype": info["dtype"], "shape": info["shape"], "data_offsets": info["data_offsets"]}
    encoded = json.dumps(ordered, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return encoded + b" " * (-len(encoded) % 8)


def rewrite_header(src, dst):
    """safetensors のファイルを、ヘッダだけ決まった形に組み直して書き出す。データ部はそのまま写す。

    ファイルの形: 先頭 8 バイトがヘッダ長（リトルエンディアン）、続いてヘッダ（JSON）、残りがデータ部。

    Args:
        src: 元の safetensors（``save_file`` が書いたもの）。
        dst: 書き出し先。``src`` と同じパスは不可。

    Returns:
        str: ``src`` から読んだデータ部の SHA-256（16 進数）。``dst`` のデータ部
        （``data_sha256_of``）と比べて、写す前後で変わっていないことの確認に使う。
    """
    digest = hashlib.sha256()
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        (length,) = struct.unpack("<Q", fin.read(8))
        header = canonical_header(fin.read(length))
        fout.write(struct.pack("<Q", len(header)))
        fout.write(header)
        for block in iter(lambda: fin.read(1 << 20), b""):
            digest.update(block)
            fout.write(block)
    return digest.hexdigest()


def data_sha256_of(path):
    """safetensors のデータ部（ヘッダより後ろ）の SHA-256 を返す。

    Args:
        path: safetensors のパス。

    Returns:
        str: 16 進数 64 桁。
    """
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        (length,) = struct.unpack("<Q", f.read(8))
        f.seek(8 + length)
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(path, metadata, state):
    """書き出したファイルを safetensors で読み直し、中身が元と同じことを確かめる。

    Args:
        path: 確かめる safetensors のパス。
        metadata (dict): 書き込んだはずのメタデータ。
        state (dict): 書き込んだはずの重み（名前 → テンソル）。

    Raises:
        ValueError: メタデータ、テンソルの名前、型、形、値のどれかが違うとき。
    """
    import torch
    from safetensors import safe_open

    with safe_open(str(path), framework="pt") as f:
        if f.metadata() != metadata:
            raise ValueError("読み直したメタデータが、元と違います")
        if sorted(f.keys()) != sorted(state):
            raise ValueError("読み直したテンソルの名前が、元と違います")
        for name, expected in state.items():
            actual = f.get_tensor(name)
            if actual.dtype != expected.dtype or not torch.equal(actual, expected):
                raise ValueError(f"読み直した重みが、元と違います: {name}")


def convert(src, dst, expected_sha256=SOURCE_SHA256):
    """pickle 形式のモデルを safetensors に変換する。同じ入力からは、いつも同じバイト列ができる。

    Args:
        src: 配布元のファイル（``.th``）。
        dst: 書き出す safetensors のパス。
        expected_sha256: ``src`` に期待する SHA-256。違えば変換しない。

    Returns:
        dict: ``{"sha256": 出力の SHA-256, "size": 出力の大きさ（バイト）,
        "sources": ステム名のリスト, "tensors": テンソルの数}``。

    Raises:
        ValueError: ``src`` のハッシュが期待と違うとき、中身が想定の形でないとき、
            または書き出したファイルを読み直して元と違ったとき（そのときは ``dst`` を置かない）。
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
    dst = Path(dst)
    raw = dst.with_name(dst.name + ".raw")
    canonical = dst.with_name(dst.name + ".part")
    try:
        # いったん safetensors に書かせる。メタデータの並び順が実行のたびに変わるので、これは配らない
        save_file({k: v.contiguous() for k, v in state.items()}, str(raw), metadata=metadata)
        # ヘッダだけを決まった形に組み直す。データ部は 1 バイトも変えない
        if rewrite_header(raw, canonical) != data_sha256_of(canonical):
            raise ValueError("データ部を写している途中で、中身が変わりました")
        verify(canonical, metadata, state)
        os.replace(canonical, dst)
    finally:
        raw.unlink(missing_ok=True)
        canonical.unlink(missing_ok=True)
    return {
        "sha256": sha256_of(dst),
        "size": dst.stat().st_size,
        "sources": kwargs.get("sources"),
        "tensors": len(state),
    }


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
