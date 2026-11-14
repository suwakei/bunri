"""グリッド推定の誤差を、正解の分かっている合成音源で数字にする。

テストではない（pytest は拾わない）。グリッド推定（``backend/structure.py``）を直すときに、
直す前と後で同じ材料の誤差を比べるための道具。

使い方（リポジトリの直下で）::

    uv run python test/back/bench_grid.py                 # 3 組すべて
    uv run python test/back/bench_grid.py --set final     # 1 組だけ
    uv run python test/back/bench_grid.py --verbose       # 1 件ごとの結果も出す
    uv run python test/back/bench_grid.py --structure 別の/structure.py   # 別の実装で測る（直す前との比較）
    uv run python test/back/bench_grid.py --auto-meter    # 拍子も自動で決めさせる（拍子の正解率も出す）

組の意味は ``grid_materials.py`` の ``design_cases`` / ``holdout_cases`` / ``final_cases`` を参照。
"""
import argparse
import importlib.util
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent / "backend"))

import grid_materials  # noqa: E402

SETS = {
    "design": grid_materials.design_cases,
    "holdout": grid_materials.holdout_cases,
    "final": grid_materials.final_cases,
}


def load_structure(path):
    """グリッド推定のモジュールを読み込む。``path`` が None なら ``backend/structure.py``。"""
    if path is None:
        import structure
        return structure
    spec = importlib.util.spec_from_file_location("structure_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_set(structure, name, verbose=False, auto_meter=False):
    """1 組を測り、行のリストを返す。``auto_meter`` なら拍子を渡さず、自動で決めさせる。"""
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for index, (label, kind, kwargs) in enumerate(SETS[name]()):
            path = Path(tmp) / f"{index}.wav"
            truth = grid_materials.write_song(path, kind, **kwargs)
            grid = structure.estimate_grid(
                str(path), beats_per_bar=None if auto_meter else truth["beats_per_bar"])
            errors = grid_materials.grid_errors(grid, truth)
            tempo, beats_ok, downbeat_ok = grid_materials.judge(errors)
            rows.append({
                "label": label, "tempo": tempo, "beats_ok": beats_ok, "downbeat_ok": downbeat_ok,
                "confidence": grid["bpm_confidence"], "bpm": grid["bpm"], "true_bpm": truth["bpm"],
                "offset": grid["downbeat_offset_sec"], "true_downbeat": truth["downbeat"],
                "meter": grid["time_signature"][0], "true_meter": truth["beats_per_bar"], **errors,
            })
            if verbose:
                row = rows[-1]
                print(f"  {'OK' if downbeat_ok else 'NG'} {label:58s} 拍子 {row['meter']}/{row['true_meter']} bpm {row['bpm']:7.2f} ({tempo:5s}) "
                      f"確信度 {row['confidence']:.2f} 拍 {row['beat_err_ms']:6.1f}ms "
                      f"1拍目 {row['offset']:6.3f}s (正解 {row['true_downbeat']:.3f}) "
                      f"ずれ {row['downbeat_err_beats']}拍 {row['downbeat_err_ms']:+7.1f}ms", flush=True)
    return rows


def summarize(name, rows):
    """1 組の集計を 1 行で出す。"""
    import numpy as np

    count = len(rows)
    tempo = {key: sum(row["tempo"] == key for row in rows) for key in ("ok", "x2", "x0.5", "other")}
    aligned = [row["beat_err_ms"] for row in rows if row["tempo"] == "ok"]
    sure_but_wrong = sum(row["confidence"] >= 0.7 and not row["downbeat_ok"] for row in rows)
    print(f"{name:8s} {count:3d} 件 | テンポ: 正解 {tempo['ok']:3d} / 倍 {tempo['x2']:2d} / 半分 {tempo['x0.5']:2d} / "
          f"その他 {tempo['other']:2d} | 1 拍目の位置が正解 {sum(row['downbeat_ok'] for row in rows):3d} | "
          f"拍の位置の誤差の中央値 {np.median(aligned) if aligned else float('nan'):5.1f}ms | "
          f"外れているのに「確実」 {sure_but_wrong}")
    meters = sorted({row["true_meter"] for row in rows})
    print("         拍子（自動で決めたときの当たり / 件数）: " + ", ".join(
        f"{m} 拍子 {sum(r['meter'] == m for r in rows if r['true_meter'] == m)}/"
        f"{sum(r['true_meter'] == m for r in rows)}" for m in meters))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--set", choices=list(SETS), help="測る組（省略すると 3 組すべて）")
    parser.add_argument("--structure", help="測る実装（structure.py のパス。省略すると backend/structure.py）")
    parser.add_argument("--verbose", action="store_true", help="1 件ごとの結果も出す")
    parser.add_argument("--auto-meter", action="store_true", help="拍子を渡さず、自動で決めさせる")
    args = parser.parse_args()

    structure = load_structure(args.structure)
    for name in ([args.set] if args.set else list(SETS)):
        if args.verbose:
            print(f"== {name}")
        summarize(name, run_set(structure, name, args.verbose, args.auto_meter))


if __name__ == "__main__":
    main()
