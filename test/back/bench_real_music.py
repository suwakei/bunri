"""グリッド推定のテンポを、作者がテンポを公開している実際の曲で測る。

テストではない（pytest は拾わない）。合成音源のベンチ（``bench_grid.py``）では見えない、
実際の曲での倍・半分の取り違えと、確信度の当たり具合を数字にする道具。

曲の一覧は ``real_music_tracks.json``（CC BY 4.0 の 58 曲。題名・公開されているテンポ・取得元）。
音源そのものはリポジトリに入れていないので、先に手元へ取得する（約 280 MB。ネットワークを使う）。

使い方（リポジトリの直下で）::

    uv run python test/back/bench_real_music.py 置き場 --fetch     # 取得する（1 回だけ）
    uv run python test/back/bench_real_music.py 置き場             # 測る
    uv run python test/back/bench_real_music.py 置き場 --verbose   # 1 曲ごとの結果も出す
    uv run python test/back/bench_real_music.py 置き場 --structure 別の/structure.py   # 直す前との比較

分かるのはテンポだけ。拍の位置と小節頭は、正解の注釈が無いので測れない。
公開されているテンポは作者の数え方によるので、3:2 や 4:3 の食い違いは、推定の誤りとは限らない
（6/8 やワルツを、付点 4 分で数えるか 8 分・4 分で数えるか）。

``split`` は、定数を決めるのに使った半分（calibration）と、決めた後で当てた半分（validation）。
定数を直すときは calibration だけを見て決め、validation で確かめること。
"""
import argparse
import json
import sys
import time
import urllib.request
import warnings
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent / "backend"))

from bench_grid import load_structure  # noqa: E402

TRACKS = HERE / "real_music_tracks.json"

# 公開されているテンポとの比。±3% に入ったものを、その関係とみなす
RATIOS = [("ok", 1.0), ("x2", 2.0), ("x0.5", 0.5), ("x1.5", 1.5), ("x0.67", 2 / 3), ("x1.33", 4 / 3), ("x0.75", 0.75)]
RATIO_TOLERANCE = 0.03

# 画面と同じ段の境目（web-ui/src/lib/chart.ts の confidenceTier）
TIERS = [("確実", 0.7), ("たぶん", 0.4), ("自信なし", 0.0)]


def load_tracks():
    """曲の一覧を読む。"""
    with open(TRACKS, encoding="utf-8") as f:
        return json.load(f)["tracks"]


def track_path(root, track):
    """1 曲の置き場。取得したファイルは 1 曲ずつ別のフォルダに置く。"""
    return Path(root) / track["id"] / "track.mp3"


def fetch(root):
    """まだ手元に無い曲を取得する。"""
    for track in load_tracks():
        target = track_path(root, track)
        if target.exists() and target.stat().st_size > 50_000:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(track["url"], headers={"User-Agent": "Mozilla/5.0 (compatible; bench-script)"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read()
        except OSError as error:
            print(f"{track['id']} 取得できない: {track['title']} ({error})", flush=True)
            continue
        # MP3 でないもの（エラーページなど）は置かない
        if data[:3] != b"ID3" and data[:2] not in (b"\xff\xfb", b"\xff\xf3"):
            print(f"{track['id']} MP3 ではない: {track['title']}", flush=True)
            continue
        target.write_bytes(data)
        print(f"{track['id']} 取得: {track['title']}", flush=True)
        time.sleep(0.5)


def classify(estimated, published):
    """推定したテンポと公開されているテンポの関係を返す（``ok`` / ``x2`` / … / ``other``）。"""
    ratio = estimated / published
    for name, target in RATIOS:
        if abs(ratio / target - 1.0) <= RATIO_TOLERANCE:
            return name
    return "other"


def tier(confidence):
    """確信度を、画面と同じ 3 段に分ける。"""
    return next(name for name, floor in TIERS if confidence >= floor)


def measure(structure, root, verbose=False):
    """手元に在る曲を測り、行のリストを返す。拍子は渡さない（取り込み時と同じ自動判定）。"""
    rows = []
    for track in load_tracks():
        path = track_path(root, track)
        if not path.exists():
            continue
        grid = structure.estimate_grid(str(path))
        row = {**track, "estimated": grid["bpm"], "confidence": grid["bpm_confidence"],
               "meter": grid["time_signature"][0], "tempo": classify(grid["bpm"], track["bpm"])}
        rows.append(row)
        if verbose:
            print(f"  {row['tempo']:6s} 公開 {track['bpm']:3d} 推定 {row['estimated']:6.1f} {row['meter']} 拍子 "
                  f"確信度 {row['confidence']:.2f} ({tier(row['confidence'])}) {track['split'][:3]} "
                  f"{track['group']:5s} {track['title']}", flush=True)
    return rows


def summarize(name, rows):
    """1 組の集計を出す。"""
    kinds = {}
    for row in rows:
        kinds[row["tempo"]] = kinds.get(row["tempo"], 0) + 1
    others = ", ".join(f"{kind} {count}" for kind, count in sorted(kinds.items()) if kind != "ok")
    tiers = " / ".join(
        f"{label} 合 {sum(tier(r['confidence']) == label and r['tempo'] == 'ok' for r in rows)}"
        f" 外 {sum(tier(r['confidence']) == label and r['tempo'] != 'ok' for r in rows)}"
        for label, _ in TIERS)
    print(f"{name:12s} {len(rows):2d} 曲 | テンポが公開値と一致 {kinds.get('ok', 0):2d}（外れ: {others or 'なし'}）")
    print(f"{'':12s}       | 確信度: {tiers}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", help="音源の置き場（リポジトリの外のフォルダ）")
    parser.add_argument("--fetch", action="store_true", help="まだ手元に無い曲を取得する（測らない）")
    parser.add_argument("--structure", help="測る実装（structure.py のパス。省略すると backend/structure.py）")
    parser.add_argument("--verbose", action="store_true", help="1 曲ごとの結果も出す")
    args = parser.parse_args()

    if args.fetch:
        fetch(args.root)
        return

    warnings.filterwarnings("ignore")
    rows = measure(load_structure(args.structure), args.root, args.verbose)
    if not rows:
        print("音源が在りません。先に --fetch で取得してください")
        return
    for name in ("calibration", "validation"):
        summarize(name, [row for row in rows if row["split"] == name])
    summarize("全体", rows)
    summarize("ゲーム音楽風", [row for row in rows if row["group"] == "game"])


if __name__ == "__main__":
    main()
