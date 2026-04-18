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
    """周波数をMIDIノート番号に変換する。

    A4=440Hz を基準とした12平均律で計算し、ピアノ鍵盤範囲（21〜108）外の
    値は None を返す。

    Args:
        freq (float): 変換する周波数（Hz）。0以下または NaN の場合は None を返す。

    Returns:
        int | None: MIDIノート番号（21〜108）。範囲外または無効な入力の場合は None。

    Note:
        内部で numpy をインポートする（遅延インポート）。
    """
    import numpy as np
    if freq <= 0 or np.isnan(freq):
        return None
    midi = 69 + 12 * np.log2(freq / 440.0)
    midi_round = int(round(midi))
    if midi_round < 21 or midi_round > 108:
        return None
    return midi_round


def _midi_to_note(midi):
    """MIDIノート番号を音名とオクターブのタプルに変換する。

    Args:
        midi (int): MIDIノート番号（0〜127）。

    Returns:
        tuple[str, int]: ``(音名, オクターブ)`` のタプル。
            音名は "C", "C#", … "B" のいずれか。
            オクターブは MIDI 規約に基づき中央 C（60）が C4 となるよう算出。

    Raises:
        IndexError: ``midi`` が 0〜127 の範囲外の場合。
    """
    note_name = NOTE_NAMES[midi % 12]
    octave = (midi // 12) - 1
    return note_name, octave


def transcribe_polyphonic(file_path, bpm=120, sensitivity=0.5, max_notes_per_frame=4, engine="basic_pitch"):
    """音声ファイルからポリフォニック（多声）ピッチを検出してノートリストを返す。

    デフォルトエンジンは Spotify Basic Pitch（``engine="basic_pitch"``）。
    Basic Pitch が利用できない環境では ``engine="stft"`` で旧STFT実装に
    フォールバックできる。

    Args:
        file_path (str): 解析する音声ファイルのパス（WAV推奨）。
        bpm (int, optional): テンポ（BPM）。ステップ長の計算に使用。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。大きいほど多くのノートを検出。
            デフォルト 0.5。
        max_notes_per_frame (int, optional): 1フレームあたりの最大同時発音数。
            ``engine="stft"`` の場合のみ有効。デフォルト 4。
        engine (str, optional): 使用するエンジン。``"basic_pitch"``（デフォルト）または
            ``"stft"``。

    Returns:
        list[dict]: ノートイベントのリスト。各要素は以下のキーを持つ辞書。

        .. code-block:: python

            {
                "note":     str,   # 音名 ("C", "C#", … "B")
                "octave":   int,   # オクターブ番号
                "step":     int,   # 16分音符単位の開始位置
                "length":   int,   # 16分音符単位の長さ（最小 1）
                "velocity": int,   # ベロシティ（1〜127）
            }

    Note:
        重いモジュール（``basic_pitch`` または ``librosa``）は関数内で遅延インポートする。
    """
    if engine == "stft":
        return _transcribe_stft(file_path, bpm, sensitivity, max_notes_per_frame)
    return _transcribe_basic_pitch(file_path, bpm, sensitivity)


def _transcribe_basic_pitch(file_path, bpm=120, sensitivity=0.5):
    """Spotify Basic Pitch を使ってポリフォニックピッチ検出を行う内部実装。

    Basic Pitch の ICASSP 2022 モデルを用いてオンセット閾値とフレーム閾値を
    ``sensitivity`` から算出し、ノートイベントをピアノロール形式のリストに変換する。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        bpm (int, optional): テンポ（BPM）。ステップ長計算に使用。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。

    Returns:
        list[dict]: ``transcribe_polyphonic`` と同じ形式のノートリスト。
            ステップ順にソート済み。

    Raises:
        ImportError: ``basic_pitch`` パッケージがインストールされていない場合。

    Note:
        ``TF_CPP_MIN_LOG_LEVEL`` 環境変数を "3" に設定して TensorFlow の
        ログ出力を抑制する（既に設定済みの場合は上書きしない）。
    """
    import os
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH

    onset_threshold = max(0.3, 1.0 - sensitivity * 0.7)
    note_threshold = max(0.2, 0.8 - sensitivity * 0.6)

    _, _, note_events = predict(
        file_path,
        model_or_model_path=ICASSP_2022_MODEL_PATH,
        onset_threshold=onset_threshold,
        frame_threshold=note_threshold,
        minimum_note_length=40,
        midi_tempo=bpm,
    )

    step_sec = 60.0 / bpm / 4

    notes = []
    for start_sec, end_sec, midi_note, amplitude, _ in note_events:
        midi_note = int(midi_note)
        if midi_note < 21 or midi_note > 108:
            continue
        note_name = NOTE_NAMES[midi_note % 12]
        octave = (midi_note // 12) - 1
        step = max(0, int(round(start_sec / step_sec)))
        length = max(1, int(round((end_sec - start_sec) / step_sec)))
        velocity = min(127, max(1, int(amplitude * 127)))
        notes.append({
            "note": note_name,
            "octave": octave,
            "step": step,
            "length": length,
            "velocity": velocity,
        })

    notes.sort(key=lambda n: (n["step"], n["octave"], n["note"]))
    return notes


def _transcribe_stft(file_path, bpm=120, sensitivity=0.5, max_notes_per_frame=4):
    """STFT スペクトル解析によるポリフォニックピッチ検出の旧実装。

    Basic Pitch が使えない環境向けのフォールバック。
    n_fft=4096 の高解像度 STFT を用いて各フレームで倍音ピークを検出し、
    連続するフレームをまとめてノートイベントに変換する。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        bpm (int, optional): テンポ（BPM）。ステップ長計算に使用。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。
        max_notes_per_frame (int, optional): 1フレームあたりの最大同時発音数。
            デフォルト 4。

    Returns:
        list[dict]: ``transcribe_polyphonic`` と同じ形式のノートリスト。

    Note:
        サンプルレートは 22050 Hz に固定。``numpy`` および ``librosa`` を
        関数内で遅延インポートする。
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
    """スペクトルから倍音構造を考慮してピーク（MIDIノート）を検出する。

    各MIDIノートについて基音（f0）と3次倍音（2f0, 3f0, 4f0）のエネルギーを
    重み付き合算し、閾値を超えかつ倍音が2本以上検出された場合に採用する。
    半音（1半音）以内の近接ノートは重複とみなして除去する。

    Args:
        spectrum (numpy.ndarray): 正規化済みSTFTマグニチュードスペクトル（1次元）。
        freqs (numpy.ndarray): 各ビンに対応する周波数配列（Hz）。
        midi_min (int): 検出するMIDIノート番号の下限（含む）。
        midi_max (int): 検出するMIDIノート番号の上限（含む）。
        threshold (float): 採用するエネルギー閾値（正規化値）。
        max_peaks (int): 返すピーク数の上限。

    Returns:
        list[tuple[int, float]]: ``(MIDIノート番号, エネルギー値)`` のリスト。
            エネルギー降順・近接除去済み。最大 ``max_peaks`` 件。

    Note:
        ``numpy`` を関数内で遅延インポートする。
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
    """フレーム単位のMIDIノート列をノートイベントリストに変換する。

    フレームを順に走査し、各MIDIノートのオン/オフ遷移を検出して開始・終了フレームを
    記録する。持続時間が ``step_sec`` の 0.5 倍未満のイベントはノイズとして除去する。

    Args:
        frame_notes (list[list[int]]): フレームごとのアクティブMIDIノート番号リスト。
        frame_velocities (list[list[int]]): ``frame_notes`` に対応するベロシティリスト。
        sr (int): サンプルレート（Hz）。
        hop_length (int): STFTのホップ長（サンプル数）。フレーム→秒変換に使用。
        step_sec (float): 1ステップの長さ（秒）。通常は16分音符の長さ。

    Returns:
        list[dict]: ``transcribe_polyphonic`` と同じ形式のノートリスト。
            ステップ順にソート済み。

    Note:
        ``numpy`` を関数内で遅延インポートする。
    """
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
    """ドラムステムからリズムパターンを検出してドラムイベントリストを返す。

    librosa のオンセット検出でアタックを特定し、各オンセット近傍の 30ms 窓の
    スペクトル重心からキック・スネア・ハイハットを分類する。

    Args:
        file_path (str): ドラムステムの音声ファイルパス（WAV推奨）。
        bpm (int, optional): テンポ（BPM）。ステップ位置の計算に使用。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。大きいほど弱いアタックも検出。
            デフォルト 0.5。

    Returns:
        list[dict]: ドラムイベントのリスト。各要素は以下のキーを持つ辞書。

        .. code-block:: python

            {
                "type":     str,  # "kick" | "snare" | "hihat"
                "step":     int,  # 16分音符単位の発音位置
                "velocity": int,  # ベロシティ（1〜127）
            }

    Note:
        サンプルレートは 22050 Hz に固定。``numpy`` および ``librosa`` を
        関数内で遅延インポートする。
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
    """短い音声ウィンドウのスペクトル重心からドラムの種類とベロシティを判定する。

    FFT のスペクトル重心を用いたヒューリスティック分類:

    - 重心 < 200 Hz  → キック
    - 200 Hz 以上 < 2000 Hz → スネア
    - 2000 Hz 以上  → ハイハット

    Args:
        window (numpy.ndarray): 解析する音声サンプル列（30ms 程度を想定）。
        sr (int): サンプルレート（Hz）。

    Returns:
        tuple[str, int]: ``(drum_type, velocity)`` のタプル。
            ``drum_type`` は ``"kick"``、``"snare"``、``"hihat"`` のいずれか。
            ``velocity`` は 1〜127。

    Note:
        ``numpy`` を関数内で遅延インポートする。
    """
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
    """ステムのスペクトル特徴から最適な GM 楽器番号を推定する。

    音声の最初の 10 秒を読み込んでスペクトル重心を計算し、``candidates`` に
    含まれる GM プログラム番号の経験的な重心値と最も近いものを返す。

    Args:
        file_path (str): 解析するステムファイルのパス。
        stem_name (str): ステム名（``"vocals"``, ``"drums"``, ``"bass"``,
            ``"guitar"``, ``"piano"``, ``"other"`` のいずれか）。
            ``candidates`` が None の場合、``STEM_GM_CANDIDATES`` から候補を取得。
        candidates (list[int] | None, optional): 候補の GM プログラム番号リスト。
            None の場合は ``STEM_GM_CANDIDATES[stem_name]`` を使用。デフォルト None。

    Returns:
        int | None: 推定された GM プログラム番号（0〜127）。
            候補リストが空の場合は None。

    Raises:
        Exception: ``librosa.load`` が失敗した場合は例外が伝播する。

    Note:
        ``numpy`` および ``librosa`` を関数内で遅延インポートする。
        ボーカルとドラム（``STEM_GM_CANDIDATES`` が空のステム）は None を返す。
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
    """ステム音声からミックスパラメータ（音量・パン・残響量）を推定する。

    - **volume_db**: 全体 RMS から dBFS を算出。
    - **pan**: L/R チャンネルの RMS 差分から -1（左）〜1（右）を算出。
    - **reverb_wet**: 末尾 10% のエネルギー比率から残響量を推定。

    Args:
        file_path (str): 解析するステムファイルのパス（WAV推奨）。
            モノラル・ステレオどちらも可。

    Returns:
        dict: 以下のキーを持つ辞書。値はすべて float で丸め済み。

        .. code-block:: python

            {
                "volume_db":  float,  # 平均音量（dBFS）
                "pan":        float,  # パン位置（-1.0〜1.0）
                "reverb_wet": float,  # 推定残響量（0.0〜1.0）
            }

    Note:
        モノラルファイルの場合、ステレオに複製してパンを 0.0 とする。
        ``numpy`` および ``librosa`` を関数内で遅延インポートする。
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
    """音源分解のメインパイプライン。WAV → 分離 → 解析 → トラックデータを返す。

    以下の3段階で処理する:

    1. ``deep_separate`` （``separate.py``）で htdemucs_6s による6ステム分離。
    2. 各ステムをポリフォニック書き起こし（ドラムはリズム解析）。
    3. 楽器番号推定とミックスパラメータ推定。

    Args:
        input_path (str): 入力 WAV ファイルのパス。
        bpm (int | None, optional): テンポ（BPM）。None の場合は librosa で自動検出し
            60〜200 の範囲にクランプする。デフォルト None。
        sensitivity (float, optional): ピッチ/リズム検出の感度（0〜1）。デフォルト 0.5。
        segment (int, optional): Demucs の処理セグメント長（秒）。小さいほどメモリ節約。
            デフォルト 7。
        jobs (int, optional): Demucs の並列ジョブ数。CPU 負荷を抑えるなら 1。
            デフォルト 1。

    Returns:
        dict: 以下の構造を持つ辞書。

        .. code-block:: python

            {
                "bpm": int,
                "stems": {
                    "<stem_name>": {
                        "audio_path": str,        # results/decompose/<stem>.wav
                        "notes": list[dict],      # ピアノロール用ノートデータ（ドラム以外）
                        "drum_events": list[dict],# リズムイベント（ドラムのみ）
                        "gm_program": int | None, # GM プログラム番号
                        "mix": {
                            "volume_db":  float,
                            "pan":        float,
                            "reverb_wet": float,
                        },
                    }
                }
            }

    Raises:
        FileNotFoundError: ``input_path`` が存在しない場合（``deep_separate`` が送出）。
        RuntimeError: Demucs の実行に失敗した場合。

    Note:
        分離済みステムは ``results/decompose/`` に WAV としてコピーされる。
        ``numpy`` および ``librosa`` を関数内で遅延インポートする。
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
