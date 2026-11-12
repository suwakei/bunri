"""decompose モジュールのテスト"""
import numpy as np
import pytest
from pathlib import Path
import sys
import os

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "backend"))


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


class TestSecondsToStep:
    """ステップ 0 は 1 小節目の 1 拍目（楽曲カルテの 1 拍目の位置）"""

    def test_位置を0からのステップに丸める(self):
        from decompose import seconds_to_step
        # 120 BPM の 16 分音符は 0.125 秒
        assert seconds_to_step(0.0, 0.125) == 0
        assert seconds_to_step(1.0, 0.125) == 8
        assert seconds_to_step(1.06, 0.125) == 8

    def test_1小節目の位置からのステップにする(self):
        from decompose import seconds_to_step
        assert seconds_to_step(0.75, 0.125, offset_sec=0.75) == 0
        assert seconds_to_step(2.75, 0.125, offset_sec=0.75) == 16

    def test_1小節目より前の音は置かない(self):
        from decompose import seconds_to_step
        assert seconds_to_step(0.5, 0.125, offset_sec=0.75) is None
        # 半ステップ未満の手前は、1 小節目の頭に丸める
        assert seconds_to_step(0.70, 0.125, offset_sec=0.75) == 0


def _write_tone(path, starts, dur, midi=69, total=8.0, sr=22050):
    """``starts`` の各位置（秒）から ``dur`` 秒だけ鳴る音（倍音つき）の WAV を書く。"""
    import soundfile as sf
    data = np.zeros(int(total * sr), dtype=np.float32)
    freq = 440.0 * 2 ** ((midi - 69) / 12)
    n = int(dur * sr)
    t = np.arange(n) / sr
    env = np.minimum(1.0, np.minimum(np.arange(n), n - np.arange(n)) / 200.0)
    for start in starts:
        i = int(start * sr)
        wave = sum(a * np.sin(2 * np.pi * freq * k * t) for k, a in ((1, 0.4), (2, 0.2), (3, 0.1)))
        data[i:i + n] += (wave * env).astype(np.float32)
    sf.write(str(path), data, sr)


class TestChartAndPianoRollBars:
    """楽曲カルテの小節と、ピアノロールの小節が、同じ時刻を指す（1 拍目が 0 秒に無い曲）

    カルテは実測のビートと 1 拍目の位置で小節を数える。採譜（パート分離のお手本）は、以前は 0 秒から
    数えていたので、1 拍目が 0.75 秒の曲では「カルテの 3 小節」と「ピアノロールの 3 小節」がずれていた。
    いまは画面がカルテのテンポと 1 拍目の位置を渡し、採譜はそこからステップを数える。
    """

    def test_カルテの3小節目の頭で鳴る音は_ピアノロールでも3小節目の頭に置かれる(self, tmp_path):
        import sys as _sys
        _sys.path.insert(0, str(Path(__file__).resolve().parent))
        import grid_materials
        import structure
        from decompose import _transcribe_stft

        # 曲頭に 0.75 秒の無音がある、120 BPM・4/4 の曲 (1 拍目は 0.75 秒)
        song = tmp_path / "song.wav"
        truth = grid_materials.write_song(song, "basic", bpm=120.0, lead_silence=0.75, bars=8, style="piano_chords")
        grid = structure.estimate_grid(str(song))
        assert abs(grid["downbeat_offset_sec"] - truth["downbeat"]) < 0.06
        assert grid["downbeat_offset_sec"] > 0.5

        # カルテの 3 小節目の頭 (ビート列の 9 番目) から 1 拍鳴る、パートの音
        per_bar = grid["time_signature"][0]
        bar3 = grid["beat_times_sec"][2 * per_bar]
        part = tmp_path / "part.wav"
        _write_tone(part, [bar3], 0.5, total=truth["downbeat"] + 8 * 2.0 + 1)

        notes = _transcribe_stft(str(part), bpm=grid["bpm"], sensitivity=0.7,
                                 offset_sec=grid["downbeat_offset_sec"])
        assert notes, "音が採譜されていない"
        first = min(n["step"] for n in notes)
        steps_per_bar = per_bar * 4
        # ピアノロールの小節番号 (ステップ // 1 小節のステップ数 + 1) がカルテと同じ 3 で、拍の頭に在る
        assert first // steps_per_bar + 1 == 3
        assert first == 2 * steps_per_bar

        # 以前の数え方 (0 秒から) だと、同じ音が 3 小節目の頭からずれる
        old = _transcribe_stft(str(part), bpm=round(grid["bpm"]), sensitivity=0.7)
        assert min(n["step"] for n in old) != 2 * steps_per_bar
