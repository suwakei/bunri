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

PIANO = json.loads(Path(__file__).with_name("instrument_catalog.json").read_text())["salamander"]
_install_lock = threading.Lock()
_BLOCK = 1 << 20
_MAX_EXPANDED = 4 * 1024 ** 3


class InstrumentUnavailableError(RuntimeError):
    """楽器の素材を用意できなかった理由。利用者にそのまま見せられる。"""


def piano_dir():
    """固定した版のピアノの置き場を返す。存在の保証はしない。"""
    from audio_utils import data_dir

    return data_dir() / "instruments" / "salamander" / PIANO["version"]


def piano_status():
    """準備できているかと、取得前に見せる容量・出典・ライセンスを返す。"""
    folder = piano_dir()
    installed = False
    try:
        marker = json.loads((folder / ".installed.json").read_text())
        installed = (
            marker == {"version": PIANO["version"], "sha256": PIANO["sha256"]}
            and (folder / PIANO["sfz"]).is_file()
            and (folder / "LICENSE").is_file()
            and (folder / "Samples").is_dir()
            and (folder / "Data").is_dir()
        )
    except (OSError, ValueError):
        pass
    return {
        "id": PIANO["id"], "name": PIANO["name"], "installed": installed,
        "downloadBytes": PIANO["size"], "license": PIANO["license"],
        "author": PIANO["author"], "sourceUrl": PIANO["sourceUrl"],
    }


def _check(job):
    """ジョブが在れば中止の要求を確かめる。"""
    if job is not None:
        job.check_cancelled()


def _download(dest, job):
    """途中までの素材が在れば Range で続きを取得する。非対応なら最初から取り直す。"""
    import httpx

    done = dest.stat().st_size if dest.exists() else 0
    if done > PIANO["size"]:
        dest.unlink()
        done = 0
    if done == PIANO["size"]:
        return
    url = PIANO["url"]
    headers = {"Range": f"bytes={done}-"} if done else {}
    with httpx.stream("GET", url, headers=headers, follow_redirects=True,
                      timeout=httpx.Timeout(30.0, read=120.0)) as response:
        response.raise_for_status()
        if response.status_code == 206:
            content_range = response.headers.get("Content-Range", "")
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if not match or int(match[1]) != done or int(match[3]) != PIANO["size"]:
                raise InstrumentUnavailableError("ピアノ音源の続きの取得に失敗しました。もう一度お試しください")
        elif response.status_code == 200:
            done = 0
        else:
            raise InstrumentUnavailableError("ピアノ音源を取得できませんでした。もう一度お試しください")
        with dest.open("ab" if done else "wb") as target:
            for block in response.iter_bytes(_BLOCK):
                _check(job)
                done += len(block)
                if done > PIANO["size"]:
                    raise InstrumentUnavailableError("ピアノ音源の容量が想定と異なります。取得を中止しました")
                target.write(block)
                if job is not None:
                    job.set_progress(done / PIANO["size"])


def _verify(archive, job):
    """配布物全体の容量と SHA-256 を照合する。"""
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        for block in iter(lambda: source.read(_BLOCK), b""):
            _check(job)
            digest.update(block)
    if archive.stat().st_size != PIANO["size"] or digest.hexdigest() != PIANO["sha256"]:
        archive.unlink(missing_ok=True)
        raise InstrumentUnavailableError("ピアノ音源が想定のファイルと一致しませんでした。使わずに破棄しました")


def _extract(archive, folder, job):
    """ZIP の外へ書かず、リンクを受け付けずに単一のルートを除いて展開する。"""
    with zipfile.ZipFile(archive) as package:
        members = package.infolist()
        if len(members) > 20_000 or sum(item.file_size for item in members) > _MAX_EXPANDED:
            raise InstrumentUnavailableError("ピアノ音源の展開後の容量が大きすぎます")
        root = None
        seen = set()
        for item in members:
            _check(job)
            path = PurePosixPath(item.filename)
            mode = item.external_attr >> 16
            if (path.is_absolute() or ".." in path.parts or "\\" in item.filename or ":" in item.filename
                    or not path.parts or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                raise InstrumentUnavailableError("ピアノ音源に展開できないファイルが含まれています")
            if root is None:
                root = path.parts[0]
            if root != path.parts[0]:
                raise InstrumentUnavailableError("ピアノ音源のフォルダの構成が想定と異なります")
            if len(path.parts) == 1:
                if not item.is_dir():
                    raise InstrumentUnavailableError("ピアノ音源のフォルダの構成が想定と異なります")
                continue
            relative = PurePosixPath(*path.parts[1:])
            if relative in seen:
                raise InstrumentUnavailableError("ピアノ音源に重複したファイルが含まれています")
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
        if not ((folder / PIANO["sfz"]).is_file() and (folder / "LICENSE").is_file()
                and any((folder / "Samples").glob("*.flac")) and (folder / "Data").is_dir()):
            raise InstrumentUnavailableError("ピアノ音源の素材が揃っていません")


def install_piano(job=None):
    """ピアノを明示的に取得し、検証・展開が完了した版だけを公開する。

    取得途中のファイルは中止・通信失敗のあとも残し、次の要求で続きを取得する。
    展開途中のファイルは必ず削除する。実音源を使う再生処理から自動では呼ばない。
    """
    with _install_lock:
        _check(job)
        if piano_status()["installed"]:
            return piano_status()
        folder = piano_dir()
        folder.parent.mkdir(parents=True, exist_ok=True)
        archive = folder.with_suffix(".zip.part")
        try:
            if job is not None:
                job.enter_stage("download")
            _download(archive, job)
            if job is not None:
                job.enter_stage("verify")
            _verify(archive, job)
            if job is not None:
                job.enter_stage("extract")
            with tempfile.TemporaryDirectory(prefix=".piano-", dir=folder.parent) as temporary:
                unpacked = Path(temporary) / "instrument"
                unpacked.mkdir()
                _extract(archive, unpacked, job)
                _check(job)
                (unpacked / ".installed.json").write_text(json.dumps({
                    "version": PIANO["version"], "sha256": PIANO["sha256"],
                }))
                # 未完了の古い版だけを置き換える。準備済みの版は入口で返している。
                if folder.exists():
                    shutil.rmtree(folder)
                os.replace(unpacked, folder)
            archive.unlink(missing_ok=True)
            return piano_status()
        except InstrumentUnavailableError:
            raise
        except Exception as error:
            raise InstrumentUnavailableError(
                "ピアノ音源を用意できませんでした。通信とディスクの空き容量を確かめ、もう一度お試しください"
            ) from error
