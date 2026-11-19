"""同梱する上流コードの来歴と、追加の実行基盤なしで読み込めることを確認する。"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "backend" / "_vendor" / "subroformer"


def test_上流コードのライセンスと変更箇所を追跡できる():
    source = json.loads((VENDOR / "SOURCE.json").read_text())
    assert source["revision"] == "bf4e35aff7905c8cd43b8d7365ffd1bcc7d1df02"
    assert "MIT License" in (VENDOR / "LICENSE").read_text()
    assert "Copyright (c) 2026 ArchiMickey" in (VENDOR / "LICENSE").read_text()
    for relative, expected in source["upstream_sha256"].items():
        actual = hashlib.sha256((VENDOR / relative).read_bytes()).hexdigest()
        if relative in source["changes"]:
            assert actual != expected, relative
        else:
            assert actual == expected, relative


def test_推論の設定と入口を開発用checkoutやコンパイラなしに読み込める():
    script = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from subroformer.inference.engine import load_inference_config, load_separator, separate_audio
from subroformer.frontend.subband.dsp3 import utils
from subroformer.inference.coreml import use_coreml
config = load_inference_config(Path(sys.argv[1]) / 'subroformer/configs/sbroformer_base_4stem_silu.yaml')
assert config.audio.sample_rate == 48000
assert list(config.training.instruments) == ['vocals', 'bass', 'drums', 'other']
assert config.model.dsp_backend == 'dsp3'
assert not use_coreml('torch', 'cpu', None, None)
assert 'coremltools' not in sys.modules
assert not any(name.endswith(('.cpu_kernel', '.cuda_kernel', '.mps_kernel')) for name in sys.modules if name.startswith('subroformer.'))
assert not hasattr(utils, '_ShiftFrequency')
"""
    subprocess.run([sys.executable, "-c", script, str(VENDOR)], check=True, cwd=ROOT)
