"""再現ガイドの保存 — 同じ条件なら Claude を呼ばずに済ませる

再現ガイドは 1 回作るのに数十秒と費用がかかる。同じカルテ・同じ対象・同じモデル・同じ指示文なら
結果を作り直す理由が無いので、作ったガイドを ``results/guide/cache/`` に 1 件 1 ファイルで保存する。

- 鍵は ``reproduction_guide.guide_key`` が作る（カルテの正規化 JSON のハッシュ + 対象 + モデル +
  思考の深さ + 指示文と出力の形の指紋）。ここは鍵からファイルを引くだけ
- 同じカルテへの呼び出しを 1 つずつ通すための錠も、ここで持つ（``lock_for``）
"""
import hashlib
import json
import threading

import audio_utils

_locks = {}
_locks_guard = threading.Lock()


def chart_hash(chart):
    """カルテの指紋（正規化 JSON の SHA-256）を返す。

    Args:
        chart: 楽曲カルテ。

    Returns:
        str: 64 桁の 16 進文字列。カルテの中身が同じなら同じ値になる。
    """
    import song_chart

    return hashlib.sha256(song_chart.to_canonical_json(chart).encode("utf-8")).hexdigest()


def _path(key):
    return audio_utils.safe_join(audio_utils.results_dir("guide", "cache"), f"{key}.json")


def load(key):
    """保存したガイドを読む（無い・読めないときは None）。

    Args:
        key: ``reproduction_guide.guide_key`` の値。

    Returns:
        dict | None: 保存した 1 件。
    """
    try:
        entry = json.loads(_path(key).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return entry if isinstance(entry, dict) and isinstance(entry.get("guide"), dict) else None


def save(key, entry):
    """ガイドを保存する。同じ鍵が在れば置き換える。

    書きかけのファイルを読まれないよう、別名に書いてから置き換える。

    Args:
        key: ``reproduction_guide.guide_key`` の値。
        entry: 保存する 1 件（``guide`` を持つ辞書）。
    """
    path = _path(key)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(entry, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def lock_for(name):
    """名前ごとの錠を返す（同じ名前には、いつも同じ錠）。

    同じカルテへの呼び出しを同時に走らせないために使う。別のカルテ同士は待たせない。

    Args:
        name: 錠の名前（カルテの指紋）。

    Returns:
        threading.Lock: 錠。
    """
    with _locks_guard:
        return _locks.setdefault(name, threading.Lock())
