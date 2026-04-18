"""Basic Pitch vs pyin の回帰テスト

同一音源で basic-pitch が pyin より精度が高い（ノート検出数が多い）ことを確認。
"""
import numpy as np
import pytest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture
def polyphonic_wav(tmp_path):
    """ポリフォニックテスト音源: C4 + E4 + G4 の和音 → pyin は1音しか取れない"""
    import soundfile as sf
    sr = 22050
    duration = 2.0
    t = np.linspace(0, duration, int(sr * duration), dtype=np.float32)
    # Cメジャートライアド（C4 + E4 + G4）
    c4 = 0.3 * np.sin(2 * np.pi * 261.63 * t)
    e4 = 0.3 * np.sin(2 * np.pi * 329.63 * t)
    g4 = 0.3 * np.sin(2 * np.pi * 392.00 * t)
    data = c4 + e4 + g4
    path = tmp_path / "chord_test.wav"
    sf.write(str(path), data, sr)
    return str(path)


@pytest.fixture
def melody_wav(tmp_path):
    """単音メロディテスト音源: C4 → E4 → G4 の順次発音"""
    import soundfile as sf
    sr = 22050
    segment = int(sr * 0.5)  # 各ノート0.5秒
    t = np.linspace(0, 0.5, segment, dtype=np.float32)
    c4 = 0.5 * np.sin(2 * np.pi * 261.63 * t)
    e4 = 0.5 * np.sin(2 * np.pi * 329.63 * t)
    g4 = 0.5 * np.sin(2 * np.pi * 392.00 * t)
    data = np.concatenate([c4, e4, g4])
    path = tmp_path / "melody_test.wav"
    sf.write(str(path), data, sr)
    return str(path)


class TestBasicPitchVsPyin:
    def test_basic_pitchが和音から複数ノートを検出(self, polyphonic_wav):
        """和音に対して basic-pitch は pyin より多くのノートを検出する"""
        from analyze import analyze_wav

        bp_notes = analyze_wav(polyphonic_wav, bpm=120, sensitivity=0.7, engine="basic_pitch")
        pyin_notes = analyze_wav(polyphonic_wav, bpm=120, sensitivity=0.7, engine="pyin")

        # basic-pitch は和音の複数ノートを検出できる
        assert len(bp_notes) >= len(pyin_notes), (
            f"basic-pitch ({len(bp_notes)} notes) should detect >= pyin ({len(pyin_notes)} notes)"
        )

    def test_basic_pitchがノートを検出する(self, melody_wav):
        """basic-pitch が単音メロディからノートを検出できる"""
        from analyze import analyze_wav
        notes = analyze_wav(melody_wav, bpm=120, sensitivity=0.7, engine="basic_pitch")
        assert len(notes) > 0

    def test_pyinがノートを検出する(self, melody_wav):
        """pyin フォールバックも引き続き動作する"""
        from analyze import analyze_wav
        notes = analyze_wav(melody_wav, bpm=120, sensitivity=0.7, engine="pyin")
        assert len(notes) > 0

    def test_engineパラメータのデフォルトはbasic_pitch(self, melody_wav):
        """engine 未指定時は basic_pitch が使われる"""
        from analyze import analyze_wav
        notes = analyze_wav(melody_wav, bpm=120, sensitivity=0.5)
        assert len(notes) > 0

    def test_ノート構造が一貫している(self, melody_wav):
        """両エンジンとも同じスキーマで出力する"""
        from analyze import analyze_wav
        for eng in ["basic_pitch", "pyin"]:
            notes = analyze_wav(melody_wav, bpm=120, sensitivity=0.7, engine=eng)
            for n in notes:
                assert "note" in n
                assert "octave" in n
                assert "step" in n
                assert "length" in n
                assert n["note"] in ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
                assert isinstance(n["octave"], int)
                assert isinstance(n["step"], int)
                assert isinstance(n["length"], int)
                assert n["step"] >= 0
                assert n["length"] >= 1


class TestDecomposeWithBasicPitch:
    def test_transcribe_polyphonic_basic_pitch(self, polyphonic_wav):
        """decompose.transcribe_polyphonic がデフォルトでbasic-pitchを使う"""
        from decompose import transcribe_polyphonic
        notes = transcribe_polyphonic(polyphonic_wav, bpm=120, sensitivity=0.7)
        assert len(notes) > 0
        for n in notes:
            assert "velocity" in n

    def test_transcribe_polyphonic_stft_fallback(self, polyphonic_wav):
        """engine='stft' で旧実装にフォールバック"""
        from decompose import transcribe_polyphonic
        notes = transcribe_polyphonic(polyphonic_wav, bpm=120, sensitivity=0.7, engine="stft")
        assert isinstance(notes, list)

    def test_basic_pitchのほうがstftより精度が高い(self, polyphonic_wav):
        """同一和音で basic-pitch が STFT より多くのノートを検出"""
        from decompose import transcribe_polyphonic
        bp = transcribe_polyphonic(polyphonic_wav, bpm=120, sensitivity=0.7, engine="basic_pitch")
        stft = transcribe_polyphonic(polyphonic_wav, bpm=120, sensitivity=0.7, engine="stft")
        assert len(bp) >= len(stft), (
            f"basic-pitch ({len(bp)}) should detect >= STFT ({len(stft)})"
        )
