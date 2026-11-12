"""bunri DAW — FastAPI バックエンド

API だけを持つ。画面（web-ui）はデスクトップアプリ（Tauri）が表示するので、ここからは配らない。
"""
import sys
from pathlib import Path

# backend/ をパスに追加（フラットに並んだ既存モジュールの参照用）
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from fastapi import Body, FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
import shutil
import tempfile
import json

from audio_utils import projects_dir, results_dir, safe_join, uploads_dir

app = FastAPI(title="bunri DAW API")

# デスクトップアプリから起動されたとき（BUNRI_TOKEN が在るとき）だけ、API に鍵をかける
import access_control
access_control.install_from_env(app)

# 時間のかかる処理はジョブとして動かす（進み具合の確認とキャンセルのため。docs/jobs.md）
from fastapi import Query
from web import job_routes
app.include_router(job_routes.router)

# プロジェクトの保存と読み込み（.bunri v2）と、データの整理
from web import project_routes
app.include_router(project_routes.router)

# ブラウザを自動操作するテストのための、わざと遅いジョブ（docs/jobs.md「テスト用の遅いジョブ」）。
# 環境変数 BUNRI_E2E_HOOKS=1 のときだけ足す。既定では足さない（配布物の sidecar には無い）
import os as _os
if _os.environ.get("BUNRI_E2E_HOOKS") == "1":
    from web import e2e_routes
    app.include_router(e2e_routes.router)


@app.get("/api/health")
async def api_health():
    """API サーバが応答できるかを返す（画面の見張りが数秒おきに呼ぶ。軽い処理だけ）。

    重い処理はジョブとして別のスレッドで動くので、その最中でも応答する。

    Returns:
        ``{"ok": True}``。
    """
    return {"ok": True}

# データ置き場（uploads/ results/ projects/）は audio_utils が決める。
# 置き場は環境変数 BUNRI_DATA_DIR で差し替えられるので、定数に固めず都度引く。


def _safe_path(base: Path, name: str) -> Path:
    """外から受け取ったファイル名を ``base`` 直下のパスに解決する。

    Args:
        base: 親ディレクトリ。
        name: リクエストに含まれていたファイル名。

    Returns:
        ``base`` 直下の絶対パス。

    Raises:
        HTTPException: 名前が ``base`` の外を指す、またはパス区切りを含む場合（HTTP 400）。
    """
    try:
        return safe_join(base, name)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _save_upload(upload: UploadFile) -> Path:
    """アップロードされたファイルを uploads/ に保存し、保存先パスを返す。

    Args:
        upload: FastAPI の ``UploadFile`` オブジェクト。``filename`` 属性が必要。

    Returns:
        保存先ファイルの絶対パス（``uploads/`` 直下）。

    Raises:
        HTTPException: ファイル名が ``../`` などで uploads/ の外を指す場合（HTTP 400）。
        OSError: ファイルの書き込みに失敗した場合。
    """
    dst = _safe_path(uploads_dir(), upload.filename)
    with open(dst, "wb") as f:
        shutil.copyfileobj(upload.file, f)
    return dst


# ---- シンセ / シーケンサー API ----

@app.post("/api/synth/note")
async def api_synth_note(
    note: str = Form("A"),
    octave: int = Form(4),
    duration: float = Form(1.0),
    waveform: str = Form("sine"),
    volume: float = Form(0.7),
    attack: float = Form(0.01),
    decay: float = Form(0.1),
    sustain: float = Form(0.7),
    release: float = Form(0.3),
):
    """単音をソフトウェアシンセで合成して WAV で返す。

    Args:
        note: 音名（例: ``"A"``, ``"C#"``）。
        octave: オクターブ（2〜6）。
        duration: 発音時間（秒）。
        waveform: 波形種別（``"sine"`` / ``"square"`` / ``"sawtooth"`` / ``"triangle"``）。
        volume: 出力音量（0.0〜1.0）。
        attack: ADSR アタック時間（秒）。
        decay: ADSR ディケイ時間（秒）。
        sustain: ADSR サスティンレベル（0.0〜1.0）。
        release: ADSR リリース時間（秒）。

    Returns:
        合成した WAV ファイルの ``FileResponse``（``audio/wav``）。
    """
    from synth import synth_note
    path = synth_note(note, octave, duration, waveform, volume,
                      attack, decay, sustain, release)
    return FileResponse(path, media_type="audio/wav")


@app.post("/api/synth/sequence")
async def api_synth_sequence(
    notes_json: str = Form(...),
    bpm: float = Form(120),
    waveform: str = Form("square"),
    volume: float = Form(0.5),
    attack: float = Form(0.01),
    decay: float = Form(0.05),
    sustain: float = Form(0.6),
    release: float = Form(0.1),
    instrument: str = Form(""),
    gm_program: str = Form(""),
):
    """ステップシーケンサーでノートシーケンスを合成して WAV で返す。

    Args:
        notes_json: ノートリストを表す JSON 文字列
            （例: ``'[{"note":"C","octave":4,"step":0,"length":4}]'``）。
        bpm: テンポ（BPM）。
        waveform: 波形種別（``"sine"`` / ``"square"`` 等）。GM 楽器指定時は無視。
        volume: 出力音量（0.0〜1.0）。
        attack: ADSR アタック時間（秒）。
        decay: ADSR ディケイ時間（秒）。
        sustain: ADSR サスティンレベル（0.0〜1.0）。
        release: ADSR リリース時間（秒）。
        instrument: 楽器カテゴリ名（FluidSynth 使用時）。空文字で波形合成。
        gm_program: GM プログラム番号（文字列）。``"none"`` または空文字で波形合成。

    Returns:
        合成した WAV ファイルの ``FileResponse``（``audio/wav``）。

    Raises:
        HTTPException: ``notes_json`` のパースや合成処理に失敗した場合（HTTP 400）。
    """
    from synth import step_sequencer
    try:
        inst = instrument if instrument else None
        gm = int(gm_program) if gm_program not in ("", "none") else None
        path = step_sequencer(notes_json, bpm, waveform, volume,
                              attack, decay, sustain, release,
                              instrument=inst, gm_program=gm)
        return FileResponse(path, media_type="audio/wav")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/gm-instruments")
async def api_gm_instruments():
    """利用可能な GM 楽器一覧を返す。

    Returns:
        プログラム番号と楽器名のリスト（JSON）。各要素は
        ``{"program": int, "name": str}`` の形式。
    """
    from synth import GM_INSTRUMENTS
    return [{"program": k, "name": v} for k, v in GM_INSTRUMENTS.items()]


@app.post("/api/synth/drum")
async def api_drum(
    pattern: str = Form("8ビート"),
    bpm: float = Form(120),
    bars: int = Form(4),
    volume: float = Form(0.7),
):
    """ドラムマシンでパターンを生成し WAV で返す。

    Args:
        pattern: ドラムパターン名（例: ``"8ビート"``, ``"4つ打ち"``, ``"ボサノバ"``）。
        bpm: テンポ（BPM）。
        bars: 生成する小節数。
        volume: 出力音量（0.0〜1.0）。

    Returns:
        生成した WAV ファイルの ``FileResponse``（``audio/wav``）。

    Raises:
        HTTPException: 不明なパターン名などで失敗した場合（HTTP 400）。
    """
    from synth import drum_machine
    try:
        path = drum_machine(pattern, bpm, bars, volume)
        return FileResponse(path, media_type="audio/wav")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/synth/vst")
async def api_synth_vst(
    midi: UploadFile = File(...),
    plugin_path: str = Form(...),
    duration: float = Form(30.0),
    preset_path: str = Form(""),
    sample_rate: int = Form(44100),
):
    """VST3 プラグインで MIDI をレンダリングして WAV で返す。

    ``vst_renderer.VST3Renderer`` を呼び出し、アップロードされた MIDI を
    指定の VST3 プラグインでオフラインレンダリングする。出力は既存の
    シンセ系エンドポイントと同じく ``audio/wav`` の ``FileResponse``。

    Args:
        midi: アップロードされた MIDI ファイル（``.mid`` / ``.midi``）。
        plugin_path: サーバー側から見た VST3 のパス（``.vst3`` バンドル/ファイル）。
        duration: レンダリング時間（秒）。デフォルトは 30 秒。
        preset_path: 任意のプリセットファイル（``.vstpreset`` / ``.fxp`` 等）。
            空文字のときはプラグインのデフォルト状態で読み込む。
        sample_rate: サンプルレート（Hz）。デフォルト 44100。

    Returns:
        レンダリングした WAV ファイルの ``FileResponse``（``audio/wav``）。

    Raises:
        HTTPException: dawdreamer 未インストール時（HTTP 500）、
            プラグイン/プリセット/MIDI が見つからない場合（HTTP 400）、
            レンダリング中に例外が発生した場合（HTTP 500）。
    """
    # 重いインポートは関数内で遅延実行（プロジェクト規約）
    from vst_renderer import render_vst_midi

    midi_path = _save_upload(midi)
    preset = preset_path or None

    try:
        out_path = render_vst_midi(
            plugin_path=plugin_path,
            midi_path=str(midi_path),
            duration=duration,
            preset_path=preset,
            sr=sample_rate,
        )
    except ImportError as e:
        raise HTTPException(500, f"dawdreamer が利用できません: {e}")
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))
    except (ValueError, RuntimeError) as e:
        raise HTTPException(500, f"VST3 レンダリングに失敗しました: {e}")

    return FileResponse(out_path, media_type="audio/wav")


@app.post("/api/metronome")
async def api_metronome(
    bpm: float = Form(120),
    beats_per_bar: int = Form(4),
    bars: int = Form(8),
    volume: float = Form(0.7),
):
    """メトロノーム音声を生成して WAV で返す。

    Args:
        bpm: テンポ（BPM）。
        beats_per_bar: 1小節あたりの拍数（例: ``4`` = 4/4拍子）。
        bars: 生成する小節数。
        volume: クリック音の音量（0.0〜1.0）。

    Returns:
        生成したメトロノーム WAV ファイルの ``FileResponse``（``audio/wav``）。
    """
    from metronome import generate_metronome
    path = generate_metronome(bpm, beats_per_bar, bars, volume)
    return FileResponse(path, media_type="audio/wav")


# ---- エフェクト API ----

@app.post("/api/effects/{effect_name}")
async def api_effect(
    effect_name: str,
    file: UploadFile = File(...),
    params: str = Form("{}"),
):
    """指定したエフェクトを音声ファイルに適用して WAV で返す。

    Args:
        effect_name: 適用するエフェクト名。以下が有効:
            ``eq``, ``compressor``, ``reverb``, ``delay``, ``volume``,
            ``normalize``, ``fade_in``, ``fade_out``, ``pan``, ``reverse``,
            ``pitch_shift``, ``time_stretch``, ``speed``。
        file: 処理対象の音声ファイル（マルチパートアップロード）。
        params: エフェクトパラメータの JSON 文字列（例: ``'{"db": -3}'``）。

    Returns:
        エフェクト適用後の WAV ファイルの ``FileResponse``（``audio/wav``）。

    Raises:
        HTTPException: ``effect_name`` が無効な場合（HTTP 400）。
        HTTPException: エフェクト処理中に ``ValueError`` が発生した場合（HTTP 400）。
    """
    import effects
    import edit
    import pitch_time

    src = _save_upload(file)
    p = json.loads(params)

    dispatch = {
        "eq": lambda: effects.eq_3band(str(src), p.get("low", 0), p.get("mid", 0), p.get("high", 0)),
        "compressor": lambda: effects.compressor(str(src), p.get("threshold", -20), p.get("ratio", 4),
                                                  p.get("attack", 10), p.get("release", 100)),
        "reverb": lambda: effects.reverb(str(src), p.get("room_size", 0.5), p.get("wet", 0.3)),
        "delay": lambda: effects.delay_effect(str(src), p.get("delay_ms", 300),
                                               p.get("feedback", 0.4), p.get("wet", 0.3)),
        "volume": lambda: edit.change_volume(str(src), p.get("db", 0)),
        "normalize": lambda: edit.normalize_audio(str(src)),
        "fade_in": lambda: edit.fade_in(str(src), p.get("duration", 3)),
        "fade_out": lambda: edit.fade_out(str(src), p.get("duration", 3)),
        "pan": lambda: edit.pan_audio(str(src), p.get("pan", 0)),
        "reverse": lambda: edit.reverse_audio(str(src)),
        "pitch_shift": lambda: pitch_time.pitch_shift(str(src), p.get("semitones", 0)),
        "time_stretch": lambda: pitch_time.time_stretch(str(src), p.get("rate", 1.0)),
        "speed": lambda: edit.change_speed(str(src), p.get("speed", 1.0)),
    }

    if effect_name not in dispatch:
        raise HTTPException(400, f"不明なエフェクト: {effect_name}")
    try:
        path = dispatch[effect_name]()
        return FileResponse(path, media_type="audio/wav")
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- 編集 API ----

@app.post("/api/edit/{action}")
async def api_edit(
    action: str,
    file: UploadFile = File(...),
    params: str = Form("{}"),
):
    """指定した編集操作を音声ファイルに適用して WAV で返す。

    Args:
        action: 編集操作名。以下が有効:
            ``trim``, ``cut``, ``copy_range``, ``silence``, ``loop``。
        file: 処理対象の音声ファイル（マルチパートアップロード）。
        params: 操作パラメータの JSON 文字列
            （例: ``'{"start": 1.0, "end": 5.0}'``）。

    Returns:
        編集後の WAV ファイルの ``FileResponse``（``audio/wav``）。
        複数ファイルを返す操作（``split_at`` 等）では先頭ファイルを返す。

    Raises:
        HTTPException: ``action`` が無効な場合（HTTP 400）。
        HTTPException: パラメータ不足または値域エラーの場合（HTTP 400）。
    """
    import edit

    src = _save_upload(file)
    p = json.loads(params)

    dispatch = {
        "trim": lambda: edit.trim_audio(str(src), p["start"], p["end"]),
        "cut": lambda: edit.cut_audio(str(src), p["start"], p["end"]),
        "copy_range": lambda: edit.copy_range(str(src), p["start"], p["end"], p["insert_at"]),
        "silence": lambda: edit.insert_silence(str(src), p["position"], p["length"]),
        "loop": lambda: edit.loop_range(str(src), p["start"], p["end"], p["count"]),
    }

    if action not in dispatch:
        raise HTTPException(400, f"不明なアクション: {action}")
    try:
        result = dispatch[action]()
        if isinstance(result, tuple):
            # split_at 等の複数返却は最初のファイルを返す
            return FileResponse(result[0], media_type="audio/wav")
        return FileResponse(result, media_type="audio/wav")
    except KeyError as e:
        # str(KeyError) は "'start'" のような引用符付きの名前だけになるので、文にして返す
        raise HTTPException(400, f"パラメータが足りません: {e.args[0]}")
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- バッチ編集 API ----

@app.post("/api/batch/edit")
async def api_batch_edit(
    files: list[UploadFile] = File(...),
    action: str = Form("trim"),
    params: str = Form("{}"),
):
    """複数ファイルに同じ編集操作を一括適用して結果をダウンロードリンクで返す。

    Args:
        files: 処理対象の音声ファイルリスト（マルチパートアップロード）。
        action: 編集操作名（``trim``, ``cut``, ``silence``, ``loop``,
            ``reverse``, ``normalize``, ``volume``, ``fade_in``, ``fade_out``,
            ``speed`` のいずれか）。
        params: 操作パラメータの JSON 文字列。

    Returns:
        各ファイルの処理結果リスト（JSON）。各要素は
        ``{"filename": str, "url": str | None, "status": str}`` の形式。
        個別ファイルのエラーは ``status`` に記録され、全体は 200 で返る。

    Raises:
        HTTPException: ``action`` が無効な場合（HTTP 400）。
    """
    import edit
    p = json.loads(params)

    dispatch_fn = {
        "trim": lambda src: edit.trim_audio(src, p["start"], p["end"]),
        "cut": lambda src: edit.cut_audio(src, p["start"], p["end"]),
        "silence": lambda src: edit.insert_silence(src, p["position"], p["length"]),
        "loop": lambda src: edit.loop_range(src, p["start"], p["end"], p["count"]),
        "reverse": lambda src: edit.reverse_audio(src),
        "normalize": lambda src: edit.normalize_audio(src),
        "volume": lambda src: edit.change_volume(src, p.get("db", 0)),
        "fade_in": lambda src: edit.fade_in(src, p.get("duration", 3)),
        "fade_out": lambda src: edit.fade_out(src, p.get("duration", 3)),
        "speed": lambda src: edit.change_speed(src, p.get("speed", 1.0)),
    }
    if action not in dispatch_fn:
        raise HTTPException(400, f"不明なアクション: {action}")

    results = []
    for upload in files:
        src = _save_upload(upload)
        try:
            out = dispatch_fn[action](str(src))
            dst_name = f"batch_{action}_{upload.filename}"
            dst = results_dir() / dst_name
            shutil.copy2(out, str(dst))
            results.append({
                "filename": upload.filename,
                "url": f"/api/download/{dst_name}",
                "status": "ok",
            })
        except KeyError as e:
            # str(KeyError) は "'start'" のような引用符付きの名前だけになるので、文にして返す
            results.append({
                "filename": upload.filename,
                "url": None,
                "status": f"error: パラメータが足りません: {e.args[0]}",
            })
        except Exception as e:
            results.append({
                "filename": upload.filename,
                "url": None,
                "status": f"error: {e}",
            })
    return JSONResponse(results)


@app.post("/api/batch/effects")
async def api_batch_effects(
    files: list[UploadFile] = File(...),
    effect_name: str = Form("normalize"),
    params: str = Form("{}"),
):
    """複数ファイルに同じエフェクトを一括適用して結果をダウンロードリンクで返す。

    Args:
        files: 処理対象の音声ファイルリスト（マルチパートアップロード）。
        effect_name: エフェクト名（``eq``, ``compressor``, ``reverb``, ``delay``,
            ``volume``, ``normalize``, ``fade_in``, ``fade_out``, ``pan``,
            ``reverse``, ``pitch_shift``, ``time_stretch``, ``speed`` のいずれか）。
        params: エフェクトパラメータの JSON 文字列。

    Returns:
        各ファイルの処理結果リスト（JSON）。各要素は
        ``{"filename": str, "url": str | None, "status": str}`` の形式。
        個別ファイルのエラーは ``status`` に記録され、全体は 200 で返る。

    Raises:
        HTTPException: ``effect_name`` が無効な場合（HTTP 400）。
    """
    import effects
    import edit
    import pitch_time

    p = json.loads(params)

    dispatch_fn = {
        "eq": lambda src: effects.eq_3band(src, p.get("low", 0), p.get("mid", 0), p.get("high", 0)),
        "compressor": lambda src: effects.compressor(src, p.get("threshold", -20), p.get("ratio", 4),
                                                      p.get("attack", 10), p.get("release", 100)),
        "reverb": lambda src: effects.reverb(src, p.get("room_size", 0.5), p.get("wet", 0.3)),
        "delay": lambda src: effects.delay_effect(src, p.get("delay_ms", 300),
                                                    p.get("feedback", 0.4), p.get("wet", 0.3)),
        "volume": lambda src: edit.change_volume(src, p.get("db", 0)),
        "normalize": lambda src: edit.normalize_audio(src),
        "fade_in": lambda src: edit.fade_in(src, p.get("duration", 3)),
        "fade_out": lambda src: edit.fade_out(src, p.get("duration", 3)),
        "pan": lambda src: edit.pan_audio(src, p.get("pan", 0)),
        "reverse": lambda src: edit.reverse_audio(src),
        "pitch_shift": lambda src: pitch_time.pitch_shift(src, p.get("semitones", 0)),
        "time_stretch": lambda src: pitch_time.time_stretch(src, p.get("rate", 1.0)),
        "speed": lambda src: edit.change_speed(src, p.get("speed", 1.0)),
    }
    if effect_name not in dispatch_fn:
        raise HTTPException(400, f"不明なエフェクト: {effect_name}")

    results = []
    for upload in files:
        src = _save_upload(upload)
        try:
            out = dispatch_fn[effect_name](str(src))
            dst_name = f"batch_{effect_name}_{upload.filename}"
            dst = results_dir() / dst_name
            shutil.copy2(out, str(dst))
            results.append({
                "filename": upload.filename,
                "url": f"/api/download/{dst_name}",
                "status": "ok",
            })
        except KeyError as e:
            # str(KeyError) は "'start'" のような引用符付きの名前だけになるので、文にして返す
            results.append({
                "filename": upload.filename,
                "url": None,
                "status": f"error: パラメータが足りません: {e.args[0]}",
            })
        except Exception as e:
            results.append({
                "filename": upload.filename,
                "url": None,
                "status": f"error: {e}",
            })
    return JSONResponse(results)


# ---- ミキサー API ----

@app.post("/api/mixer")
async def api_mixer(
    files: list[UploadFile] = File(...),
    config: str = Form("{}"),
):
    """最大4トラックをミキシングして WAV で返す。

    Args:
        files: ミキシングするトラックファイルのリスト（最大4件）。
        config: ミキサー設定の JSON 文字列。形式::

                {
                    "tracks": [{"vol": 0, "pan": 0, "mute": false}, ...],
                    "master_vol": 0
                }

            ``vol`` は dB 調整量、``pan`` は -1.0〜1.0、``master_vol`` は
            マスター出力の dB 調整量。

    Returns:
        ミキシング後の WAV ファイルの ``FileResponse``（``audio/wav``）。

    Raises:
        HTTPException: ミキシング処理中に ``ValueError`` が発生した場合（HTTP 400）。
    """
    from mixer import mix_tracks

    c = json.loads(config)
    tracks_config = c.get("tracks", [])
    master = c.get("master_vol", 0)

    # 最大4トラック
    args = []
    for i in range(4):
        if i < len(files) and i < len(tracks_config):
            tc = tracks_config[i]
            path = _save_upload(files[i])
            args.extend([str(path), tc.get("vol", 0), tc.get("pan", 0), tc.get("mute", False)])
        else:
            args.extend([None, 0, 0, True])
    args.append(master)

    try:
        path = mix_tracks(*args)
        return FileResponse(path, media_type="audio/wav")
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- 音声解析 API ----

@app.post("/api/analyze")
async def api_analyze(
    file: UploadFile = File(...),
    bpm: float = Form(120),
    sensitivity: float = Form(0.5),
    engine: str = Form("basic_pitch"),
    run_async: bool = Query(False, alias="async"),
):
    """WAV ファイルを解析してピアノロール用ノートデータを返す。

    Args:
        file: 解析する音声ファイル（マルチパートアップロード）。
        bpm: プロジェクトの BPM（ノートのステップ計算に使用）。
        sensitivity: ノート検出感度（0.0〜1.0）。高いほど微弱な音も検出する。
        engine: 解析エンジン（``"basic_pitch"`` または ``"pyin"``）。
        run_async: クエリ ``?async=1``。付けると、ジョブを始めてすぐ返す（``job_routes.dispatch``）。

    Returns:
        ノートデータのリスト（JSON）。各要素は
        ``{"note": str, "octave": int, "step": int, "length": int}`` の形式。
        ``?async=1`` のときは、ジョブの状態（HTTP 202）。

    Raises:
        HTTPException: 解析処理中に例外が発生した場合（HTTP 500）。
    """
    def task(job, src):
        from analyze import analyze_wav
        # 採譜はひとまとまりの処理で、途中の進み具合は取れず、途中で止めることもできない
        job.enter_stage("transcribe")
        return analyze_wav(str(src), bpm=bpm, sensitivity=sensitivity, engine=engine)

    return await job_routes.dispatch(
        "analyze", title="採譜", filename=file.filename,
        stages=[("transcribe", "ノートを読み取っています")],
        prepare=lambda: _save_upload(file), task=task, run_async=run_async,
    )


# ---- 音源分離 API ----

def _stem_links(job, paths: dict, prefix: str, filename: str) -> dict:
    """分離したステムを results/ 直下に置き、ダウンロードリンクの辞書にする（可変数ステム）。

    Args:
        job: 動かしているジョブ。失敗・キャンセルのときに、置いたファイルを消してもらう。
        paths: ステム名をキー、分離結果のファイルパスを値とする辞書。
        prefix: 置くファイル名の頭（``"sep"`` / ``"deep"``）。
        filename: アップロードされたファイル名。

    Returns:
        ステム名をキー、``{"url": str, "label": str}`` を値とする辞書。
    """
    from separate import STEM_LABELS

    result = {}
    for key, p in paths.items():
        p = Path(p)
        if p.exists():
            dst = results_dir() / f"{prefix}_{key}_{filename}"
            job.remove_on_abort(dst)
            shutil.copy2(str(p), str(dst))
            result[key] = {
                "url": f"/api/download/{dst.name}",
                "label": STEM_LABELS.get(key, key),
            }
    return result


@app.post("/api/separate")
async def api_separate(
    file: UploadFile = File(...),
    model: str = Form("htdemucs"),
    two_stems: str = Form("true"),
    run_async: bool = Query(False, alias="async"),
):
    """Demucs で音源を分離してダウンロードリンクを返す。

    Args:
        file: 分離対象の音声ファイル（マルチパートアップロード）。
        model: Demucs モデル名（例: ``"htdemucs"``）。
        two_stems: ``"true"`` でボーカル/伴奏の2ステム分離、
            ``"false"`` で4ステム（vocals/drums/bass/other）分離。
        run_async: クエリ ``?async=1``。付けると、ジョブを始めてすぐ返す（``job_routes.dispatch``）。

    Returns:
        ステム名をキー、``{"url": str, "label": str}`` を値とする辞書（JSON）。
        ``?async=1`` のときは、ジョブの状態（HTTP 202）。

    Raises:
        HTTPException: 分離処理中に例外が発生した場合（HTTP 500）。
    """
    from separate import SEPARATE_STAGES
    filename = file.filename
    is_two_stems = two_stems.lower() in ("true", "1", "yes")

    def task(job, src):
        from separate import separate_audio
        paths = separate_audio(
            str(src), output_dir=str(results_dir() / "separated"), model=model,
            two_stems=is_two_stems, segment=7, jobs=1, job=job,
        )
        return _stem_links(job, paths, "sep", filename)

    return await job_routes.dispatch(
        "separate", title="パート分離", filename=filename, stages=SEPARATE_STAGES,
        prepare=lambda: _save_upload(file), task=task, run_async=run_async,
    )


@app.post("/api/deep-separate")
async def api_deep_separate(
    file: UploadFile = File(...),
    depth: int = Form(1),
    run_async: bool = Query(False, alias="async"),
):
    """htdemucs_6s による深層分離を実行してダウンロードリンクを返す。

    ``other`` ステムを再帰的に再分離することで最大限レイヤーを分割する。

    Args:
        file: 分離対象の音声ファイル（マルチパートアップロード）。
        depth: 再帰分離の深さ（1 = 追加再分離なし）。
        run_async: クエリ ``?async=1``。付けると、ジョブを始めてすぐ返す（``job_routes.dispatch``）。

    Returns:
        ステム名をキー、``{"url": str, "label": str}`` を値とする辞書（JSON）。
        ``?async=1`` のときは、ジョブの状態（HTTP 202）。

    Raises:
        HTTPException: 分離処理中に例外が発生した場合（HTTP 500）。
    """
    from separate import DEEP_SEPARATE_STAGES
    filename = file.filename
    # 再分離をしないなら、そのステージは並びに入れない
    stages = [s for s in DEEP_SEPARATE_STAGES if int(depth) > 0 or s[0] != "separate_other"]

    def task(job, src):
        from separate import deep_separate
        paths = deep_separate(
            str(src), output_dir=str(results_dir() / "separated"),
            segment=7, jobs=1, recursive_depth=int(depth), job=job,
        )
        return _stem_links(job, paths, "deep", filename)

    return await job_routes.dispatch(
        "deep_separate", title="パート分離（6 パート）", filename=filename, stages=stages,
        prepare=lambda: _save_upload(file), task=task, run_async=run_async,
    )


@app.post("/api/deep-analyze")
async def api_deep_analyze(
    file: UploadFile = File(...),
):
    """音声ファイルの詳細解析レポートをマークダウンで返す。

    周波数帯域エネルギー分布・推定楽器構成・テンポ・スペクトル特徴を含む。

    Args:
        file: 解析する音声ファイル（マルチパートアップロード）。

    Returns:
        マークダウン形式のレポートを含む JSON（``{"report": str}``）。

    Raises:
        HTTPException: 解析処理中に例外が発生した場合（HTTP 500）。
    """
    from deep_separate import analyze_audio
    src = _save_upload(file)
    try:
        report = analyze_audio(str(src))
        return JSONResponse({"report": report})
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/models/{name}/status")
async def api_model_status(name: str):
    """音源分離モデルが手元に在るか（初回ダウンロードが要るか）を返す。

    モデルは初めて使うときにネットワークから落ちてくる。画面がその待ち時間を
    事前に伝えられるようにするための API。

    Args:
        name: Demucs のモデル名（例: ``"htdemucs"``）。

    Returns:
        ``{"model": 名前, "cached": bool, "missing": 足りないファイル数}``。

    Raises:
        HTTPException: 知らないモデル名の場合（HTTP 404）。
    """
    import model_cache

    try:
        return model_cache.model_status(name)
    except KeyError:
        raise HTTPException(404, "モデルが見つかりません")


@app.get("/api/download/{filename}")
async def api_download(filename: str):
    """results/ ディレクトリ内のファイルをダウンロードとして返す。

    Args:
        filename: ダウンロードするファイル名（パス区切り文字を含まない）。

    Returns:
        指定ファイルの ``FileResponse``（``audio/wav``）。

    Raises:
        HTTPException: ``filename`` が results/ の外を指す場合（HTTP 400）、
            results/ に存在しない場合（HTTP 404）。
    """
    path = _safe_path(results_dir(), filename)
    if not path.is_file():
        raise HTTPException(404, "ファイルが見つかりません")
    return FileResponse(str(path), media_type="audio/wav",
                        filename=filename)


# ---- オーバーレイ API ----

@app.post("/api/overlay")
async def api_overlay(
    base_file: UploadFile = File(...),
    overlay_file: UploadFile = File(...),
    offset_sec: float = Form(0),
    base_vol_db: float = Form(0),
    overlay_vol_db: float = Form(0),
):
    """2つの音声ファイルを合成（オーバーレイ）して WAV で返す。

    Args:
        base_file: ベースとなる音声ファイル（マルチパートアップロード）。
        overlay_file: 重ねる音声ファイル（マルチパートアップロード）。
        offset_sec: オーバーレイを開始するオフセット時間（秒）。
        base_vol_db: ベース音声の音量調整（dB）。
        overlay_vol_db: オーバーレイ音声の音量調整（dB）。

    Returns:
        合成後の WAV ファイルの ``FileResponse``（``audio/wav``）。
        ダウンロードファイル名は ``overlay_result.wav``。

    Raises:
        HTTPException: 合成処理中に ``ValueError`` が発生した場合（HTTP 400）。
    """
    from overlay import overlay_audio
    base_path = _save_upload(base_file)
    over_path = _save_upload(overlay_file)
    try:
        path = overlay_audio(str(base_path), str(over_path),
                              offset_sec, base_vol_db, overlay_vol_db)
        return FileResponse(path, media_type="audio/wav",
                            filename="overlay_result.wav")
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- フォーマット変換 API ----

@app.post("/api/convert/{target}")
async def api_convert(
    target: str,
    file: UploadFile = File(...),
    bitrate: int = Form(192),
):
    """音声・動画ファイルを指定フォーマットに変換して返す。

    Args:
        target: 変換先フォーマット（``"wav"`` または ``"mp3"``）。
        file: 変換元ファイル（マルチパートアップロード）。MP4/動画・音声ファイルを想定。
        bitrate: MP3 出力時のビットレート（kbps）。WAV 変換時は無視。

    Returns:
        変換後のファイルの ``FileResponse``（``audio/wav`` または ``audio/mp3``）。
        ダウンロードファイル名は ``converted.<target>``。

    Raises:
        HTTPException: ``target`` が ``"wav"``/``"mp3"`` 以外の場合（HTTP 400）。
        HTTPException: 変換処理中に ``ValueError`` が発生した場合（HTTP 400）。
    """
    from convert import mp4_to_wav, mp4_to_mp3
    src = _save_upload(file)
    try:
        if target == "wav":
            path = mp4_to_wav(str(src))
        elif target == "mp3":
            path = mp4_to_mp3(str(src), bitrate)
        else:
            raise HTTPException(400, f"不明な変換先: {target}")
        return FileResponse(path, media_type=f"audio/{target}",
                            filename=f"converted.{target}")
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- 以前の形式のプロジェクト（projects/*.json） ----
# 画面の保存は .bunri（web/project_routes.py）に移った。ここは以前の形式を読み書きする口として残す
# （以前の版が保存したものを「以前の形式」として開く。ブラウザのテストが以前の形式を用意するのにも使う）。

@app.post("/api/project/save")
async def save_project(data: str = Form(...)):
    """以前の形式のプロジェクト（JSON。音声を持たない）を保存する。画面はもう使わない。

    タイムラインのクリップ配置・オートメーション等を含む JSON 文字列を
    ``projects/project_<timestamp>.json`` として保存する。

    Args:
        data: 保存するプロジェクトデータの JSON 文字列。

    Returns:
        保存されたファイル名を含む辞書（例: ``{"filename": "project_1234567890.json"}``）。
    """
    project_dir = projects_dir()
    import time
    name = f"project_{int(time.time())}.json"
    (project_dir / name).write_text(data, encoding="utf-8")
    return {"filename": name}


@app.get("/api/project/list")
async def list_projects():
    """保存済みプロジェクトのファイル名一覧を返す。

    Returns:
        プロジェクトファイル名（文字列）のリスト（JSON）。
        新しいものが先頭になるよう降順ソートされる。
    """
    project_dir = projects_dir()
    files = sorted(project_dir.glob("*.json"), reverse=True)
    return [f.name for f in files]


@app.get("/api/project/load/{name}")
async def load_project(name: str):
    """指定した名前のプロジェクトを読み込んで JSON で返す。

    Args:
        name: 読み込むプロジェクトファイル名（拡張子 ``.json`` を含む）。

    Returns:
        プロジェクトデータの ``JSONResponse``。

    Raises:
        HTTPException: ``name`` が projects/ の外を指す場合（HTTP 400）、
            projects/ に存在しない場合（HTTP 404）。
    """
    path = _safe_path(projects_dir(), name)
    if not path.is_file():
        raise HTTPException(404, "プロジェクトが見つかりません")
    return JSONResponse(json.loads(path.read_text(encoding="utf-8")))


# ---- 音源分解（Decompose）API ----

@app.post("/api/decompose")
async def api_decompose(
    file: UploadFile = File(...),
    bpm: float = Form(0),
    grid_offset: float = Form(0),
    sensitivity: float = Form(0.5),
    run_async: bool = Query(False, alias="async"),
):
    """WAV ファイルを分離・ピッチ解析・楽器推定まで一括処理して返す。

    Args:
        file: 処理対象の音声ファイル（マルチパートアップロード）。
        bpm: プロジェクトの BPM（小数も可）。``0`` を指定すると自動検出する。
        grid_offset: ノートのステップ 0 を置く位置（秒）。楽曲カルテの 1 拍目の位置を渡すと、
            カルテとピアノロールの小節番号がそろう（``decompose.seconds_to_step``）。
        sensitivity: ノート検出感度（0.0〜1.0）。
        run_async: クエリ ``?async=1``。付けると、ジョブを始めてすぐ返す（``job_routes.dispatch``）。

    Returns:
        分解結果の ``JSONResponse``。各ステムに ``audio_url`` と
        ノートデータ・楽器推定結果が含まれる。``audio_path`` は除去済み。
        ``?async=1`` のときは、ジョブの状態（HTTP 202）。

    Raises:
        HTTPException: 処理中に例外が発生した場合（HTTP 500）。
    """
    from decompose import decompose_stages

    filename = file.filename
    detected_bpm = bpm if bpm > 0 else None

    def task(job, src):
        from decompose import decompose
        result = decompose(
            str(src), bpm=detected_bpm, sensitivity=sensitivity,
            segment=7, jobs=1, job=job, grid_offset_sec=max(0.0, grid_offset),
        )

        # 音声ファイルのパスをダウンロードURLに変換
        for stem_name, stem_data in result["stems"].items():
            audio_path = Path(stem_data["audio_path"])
            if audio_path.exists():
                dst_name = f"decompose_{stem_name}_{filename}"
                dst = results_dir() / dst_name
                job.remove_on_abort(dst)
                shutil.copy2(str(audio_path), str(dst))
                stem_data["audio_url"] = f"/api/download/{dst_name}"
            del stem_data["audio_path"]

        return result

    return await job_routes.dispatch(
        "decompose", title="パート分離と採譜", filename=filename,
        stages=decompose_stages(detect_bpm=detected_bpm is None),
        prepare=lambda: _save_upload(file), task=task, run_async=run_async,
    )


# ---- WAV最適化 API ----

@app.post("/api/wav/info")
async def api_wav_info(file: UploadFile = File(...)):
    """WAV ファイルのメタデータと詳細情報を返す。

    Args:
        file: 情報を取得する WAV ファイル（マルチパートアップロード）。

    Returns:
        サンプルレート・ビット深度・チャンネル数・ファイルサイズ等を含む
        ``JSONResponse``。

    Raises:
        HTTPException: ファイル読み取りや解析に失敗した場合（HTTP 500）。
    """
    from wav_optimize import get_wav_info
    src = _save_upload(file)
    try:
        info = get_wav_info(str(src))
        return JSONResponse(info)
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/wav/optimize")
async def api_wav_optimize(
    file: UploadFile = File(...),
    target_sr: int = Form(44100),
    target_bit_depth: int = Form(16),
):
    """WAV ファイルをリサンプリング・ビット深度変換して容量を削減する。

    Args:
        file: 最適化する WAV ファイル（マルチパートアップロード）。
        target_sr: 目標サンプルレート（Hz）。デフォルト 44100。
        target_bit_depth: 目標ビット深度（16 または 24）。デフォルト 16。

    Returns:
        最適化結果の ``JSONResponse``。``download_url`` キーにダウンロード
        リンクを含み、``path`` キーは除去済み。

    Raises:
        HTTPException: 最適化処理中に例外が発生した場合（HTTP 500）。
    """
    from wav_optimize import optimize_wav
    src = _save_upload(file)
    try:
        result = optimize_wav(str(src), target_sr, target_bit_depth)
        opt_path = Path(result["path"])
        dst_name = f"optimized_{file.filename}"
        dst = results_dir() / dst_name
        import shutil
        shutil.copy2(str(opt_path), str(dst))
        result["download_url"] = f"/api/download/{dst_name}"
        del result["path"]
        return JSONResponse(result)
    except Exception as e:
        raise HTTPException(500, str(e))


# ---- 楽曲カルテ API（第1層） ----

def _chart_path(chart_id: str) -> Path:
    """カルテIDから `.bunri` ファイルのパスを解決する。

    ``chart_id`` にパス区切りや親ディレクトリ参照が含まれていた場合は
    ファイル名部分だけを取り出し、results/charts/ の外へ出られないようにする。

    Args:
        chart_id: カルテID（拡張子なし）。

    Returns:
        `.bunri` ファイルのパス。

    Raises:
        HTTPException: ``chart_id`` が空、または解決結果が
            results/charts/ の外を指す場合（HTTP 400）。
    """
    from audio_utils import results_dir

    safe = Path(str(chart_id)).name
    if not safe or safe.startswith("."):
        raise HTTPException(400, "カルテIDが不正です")

    charts_dir = results_dir("charts").resolve()
    path = (charts_dir / f"{safe}.bunri").resolve()
    if path.parent != charts_dir:
        raise HTTPException(400, "カルテIDが不正です")
    return path


def _chart_payload(chart: dict, chart_id: str, audio_path: Path) -> dict:
    """カルテ・波形ピーク・用語辞書をまとめた API レスポンスの中身を組み立てる。

    波形ピークと用語辞書はカルテ本体に含めない。カルテはプロンプトキャッシュの
    プレフィックスとしてバイト安定である必要があり、サイズも抑えたいため。

    Args:
        chart: ``song_chart.build_chart`` が返したカルテ辞書。
        chart_id: カルテID。
        audio_path: 波形ピークを生成する元音声のパス。

    Returns:
        ``{"chart_id", "chart", "peaks", "glossary"}`` を持つ辞書。
    """
    import song_chart
    from music_theory import GLOSSARY

    return {
        "chart_id": chart_id,
        "chart": chart,
        "peaks": song_chart.waveform_peaks(str(audio_path)),
        "glossary": GLOSSARY,
    }


def _chart_stages() -> list:
    """カルテを作るジョブのステージの並び（解析のステージ + 保存）を返す。"""
    import song_chart

    return list(song_chart.CHART_STAGES) + [("save", "カルテを保存しています")]


@app.post("/api/chart")
async def api_chart(
    file: UploadFile = File(...),
    bpm: float = Form(0),
    downbeat_offset: float = Form(-1),
    beats_per_bar: int = Form(4),
    run_async: bool = Query(False, alias="async"),
):
    """音声ファイルから楽曲カルテ（速報）を生成する。

    ステム分離を行わないため数秒〜十数秒で完了する。Demucs を使う詳細解析は
    別経路（``/api/decompose``）。

    生成したカルテと元音声は `.bunri` ファイルとして results/charts/ に保存し、
    以後は ``chart_id`` で参照する。v1 では `.bunri` を UI に露出しない。

    Args:
        file: 解析する音声ファイル（マルチパートアップロード）。
        bpm: BPM の上書き値。``0`` なら自動検出。
        downbeat_offset: 1拍目の位置（秒）の上書き値。負値なら自動推定。
        beats_per_bar: 1小節あたりの拍数。拍子は自動検出せずユーザー指定を信頼する。
        run_async: クエリ ``?async=1``。付けると、ジョブを始めてすぐ返す（``job_routes.dispatch``）。

    Returns:
        ``{"chart_id": str, "chart": dict, "peaks": dict, "glossary": dict}``
        形式の ``JSONResponse``。``?async=1`` のときは、ジョブの状態（HTTP 202）。

    Raises:
        HTTPException: 解析に失敗した場合（HTTP 500）。
    """
    filename = file.filename
    chart_id = Path(filename).stem or "chart"

    def task(job, src):
        import song_chart
        import bunri_file

        try:
            chart = song_chart.build_chart(
                str(src),
                filename=filename,
                bpm=bpm if bpm > 0 else None,
                downbeat_offset=downbeat_offset if downbeat_offset >= 0 else None,
                beats_per_bar=beats_per_bar,
                job=job,
            )
            job.enter_stage("save")
            path = _chart_path(chart_id)
            # 途中でやめたら、新しく作ったファイルは消す。前から在ったカルテを上書きした場合は消さない
            if not path.exists():
                job.remove_on_abort(path)
            bunri_file.create(path, chart, audio_path=src, embed_audio=True)
            return _chart_payload(chart, chart_id, src)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(500, f"カルテの生成に失敗しました: {e}")

    return await job_routes.dispatch(
        "chart", title="楽曲カルテの作成", filename=filename, stages=_chart_stages(),
        prepare=lambda: _save_upload(file), task=task, run_async=run_async,
    )


@app.post("/api/chart/regrid")
async def api_chart_regrid(
    chart_id: str = Form(...),
    bpm: float = Form(...),
    downbeat_offset: float = Form(...),
    beats_per_bar: int = Form(4),
    run_async: bool = Query(False, alias="async"),
):
    """グリッドを補正した値でカルテを再計算する。

    グリッド補正UIからの経路。BPM やダウンビートがずれているとコード・
    セクションが全てずれるため、ユーザーが直した値を前提に解析し直す。
    元音声は `.bunri` から取り出すので再アップロードは不要。

    Args:
        chart_id: 対象カルテのID（``/api/chart`` が返した値）。
        bpm: 補正後の BPM。
        downbeat_offset: 補正後の1拍目の位置（秒）。
        beats_per_bar: 1小節あたりの拍数。
        run_async: クエリ ``?async=1``。付けると、ジョブを始めてすぐ返す（``job_routes.dispatch``）。

    Returns:
        ``/api/chart`` と同じ形式の ``JSONResponse``。``?async=1`` のときは、ジョブの状態（HTTP 202）。

    Raises:
        HTTPException: カルテが見つからない場合（HTTP 404）。
        HTTPException: `.bunri` に元音声が保存されていない場合（HTTP 400）。
        HTTPException: 再計算に失敗した場合（HTTP 500）。
    """
    def prepare():
        path = _chart_path(chart_id)
        if not path.exists():
            raise HTTPException(404, "カルテが見つかりません")
        return path

    def task(job, path):
        import song_chart
        import bunri_file
        from audio_utils import results_dir

        try:
            audio = bunri_file.extract_audio(path, results_dir("charts", "audio"))
            if audio is None:
                raise HTTPException(400, "このカルテには元音声が保存されていないため再計算できません")

            previous = bunri_file.read_chart(path)
            chart = song_chart.build_chart(
                str(audio),
                filename=(previous.get("source") or {}).get("filename"),
                bpm=bpm if bpm > 0 else None,
                downbeat_offset=downbeat_offset if downbeat_offset >= 0 else None,
                beats_per_bar=beats_per_bar,
                job=job,
            )
            # 保存は 1 回の書き込み。ここより前でやめれば、元のカルテはそのまま残る
            job.enter_stage("save")
            bunri_file.update_chart(path, chart)
            return _chart_payload(chart, chart_id, audio)
        except HTTPException:
            raise
        except bunri_file.BunriFileError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(500, f"カルテの再計算に失敗しました: {e}")

    return await job_routes.dispatch(
        "chart_regrid", title="カルテの再計算", filename=chart_id, stages=_chart_stages(),
        prepare=prepare, task=task, run_async=run_async,
    )


@app.get("/api/settings/llm")
async def api_llm_settings():
    """LLM（Claude）の設定の状態を返す。API キーそのものは返さない。

    Returns:
        ``{"has_key": bool, "key_source": "settings" | "env" | "none", "model": str}``。
    """
    import llm_settings

    return llm_settings.status()


@app.post("/api/settings/anthropic-key")
async def api_set_anthropic_key(key: str = Form(...)):
    """設定画面から渡された Claude の API キーを、このプロセスのメモリに持つ。

    ファイルには書かない。デスクトップ版では、アプリが OS のキーチェーンに保存し、
    次回の起動時に環境変数で渡してくる。

    Args:
        key: API キー。

    Returns:
        更新後の設定の状態（``/api/settings/llm`` と同じ形）。

    Raises:
        HTTPException: キーが空、または不正な文字を含む場合（HTTP 400）。
    """
    import llm_settings

    try:
        llm_settings.set_api_key(key)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return llm_settings.status()


@app.delete("/api/settings/anthropic-key")
async def api_clear_anthropic_key():
    """設定画面から渡された API キーを忘れる。

    Returns:
        更新後の設定の状態（``/api/settings/llm`` と同じ形）。
    """
    import llm_settings

    llm_settings.clear_api_key()
    return llm_settings.status()


# 再現ガイドを作れなかったときの HTTP ステータス（GuideError.code → ステータス）。無いものは 502
_GUIDE_ERROR_STATUS = {
    "no_key": 401, "auth": 401, "rate_limit": 429, "daily_limit": 429,
    "invalid": 400, "too_long": 413, "no_material": 422,
}


def _guide_chart(chart_id: str, focus: str):
    """再現ガイドの対象になるカルテと、対象のセクション ID を読む（内部用）。

    Raises:
        HTTPException: カルテが見つからない（404）、形式が読めない（400）。
    """
    import bunri_file

    path = _chart_path(chart_id)
    if not path.exists():
        raise HTTPException(404, "カルテが見つかりません")
    try:
        chart = bunri_file.read_chart(path)
    except bunri_file.BunriFileError as e:
        raise HTTPException(400, str(e))
    return chart, focus.strip() or None


def _guide_http_error(e):
    """``GuideError`` を、理由と種類を持つ ``HTTPException`` にする（内部用）。"""
    return HTTPException(_GUIDE_ERROR_STATUS.get(e.code, 502), {"message": str(e), "code": e.code})


@app.get("/api/chart/{chart_id}/guide")
def api_chart_guide_saved(chart_id: str, focus: str = ""):
    """保存済みの再現ガイドを返す。Claude は呼ばない（費用はかからない）。

    画面は、カルテを開いたとき・対象を変えたときにこれを呼び、保存済みが在れば最初から表示する。

    Args:
        chart_id: カルテの ID。
        focus: 絞り込むセクションの ID。空なら曲全体。

    Returns:
        ``{"chart_id", "focus", "saved": bool, "today": 今日の使用量}``。``saved`` が True のときは、
        ``POST`` と同じ ``guide`` ``model`` ``usage`` ``cost_usd`` ``created_at`` ``cached`` も持つ。

    Raises:
        HTTPException: カルテが見つからない（404）、形式が読めない・``focus`` が不正（400）。
    """
    import guide_usage
    import reproduction_guide

    chart, focus_id = _guide_chart(chart_id, focus)
    try:
        saved = reproduction_guide.saved_guide(chart, focus=focus_id)
    except reproduction_guide.GuideError as e:
        raise _guide_http_error(e)
    return {"chart_id": chart_id, "focus": focus_id, "saved": saved is not None, **(saved or {}),
            "today": guide_usage.today()}


@app.post("/api/chart/{chart_id}/guide")
def api_chart_guide(chart_id: str, focus: str = Form(""), regenerate: bool = Form(False)):
    """保存済みのカルテから、再現ガイド（第2層）を作る。

    同じ条件のガイドが保存済みなら、Claude を呼ばずにそれを返す。無いとき（か、``regenerate`` が
    真のとき）だけ、カルテを Claude に渡して「こう作れば再現できる」という手順の説明を受け取る。
    Claude の応答を待つ間ほかのリクエストを止めないよう、同期関数にしてある
    （FastAPI がスレッドプールで実行する）。

    Args:
        chart_id: カルテの ID。
        focus: 絞り込むセクションの ID。空なら曲全体。
        regenerate: 真なら、保存済みが在っても作り直す（費用がかかる）。

    Returns:
        ``{"chart_id", "focus", "guide", "model", "usage", "cost_usd", "duration_sec",
        "created_at", "cached": bool, "today": 今日の使用量}``。``cost_usd`` は概算。

    Raises:
        HTTPException: カルテが見つからない（404）、形式が読めない・``focus`` が不正（400）、
            API キーが無い・正しくない（401）、利用制限・1 日の上限（429）、カルテが長すぎる（413）、
            材料が足りない（422）、Claude 側の失敗（502）。
            本文の ``detail`` は ``{"message": 利用者向けの文, "code": 種類}``。
    """
    import guide_usage
    import reproduction_guide

    chart, focus_id = _guide_chart(chart_id, focus)
    try:
        result = reproduction_guide.guide_for(chart, focus=focus_id, regenerate=regenerate)
    except reproduction_guide.GuideError as e:
        raise _guide_http_error(e)
    return {"chart_id": chart_id, "focus": focus_id, **result, "today": guide_usage.today()}


@app.get("/api/settings/guide")
def api_guide_settings():
    """再現ガイドの費用まわりの設定と、今日の使用量を返す。

    Returns:
        ``{"settings": {"daily_limit_calls", "daily_limit_usd", "max_input_tokens"},
        "today": {"date", "calls", "cost_usd", "limit_calls", "limit_usd", "blocked"}}``。
    """
    import guide_usage

    return {"settings": guide_usage.settings(), "today": guide_usage.today()}


@app.post("/api/settings/guide")
def api_update_guide_settings(payload: dict = Body(...)):
    """再現ガイドの費用まわりの設定（1 日の上限など）を書き換える。

    Args:
        payload: 変える項目だけを持つ JSON。上限なしは ``null``。

    Returns:
        ``GET /api/settings/guide`` と同じ形。

    Raises:
        HTTPException: 知らない項目、または値が不正な場合（HTTP 400）。
    """
    import guide_usage

    try:
        guide_usage.update_settings(payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"settings": guide_usage.settings(), "today": guide_usage.today()}


@app.get("/api/chart/{chart_id}")
async def api_chart_load(chart_id: str):
    """保存済みのカルテを読み出す。

    Args:
        chart_id: 読み出すカルテのID。

    Returns:
        ``{"chart_id": str, "chart": dict, "glossary": dict}`` 形式の
        ``JSONResponse``。波形ピークは含まない（必要なら再計算経路で取得する）。

    Raises:
        HTTPException: カルテが見つからない場合（HTTP 404）。
        HTTPException: ファイル形式が読み込めない場合（HTTP 400）。
    """
    import bunri_file
    from music_theory import GLOSSARY

    path = _chart_path(chart_id)
    if not path.exists():
        raise HTTPException(404, "カルテが見つかりません")

    try:
        return JSONResponse({
            "chart_id": chart_id,
            "chart": bunri_file.read_chart(path),
            "glossary": GLOSSARY,
        })
    except bunri_file.BunriFileError as e:
        raise HTTPException(400, str(e))


# ---- 差分コーチ（第3層の土台）API ----

@app.post("/api/coach/diff")
async def api_coach_diff(payload: dict = Body(...)):
    """お手本のノートと、利用者の打ち込みの差分を返す。

    LLM は使わない。どの小節のどの音が抜けているか・違っているかを、機械的に決まる形で返す。

    Args:
        payload: JSON の本文。``reference``（お手本のノート列）と ``attempt``（打ち込みの
            ノート列）は必須。``steps_per_bar`` ``steps_per_beat`` ``timing_tolerance`` は任意。

    Returns:
        ``coach_diff.diff_notes`` の結果（``summary`` ``bars`` ``worst_bars``）。

    Raises:
        HTTPException: 入力の形が正しくない、またはお手本が空の場合（HTTP 400）。
    """
    import coach_diff

    options = {key: payload[key] for key in ("steps_per_bar", "steps_per_beat", "timing_tolerance") if key in payload}
    try:
        return coach_diff.diff_notes(payload.get("reference"), payload.get("attempt"), **options)
    except coach_diff.DiffError as e:
        raise HTTPException(400, str(e))


# ---- 差分コーチの言語化（第3層）API ----

def _coach_facts(payload: dict):
    """リクエストの本文から、差分の事実を組み立てる（内部用）。

    差分は、利用者が送ってきた結果を信じず、ノートからサーバの側で計算し直す。

    Raises:
        HTTPException: 入力の形が正しくない・お手本が空（400）、``chart_id`` のカルテが見つからない（404）。
    """
    import coach_diff
    import coach_explain

    options = {key: payload[key] for key in ("steps_per_bar", "steps_per_beat", "timing_tolerance") if key in payload}
    chart = None
    if payload.get("chart_id"):
        chart, _ = _guide_chart(str(payload["chart_id"]), "")
    try:
        return coach_explain.build_facts(payload.get("reference"), payload.get("attempt"),
                                         chart=chart, bpm=payload.get("bpm"),
                                         grid_offset_sec=payload.get("grid_offset_sec"), **options)
    except coach_diff.DiffError as e:
        raise HTTPException(400, {"message": str(e), "code": "invalid"})


@app.post("/api/coach/explain/saved")
def api_coach_explain_saved(payload: dict = Body(...)):
    """Claude を呼ばずに返せる差分の説明を返す（費用はかからない）。

    画面は、お手本と比べた直後にこれを呼び、返せる説明が在れば最初から表示する。返せるのは、
    同じ事実で作った保存済みの説明か、LLM に頼むまでもないとき（違いが無い・少ない、など）の決まった文。

    Args:
        payload: ``POST /api/coach/explain`` と同じ本文（``regenerate`` は見ない）。

    Returns:
        ``{"saved": bool, "today": 今日の使用量}``。``saved`` が True のときは、
        ``POST /api/coach/explain`` と同じ項目も持つ。

    Raises:
        HTTPException: ``POST /api/coach/explain`` の、入力に関するものと同じ（400、404）。
    """
    import coach_explain
    import guide_usage

    saved = coach_explain.saved_explanation(_coach_facts(payload))
    return {"saved": saved is not None, **(saved or {}), "today": guide_usage.today()}


@app.post("/api/coach/explain")
def api_coach_explain(payload: dict = Body(...)):
    """お手本と打ち込みの差分を、言葉の説明にする（第3層）。

    差分の事実（``coach_diff``）を Claude に渡し、「どんな傾向の違いか、音楽的になぜそうなったと
    考えられるか、まず何を見直すか」を受け取る。Claude は言葉にするだけで、音符は出さない。
    出力は、事実と突き合わせてから返す。

    同じ事実の説明が保存済みなら、Claude を呼ばずにそれを返す。違いが無い・ごく少ない、打ち込みが無い、
    お手本が少ないときも、Claude を呼ばずに決まった文を返す（``source`` が ``"rule"``）。
    使用量の記録と 1 日の上限は、再現ガイドと共通。Claude の応答を待つ間ほかのリクエストを
    止めないよう、同期関数にしてある。

    Args:
        payload: JSON の本文。``reference``（お手本のノート列）と ``attempt``（打ち込みのノート列）は必須。
            ``steps_per_bar`` ``steps_per_beat`` ``timing_tolerance`` は任意（``/api/coach/diff`` と同じ）。
            ``chart_id``（お手本と同じ曲のカルテ）を付けると、キーを事実に足す。さらに ``bpm``
            （お手本を採譜したときのテンポ）も付けると、その場のコードとセクションも足す。
            ``grid_offset_sec``（ピアノロールのステップ 0 の位置。画面ではカルテの 1 拍目の位置）を
            付けると、ステップを秒に直すときに足す（無ければ 0）。
            ``regenerate`` が真なら、保存済みが在っても作り直す（費用がかかる）。

    Returns:
        ``{"explanation", "source", "reason", "model", "usage", "cost_usd", "duration_sec",
        "created_at", "cached": bool, "input", "today": 今日の使用量}``。``cost_usd`` は概算。

    Raises:
        HTTPException: 入力の形が正しくない・お手本が空・Claude の出力を事実と結び付けられなかった（400）、
            カルテが見つからない（404）、API キーが無い・正しくない（401）、利用制限・1 日の上限（429）、
            入力が長すぎる（413）、Claude 側の失敗（502）。
            本文の ``detail`` は ``{"message": 利用者向けの文, "code": 種類}``（再現ガイドと同じ）。
    """
    import coach_explain
    import guide_usage
    import reproduction_guide

    facts = _coach_facts(payload)
    try:
        result = coach_explain.explain_for(facts, regenerate=payload.get("regenerate") is True)
    except reproduction_guide.GuideError as e:
        raise _guide_http_error(e)
    return {**result, "today": guide_usage.today()}
