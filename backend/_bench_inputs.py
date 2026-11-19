"""同一区間の分離比較用入力を作る。音声は外部送信せず、新しい出力先だけに書く。"""
import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import zipfile

ARCHIVE_MD5 = "dc2bdfac5b46ce742bd60009866758a5"
DATASET_URL = "https://zenodo.org/records/3270814"
LICENSE_URL = "https://github.com/sigsep/website/blob/master/content/datasets/assets/tracklist.csv"
STEMS = ("drums", "bass", "other", "vocals")


def file_hash(path, algorithm="sha256"):
    """大きな音源もブロック単位で照合する。"""
    digest = hashlib.new(algorithm)
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def select_tracks(names):
    """test subset の安全なファイル名から辞書順先頭3曲を選ぶ。"""
    candidates = []
    for name in names:
        if not name.startswith("test/") or not name.lower().endswith(".mp4"):
            continue
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name or "\x00" in name:
            raise ValueError("アーカイブに安全でないパスがあります")
        candidates.append(name)
    if len(candidates) != len(set(candidates)) or len(candidates) < 3:
        raise ValueError("test subset に重複しない3曲以上が必要です")
    return sorted(candidates)[:3]


def _decode(source, destination, stream=None, start=None, seconds=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = ["ffmpeg", "-nostdin", "-v", "error"]
    if start is not None:
        command += ["-ss", str(start)]
    command += ["-i", str(source)]
    if stream is not None:
        command += ["-map", f"0:a:{stream}"]
    if seconds is not None:
        command += ["-t", str(seconds)]
    command += ["-ar", "44100", "-ac", "2", "-c:a", "pcm_f32le", "-n", str(destination)]
    subprocess.run(command, check=True, capture_output=True)


def prepare_inputs(local_file, public_archive, output_dir):
    """検証済みの公開サンプルと手元の音源から5ケースと来歴を生成する。"""
    import numpy as np
    import soundfile as sf

    local_file, public_archive, output_dir = map(Path, (local_file, public_archive, output_dir))
    if output_dir.exists() or output_dir.is_symlink():
        raise FileExistsError("出力先は既にあります。新しい場所を指定してください")
    if file_hash(public_archive, "md5") != ARCHIVE_MD5:
        raise ValueError("公式サンプルの MD5 が一致しません")
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json",
                            str(local_file)], check=True, capture_output=True, text=True)
    duration = float(json.loads(probe.stdout)["format"]["duration"])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("音源の長さを取得できませんでした")
    manifest = {"version": 1, "selection": "手元の音源は30秒と90秒開始の各15秒。短い曲は末尾に調整。公開音源はtest辞書順先頭3曲。結果で選び直さない。",
                "dataset": {"record_url": DATASET_URL, "md5": ARCHIVE_MD5, "sha256": file_hash(public_archive),
                            "license_list_url": LICENSE_URL, "license_note": "先頭3曲の公式欄はRestricted。学術比較用。音声は再配布しない。",
                            "aac_note": "別エンコードの混合と参照和に差がある。HQの評価と同条件ではない。"}, "cases": []}

    def inspect(path):
        info = sf.info(path)
        return {"path": str(path.relative_to(output_dir)), "sha256": file_hash(path), "frames": info.frames,
                "sample_rate": info.samplerate, "channels": info.channels, "subtype": info.subtype}

    with zipfile.ZipFile(public_archive) as archive:
        selected = select_tracks(archive.namelist())
        output_dir.mkdir(parents=True, exist_ok=False)
        try:
            for requested in (30, 90):
                start, length = min(requested, max(0, duration - 15)), min(15, duration)
                case_id = f"local-game-{requested:03d}"
                destination = output_dir / case_id / "mixture.wav"
                _decode(local_file, destination, start=start, seconds=length)
                manifest["cases"].append({"id": case_id, "source_type": "local_game_music", "ground_truth": False,
                                          "source_filename": local_file.name, "source_sha256": file_hash(local_file),
                                          "start_sec": start, "duration_sec": length, "mixture": inspect(destination),
                                          "license_note": "利用者の手元の音源。元音声も分離出力も外部送信・再配布しない。"})
            with tempfile.TemporaryDirectory(prefix="bunri-bench-inputs-") as temporary:
                for index, name in enumerate(selected, 1):
                    source = Path(temporary) / "source.mp4"
                    with archive.open(name) as member, source.open("wb") as target:
                        shutil.copyfileobj(member, target)
                    case_id = f"musdb-test-{index:02d}"
                    case = output_dir / case_id
                    _decode(source, case / "mixture.wav", stream=0)
                    references, arrays = {}, []
                    for stream, stem in enumerate(STEMS, 1):
                        path = case / "references" / f"{stem}.wav"
                        _decode(source, path, stream=stream)
                        references[stem] = inspect(path)
                        arrays.append(sf.read(path, dtype="float32", always_2d=True)[0])
                    mixture, rate = sf.read(case / "mixture.wav", dtype="float32", always_2d=True)
                    if len({array.shape for array in arrays + [mixture]}) != 1:
                        raise ValueError("混合と参照パートの長さが一致しません")
                    linear = np.sum(np.stack(arrays).astype(np.float64), axis=0).astype(np.float32)
                    sf.write(case / "linear-mixture.wav", linear, rate, subtype="FLOAT")
                    error = mixture.astype(np.float64) - linear
                    ratio = np.mean(error ** 2) / (np.mean(mixture.astype(np.float64) ** 2) + 1e-30)
                    manifest["cases"].append({"id": case_id, "source_type": "musdb18_test_excerpt", "ground_truth": True,
                        "archive_member": name, "source_sha256": file_hash(source), "duration_sec": len(mixture) / rate,
                        "mixture": inspect(case / "mixture.wav"), "references": references,
                        "linear_mixture": inspect(case / "linear-mixture.wav"),
                        "aac_mix_minus_reference_sum_rms_db": float(10 * np.log10(max(ratio, 1e-30))),
                        "known_reference_issue": "公式errata: synth vocals mixed into other" if "Al James - Schoolboy Facination" in name else None})
            (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        except BaseException:
            shutil.rmtree(output_dir)
            raise
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-file", type=Path, required=True)
    parser.add_argument("--public-archive", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    prepare_inputs(args.local_file, args.public_archive, args.output_dir)


if __name__ == "__main__":
    main()
