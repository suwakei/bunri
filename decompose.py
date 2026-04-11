"""
bunri DAW — 音源分解パイプライン
WAV → Demucs分離 → 各ステムをピッチ/リズム解析 → トラック+ピアノロール自動生成

CPU環境前提。重いモジュールは遅延インポート。
"""

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# ステムごとのGM楽器候補（スペクトル解析で絞り込む）
STEM_GM_CANDIDATES = {
    "vocals": [],  # ボーカルはGM音源での再現が難しいため空
    "drums": [],   # ドラムは別処理
    "bass": [32, 33, 34, 35, 36, 38],  # Acoustic/Electric/Slap Bass 等
    "guitar": [24, 25, 26, 27, 28, 29, 30],  # Acoustic/Electric Guitar 等
    "piano": [0, 1, 2, 4, 5, 6],  # Acoustic/Electric Piano 等
    "other": [48, 49, 50, 80, 81, 88, 89],  # Strings, Synth Lead/Pad 等
}


def _freq_to_midi(freq):
    """周波数からMIDIノート番号を返す"""
    import numpy as np
    if freq <= 0 or np.isnan(freq):
        return None
    midi = 69 + 12 * np.log2(freq / 440.0)
    midi_round = int(round(midi))
    if midi_round < 21 or midi_round > 108:
        return None
    return midi_round


def _midi_to_note(midi):
    """MIDIノート番号から(音名, オクターブ)を返す"""
    note_name = NOTE_NAMES[midi % 12]
    octave = (midi // 12) - 1
    return note_name, octave


def transcribe_polyphonic(file_path, bpm=120, sensitivity=0.5, max_notes_per_frame=4):
    """
    ポリフォニック（多声）ピッチ検出。
    STFTのスペクトルピークから複数の同時発音を検出する。

    Args:
        file_path: WAVファイルパス
        bpm: テンポ
        sensitivity: 検出感度（0〜1）
        max_notes_per_frame: 1フレームあたりの最大同時発音数

    Returns:
        list of {"note": str, "octave": int, "step": int, "length": int, "velocity": int}
    """
    import numpy as np
    import librosa

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    if len(y) == 0:
        return []

    # パラメータ
    hop_length = 512
    n_fft = 4096  # 高周波数解像度
    step_sec = 60.0 / bpm / 4  # 16分音符

    # STFT
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop_length))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)

    # ノート範囲（C2〜C7）をMIDI番号で
    midi_min, midi_max = 36, 96
    threshold = (1.0 - sensitivity) * 0.3 + 0.05  # 感度を閾値に変換

    # フレームごとにピークを検出
    frame_notes = []  # フレーム → [midi_numbers]
    frame_velocities = []  # フレーム → [velocities]

    # スペクトルの正規化
    S_max = np.max(S) if np.max(S) > 0 else 1.0

    for frame_idx in range(S.shape[1]):
        spectrum = S[:, frame_idx] / S_max
        peaks = _find_harmonic_peaks(spectrum, freqs, midi_min, midi_max,
                                      threshold, max_notes_per_frame)
        midis = []
        vels = []
        for midi, amp in peaks:
            midis.append(midi)
            vels.append(min(127, max(1, int(amp * 127))))
        frame_notes.append(midis)
        frame_velocities.append(vels)

    # フレーム → ノートイベントに変換
    notes = _frames_to_notes(frame_notes, frame_velocities, sr, hop_length, step_sec)
    return notes


def _find_harmonic_peaks(spectrum, freqs, midi_min, midi_max, threshold, max_peaks):
    """
    スペクトルから倍音構造を考慮してピークを検出。
    基音と倍音（2f, 3f, 4f）のエネルギーを合算して信頼度を上げる。
    """
    import numpy as np

    results = []  # (midi, amplitude)

    # 各MIDIノートについて基音+倍音のエネルギーを計算
    for midi in range(midi_min, midi_max + 1):
        f0 = 440.0 * (2.0 ** ((midi - 69) / 12.0))
        energy = 0.0
        harmonics_found = 0

        for h in range(1, 5):  # 基音 + 3倍音まで
            target_freq = f0 * h
            # 最も近い周波数ビンを見つける
            idx = np.argmin(np.abs(freqs - target_freq))
            if idx > 0 and idx < len(spectrum) - 1:
                # ピーク近傍3ビンの最大値
                local_max = np.max(spectrum[max(0, idx-1):idx+2])
                weight = 1.0 / h  # 高次倍音ほど重みを下げる
                energy += local_max * weight
                if local_max > threshold * 0.5:
                    harmonics_found += 1

        # 基音のエネルギーが閾値以上、かつ倍音が2つ以上あれば採用
        if energy > threshold and harmonics_found >= 2:
            results.append((midi, energy))

    # エネルギー順にソートして上位を返す
    results.sort(key=lambda x: x[1], reverse=True)

    # 近すぎるノート（半音以内）を除去
    filtered = []
    for midi, amp in results:
        if not any(abs(midi - m) <= 1 for m, _ in filtered):
            filtered.append((midi, amp))
        if len(filtered) >= max_peaks:
            break

    return filtered


def _frames_to_notes(frame_notes, frame_velocities, sr, hop_length, step_sec):
    """フレーム単位のMIDIノート列をノートイベント（開始・終了）に変換"""
    import numpy as np

    # アクティブノートの追跡
    active = {}  # midi → {"start_frame": int, "velocity": int}
    events = []  # 完成したノートイベント

    for frame_idx, (midis, vels) in enumerate(zip(frame_notes, frame_velocities)):
        midi_set = set(midis)

        # 終了したノート
        ended = [m for m in active if m not in midi_set]
        for m in ended:
            info = active.pop(m)
            events.append({
                "midi": m,
                "start_frame": info["start_frame"],
                "end_frame": frame_idx,
                "velocity": info["velocity"],
            })

        # 新しいノート
        for midi, vel in zip(midis, vels):
            if midi not in active:
                active[midi] = {"start_frame": frame_idx, "velocity": vel}

    # 残っているノートを閉じる
    total_frames = len(frame_notes)
    for m, info in active.items():
        events.append({
            "midi": m,
            "start_frame": info["start_frame"],
            "end_frame": total_frames,
            "velocity": info["velocity"],
        })

    # フレーム → 秒 → ステップに変換
    frame_to_sec = hop_length / sr
    notes = []
    for ev in events:
        start_sec = ev["start_frame"] * frame_to_sec
        end_sec = ev["end_frame"] * frame_to_sec
        duration = end_sec - start_sec
        if duration < step_sec * 0.5:  # 0.5ステップ未満は除去
            continue

        note_name, octave = _midi_to_note(ev["midi"])
        step = max(0, int(round(start_sec / step_sec)))
        length = max(1, int(round(duration / step_sec)))

        notes.append({
            "note": note_name,
            "octave": octave,
            "step": step,
            "length": length,
            "velocity": ev["velocity"],
        })

    # ステップ順にソート
    notes.sort(key=lambda n: (n["step"], n["octave"], n["note"]))
    return notes


def transcribe_drums(file_path, bpm=120, sensitivity=0.5):
    """
    ドラムステムからリズムパターンを検出。
    オンセット検出 + スペクトル特徴でキック/スネア/ハイハットを分類。

    Returns:
        list of {"type": "kick"|"snare"|"hihat", "step": int, "velocity": int}
    """
    import numpy as np
    import librosa

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    if len(y) == 0:
        return []

    step_sec = 60.0 / bpm / 4
    hop_length = 512

    # オンセット検出
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=hop_length,
        delta=0.1 + (1 - sensitivity) * 0.3,
        wait=int(sr * 0.05 / hop_length),
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop_length)

    # 各オンセットのスペクトル特徴でドラム種類を分類
    events = []
    for onset_time in onset_times:
        onset_sample = int(onset_time * sr)
        # オンセット近傍の短い区間（30ms）を解析
        window = y[onset_sample:onset_sample + int(0.03 * sr)]
        if len(window) < 256:
            continue

        drum_type, velocity = _classify_drum_hit(window, sr)
        step = max(0, int(round(onset_time / step_sec)))
        events.append({
            "type": drum_type,
            "step": step,
            "velocity": velocity,
        })

    return events


def _classify_drum_hit(window, sr):
    """短い音声区間からドラムの種類と強さを判定"""
    import numpy as np

    # RMSからvelocity推定
    rms = np.sqrt(np.mean(window ** 2))
    velocity = min(127, max(1, int(rms * 500)))

    # スペクトル重心で分類
    fft = np.abs(np.fft.rfft(window))
    freqs = np.fft.rfftfreq(len(window), 1 / sr)

    if np.sum(fft) == 0:
        return "hihat", velocity

    centroid = np.sum(freqs * fft) / np.sum(fft)

    # 重心が低い → キック、中 → スネア、高 → ハイハット
    if centroid < 200:
        return "kick", velocity
    elif centroid < 2000:
        return "snare", velocity
    else:
        return "hihat", velocity


def estimate_instrument(file_path, stem_name, candidates=None):
    """
    ステムのスペクトル特徴から最適なGM楽器番号を推定。

    Returns:
        int: GM program number (0-127), or None
    """
    import numpy as np
    import librosa

    if not candidates:
        candidates = STEM_GM_CANDIDATES.get(stem_name, [])
    if not candidates:
        return None

    y, sr = librosa.load(file_path, sr=22050, mono=True, duration=10)
    if len(y) == 0:
        return candidates[0] if candidates else None

    # スペクトル特徴量
    centroid = np.mean(librosa.feature.spectral_centroid(y=y, sr=sr))
    rolloff = np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr))
    bandwidth = np.mean(librosa.feature.spectral_bandwidth(y=y, sr=sr))

    # 特徴量に基づく簡易マッチング
    # GM楽器の大まかなスペクトル特徴（経験的な値）
    GM_FEATURES = {
        # ベース系（低い重心）
        32: 200, 33: 250, 34: 220, 35: 180, 36: 280, 38: 300,
        # ギター系（中程度の重心）
        24: 1200, 25: 1000, 26: 1500, 27: 1800, 28: 1100, 29: 2000, 30: 2500,
        # ピアノ系（広い帯域）
        0: 1500, 1: 1600, 2: 1700, 4: 1400, 5: 1300, 6: 1200,
        # ストリングス/シンセ
        48: 800, 49: 900, 50: 700, 80: 2000, 81: 2200, 88: 600, 89: 500,
    }

    best_prog = candidates[0]
    best_dist = float('inf')

    for prog in candidates:
        if prog in GM_FEATURES:
            dist = abs(centroid - GM_FEATURES[prog])
            if dist < best_dist:
                best_dist = dist
                best_prog = prog

    return best_prog


def estimate_mix_params(file_path):
    """
    ステムのミックスパラメータ（音量、パン、残響量）を推定。

    Returns:
        {"volume_db": float, "pan": float, "reverb_wet": float}
    """
    import numpy as np
    import librosa

    y, sr = librosa.load(file_path, sr=22050, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])

    # RMSから音量推定
    rms = np.sqrt(np.mean(y ** 2))
    volume_db = 20 * np.log10(max(rms, 1e-10))

    # ステレオ差分からパン推定
    if y.shape[0] >= 2:
        left_rms = np.sqrt(np.mean(y[0] ** 2))
        right_rms = np.sqrt(np.mean(y[1] ** 2))
        total = left_rms + right_rms
        if total > 0:
            pan = (right_rms - left_rms) / total  # -1〜1
        else:
            pan = 0.0
    else:
        pan = 0.0

    # 残響量の簡易推定（減衰の遅さから）
    mono = np.mean(y, axis=0) if y.ndim > 1 else y
    env = np.abs(mono)
    # 最後の10%の平均エネルギー vs 全体平均
    tail_len = max(1, len(env) // 10)
    tail_energy = np.mean(env[-tail_len:])
    total_energy = np.mean(env)
    reverb_wet = min(1.0, tail_energy / (total_energy + 1e-10) * 2)

    return {
        "volume_db": round(float(volume_db), 1),
        "pan": round(float(pan), 2),
        "reverb_wet": round(float(reverb_wet), 2),
    }


def decompose(input_path, bpm=None, sensitivity=0.5, segment=7, jobs=1):
    """
    音源分解のメインパイプライン。

    1. Demucs で6ステム分離
    2. 各ステムをポリフォニック書き起こし（ドラムはリズム解析）
    3. 楽器推定 + ミックスパラメータ推定

    Args:
        input_path: WAVファイルパス
        bpm: テンポ（Noneの場合は自動検出）
        sensitivity: 検出感度 (0〜1)
        segment: Demucs の処理セグメント長
        jobs: 並列ジョブ数

    Returns:
        {
            "bpm": int,
            "stems": {
                "stem_name": {
                    "audio_path": str,
                    "notes": [...],           # ピアノロール用ノートデータ
                    "drum_events": [...],      # ドラムのみ
                    "gm_program": int | None,
                    "mix": {"volume_db", "pan", "reverb_wet"},
                }
            }
        }
    """
    import numpy as np
    import librosa

    # BPM自動検出
    if bpm is None:
        y_full, sr_full = librosa.load(input_path, sr=22050, mono=True, duration=30)
        tempo, _ = librosa.beat.beat_track(y=y_full, sr=sr_full)
        bpm = int(round(float(np.atleast_1d(tempo)[0])))
        bpm = max(60, min(200, bpm))

    # 1. Demucs 分離
    from separate import deep_separate
    import shutil
    from pathlib import Path

    results_dir = Path("results") / "decompose"
    results_dir.mkdir(parents=True, exist_ok=True)

    stem_paths = deep_separate(
        input_path,
        output_dir=str(results_dir / "separated"),
        segment=segment,
        jobs=jobs,
        recursive_depth=1,
    )

    # 2. 各ステムを解析
    stems = {}
    for stem_name, stem_path in stem_paths.items():
        stem_path = str(stem_path)
        # 保存用にコピー
        dst = results_dir / f"{stem_name}.wav"
        shutil.copy2(stem_path, str(dst))

        stem_data = {
            "audio_path": str(dst),
            "notes": [],
            "drum_events": [],
            "gm_program": None,
            "mix": estimate_mix_params(stem_path),
        }

        if "drum" in stem_name:
            # ドラム → リズム解析
            stem_data["drum_events"] = transcribe_drums(stem_path, bpm, sensitivity)
        else:
            # メロディ/和音 → ポリフォニック書き起こし
            max_polyphony = 1 if "bass" in stem_name or "vocal" in stem_name else 4
            stem_data["notes"] = transcribe_polyphonic(
                stem_path, bpm, sensitivity, max_notes_per_frame=max_polyphony
            )
            # 楽器推定
            stem_data["gm_program"] = estimate_instrument(stem_path, stem_name)

        stems[stem_name] = stem_data

    return {
        "bpm": bpm,
        "stems": stems,
    }
