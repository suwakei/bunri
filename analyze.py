"""WAV音声解析 → ピアノロール用ノートデータ変換

デフォルトは Spotify Basic Pitch（ポリフォニック対応ニューラルネット）。
engine='pyin' で従来の librosa pyin（単音メロディ向け）にフォールバック可能。
"""
import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def analyze_wav(file_path, bpm=120, sensitivity=0.5, engine="basic_pitch"):
    """WAVファイルを解析してピアノロール用のノートデータを返す。

    engine に応じて Basic Pitch または pyin を使用してピッチ検出を行い、
    16分音符単位のステップ/長さに変換したノートデータのリストを返す。

    Args:
        file_path (str): 解析対象の WAV ファイルパス。
        bpm (float): テンポ（BPM）。16分音符のステップ長さ計算に使用される。
        sensitivity (float): ピッチ検出の感度（0.0〜1.0）。
            値が高いほど検出ノート数が増える（閾値が緩くなる）。
        engine (str): 検出エンジンの選択。
            "basic_pitch" — Spotify Basic Pitch によるポリフォニック検出（デフォルト）。
            "pyin"        — librosa pyin による単音メロディ向け検出。

    Returns:
        list[dict]: ノートデータのリスト。各要素は以下のキーを持つ辞書。
            - note (str): 音名（例: "C", "A#"）。
            - octave (int): オクターブ番号。
            - step (int): 開始ステップ（16分音符単位、0始まり）。
            - length (int): ノートの長さ（16分音符の個数）。
    """
    if engine == "pyin":
        return _analyze_pyin(file_path, bpm, sensitivity)
    return _analyze_basic_pitch(file_path, bpm, sensitivity)


def _analyze_basic_pitch(file_path, bpm=120, sensitivity=0.5):
    """Spotify Basic Pitch を使ってポリフォニックピッチ検出を行う。

    ICASSP_2022 モデルでオンセット・フレーム閾値を sensitivity から算出し、
    検出された MIDI ノートイベントを 16分音符単位のステップ/長さに変換する。
    C1（MIDI=24）〜C7（MIDI=96）の範囲外のノートは除外する。

    Args:
        file_path (str): 解析対象のオーディオファイルパス
            （Basic Pitch が対応する形式: WAV, MP3, FLAC 等）。
        bpm (float): テンポ（BPM）。ステップ変換に使用される。
        sensitivity (float): 検出感度（0.0〜1.0）。
            高いほどオンセット/フレーム閾値が低くなり、より多くのノートを検出する。

    Returns:
        list[dict]: step 昇順にソートされたノートデータのリスト。
            各要素は {"note": str, "octave": int, "step": int, "length": int}。
    """
    import os
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH

    # onset/note の閾値を sensitivity から計算
    # sensitivity 高い → 閾値低い → 検出ノート数が増える
    onset_threshold = max(0.3, 1.0 - sensitivity * 0.7)
    note_threshold = max(0.2, 0.8 - sensitivity * 0.6)

    model_output, midi_data, note_events = predict(
        file_path,
        model_or_model_path=ICASSP_2022_MODEL_PATH,
        onset_threshold=onset_threshold,
        frame_threshold=note_threshold,
        minimum_note_length=40,  # ms
        midi_tempo=bpm,
    )

    step_sec = 60.0 / bpm / 4  # 16分音符

    notes = []
    for start_sec, end_sec, midi_note, amplitude, _ in note_events:
        if midi_note < 24 or midi_note > 96:  # C1〜C7
            continue
        note_name = NOTE_NAMES[int(midi_note) % 12]
        octave = (int(midi_note) // 12) - 1
        step = max(0, int(round(start_sec / step_sec)))
        length = max(1, int(round((end_sec - start_sec) / step_sec)))
        notes.append({
            "note": note_name,
            "octave": octave,
            "step": step,
            "length": length,
        })

    notes.sort(key=lambda n: (n["step"], n["octave"], n["note"]))
    return notes


def _analyze_pyin(file_path, bpm=120, sensitivity=0.5):
    """librosa pyin による単音メロディ向けピッチ検出（フォールバック用）"""
    import librosa

    y, sr = librosa.load(file_path, sr=22050, mono=True)

    fmin = librosa.note_to_hz('C2')
    fmax = librosa.note_to_hz('C7')
    f0, voiced_flag, voiced_prob = librosa.pyin(
        y, fmin=fmin, fmax=fmax, sr=sr,
        frame_length=2048, hop_length=512,
    )

    times = librosa.times_like(f0, sr=sr, hop_length=512)
    step_sec = 60.0 / bpm / 4

    threshold = max(0.1, sensitivity * 0.8)
    notes = []
    current_note = None
    current_start = 0
    current_midi = -1

    for i, (freq, is_voiced, prob) in enumerate(zip(f0, voiced_flag, voiced_prob)):
        t = times[i]

        if is_voiced and prob >= threshold and not np.isnan(freq):
            info = _freq_to_note(freq)
            if info is None:
                if current_note:
                    notes.append(_make_note(current_note, current_start, t, step_sec))
                    current_note = None
                continue

            note_name, octave, midi = info

            if current_note and abs(midi - current_midi) <= 1:
                continue
            else:
                if current_note:
                    notes.append(_make_note(current_note, current_start, t, step_sec))
                current_note = (note_name, octave)
                current_start = t
                current_midi = midi
        else:
            if current_note:
                notes.append(_make_note(current_note, current_start, t, step_sec))
                current_note = None

    if current_note:
        end_t = times[-1] if len(times) > 0 else current_start + step_sec
        notes.append(_make_note(current_note, current_start, end_t, step_sec))

    notes = [n for n in notes if n["length"] >= 1]
    return notes


def _freq_to_note(freq):
    """周波数から(音名, オクターブ, MIDIノート番号)を返す"""
    if freq <= 0 or np.isnan(freq):
        return None
    midi = 69 + 12 * np.log2(freq / 440.0)
    midi_round = int(round(midi))
    if midi_round < 24 or midi_round > 96:
        return None
    note_name = NOTE_NAMES[midi_round % 12]
    octave = (midi_round // 12) - 1
    return note_name, octave, midi_round


def _make_note(note_info, start_time, end_time, step_sec):
    """ノート情報を辞書に変換"""
    note_name, octave = note_info
    step = max(0, int(round(start_time / step_sec)))
    length = max(1, int(round((end_time - start_time) / step_sec)))
    return {
        "note": note_name,
        "octave": octave,
        "step": step,
        "length": length,
    }
