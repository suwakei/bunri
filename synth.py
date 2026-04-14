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
    """音名+オクターブからMIDIノート番号を返す"""
    idx = NOTE_NAMES.index(note_name)
    return (octave + 1) * 12 + idx


# ---- 基本波形 ----

def _oscillator(freq, duration, sr, waveform):
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
    """音名とオクターブから周波数を計算（A4=440Hz基準）"""
    if note_name not in NOTE_NAMES:
        raise ValueError(f"不正な音名: {note_name}")
    semitone = NOTE_NAMES.index(note_name) - 9  # A=0基準
    midi_offset = semitone + (octave - 4) * 12
    return 440.0 * (2 ** (midi_offset / 12))


# ---- 単音シンセ ----

def _instrument_synth(freq, duration, sr, instrument):
    """楽器プリセットによる音声合成"""
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

    elif instrument == "choir":
        # 男女混声合唱風: フォルマント合成（母音「ア」的な共鳴）
        # 複数声部のデチューン + フォルマント強調
        vibrato = 0.005 * np.sin(2 * np.pi * 5 * t + np.random.uniform(0, np.pi))
        base = np.sin(phase * (1 + vibrato))
        # フォルマント周波数（男声「ア」: 730, 1090, 2440 Hz 付近）
        formant1 = np.sin(2 * np.pi * 730 * t) * 0.15
        formant2 = np.sin(2 * np.pi * 1090 * t) * 0.08
        formant3 = np.sin(2 * np.pi * 2440 * t) * 0.04
        # 男女パート（1オクターブ違い）を重ねる
        upper = np.sin(2 * np.pi * (freq * 2) * t) * 0.3
        lower = np.sin(2 * np.pi * (freq * 0.5) * t) * 0.2
        # 軽いノイズで息感
        breath = np.random.randn(len(t)) * 0.03
        out = base + upper + lower + formant1 + formant2 + formant3 + breath
        return out * 0.4

    elif instrument == "strings":
        # ストリングスセクション: 多層デチューン鋸歯状波 + ビブラート
        vibrato = 0.004 * np.sin(2 * np.pi * 5.2 * t)
        saw1 = 2 * ((freq * t * (1 + vibrato)) - np.floor(0.5 + freq * t * (1 + vibrato)))
        saw2 = 2 * ((freq * 1.007 * t) - np.floor(0.5 + freq * 1.007 * t))
        saw3 = 2 * ((freq * 0.993 * t) - np.floor(0.5 + freq * 0.993 * t))
        mix = (saw1 + saw2 + saw3) / 3
        # 簡易ローパス（アンサンブル感）
        kernel_size = max(int(sr / (freq * 8)), 3)
        kernel = np.ones(kernel_size) / kernel_size
        filtered = np.convolve(mix, kernel, mode='same')
        return filtered * 0.8

    elif instrument == "brass":
        # ブラス: 鋸歯状波 + 倍音強調 + アタック時のピッチベンド
        pitch_bend = 1 + 0.002 * np.exp(-t * 8)  # アタックで上昇
        saw = 2 * ((freq * t * pitch_bend) - np.floor(0.5 + freq * t * pitch_bend))
        # 2倍音を強調
        h2 = np.sin(phase * 2) * 0.4
        return saw * 0.7 + h2

    elif instrument == "piano":
        # ピアノ: 複数倍音の加算合成 + 減衰
        # ハンマー音（アタックノイズ）
        attack_noise = np.random.randn(int(sr * 0.005)) * 0.3
        out = np.zeros_like(t)
        # 倍音ごとに異なる減衰率
        harmonics = [(1, 1.0, 2.0), (2, 0.5, 3.0), (3, 0.25, 4.0),
                     (4, 0.15, 5.0), (5, 0.08, 6.0)]
        for h, amp, decay_rate in harmonics:
            out += amp * np.sin(phase * h) * np.exp(-t * decay_rate)
        # アタックノイズを先頭に付与
        if len(attack_noise) < len(out):
            out[:len(attack_noise)] += attack_noise
        return out / 2

    elif instrument == "epiano":
        # エレピ: FM合成（Yamaha DX7風）
        mod_freq = freq * 1.0
        mod_index = 2.0 * np.exp(-t * 3)  # モジュレーションインデックスが減衰
        modulator = mod_index * np.sin(2 * np.pi * mod_freq * t)
        carrier = np.sin(phase + modulator)
        return carrier * np.exp(-t * 0.8)

    elif instrument == "pad":
        # シンセパッド: スロー立ち上がりの多層デチューン
        vibrato = 0.002 * np.sin(2 * np.pi * 0.5 * t)
        s1 = np.sin(phase * (1 + vibrato))
        s2 = np.sin(2 * np.pi * (freq * 1.003) * t + 0.3)
        s3 = np.sin(2 * np.pi * (freq * 0.997) * t + 0.7)
        s4 = np.sin(2 * np.pi * (freq * 2.0) * t) * 0.3  # 1オクターブ上
        return (s1 + s2 + s3 + s4) * 0.3

    elif instrument == "bell":
        # ベル/シンセベル: FM合成の非整数倍音
        mod = np.sin(2 * np.pi * freq * 3.5 * t) * 3 * np.exp(-t * 2)
        carrier = np.sin(phase + mod)
        return carrier * np.exp(-t * 1.5)

    elif instrument == "pluck":
        # プラック（シンセ弦）: 鋸歯状波 + 急減衰フィルタ
        saw = 2 * (freq * t - np.floor(0.5 + freq * t))
        envelope = np.exp(-t * 4)  # 急速な減衰
        return saw * envelope

    elif instrument == "lead":
        # シンセリード: 矩形波 + 軽いPWM + ビブラート
        vibrato = 0.005 * np.sin(2 * np.pi * 5 * t)
        pwm = 0.5 + 0.2 * np.sin(2 * np.pi * 0.8 * t)
        square = np.sign(np.sin(phase * (1 + vibrato)) - (pwm - 0.5) * 2)
        return square * 0.6

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
    "choir":   (0.15, 0.2, 0.75, 0.4),
    "strings": (0.12, 0.2, 0.8, 0.3),
    "brass":   (0.05, 0.1, 0.75, 0.2),
    "piano":   (0.002, 0.3, 0.4, 0.5),
    "epiano":  (0.005, 0.2, 0.5, 0.3),
    "pad":     (0.4, 0.3, 0.85, 0.6),
    "bell":    (0.001, 0.1, 0.3, 1.5),
    "pluck":   (0.001, 0.05, 0.1, 0.3),
    "lead":    (0.01, 0.05, 0.8, 0.15),
    "flute":   (0.05, 0.08, 0.7, 0.15),
    "bass":    (0.005, 0.1, 0.6, 0.1),
    "organ":   (0.01, 0.05, 0.9, 0.05),
}

INSTRUMENTS = list(INSTRUMENT_ADSR.keys())


def synth_note(note_name, octave, duration, waveform, volume,
               attack, decay, sustain, release, instrument=None):
    """単音を生成（instrument指定時は楽器プリセットを使用）"""
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
