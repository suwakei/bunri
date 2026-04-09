import subprocess
import sys
from pathlib import Path


SUPPORTED_FORMATS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}

MODELS = {
    "htdemucs":    "標準（推奨・CPU向け）",
    "htdemucs_ft": "高精度（非常に遅い・非推奨）",
}


def separate_audio(
    input_path: str,
    output_dir: str = "output",
    model: str = "htdemucs",
    two_stems: bool = True,
    mp3_output: bool = False,
    segment: int = 7,
    jobs: int = 1,
) -> dict[str, Path]:
    """
    音源を分離してボーカルと伴奏のパスを返す。

    Args:
        input_path:  入力音声ファイルのパス
        output_dir:  出力先ディレクトリ
        model:       使用するDemucsモデル
        two_stems:   True → vocals / no_vocals の2分割
                     False → vocals / drums / bass / other の4分割
        mp3_output:  True → MP3で出力（False → WAV）
        segment:     処理セグメント長（秒）。小さいほどメモリ節約（デフォルト7）
        jobs:        並列ジョブ数（CPU負荷を抑えるなら1）
    Returns:
        {"vocals": Path, "no_vocals": Path} または
        {"vocals": Path, "drums": Path, "bass": Path, "other": Path}
    """
    input_path = Path(input_path)

    if not input_path.exists():
        raise FileNotFoundError(f"ファイルが見つかりません: {input_path}")

    if input_path.suffix.lower() not in SUPPORTED_FORMATS:
        raise ValueError(f"非対応フォーマット: {input_path.suffix}")

    runner = str(Path(__file__).parent / "_demucs_runner.py")
    cmd = [
        sys.executable, runner,
        "--out", output_dir,
        "-n", model,
        "--segment", str(segment),
        "--jobs", str(jobs),
    ]

    if two_stems:
        cmd += ["--two-stems", "vocals"]

    if mp3_output:
        cmd += ["--mp3"]

    cmd.append(str(input_path))

    print(f"[*] モデル: {model}  ファイル: {input_path.name}")
    print(f"[*] セグメント長: {segment}秒  ジョブ数: {jobs}")
    print(f"[*] 実行コマンド: {' '.join(cmd)}\n")

    result = subprocess.run(cmd, capture_output=False, text=True)

    if result.returncode != 0:
        raise RuntimeError("Demucs の実行に失敗しました。")

    ext = ".mp3" if mp3_output else ".wav"
    stem_name = input_path.stem
    base = Path(output_dir) / model / stem_name

    if two_stems:
        return {
            "vocals":    base / f"vocals{ext}",
            "no_vocals": base / f"no_vocals{ext}",
        }
    else:
        return {
            "vocals": base / f"vocals{ext}",
            "drums":  base / f"drums{ext}",
            "bass":   base / f"bass{ext}",
            "other":  base / f"other{ext}",
        }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Demucs 音源分離ツール（CPU最適化）")
    parser.add_argument("input", help="入力音声ファイル（WAV推奨）")
    parser.add_argument("-o", "--out", default="output", help="出力ディレクトリ")
    parser.add_argument("-m", "--model", default="htdemucs",
                        choices=list(MODELS.keys()), help="使用モデル")
    parser.add_argument("--four-stems", action="store_true",
                        help="4分割モード（vocals/drums/bass/other）")
    parser.add_argument("--mp3", action="store_true", help="MP3形式で出力（デフォルトはWAV）")
    parser.add_argument("--segment", type=int, default=7,
                        help="セグメント長（秒）。小さいほどメモリ節約（デフォルト7）")
    parser.add_argument("--jobs", type=int, default=1,
                        help="並列ジョブ数（デフォルト1・CPU負荷軽減）")
    args = parser.parse_args()

    paths = separate_audio(
        input_path=args.input,
        output_dir=args.out,
        model=args.model,
        two_stems=not args.four_stems,
        mp3_output=args.mp3,
        segment=args.segment,
        jobs=args.jobs,
    )

    print("\n[完了] 出力ファイル:")
    for key, path in paths.items():
        print(f"  {key:10s} → {path}")