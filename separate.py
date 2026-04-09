import subprocess
import sys
from pathlib import Path


SUPPORTED_FORMATS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}

MODELS = {
    "htdemucs":    "標準4ステム（推奨・CPU向け）",
    "htdemucs_ft": "高精度4ステム（非常に遅い）",
    "htdemucs_6s": "6ステム（ボーカル/ドラム/ベース/ギター/ピアノ/その他）",
}

# モデルごとの出力ステム定義
MODEL_STEMS = {
    "htdemucs":    {"two": ["vocals", "no_vocals"],
                    "full": ["vocals", "drums", "bass", "other"]},
    "htdemucs_ft": {"two": ["vocals", "no_vocals"],
                    "full": ["vocals", "drums", "bass", "other"]},
    "htdemucs_6s": {"full": ["vocals", "drums", "bass", "guitar", "piano", "other"]},
}

STEM_LABELS = {
    "vocals": "ボーカル",
    "no_vocals": "伴奏（ボーカル除去）",
    "drums": "ドラム・パーカッション",
    "bass": "ベース",
    "guitar": "ギター",
    "piano": "ピアノ・鍵盤",
    "other": "その他（ストリングス・シンセ等）",
    # 再帰分離で生成されるサブステム
    "other_vocals": "その他 → ボーカル/コーラス成分",
    "other_drums": "その他 → パーカッション成分",
    "other_bass": "その他 → 低音成分",
    "other_guitar": "その他 → ギター系成分",
    "other_piano": "その他 → 鍵盤系成分",
    "other_other": "その他 → 残余成分",
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
    音源を分離して各ステムのパスを返す。

    Args:
        input_path:  入力音声ファイルのパス
        output_dir:  出力先ディレクトリ
        model:       使用するDemucsモデル
        two_stems:   True → vocals / no_vocals の2分割（htdemucs_6sでは無視）
                     False → モデルの全ステム分割
        mp3_output:  True → MP3で出力（False → WAV）
        segment:     処理セグメント長（秒）。小さいほどメモリ節約（デフォルト7）
        jobs:        並列ジョブ数（CPU負荷を抑えるなら1）
    Returns:
        {"stem_name": Path, ...} — モデルと設定に応じた可変数のステム
    """
    input_path = Path(input_path)

    if not input_path.exists():
        raise FileNotFoundError(f"ファイルが見つかりません: {input_path}")

    if input_path.suffix.lower() not in SUPPORTED_FORMATS:
        raise ValueError(f"非対応フォーマット: {input_path.suffix}")

    # htdemucs_6s は two_stems 非対応（常にフル分割）
    if model == "htdemucs_6s":
        two_stems = False

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

    # 出力ステム名を決定
    stems_info = MODEL_STEMS.get(model, MODEL_STEMS["htdemucs"])
    if two_stems and "two" in stems_info:
        stem_names = stems_info["two"]
    else:
        stem_names = stems_info["full"]

    print(f"[*] モデル: {model}  ファイル: {input_path.name}")
    print(f"[*] ステム: {', '.join(stem_names)}")
    print(f"[*] セグメント長: {segment}秒  ジョブ数: {jobs}")
    print(f"[*] 実行コマンド: {' '.join(cmd)}\n")

    result = subprocess.run(cmd, capture_output=False, text=True)

    if result.returncode != 0:
        raise RuntimeError("Demucs の実行に失敗しました。")

    ext = ".mp3" if mp3_output else ".wav"
    stem_name = input_path.stem
    base = Path(output_dir) / model / stem_name

    # 存在するステムだけ返す
    paths = {}
    for s in stem_names:
        p = base / f"{s}{ext}"
        if p.exists():
            paths[s] = p
    return paths


def _is_silent(file_path: Path, threshold_db: float = -50) -> bool:
    """WAVファイルがほぼ無音かどうか判定する"""
    import numpy as np
    import soundfile as sf
    data, sr = sf.read(str(file_path))
    if data.ndim > 1:
        data = data.mean(axis=1)
    rms = np.sqrt(np.mean(data ** 2))
    db = 20 * np.log10(rms + 1e-10)
    return db < threshold_db


def deep_separate(
    input_path: str,
    output_dir: str = "output",
    mp3_output: bool = False,
    segment: int = 7,
    jobs: int = 1,
    recursive_depth: int = 1,
) -> dict[str, Path]:
    """
    最大限のレイヤー分離を行う。

    1. htdemucs_6s で6ステムに分離
    2. 「other」ステムをさらに htdemucs_6s で再分離
    3. 再分離で得た無音ステムは除外

    Args:
        recursive_depth: otherを再帰分離する深さ（1=1回再分離, 0=再分離なし）
    Returns:
        {"stem_name": Path, ...} — 可変数のステム（無音除外済み）
    """
    input_p = Path(input_path)

    # 第1段: htdemucs_6s でフル分離
    print(f"[深層分離] === 第1段: htdemucs_6s フル分離 ===")
    first = separate_audio(
        input_path=input_path,
        output_dir=output_dir,
        model="htdemucs_6s",
        two_stems=False,
        mp3_output=mp3_output,
        segment=segment,
        jobs=jobs,
    )

    result = {}
    other_path = None
    for key, p in first.items():
        if key == "other":
            other_path = p
        else:
            # 無音でなければ結果に含める
            if not _is_silent(p):
                result[key] = p
            else:
                print(f"[深層分離] {key} はほぼ無音のためスキップ")

    # 第2段: otherをさらに分離
    if other_path and other_path.exists() and recursive_depth > 0:
        if _is_silent(other_path):
            print(f"[深層分離] other はほぼ無音のためスキップ")
        else:
            print(f"\n[深層分離] === 第2段: otherステムを再分離 ===")
            other_out = str(Path(output_dir) / "deep_other")
            sub = separate_audio(
                input_path=str(other_path),
                output_dir=other_out,
                model="htdemucs_6s",
                two_stems=False,
                mp3_output=mp3_output,
                segment=segment,
                jobs=jobs,
            )

            has_sub = False
            for sub_key, sub_p in sub.items():
                prefixed = f"other_{sub_key}"
                if not _is_silent(sub_p):
                    result[prefixed] = sub_p
                    has_sub = True
                    print(f"[深層分離] {prefixed}: 音声あり → 出力")
                else:
                    print(f"[深層分離] {prefixed}: ほぼ無音 → スキップ")

            # サブステムが全て無音なら元のotherを残す
            if not has_sub:
                result["other"] = other_path
    elif other_path and not _is_silent(other_path):
        result["other"] = other_path

    print(f"\n[深層分離] 完了: {len(result)}個のレイヤーを出力")
    return result


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