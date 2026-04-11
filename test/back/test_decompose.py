"""decompose モジュールのテスト"""
import numpy as np
import pytest
from pathlib import Path
import sys
import os

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture
def test_wav(tmp_path):
    """テスト用WAVファイル（440Hz + 880Hz のポリフォニック）"""
    import soundfile as sf
    sr = 22050
    t = np.linspace(0, 1, sr, dtype=np.float32)
    # 2音同時: A4(440Hz) + A5(880Hz)
    data = 0.3 * np.sin(2 * np.pi * 440 * t) + 0.2 * np.sin(2 * np.pi * 880 * t)
    path = tmp_path / "test_poly.wav"
    sf.write(str(path), data, sr)
    return str(path)


@pytest.fixture
def drum_wav(tmp_path):
    """テスト用ドラムWAV（インパルス列）"""
    import soundfile as sf
    sr = 22050
    data = np.zeros(sr, dtype=np.float32)
    # 4つのインパルス（キック風の低周波）
    for i in range(4):
        pos = int(i * sr / 4)
        burst = np.exp(-np.linspace(0, 10, 200)) * 0.5
        burst *= np.sin(2 * np.pi * 80 * np.linspace(0, 200/sr, 200))
        data[pos:pos+200] += burst.astype(np.float32)
    path = tmp_path / "test_drums.wav"
    sf.write(str(path), data, sr)
    return str(path)


class TestTranscribePolyphonic:
    def test_ノートが検出される(self, test_wav):
        from decompose import transcribe_polyphonic
        notes = transcribe_polyphonic(test_wav, bpm=120, sensitivity=0.7)
        assert len(notes) > 0

    def test_ノートにはnote_octave_step_lengthがある(self, test_wav):
        from decompose import transcribe_polyphonic
        notes = transcribe_polyphonic(test_wav, bpm=120, sensitivity=0.7)
        if len(notes) > 0:
            n = notes[0]
            assert "note" in n
            assert "octave" in n
            assert "step" in n
            assert "length" in n
            assert "velocity" in n

    def test_感度が高いほどノートが多い(self, test_wav):
        from decompose import transcribe_polyphonic
        notes_low = transcribe_polyphonic(test_wav, bpm=120, sensitivity=0.3)
        notes_high = transcribe_polyphonic(test_wav, bpm=120, sensitivity=0.9)
        assert len(notes_high) >= len(notes_low)


class TestTranscribeDrums:
    def test_ドラムイベントが検出される(self, drum_wav):
        from decompose import transcribe_drums
        events = transcribe_drums(drum_wav, bpm=120, sensitivity=0.7)
        assert len(events) > 0

    def test_イベントにはtype_step_velocityがある(self, drum_wav):
        from decompose import transcribe_drums
        events = transcribe_drums(drum_wav, bpm=120, sensitivity=0.7)
        if len(events) > 0:
            e = events[0]
            assert "type" in e
            assert e["type"] in ("kick", "snare", "hihat")
            assert "step" in e
            assert "velocity" in e


class TestEstimateMixParams:
    def test_パラメータが返される(self, test_wav):
        from decompose import estimate_mix_params
        params = estimate_mix_params(test_wav)
        assert "volume_db" in params
        assert "pan" in params
        assert "reverb_wet" in params
        assert isinstance(params["volume_db"], float)
        assert -100 < params["volume_db"] < 10

    def test_パンは範囲内(self, test_wav):
        from decompose import estimate_mix_params
        params = estimate_mix_params(test_wav)
        assert -1.0 <= params["pan"] <= 1.0


class TestFreqToMidi:
    def test_440Hzは69(self):
        from decompose import _freq_to_midi
        assert _freq_to_midi(440) == 69

    def test_0以下はNone(self):
        from decompose import _freq_to_midi
        assert _freq_to_midi(0) is None
        assert _freq_to_midi(-1) is None


class TestMidiToNote:
    def test_69はA4(self):
        from decompose import _midi_to_note
        note, octave = _midi_to_note(69)
        assert note == "A"
        assert octave == 4

    def test_60はC4(self):
        from decompose import _midi_to_note
        note, octave = _midi_to_note(60)
        assert note == "C"
        assert octave == 4
