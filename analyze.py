"""WAV音声解析 → ピアノロール用ノートデータ変換"""
import numpy as np


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _freq_to_note(freq):
    """周波数から(音名, オクターブ, MIDIノート番号)を返す"""
    if freq <= 0 or np.isnan(freq):
        return None
    midi = 69 + 12 * np.log2(freq / 440.0)
    midi_round = int(round(midi))
    if midi_round < 24 or midi_round > 96:  # C2〜C7の範囲外は無視
        return None
    note_name = NOTE_NAMES[midi_round % 12]
    octave = (midi_round // 12) - 1
    return note_name, octave, midi_round


def analyze_wav(file_path, bpm=120, sensitivity=0.5):
    """
    WAVファイルを解析してピアノロール用のノートデータを返す。

    Args:
        file_path: WAVファイルのパス
        bpm: テンポ（16分音符のステップ計算に使用）
        sensitivity: ピッチ検出の感度（0〜1, 低いほど厳密）

    Returns:
        list of {"note": str, "octave": int, "step": int, "length": int}
    """
    import librosa

    # 音声読み込み（モノラル、22050Hz）
    y, sr = librosa.load(file_path, sr=22050, mono=True)

    # ピッチ検出（pyin: 確率的YIN）
    fmin = librosa.note_to_hz('C2')
    fmax = librosa.note_to_hz('C7')
    f0, voiced_flag, voiced_prob = librosa.pyin(
        y, fmin=fmin, fmax=fmax, sr=sr,
        frame_length=2048, hop_length=512,
    )

    # 時間軸
    times = librosa.times_like(f0, sr=sr, hop_length=512)

    # 16分音符のステップ長（秒）
    step_sec = 60.0 / bpm / 4

    # フレームごとのピッチをノートに変換
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
                # 範囲外 → 無音扱い
                if current_note:
                    notes.append(_make_note(current_note, current_start, t, step_sec))
                    current_note = None
                continue

            note_name, octave, midi = info

            # 同じノートが続いている場合はまとめる
            if current_note and abs(midi - current_midi) <= 1:
                continue  # 同じノート（半音以内の揺れは許容）
            else:
                # 新しいノート
                if current_note:
                    notes.append(_make_note(current_note, current_start, t, step_sec))
                current_note = (note_name, octave)
                current_start = t
                current_midi = midi
        else:
            # 無声区間
            if current_note:
                notes.append(_make_note(current_note, current_start, t, step_sec))
                current_note = None

    # 最後のノート
    if current_note:
        end_t = times[-1] if len(times) > 0 else current_start + step_sec
        notes.append(_make_note(current_note, current_start, end_t, step_sec))

    # 極端に短いノート（1ステップ未満）を除去
    notes = [n for n in notes if n["length"] >= 1]

    return notes


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
