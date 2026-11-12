"""プロジェクトの保存と読み込み（`.bunri` v2）

画面のプロジェクト（トラック・ノート・音声・カルテ・学ぶ流れの状態・学習の記録）を 1 つの `.bunri` に
まとめて書き、開くときは画面に戻せる形（プロジェクトの文書）にして返す。ファイルの形は ``bunri_file``。

## sidecar が触るのはデータ置き場の中だけ

利用者が選んだ場所（``~/Documents/bunri/曲名.bunri`` など）のファイルを、sidecar は直接読み書きしない。

- 保存: 文書を ``work/<token>.bunri``（作業用の写し）に書き、その名前を返す。利用者の選んだ場所へ写すのは
  デスクトップ版では Rust（保存のダイアログで選ばれた場所だけ）、開発用のブラウザ起動では
  ``projects/`` へ写す（``library_save``）
- 開く: Rust（かブラウザ起動では ``library_open``）が ``work/<token>.bunri`` へ写したものを開く

こうすると、API の鍵（トークン）を持つ画面が乗っ取られても、sidecar 経由で任意の場所に書くことはできない。
理由と、検討して捨てた案は docs/desktop-architecture.md「プロジェクトのファイル」。

## 音声は 1 回だけ送る

画面は、音声の元のバイト列のハッシュを先に送り（``missing_audio``）、写しに無いものだけを送る
（``stage_audio``）。保存し直すときは、前の写しから同じハッシュの音声をそのまま写す（作り直さない）。
"""
import json
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

import audio_utils
import bunri_file

# 作業用の写しの名前（Rust も同じ形で作る。src-tauri/src/project.rs の TOKEN_LEN）
_TOKEN_RE = re.compile(r"^[0-9a-f]{24}$")
# ガイドと説明の保存の鍵（reproduction_guide.guide_key / coach_explain.explanation_key）
_CACHE_KEY_RE = re.compile(r"^[0-9a-f]{40}$")
_CACHE_KINDS = ("guide", "coach")

# 保存は 1 つずつ（同じ写しを 2 つの保存が読み書きしないように）
_save_lock = threading.Lock()

# 整理で消さない、新しいファイルの年齢（秒）。動いている処理が書いている途中のものを消さないため
CLEANUP_MIN_AGE_SEC = 5 * 60


class ProjectError(Exception):
    """プロジェクトの保存・読み込みの失敗。HTTP の状態コードと、利用者に見せる理由を持つ。"""

    def __init__(self, status, detail):
        """
        Args:
            status: HTTP の状態コード。
            detail: 利用者に見せる理由。
        """
        super().__init__(detail)
        self.status = int(status)
        self.detail = detail


def new_token():
    """作業用の写しの、新しい名前を返す。"""
    return secrets.token_hex(12)


def work_path(token):
    """作業用の写しのパスを返す。

    Args:
        token: 写しの名前（24 桁の 16 進）。

    Returns:
        pathlib.Path: ``work/<token>.bunri``。

    Raises:
        ProjectError: 名前の形が正しくない場合（400）。
    """
    if not isinstance(token, str) or not _TOKEN_RE.match(token):
        raise ProjectError(400, "プロジェクトの指定が正しくありません")
    return audio_utils.work_dir() / f"{token}.bunri"


def _staged_dir():
    return audio_utils.work_dir("staged")


def _staged_path(hash_):
    if not bunri_file.is_audio_hash(hash_):
        raise ProjectError(400, "音声の指定が正しくありません")
    return _staged_dir() / hash_


# ---- 音声の受け取り ----

def missing_audio(base, hashes):
    """保存に要る音声のうち、まだ受け取っていないものを返す。

    Args:
        base: いま開いている写しの名前（無ければ None）。その写しに在る音声は送らなくてよい。
        hashes: 文書が指している音声のハッシュ。

    Returns:
        list[str]: 送ってほしいハッシュ。

    Raises:
        ProjectError: ハッシュや写しの名前の形が正しくない場合（400）。
    """
    wanted = []
    for h in hashes or []:
        if not bunri_file.is_audio_hash(h):
            raise ProjectError(400, "音声の指定が正しくありません")
        if h not in wanted:
            wanted.append(h)
    have = bunri_file.audio_hashes_in(work_path(base)) if base else set()
    return [h for h in wanted if h not in have and not _staged_path(h).exists()]


def stage_audio(hash_, data, filename=None):
    """画面から受け取った音声を、保存まで預かる。中身がハッシュと合わなければ断る。

    Args:
        hash_: 画面が計算した、元のバイト列の SHA-256。
        data: 元のバイト列。
        filename: 元のファイル名（拡張子を、取り出すときに使う）。

    Raises:
        ProjectError: ハッシュの形が正しくない、または中身と合わない場合（400）。
    """
    path = _staged_path(hash_)
    if bunri_file.audio_hash(data) != hash_:
        raise ProjectError(400, "音声が途中で壊れました。もう一度保存してください")
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    name = Path(filename).name if isinstance(filename, str) and filename else None
    path.with_suffix(".json").write_text(json.dumps({"filename": name}, ensure_ascii=False), encoding="utf-8")


def _staged_name(hash_):
    try:
        return json.loads(_staged_path(hash_).with_suffix(".json").read_text(encoding="utf-8")).get("filename")
    except (OSError, ValueError):
        return None


# ---- 保存 ----

def _cached_entries(doc):
    """文書に入れる、ガイドと説明の写し（``(種類, 鍵, 中身)``）を集める。

    - ガイド: カルテから、いまのモデルと設定での鍵（曲全体と各セクション）を作り、保存済みのものを入れる
    - 説明: 文書の ``explanations.coach``（学習の記録と、いまの差分チェックが指している説明の鍵）
    """
    import guide_cache

    wanted = []
    chart = (doc.get("chart") or {}).get("chart") if isinstance(doc.get("chart"), dict) else None
    if isinstance(chart, dict):
        try:
            import reproduction_guide

            wanted += [("guide", key) for key in reproduction_guide.cache_keys_for(chart)]
        except Exception:
            # ガイドの写しが入らなくても、保存はできる (開き直したときに作り直せる)
            pass
    explanations = doc.get("explanations") if isinstance(doc.get("explanations"), dict) else {}
    for kind in _CACHE_KINDS:
        for key in explanations.get(kind) or []:
            wanted.append((kind, key))

    out, seen = [], set()
    for kind, key in wanted:
        if (kind, key) in seen or not isinstance(key, str) or not _CACHE_KEY_RE.match(key):
            continue
        seen.add((kind, key))
        entry = guide_cache.load(key, kind=kind)
        if entry:
            out.append((kind, key, entry))
    return out


def save_document(doc, base=None, app_version="0.1.0"):
    """プロジェクトの文書を、新しい作業用の写しに書く。

    Args:
        doc: プロジェクトの文書。
        base: いま開いている写しの名前（無ければ None）。同じ音声はそこから写す。
        app_version: アプリの版。

    Returns:
        dict: ``{"token": 新しい写しの名前, "size_bytes": 大きさ, "audio_count": 音声の数,
        "duration_sec": かかった時間}``。

    Raises:
        ProjectError: 文書の形が正しくない、音声が揃っていない場合（400）。
    """
    started = time.monotonic()
    if not isinstance(doc, dict):
        raise ProjectError(400, "プロジェクトの形が正しくありません")
    base_path = work_path(base) if base else None
    with _save_lock:
        token = new_token()
        path = work_path(token)
        tmp = path.with_suffix(".tmp")
        used_staged = []

        def blobs(conn, hashes):
            got = bunri_file.copy_blobs(conn, base_path, hashes) if base_path else set()
            for h in hashes:
                if h in got:
                    continue
                staged = _staged_path(h)
                if not staged.exists():
                    continue
                bunri_file.insert_audio(conn, staged.read_bytes(), _staged_name(h), expected_hash=h)
                used_staged.append(h)
            conn.commit()

        try:
            bunri_file.write_project(tmp, doc, blobs, app_version=app_version, cached=_cached_entries(doc))
        except bunri_file.BunriFileError as e:
            raise ProjectError(400, str(e))
        tmp.replace(path)
        for h in used_staged:
            _staged_path(h).unlink(missing_ok=True)
            _staged_path(h).with_suffix(".json").unlink(missing_ok=True)
    return {
        "token": token,
        "size_bytes": path.stat().st_size,
        "audio_count": len(bunri_file.document_audio_hashes(doc)),
        "duration_sec": round(time.monotonic() - started, 3),
    }


# ---- 開く ----

def _safe_chart_id(chart, token):
    """カルテの ID（``results/charts/<id>.bunri`` の名前）を決める。"""
    raw = chart.get("chartId") or Path(chart.get("audioName") or "").stem or f"project_{token}"
    name = re.sub(r"[\\/\x00:]", "_", str(raw)).strip(". ") or f"project_{token}"
    return name[:120]


def _restore_chart(path, chart, token):
    """開いたプロジェクトのカルテを、カルテの API（再計算・ガイド・説明）が使う置き場へ置き直す。

    カルテは作り直さない（解析しない）。中身と元音声をそのまま ``results/charts/<id>.bunri`` に書く。
    波形のピークを持っていない（カルテだけの古いファイル）ときだけ、元音声から作る（解析ではなく間引くだけ）。
    """
    chart_id = _safe_chart_id(chart, token)
    chart["chartId"] = chart_id
    audio = bunri_file.read_audio(path, chart["audio"]) if chart.get("audio") else None
    target = audio_utils.safe_join(audio_utils.results_dir("charts"), f"{chart_id}.bunri")
    name = None
    if audio is not None:
        data, _media, ext = audio
        name = Path(chart.get("audioName") or "audio").stem + ext
        bunri_file.create(target, chart["chart"], audio_data=(name, data))
    else:
        bunri_file.create(target, chart["chart"])
    if not chart.get("peaks") and audio is not None:
        import song_chart

        extracted = audio_utils.safe_join(audio_utils.results_dir("charts", "audio"), name)
        extracted.write_bytes(audio[0])
        try:
            chart["peaks"] = song_chart.waveform_peaks(str(extracted))
        except Exception:
            chart["peaks"] = None


def _restore_cached(entries):
    """文書に入っていたガイドと説明の写しを、保存の置き場へ戻す（無いものだけ）。"""
    import guide_cache

    restored = {"guide": 0, "coach": 0}
    for item in entries or []:
        kind, key, entry = item.get("kind"), item.get("key"), item.get("entry")
        if kind not in _CACHE_KINDS or not isinstance(key, str) or not _CACHE_KEY_RE.match(key):
            continue
        if guide_cache.load(key, kind=kind) is None and isinstance(entry, dict):
            try:
                guide_cache.save(key, entry, kind=kind)
            except OSError:
                continue
        restored[kind] += 1
    return restored


def open_document(token):
    """作業用の写しを開き、プロジェクトの文書を返す。

    - 古い版（カルテだけの v1）なら、写しを v2 に上げる（利用者のファイルは書き換えない）
    - カルテが在れば、カルテの API が使う置き場へ置き直す（解析はしない）
    - ガイドと説明の写しを、保存の置き場へ戻す（開き直しても Claude を呼ばずに出せる）

    Args:
        token: 写しの名前。

    Returns:
        dict: プロジェクトの文書に ``token`` と ``audioBase``（音声を取る URL の頭）、
        ``restored``（戻したガイドと説明の数）を足したもの。

    Raises:
        ProjectError: 写しが無い（404）、bunri の形式でない・新しすぎる（400）場合。
    """
    path = work_path(token)
    if not path.is_file():
        raise ProjectError(404, "開くプロジェクトが見つかりません")
    try:
        before = bunri_file.migrate(path)
        doc = bunri_file.read_project(path)
    except bunri_file.BunriFileError as e:
        raise ProjectError(400, str(e))
    restored = _restore_cached(doc.pop("cached", []))
    if isinstance(doc.get("chart"), dict):
        _restore_chart(path, doc["chart"], token)
    doc["token"] = token
    doc["audioBase"] = f"/api/project/{token}/audio/"
    doc["restored"] = restored
    doc["formatBefore"] = before
    return doc


def read_audio(token, hash_):
    """写しの音声を 1 つ返す。

    Raises:
        ProjectError: 写しか音声が無い場合（404）。
    """
    path = work_path(token)
    if not path.is_file():
        raise ProjectError(404, "プロジェクトが見つかりません")
    audio = bunri_file.read_audio(path, hash_)
    if audio is None:
        raise ProjectError(404, "音声が見つかりません")
    return audio


# ---- 開発用のブラウザ起動での置き場（projects/）と、以前の形式 ----

def _display_name(name):
    """利用者が付けた名前を、ファイル名に使える形にする。"""
    text = re.sub(r"[\\/\x00-\x1f:*?\"<>|]", "_", str(name or "")).strip(" .")
    return text[:80] or "無題のプロジェクト"


def library_list():
    """``projects/`` に在るプロジェクト（`.bunri`）と以前の形式（JSON）の一覧を、新しい順に返す。

    Returns:
        list[dict]: ``{"file", "name", "kind": "bunri" | "legacy", "modified": 秒, "size_bytes"}``。
    """
    items = []
    for p in audio_utils.projects_dir().iterdir():
        if not p.is_file() or p.suffix not in (".bunri", ".json"):
            continue
        st = p.stat()
        items.append({
            "file": p.name, "name": p.stem, "kind": "bunri" if p.suffix == ".bunri" else "legacy",
            "modified": st.st_mtime, "size_bytes": st.st_size,
        })
    items.sort(key=lambda x: x["modified"], reverse=True)
    return items


def library_save(token, name, file=None):
    """作業用の写しを ``projects/`` に置く（開発用のブラウザ起動の「保存」）。

    Args:
        token: 写しの名前。
        name: 利用者が付けた名前（``file`` が無いとき）。同じ名前が在れば「名前 (2)」にする。
        file: 上書きする既存のファイル名（保存し直すとき）。

    Returns:
        dict: ``{"file", "name"}``。

    Raises:
        ProjectError: 写しが無い（404）、名前が正しくない（400）場合。
    """
    src = work_path(token)
    if not src.is_file():
        raise ProjectError(404, "保存するプロジェクトが見つかりません")
    base = audio_utils.projects_dir()
    if file:
        if not str(file).endswith(".bunri"):
            raise ProjectError(400, "上書きできるのは .bunri だけです")
        try:
            dst = audio_utils.safe_join(base, file)
        except ValueError as e:
            raise ProjectError(400, str(e))
    else:
        stem = _display_name(name)
        dst = audio_utils.safe_join(base, f"{stem}.bunri")
        n = 2
        while dst.exists():
            dst = audio_utils.safe_join(base, f"{stem} ({n}).bunri")
            n += 1
    tmp = dst.with_name(f".{dst.name}.tmp")
    shutil.copyfile(src, tmp)
    tmp.replace(dst)
    return {"file": dst.name, "name": dst.stem}


def library_open(file):
    """``projects/`` のプロジェクトを開く。`.bunri` なら作業用の写しを作り、以前の形式なら文書にして返す。

    Args:
        file: ``projects/`` 直下のファイル名。

    Returns:
        dict: `.bunri` なら ``{"token"}``、以前の形式なら ``{"document"}``。

    Raises:
        ProjectError: 名前が正しくない（400）、無い（404）場合。
    """
    try:
        src = audio_utils.safe_join(audio_utils.projects_dir(), file)
    except ValueError as e:
        raise ProjectError(400, str(e))
    if not src.is_file():
        raise ProjectError(404, "プロジェクトが見つかりません")
    if src.suffix == ".json":
        try:
            data = json.loads(src.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise ProjectError(400, "以前の形式のプロジェクトを読めませんでした（ファイルが壊れています）")
        return {"document": legacy_document(data, src.stem)}
    if src.suffix != ".bunri":
        raise ProjectError(400, "開けるのは .bunri と以前の形式（.json）だけです")
    token = new_token()
    shutil.copyfile(src, work_path(token))
    return {"token": token}


def _notes(value):
    if not isinstance(value, list):
        return []
    out = []
    for n in value:
        if isinstance(n, dict) and isinstance(n.get("note"), str):
            out.append({"note": n["note"], "octave": int(n.get("octave") or 0), "step": int(n.get("step") or 0),
                        "length": max(1, int(n.get("length") or 1))})
    return out


def legacy_document(data, name):
    """以前の形式（``projects/*.json``。音声を持たない）を、プロジェクトの文書の形にする。

    クリップは位置と長さだけが残っているので、音声の無いクリップ（``audio: None``）にする。
    画面は「音声を読み込み直す」を出す。以前の版のオートメーションのデータは捨てる。

    Args:
        data: JSON を読んだ辞書。
        name: プロジェクトの名前（ファイル名から）。

    Returns:
        dict: プロジェクトの文書（``source.kind`` が ``"legacy"``）。
    """
    data = data if isinstance(data, dict) else {}
    tracks = []
    for t in data.get("tracks") or []:
        if not isinstance(t, dict):
            continue
        idx = t.get("practiceOfIndex")
        tracks.append({
            "name": t.get("name") if isinstance(t.get("name"), str) else "",
            "role": t.get("role") if t.get("role") in ("song", "part", "practice") else None,
            "part": t.get("part") if isinstance(t.get("part"), str) else None,
            "practiceOf": idx if isinstance(idx, int) and not isinstance(idx, bool) and idx >= 0 else None,
            "gain": float(t["gain"]) if isinstance(t.get("gain"), (int, float)) else 0.0,
            "pan": float(t["pan"]) if isinstance(t.get("pan"), (int, float)) else 0.0,
            "mute": t.get("mute") is True, "solo": False,
            "notes": _notes(t.get("pianoNotes")),
            "referenceNotes": _notes(t.get("referenceNotes")) if isinstance(t.get("referenceNotes"), list) else None,
            "clips": [
                {"name": c.get("name") if isinstance(c.get("name"), str) else "clip",
                 "offset": float(c.get("offset") or 0), "duration": float(c.get("duration") or 0), "audio": None}
                for c in t.get("clips") or [] if isinstance(c, dict)
            ],
            "extra": {},
        })
    if not tracks and isinstance(data.get("pianoRollNotes"), list):
        # もっと前の版: ピアノロールのノートが 1 列だけ
        tracks.append({"name": "Track 1", "role": None, "part": None, "practiceOf": None, "gain": 0.0, "pan": 0.0,
                       "mute": False, "solo": False, "notes": _notes(data["pianoRollNotes"]),
                       "referenceNotes": None, "clips": [], "extra": {}})
    return {
        "version": bunri_file.DOCUMENT_VERSION,
        "meta": {"name": name, "createdAt": None, "modifiedAt": None, "uuid": None, "appVersion": None},
        "grid": {
            "bpm": float(data["bpm"]) if isinstance(data.get("bpm"), (int, float)) and data["bpm"] > 0 else 120.0,
            "beatsPerBar": int(data["beatsPerBar"]) if isinstance(data.get("beatsPerBar"), int) else 4,
            "gridOffset": float(data["gridOffset"]) if isinstance(data.get("gridOffset"), (int, float)) else 0.0,
        },
        "tracks": tracks,
        "chart": None,
        "state": {},
        "history": [],
        "source": {"kind": "legacy", "file": f"{name}.json"},
    }


# ---- データの整理 ----

def _tree_size(path, skip=()):
    total, count = 0, 0
    if not path.exists():
        return 0, 0
    for p in path.rglob("*"):
        if any(p == s or s in p.parents for s in skip):
            continue
        if p.is_file():
            total += p.stat().st_size
            count += 1
    return total, count


def _categories():
    """データ置き場の中身の分類（整理の画面に出す順）。"""
    results = audio_utils.results_dir()
    keep_results = [results / "charts", results / "guide", results / "coach"]
    return [
        {"key": "uploads", "label": "取り込んだ音声の写し", "path": audio_utils.uploads_dir(), "skip": (),
         "cleanable": True},
        {"key": "results", "label": "作った音声（パート分離・加工・シンセの結果）", "path": results,
         "skip": tuple(keep_results), "cleanable": True},
        {"key": "charts", "label": "カルテの作業ファイル", "path": results / "charts", "skip": (), "cleanable": True},
        {"key": "work", "label": "作業中のプロジェクトの写し", "path": audio_utils.work_dir(), "skip": (),
         "cleanable": True},
        {"key": "claude", "label": "保存したガイドと説明（Claude の結果。消さない）", "path": results / "guide",
         "extra": results / "coach", "skip": (), "cleanable": False},
        {"key": "projects", "label": "アプリの中に保存したプロジェクトと以前の形式（消さない）",
         "path": audio_utils.projects_dir(), "skip": (), "cleanable": False},
    ]


def storage_usage():
    """データ置き場の使用量を、分類ごとに返す。

    Returns:
        dict: ``{"data_dir", "categories": [{"key", "label", "bytes", "files", "cleanable"}], "total_bytes"}``。
    """
    out = []
    for cat in _categories():
        size, count = _tree_size(cat["path"], cat["skip"])
        if cat.get("extra") is not None:
            s2, c2 = _tree_size(cat["extra"])
            size, count = size + s2, count + c2
        out.append({"key": cat["key"], "label": cat["label"], "bytes": size, "files": count,
                    "cleanable": cat["cleanable"]})
    return {"data_dir": str(audio_utils.data_dir()), "categories": out,
            "total_bytes": sum(c["bytes"] for c in out)}


def cleanup(keep_tokens=(), keep_charts=(), min_age_sec=CLEANUP_MIN_AGE_SEC, now=None):
    """作業用の一時ファイルを消す。

    消すのは、データ置き場の中の ``uploads/``・``results/`` の音声・カルテの作業ファイル・作業中の写し
    だけ。保存した `.bunri` は音声とカルテを中に持っているので、これらを消しても開ける。

    消さないもの:
    - いま開いているプロジェクトの写し（``keep_tokens``）と、いまのカルテ（``keep_charts``）
    - 新しいファイル（``min_age_sec`` 以内に書かれたもの。動いている処理が書いている途中かもしれない）
    - ガイドと説明の保存（Claude の結果。作り直すと費用がかかる）、使用量の記録
    - ``projects/``（アプリの中に保存したプロジェクトと以前の形式）
    - データ置き場の外のもの（利用者が選んだ場所の `.bunri` には、そもそも触らない）

    Args:
        keep_tokens: 残す写しの名前。
        keep_charts: 残すカルテの ID。
        min_age_sec: これより新しいファイルは残す。
        now: いまの時刻（テスト用）。

    Returns:
        dict: ``{"removed_files", "freed_bytes"}``。
    """
    now = time.time() if now is None else now
    keep = set()
    for token in keep_tokens or []:
        if isinstance(token, str) and _TOKEN_RE.match(token):
            keep.add(work_path(token).resolve())
    charts = audio_utils.results_dir("charts")
    for chart_id in keep_charts or []:
        try:
            keep.add(audio_utils.safe_join(charts, f"{chart_id}.bunri").resolve())
        except ValueError:
            continue
    removed, freed = 0, 0
    for cat in _categories():
        if not cat["cleanable"]:
            continue
        root = cat["path"]
        for p in sorted(root.rglob("*"), reverse=True):
            if any(p == s or s in p.parents for s in cat["skip"]):
                continue
            if p.is_dir():
                if p != root:
                    try:
                        p.rmdir()  # 空になったサブディレクトリだけ
                    except OSError:
                        pass
                continue
            resolved = p.resolve()
            if resolved in keep or not resolved.is_relative_to(audio_utils.data_dir()):
                continue
            st = p.stat()
            if now - st.st_mtime < min_age_sec:
                continue
            p.unlink(missing_ok=True)
            removed += 1
            freed += st.st_size
    return {"removed_files": removed, "freed_bytes": freed}
