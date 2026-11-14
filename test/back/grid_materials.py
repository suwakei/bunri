"""グリッド推定の検証用の合成音源（正解つき）。

テンポ・1 拍目の位置・拍子・無音の前置きを変えて、拍の位置と小節頭が分かっている音源を作る。
乱数は種で固定するので、同じ引数からは同じ波形が出る。

材料は 2 系統ある。音色もリズムの作りも別にしてある（片方に合わせ込んだ直し方を、もう片方で見つけるため）。

- ``basic_song``: サイン波ベースの単純な材料（クリック、コード、分散和音、ドラム）
- ``band_song``: 鋸波・エレピ風の音色で、実際の曲に近いリズムの型（ロック、ハウス、シャッフル、
  16 分の刻み、食い、ワルツ、5 拍子など）。残響も付けられる

テスト（``test_structure.py``）と、誤差の表を出すスクリプト（``bench_grid.py``）が使う。
"""
import numpy as np

SR = 44100

# 1 小節ごとのコード進行（MIDI ノート番号）
_BASIC_PROGRESSION = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]]  # C → G → Am → F

BAND_PROGRESSIONS = {
    "vi-IV-I-V": [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]],
    "ii-V-I-vi7": [[62, 65, 69], [55, 59, 62, 65], [60, 64, 67], [57, 60, 64, 67]],
    "I-vi-IV-V": [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]],
}

BASIC_STYLES = (
    "click_chords",   # 持続するコード + 各拍に同じ強さのクリック
    "sine_notes",     # サイン波の単音を 1 小節ずつ
    "pad_chords",     # 立ち上がりの遅いコードだけ。打楽器なし
    "piano_chords",   # 各拍でコードを弾き直す（減衰音）。小節頭でコードが変わる
    "arpeggio",       # 8 分音符の分散和音 + 小節頭のベース
    "drums",          # ドラムだけ（キック・スネア・ハイハット）。和音なし
    "band",           # ドラム + 8 分のベース + 1 小節ごとのコード
    "band_2chords",   # band と同じだが、コードが半小節ごとに変わる
    "band_backbeat",  # band と同じだが、スネア（2・4 拍）がいちばん大きい
)

BAND_STYLES = (
    "rock",       # キック 1・3・3 裏、スネア 2・4、8 分のハイハットとベース、パワーコード
    "house",      # 4 つ打ち、クラップ 2・4、裏拍のハイハットとベース
    "shuffle",    # 跳ねたハイハット、拍ごとに動くベース（ルート・3 度・5 度・6 度）
    "sixteenth",  # 16 分のハイハット、シンコペーションしたキックとベース
    "ballad",     # 8 分の分散和音、小節頭のベース、キック 1・リム 3
    "push",       # コードとベースが、小節線の 8 分音符前に先取りで変わる（食い）
    "melody",     # 単旋律だけ。伴奏なし
    "strum",      # ギター風のかき鳴らし（拍の頭が強く、裏が弱い）。打楽器なし
    "waltz",      # 3 拍子。1 拍目にベース、2・3 拍目にコード
    "five",       # 5 拍子（3 + 2）
)


def _hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def _add(buf, start_sec, wave):
    """``buf`` の ``start_sec`` の位置に ``wave`` を足し込む（はみ出す分は捨てる）。"""
    start = int(round(start_sec * SR))
    if start < 0 or start >= len(buf):
        return
    end = min(len(buf), start + len(wave))
    buf[start:end] += wave[:end - start]


def _finish(buf, rng, noise):
    """わずかな雑音を足し、最大振幅をそろえて float32 にする。"""
    buf = buf + noise * rng.standard_normal(len(buf))
    buf /= max(1e-9, np.max(np.abs(buf)) / 0.89)
    return buf.astype(np.float32)


# ── basic_song の音色 ─────────────────────────────────────────


def _tone(midi_notes, dur, attack=0.025, decay=0.0, harmonics=(1.0, 0.28)):
    t = np.arange(int(dur * SR)) / SR
    wave = np.zeros_like(t)
    for m in midi_notes:
        for h, gain in enumerate(harmonics, start=1):
            wave += gain * np.sin(2 * np.pi * _hz(m) * h * t)
    env = np.minimum(1.0, t / attack)
    if decay > 0:
        env = env * np.exp(-t * decay)
    else:
        env = env * (1 - 0.35 * (t / max(dur, 1e-9)))
    fade = int(0.01 * SR)
    if len(env) > fade:
        env[-fade:] *= np.linspace(1, 0, fade)
    return wave * env


def _click(gain=0.5):
    t = np.arange(int(0.012 * SR)) / SR
    return gain * np.sin(2 * np.pi * 1800 * t) * np.exp(-t * 400)


def _kick(gain=0.6):
    d = int(0.12 * SR)
    t = np.arange(d) / SR
    return gain * np.sin(2 * np.pi * np.cumsum(np.linspace(120, 45, d)) / SR) * np.exp(-t * 28)


def _snare(rng, gain=0.4):
    d = int(0.12 * SR)
    t = np.arange(d) / SR
    return gain * (0.7 * rng.standard_normal(d) + 0.3 * np.sin(2 * np.pi * 190 * t)) * np.exp(-t * 30)


def _hat(rng, gain=0.12):
    d = int(0.03 * SR)
    t = np.arange(d) / SR
    noise = np.diff(rng.standard_normal(d), prepend=0.0)  # 高域寄りにする
    return gain * noise * np.exp(-t * 180)


def basic_song(bpm=120.0, beats_per_bar=4, lead_silence=0.0, bars=16, style="click_chords",
               pickup_beats=0, drift=0.0, seed=0):
    """単純な材料の合成音源と、その正解を返す。

    Args:
        bpm (float): テンポ。
        beats_per_bar (int): 1 小節の拍数（3 か 4）。
        lead_silence (float): 曲頭の無音（秒）。
        bars (int): 小節数。
        style (str): 材料の種類（``BASIC_STYLES``）。
        pickup_beats (int): 弱起の拍数。1 小節目の前に、この拍数だけ音を置く。
        drift (float): テンポの揺れの割合（0.02 で ±2%）。
        seed (int): 乱数の種。

    Returns:
        tuple[numpy.ndarray, dict]: ``(モノラル波形, 正解)``。正解のキーは
        ``bpm`` / ``beats_per_bar`` / ``beat_times``（拍の位置。弱起を含む） /
        ``downbeat``（1 小節目の頭） / ``bar_sec``（1 小節の長さ）。
    """
    rng = np.random.default_rng(seed)
    per_bar = int(beats_per_bar)
    n_beats = pickup_beats + bars * per_bar
    beat_sec = 60.0 / bpm
    periods = beat_sec * (1.0 + drift * np.sin(2 * np.pi * np.arange(n_beats) / 32.0))
    beats = lead_silence + np.concatenate([[0.0], np.cumsum(periods)])
    end_sec = float(beats[-1])
    beats = beats[:-1]
    buf = np.zeros(int((end_sec + 0.6) * SR))

    # 弱起: 1 小節目のコードの 5 度の音を、拍ごとに短く鳴らす
    for i in range(pickup_beats):
        _add(buf, beats[i], 0.12 * _tone([67], beat_sec * 0.9, attack=0.01))

    for bar in range(bars):
        chord = _BASIC_PROGRESSION[bar % 4]
        first = pickup_beats + bar * per_bar
        bar_beats = [float(beats[first + b]) for b in range(per_bar)]
        start = bar_beats[0]
        dur = (float(beats[first + per_bar]) if first + per_bar < len(beats) else end_sec) - start

        if style == "click_chords":
            _add(buf, start, 0.11 * _tone(chord, dur))
            _add(buf, start, 0.20 * _tone([chord[0] - 24], dur, harmonics=(1.0,)))
            for bt in bar_beats:
                _add(buf, bt, _click())
        elif style == "sine_notes":
            _add(buf, start, 0.4 * _tone([chord[0] + 12], dur, attack=0.005, harmonics=(1.0,)))
        elif style == "pad_chords":
            _add(buf, start, 0.14 * _tone(chord, dur, attack=0.08))
        elif style == "piano_chords":
            for bt in bar_beats:
                _add(buf, bt, 0.14 * _tone(chord, beat_sec * 0.95, attack=0.005, decay=4.0))
        elif style == "arpeggio":
            _add(buf, start, 0.22 * _tone([chord[0] - 12], dur, attack=0.005, decay=2.0, harmonics=(1.0, 0.4)))
            order = [0, 1, 2, 1]
            for b, bt in enumerate(bar_beats):
                for half in range(2):
                    note = chord[order[(b * 2 + half) % 4]] + 12
                    _add(buf, bt + half * beat_sec / 2,
                         0.16 * _tone([note], beat_sec / 2 * 0.9, attack=0.005, decay=6.0))
        elif style in ("drums", "band", "band_2chords", "band_backbeat"):
            snare_gain = 0.75 if style == "band_backbeat" else 0.4
            for b, bt in enumerate(bar_beats):
                on_kick = b in (0, 2) if per_bar == 4 else b == 0
                if on_kick:
                    _add(buf, bt, _kick())
                else:
                    _add(buf, bt, _snare(rng, snare_gain if per_bar == 4 else snare_gain * 0.7))
                _add(buf, bt, _hat(rng))
                _add(buf, bt + beat_sec / 2, _hat(rng, 0.08))
            if style == "band_2chords" and per_bar == 4:
                # 小節頭と 3 拍目の両方でコードが変わる
                spans = [(_BASIC_PROGRESSION[(2 * bar) % 4], 0, 2), (_BASIC_PROGRESSION[(2 * bar + 1) % 4], 2, 2)]
            elif style != "drums":
                spans = [(chord, 0, per_bar)]
            else:
                spans = []
            for span_chord, first_beat, count in spans:
                span_end = bar_beats[first_beat + count] if first_beat + count < per_bar else start + dur
                _add(buf, bar_beats[first_beat], 0.10 * _tone(span_chord, span_end - bar_beats[first_beat], attack=0.02))
                for b in range(first_beat, first_beat + count):
                    for half in range(2):
                        _add(buf, bar_beats[b] + half * beat_sec / 2,
                             0.20 * _tone([span_chord[0] - 24], beat_sec / 2 * 0.9, attack=0.005, harmonics=(1.0, 0.3)))
        else:
            raise ValueError(f"未知の style: {style}")

    downbeat = float(beats[pickup_beats])
    return _finish(buf, rng, 0.0005), {
        "bpm": float(bpm),
        "beats_per_bar": per_bar,
        "beat_times": [float(t) for t in beats],
        "downbeat": downbeat,
        "bar_sec": float((end_sec - downbeat) / bars),
    }


# ── band_song の音色 ──────────────────────────────────────────


def _shaped(n, attack, decay):
    t = np.arange(n) / SR
    env = np.minimum(1.0, t / attack) * np.exp(-t * decay)
    fade = min(n, int(0.008 * SR))
    env[-fade:] *= np.linspace(1, 0, fade)
    return env


def _saw(notes, dur, attack=0.01, decay=0.6, detune=0.003):
    n = int(dur * SR)
    t = np.arange(n) / SR
    wave = np.zeros(n)
    for m in notes:
        for d in (-detune, detune):
            for h in range(1, 9):
                wave += np.sin(2 * np.pi * _hz(m) * (1 + d) * h * t) / h
    return wave / (2 * len(notes)) * _shaped(n, attack, decay)


def _epiano(notes, dur, decay=3.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    wave = np.zeros(n)
    for m in notes:
        f = _hz(m)
        wave += np.sin(2 * np.pi * f * t + 1.5 * np.exp(-t * 8) * np.sin(2 * np.pi * f * 2 * t))
    return wave / len(notes) * _shaped(n, 0.004, decay)


def _pluck_bass(midi, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = _hz(midi)
    wave = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2 * f * t) + 0.2 * np.sin(2 * np.pi * 3 * f * t)
    return wave * _shaped(n, 0.004, 5.0)


def _deep_kick(gain=0.8):
    n = int(0.18 * SR)
    t = np.arange(n) / SR
    return gain * np.sin(2 * np.pi * np.cumsum(50 + 110 * np.exp(-t * 35)) / SR) * np.exp(-t * 18)


def _tonal_snare(rng, gain=0.5):
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    return gain * (0.8 * rng.standard_normal(n) * np.exp(-t * 25) + 0.4 * np.sin(2 * np.pi * 220 * t) * np.exp(-t * 40))


def _clap(rng, gain=0.45):
    n = int(0.12 * SR)
    wave = np.zeros(n)
    for offset in (0.0, 0.011, 0.023):
        i = int(offset * SR)
        t = np.arange(n - i) / SR
        wave[i:] += rng.standard_normal(n - i) * np.exp(-t * 60)
    return gain * wave / 2


def _bright_hat(rng, gain=0.1, length=0.035):
    n = int(length * SR)
    t = np.arange(n) / SR
    noise = np.diff(np.diff(rng.standard_normal(n), prepend=0.0), prepend=0.0)
    return gain * noise * np.exp(-t * (5 / length)) / 2


def band_song(style, bpm=110.0, bars=16, lead_silence=0.0, progression="vi-IV-I-V", chord_bars=1,
              reverb=0.0, seed=1):
    """実際の曲に近いリズムの型の合成音源と、その正解を返す。

    Args:
        style (str): リズムの型（``BAND_STYLES``）。``waltz`` は 3 拍子、``five`` は 5 拍子、ほかは 4 拍子。
        bpm (float): テンポ。
        bars (int): 小節数。
        lead_silence (float): 曲頭の無音（秒）。
        progression (str): コード進行（``BAND_PROGRESSIONS`` のキー）。
        chord_bars (int): コード 1 つが続く小節数。
        reverb (float): 残響の量（0 で無し）。
        seed (int): 乱数の種。

    Returns:
        tuple[numpy.ndarray, dict]: ``basic_song`` と同じ形。
    """
    rng = np.random.default_rng(seed)
    per_bar = {"waltz": 3, "five": 5}.get(style, 4)
    beat = 60.0 / bpm
    bar_sec = beat * per_bar
    total = lead_silence + bars * bar_sec
    buf = np.zeros(int((total + 1.2) * SR))
    chords = BAND_PROGRESSIONS[progression]

    def bass_root(chord):
        return chord[0] - 24 if chord[0] - 24 >= 28 else chord[0] - 12

    for b in range(bars):
        chord = chords[(b // chord_bars) % len(chords)]
        following = chords[((b + 1) // chord_bars) % len(chords)]
        root = bass_root(chord)
        t0 = lead_silence + b * bar_sec

        def at(position):
            """小節頭から ``position`` 拍の位置（秒）。"""
            return t0 + position * beat

        if style == "rock":
            _add(buf, t0, 0.22 * _saw([chord[0] - 12, chord[0] - 5], bar_sec))
            for eighth in range(8):
                _add(buf, at(eighth / 2), 0.3 * _pluck_bass(root, beat / 2))
                _add(buf, at(eighth / 2), _bright_hat(rng))
            for position in (0, 2, 2.5):
                _add(buf, at(position), _deep_kick())
            for position in (1, 3):
                _add(buf, at(position), _tonal_snare(rng))
        elif style == "house":
            for k in range(4):
                _add(buf, at(k), _deep_kick())
                _add(buf, at(k + 0.5), _bright_hat(rng, 0.14, 0.09))
                _add(buf, at(k + 0.5), 0.28 * _pluck_bass(root, beat / 2))
            for position in (1, 3):
                _add(buf, at(position), _clap(rng))
            for position in (0, 1.5):
                _add(buf, at(position), 0.22 * _epiano(chord, beat))
        elif style == "shuffle":
            for k, interval in enumerate((0, 4, 7, 9)):
                _add(buf, at(k), 0.3 * _pluck_bass(root + interval, beat))
                _add(buf, at(k), _bright_hat(rng))
                _add(buf, at(k + 2 / 3), _bright_hat(rng, 0.07))
            for position in (0, 2):
                _add(buf, at(position), _deep_kick(0.6))
            for position in (1, 3):
                _add(buf, at(position), _tonal_snare(rng, 0.4))
                _add(buf, at(position), 0.18 * _epiano(chord, beat * 0.6, decay=6))
        elif style == "sixteenth":
            _add(buf, t0, 0.16 * _saw(chord, bar_sec, attack=0.03, decay=0.3))
            for sixteenth in range(16):
                _add(buf, at(sixteenth / 4), _bright_hat(rng, 0.11 if sixteenth % 4 == 0 else 0.06))
            for position in (0, 1.75, 2):
                _add(buf, at(position), _deep_kick())
            for position in (1, 3):
                _add(buf, at(position), _tonal_snare(rng))
            for position in (0, 1.75, 2.5):
                _add(buf, at(position), 0.3 * _pluck_bass(root, beat / 2))
        elif style == "ballad":
            _add(buf, t0, 0.3 * _pluck_bass(root, bar_sec))
            for eighth, index in enumerate((0, 2, 1, 2, 0, 2, 1, 2)):
                _add(buf, at(eighth / 2), 0.2 * _epiano([chord[index % len(chord)] + 12], beat * 0.9, decay=4))
            _add(buf, at(0), _deep_kick(0.45))
            _add(buf, at(2), 0.25 * _bright_hat(rng, 1.0, 0.02))
        elif style == "push":
            for eighth in range(8):
                current = following if eighth == 7 else chord
                _add(buf, at(eighth / 2), 0.3 * _pluck_bass(bass_root(current), beat / 2))
                _add(buf, at(eighth / 2), _bright_hat(rng))
            _add(buf, t0, 0.2 * _saw(chord, 3.5 * beat, decay=0.4))
            _add(buf, at(3.5), 0.2 * _saw(following, 0.5 * beat, decay=0.4))
            for position in (0, 2):
                _add(buf, at(position), _deep_kick())
            for position in (1, 3):
                _add(buf, at(position), _tonal_snare(rng))
        elif style == "melody":
            rhythm = ((0, 1.5), (1.5, 0.5), (2, 1), (3, 0.5), (3.5, 0.5))
            notes = (chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[1] + 12, chord[0] + 14)
            for (position, length), note in zip(rhythm, notes):
                _add(buf, at(position), 0.3 * _saw([note], length * beat * 0.95, decay=1.5))
        elif style == "strum":
            for k in range(4):
                _add(buf, at(k), 0.3 * _saw(chord + [chord[0] + 12], beat * 0.5, attack=0.012, decay=5))
                _add(buf, at(k + 0.5), 0.18 * _saw(chord[1:] + [chord[0] + 12], beat * 0.5, attack=0.012, decay=7))
        elif style == "waltz":
            _add(buf, at(0), 0.35 * _pluck_bass(root, beat))
            for position in (1, 2):
                _add(buf, at(position), 0.2 * _epiano(chord, beat * 0.8, decay=6))
        elif style == "five":
            for position in (0, 3):
                _add(buf, at(position), 0.35 * _pluck_bass(root, beat))
                _add(buf, at(position), _deep_kick(0.5))
            for position in (1, 2, 4):
                _add(buf, at(position), 0.2 * _epiano(chord, beat * 0.8, decay=6))
            for k in range(5):
                _add(buf, at(k), _bright_hat(rng))
        else:
            raise ValueError(f"未知の style: {style}")

    if reverb > 0:
        n = int(0.5 * SR)
        impulse = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 9)
        impulse /= np.sqrt(np.sum(impulse ** 2))
        buf = buf + reverb * np.convolve(buf, impulse)[:len(buf)]

    return _finish(buf, rng, 0.001), {
        "bpm": float(bpm),
        "beats_per_bar": per_bar,
        "beat_times": [lead_silence + k * beat for k in range(bars * per_bar)],
        "downbeat": float(lead_silence),
        "bar_sec": bar_sec,
    }


# ── 書き出しと誤差 ────────────────────────────────────────────


def make_song(kind, **kwargs):
    """``kind`` が ``"basic"`` なら ``basic_song``、``"band"`` なら ``band_song`` を呼ぶ。"""
    return basic_song(**kwargs) if kind == "basic" else band_song(**kwargs)


def write_song(path, kind, **kwargs):
    """合成音源を WAV に書き、正解を返す。"""
    import soundfile as sf

    audio, truth = make_song(kind, **kwargs)
    sf.write(str(path), audio, SR)
    return truth


def grid_errors(grid, truth):
    """推定したグリッドと正解の誤差を出す。

    Args:
        grid (dict): ``structure.estimate_grid`` の返り値。
        truth (dict): ``basic_song`` / ``band_song`` が返した正解。

    Returns:
        dict:
            ``bpm_ratio``: 推定 BPM / 正解 BPM（1.0 が正解、2.0 は倍、0.5 は半分）。
            ``beat_err_ms``: 推定した各拍から最寄りの正解の拍までの距離の中央値（ミリ秒）。
            ``downbeat_err_beats``: 1 拍目の位置のずれ（拍数、0 〜 拍子-1。0 が正解）。
            小節の整数倍のずれは同じ位置とみなす（無音の前置きへグリッドを延ばすのは仕様）。
            ``downbeat_err_ms``: 1 拍目の位置から最寄りの正解の小節頭までの距離（ミリ秒）。
    """
    true_beats = np.asarray(truth["beat_times"])
    beat_sec = 60.0 / truth["bpm"]
    per_bar = truth["beats_per_bar"]
    estimated = np.asarray(grid["beat_times_sec"], dtype=float)

    inside = estimated[(estimated >= true_beats[0] - beat_sec / 2) & (estimated <= true_beats[-1] + beat_sec / 2)]
    if len(inside):
        beat_err_ms = float(np.median(np.abs(inside[:, None] - true_beats[None, :]).min(axis=1)) * 1000)
    else:
        beat_err_ms = float("nan")

    # 正解の小節頭の列。曲の前にも等間隔で延ばす（前置きの無音へ延ばされたグリッドも測れるように）
    first = int(np.argmin(np.abs(true_beats - truth["downbeat"])))
    heads = list(true_beats[first::per_bar])
    earlier = truth["downbeat"] - truth["bar_sec"]
    while earlier > -truth["bar_sec"]:
        heads.insert(0, earlier)
        earlier -= truth["bar_sec"]
    heads = np.asarray(heads)
    offset = float(grid["downbeat_offset_sec"])
    nearest = float(heads[int(np.argmin(np.abs(heads - offset)))])

    return {
        "bpm_ratio": float(grid["bpm"] / truth["bpm"]),
        "beat_err_ms": beat_err_ms,
        "downbeat_err_beats": int(round((offset - nearest) / beat_sec)) % per_bar,
        "downbeat_err_ms": float((offset - nearest) * 1000),
    }


def judge(errors):
    """誤差を「テンポ」「拍の位置」「1 拍目の位置」の合否にする。

    Args:
        errors (dict): ``grid_errors`` の返り値。

    Returns:
        tuple[str, bool, bool]: ``(tempo, beats_ok, downbeat_ok)``。
        ``tempo`` は ``"ok"``（±2%） / ``"x2"`` / ``"x0.5"`` / ``"other"``。
        ``beats_ok`` はテンポが合っていて拍の位置の誤差が 35ms 以内、
        ``downbeat_ok`` はさらに 1 拍目が正しい拍に在って 60ms 以内。
    """
    ratio = errors["bpm_ratio"]
    if abs(ratio - 1) <= 0.02:
        tempo = "ok"
    elif abs(ratio - 2) <= 0.04:
        tempo = "x2"
    elif abs(ratio - 0.5) <= 0.01:
        tempo = "x0.5"
    else:
        tempo = "other"
    beats_ok = tempo == "ok" and errors["beat_err_ms"] <= 35
    downbeat_ok = beats_ok and errors["downbeat_err_beats"] == 0 and abs(errors["downbeat_err_ms"]) <= 60
    return tempo, beats_ok, downbeat_ok


# ── 材料の一覧 ────────────────────────────────────────────────


def design_cases():
    """推定の作りを決めるのに使った組（``basic_song`` の 85 件）。

    Returns:
        list[tuple[str, str, dict]]: ``(名前, kind, 引数)`` のリスト。
    """
    cases = []

    def add(name, **kwargs):
        cases.append((name, "basic", kwargs))

    # 利用者が報告した 2 つの材料
    add("report1 click_chords 120 16bars", style="click_chords", bpm=120, bars=16)
    add("report2 sine_notes 120 4bars", style="sine_notes", bpm=120, bars=4)
    # テンポを変える（倍・半分の取り違えが出やすい端も含む）
    for style in ("click_chords", "piano_chords", "band", "arpeggio"):
        for bpm in (70, 90, 100, 128, 140, 160, 174):
            add(f"tempo {style} {bpm}", style=style, bpm=bpm, bars=16)
    # 無音の前置きを変える
    for style in ("click_chords", "band", "piano_chords"):
        for lead in (0.35, 0.8, 1.3, 2.5):
            add(f"lead {style} 120 lead{lead}", style=style, bpm=120, bars=16, lead_silence=lead)
        add(f"lead {style} 96 lead0.6", style=style, bpm=96, bars=16, lead_silence=0.6)
    # 3 拍子
    for style in ("click_chords", "piano_chords", "band", "arpeggio"):
        for bpm in (90, 120, 150):
            add(f"meter3 {style} {bpm}", style=style, bpm=bpm, bars=16, beats_per_bar=3)
        add(f"meter3 {style} 120 lead0.5", style=style, bpm=120, bars=16, beats_per_bar=3, lead_silence=0.5)
    # 材料の種類
    for style in ("pad_chords", "sine_notes", "drums", "band_2chords", "band_backbeat"):
        for bpm in (100, 120):
            add(f"style {style} {bpm}", style=style, bpm=bpm, bars=16)
    # 弱起
    for style in ("click_chords", "band", "piano_chords"):
        add(f"pickup1 {style} 120", style=style, bpm=120, bars=16, pickup_beats=1)
        add(f"pickup2 {style} 100 lead0.3", style=style, bpm=100, bars=16, pickup_beats=2, lead_silence=0.3)
    # テンポの揺れ
    for style in ("click_chords", "band"):
        add(f"drift2% {style} 120", style=style, bpm=120, bars=16, drift=0.02)
    # 短い曲
    for style in ("click_chords", "band", "piano_chords"):
        add(f"short {style} 120 4bars", style=style, bpm=120, bars=4)
        add(f"short {style} 120 8bars", style=style, bpm=120, bars=8)
    return cases


def holdout_cases():
    """作りを決めた後で初めて当てた組（``band_song`` の 32 件）。

    1 回目の結果を見て、手がかりの計算（コードの変わり目を半小節の幅で見る、端の拍の補修）を
    直すのに使った。その意味で、完全に手つかずの組ではない。

    Returns:
        list[tuple[str, str, dict]]: ``(名前, kind, 引数)`` のリスト。
    """
    tempos = {"rock": (97, 133, 168), "house": (111, 124, 128), "shuffle": (83, 111, 147),
              "sixteenth": (83, 97, 111), "ballad": (66, 76), "push": (97, 111, 133),
              "melody": (97, 133), "strum": (83, 97, 111, 133), "waltz": (97, 133, 168), "five": (111, 147)}
    progressions = list(BAND_PROGRESSIONS)
    cases = []
    index = 0
    for style, bpms in tempos.items():
        for bpm in bpms:
            index += 1
            kwargs = dict(style=style, bpm=bpm, bars=16, seed=index, progression=progressions[index % 3],
                          lead_silence=(0.0, 0.27, 0.0, 0.9)[index % 4], reverb=(0.0, 0.25)[index % 2])
            if style == "house":
                kwargs["chord_bars"] = 2
            cases.append((f"{style} {bpm} lead{kwargs['lead_silence']} rev{kwargs['reverb']}", "band", kwargs))
    cases.append(("rock 122 chord2bars", "band", dict(style="rock", bpm=122, bars=16, chord_bars=2, seed=91)))
    cases.append(("push 104 rev0.5", "band", dict(style="push", bpm=104, bars=16, reverb=0.5, seed=92)))
    cases.append(("rock 118 6bars", "band", dict(style="rock", bpm=118, bars=6, seed=93, lead_silence=0.4)))
    cases.append(("shuffle 126 8bars", "band", dict(style="shuffle", bpm=126, bars=8, seed=94)))
    return cases


def final_cases():
    """最後の確認用の組（両方の系統から、乱数で引いた 40 件）。

    推定の作りと定数を固めた後で初めて当てた。この組の結果を見て直したものは無い。

    Returns:
        list[tuple[str, str, dict]]: ``(名前, kind, 引数)`` のリスト。
    """
    rng = np.random.default_rng(2026)
    cases = []
    for i in range(20):
        style = BASIC_STYLES[i % len(BASIC_STYLES)]
        kwargs = dict(
            style=style, bpm=float(np.round(rng.uniform(75, 170), 1)), bars=int(rng.choice([8, 12, 16, 24])),
            lead_silence=float(np.round(rng.choice([0.0, rng.uniform(0.1, 1.5)]), 2)),
            pickup_beats=int(rng.choice([0, 0, 1])), seed=1000 + i,
            beats_per_bar=int(rng.choice([4, 4, 4, 3])) if style != "band_2chords" else 4,
        )
        name = (f"{style} {kwargs['bpm']} {kwargs['beats_per_bar']}拍子 lead{kwargs['lead_silence']} "
                f"pickup{kwargs['pickup_beats']} {kwargs['bars']}bars")
        cases.append((name, "basic", kwargs))
    progressions = list(BAND_PROGRESSIONS)
    for i in range(20):
        style = BAND_STYLES[i % len(BAND_STYLES)]
        kwargs = dict(
            style=style, bpm=float(np.round(rng.uniform(75, 170), 1)), bars=int(rng.choice([8, 12, 16, 24])),
            lead_silence=float(np.round(rng.choice([0.0, rng.uniform(0.1, 1.5)]), 2)),
            reverb=float(np.round(rng.uniform(0, 0.4), 2)), progression=str(rng.choice(progressions)),
            chord_bars=int(rng.choice([1, 1, 2])), seed=2000 + i,
        )
        name = (f"{style} {kwargs['bpm']} lead{kwargs['lead_silence']} rev{kwargs['reverb']} "
                f"chord{kwargs['chord_bars']}bars {kwargs['bars']}bars")
        cases.append((name, "band", kwargs))
    return cases
