"""新しい4パート分離を、キャンセル可能な子プロセスで動かす。"""
import os
from pathlib import Path
import sys
import shutil

import modern_models

STEMS = ("vocals", "drums", "bass", "other")
RUNNER = Path(__file__).with_name("_modern_separate_runner.py")


def separate(input_path, output_dir, model, job=None):
    """分離中の出力だけをジョブへ登録し、成功した4つのWAVを返す。"""
    import background_jobs
    import demucs_progress

    if model not in modern_models.MODELS:
        raise ValueError("対応していない分離モデルです")
    source = Path(input_path)
    if not source.is_file():
        raise FileNotFoundError("分離する音源が見つかりません")
    if job is None:
        job = background_jobs.detached()
    destination = Path(output_dir) / model / source.stem
    job.check_cancelled()
    # ここはモデル専用の中間出力。画面のクリップが使うresults直下の成功済み音声は触らない。
    # workerは排他的にWAVを作るので、同じ曲の分け直しでも新規状態から始める。
    if destination.is_symlink():
        destination.unlink()
    elif destination.exists():
        shutil.rmtree(destination)
    job.remove_on_abort(destination)
    job.remove_on_abort(modern_models.partial_path(model))
    tracker = demucs_progress.Tracker(job, model)
    tracker.start()
    command = [sys.executable, str(RUNNER),
               "--input", str(source), "--out", str(destination), "--model", model,
               "--weights", str(modern_models.model_path(model))]
    env = dict(os.environ, **{demucs_progress.ENV_FLAG: "1", "PYTHONUNBUFFERED": "1"})
    result = job.run_process(command, on_line=tracker.on_line, env=env)
    if result != 0:
        raise RuntimeError(tracker.error_message or "選んだモデルで音源を分けられませんでした。もう一度実行してください。")
    paths = {name: destination / f"{name}.wav" for name in STEMS}
    if not all(path.is_file() for path in paths.values()):
        raise RuntimeError("分離結果の音声が揃っていません。もう一度パートに分けてください。")
    return paths
