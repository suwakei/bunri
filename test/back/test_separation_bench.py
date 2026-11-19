"""分離比較の数値が音量低下や単なる原音のコピーを誤って高評価にしないことを確かめる。"""
import json
import sys

import numpy as np
import pytest
import soundfile as sf

from separation_bench import STEMS, evaluate, file_hash, measured_run, reference_metrics, refresh_report, run_manifest, write_report


def test_音量低下はSI_SDRだけで隠さない():
    tone = np.sin(np.arange(1000) * 0.1)
    result = reference_metrics(tone, tone * 0.5)
    assert result["rms_level_error_db"] == pytest.approx(-6.0206, abs=0.001)
    assert result["projection_gain_db"] == pytest.approx(-6.0206, abs=0.001)
    assert result["waveform_sdr_db"] == pytest.approx(6.0206, abs=0.001)
    assert result["si_sdr_db"] > 100


def test_無音参照も有限のJSONで残す():
    result = reference_metrics(np.zeros(100), np.ones(100) * 0.01)
    assert result["reference_silent"]
    json.dumps(result, allow_nan=False)


def test_音の完全な欠落をSI_SDRゼロとして評価しない():
    result = reference_metrics(np.ones(100), np.zeros(100))
    assert result["estimate_silent"]
    assert result["si_sdr_db"] is None
    assert result["waveform_sdr_db"] == pytest.approx(0)


def fixture_audio(tmp_path, six=False):
    rate = 8000
    t = np.arange(rate) / rate
    references = tmp_path / "references"
    outputs = tmp_path / "outputs"
    references.mkdir()
    outputs.mkdir()
    signals = {}
    for index, name in enumerate(STEMS):
        signals[name] = np.column_stack([np.sin(2 * np.pi * (110 + 83 * index) * t) * 0.1] * 2)
        sf.write(references / f"{name}.wav", signals[name], rate, subtype="FLOAT")
        sf.write(outputs / f"{name}.wav", signals[name] * (0.5 if six and name == "other" else 1), rate, subtype="FLOAT")
    if six:
        for name in ("piano", "guitar"):
            sf.write(outputs / f"{name}.wav", signals["other"] * 0.25, rate, subtype="FLOAT")
    mixture = tmp_path / "mixture.wav"
    sf.write(mixture, sum(signals.values()), rate, subtype="FLOAT")
    return mixture, outputs, references, signals


def test_6パートはその他へまとめて同じ4パートと比較する(tmp_path):
    mixture, outputs, references, _ = fixture_audio(tmp_path, six=True)
    result = evaluate(mixture, outputs, references)
    assert result["merged_into_other"] == ["guitar", "piano"]
    assert result["stems"]["other"]["reference"]["waveform_sdr_db"] > 100
    assert result["reconstruction_error_db"] < -100


def test_聴き比べのその他も評価と同じ合算音声にする(tmp_path):
    mixture, outputs, references, signals = fixture_audio(tmp_path, six=True)
    result = evaluate(mixture, outputs, references)
    manifest = {"cases": [{"id": "case", "input": str(mixture), "references": str(references)}]}
    record = {"case": "case", "candidate": "six", "status": "done", "output_dir": str(outputs), "metrics": result,
              "process": {"elapsed_seconds": 1, "peak_rss_mib": 20}}
    write_report([record], manifest, tmp_path)
    combined, _ = sf.read(outputs / "comparison-other.wav")
    np.testing.assert_allclose(combined, signals["other"], atol=1e-7)
    assert "comparison-other.wav" in (tmp_path / "report.html").read_text()


def test_原曲をその他へコピーして和だけ一致しても分離の評価は悪い(tmp_path):
    mixture, outputs, references, signals = fixture_audio(tmp_path)
    audio, rate = sf.read(mixture)
    for name in STEMS:
        sf.write(outputs / f"{name}.wav", audio if name == "other" else np.zeros_like(audio), rate, subtype="FLOAT")
    result = evaluate(mixture, outputs, references)
    assert result["reconstruction_error_db"] < -100
    assert result["stems"]["bass"]["reference"]["waveform_sdr_db"] == pytest.approx(0)
    assert result["stems"]["other"]["reference"]["waveform_sdr_db"] < 0


def test_正解がなければ精度の数字を作らない(tmp_path):
    mixture, outputs, _, _ = fixture_audio(tmp_path)
    result = evaluate(mixture, outputs)
    assert not result["has_references"]
    assert all("reference" not in values for values in result["stems"].values())


def test_長さの違う出力を勝手に切り詰めない(tmp_path):
    mixture, outputs, _, signals = fixture_audio(tmp_path)
    sf.write(outputs / "bass.wav", signals["bass"][:100], 8000, subtype="FLOAT")
    with pytest.raises(ValueError, match="長さ"):
        evaluate(mixture, outputs)


def test_失敗も隠さず記録しHTMLへ出す(tmp_path):
    mixture, _, _, _ = fixture_audio(tmp_path)
    manifest = {"cases": [{"id": "case", "input": str(mixture)}],
                "candidates": [{"id": "bad", "command": [sys.executable, "-c", "raise SystemExit(2)"]}]}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    records = run_manifest(path, tmp_path / "report")
    assert records[0]["status"] == "error"
    assert records[0]["process"]["returncode"] == 2
    assert "失敗" in (tmp_path / "report" / "report.html").read_text()


def test_長い処理は止めて記録する(tmp_path):
    result = measured_run([sys.executable, "-c", "import time; time.sleep(10)"], tmp_path / "log", 0.1)
    assert result["timed_out"] and result["returncode"] != 0


def test_再評価は計測時の指紋を変えず入力改変を拒否する(tmp_path):
    mixture, outputs, references, _ = fixture_audio(tmp_path)
    destination = tmp_path / "report"
    output_dir = destination / "case" / "model"
    output_dir.mkdir(parents=True)
    import shutil
    for stem in STEMS:
        shutil.copy2(outputs / f"{stem}.wav", output_dir / f"{stem}.wav")
    fingerprint = {"input_sha256": file_hash(mixture), "references": {name: file_hash(references / f"{name}.wav") for name in STEMS},
                   "runner_sha256": {"model.py": "original-code"}}
    record = {"case": "case", "candidate": "model", "status": "done", "output_dir": str(output_dir), "fingerprint": fingerprint,
              "output_sha256": {f"{name}.wav": file_hash(output_dir / f"{name}.wav") for name in STEMS},
              "process": {"elapsed_seconds": 1, "peak_rss_mib": 20}}
    (output_dir / "benchmark.json").write_text(json.dumps(record))
    manifest = {"cases": [{"id": "case", "input": str(mixture), "references": str(references)}], "candidates": [{"id": "model"}]}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    refreshed = refresh_report(path, destination)
    assert refreshed[0]["fingerprint"] == fingerprint
    assert refreshed[0]["evaluation_code_sha256"]
    mixture.write_bytes(b"changed")
    with pytest.raises(ValueError, match="入力音声"):
        refresh_report(path, destination)
