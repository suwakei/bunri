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


# ---- 丸める先のグリッド（16 分か、三連か） ----
#
# 採譜した音の位置と長さは、グリッドに丸める。ふつうは 16 分音符（1 ステップ）。シャッフルや三連の曲では、
# 16 分に丸めるとお手本そのものがずれる（三連の裏 8/3 が 3 になる）ので、はっきり三連のときだけ、
# 三連のグリッド（1 拍を 3 つに割る = 8 分の三連。4/3 ステップおき）に丸める。
# 見分け方・値・根拠・限界は docs/coach-diff-design.md の「採譜のグリッド（16 分か、三連か）」。

GRID_STRAIGHT = "straight"
GRID_TRIPLET = "triplet"
# 三連のグリッドの間隔（刻みの数。1 刻み = 1/60 ステップ。80 = 4/3 ステップ = 1 拍の 3 分の 1）
TRIPLET_TICKS = 80
# グリッドの間隔（ステップ）
GRID_PERIOD_STEPS = {GRID_STRAIGHT: 1.0, GRID_TRIPLET: TRIPLET_TICKS / 60}

# 見分けるときの窓の長さ（ステップ。16 = 4 拍）。窓ごと・パートごとに、グリッド全体のずれを 1 つ許して当てはめる。
# テンポの推定の小さな誤差（曲の後ろほどグリッドからずれる）、1 拍目の位置の誤差、オンセット検出の遅れは、
# どれも窓の中ではほぼ一定のずれなので、これで打ち消せる
GRID_FEEL_WINDOW_STEPS = 16
# 当てはめるずれの候補の数（グリッドの間隔を、この数に割る）
GRID_FEEL_SHIFTS = 60
# 判定に要る音の始まりの数（曲全体。これより少なければ 16 分のまま）。三連で 1 小節を埋めると 12 個なので、3 小節ぶん弱
GRID_FEEL_MIN_ONSETS = 32
# 三連とみなす条件 1: 三連のグリッドからのずれ（平均。ステップ）が、16 分のグリッドからのずれの、この割合以下。
# でたらめな位置の音は、16 分のほうによく合う（間隔が狭いので。窓ごとに当てはめたあとの平均のずれは、
# 16 分 0.20・三連 0.26 ほど）。0.5 以下になるのは、音の 4 分の 3 ほど以上が三連の位置に在るときだけ
GRID_FEEL_RATIO = 0.5
# 三連とみなす条件 2: 16 分のグリッドからのずれ（平均。ステップ）が、これ以上。拍の頭だけで鳴る曲は、
# どちらのグリッドにも合う（ずれがどちらも小さい）ので、比だけで決めると、揺らぎの偶然で三連になる。
# 三連だけの曲の 16 分からのずれは 0.17〜0.22、シャッフルで拍の頭が多いと 0.1 前後
GRID_FEEL_MIN_STRAIGHT_ERROR = 0.08
# 同じパートの中で、同時に鳴った音（和音、キックとハイハット）を 1 つに数える幅（秒）
GRID_FEEL_SAME_ONSET_SEC = 0.03


def seconds_to_step(sec, step_sec, offset_sec=0.0, grid_feel=GRID_STRAIGHT):
    """秒の位置を、ピアノロールのステップ（16 分音符単位）に丸める。

    ステップ 0 は ``offset_sec``（1 小節目の 1 拍目）。楽曲カルテが在るときは、カルテの
    1 拍目の位置とテンポを渡す。こうすると、カルテの小節番号とピアノロールの小節番号が
    同じ時刻を指す（docs/coach-diff-design.md の「カルテとピアノロールの小節番号」）。

    Args:
        sec (float): 位置（秒）。
        step_sec (float): 1 ステップの長さ（秒）。
        offset_sec (float, optional): ステップ 0 の位置（秒）。デフォルト 0。
        grid_feel (str, optional): 丸める先のグリッド。``"straight"``（16 分音符。デフォルト）か
            ``"triplet"``（8 分の三連。4/3 ステップおき）。

    Returns:
        int | float | None: ステップ。16 分のグリッドでは整数。三連のグリッドでは 4/3 の倍数で、
            整数になる位置（拍の頭）は整数、そうでなければ小数（1/60 ステップの倍数。``note_steps``）。
            1 小節目より前（丸めて負になる位置。弱起）なら None。
            ピアノロールは 1 小節目より前を持てないので、その音は置かない。
    """
    position = (float(sec) - float(offset_sec)) / step_sec
    if grid_feel == GRID_TRIPLET:
        import note_steps

        index = int(round(position * note_steps.STEP_DIVISIONS / TRIPLET_TICKS))
        return note_steps.from_ticks(index * TRIPLET_TICKS) if index >= 0 else None
    step = int(round(position))
    return step if step >= 0 else None


def seconds_to_length(duration_sec, step_sec, grid_feel=GRID_STRAIGHT):
    """秒の長さを、ピアノロールの長さ（16 分音符単位）に丸める。位置と同じグリッドに丸める。

    Args:
        duration_sec (float): 長さ（秒）。
        step_sec (float): 1 ステップの長さ（秒）。
        grid_feel (str, optional): 丸める先のグリッド（``seconds_to_step`` と同じ）。

    Returns:
        int | float: 長さ。16 分のグリッドでは 1 以上の整数。三連のグリッドでは 4/3 の倍数（4/3 以上）。
    """
    length = float(duration_sec) / step_sec
    if grid_feel == GRID_TRIPLET:
        import note_steps

        count = max(1, int(round(length * note_steps.STEP_DIVISIONS / TRIPLET_TICKS)))
        return note_steps.from_ticks(count * TRIPLET_TICKS)
    return max(1, int(round(length)))


def _grid_error(positions, period):
    """音の位置の集まりを、間隔 ``period`` のグリッドに当てはめたときの、ずれの合計を返す。

    グリッド全体を前後にずらしてよい（ずらし方は 1 つ。``GRID_FEEL_SHIFTS`` 通りを試して、いちばん合うもの）。

    Args:
        positions (numpy.ndarray): 音の位置（ステップ。小数）。
        period (float): グリッドの間隔（ステップ）。

    Returns:
        float: いちばん合うずらし方での、各音からいちばん近いグリッドまでの距離の合計（ステップ）。
    """
    import numpy as np

    shifts = np.arange(GRID_FEEL_SHIFTS) * (period / GRID_FEEL_SHIFTS)
    phase = np.mod(positions[:, None] - shifts[None, :], period)
    return float(np.min(np.sum(np.minimum(phase, period - phase), axis=0)))


def _distinct_onsets(times, min_gap=GRID_FEEL_SAME_ONSET_SEC):
    """同時に鳴った音（``min_gap`` 秒より近いもの）を 1 つにまとめた、音の始まりの時刻を返す（時刻順）。"""
    distinct = []
    for time in sorted(float(t) for t in times):
        if not distinct or time - distinct[-1] >= min_gap:
            distinct.append(time)
    return distinct


def detect_grid_feel(onsets_by_part, step_sec, offset_sec=0.0):
    """採譜した音の始まりの時刻から、曲が 16 分のグリッドか、三連のグリッドかを見分ける。LLM は使わない。

    曲全体で 1 つに決める（パートごとには決めない。合わせて打ち込むときに、パートごとにグリッドが違うと混乱する）。
    ただし当てはめは、パートごと・窓（``GRID_FEEL_WINDOW_STEPS``）ごとに行い、そのずれを全部足す。パートごとに
    当てはめるのは、採譜の方法がパートで違い（ドラムはオンセット検出、ほかは basic-pitch）、遅れ方が違うため。

    1. パートごとに、同時に鳴った音を 1 つにまとめ、位置をステップ（小数）に直す
    2. 窓ごとに、16 分のグリッド（1 ステップおき）と三連のグリッド（4/3 ステップおき）のそれぞれへ、
       グリッド全体のずれを 1 つ許して当てはめ、いちばん近いグリッドまでの距離を足す（``_grid_error``）
    3. 全部のパート・窓の距離を足して、音の数で割る（グリッドごとの、平均のずれ）
    4. **はっきり三連のときだけ** 三連にする: 音の数が ``GRID_FEEL_MIN_ONSETS`` 以上で、16 分からのずれが
       ``GRID_FEEL_MIN_STRAIGHT_ERROR`` 以上で、三連からのずれが 16 分からのずれの ``GRID_FEEL_RATIO`` 以下

    どれかが足りなければ 16 分（これまでと同じ丸め方）。ふつうの曲を三連と取り違えるほうが害が大きいので、
    迷うときは 16 分に倒す。

    Args:
        onsets_by_part (dict[str, Iterable[float]]): パート → 音の始まりの時刻（秒）。
        step_sec (float): 1 ステップ（16 分音符）の長さ（秒）。
        offset_sec (float, optional): ステップ 0 の位置（秒）。それより前（弱起）の音は数えない。

    Returns:
        dict: ``{"grid_feel", "onsets", "straight_error", "triplet_error"}``。``grid_feel`` は ``"straight"`` か
        ``"triplet"``。``onsets`` は数えた音の数、``*_error`` はグリッドからの平均のずれ（ステップ。音が無ければ None）。

    Note:
        ``numpy`` を関数内で遅延インポートする。
    """
    import numpy as np

    totals = {GRID_STRAIGHT: 0.0, GRID_TRIPLET: 0.0}
    count = 0
    for times in onsets_by_part.values():
        positions = (np.asarray(_distinct_onsets(times), dtype=float) - float(offset_sec)) / step_sec
        # 1 小節目より前（弱起）は置かない音なので、数えない
        positions = positions[positions >= -0.5]
        if len(positions) == 0:
            continue
        windows = np.floor(np.maximum(positions, 0.0) / GRID_FEEL_WINDOW_STEPS).astype(int)
        for window in np.unique(windows):
            inside = positions[windows == window]
            for feel, period in GRID_PERIOD_STEPS.items():
                totals[feel] += _grid_error(inside, period)
        count += len(positions)

    if count == 0:
        return {"grid_feel": GRID_STRAIGHT, "onsets": 0, "straight_error": None, "triplet_error": None}
    straight, triplet = totals[GRID_STRAIGHT] / count, totals[GRID_TRIPLET] / count
    clearly_triplet = (count >= GRID_FEEL_MIN_ONSETS and straight >= GRID_FEEL_MIN_STRAIGHT_ERROR
                       and triplet <= GRID_FEEL_RATIO * straight)
    return {
        "grid_feel": GRID_TRIPLET if clearly_triplet else GRID_STRAIGHT,
        "onsets": count,
        "straight_error": round(straight, 4),
        "triplet_error": round(triplet, 4),
    }


def polyphonic_events(file_path, bpm=120, sensitivity=0.5, max_notes_per_frame=4, engine="basic_pitch"):
    """音声ファイルからポリフォニック（多声）ピッチを検出し、グリッドに丸める前の音の一覧を返す。

    ``transcribe_polyphonic`` の前半。``decompose`` は、全部のパートの音の始まりを見てからグリッド
    （16 分か三連か）を決めるので、丸める前の音を先に集める。

    Args:
        file_path (str): 解析する音声ファイルのパス（WAV推奨）。
        bpm (float, optional): テンポ（BPM）。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。
        max_notes_per_frame (int, optional): 1フレームあたりの最大同時発音数（``engine="stft"`` のときだけ）。
        engine (str, optional): ``"basic_pitch"``（デフォルト）または ``"stft"``。

    Returns:
        list[tuple[float, float, int, int]]: ``(始まり（秒）, 終わり（秒）, MIDI ノート番号, ベロシティ)`` のリスト。
    """
    if engine == "stft":
        return _stft_events(file_path, bpm, sensitivity, max_notes_per_frame)
    return _basic_pitch_events(file_path, bpm, sensitivity)


def events_to_notes(events, step_sec, offset_sec=0.0, grid_feel=GRID_STRAIGHT):
    """丸める前の音（``polyphonic_events`` の結果）を、グリッドに丸めてノートリストにする。

    Args:
        events (list[tuple[float, float, int, int]]): ``(始まり, 終わり, MIDI ノート番号, ベロシティ)`` のリスト。
        step_sec (float): 1 ステップの長さ（秒）。
        offset_sec (float, optional): ステップ 0 の位置（秒）。それより前に始まる音は置かない。
        grid_feel (str, optional): 丸める先のグリッド（``seconds_to_step`` と同じ）。位置も長さも、同じグリッドに丸める。

    Returns:
        list[dict]: ``transcribe_polyphonic`` と同じ形式のノートリスト。ステップ順にソート済み。
    """
    notes = []
    for start_sec, end_sec, midi_note, velocity in events:
        step = seconds_to_step(start_sec, step_sec, offset_sec, grid_feel)
        if step is None:
            continue
        note_name, octave = _midi_to_note(midi_note)
        notes.append({
            "note": note_name,
            "octave": octave,
            "step": step,
            "length": seconds_to_length(end_sec - start_sec, step_sec, grid_feel),
            "velocity": velocity,
        })
    notes.sort(key=lambda n: (n["step"], n["octave"], n["note"]))
    return notes


def transcribe_polyphonic(file_path, bpm=120, sensitivity=0.5, max_notes_per_frame=4, engine="basic_pitch",
                          offset_sec=0.0, grid_feel=GRID_STRAIGHT):
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
        offset_sec (float, optional): ステップ 0 の位置（秒。1 小節目の 1 拍目）。
            それより前に始まる音は置かない（``seconds_to_step``）。デフォルト 0。
        grid_feel (str, optional): 丸める先のグリッド。``"straight"``（16 分音符。デフォルト）か
            ``"triplet"``（8 分の三連）。ここでは見分けない（見分けるのは ``decompose``。``detect_grid_feel``）。

    Returns:
        list[dict]: ノートイベントのリスト。各要素は以下のキーを持つ辞書。

        .. code-block:: python

            {
                "note":     str,   # 音名 ("C", "C#", … "B")
                "octave":   int,   # オクターブ番号
                "step":     int | float,  # 16分音符単位の開始位置（16 分のグリッドでは整数。三連では 4/3 の倍数）
                "length":   int | float,  # 16分音符単位の長さ（16 分のグリッドでは 1 以上の整数。三連では 4/3 の倍数）
                "velocity": int,   # ベロシティ（1〜127）
            }

    Note:
        重いモジュール（``basic_pitch`` または ``librosa``）は関数内で遅延インポートする。
    """
    events = polyphonic_events(file_path, bpm, sensitivity, max_notes_per_frame, engine)
    return events_to_notes(events, 60.0 / bpm / 4, offset_sec, grid_feel)


def _transcribe_basic_pitch(file_path, bpm=120, sensitivity=0.5, offset_sec=0.0):
    """Spotify Basic Pitch を使ってポリフォニックピッチ検出を行う内部実装（16 分のグリッドに丸める）。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        bpm (int, optional): テンポ（BPM）。ステップ長計算に使用。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。
        offset_sec (float, optional): ステップ 0 の位置（秒）。デフォルト 0。

    Returns:
        list[dict]: ``transcribe_polyphonic`` と同じ形式のノートリスト。
            ステップ順にソート済み。
    """
    return events_to_notes(_basic_pitch_events(file_path, bpm, sensitivity), 60.0 / bpm / 4, offset_sec)


def _basic_pitch_events(file_path, bpm=120, sensitivity=0.5):
    """Spotify Basic Pitch でポリフォニックピッチ検出を行い、グリッドに丸める前の音を返す。

    Basic Pitch の ICASSP 2022 モデルを用いてオンセット閾値とフレーム閾値を
    ``sensitivity`` から算出する。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        bpm (float, optional): テンポ（BPM）。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。

    Returns:
        list[tuple[float, float, int, int]]: ``(始まり（秒）, 終わり（秒）, MIDI ノート番号, ベロシティ)`` のリスト。
            ピアノの鍵盤の範囲（21〜108）の外の音は入れない。

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

    events = []
    for start_sec, end_sec, midi_note, amplitude, _ in note_events:
        midi_note = int(midi_note)
        if midi_note < 21 or midi_note > 108:
            continue
        velocity = min(127, max(1, int(amplitude * 127)))
        events.append((float(start_sec), float(end_sec), midi_note, velocity))
    return events


def _transcribe_stft(file_path, bpm=120, sensitivity=0.5, max_notes_per_frame=4, offset_sec=0.0):
    """STFT スペクトル解析によるポリフォニックピッチ検出の旧実装（16 分のグリッドに丸める）。

    Basic Pitch が使えない環境向けのフォールバック。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        bpm (int, optional): テンポ（BPM）。ステップ長計算に使用。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。
        max_notes_per_frame (int, optional): 1フレームあたりの最大同時発音数。
            デフォルト 4。
        offset_sec (float, optional): ステップ 0 の位置（秒）。デフォルト 0。

    Returns:
        list[dict]: ``transcribe_polyphonic`` と同じ形式のノートリスト。
    """
    events = _stft_events(file_path, bpm, sensitivity, max_notes_per_frame)
    return events_to_notes(events, 60.0 / bpm / 4, offset_sec)


def _stft_events(file_path, bpm=120, sensitivity=0.5, max_notes_per_frame=4):
    """STFT スペクトル解析でポリフォニックピッチ検出を行い、グリッドに丸める前の音を返す。

    n_fft=4096 の高解像度 STFT を用いて各フレームで倍音ピークを検出し、
    連続するフレームをまとめて音にする。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        bpm (float, optional): テンポ（BPM）。短すぎる音を捨てる長さの基準に使う。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。
        max_notes_per_frame (int, optional): 1フレームあたりの最大同時発音数。デフォルト 4。

    Returns:
        list[tuple[float, float, int, int]]: ``(始まり（秒）, 終わり（秒）, MIDI ノート番号, ベロシティ)`` のリスト。

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

    # フレーム → 音（秒）に変換
    return _frames_to_events(frame_notes, frame_velocities, sr, hop_length, step_sec)


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


def _frames_to_notes(frame_notes, frame_velocities, sr, hop_length, step_sec, offset_sec=0.0):
    """フレーム単位のMIDIノート列をノートイベントリストに変換する（16 分のグリッドに丸める）。

    Args:
        frame_notes (list[list[int]]): フレームごとのアクティブMIDIノート番号リスト。
        frame_velocities (list[list[int]]): ``frame_notes`` に対応するベロシティリスト。
        sr (int): サンプルレート（Hz）。
        hop_length (int): STFTのホップ長（サンプル数）。フレーム→秒変換に使用。
        step_sec (float): 1ステップの長さ（秒）。通常は16分音符の長さ。
        offset_sec (float, optional): ステップ 0 の位置（秒）。デフォルト 0。

    Returns:
        list[dict]: ``transcribe_polyphonic`` と同じ形式のノートリスト。
            ステップ順にソート済み。
    """
    events = _frames_to_events(frame_notes, frame_velocities, sr, hop_length, step_sec)
    return events_to_notes(events, step_sec, offset_sec)


def _frames_to_events(frame_notes, frame_velocities, sr, hop_length, step_sec):
    """フレーム単位のMIDIノート列を、グリッドに丸める前の音の一覧に変換する。

    フレームを順に走査し、各MIDIノートのオン/オフ遷移を検出して開始・終了フレームを
    記録する。持続時間が ``step_sec`` の 0.5 倍未満のイベントはノイズとして除去する。

    Args:
        frame_notes (list[list[int]]): フレームごとのアクティブMIDIノート番号リスト。
        frame_velocities (list[list[int]]): ``frame_notes`` に対応するベロシティリスト。
        sr (int): サンプルレート（Hz）。
        hop_length (int): STFTのホップ長（サンプル数）。フレーム→秒変換に使用。
        step_sec (float): 1ステップの長さ（秒）。通常は16分音符の長さ。

    Returns:
        list[tuple[float, float, int, int]]: ``(始まり（秒）, 終わり（秒）, MIDI ノート番号, ベロシティ)`` のリスト。
    """
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

    # フレーム → 秒に変換（ステップに丸めるのは ``events_to_notes``）
    frame_to_sec = hop_length / sr
    result = []
    for ev in events:
        start_sec = ev["start_frame"] * frame_to_sec
        end_sec = ev["end_frame"] * frame_to_sec
        if end_sec - start_sec < step_sec * 0.5:  # 0.5ステップ未満は除去
            continue
        result.append((start_sec, end_sec, ev["midi"], ev["velocity"]))
    return result


def transcribe_drums(file_path, bpm=120, sensitivity=0.5, offset_sec=0.0):
    """ドラムステムからリズムパターンを検出してドラムイベントリストを返す。

    librosa のオンセット検出でアタックを特定し、各オンセット近傍の 30ms 窓の
    スペクトル重心からキック・スネア・ハイハットを分類する。

    Args:
        file_path (str): ドラムステムの音声ファイルパス（WAV推奨）。
        bpm (int, optional): テンポ（BPM）。ステップ位置の計算に使用。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。大きいほど弱いアタックも検出。
            デフォルト 0.5。
        offset_sec (float, optional): ステップ 0 の位置（秒）。デフォルト 0。

    Returns:
        list[dict]: ドラムイベントのリスト。各要素は以下のキーを持つ辞書。

        .. code-block:: python

            {
                "type":     str,  # "kick" | "snare" | "hihat"
                "step":     int,  # 16分音符単位の発音位置
                "velocity": int,  # ベロシティ（1〜127）
            }

    Note:
        16 分のグリッドに丸める。三連のグリッドに丸めるときは、``spectral_drum_hits`` と
        ``spectral_hits_to_events`` を使う（``decompose`` がそうしている）。
    """
    return spectral_hits_to_events(spectral_drum_hits(file_path, sensitivity), 60.0 / bpm / 4, offset_sec)


def spectral_hits_to_events(hits, step_sec, offset_sec=0.0, grid_feel=GRID_STRAIGHT):
    """``spectral_drum_hits`` の打音（秒）を、グリッドに丸めてドラムイベントにする。

    Args:
        hits (list[tuple[str, float, int]]): ``(種類, 時刻（秒）, ベロシティ)`` のリスト。
        step_sec (float): 1 ステップの長さ（秒）。
        offset_sec (float, optional): ステップ 0 の位置（秒）。それより前の打音は置かない。
        grid_feel (str, optional): 丸める先のグリッド（``seconds_to_step`` と同じ）。

    Returns:
        list[dict]: ``{"type", "step", "velocity"}`` のリスト（打音の順）。
    """
    events = []
    for drum_type, time, velocity in hits:
        step = seconds_to_step(time, step_sec, offset_sec, grid_feel)
        if step is None:
            continue
        events.append({"type": drum_type, "step": step, "velocity": velocity})
    return events


def spectral_drum_hits(file_path, sensitivity=0.5):
    """ドラムステムの打音を検出し、スペクトル重心で種類を振り分けて、グリッドに丸める前の打音を返す。

    librosa のオンセット検出でアタックを特定し、各オンセット近傍の 30ms 窓の
    スペクトル重心からキック・スネア・ハイハットを分類する（``transcribe_drums`` の前半）。

    Args:
        file_path (str): ドラムステムの音声ファイルパス（WAV推奨）。
        sensitivity (float, optional): 検出感度（0〜1）。大きいほど弱いアタックも検出。デフォルト 0.5。

    Returns:
        list[tuple[str, float, int]]: ``(種類, 時刻（秒）, ベロシティ)`` のリスト（時刻順）。
            種類は ``"kick"`` ``"snare"`` ``"hihat"``。

    Note:
        サンプルレートは 22050 Hz に固定。``librosa`` を関数内で遅延インポートする。
    """
    import librosa

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    if len(y) == 0:
        return []

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
    hits = []
    for onset_time in onset_times:
        onset_sample = int(onset_time * sr)
        # オンセット近傍の短い区間（30ms）を解析
        window = y[onset_sample:onset_sample + int(0.03 * sr)]
        if len(window) < 256:
            continue

        drum_type, velocity = _classify_drum_hit(window, sr)
        hits.append((drum_type, float(onset_time), velocity))

    return hits


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


# ---- ドラムの採譜（種類ごとに分けた音声から） ----
#
# ドラムを種類ごとに分けるモデル（``stem_models`` の drumsep）の出力から、種類ごとにオンセットを取る。
# 同時に鳴ったキックとシンバルが、両方ともイベントになる（``transcribe_drums`` は、同時に鳴った音を
# 1 つにしか数えられない）。値と根拠は docs/coach-diff-design.md の「ドラムの差分」。

# 分けたステムの名前（``separate.deep_separate`` のキー）→ ドラムの種類
DRUM_STEM_TYPES = {
    "drums_kick": "kick",
    "drums_snare": "snare",
    "drums_toms": "toms",
    "drums_cymbals": "cymbals",
}
# 同じ種類の打音どうしの、最小の間隔（秒）。これより近い 2 つは 1 つの打音として、強いほうを残す。
# 残響や、1 回の打音の中の 2 つ目の山（フラム、スネアの響き線）を、2 度打ちに数えないため。
# 150 BPM の 32 分音符（0.05 秒）までは、別の打音として残る
DRUM_MIN_INTERVAL_SEC = 0.05
# 打音の大きさを測る窓（秒。見つけたオンセットの前と後ろ）。オンセットの時刻はフレーム（約 23 ミリ秒）刻みで、
# 本当のアタックより前にも後ろにも 1〜2 フレームずれるので、どちらにずれてもアタックの山が入る幅にする
DRUM_LEVEL_WINDOW_SEC = (0.05, 0.05)
# その種類の「ふつうに叩いた大きさ」（打音の大きさの 90 パーセンタイル）に対する下限。
# これより小さい打音は、ほかの種類の漏れ込み（キックのステムに残ったスネア）として捨てる（約 −14 dB）。
# お手本に入らなくなるもの: ふつうの打音より 14 dB 以上弱いゴーストノート
DRUM_BLEED_RATIO = 0.2
# 打音の大きさの絶対の下限（振幅。約 −40 dBFS）。分離の残りかすだけのステムを拾わないため
DRUM_MIN_LEVEL = 0.01
# 「ほかの種類の影」の判定。その種類の打音の大半（``DRUM_SHADOW_SHARE``）が、ほかの 1 つの種類の打音と
# 同時（``DRUM_SHADOW_WINDOW_SEC`` 以内）に鳴っていて、大きさがその種類よりずっと小さい
# （``DRUM_SHADOW_RATIO``。約 −12 dB）なら、同時に鳴っている打音を漏れ込みとして捨てる。
# 曲にタムが無いのに、タムのステムにスネアが薄く残っている、のような場合のため。
# シンバル（ハイハット）は対象にしない: キックやスネアと同時に、ずっと小さく鳴るのがふつうなので
DRUM_SHADOW_WINDOW_SEC = 0.03
DRUM_SHADOW_SHARE = 0.8
DRUM_SHADOW_RATIO = 0.25
DRUM_SHADOW_TYPES = ("kick", "snare", "toms")
# 強さ（ベロシティ）の基準。その種類のふつうの打音が、この強さになる（画面の ``DEFAULT_VELOCITY`` と同じ）
DRUM_BASE_VELOCITY = 96


def _drum_onsets(y, sr, sensitivity):
    """ドラムの音声 1 本から、打音の時刻と大きさを取り出す。

    オンセット検出は ``transcribe_drums`` と同じ設定。近すぎる 2 つ（``DRUM_MIN_INTERVAL_SEC`` 未満）は
    1 つにまとめ、強いほうを残す。

    Args:
        y (numpy.ndarray): モノラルの音声。
        sr (int): サンプルレート（Hz）。
        sensitivity (float): 検出感度（0〜1）。

    Returns:
        list[tuple[float, float]]: ``(時刻（秒）, 大きさ（窓の中の振幅の山）)`` のリスト（時刻順）。

    Note:
        ``numpy`` と ``librosa`` を関数内で遅延インポートする。
    """
    import numpy as np
    import librosa

    if len(y) == 0:
        return []
    hop_length = 512
    # 頭に短い無音を足してから調べる。オンセット検出は「前より大きくなった所」を探すので、
    # 音声のいちばん頭で鳴った打音（曲が 1 拍目から始まるとき）は、そのままでは見つからない
    lead = int(0.1 * sr)
    padded = np.concatenate([np.zeros(lead, dtype=y.dtype), y])
    onset_env = librosa.onset.onset_strength(y=padded, sr=sr, hop_length=hop_length)
    frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=hop_length,
        delta=0.1 + (1 - sensitivity) * 0.3,
        wait=int(sr * DRUM_MIN_INTERVAL_SEC / hop_length),
    )
    before, after = DRUM_LEVEL_WINDOW_SEC
    hits = []
    for padded_time in librosa.frames_to_time(frames, sr=sr, hop_length=hop_length):
        time = max(0.0, float(padded_time) - lead / sr)
        window = y[max(0, int((time - before) * sr)):int((time + after) * sr)]
        if len(window) == 0:
            continue
        hits.append((float(time), float(np.max(np.abs(window)))))
    return _merge_close_hits(hits)


def _merge_close_hits(hits, min_interval=DRUM_MIN_INTERVAL_SEC):
    """近すぎる打音（同じ種類の中の 2 度打ちの誤検出）を 1 つにまとめる。

    Args:
        hits: ``(時刻, 大きさ)`` のリスト（時刻順）。
        min_interval: 別の打音とみなす、最小の間隔（秒）。

    Returns:
        list[tuple[float, float]]: まとめたあとのリスト。まとめた組は、強いほうの時刻と大きさを残す。
    """
    merged = []
    for time, level in hits:
        if merged and time - merged[-1][0] < min_interval:
            if level > merged[-1][1]:
                merged[-1] = (time, level)
            continue
        merged.append((time, level))
    return merged


def _typical_level(hits):
    """その種類の「ふつうに叩いた大きさ」（打音の大きさの 90 パーセンタイル）を返す。打音が無ければ 0。"""
    import numpy as np

    if not hits:
        return 0.0
    return float(np.percentile([level for _, level in hits], 90))


def _drop_drum_bleed(hits_by_type):
    """種類ごとの打音から、ほかの種類の漏れ込みと思われるものを捨てる。

    1. 大きさが絶対の下限（``DRUM_MIN_LEVEL``）より小さい打音と、その種類のふつうの大きさの
       ``DRUM_BLEED_RATIO`` より小さい打音を捨てる（本物の打音が在るステムに、薄く残った別の種類）
    2. その種類が、ほかの 1 つの種類の「影」（打音の大半が同時で、ずっと小さい）なら、同時の打音を捨てる
       （本物の打音が無いステムに残った別の種類。``DRUM_SHADOW_TYPES`` の種類だけ）

    Args:
        hits_by_type (dict[str, list[tuple[float, float]]]): 種類 → ``(時刻, 大きさ)`` のリスト（時刻順）。

    Returns:
        tuple[dict, dict]: ``(残した打音, 種類ごとのふつうの大きさ)``。どちらも種類がキー。
    """
    from bisect import bisect_left

    typical = {kind: _typical_level(hits) for kind, hits in hits_by_type.items()}
    kept = {
        kind: [(time, level) for time, level in hits
               if level >= DRUM_MIN_LEVEL and level >= DRUM_BLEED_RATIO * typical[kind]]
        for kind, hits in hits_by_type.items()
    }
    # 影の判定は、1. を済ませた打音どうしで行う（判定の途中で相手を書き換えない）
    times = {kind: [time for time, _ in hits] for kind, hits in kept.items()}

    def coincides(time, others):
        index = bisect_left(others, time)
        return any(0 <= i < len(others) and abs(others[i] - time) <= DRUM_SHADOW_WINDOW_SEC for i in (index - 1, index))

    result = dict(kept)
    for kind in DRUM_SHADOW_TYPES:
        hits = kept.get(kind) or []
        if not hits:
            continue
        for other, other_times in times.items():
            if other == kind or not other_times or typical[kind] >= DRUM_SHADOW_RATIO * typical[other]:
                continue
            alone = [(time, level) for time, level in hits if not coincides(time, other_times)]
            if len(hits) - len(alone) >= DRUM_SHADOW_SHARE * len(hits):
                result[kind] = alone
                break
    return result, typical


def drum_hits_to_events(hits_by_type, step_sec, offset_sec=0.0, typical=None, grid_feel=GRID_STRAIGHT):
    """種類ごとの打音（秒）を、ドラムイベント（ステップ）にする。

    秒からステップへの換算は、ここ 1 か所（``seconds_to_step``）。丸める先のグリッドは ``grid_feel`` で選ぶ。
    同じ種類で同じステップに丸まった打音は 1 つにし、強いほうを残す。

    Args:
        hits_by_type (dict[str, list[tuple[float, float]]]): 種類 → ``(時刻, 大きさ)`` のリスト。
        step_sec (float): 1 ステップの長さ（秒）。
        offset_sec (float, optional): ステップ 0 の位置（秒）。それより前の打音は置かない。
        typical (dict[str, float] | None, optional): 種類ごとのふつうの大きさ。強さは、これに対する比で決める
            （ふつうの打音が ``DRUM_BASE_VELOCITY``）。None なら、渡された打音から出す。
        grid_feel (str, optional): 丸める先のグリッド。``"straight"``（16 分音符。デフォルト）か
            ``"triplet"``（8 分の三連。ステップは 4/3 の倍数で、小数になりうる）。

    Returns:
        list[dict]: ``{"type", "step", "velocity"}`` のリスト（ステップ順。同じステップでは種類の名前順）。
    """
    strongest = {}
    for kind, hits in hits_by_type.items():
        base = (typical or {}).get(kind) or _typical_level(hits)
        for time, level in hits:
            step = seconds_to_step(time, step_sec, offset_sec, grid_feel)
            if step is None:
                continue
            velocity = min(127, max(1, int(round(DRUM_BASE_VELOCITY * level / base)))) if base > 0 else DRUM_BASE_VELOCITY
            key = (kind, step)
            if key not in strongest or velocity > strongest[key]:
                strongest[key] = velocity
    return [
        {"type": kind, "step": step, "velocity": velocity}
        for (kind, step), velocity in sorted(strongest.items(), key=lambda item: (item[0][1], item[0][0]))
    ]


def transcribe_drum_stems(stem_paths, bpm=120, sensitivity=0.5, offset_sec=0.0):
    """種類ごとに分けたドラムの音声から、ドラムイベントのリストを返す。

    ステムごとにオンセットを検出して、その種類のイベントにする。同時に鳴ったキックとシンバルは、
    両方ともイベントになる。同じ種類の中の 2 度打ちの誤検出と、ほかの種類の漏れ込みは捨てる
    （``_merge_close_hits`` ``_drop_drum_bleed``）。

    Args:
        stem_paths (dict[str, str]): 種類（``"kick"`` ``"snare"`` ``"toms"`` ``"cymbals"``）→ 音声ファイルのパス。
        bpm (float, optional): テンポ（BPM）。ステップの計算に使う。デフォルト 120。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。
        offset_sec (float, optional): ステップ 0 の位置（秒）。デフォルト 0。

    Returns:
        list[dict]: ``{"type", "step", "velocity"}`` のリスト（ステップ順）。``type`` は ``stem_paths`` のキー。
            強さは、その種類のふつうの打音を 96 とした相対の値（種類どうしの音量の比は入らない）。

    Note:
        16 分のグリッドに丸める。三連のグリッドに丸めるときは、``drum_stem_hits`` と ``drum_hits_to_events`` を
        使う（``decompose`` がそうしている）。
    """
    kept, typical = drum_stem_hits(stem_paths, sensitivity)
    return drum_hits_to_events(kept, 60.0 / bpm / 4, offset_sec, typical=typical)


def drum_stem_hits(stem_paths, sensitivity=0.5):
    """種類ごとに分けたドラムの音声から、グリッドに丸める前の打音を返す（``transcribe_drum_stems`` の前半）。

    Args:
        stem_paths (dict[str, str]): 種類 → 音声ファイルのパス。
        sensitivity (float, optional): 検出感度（0〜1）。デフォルト 0.5。

    Returns:
        tuple[dict, dict]: ``(残した打音, 種類ごとのふつうの大きさ)``（``_drop_drum_bleed`` の結果）。
        打音は、種類 → ``(時刻（秒）, 大きさ)`` のリスト。

    Note:
        サンプルレートは 22050 Hz に固定。``librosa`` を関数内で遅延インポートする。
    """
    import librosa

    hits_by_type = {}
    for kind, path in stem_paths.items():
        y, sr = librosa.load(str(path), sr=22050, mono=True)
        hits_by_type[kind] = _drum_onsets(y, sr, sensitivity)
    return _drop_drum_bleed(hits_by_type)


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


def decompose_stages(detect_bpm=True, split_drums=False, download_drum_model=False):
    """``decompose`` をジョブとして動かすときのステージの並びを返す。

    Args:
        detect_bpm (bool, optional): BPM を自動検出するか（``bpm=None`` で呼ぶか）。
            False なら、テンポを調べるステージを入れない。
        split_drums (bool, optional): ドラムを種類ごとに分けてから採譜するか。真なら、ドラムを分けるステージを入れる。
        download_drum_model (bool, optional): ドラムを分けるモデルのダウンロードが要るか
            （``split_drums`` が真で、モデルが手元に無いとき）。真なら、そのステージを入れる。

    Returns:
        list[tuple[str, str]]: ``(キー, 表示名)`` を進む順に並べたリスト。
    """
    from separate import deep_separate_stages

    stages = [("tempo", "テンポを調べています")] if detect_bpm else []
    separation = deep_separate_stages(recursive_depth=1, split_drums=split_drums, download_drum_model=download_drum_model)
    return stages + separation + [("transcribe", "パートごとにノートを採譜しています")]


# ドラムを種類ごとに分けるよう頼まれたが、スペクトル重心の振り分けに落としたときの理由（結果の ``drum_fallback``）
DRUM_FALLBACK_NO_HITS = "ドラムを種類ごとに分けた音から、打音を見つけられませんでした。"
DRUM_FALLBACK_SPLIT_FAILED = "ドラムを種類ごとに分けられませんでした。分ける処理が途中で失敗しました。メモリが足りないときなどに起きます。"


def _onset_times(entry):
    """``decompose`` が集めた、丸める前の音（パート 1 つぶん）から、音の始まりの時刻（秒）を取り出す。

    Args:
        entry (tuple): ``("notes", 音の一覧)``、``("stems", 種類ごとの打音, ふつうの大きさ)``、
            ``("spectral", 打音の一覧)`` のどれか。

    Returns:
        list[float]: 音の始まりの時刻。ドラムは、全部の種類を合わせる。
    """
    if entry[0] == "notes":
        return [start for start, _, _, _ in entry[1]]
    if entry[0] == "stems":
        return [time for hits in entry[1].values() for time, _ in hits]
    return [time for _, time, _ in entry[1]]


def decompose(input_path, bpm=None, sensitivity=0.5, segment=7, jobs=1, job=None, grid_offset_sec=0.0,
              split_drums=False):
    """音源分解のメインパイプライン。WAV → 分離 → 解析 → トラックデータを返す。

    以下の3段階で処理する:

    1. ``deep_separate`` （``separate.py``）で htdemucs_6s による6ステム分離。
    2. 各ステムをポリフォニック書き起こし（ドラムはリズム解析）。
    3. 楽器番号推定とミックスパラメータ推定。

    採譜した音は、全部のパートの音の始まりを見てから、グリッドに丸める。ふつうは 16 分音符。曲全体が
    はっきり三連（シャッフル・三連の刻み）のときだけ、全部のパートを三連のグリッド（1 拍を 3 つ）に丸める
    （``detect_grid_feel``。結果の ``grid_feel``）。

    Args:
        input_path (str): 入力 WAV ファイルのパス。
        bpm (float | None, optional): テンポ（BPM。小数も可）。None の場合は librosa で自動検出し
            60〜200 の範囲にクランプする（整数）。デフォルト None。楽曲カルテが在るときは、
            カルテのテンポを渡す。
        sensitivity (float, optional): ピッチ/リズム検出の感度（0〜1）。デフォルト 0.5。
        segment (int, optional): Demucs の処理セグメント長（秒）。小さいほどメモリ節約。
            デフォルト 7。
        jobs (int, optional): Demucs の並列ジョブ数。CPU 負荷を抑えるなら 1。
            デフォルト 1。
        job (background_jobs.Job | None, optional): この処理を動かしているジョブ。
            進み具合の報告とキャンセルに使う。ステージは ``decompose_stages`` のキーで進む。
            None なら報告しない。
        grid_offset_sec (float, optional): ノートのステップ 0 を置く位置（秒）。楽曲カルテの
            1 拍目の位置（``grid.downbeat_offset_sec``）を渡すと、カルテとピアノロールの
            小節番号がそろう。それより前（弱起）の音は置かない。デフォルト 0。
        split_drums (bool, optional): ドラムを種類ごと（キック / スネア / タム / シンバル）に分けてから
            採譜するか。真のとき、追加のモデル（``stem_models`` の drumsep。約 160 MB）が手元に無ければ
            ダウンロードする。用意できなければ（オフラインなど）、または細分化そのものが失敗したら
            （メモリ不足など）、失敗にせず、これまでのスペクトル重心の振り分け（``transcribe_drums``）に落とす
            （理由は結果の ``drum_fallback``）。偽なら、ダウンロードもドラムの分離もしない。デフォルト False。

    Returns:
        dict: 以下の構造を持つ辞書。

        .. code-block:: python

            {
                "bpm": float,
                "grid_offset_sec": float,   # ステップ 0 の位置（秒）
                "grid_feel": str,           # ノートとドラムのイベントを丸めたグリッド。"straight"（16 分音符）か
                                            # "triplet"（8 分の三連。step と length が 4/3 の倍数で、小数になりうる）。
                                            # 曲全体で 1 つ（全部のパートが同じ）
                "drum_source": str | None,  # "drums" のイベントの作り方（下の stems の drum_source と同じ）。
                                            # ドラムのパートが無ければ None
                "drum_fallback": str | None,# split_drums を頼まれたのに "spectral" に落としたときの理由（利用者に見せられる文）
                "stems": {
                    "<stem_name>": {
                        "audio_path": str,        # results/decompose/<stem>.wav
                        "notes": list[dict],      # ピアノロール用ノートデータ（ドラム以外）
                        "drum_events": list[dict],# リズムイベント（ドラムのみ）。type は、種類ごとに分けたとき
                                                  # "kick" "snare" "toms" "cymbals"、落としたとき "kick" "snare" "hihat"
                        "drum_source": str,       # ドラムのパートだけ。"stems"（種類ごとに分けた音から）か
                                                  # "spectral"（スペクトル重心の振り分け）
                        "grid_feel": str,         # 上の grid_feel と同じ値（どのパートも同じ）
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
        background_jobs.JobCancelled: ジョブがキャンセルされた場合。

    Note:
        分離済みステムは ``results/decompose/`` に WAV としてコピーされる。
        ``numpy`` および ``librosa`` を関数内で遅延インポートする。
        キャンセルが効くのは、Demucs の実行中（子プロセスを kill する）と、パートとパートの間。
        1 つのパートを音符にしている最中は止められない。
        種類ごとに分けたドラムの音声（``drums_kick`` など）は、採譜の材料にだけ使い、パートとしては返さない。
    """
    import numpy as np
    import librosa
    import background_jobs
    import stem_models

    if job is None:
        job = background_jobs.detached()
    grid_offset_sec = max(0.0, float(grid_offset_sec or 0.0))

    # BPM自動検出
    if bpm is None:
        job.enter_stage("tempo")
        y_full, sr_full = librosa.load(input_path, sr=22050, mono=True, duration=30)
        tempo, _ = librosa.beat.beat_track(y=y_full, sr=sr_full)
        bpm = int(round(float(np.atleast_1d(tempo)[0])))
        bpm = max(60, min(200, bpm))

    # 1. Demucs 分離
    from separate import deep_separate, STEM_LABELS
    import shutil
    from pathlib import Path

    import audio_utils
    results_dir = audio_utils.results_dir("decompose")

    def separate_stems(with_drums, **extra):
        return deep_separate(
            input_path,
            output_dir=str(results_dir / "separated"),
            segment=segment,
            jobs=jobs,
            recursive_depth=1,
            split_drums=with_drums,
            job=job,
            **extra,
        )

    drum_fallback = None
    if split_drums:
        split_errors = []
        try:
            # 細分化そのものの失敗（メモリ不足など）は、6 ステムの分離を数分かけたあとで起きる。
            # ジョブ全体を失敗にせず、ドラムを分けないで続ける（書きかけの細分化の出力は ``separate_drums`` が消す）。
            # キャンセルは受け止めない
            stem_paths = separate_stems(True, on_drum_split_error=split_errors.append)
            if split_errors:
                drum_fallback = DRUM_FALLBACK_SPLIT_FAILED
        except stem_models.ModelUnavailableError as e:
            # 追加のモデルを用意できなかった（オフラインなど）。``deep_separate`` は分離を始める前にこれを送出するので、
            # やり直しても、済んだ分離を捨てることにはならない。ドラムは、これまでの振り分けで採譜する
            drum_fallback = str(e)
            stem_paths = separate_stems(False)
    else:
        stem_paths = separate_stems(False)

    # 種類ごとに分けたドラムの音声は、採譜の材料。パートとしては返さない
    drum_stems = {DRUM_STEM_TYPES[name]: str(path) for name, path in stem_paths.items() if name in DRUM_STEM_TYPES}
    part_paths = {name: path for name, path in stem_paths.items() if name not in DRUM_STEM_TYPES}

    # 2. 各ステムを解析。ここでは、グリッドに丸める前の音（秒）までを取る。丸めるのは、全部のパートを
    # 見てグリッド（16 分か三連か）を決めたあと（ループの後ろ）
    job.enter_stage("transcribe")
    step_sec = 60.0 / bpm / 4
    stems = {}
    # パート → 丸める前の音。ノートは ("notes", 音の一覧)、ドラムは ("stems", 打音, ふつうの大きさ) か ("spectral", 打音)
    raw = {}
    for index, (stem_name, stem_path) in enumerate(part_paths.items()):
        # パートの切れ目でだけキャンセルを見る。進み具合は「済んだパートの数」
        job.check_cancelled()
        job.set_label(
            f"パートごとにノートを採譜しています（{index + 1}/{len(part_paths)}: {STEM_LABELS.get(stem_name, stem_name)}）"
        )
        job.set_progress(index / len(part_paths))

        stem_path = str(stem_path)
        # 保存用にコピー
        dst = results_dir / f"{stem_name}.wav"
        job.remove_on_abort(dst)
        shutil.copy2(stem_path, str(dst))

        stem_data = {
            "audio_path": str(dst),
            "notes": [],
            "drum_events": [],
            "gm_program": None,
            "mix": estimate_mix_params(stem_path),
        }

        if "drum" in stem_name:
            # ドラム → リズム解析。種類ごとに分けた音声が在れば（"drums" だけ）、そこから採譜する
            kept, typical = {}, {}
            if stem_name == "drums" and drum_stems:
                kept, typical = drum_stem_hits(drum_stems, sensitivity)
            # 1 小節目から後ろに打音が在るか（これまでと同じく、16 分のグリッドに丸めたイベントが在るかで決める）
            if drum_hits_to_events(kept, step_sec, grid_offset_sec, typical=typical):
                stem_data["drum_source"] = "stems"
                raw[stem_name] = ("stems", kept, typical)
            else:
                # 分けた音声が無い（モデルを用意できなかった・どれも無音だった）か、打音を取れなかった
                if stem_name == "drums" and split_drums and drum_fallback is None:
                    drum_fallback = DRUM_FALLBACK_NO_HITS
                stem_data["drum_source"] = "spectral"
                raw[stem_name] = ("spectral", spectral_drum_hits(stem_path, sensitivity))
        else:
            # メロディ/和音 → ポリフォニック書き起こし
            max_polyphony = 1 if "bass" in stem_name or "vocal" in stem_name else 4
            raw[stem_name] = ("notes", polyphonic_events(stem_path, bpm, sensitivity, max_notes_per_frame=max_polyphony))
            # 楽器推定
            stem_data["gm_program"] = estimate_instrument(stem_path, stem_name)

        stems[stem_name] = stem_data

    # 3. グリッドを決めて、丸める。曲全体で 1 つ（全部のパートの音の始まりから決め、全部のパートに同じグリッドを使う）
    grid_feel = detect_grid_feel(
        {name: _onset_times(entry) for name, entry in raw.items()}, step_sec, grid_offset_sec)["grid_feel"]
    for stem_name, entry in raw.items():
        stem_data = stems[stem_name]
        stem_data["grid_feel"] = grid_feel
        if entry[0] == "notes":
            stem_data["notes"] = events_to_notes(entry[1], step_sec, grid_offset_sec, grid_feel)
        elif entry[0] == "stems":
            stem_data["drum_events"] = drum_hits_to_events(entry[1], step_sec, grid_offset_sec, typical=entry[2],
                                                           grid_feel=grid_feel)
        else:
            stem_data["drum_events"] = spectral_hits_to_events(entry[1], step_sec, grid_offset_sec, grid_feel)

    job.set_progress(1.0)
    drum_source = stems["drums"]["drum_source"] if "drums" in stems else None
    return {
        "bpm": bpm,
        "grid_offset_sec": grid_offset_sec,
        "grid_feel": grid_feel,
        "drum_source": drum_source,
        # 頼まれていない・種類ごとに分けて採譜できた・ドラムのパートが無い、のどれでも None
        "drum_fallback": drum_fallback if split_drums and drum_source == "spectral" else None,
        "stems": stems,
    }
