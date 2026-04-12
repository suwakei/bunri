"""bunri DAW — FastAPI バックエンド"""
import sys
from pathlib import Path

# プロジェクトルートをパスに追加（既存モジュール参照用）
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
import shutil
import tempfile
import json

app = FastAPI(title="bunri DAW API")

# 静的ファイル配信（React ビルド出力 → web/static/dist/）
STATIC_DIR = Path(__file__).parent / "static"
DIST_DIR = STATIC_DIR / "dist"

# React ビルド出力の assets を配信
if DIST_DIR.exists() and (DIST_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(DIST_DIR / "assets")), name="assets")

# アップロード一時ディレクトリ
UPLOAD_DIR = ROOT / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
RESULTS_DIR = ROOT / "results"
RESULTS_DIR.mkdir(exist_ok=True)


def _save_upload(upload: UploadFile) -> Path:
    """アップロードファイルを保存してパスを返す"""
    dst = UPLOAD_DIR / upload.filename
    with open(dst, "wb") as f:
        shutil.copyfileobj(upload.file, f)
    return dst


# ---- ルート ----

@app.get("/")
async def index():
    """React SPA のエントリーポイントを返す"""
    react_index = DIST_DIR / "index.html"
    if not react_index.exists():
        raise HTTPException(500, "React build が見つかりません。`cd web-ui && npm run build` を実行してください")
    return FileResponse(str(react_index))


@app.get("/help")
async def help_page():
    return await index()


@app.get("/tools")
async def tools_page():
    return await index()


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
    """利用可能なGM楽器リストを返す"""
    from synth import GM_INSTRUMENTS
    return [{"program": k, "name": v} for k, v in GM_INSTRUMENTS.items()]


@app.post("/api/synth/drum")
async def api_drum(
    pattern: str = Form("8ビート"),
    bpm: float = Form(120),
    bars: int = Form(4),
    volume: float = Form(0.7),
):
    from synth import drum_machine
    try:
        path = drum_machine(pattern, bpm, bars, volume)
        return FileResponse(path, media_type="audio/wav")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/metronome")
async def api_metronome(
    bpm: float = Form(120),
    beats_per_bar: int = Form(4),
    bars: int = Form(8),
    volume: float = Form(0.7),
):
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
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))


# ---- バッチ編集 API ----

@app.post("/api/batch/edit")
async def api_batch_edit(
    files: list[UploadFile] = File(...),
    action: str = Form("trim"),
    params: str = Form("{}"),
):
    """複数ファイルに同じ編集操作を一括適用"""
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
            dst = RESULTS_DIR / dst_name
            shutil.copy2(out, str(dst))
            results.append({
                "filename": upload.filename,
                "url": f"/api/download/{dst_name}",
                "status": "ok",
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
    """複数ファイルに同じエフェクトを一括適用"""
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
            dst = RESULTS_DIR / dst_name
            shutil.copy2(out, str(dst))
            results.append({
                "filename": upload.filename,
                "url": f"/api/download/{dst_name}",
                "status": "ok",
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
    """
    config JSON: {
        "tracks": [{"vol": 0, "pan": 0, "mute": false}, ...],
        "master_vol": 0
    }
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
):
    """WAVファイルを解析してピアノロール用ノートデータを返す"""
    from analyze import analyze_wav
    src = _save_upload(file)
    try:
        notes = analyze_wav(str(src), bpm=bpm, sensitivity=sensitivity)
        return JSONResponse(notes)
    except Exception as e:
        raise HTTPException(500, str(e))


# ---- 音源分離 API ----

@app.post("/api/separate")
async def api_separate(
    file: UploadFile = File(...),
    model: str = Form("htdemucs"),
    two_stems: str = Form("true"),
):
    from separate import separate_audio, STEM_LABELS
    src = _save_upload(file)
    out_dir = str(RESULTS_DIR / "separated")
    is_two_stems = two_stems.lower() in ("true", "1", "yes")
    try:
        paths = separate_audio(
            str(src), output_dir=out_dir, model=model,
            two_stems=is_two_stems, segment=7, jobs=1,
        )
        # 結果ファイルをJSON + ダウンロードリンクで返す（可変数ステム）
        result = {}
        for key, p in paths.items():
            p = Path(p)
            if p.exists():
                dst = RESULTS_DIR / f"sep_{key}_{file.filename}"
                shutil.copy2(str(p), str(dst))
                result[key] = {
                    "url": f"/api/download/{dst.name}",
                    "label": STEM_LABELS.get(key, key),
                }
        return JSONResponse(result)
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/deep-separate")
async def api_deep_separate(
    file: UploadFile = File(...),
    depth: int = Form(1),
):
    """深層分離: htdemucs_6s + otherの再分離で最大限レイヤー分割"""
    from separate import deep_separate, STEM_LABELS
    src = _save_upload(file)
    out_dir = str(RESULTS_DIR / "separated")
    try:
        paths = deep_separate(
            str(src), output_dir=out_dir,
            segment=7, jobs=1, recursive_depth=int(depth),
        )
        result = {}
        for key, p in paths.items():
            p = Path(p)
            if p.exists():
                dst = RESULTS_DIR / f"deep_{key}_{file.filename}"
                shutil.copy2(str(p), str(dst))
                result[key] = {
                    "url": f"/api/download/{dst.name}",
                    "label": STEM_LABELS.get(key, key),
                }
        return JSONResponse(result)
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/deep-analyze")
async def api_deep_analyze(
    file: UploadFile = File(...),
):
    """音声ファイルの詳細解析（周波数帯域・楽器構成・テンポ等）"""
    from deep_separate import analyze_audio
    src = _save_upload(file)
    try:
        report = analyze_audio(str(src))
        return JSONResponse({"report": report})
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/download/{filename}")
async def api_download(filename: str):
    path = RESULTS_DIR / filename
    if not path.exists():
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


# ---- プロジェクト保存/読込 ----

@app.post("/api/project/save")
async def save_project(data: str = Form(...)):
    """タイムラインのクリップ配置やオートメーションデータを保存"""
    project_dir = ROOT / "projects"
    project_dir.mkdir(exist_ok=True)
    import time
    name = f"project_{int(time.time())}.json"
    (project_dir / name).write_text(data, encoding="utf-8")
    return {"filename": name}


@app.get("/api/project/list")
async def list_projects():
    project_dir = ROOT / "projects"
    project_dir.mkdir(exist_ok=True)
    files = sorted(project_dir.glob("*.json"), reverse=True)
    return [f.name for f in files]


@app.get("/api/project/load/{name}")
async def load_project(name: str):
    project_dir = ROOT / "projects"
    path = project_dir / name
    if not path.exists():
        raise HTTPException(404, "プロジェクトが見つかりません")
    return JSONResponse(json.loads(path.read_text(encoding="utf-8")))


# ---- 音源分解（Decompose）API ----

@app.post("/api/decompose")
async def api_decompose(
    file: UploadFile = File(...),
    bpm: int = Form(0),
    sensitivity: float = Form(0.5),
):
    """
    WAVファイルを分離→ピッチ解析→楽器推定まで一括処理。
    bpm=0 の場合は自動検出。
    """
    from decompose import decompose

    src = _save_upload(file)
    detected_bpm = bpm if bpm > 0 else None

    try:
        result = decompose(
            str(src), bpm=detected_bpm, sensitivity=sensitivity,
            segment=7, jobs=1,
        )

        # 音声ファイルのパスをダウンロードURLに変換
        for stem_name, stem_data in result["stems"].items():
            audio_path = Path(stem_data["audio_path"])
            if audio_path.exists():
                dst_name = f"decompose_{stem_name}_{file.filename}"
                dst = RESULTS_DIR / dst_name
                import shutil
                shutil.copy2(str(audio_path), str(dst))
                stem_data["audio_url"] = f"/api/download/{dst_name}"
            del stem_data["audio_path"]

        return JSONResponse(result)
    except Exception as e:
        raise HTTPException(500, str(e))


# ---- WAV最適化 API ----

@app.post("/api/wav/info")
async def api_wav_info(file: UploadFile = File(...)):
    """WAVファイルの詳細情報を返す"""
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
    """WAVファイルを最適化して容量を削減"""
    from wav_optimize import optimize_wav
    src = _save_upload(file)
    try:
        result = optimize_wav(str(src), target_sr, target_bit_depth)
        opt_path = Path(result["path"])
        dst_name = f"optimized_{file.filename}"
        dst = RESULTS_DIR / dst_name
        import shutil
        shutil.copy2(str(opt_path), str(dst))
        result["download_url"] = f"/api/download/{dst_name}"
        del result["path"]
        return JSONResponse(result)
    except Exception as e:
        raise HTTPException(500, str(e))
