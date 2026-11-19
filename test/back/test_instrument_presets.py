"""内蔵音色の波形、ループ、声の派生パッチを確かめる。"""
import wave

import numpy as np
import pytest

from background_jobs import JobCancelled
from instrument_presets import GAME_PRESETS, prepare_pack


def _samples(path):
    """検査用に、生成した16bitモノラル波形を読む。"""
    with wave.open(str(path), "rb") as source:
        assert source.getnchannels() == 1
        assert source.getsampwidth() == 2
        return source.getframerate(), np.frombuffer(source.readframes(source.getnframes()), dtype="<i2") / 32768


def test_ゲーム音色は全種類の素材と鍵盤範囲を持ち無音ではない(tmp_path):
    prepare_pack("game", tmp_path)
    assert (tmp_path / "LICENSE").is_file()
    assert {path.stem for path in tmp_path.glob("*.sfz")} == set(GAME_PRESETS)
    for preset in GAME_PRESETS:
        if preset == "game-drums":
            continue
        text = (tmp_path / f"{preset}.sfz").read_text()
        assert "lokey=0 " in text and "hikey=127 " in text
        rate, signal = _samples(tmp_path / "Samples" / f"{preset}-60.wav")
        assert rate == 32000
        assert 0.6 < np.max(np.abs(signal)) < 0.7
        assert abs(np.mean(signal)) < 1e-3
        # サンプルの先頭とループ先は同じ整数周期で、継ぎ目の波形が変わらない。
        period = len(signal) // 8
        np.testing.assert_array_equal(signal[:period], signal[period:period * 2])
    square = _samples(tmp_path / "Samples/game-square-60.wav")[1]
    flute = _samples(tmp_path / "Samples/game-flute-60.wav")[1]
    assert np.sqrt(np.mean((square - flute) ** 2)) > 0.15
    drums = (tmp_path / "game-drums.sfz").read_text()
    assert "key=36 " in drums and "key=81 " in drums
    assert "group=1 off_by=1" in drums
    rate, kick = _samples(tmp_path / "Samples/game-drums-36.wav")
    _, hat = _samples(tmp_path / "Samples/game-drums-42.wav")
    assert rate == 16000 and kick[0] == 0 and hat[0] == 0
    assert np.sqrt(np.mean((kick - hat) ** 2)) > 0.1


def test_ゲーム音色の生成途中で中止できる(tmp_path):
    class Cancel:
        checks = 0

        def check_cancelled(self):
            self.checks += 1
            if self.checks > 3:
                raise JobCancelled()

    with pytest.raises(JobCancelled):
        prepare_pack("game", tmp_path, Cancel())
    assert not (tmp_path / "LICENSE").exists()


def test_声を重ねても元の調律補正と音域と参照先を保つ(tmp_path):
    programs = tmp_path / "Programs"
    modules = programs / "modules"
    modules.mkdir(parents=True)
    (programs / "01-no_legato_polyphonic_only_no_vibrato_a.sfz").write_text(
        '<control> set_cc1=63\n<global> ampeg_release=0.2\n<master>\n')
    (modules / "vowel_sustain_a.sfz").write_text(
        '<region>\nsample=../Samples/a.wav\ntune=25\nlokey=57\nhikey=57\n')
    (modules / "vowel_sustain_a_lows.sfz").write_text(
        '<region>\nsample=../Samples/low.wav\nlokey=50\nhikey=50\n')
    prepare_pack("voice", tmp_path)
    original = (modules / "vowel_sustain_a.sfz").read_text()
    assert "tune=25\n" in original
    first = (programs / "bunri-choir-layer-0.sfz").read_text()
    assert "tune=16\nlokey=57\n" in first
    assert "sample=../Samples/low.wav\n" in first
    choir = (programs / "bunri-choir-a.sfz").read_text()
    assert choir.count("<master>") == 6
    assert "合唱団" not in choir  # 合唱団の録音だとは表示しない。
    assert "単独声を重ねた" in choir


def test_配布元のプサルテリウムの参照だけを修正し元定義を残す(tmp_path):
    base = tmp_path / "Chordophones/Zithers"
    (base / "Harpsichord, Italian/Psaltery, Bowed and Plucked").mkdir(parents=True)
    original = '<region>\nsample=Psaltery, Bowed and Plucked/LongBow/a.wav\nkey=60\n'
    for kind in ("LongBow", "Pluck", "Spiccato"):
        (base / f"Psaltery, Bowed and Plucked - {kind}.sfz").write_text(original)
    prepare_pack("vcsl", tmp_path)
    prepare_pack("vcsl", tmp_path)  # 繰り返しても、参照に同じフォルダ名を重ねない。
    for kind in ("LongBow", "Pluck", "Spiccato"):
        path = base / f"Psaltery, Bowed and Plucked - {kind}.sfz"
        assert "sample=Harpsichord, Italian/Psaltery" in path.read_text()
        assert path.with_suffix(".sfz.original").read_text() == original
