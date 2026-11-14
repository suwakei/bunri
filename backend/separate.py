import sys
from pathlib import Path


SUPPORTED_FORMATS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}

# Demucs を子プロセスとして起動するスクリプト
RUNNER = Path(__file__).parent / "_demucs_runner.py"

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
    # ドラムの細分化で生成されるサブステム（stem_models.py の drumsep）
    "drums_kick": "ドラム → キック",
    "drums_snare": "ドラム → スネア",
    "drums_toms": "ドラム → タム",
    "drums_cymbals": "ドラム → シンバル・ハイハット",
    # 再帰分離で生成されるサブステム
    "other_vocals": "その他 → ボーカル/コーラス成分",
    "other_drums": "その他 → パーカッション成分",
    "other_bass": "その他 → 低音成分",
    "other_guitar": "その他 → ギター系成分",
    "other_piano": "その他 → 鍵盤系成分",
    "other_other": "その他 → 残余成分",
}

# ジョブとして動かすときのステージ（``background_jobs``）。``(キー, 表示名)`` を進む順に並べる。
# モデルが手元に無いときは、"model" の表示名がダウンロード中のものに変わる（``demucs_progress``）
SEPARATE_STAGES = [
    ("model", "モデルを読み込んでいます"),
    ("separate", "パートに分けています"),
]
DEEP_SEPARATE_STAGES = [
    ("model", "モデルを読み込んでいます"),
    ("separate", "6 つのパートに分けています"),
    ("separate_other", "「その他」のパートをさらに分けています"),
]
# ドラムを部位ごとに分けるとき（``deep_separate(split_drums=True)``）だけ通るステージ。
# 追加のモデルは、手元に無いときだけ最初にダウンロードする（``stem_models``）
DRUM_MODEL_STAGE = ("drum_model", "ドラムを分けるモデルをダウンロードしています（初回のみ）")
DRUM_SPLIT_STAGE = ("separate_drums", "ドラムをキック・スネア・タム・シンバルに分けています")


def deep_separate_stages(recursive_depth=1, split_drums=False, download_drum_model=False):
    """``deep_separate`` をジョブとして動かすときのステージの並びを返す。

    Args:
        recursive_depth (int, optional): ``"other"`` を再分離する深さ。0 なら、そのステージを入れない。
        split_drums (bool, optional): ドラムを部位ごとに分けるか。真なら、そのステージを入れる。
        download_drum_model (bool, optional): ドラムを分けるモデルのダウンロードが要るか
            （``split_drums`` が真で、モデルが手元に無いとき）。真なら、最初にそのステージを入れる。

    Returns:
        list[tuple[str, str]]: ``(キー, 表示名)`` を進む順に並べたリスト。
    """
    stages = []
    if split_drums and download_drum_model:
        stages.append(DRUM_MODEL_STAGE)
    for stage in DEEP_SEPARATE_STAGES:
        if stage[0] == "separate_other":
            if split_drums:
                stages.append(DRUM_SPLIT_STAGE)
            if recursive_depth <= 0:
                continue
        stages.append(stage)
    return stages


def separate_audio(
    input_path: str,
    output_dir: str = "output",
    model: str = "htdemucs",
    two_stems: bool = True,
    mp3_output: bool = False,
    segment: int = 7,
    jobs: int = 1,
    job=None,
    stage: str = "separate",
    model_stage: str | None = "model",
) -> dict[str, Path]:
    """Demucs を使って音声ファイルを各ステムに分離し、出力パスを返す。

    ``_demucs_runner.py`` をサブプロセスとして起動することで、torchaudio の
    保存パッチを安全に適用しつつ分離処理を行う。

    Args:
        input_path (str): 入力音声ファイルのパス。対応フォーマット:
            ``.mp3``, ``.wav``, ``.flac``, ``.ogg``, ``.m4a``。
        output_dir (str, optional): 分離結果の出力先ルートディレクトリ。
            デフォルト ``"output"``。
        model (str, optional): 使用する Demucs モデル名。
            ``"htdemucs"``（推奨）, ``"htdemucs_ft"``, ``"htdemucs_6s"`` のいずれか。
            デフォルト ``"htdemucs"``。
        two_stems (bool, optional): ``True`` の場合 vocals / no_vocals の2分割。
            ``False`` の場合モデルの全ステムを分割。
            ``htdemucs_6s`` 指定時は常に ``False`` に強制される。デフォルト ``True``。
        mp3_output (bool, optional): ``True`` → MP3 形式で出力。
            ``False`` → WAV 形式で出力。デフォルト ``False``。
        segment (int, optional): Demucs の処理セグメント長（秒）。
            小さいほどメモリ使用量を抑えられる。デフォルト 7。
        jobs (int, optional): 並列ジョブ数。CPU 負荷を抑えるなら 1。デフォルト 1。
        job (background_jobs.Job | None, optional): この処理を動かしているジョブ。
            進み具合の報告とキャンセルに使う。None なら報告しない。
        stage (str, optional): 分離のステージのキー。デフォルト ``"separate"``。
        model_stage (str | None, optional): モデルを用意するステージのキー。
            None なら設けない（同じジョブの中で 2 回目に分離するとき）。デフォルト ``"model"``。

    Returns:
        dict[str, Path]: ステム名をキー、出力ファイルパスを値とする辞書。
            実際にファイルが存在するステムのみ含まれる。例::

                {"vocals": Path("output/htdemucs/track/vocals.wav"),
                 "no_vocals": Path("output/htdemucs/track/no_vocals.wav")}

    Raises:
        FileNotFoundError: ``input_path`` が存在しない場合。
        ValueError: ``input_path`` の拡張子が非対応フォーマットの場合。
        RuntimeError: Demucs サブプロセスが非ゼロ終了コードを返した場合。
        background_jobs.JobCancelled: ジョブがキャンセルされた場合（サブプロセスは kill 済み）。

    Note:
        Demucs の出力（進捗バーを含む）は、今までどおりこのプロセスの標準出力・標準エラーに出る。
        ジョブが失敗またはキャンセルで終わったら、このトラックの出力ディレクトリは消される。
    """
    import background_jobs
    import demucs_progress

    if job is None:
        job = background_jobs.detached()
    input_path = Path(input_path)

    if not input_path.exists():
        raise FileNotFoundError(f"ファイルが見つかりません: {input_path}")

    if input_path.suffix.lower() not in SUPPORTED_FORMATS:
        raise ValueError(f"非対応フォーマット: {input_path.suffix}")

    # htdemucs_6s は two_stems 非対応（常にフル分割）
    if model == "htdemucs_6s":
        two_stems = False

    cmd = [
        sys.executable, str(RUNNER),
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

    ext = ".mp3" if mp3_output else ".wav"
    stem_name = input_path.stem
    base = Path(output_dir) / model / stem_name

    # 途中でやめたときに、書きかけのステムを残さない
    job.remove_on_abort(base)
    returncode = demucs_progress.run(cmd, model=model, job=job, stage=stage, model_stage=model_stage)

    if returncode != 0:
        raise RuntimeError("Demucs の実行に失敗しました。")

    # 存在するステムだけ返す
    paths = {}
    for s in stem_names:
        p = base / f"{s}{ext}"
        if p.exists():
            paths[s] = p
    return paths


def _is_silent(file_path: Path, threshold_db: float = -50) -> bool:
    """WAV ファイルの RMS がほぼ無音レベルかどうかを判定する。

    ファイル全体の RMS を dBFS に変換し、``threshold_db`` を下回れば無音と判定する。

    Args:
        file_path (Path): 判定する WAV ファイルのパス。
        threshold_db (float, optional): 無音と見なす閾値（dBFS）。
            デフォルト ``-50``。

    Returns:
        bool: RMS が ``threshold_db`` 未満であれば ``True``（無音）、
            それ以外は ``False``。

    Note:
        ステレオファイルはチャンネル平均をとってからモノラル RMS を算出する。
        ``numpy`` および ``soundfile`` を関数内で遅延インポートする。
    """
    import numpy as np
    import soundfile as sf
    data, sr = sf.read(str(file_path))
    if data.ndim > 1:
        data = data.mean(axis=1)
    rms = np.sqrt(np.mean(data ** 2))
    db = 20 * np.log10(rms + 1e-10)
    return db < threshold_db


DRUM_MODEL = "drumsep"


def _ensure_drum_model(job):
    """ドラムを分けるモデルを用意して、ファイルのパスを返す。手元に無ければダウンロードする。

    ダウンロードの間は、ジョブをそのステージ（``DRUM_MODEL_STAGE``）に入れ、落とした量を
    進み具合として伝える（ファイルの大きさが分かっているので、本物の割合が出せる）。
    キャンセルされたら、ブロックの切れ目で止まる（書きかけは ``stem_models`` が消す）。

    Args:
        job (background_jobs.Job): この処理を動かしているジョブ。

    Returns:
        pathlib.Path: モデルのファイルのパス。

    Raises:
        stem_models.ModelUnavailableError: ダウンロードできなかった、またはハッシュが合わなかった場合。
        background_jobs.JobCancelled: ダウンロードの途中でキャンセルされた場合。
    """
    import stem_models

    if stem_models.is_cached(DRUM_MODEL):
        return stem_models.model_path(DRUM_MODEL)
    job.enter_stage(DRUM_MODEL_STAGE[0])
    size = stem_models.ADDON_MODELS[DRUM_MODEL]["size"]

    def on_bytes(done):
        job.check_cancelled()
        job.set_progress(done / size)

    return stem_models.ensure_model(DRUM_MODEL, on_bytes=on_bytes)


def separate_drums(
    drums_path: str,
    output_dir: str = "output",
    mp3_output: bool = False,
    segment: int = 7,
    jobs: int = 1,
    job=None,
    stage: str = DRUM_SPLIT_STAGE[0],
) -> dict[str, Path]:
    """ドラムのステムを、キック / スネア / タム / シンバルに分ける。

    追加のモデル（``stem_models.py`` の ``drumsep``）を使う。手元に無ければ、先にダウンロードする。
    入力はドラムだけの音（``htdemucs`` 系で分けたあとの ``drums``）を想定している。
    曲全体を入れても動くが、ドラム以外の音がどこかの部位に混ざる。

    Args:
        drums_path (str): ドラムのステムのパス。
        output_dir (str, optional): 出力先ルートディレクトリ。デフォルト ``"output"``。
        mp3_output (bool, optional): ``True`` → MP3 出力。デフォルト ``False``（WAV）。
        segment (int, optional): 処理セグメント長（秒）。デフォルト 7。
        jobs (int, optional): 並列ジョブ数。デフォルト 1。
        job (background_jobs.Job | None, optional): この処理を動かしているジョブ。
            進み具合の報告とキャンセルに使う。None なら報告しない。
        stage (str, optional): 分離のステージのキー。デフォルト ``"separate_drums"``。

    Returns:
        dict[str, Path]: ``"drums_kick"`` ``"drums_snare"`` ``"drums_toms"`` ``"drums_cymbals"`` を
            キー、出力ファイルパスを値とする辞書。実際にファイルが在るものだけを含む。

    Raises:
        FileNotFoundError: ``drums_path`` が存在しない場合。
        stem_models.ModelUnavailableError: モデルをダウンロードできなかった場合。
        RuntimeError: Demucs サブプロセスが失敗した場合。
        background_jobs.JobCancelled: ジョブがキャンセルされた場合（サブプロセスは kill 済み）。

    Note:
        ジョブが失敗またはキャンセルで終わったら、このトラックの出力ディレクトリは消される。
    """
    import background_jobs
    import demucs_progress
    import stem_models

    if job is None:
        job = background_jobs.detached()
    src = Path(drums_path)
    if not src.exists():
        raise FileNotFoundError(f"ファイルが見つかりません: {src}")

    model_file = _ensure_drum_model(job)
    cmd = [
        sys.executable, str(RUNNER),
        "--out", output_dir,
        "-n", DRUM_MODEL,
        "--bunri-model-file", str(model_file),
        "--segment", str(segment),
        "--jobs", str(jobs),
    ]
    if mp3_output:
        cmd += ["--mp3"]
    cmd.append(str(src))

    print(f"[*] モデル: {DRUM_MODEL}  ファイル: {src.name}")
    ext = ".mp3" if mp3_output else ".wav"
    base = Path(output_dir) / DRUM_MODEL / src.stem

    # 途中でやめたときに、書きかけのステムを残さない
    job.remove_on_abort(base)
    # モデルはすでに手元に在るので、モデルを用意するステージは設けない
    returncode = demucs_progress.run(cmd, model=DRUM_MODEL, job=job, stage=stage, model_stage=None)
    if returncode != 0:
        raise RuntimeError("ドラムの細分化（Demucs）の実行に失敗しました。")

    paths = {}
    for model_stem, key in stem_models.ADDON_MODELS[DRUM_MODEL]["stems"].items():
        p = base / f"{model_stem}{ext}"
        if p.exists():
            paths[key] = p
    return paths


def deep_separate(
    input_path: str,
    output_dir: str = "output",
    mp3_output: bool = False,
    segment: int = 7,
    jobs: int = 1,
    recursive_depth: int = 1,
    split_drums: bool = False,
    job=None,
) -> dict[str, Path]:
    """htdemucs_6s による多段のレイヤー分離を行い、有音ステムのパスを返す。

    以下の手順で最大限のレイヤー分離を試みる:

    1. ``htdemucs_6s`` で入力を6ステムに分離。
    2. ``split_drums`` が真なら、「drums」ステムをキック / スネア / タム / シンバルに分け、
       ``"drums_<部位>"`` として追加する（元の ``"drums"`` も残す）。
    3. ``recursive_depth > 0`` の場合、「other」ステムをさらに
       ``htdemucs_6s`` で再分離し ``"other_<stem>"`` として追加。
    4. 無音（RMS < -50 dBFS）のステムは結果から除外する。
    5. 再分離後のサブステムが全て無音の場合は元の ``"other"`` を残す。

    Args:
        input_path (str): 入力音声ファイルのパス。
        output_dir (str, optional): 出力先ルートディレクトリ。デフォルト ``"output"``。
        mp3_output (bool, optional): ``True`` → MP3 出力。``False`` → WAV 出力。
            デフォルト ``False``。
        segment (int, optional): Demucs の処理セグメント長（秒）。デフォルト 7。
        jobs (int, optional): 並列ジョブ数。デフォルト 1。
        recursive_depth (int, optional): ``"other"`` ステムを再帰分離する深さ。
            ``1`` で1回再分離、``0`` で再分離なし。デフォルト 1。
        split_drums (bool, optional): ドラムを部位ごとに分けるか。デフォルト ``False``。
            真のとき、追加のモデルが手元に無ければ最初にダウンロードする（約 160 MB）。
        job (background_jobs.Job | None, optional): この処理を動かしているジョブ。
            ステージは ``deep_separate_stages()`` のキーで進む。None なら報告しない。

    Returns:
        dict[str, Path]: ステム名をキー、出力ファイルパスを値とする辞書。
            無音ステムは除外済み。再分離ステムのキーは ``"other_vocals"`` 等の
            形式でプレフィックスされる。ドラムの部位は ``"drums"`` の直後に並ぶ。

    Raises:
        RuntimeError: Demucs サブプロセスが失敗した場合（``separate_audio`` が送出）。
        stem_models.ModelUnavailableError: ``split_drums`` が真で、モデルを用意できなかった場合。
            分離を始める前に送出する（数分かけて分離したあとで失敗しないように）。
        background_jobs.JobCancelled: ジョブがキャンセルされた場合。

    Note:
        第2段の出力は ``<output_dir>/deep_other/`` と ``<output_dir>/deep_drums/`` に書き出される。
        進捗ログは標準出力に直接出力される。
    """
    import background_jobs

    if job is None:
        job = background_jobs.detached()
    if split_drums:
        # 重い処理の前に、モデルを用意しておく。用意できなければここで止まる
        _ensure_drum_model(job)

    # 第1段: htdemucs_6s でフル分離
    print("[深層分離] === 第1段: htdemucs_6s フル分離 ===")
    first = separate_audio(
        input_path=input_path,
        output_dir=output_dir,
        model="htdemucs_6s",
        two_stems=False,
        mp3_output=mp3_output,
        segment=segment,
        jobs=jobs,
        job=job,
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
                if key == "drums" and split_drums:
                    print("\n[深層分離] === ドラムを部位ごとに分離 ===")
                    parts = separate_drums(
                        str(p),
                        output_dir=str(Path(output_dir) / "deep_drums"),
                        mp3_output=mp3_output,
                        segment=segment,
                        jobs=jobs,
                        job=job,
                    )
                    for part_key, part_p in parts.items():
                        if not _is_silent(part_p):
                            result[part_key] = part_p
                            print(f"[深層分離] {part_key}: 音声あり → 出力")
                        else:
                            print(f"[深層分離] {part_key}: ほぼ無音 → スキップ")
            else:
                print(f"[深層分離] {key} はほぼ無音のためスキップ")

    # 第2段: otherをさらに分離
    if other_path and other_path.exists() and recursive_depth > 0:
        if _is_silent(other_path):
            print("[深層分離] other はほぼ無音のためスキップ")
        else:
            print("\n[深層分離] === 第2段: otherステムを再分離 ===")
            other_out = str(Path(output_dir) / "deep_other")
            sub = separate_audio(
                input_path=str(other_path),
                output_dir=other_out,
                model="htdemucs_6s",
                two_stems=False,
                mp3_output=mp3_output,
                segment=segment,
                jobs=jobs,
                job=job,
                stage="separate_other",
                model_stage=None,
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