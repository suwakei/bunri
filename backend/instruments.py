"""楽器の録音素材の取得。検証が済んだ版だけを再生に使える場所へ置く。"""
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import zipfile
from pathlib import Path, PurePosixPath

CATALOG = json.loads(Path(__file__).with_name("instrument_catalog.json").read_text())
PACKS = CATALOG["packs"]
INSTRUMENTS = CATALOG["instruments"]
_install_lock = threading.Lock()
_BLOCK = 1 << 20


class InstrumentUnavailableError(RuntimeError):
    """楽器の素材を用意できなかった理由。利用者にそのまま見せられる。"""


class InstrumentNotFoundError(LookupError):
    """カタログに無い楽器を指定されたことを表す。"""


def _instrument(instrument_id):
    """カタログにある楽器だけを返す。ID をパスとして解釈しない。"""
    if instrument_id not in INSTRUMENTS:
        raise InstrumentNotFoundError("楽器が見つかりません")
    return INSTRUMENTS[instrument_id]


def pack_dir(pack_id):
    """固定した版の素材の置き場を返す。存在の保証はしない。"""
    from audio_utils import data_dir

    return data_dir() / "instruments" / pack_id / PACKS[pack_id]["version"]


def _complete(folder, pack_id):
    """素材の必須ファイルと、その素材で提供するすべての楽器が揃っているかを返す。"""
    pack = PACKS[pack_id]
    return (
        all((folder / path).exists() for path in pack["requiredPaths"])
        and all((folder / instrument["sfz"]).is_file()
                for instrument in INSTRUMENTS.values() if instrument["pack"] == pack_id)
    )


def _installed(pack_id):
    """完了の目印と素材の両方が揃っているときだけ準備済みとする。"""
    pack = PACKS[pack_id]
    folder = pack_dir(pack_id)
    try:
        marker = json.loads((folder / ".installed.json").read_text())
        return (
            marker == {"version": pack["version"], "sha256": pack["sha256"]}
            and _complete(folder, pack_id)
        )
    except (OSError, ValueError):
        return False


def _status(instrument, installed):
    """楽器の情報に素材の準備状況を合わせて返す。"""
    pack = PACKS[instrument["pack"]]
    result = {
        "id": instrument["id"], "name": instrument["name"], "category": instrument["category"],
        "kind": "sampler", "packId": instrument["pack"], "installed": installed,
        "downloadBytes": pack["size"], "license": pack["license"],
        "author": pack["author"], "sourceUrl": pack["sourceUrl"],
    }
    if "description" in instrument:
        result["description"] = instrument["description"]
    return result


def instrument_status(instrument_id):
    """楽器の準備状況と、取得前に見せる容量・出典・ライセンスを返す。"""
    instrument = _instrument(instrument_id)
    return _status(instrument, _installed(instrument["pack"]))


def library_status():
    """楽器の一覧を返す。同じ素材の確認は一覧の中で一度だけ行う。"""
    ready = {pack_id: _installed(pack_id) for pack_id in {item["pack"] for item in INSTRUMENTS.values()}}
    return {"instruments": [_status(item, ready[item["pack"]]) for item in INSTRUMENTS.values()]}


def piano_dir():
    """旧版と同じグランドピアノの置き場を返す。"""
    return pack_dir("salamander")


def piano_status():
    """旧版のピアノ専用 API のための準備状況を返す。"""
    return instrument_status("salamander")


def _check(job):
    """ジョブが在れば中止の要求を確かめる。"""
    if job is not None:
        job.check_cancelled()


def _download(dest, job, pack):
    """途中までの素材が在れば Range で続きを取得する。非対応なら最初から取り直す。"""
    import httpx

    done = dest.stat().st_size if dest.exists() else 0
    if done > pack["size"]:
        dest.unlink()
        done = 0
    if done == pack["size"]:
        return
    url = pack["url"]
    headers = {"Range": f"bytes={done}-"} if done else {}
    with httpx.stream("GET", url, headers=headers, follow_redirects=True,
                      timeout=httpx.Timeout(30.0, read=120.0)) as response:
        response.raise_for_status()
        if response.status_code == 206:
            content_range = response.headers.get("Content-Range", "")
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if not match or int(match[1]) != done or int(match[3]) != pack["size"]:
                raise InstrumentUnavailableError("楽器の音源の続きの取得に失敗しました。もう一度お試しください")
        elif response.status_code == 200:
            done = 0
        else:
            raise InstrumentUnavailableError("楽器の音源を取得できませんでした。もう一度お試しください")
        with dest.open("ab" if done else "wb") as target:
            for block in response.iter_bytes(_BLOCK):
                _check(job)
                done += len(block)
                if done > pack["size"]:
                    raise InstrumentUnavailableError("楽器の音源の容量が想定と異なります。取得を中止しました")
                target.write(block)
                if job is not None:
                    job.set_progress(done / pack["size"])


def _verify(archive, job, pack):
    """配布物全体の容量と SHA-256 を照合する。"""
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        for block in iter(lambda: source.read(_BLOCK), b""):
            _check(job)
            digest.update(block)
    if archive.stat().st_size != pack["size"] or digest.hexdigest() != pack["sha256"]:
        archive.unlink(missing_ok=True)
        raise InstrumentUnavailableError("楽器の音源が想定のファイルと一致しませんでした。使わずに破棄しました")


def _extract(archive, folder, job, pack):
    """ZIP の外へ書かず、リンクを受け付けずに単一のルートを除いて展開する。"""
    with zipfile.ZipFile(archive) as package:
        members = package.infolist()
        if len(members) > 20_000 or sum(item.file_size for item in members) > pack["expandedBytes"]:
            raise InstrumentUnavailableError("楽器の音源の展開後の容量が大きすぎます")
        root = None
        seen = set()
        strip_root = pack.get("stripRoot", True)
        for item in members:
            _check(job)
            path = PurePosixPath(item.filename)
            mode = item.external_attr >> 16
            if (path.is_absolute() or ".." in path.parts or "\\" in item.filename or ":" in item.filename
                    or not path.parts or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                raise InstrumentUnavailableError("楽器の音源に展開できないファイルが含まれています")
            if strip_root:
                if root is None:
                    root = path.parts[0]
                if root != path.parts[0]:
                    raise InstrumentUnavailableError("楽器の音源のフォルダの構成が想定と異なります")
                if len(path.parts) == 1:
                    if not item.is_dir():
                        raise InstrumentUnavailableError("楽器の音源のフォルダの構成が想定と異なります")
                    continue
                relative = PurePosixPath(*path.parts[1:])
            else:
                relative = path
            if relative in seen:
                raise InstrumentUnavailableError("楽器の音源に重複したファイルが含まれています")
            seen.add(relative)
            target = folder.joinpath(*relative.parts)
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(item) as source, target.open("xb") as output:
                    while block := source.read(_BLOCK):
                        _check(job)
                        output.write(block)


def _prepare_pack(pack_id, folder, job):
    """同梱の楽器と、録音素材から派生するプリセットを用意する。"""
    from instrument_presets import prepare_pack

    prepare_pack(pack_id, folder, job=job)


def install_instrument(instrument_id, job=None):
    """楽器を明示的に取得し、検証・展開が完了した素材だけを公開する。

    取得途中のファイルは中止・通信失敗のあとも残し、次の要求で続きを取得する。
    展開途中のファイルは必ず削除する。実音源を使う再生処理から自動では呼ばない。
    """
    instrument = _instrument(instrument_id)
    pack_id = instrument["pack"]
    pack = PACKS[pack_id]
    with _install_lock:
        _check(job)
        if _installed(pack_id):
            return instrument_status(instrument_id)
        folder = pack_dir(pack_id)
        folder.parent.mkdir(parents=True, exist_ok=True)
        archive = folder.with_name(folder.name + ".zip.part")
        try:
            if job is not None:
                job.enter_stage("download")
            if not pack.get("builtin"):
                _download(archive, job, pack)
            if job is not None:
                job.enter_stage("verify")
            if not pack.get("builtin"):
                _verify(archive, job, pack)
            if job is not None:
                job.enter_stage("extract")
            with tempfile.TemporaryDirectory(prefix=".instrument-", dir=folder.parent) as temporary:
                unpacked = Path(temporary) / "instrument"
                unpacked.mkdir()
                if not pack.get("builtin"):
                    _extract(archive, unpacked, job, pack)
                _prepare_pack(pack_id, unpacked, job)
                _check(job)
                if not _complete(unpacked, pack_id):
                    raise InstrumentUnavailableError("楽器の音源の素材が揃っていません")
                (unpacked / ".installed.json").write_text(json.dumps({
                    "version": pack["version"], "sha256": pack["sha256"],
                }))
                # 未完了の古い版だけを置き換える。準備済みの版は入口で返している。
                if folder.exists():
                    shutil.rmtree(folder)
                os.replace(unpacked, folder)
            archive.unlink(missing_ok=True)
            return instrument_status(instrument_id)
        except InstrumentUnavailableError:
            raise
        except Exception as error:
            raise InstrumentUnavailableError(
                "楽器の音源を用意できませんでした。通信とディスクの空き容量を確かめ、もう一度お試しください"
            ) from error


def install_piano(job=None):
    """旧版のピアノ専用 API と同じ楽器を準備する。"""
    return install_instrument("salamander", job=job)
