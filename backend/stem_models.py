"""追加の分離モデル — Demucs が自分では取りに行けないモデルの置き場とダウンロード

Demucs 本体のモデル（htdemucs など）は、Demucs が自分でダウンロードしてキャッシュする。
ここで扱うのは、それ以外に bunri が使うモデル。いまはドラムを部位ごとに分けるモデル 1 つ。

配るファイルは safetensors（重みと設定値だけを持つ形式）にしてある。元の配布物は pickle 形式で、
Demucs の標準の読み方で開くと中のコードが実行されうるため、利用者の PC では開かない。
変換の手順は ``scripts/convert_drum_model.py``。

ダウンロードしたファイルは SHA-256 を照合してから置く。合わなければ置かずに失敗する。
"""
import hashlib
import os
import threading
from pathlib import Path

# 配布元の既定。環境変数 BUNRI_MODEL_BASE_URL で差し替えられる（社内の置き場やテスト用）
DEFAULT_BASE_URL = "https://github.com/suwakei/bunri/releases/download/models-v1"

ADDON_MODELS = {
    # ドラムを 4 つの部位に分ける。Hybrid Demucs。
    # 出典: https://github.com/inagoy/drumsep （MIT License, Copyright (c) 2024 Iñaki Goyeneche）
    "drumsep": {
        "file": "drumsep-49469ca8.safetensors",
        "sha256": "fd9a07c3c8ada7f6db8f6ec4758b329f4b717bdf16c9724b8348d3e47d7a6fc5",
        "size": 167317568,
        # モデルが出すステム名（スペイン語）→ bunri のステム名
        "stems": {
            "bombo": "drums_kick",
            "redoblante": "drums_snare",
            "toms": "drums_toms",
            "platillos": "drums_cymbals",
        },
    },
}

_download_lock = threading.Lock()


class ModelUnavailableError(RuntimeError):
    """追加のモデルを用意できなかったことを表す例外。

    ダウンロードの失敗（オフラインなど）と、落としたファイルのハッシュの不一致で送出する。
    メッセージは、そのまま利用者に見せられる文にしてある。
    """


def _spec(name):
    """モデルの定義を返す。知らない名前なら KeyError。"""
    if name not in ADDON_MODELS:
        raise KeyError(name)
    return ADDON_MODELS[name]


def model_path(name):
    """モデルのファイルの置き場を返す。

    Args:
        name: モデル名（``ADDON_MODELS`` のキー）。

    Returns:
        pathlib.Path: ファイルのパス。存在の保証はしない。

    Raises:
        KeyError: 知らないモデル名の場合。
    """
    import audio_utils

    return audio_utils.models_dir() / _spec(name)["file"]


def model_url(name):
    """モデルのダウンロード元の URL を返す。

    環境変数 ``BUNRI_MODEL_BASE_URL`` が在ればそれを、無ければ既定の配布元を使う。
    呼び出しのたびに読む。

    Args:
        name: モデル名。

    Returns:
        str: URL。

    Raises:
        KeyError: 知らないモデル名の場合。
    """
    base = os.environ.get("BUNRI_MODEL_BASE_URL") or DEFAULT_BASE_URL
    return base.rstrip("/") + "/" + _spec(name)["file"]


def is_cached(name):
    """モデルが手元に在るかを返す。

    速さのため、ここではファイルの大きさだけを見る（ハッシュはダウンロードの直後に照合済み）。

    Args:
        name: モデル名。

    Returns:
        bool: 在れば True。

    Raises:
        KeyError: 知らないモデル名の場合。
    """
    path = model_path(name)
    return path.is_file() and path.stat().st_size == _spec(name)["size"]


def model_status(name):
    """モデルが手元に揃っているかを、``model_cache.model_status`` と同じ形で返す。

    Args:
        name: モデル名。

    Returns:
        dict: ``{"model": 名前, "cached": 在るか, "missing": 足りないファイル数}``。

    Raises:
        KeyError: 知らないモデル名の場合。
    """
    cached = is_cached(name)
    return {"model": name, "cached": cached, "missing": 0 if cached else 1}


def _http_fetch(url, dest):
    """URL の中身を ``dest`` に書き出す（リダイレクトを追う）。

    Args:
        url: 取りに行く URL。
        dest: 書き出し先のパス。

    Raises:
        Exception: 接続できない、または 2xx 以外が返った場合（httpx の例外）。
    """
    import httpx

    with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0)) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for block in resp.iter_bytes(1 << 20):
                f.write(block)


def _sha256_of(path):
    """ファイルの SHA-256 を 16 進数の文字列で返す。"""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_model(name, fetch=None):
    """モデルが手元に無ければダウンロードし、ファイルのパスを返す。

    落としたファイルは、SHA-256 が定義と一致したときだけ置く。同時に呼ばれても、
    ダウンロードは 1 つずつ通す（あとから来たほうは、先のものが置いたファイルを使う）。

    Args:
        name: モデル名。
        fetch: ``fetch(url, dest)`` の形の関数。None なら HTTP で取りに行く。テスト用。

    Returns:
        pathlib.Path: モデルのファイルのパス。

    Raises:
        KeyError: 知らないモデル名の場合。
        ModelUnavailableError: ダウンロードできなかった、またはハッシュが合わなかった場合。
    """
    spec = _spec(name)
    path = model_path(name)
    with _download_lock:
        if is_cached(name):
            return path
        part = path.with_name(path.name + ".part")
        url = model_url(name)
        print(f"[モデル] {name} をダウンロードします（約 {spec['size'] // (1 << 20)} MB）: {url}")
        try:
            (fetch or _http_fetch)(url, part)
        except Exception as e:
            part.unlink(missing_ok=True)
            raise ModelUnavailableError(
                "分離用の追加モデルをダウンロードできませんでした。ネットワークの接続を確かめてください。"
                f"（{type(e).__name__}）"
            ) from e
        actual = _sha256_of(part)
        if actual != spec["sha256"]:
            part.unlink(missing_ok=True)
            raise ModelUnavailableError(
                "ダウンロードした追加モデルが、想定のファイルと一致しませんでした。使わずに破棄しました。"
            )
        os.replace(part, path)
        return Path(path)
