"""同じ音源で分離モデルと実行基盤を比較する。アプリ本体の依存は変更しない。"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

STEMS = ("vocals", "drums", "bass", "other")
METRIC_VERSION = 2


def file_hash(path):
    """入力やモデルの同一性を確認するSHA-256。中身をログには出さない。"""
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_audio(path, sample_rate=None):
    """左右と振幅を保って読み、必要な場合だけ評価用のレートへ変換する。"""
    import numpy as np
    import soundfile as sf

    audio, rate = sf.read(path, always_2d=True, dtype="float64")
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError(f"空または非有限の音声: {Path(path).name}")
    if sample_rate is not None and rate != sample_rate:
        from scipy.signal import resample_poly
        divisor = math.gcd(rate, sample_rate)
        audio = resample_poly(audio, sample_rate // divisor, rate // divisor, axis=0)
        rate = sample_rate
    return audio, rate


def ratio_db(numerator, denominator):
    """無音や完全一致でもJSONにInfinityを出さない有限のdB値。"""
    return float(10 * math.log10(max(float(numerator), 1e-20) / max(float(denominator), 1e-20)))


def reference_metrics(reference, estimate):
    """音量を合わせず誤差を測る。SI-SDRは補助とし音量誤差を別に残す。"""
    import numpy as np

    ref = np.asarray(reference, dtype=np.float64)
    est = np.asarray(estimate, dtype=np.float64)
    if ref.shape != est.shape:
        raise ValueError("参照と推定の長さ・チャンネルが一致しません")
    energy = float(np.sum(ref * ref))
    if energy < 1e-15:
        return {"reference_silent": True, "estimate_rms_dbfs": ratio_db(np.mean(est * est), 1)}
    gain = float(np.sum(ref * est) / energy)
    projection = gain * ref
    silent = float(np.sum(est * est)) < 1e-20
    return {
        "reference_silent": False,
        "estimate_silent": silent,
        "waveform_sdr_db": ratio_db(energy, np.sum((ref - est) ** 2)),
        "si_sdr_db": None if silent else ratio_db(np.sum(projection ** 2), np.sum((est - projection) ** 2)),
        "rms_level_error_db": ratio_db(np.sum(est ** 2), energy),
        "projection_gain_db": 20 * math.log10(max(abs(gain), 1e-10)),
        "polarity_inverted": gain < 0,
    }


def evaluate(input_path, output_dir, references=None):
    """4パートへ統一して評価する。6パート版のギター・ピアノはその他へ足す。"""
    import numpy as np

    mixture, rate = read_audio(input_path)
    paths = {name: Path(output_dir) / f"{name}.wav" for name in STEMS}
    outputs = {}
    for name, path in paths.items():
        audio, _ = read_audio(path, rate)
        # リサンプル丸めの1サンプルだけは末尾をそろえ、時間ずれは補正しない。
        if audio.shape[1] != mixture.shape[1] or abs(len(audio) - len(mixture)) > 1:
            raise ValueError(f"出力の長さ・左右が入力と一致しません: {name}")
        if len(audio) < len(mixture):
            audio = np.pad(audio, ((0, 1), (0, 0)))
        outputs[name] = audio[:len(mixture)]
    merged = []
    for name in ("guitar", "piano"):
        path = Path(output_dir) / f"{name}.wav"
        if path.exists():
            audio, _ = read_audio(path, rate)
            if audio.shape[1] != mixture.shape[1] or abs(len(audio) - len(mixture)) > 1:
                raise ValueError(f"追加パートの長さ・左右が一致しません: {name}")
            if len(audio) < len(mixture):
                audio = np.pad(audio, ((0, 1), (0, 0)))
            outputs["other"] += audio[:len(mixture)]
            merged.append(name)
    summed = sum(outputs.values())
    per_stem = {}
    for name, audio in outputs.items():
        values = {
            "rms_dbfs": ratio_db(np.mean(audio * audio), 1),
            "peak": float(np.max(np.abs(audio))),
        }
        if references:
            ref, _ = read_audio(Path(references) / f"{name}.wav", rate)
            if ref.shape != audio.shape:
                raise ValueError(f"正解音声の長さ・左右が一致しません: {name}")
            values["reference"] = reference_metrics(ref, audio)
        per_stem[name] = values
    return {
        "metric_version": METRIC_VERSION,
        "sample_rate": rate,
        "duration_seconds": len(mixture) / rate,
        "channels": mixture.shape[1],
        "merged_into_other": merged,
        "reconstruction_error_db": ratio_db(np.sum((summed - mixture) ** 2), np.sum(mixture * mixture)),
        "reconstruction_level_error_db": ratio_db(np.sum(summed ** 2), np.sum(mixture ** 2)),
        "has_references": bool(references),
        "stems": per_stem,
    }


def measured_run(command, log_path, timeout):
    """モデルを一つずつ別プロセスで動かし、経過時間とプロセスの最大RSSを測る。"""
    started = time.perf_counter()
    timed_out = threading.Event()
    with open(log_path, "wb") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name == "posix")

        def stop():
            timed_out.set()
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass

        timer = threading.Timer(timeout, stop)
        timer.start()
        try:
            if hasattr(os, "wait4"):
                _, status, usage = os.wait4(process.pid, 0)
                process.returncode = os.waitstatus_to_exitcode(status)
                rss = usage.ru_maxrss / (1024 ** 2 if sys.platform == "darwin" else 1024)
            else:
                process.wait()
                rss = None
        finally:
            timer.cancel()
    return {
        "elapsed_seconds": time.perf_counter() - started,
        "peak_rss_mib": rss,
        "returncode": process.returncode,
        "timed_out": timed_out.is_set(),
    }


def run_manifest(manifest_path, destination, timeout=1800, resume=False):
    """宣言したコマンドへ同じWAVを渡す。shellは使わず、失敗も記録して次へ進む。"""
    from audio_utils import safe_join

    manifest_path = Path(manifest_path).resolve()
    manifest = json.loads(manifest_path.read_text())
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    records = []
    for case in manifest["cases"]:
        input_path = Path(case["input"]).resolve()
        references = case.get("references")
        case_dir = safe_join(destination, case["id"])
        case_dir.mkdir(exist_ok=True)
        for candidate in manifest["candidates"]:
            output_dir = safe_join(case_dir, candidate["id"])
            output_dir.mkdir(exist_ok=True)
            command = [arg.replace("{input}", str(input_path)).replace("{output_dir}", str(output_dir))
                       for arg in candidate["command"]]
            fingerprint = {"input_sha256": file_hash(input_path), "command": command,
                           "metric_version": METRIC_VERSION, "candidate": candidate,
                           "runner_sha256": {arg: file_hash(arg) for arg in command if arg.endswith(".py") and Path(arg).is_file()},
                           "references": {name: file_hash(Path(references) / f"{name}.wav") for name in STEMS} if references else None}
            record_path = output_dir / "benchmark.json"
            if resume and record_path.exists():
                cached = json.loads(record_path.read_text())
                hashes = cached.get("output_sha256", {})
                intact = bool(hashes) and all((output_dir / name).is_file() and file_hash(output_dir / name) == digest
                                              for name, digest in hashes.items())
                if cached.get("fingerprint") == fingerprint and cached.get("status") == "done" and intact:
                    records.append(cached)
                    continue
            record = {"case": case["id"], "candidate": candidate["id"], "fingerprint": fingerprint,
                      "device": candidate.get("device"), "output_dir": str(output_dir)}
            print(f"比較中: {case['id']} / {candidate['id']}", flush=True)
            try:
                # 前回の6パート結果を4パートの再実行へ混ぜない。自分の出力だけを消す。
                for name in (*STEMS, "guitar", "piano"):
                    (output_dir / f"{name}.wav").unlink(missing_ok=True)
                (output_dir / "metadata.json").unlink(missing_ok=True)
                record["process"] = measured_run(command, output_dir / "process.log", timeout)
                if record["process"]["returncode"]:
                    raise RuntimeError("分離プロセスが失敗しました。process.logを確認してください")
                record["metrics"] = evaluate(input_path, output_dir, references)
                metadata_path = output_dir / "metadata.json"
                record["metadata"] = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
                record["output_sha256"] = {f"{name}.wav": file_hash(output_dir / f"{name}.wav")
                                           for name in (*STEMS, "guitar", "piano") if (output_dir / f"{name}.wav").is_file()}
                record["status"] = "done"
            except Exception as error:
                record["status"] = "error"
                record["error"] = str(error)
            record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
            records.append(record)
            (destination / "report.json").write_text(json.dumps(records, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    (destination / "report.json").write_text(json.dumps(records, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    write_report(records, manifest, destination)
    return records


def write_report(records, manifest, destination):
    """実音源を埋め込まず、ローカルの比較音声と指標を開けるHTMLを作る。"""
    from urllib.parse import quote
    destination = Path(destination)
    summary = summarize(records)
    (destination / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False) + "\n")

    def player(path, label):
        relative = os.path.relpath(path, destination)
        return f'<p>{html.escape(label)}<br><audio controls preload="none" src="{quote(relative)}"></audio></p>'

    fragments = ['<!doctype html><meta charset="utf-8"><title>bunri 分離比較</title>',
                 '<style>body{font:16px sans-serif;max-width:1100px;margin:32px auto;padding:16px;background:#181a1d;color:#eee} '
                 'table{border-collapse:collapse}td,th{padding:8px;border:1px solid #555}audio{width:300px} '
                 'section{border-top:1px solid #555;margin-top:32px} .players{display:flex;flex-wrap:wrap;gap:20px}</style>',
                 '<h1>bunri 分離比較</h1><p>音量はそろえていません。原曲・正解・各方式を同じ再生音量で比較してください。'
                 '再構成誤差が小さくても、各楽器へ正しく分かれた証明にはなりません。'
                 '波形SDRは独自の単純誤差で、論文のBSS Evalと同一ではありません。値は大きいほど誤差が少なく、'
                 '音量差は0 dBに近いほど正解と同じ大きさです。</p>',
                 '<label>共通再生音量（全音声へ同じ倍率） <input id="volume" type="range" min="0" max="1" step="0.01" value="0.5"></label>']
    fragments.append('<table><tr><th>方式</th><th>成功/実行</th><th>合計秒</th><th>正解付き件数</th>'
                     '<th>平均波形SDR dB</th><th>平均絶対音量差 dB</th></tr>')
    for row in summary:
        score = '—' if row['mean_waveform_sdr_db'] is None else f'{row["mean_waveform_sdr_db"]:.2f}'
        level = '—' if row['mean_absolute_level_error_db'] is None else f'{row["mean_absolute_level_error_db"]:.2f}'
        fragments.append(f'<tr><td>{html.escape(row["candidate"])}</td><td>{row["completed"]}/{row["attempted"]}</td>'
                         f'<td>{row["elapsed_seconds_total"]:.2f}</td><td>{row["reference_cases"]}</td><td>{score}</td><td>{level}</td></tr>')
    fragments.append('</table><p>最大RSSはCPUプロセスの値で、GPUや別サービスを含む総メモリではありません。'
                     'ケースを一回ずつ固定順に実行した結果です。</p>')
    for case in manifest["cases"]:
        fragments.append(f'<section><h2>{html.escape(case["id"])}</h2>')
        fragments.append(player(case["input"], "原曲"))
        if case.get("references"):
            fragments.append('<details><summary>正解の各パート</summary><div class="players">')
            for stem in STEMS:
                fragments.append(player(Path(case["references"]) / f"{stem}.wav", stem))
            fragments.append('</div></details>')
        for record in (r for r in records if r["case"] == case["id"]):
            fragments.append(f'<h3>{html.escape(record["candidate"])}</h3>')
            if record["status"] != "done":
                fragments.append(f'<p>失敗: {html.escape(record.get("error", ""))}</p>')
                continue
            process = record["process"]
            rss = process["peak_rss_mib"]
            fragments.append(f'<p>処理全体 {process["elapsed_seconds"]:.2f}秒 / 最大RSS {rss:.0f} MiB</p>' if rss is not None
                             else f'<p>処理全体 {process["elapsed_seconds"]:.2f}秒 / RSS未計測</p>')
            fragments.append('<div class="players">')
            merged = record["metrics"]["merged_into_other"]
            if merged:
                import soundfile as sf
                combined, rate = read_audio(Path(record["output_dir"]) / "other.wav")
                for name in merged:
                    addition, _ = read_audio(Path(record["output_dir"]) / f"{name}.wav", rate)
                    combined += addition
                sf.write(Path(record["output_dir"]) / "comparison-other.wav", combined, rate, subtype="FLOAT")
            for stem in STEMS:
                filename = "comparison-other.wav" if stem == "other" and merged else f"{stem}.wav"
                fragments.append(player(Path(record["output_dir"]) / filename,
                                        stem + ("（ギター・ピアノ合算）" if stem == "other" and merged else "")))
            for stem in record["metrics"]["merged_into_other"]:
                fragments.append(player(Path(record["output_dir"]) / f"{stem}.wav", stem))
            fragments.append('</div>')
            if record["metrics"]["has_references"]:
                fragments.append('<table><tr><th>パート</th><th>波形SDR dB</th><th>SI-SDR dB</th><th>音量差 dB</th></tr>')
                for stem, values in record["metrics"]["stems"].items():
                    ref = values["reference"]
                    if ref["reference_silent"]:
                        fragments.append(f'<tr><td>{stem}</td><td colspan="3">正解は無音</td></tr>')
                    else:
                        si_sdr = "無音（未定義）" if ref["si_sdr_db"] is None else f'{ref["si_sdr_db"]:.2f}'
                        fragments.append(f'<tr><td>{stem}</td><td>{ref["waveform_sdr_db"]:.2f}</td>'
                                         f'<td>{si_sdr}</td><td>{ref["rms_level_error_db"]:+.2f}</td></tr>')
                fragments.append('</table>')
            else:
                fragments.append('<p>各パートの正解なし：混入・欠落の正確な定量評価はしていません。</p>')
        fragments.append('</section>')
    fragments.append('<script>const players=[...document.querySelectorAll("audio")];players.forEach(a=>a.volume=0.5);'
                     'document.querySelector("#volume").addEventListener("input",e=>players.forEach(a=>a.volume=Number(e.target.value)));'
                     'document.addEventListener("play",e=>{if(e.target.tagName==="AUDIO")'
                     'players.forEach(a=>{if(a!==e.target)a.pause()})},true)</script>')
    (destination / "report.html").write_text("\n".join(fragments))


def summarize(records):
    """同じケース群の集計を残す。正解の無いケースから精度の数字は作らない。"""
    import statistics

    summary = []
    for name in dict.fromkeys(record["candidate"] for record in records):
        attempted = [r for r in records if r["candidate"] == name]
        done = [r for r in attempted if r["status"] == "done"]
        reference_cases = [r for r in done if r["metrics"]["has_references"]]
        values = [v["reference"] for r in reference_cases for v in r["metrics"]["stems"].values()
                  if not v["reference"]["reference_silent"]]
        summary.append({
            "candidate": name, "attempted": len(attempted), "completed": len(done), "reference_cases": len(reference_cases),
            "elapsed_seconds_total": sum(r["process"]["elapsed_seconds"] for r in done),
            "mean_waveform_sdr_db": statistics.mean(v["waveform_sdr_db"] for v in values) if values else None,
            "mean_absolute_level_error_db": statistics.mean(abs(v["rms_level_error_db"]) for v in values) if values else None,
            "per_stem_waveform_sdr_db": {
                stem: statistics.mean(r["metrics"]["stems"][stem]["reference"]["waveform_sdr_db"]
                                      for r in reference_cases if not r["metrics"]["stems"][stem]["reference"]["reference_silent"])
                for stem in STEMS if any(not r["metrics"]["stems"][stem]["reference"]["reference_silent"] for r in reference_cases)
            },
        })
    return summary


def refresh_report(manifest_path, destination):
    """保存済みの出力を照合して再評価する。モデルを動かしたときの指紋は書き換えない。"""
    from audio_utils import safe_join

    manifest = json.loads(Path(manifest_path).read_text())
    destination = Path(destination).resolve()
    records = []
    for case in manifest["cases"]:
        for candidate in manifest["candidates"]:
            output_dir = safe_join(safe_join(destination, case["id"]), candidate["id"])
            record_path = output_dir / "benchmark.json"
            if not record_path.exists():
                records.append({"case": case["id"], "candidate": candidate["id"], "status": "not_run", "error": "未実行"})
                continue
            record = json.loads(record_path.read_text())
            if record["status"] == "done":
                if file_hash(case["input"]) != record["fingerprint"]["input_sha256"]:
                    raise ValueError("計測後に入力音声が変わっています")
                for name, digest in record["output_sha256"].items():
                    if file_hash(safe_join(output_dir, name)) != digest:
                        raise ValueError("計測後に出力音声が変わっています")
                refs = case.get("references")
                hashes = {name: file_hash(Path(refs) / f"{name}.wav") for name in STEMS} if refs else None
                if hashes != record["fingerprint"]["references"]:
                    raise ValueError("計測後に正解音声が変わっています")
                record["metrics"] = evaluate(case["input"], output_dir, refs)
                record["evaluation_code_sha256"] = file_hash(__file__)
                record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
            records.append(record)
    (destination / "report.json").write_text(json.dumps(records, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    write_report(records, manifest, destination)
    return records


def demucs_worker(input_path, output_dir, model):
    """既存と同じDemucsを固定seed・CPU・1ジョブで比較する。"""
    import importlib.metadata
    import random
    import runpy
    import shutil
    import numpy as np
    import torch

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    torch.manual_seed(0)
    random.seed(0)
    np.random.seed(0)
    started = time.perf_counter()
    runner = Path(__file__).with_name("_demucs_runner.py")
    sys.argv = [str(runner), "-n", model, "--device", "cpu", "--segment", "7", "--jobs", "1", "--shifts", "1",
                "--float32", "--clip-mode", "none", "--out", str(output_dir / "raw"), input_path]
    runpy.run_path(str(runner), run_name="__main__")
    for path in (output_dir / "raw" / model / Path(input_path).stem).glob("*.wav"):
        shutil.copy2(path, output_dir / path.name)
    metadata = {"model": model, "package": importlib.metadata.version("demucs"), "device": "cpu",
                "separation_including_load_seconds": time.perf_counter() - started,
                "runner_sha256": file_hash(runner), "seed": 0, "threads": 4,
                "torch_version": torch.__version__}
    (output_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    run = commands.add_parser("run")
    run.add_argument("--manifest", required=True)
    run.add_argument("--output-dir")
    run.add_argument("--timeout", type=float, default=1800)
    run.add_argument("--resume", action="store_true")
    report = commands.add_parser("report")
    report.add_argument("--manifest", required=True)
    report.add_argument("--output-dir", required=True)
    demucs = commands.add_parser("demucs")
    demucs.add_argument("--input", required=True)
    demucs.add_argument("--output-dir", required=True)
    demucs.add_argument("--model", choices=("htdemucs_ft", "htdemucs", "htdemucs_6s"), default="htdemucs_ft")
    args = parser.parse_args()
    if args.mode == "demucs":
        demucs_worker(args.input, args.output_dir, args.model)
    elif args.mode == "report":
        refresh_report(args.manifest, args.output_dir)
    else:
        from audio_utils import results_dir
        records = run_manifest(args.manifest, args.output_dir or results_dir("separation-bench"), args.timeout, args.resume)
        if any(record["status"] == "error" for record in records):
            raise SystemExit(1)


if __name__ == "__main__":
    main()
