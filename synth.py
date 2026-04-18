"""ソフトウェアシンセサイザー + ステップシーケンサー + ドラムマシン"""
import json
import numpy as np
from pathlib import Path

from audio_utils import save_tmp

# ---- SoundFont (FluidSynth) ----

SOUNDFONT_PATH = Path(__file__).parent / "soundfonts" / "MuseScore_General.sf3"

# GM楽器マップ（番号: 表示名）
GM_INSTRUMENTS = {
    0: "ピアノ",
    1: "ブライトピアノ",
    2: "エレクトリックグランド",
    4: "エレクトリックピアノ",
    5: "FMピアノ",
    6: "ハープシコード",
    8: "チェレスタ",
    9: "グロッケンシュピール",
    10: "オルゴール",
    11: "ビブラフォン",
    12: "マリンバ",
    13: "シロフォン",
    24: "ナイロンギター",
    25: "スチールギター",
    26: "ジャズギター",
    27: "クリーンギター",
    28: "ミュートギター",
    29: "オーバードライブギター",
    30: "ディストーションギター",
    32: "アコースティックベース",
    33: "フィンガーベース",
    34: "ピックベース",
    35: "フレットレスベース",
    36: "スラップベース1",
    38: "シンセベース1",
    40: "バイオリン",
    41: "ビオラ",
    42: "チェロ",
    43: "コントラバス",
    44: "トレモロストリングス",
    45: "ピチカートストリングス",
    46: "ハープ",
    48: "ストリングアンサンブル1",
    49: "ストリングアンサンブル2",
    50: "シンセストリングス1",
    52: "コーラス Aah",
    53: "コーラス Ooh",
    54: "シンセボイス",
    56: "トランペット",
    57: "トロンボーン",
    58: "チューバ",
    59: "ミュートトランペット",
    60: "フレンチホルン",
    61: "ブラスセクション",
    62: "シンセブラス1",
    64: "ソプラノサックス",
    65: "アルトサックス",
    66: "テナーサックス",
    67: "バリトンサックス",
    68: "オーボエ",
    69: "イングリッシュホルン",
    70: "バスーン",
    71: "クラリネット",
    72: "ピッコロ",
    73: "フルート",
    74: "リコーダー",
    75: "パンフルート",
    79: "オカリナ",
    80: "シンセリード (Square)",
    81: "シンセリード (Saw)",
    88: "シンセパッド (New Age)",
    89: "シンセパッド (Warm)",
    90: "シンセパッド (Polysynth)",
    91: "シンセパッド (Choir)",
    95: "シンセパッド (Sweep)",
    104: "シタール",
    105: "バンジョー",
    108: "カリンバ",
    110: "フィドル",
    114: "スチールドラム",
}


def _fluidsynth_render(notes, bpm, program, volume, sr=44100):
    """
    FluidSynthでGM楽器のノートをレンダリング。
    notes: [{"note": "C", "octave": 4, "step": 0, "length": 1}, ...]
    """
    import fluidsynth

    step_sec = 60.0 / bpm / 4  # 16分音符

    max_end = max(n["step"] + n["length"] for n in notes)
    total_sec = max_end * step_sec + 2.0  # 余白2秒（リリース用）
    total_samples = int(total_sec * sr)

    fs = fluidsynth.Synth(samplerate=float(sr))
    sfid = fs.sfload(str(SOUNDFONT_PATH))
    fs.program_select(0, sfid, 0, program)

    # イベントをタイムライン順にソート
    events = []
    for n in notes:
        note_name = n.get("note", "C")
        if note_name.lower() == "rest":
            continue
        oct = int(n.get("octave", 4))
        midi_note = _note_to_midi(note_name, oct)
        start_sec = n["step"] * step_sec
        dur_sec = n["length"] * step_sec
        vel = min(127, max(1, int(volume * 127)))
        events.append(("on", start_sec, midi_note, vel))
        events.append(("off", start_sec + dur_sec, midi_note, 0))

    events.sort(key=lambda e: (e[1], 0 if e[0] == "off" else 1))

    # チャンクごとにレンダリング
    output = np.zeros(total_samples, dtype=np.float32)
    current_time = 0.0
    write_pos = 0

    for evt_type, evt_time, midi_note, vel in events:
        # evt_timeまでのサンプルを生成
        delta = evt_time - current_time
        if delta > 0:
            n_samples = int(delta * sr)
            if n_samples > 0:
                chunk = fs.get_samples(n_samples)
                # stereo interleaved → mono
                stereo = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
                mono = (stereo[0::2] + stereo[1::2]) * 0.5
                end = min(write_pos + len(mono), total_samples)
                output[write_pos:end] = mono[:end - write_pos]
                write_pos = end
            current_time = evt_time

        if evt_type == "on":
            fs.noteon(0, midi_note, vel)
        else:
            fs.noteoff(0, midi_note)

    # 残りのリリース部分を生成
    remaining = total_samples - write_pos
    if remaining > 0:
        chunk = fs.get_samples(remaining)
        stereo = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
        mono = (stereo[0::2] + stereo[1::2]) * 0.5
        output[write_pos:write_pos + len(mono)] = mono[:remaining]

    fs.delete()

    # 末尾の無音をトリム
    threshold = 0.001
    last_nonsilent = len(output) - 1
    while last_nonsilent > 0 and abs(output[last_nonsilent]) < threshold:
        last_nonsilent -= 1
    # フェードアウト用に少し余白
    end_idx = min(last_nonsilent + int(0.3 * sr), len(output))
    output = output[:end_idx]

    output = np.clip(output * volume, -1.0, 1.0)
    return save_tmp(output, sr, "gm")


def _note_to_midi(note_name, octave):
    """音名とオクターブからMIDIノート番号を計算して返す。

    Args:
        note_name (str): 音名。NOTE_NAMES に含まれる文字列（例: "C", "A#"）。
        octave (int): オクターブ番号（MIDI規格: C4=60 に基づく）。

    Returns:
        int: MIDIノート番号（0〜127）。
    """
    idx = NOTE_NAMES.index(note_name)
    return (octave + 1) * 12 + idx


# ---- 基本波形 ----

def _oscillator(freq, duration, sr, waveform):
    """指定した波形の基本オシレーターを生成する。

    Args:
        freq (float): 生成する音の周波数（Hz）。
        duration (float): 生成する長さ（秒）。
        sr (int): サンプルレート（Hz）。
        waveform (str): 波形の種類。"sine" / "square" / "sawtooth" / "triangle"
            のいずれか。未知の値の場合は "sine" にフォールバックする。

    Returns:
        numpy.ndarray: 形状 (int(sr * duration),) の float64 配列。
            振幅は -1.0〜1.0 の範囲。
    """
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    if waveform == "sine":
        return np.sin(2 * np.pi * freq * t)
    elif waveform == "square":
        return np.sign(np.sin(2 * np.pi * freq * t))
    elif waveform == "sawtooth":
        return 2 * (freq * t - np.floor(0.5 + freq * t))
    elif waveform == "triangle":
        return 2 * np.abs(2 * (freq * t - np.floor(0.5 + freq * t))) - 1
    return np.sin(2 * np.pi * freq * t)


# ---- ADSRエンベロープ ----

def _adsr(length, sr, attack, decay, sustain, release):
    """ADSRエンベロープを生成する。

    Attack → Decay → Sustain → Release の順に振幅が変化する
    エンベロープ配列を返す。各フェーズが length を超える場合は
    残りサンプル数に合わせてクリップされる。

    Args:
        length (int): エンベロープの総サンプル数。
        sr (int): サンプルレート（Hz）。
        attack (float): アタック時間（秒）。0 から 1 まで線形補間。
        decay (float): ディケイ時間（秒）。1 から sustain まで線形補間。
        sustain (float): サステインレベル（0.0〜1.0）。
        release (float): リリース時間（秒）。sustain から 0 まで線形補間。

    Returns:
        numpy.ndarray: 形状 (length,) の float64 配列。
            値は 0.0〜1.0 の範囲。
    """
    env = np.zeros(length)
    a = int(attack * sr)
    d = int(decay * sr)
    r = int(release * sr)
    s_len = max(length - a - d - r, 0)

    idx = 0
    # Attack
    n = min(a, length - idx)
    env[idx:idx + n] = np.linspace(0, 1, n)
    idx += n
    # Decay
    n = min(d, length - idx)
    env[idx:idx + n] = np.linspace(1, sustain, n)
    idx += n
    # Sustain
    n = min(s_len, length - idx)
    env[idx:idx + n] = sustain
    idx += n
    # Release
    n = min(r, length - idx)
    env[idx:idx + n] = np.linspace(sustain, 0, n)
    idx += n

    return env


# ---- 音名→周波数 ----

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_to_freq(note_name, octave):
    """音名とオクターブから周波数を計算する（A4=440Hz基準）。

    A4 を 440 Hz として、半音ごとに 2^(1/12) 倍のスケールで
    平均律の周波数を算出する。

    Args:
        note_name (str): 音名。NOTE_NAMES に含まれる文字列
            （"C", "C#", "D", ... "B" のいずれか）。
        octave (int): オクターブ番号（A4 が octave=4 に対応）。

    Returns:
        float: 対応する周波数（Hz）。

    Raises:
        ValueError: note_name が NOTE_NAMES に含まれない場合。
    """
    if note_name not in NOTE_NAMES:
        raise ValueError(f"不正な音名: {note_name}")
    semitone = NOTE_NAMES.index(note_name) - 9  # A=0基準
    midi_offset = semitone + (octave - 4) * 12
    return 440.0 * (2 ** (midi_offset / 12))


# ---- 単音シンセ ----

def _instrument_synth(freq, duration, sr, instrument):
    """楽器プリセットを使ったモデルベース音声合成を行う。

    各楽器ごとに専用アルゴリズムで波形を生成する。
    未知の instrument 名が渡された場合は _oscillator にフォールバックする。

    Args:
        freq (float): 音の基本周波数（Hz）。
        duration (float): 生成する長さ（秒）。
        sr (int): サンプルレート（Hz）。
        instrument (str): 楽器プリセット名。
            "guitar" / "violin" / "chorus" / "flute" / "bass" / "organ"
            のいずれか。それ以外は _oscillator の waveform として解釈される。

    Returns:
        numpy.ndarray: 生成した波形サンプル列（float64）。
            長さは int(sr * duration)。ADSRエンベロープは未適用。
    """
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    phase = 2 * np.pi * freq * t

    if instrument == "guitar":
        # Karplus-Strong（弦をはじくモデル）
        n_samples = int(sr * duration)
        buf_len = int(sr / freq)
        if buf_len < 2:
            buf_len = 2
        buf = np.random.uniform(-1, 1, buf_len)
        out = np.zeros(n_samples)
        for i in range(n_samples):
            out[i] = buf[i % buf_len]
            buf[i % buf_len] = 0.498 * (buf[i % buf_len] + buf[(i + 1) % buf_len])
        return out

    elif instrument == "violin":
        # FM合成 + ビブラート
        vibrato = 0.005 * np.sin(2 * np.pi * 5.5 * t)
        mod = np.sin(2 * np.pi * freq * 2 * t) * 0.8
        return np.sin(phase * (1 + vibrato) + mod)

    elif instrument == "chorus":
        # 複数デチューン正弦波 + ビブラート
        vibrato = 0.003 * np.sin(2 * np.pi * 4 * t)
        v1 = np.sin(phase * (1 + vibrato))
        v2 = np.sin(2 * np.pi * (freq * 1.005) * t + 0.5)
        v3 = np.sin(2 * np.pi * (freq * 0.995) * t + 1.0)
        v4 = np.sin(2 * np.pi * (freq * 1.002) * t + 1.5)
        return (v1 + v2 + v3 + v4) * 0.25

    elif instrument == "flute":
        # 正弦波 + ブレスノイズ + ビブラート
        vibrato = 0.004 * np.sin(2 * np.pi * 5 * t)
        tone = np.sin(phase * (1 + vibrato))
        breath = np.random.randn(len(t)) * 0.05 * np.exp(-t * 0.5)
        return tone * 0.85 + breath

    elif instrument == "bass":
        # 鋸歯状波 + ローパスフィルタ近似
        saw = 2 * (freq * t - np.floor(0.5 + freq * t))
        # 簡易ローパス（移動平均）
        kernel_size = max(int(sr / (freq * 4)), 3)
        kernel = np.ones(kernel_size) / kernel_size
        filtered = np.convolve(saw, kernel, mode='same')
        return filtered

    elif instrument == "organ":
        # 倍音加算合成（ドローバーオルガン風）
        harmonics = [1, 2, 3, 4, 6, 8]
        amps = [1.0, 0.8, 0.6, 0.3, 0.2, 0.1]
        out = np.zeros_like(t)
        for h, a in zip(harmonics, amps):
            out += a * np.sin(phase * h)
        return out / sum(amps)

    # フォールバック: 基本波形
    return _oscillator(freq, duration, sr, instrument)


# 楽器プリセットのデフォルトADSR
INSTRUMENT_ADSR = {
    "guitar":  (0.002, 0.05, 0.3, 0.3),
    "violin":  (0.08, 0.1, 0.8, 0.15),
    "chorus":  (0.1, 0.15, 0.7, 0.3),
    "flute":   (0.05, 0.08, 0.7, 0.15),
    "bass":    (0.005, 0.1, 0.6, 0.1),
    "organ":   (0.01, 0.05, 0.9, 0.05),
}

INSTRUMENTS = list(INSTRUMENT_ADSR.keys())


def synth_note(note_name, octave, duration, waveform, volume,
               attack, decay, sustain, release, instrument=None):
    """単音WAVファイルを合成して一時ファイルに保存する。

    instrument が指定されている場合は _instrument_synth と INSTRUMENT_ADSR の
    プリセットパラメータを使用する。呼び出し元が ADSR パラメータをデフォルト値
    （attack=0.01, decay=0.1, sustain=0.6, release=0.2）のまま渡した場合は
    プリセット値を優先する。

    Args:
        note_name (str): 音名（"C"〜"B"、シャープ記号含む）。
        octave (int): オクターブ番号。
        duration (float): 音符の長さ（秒）。
        waveform (str): instrument が None のときに使用する波形
            （"sine" / "square" / "sawtooth" / "triangle"）。
        volume (float): 出力音量スケール（0.0〜1.0）。
        attack (float): アタック時間（秒）。
        decay (float): ディケイ時間（秒）。
        sustain (float): サステインレベル（0.0〜1.0）。
        release (float): リリース時間（秒）。
        instrument (str | None): 楽器プリセット名。None の場合は
            waveform パラメータが使用される。

    Returns:
        str: 生成した WAV 一時ファイルのパス。
    """
    sr = 44100
    freq = note_to_freq(note_name, int(octave))
    if instrument and instrument in INSTRUMENT_ADSR:
        samples = _instrument_synth(freq, duration, sr, instrument)
        # instrument指定時はプリセットADSRをデフォルトに
        da, dd, ds, dr = INSTRUMENT_ADSR[instrument]
        env = _adsr(len(samples), sr,
                     attack if attack != 0.01 else da,
                     decay if decay != 0.1 else dd,
                     sustain if sustain != 0.6 else ds,
                     release if release != 0.2 else dr)
    else:
        samples = _oscillator(freq, duration, sr, waveform)
        env = _adsr(len(samples), sr, attack, decay, sustain, release)
    result = samples * env * volume
    return save_tmp(np.clip(result, -1.0, 1.0).astype(np.float32), sr, "synth")


# ---- ステップシーケンサー ----

def step_sequencer(notes_json, bpm, waveform, volume,
                   attack, decay, sustain, release, instrument=None,
                   gm_program=None):
    """
    JSONフォーマットの音符データからオーディオを生成。

    notes_json: [{"note": "C", "octave": 4, "step": 0, "length": 1}, ...]
      - step: 何ステップ目か（16分音符単位、0始まり）
      - length: 何ステップ分の長さか
      - "rest" の note は休符
    gm_program: GM楽器番号（指定時はFluidSynthで高品質レンダリング）
    """
    sr = 44100
    step_sec = 60.0 / bpm / 4  # 16分音符の長さ（秒）

    try:
        notes = json.loads(notes_json)
    except (json.JSONDecodeError, TypeError):
        raise ValueError(
            'JSONの形式が正しくありません。例:\n'
            '[{"note":"C","octave":4,"step":0,"length":4},\n'
            ' {"note":"E","octave":4,"step":4,"length":4}]'
        )

    if not notes:
        raise ValueError("音符データが空です")

    # GM楽器指定時はFluidSynthでレンダリング
    if gm_program is not None and SOUNDFONT_PATH.exists():
        return _fluidsynth_render(notes, bpm, int(gm_program), volume, sr)

    # 全体の長さを計算
    max_end = max(n["step"] + n["length"] for n in notes)
    total_samples = int(max_end * step_sec * sr)
    output = np.zeros(total_samples, dtype=np.float64)

    for n in notes:
        note_name = n.get("note", "C")
        if note_name.lower() == "rest":
            continue
        oct = int(n.get("octave", 4))
        step_start = int(n.get("step", 0))
        step_len = int(n.get("length", 1))

        freq = note_to_freq(note_name, oct)
        dur = step_len * step_sec
        if instrument and instrument in INSTRUMENT_ADSR:
            samples = _instrument_synth(freq, dur, sr, instrument)
            da, dd, ds, dr = INSTRUMENT_ADSR[instrument]
            env = _adsr(len(samples), sr,
                         attack if attack != 0.01 else da,
                         decay if decay != 0.1 else dd,
                         sustain if sustain != 0.6 else ds,
                         release if release != 0.2 else dr)
        else:
            samples = _oscillator(freq, dur, sr, waveform)
            env = _adsr(len(samples), sr, attack, decay, sustain, release)
        tone = samples * env * volume

        start_idx = int(step_start * step_sec * sr)
        end_idx = start_idx + len(tone)
        if end_idx > total_samples:
            tone = tone[:total_samples - start_idx]
            end_idx = total_samples
        output[start_idx:end_idx] += tone

    output = np.clip(output, -1.0, 1.0).astype(np.float32)
    return save_tmp(output, sr, "seq")


# ---- ドラムマシン ----

def _kick(sr):
    """キックドラムの合成"""
    t = np.linspace(0, 0.3, int(sr * 0.3), endpoint=False)
    freq = 150 * np.exp(-t * 15) + 40
    phase = np.cumsum(2 * np.pi * freq / sr)
    return np.sin(phase) * np.exp(-t * 8)


def _snare(sr):
    """スネアドラムの合成"""
    t = np.linspace(0, 0.2, int(sr * 0.2), endpoint=False)
    tone = np.sin(2 * np.pi * 200 * t) * np.exp(-t * 20)
    noise = np.random.randn(len(t)) * np.exp(-t * 15)
    return (tone * 0.5 + noise * 0.5)


def _hihat(sr):
    """ハイハットの合成"""
    t = np.linspace(0, 0.08, int(sr * 0.08), endpoint=False)
    noise = np.random.randn(len(t)) * np.exp(-t * 40)
    return noise * 0.6


DRUM_PATTERNS = {
    "4つ打ち": {
        "kick":  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        "snare": [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
        "hihat": [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    },
    "8ビート": {
        "kick":  [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        "snare": [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
        "hihat": [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    },
    "ボサノバ": {
        "kick":  [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0],
        "snare": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "hihat": [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0],
    },
    "レゲエ": {
        "kick":  [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
        "snare": [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
        "hihat": [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
    },
}


def drum_machine(pattern_name, bpm, bars, volume):
    """ドラムパターンを生成"""
    sr = 44100
    step_sec = 60.0 / bpm / 4
    bars = int(bars)

    if pattern_name not in DRUM_PATTERNS:
        raise ValueError(f"不明なパターン: {pattern_name}")

    pattern = DRUM_PATTERNS[pattern_name]
    steps_per_bar = 16
    total_steps = steps_per_bar * bars
    total_samples = int(total_steps * step_sec * sr)
    output = np.zeros(total_samples, dtype=np.float64)

    sounds = {
        "kick": _kick(sr),
        "snare": _snare(sr),
        "hihat": _hihat(sr),
    }

    for step in range(total_steps):
        pat_step = step % steps_per_bar
        start = int(step * step_sec * sr)
        for drum_name, seq in pattern.items():
            if seq[pat_step]:
                sound = sounds[drum_name]
                end = min(start + len(sound), total_samples)
                output[start:end] += sound[:end - start]

    output = output * volume
    output = np.clip(output, -1.0, 1.0).astype(np.float32)
    return save_tmp(output, sr, "drum")
