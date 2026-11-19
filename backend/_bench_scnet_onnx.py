"""SCNet 小型量子化 ONNX を公式 JavaScript の前後処理で比較する実験用入口。

アプリの依存は変えず、固定した外部 checkout と Node の別環境を使う。
STFT・正規化・区間のフェードは audiojs/neural の実装に任せ、ここでは再実装しない。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from _bench_roformer import verify_artifact


CODE_REVISION = "6df9aedb25cc10e54e9acddad673aac587c079a9"
WEIGHTS_REVISION = "af9bf78fdf676109a67211b32a3b54a1069acd40"
WEIGHTS_SHA = "98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845"
DEFAULT_ROOT = Path("/tmp/bunri-model-bench/roformer")
STEMS = ("drums", "bass", "other", "vocals")

# 音声は一時ファイルのfloat配列で渡す。標準出力には中身を書かない。
NODE_BRIDGE = r"""
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [source, input, output, framesText, weights] = process.argv.slice(2);
const frames = Number(framesText);
const {default: separate} = await import(pathToFileURL(path.join(source, 'separate.js')));
const {load} = await import(pathToFileURL(path.join(source, 'node_modules/@audio/neural-runtime/runtime.js')));
const bytes = new Uint8Array(fs.readFileSync(input));
const audio = new Float32Array(bytes.buffer);
if (audio.length !== frames * 2) throw new Error('入力配列の形が不正です');
let loadSeconds = 0;
const started = performance.now();
const result = await separate([audio.subarray(0, frames), audio.subarray(frames)], {
    model: 'scnet', sampleRate: 44100, weights, device: 'node', step: 0.25,
    session: async model => {
        const began = performance.now();
        const session = await load(model, {backend: 'node', sessionOptions: {
            executionProviders: ['cpu'], intraOpNumThreads: 4, interOpNumThreads: 1,
            enableCpuMemArena: false, enableMemPattern: false,
        }});
        loadSeconds += (performance.now() - began) / 1000;
        return session;
    },
});
const seconds = (performance.now() - started) / 1000;
for (const name of ['drums', 'bass', 'other', 'vocals']) {
    const channels = result.stems[name];
    if (channels.length !== 2 || channels.some(c => c.length !== frames)) throw new Error('出力配列の形が不正です');
    const raw = new Float32Array(frames * 2);
    raw.set(channels[0]); raw.set(channels[1], frames);
    fs.writeFileSync(path.join(output, `${name}.f32`), new Uint8Array(raw.buffer));
}
fs.writeFileSync(path.join(output, 'timing.json'), JSON.stringify({
    load_seconds: loadSeconds, separation_seconds: seconds - loadSeconds, sample_rate: result.sampleRate,
}));
"""


def validate_output_dir(output_dir: Path) -> None:
    """既存の音声と結果を上書きしない。計測ログは置いてよい。"""
    if output_dir.exists() and (any(output_dir.glob("*.wav")) or (output_dir / "metadata.json").exists()):
        raise FileExistsError("空の比較出力先を指定してください（ログだけなら使用可能です）")


def run(input_path: Path, output_dir: Path, source_dir: Path, model_dir: Path) -> dict:
    """固定ONNXと公式JS処理をCPUで動かしてfloat WAVへ保存する。"""
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    from math import gcd

    validate_output_dir(output_dir)
    verify_artifact(model_dir / "scnet" / "scnet.int8.onnx", WEIGHTS_SHA)
    revision = subprocess.check_output(["git", "-C", str(source_dir), "rev-parse", "HEAD"], text=True).strip()
    if revision != CODE_REVISION:
        raise ValueError("SCNetの比較用コード revision が一致しません")
    if subprocess.run(["git", "-C", str(source_dir), "diff", "--quiet", "HEAD", "--"], check=False).returncode:
        raise ValueError("比較用のコードに未記録の変更があります")
    data, rate = sf.read(input_path, dtype="float32", always_2d=True)
    if not data.size or not np.isfinite(data).all() or data.shape[1] not in (1, 2):
        raise ValueError("空でない有限のモノラルかステレオ音声を指定してください")
    if rate != 44100:
        divisor = gcd(rate, 44100)
        data = resample_poly(data, 44100 // divisor, rate // divisor, axis=0).astype(np.float32)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bunri-scnet-onnx-") as task_dir:
        temporary = Path(task_dir)
        source = temporary / "input.f32"
        data.T.astype("<f4").tofile(source)
        subprocess.run([
            "node", "--input-type=module", "-", str(source_dir), str(source), str(temporary), str(len(data)), str(model_dir),
        ], input=NODE_BRIDGE, text=True, check=True)
        timing = json.loads((temporary / "timing.json").read_text())
        if timing["sample_rate"] != 44100:
            raise ValueError("SCNetの出力サンプルレートが一致しません")
        for stem in STEMS:
            audio = np.fromfile(temporary / f"{stem}.f32", dtype="<f4")
            if audio.size != len(data) * 2 or not np.isfinite(audio).all():
                raise ValueError("SCNetの出力の形または値が不正です")
            sf.write(output_dir / f"{stem}.wav", audio.reshape(2, -1).T, 44100, subtype="FLOAT")
    metadata = {
        "model": "SCNet-small-int8-ONNX", "runtime": "JavaScript / onnxruntime-node", "device": "cpu",
        "node_version": subprocess.check_output(["node", "--version"], text=True).strip(),
        "runtime_version": json.loads((source_dir / "node_modules" / "onnxruntime-node" / "package.json").read_text())["version"],
        "code_repository": "https://github.com/audiojs/neural", "weights_repository": "https://huggingface.co/square-zero-labs/scnet",
        "code_revision": revision, "weights_revision": WEIGHTS_REVISION, "weights_sha256": WEIGHTS_SHA,
        "weights_license": "MIT (starrytong/SCNet); ONNX conversion by audiojs",
        **timing, "stems": list(STEMS), "chunk_size": 485100, "step": 0.25,
        "normalization": "公式JSの平均・標準偏差正規化と振幅復元。DC平均はパートへ加えない。",
        "weights_dtype": "int8+float16, 計算float32", "threads": 4,
        "note": "SCNet XLではなく小型の量子化変換。Python版と同じ精度とは仮定しない。",
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu",), default="cpu")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_ROOT / "neural" / "packages" / "neural-separate")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_ROOT / "scnet-models")
    args = parser.parse_args()
    print(json.dumps(run(args.input, args.output_dir, args.source_dir, args.model_dir), ensure_ascii=False))


if __name__ == "__main__":
    main()
