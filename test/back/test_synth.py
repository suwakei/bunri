"""synth モジュールのテスト"""
import pytest
from pathlib import Path
from audio_utils import load_audio


class TestNoteToFreq:
    def test_A4は440Hz(self):
        from synth import note_to_freq
        assert note_to_freq('A', 4) == pytest.approx(440.0, rel=1e-3)

    def test_A5は880Hz(self):
        from synth import note_to_freq
        assert note_to_freq('A', 5) == pytest.approx(880.0, rel=1e-3)

    def test_C4は約261Hz(self):
        from synth import note_to_freq
        assert note_to_freq('C', 4) == pytest.approx(261.63, rel=1e-2)


class TestSynthNote:
    def test_サイン波ノートを生成(self):
        from synth import synth_note
        result = synth_note('A', 4, 0.5, 'sine', 0.7, 0.01, 0.1, 0.7, 0.3)
        assert Path(result).exists()
        data, sr = load_audio(result)
        expected_samples = int(0.5 * sr)
        assert abs(len(data) - expected_samples) < sr * 0.1

    def test_各波形で生成できる(self):
        from synth import synth_note
        for wave in ['sine', 'square', 'sawtooth', 'triangle']:
            result = synth_note('C', 4, 0.3, wave, 0.5, 0.01, 0.1, 0.6, 0.2)
            assert Path(result).exists()

    def test_楽器プリセットで生成できる(self):
        from synth import synth_note
        for inst in ['guitar', 'violin', 'flute', 'bass']:
            result = synth_note('E', 3, 0.3, 'sine', 0.5, 0.01, 0.1, 0.6, 0.2, instrument=inst)
            assert Path(result).exists()


class TestDrumMachine:
    def test_8ビートパターンを生成(self):
        from synth import drum_machine
        result = drum_machine('8ビート', 120, 2, 0.7)
        assert Path(result).exists()
        data, sr = load_audio(result)
        assert len(data) > 0

    def test_全パターンが生成できる(self):
        from synth import drum_machine
        for pattern in ['8ビート', '4つ打ち', 'ボサノバ', 'レゲエ']:
            result = drum_machine(pattern, 120, 1, 0.5)
            assert Path(result).exists()

    def test_不明なパターンでエラー(self):
        from synth import drum_machine
        with pytest.raises(ValueError):
            drum_machine('不明なパターン', 120, 1, 0.5)


class TestStepSequencer:
    def test_ノートシーケンスをレンダリング(self):
        import json
        from synth import step_sequencer
        notes = [
            {"note": "C", "octave": 4, "step": 0, "length": 4},
            {"note": "E", "octave": 4, "step": 4, "length": 4},
            {"note": "G", "octave": 4, "step": 8, "length": 4},
        ]
        result = step_sequencer(json.dumps(notes), 120, 'sine', 0.5, 0.01, 0.1, 0.6, 0.2)
        assert Path(result).exists()
        data, sr = load_audio(result)
        assert len(data) > 0

    def test_空ノートでValueError(self):
        from synth import step_sequencer
        with pytest.raises(ValueError):
            step_sequencer('[]', 120, 'sine', 0.5, 0.01, 0.1, 0.6, 0.2)
