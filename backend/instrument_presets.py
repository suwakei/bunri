"""内蔵の16bitゲーム風音色と、録音した声を重ねた合唱用パッチを用意する。"""
import math
import re
import wave
from pathlib import Path


GAME_PRESETS = (
    "game-lead", "game-square", "game-triangle", "game-saw", "game-flute",
    "game-strings", "game-brass", "game-pad", "game-bass", "game-pluck",
    "game-bell", "game-organ", "game-voice", "game-piano", "game-drums",
)
_ROOTS = (24, 36, 48, 60, 72, 84, 96, 108)
_RATE = 32000


def _check(job):
    """生成途中でも中止できるようにする。"""
    if job is not None:
        job.check_cancelled()


def _write_wave(path, signal, sample_rate):
    """モノラル16bitの波形を、エンジンが読む素材として保存する。"""
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    samples = np.asarray(signal, dtype=np.float64)
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 0:
        samples = samples * (0.65 / peak)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(np.round(samples * 32767).astype("<i2").tobytes())


def _cycle(preset, root, highest_key):
    """繰り返しの境界が一致し、担当音域で折り返しにくい波形を作る。"""
    import numpy as np

    frequency = 440 * 2 ** ((root - 69) / 12)
    period = max(4, round(_RATE / frequency))
    actual = _RATE / period
    phase = np.arange(period, dtype=np.float64) * (2 * np.pi / period)
    # 音域ごとに倍音を減らす。移調先のいちばん高い音でもナイキストを越えない。
    highest_frequency = 440 * 2 ** ((highest_key - 69) / 12)
    harmonics = max(1, min(64, int(min(6000, _RATE * 0.42) / highest_frequency)))
    signal = np.zeros(period, dtype=np.float64)
    for harmonic in range(1, harmonics + 1):
        angle = phase * harmonic
        if preset == "game-triangle":
            weight = ((-1) ** ((harmonic - 1) // 2)) / harmonic ** 2 if harmonic % 2 else 0
        elif preset in ("game-square", "game-lead", "game-bass"):
            duty = {"game-square": 0.5, "game-lead": 0.25, "game-bass": 0.125}[preset]
            signal += np.cos(angle - np.pi * harmonic * duty) * math.sin(np.pi * harmonic * duty) / harmonic
            continue
        elif preset == "game-saw":
            weight = (-1) ** (harmonic + 1) / harmonic
        elif preset == "game-flute":
            weight = {1: 1, 2: 0.12, 3: 0.04}.get(harmonic, 0)
        elif preset == "game-organ":
            weight = {1: 1, 2: 0.5, 3: 0.35, 4: 0.25, 6: 0.12, 8: 0.08}.get(harmonic, 0)
        elif preset == "game-piano":
            weight = {1: 1, 2: 0.5, 3: 0.18, 4: 0.27, 7: 0.1}.get(harmonic, 0)
        elif preset == "game-bell":
            weight = {1: 1, 2: 0.1, 3: 0.6, 7: 0.45, 11: 0.24}.get(harmonic, 0)
        elif preset == "game-voice":
            hz = frequency * harmonic
            weight = (0.12 if harmonic == 1 else 0) + sum(
                strength * math.exp(-0.5 * ((hz - center) / width) ** 2)
                for center, width, strength in ((800, 180, 1), (1150, 220, 0.6), (2900, 500, 0.22))
            ) / harmonic
        elif preset == "game-pad":
            weight = (1 if harmonic == 1 else 0.45 / harmonic ** 1.6) if harmonic % 2 else 0.08 / harmonic
        elif preset == "game-pluck":
            weight = 1 / harmonic ** 1.3
        elif preset == "game-brass":
            weight = math.exp(-harmonic / 10) / harmonic ** 0.7
        else:  # 弦のような、少し丸いのこぎり波。
            weight = (-1) ** (harmonic + 1) / harmonic ** 1.25
        signal += np.sin(angle) * weight
    signal -= np.mean(signal)
    # 整数周期を使ったぶんの微小なずれを SFZ で補正する。
    tune = 1200 * math.log2(frequency / actual)
    return np.tile(signal, 8), tune


def _melodic(folder, preset, job):
    """音域別のループ素材と、音色ごとの音量包絡を用意する。"""
    envelopes = {
        "game-strings": (0.08, 0.2, 85, 0.4), "game-pad": (0.2, 0.5, 80, 0.7),
        "game-brass": (0.025, 0.15, 85, 0.15), "game-flute": (0.02, 0.1, 90, 0.15),
        "game-pluck": (0.002, 0.5, 12, 0.12), "game-bell": (0.002, 1.2, 3, 0.8),
        "game-piano": (0.002, 0.7, 20, 0.2), "game-bass": (0.004, 0.2, 70, 0.08),
        "game-voice": (0.08, 0.3, 85, 0.35),
    }
    attack, decay, sustain, release = envelopes.get(preset, (0.004, 0.12, 85, 0.1))
    parts = ["// bunri の16bitゲーム風音色。特定のゲームの録音は使用していません。",
             f"<global> amp_veltrack=100 ampeg_attack={attack} ampeg_decay={decay} "
             f"ampeg_sustain={sustain} ampeg_release={release}"]
    stereo = preset in ("game-strings", "game-pad", "game-voice")
    for index, root in enumerate(_ROOTS):
        _check(job)
        low = 0 if index == 0 else root - 5
        high = 127 if index == len(_ROOTS) - 1 else root + 6
        signal, tune = _cycle(preset, root, high)
        filename = f"Samples/{preset}-{root}.wav"
        _write_wave(folder / filename, signal, _RATE)
        for detune, pan in ((-5, -40), (5, 40)) if stereo else ((0, 0),):
            parts.append(f"<region> sample={filename} lokey={low} hikey={high} "
                         f"pitch_keycenter={root} tune={tune + detune:.8f} pan={pan} "
                         f"volume={-6 if stereo else 0} loop_mode=loop_continuous "
                         f"loop_start=0 loop_end={len(signal) - 1}")
    (folder / f"{preset}.sfz").write_text("\n".join(parts) + "\n", encoding="utf-8")


def _drums(folder, job):
    """電子ドラムを GM の打楽器の高さに配置する。"""
    import numpy as np

    rate = 16000
    parts = ["// bunri の16bitゲーム風ドラム。", "<global> amp_veltrack=100"]
    for pitch in range(35, 82):
        _check(job)
        length = 0.7 if pitch in (46, 49, 51, 52, 55, 57, 59) else 0.35
        time = np.arange(round(rate * length), dtype=np.float64) / rate
        noise = np.random.default_rng(41000 + pitch).uniform(-1, 1, time.size)
        bright = np.concatenate(([0], np.diff(noise)))
        if pitch in (35, 36):
            frequency = 42 + 110 * np.exp(-time * 40)
            signal = np.sin(2 * np.pi * np.cumsum(frequency) / rate) * np.exp(-time * 15)
        elif pitch in (38, 40):
            signal = (0.7 * bright + 0.3 * np.sin(2 * np.pi * 175 * time)) * np.exp(-time * 20)
        elif pitch in (41, 43, 45, 47, 48, 50):
            frequency = 65 + (pitch - 41) * 14 + 45 * np.exp(-time * 25)
            signal = (np.sin(2 * np.pi * np.cumsum(frequency) / rate) + noise * 0.07) * np.exp(-time * 15)
        elif pitch in (42, 44, 46):
            signal = bright * np.exp(-time * (9 if pitch == 46 else 65))
        elif pitch in (49, 51, 52, 53, 55, 57, 59):
            metal = sum(np.sin(2 * np.pi * hz * time) for hz in (321, 544, 901, 1237, 2401)) / 5
            signal = (bright + metal * 0.2) * np.exp(-time * 7)
        else:
            signal = (0.5 * noise + np.sin(2 * np.pi * (180 + pitch * 6) * time)) * np.exp(-time * 30)
        signal *= np.minimum(1, time / 0.001)
        filename = f"Samples/game-drums-{pitch}.wav"
        _write_wave(folder / filename, signal, rate)
        choke = " group=1 off_by=1" if pitch in (42, 44, 46) else ""
        parts.append(f"<region> sample={filename} key={pitch} loop_mode=one_shot{choke}")
    (folder / "game-drums.sfz").write_text("\n".join(parts) + "\n", encoding="utf-8")


def _game_pack(folder, job):
    """ゲーム風音色一式を生成する。外部への通信は行わない。"""
    folder.mkdir(parents=True, exist_ok=True)
    for index, preset in enumerate(GAME_PRESETS):
        _check(job)
        if preset == "game-drums":
            _drums(folder, job)
        else:
            _melodic(folder, preset, job)
        if job is not None:
            job.set_progress((index + 1) / len(GAME_PRESETS))
    (folder / "LICENSE").write_text(
        "bunri 内蔵ゲーム風音色\n作者: bunri\n"
        "このフォルダの生成した音色・録音素材を CC0 1.0 Universal で提供します。\n"
        "https://creativecommons.org/publicdomain/zero/1.0/\n", encoding="utf-8")


def _choir(folder, job):
    """単独の男声をわずかにずらして重ねる。合唱団の録音ではない。"""
    programs = folder / "Programs"
    original = programs / "01-no_legato_polyphonic_only_no_vibrato_a.sfz"
    if not original.is_file():
        raise ValueError("コーラスの元になる声の素材がありません")
    source = original.read_text(encoding="utf-8")
    control, rest = source.split("<global>", 1)
    global_settings = rest.split("<master>", 1)[0]
    regions = "\n".join((programs / "modules" / name).read_text(encoding="utf-8")
                        for name in ("vowel_sustain_a.sfz", "vowel_sustain_a_lows.sfz"))
    result = ["// Hadzi-Fia の単独声を重ねたコーラス（CC0 素材の派生パッチ）。", control,
              "<global>", global_settings]
    for index, (detune, pan) in enumerate(((-9, -65), (-5, -38), (-1, -12), (2, 15), (6, 42), (10, 68))):
        _check(job)
        # 元の録音の調律補正を保ち、それぞれの声を少しずらす。
        shifted = re.sub(r"(?m)^tune=(-?[\d.]+)[ \t]*$",
                         lambda match: f"tune={float(match[1]) + detune:g}", regions)
        name = f"bunri-choir-layer-{index}.sfz"
        (programs / name).write_text(shifted, encoding="utf-8")
        result.append(f'<master> tune={detune} pan={pan} volume=-16 offset_random=0.012\n#include "{name}"')
    result.append('#include "modules/controls/curves.sfz"')
    (programs / "bunri-choir-a.sfz").write_text("\n".join(result) + "\n", encoding="utf-8")


def _repair_vcsl(folder, job):
    """固定版にあるプサルテリウムの3入口を、実際の素材の置き場へ合わせる。"""
    base = folder / "Chordophones" / "Zithers"
    if not (base / "Harpsichord, Italian" / "Psaltery, Bowed and Plucked").is_dir():
        raise ValueError("プサルテリウムの録音素材がありません")
    for articulation in ("LongBow", "Pluck", "Spiccato"):
        _check(job)
        path = base / f"Psaltery, Bowed and Plucked - {articulation}.sfz"
        source = path.read_text(encoding="utf-8")
        # 参照だけを直し、元の音色定義もそばに残す。音声自体は書き換えない。
        backup = path.with_suffix(".sfz.original")
        if not backup.exists():
            backup.write_text(source, encoding="utf-8")
        path.write_text(source.replace(
            "sample=Psaltery, Bowed and Plucked/",
            "sample=Harpsichord, Italian/Psaltery, Bowed and Plucked/"), encoding="utf-8")


def prepare_pack(pack_id: str, folder: Path, job=None):
    """取得済み素材の派生パッチ、または内蔵音色を公開前に用意する。"""
    folder = Path(folder)
    if pack_id == "game":
        _game_pack(folder, job)
    elif pack_id == "voice":
        _choir(folder, job)
    elif pack_id == "vcsl":
        _repair_vcsl(folder, job)
