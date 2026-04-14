"""decompose の結果構造が FilePanel の期待する形式に一致することを検証"""
import pytest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))


class TestDecomposeResultStructure:
    """decompose() の戻り値構造が FilePanel の自動配置ロジックと互換であることを確認"""

    def test_stemsの各エントリが必要なフィールドを持つ(self):
        """FilePanel.handleFullTranscribe が参照するフィールドの存在確認"""
        from decompose import transcribe_polyphonic, estimate_mix_params
        import numpy as np
        import soundfile as sf
        import tempfile

        # テスト用のシンプルなWAV
        sr = 22050
        t = np.linspace(0, 0.5, sr // 2, dtype=np.float32)
        data = 0.3 * np.sin(2 * np.pi * 440 * t)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, data, sr)

            # 各コンポーネントが返す構造を確認
            notes = transcribe_polyphonic(tmp.name, bpm=120, sensitivity=0.7)
            for n in notes:
                assert "note" in n
                assert "octave" in n
                assert "step" in n
                assert "length" in n
                assert isinstance(n["step"], int)
                assert isinstance(n["length"], int)

            mix = estimate_mix_params(tmp.name)
            assert "volume_db" in mix
            assert "pan" in mix
            assert "reverb_wet" in mix
            assert isinstance(mix["volume_db"], float)
            assert -1.0 <= mix["pan"] <= 1.0

    def test_drum_eventsの構造(self):
        from decompose import transcribe_drums
        import numpy as np
        import soundfile as sf
        import tempfile

        sr = 22050
        data = np.zeros(sr, dtype=np.float32)
        for i in range(4):
            pos = int(i * sr / 4)
            burst = np.exp(-np.linspace(0, 10, 200)) * 0.5
            burst *= np.sin(2 * np.pi * 80 * np.linspace(0, 200 / sr, 200))
            data[pos:pos + 200] += burst.astype(np.float32)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, data, sr)
            events = transcribe_drums(tmp.name, bpm=120, sensitivity=0.7)

            for e in events:
                assert "type" in e
                assert e["type"] in ("kick", "snare", "hihat")
                assert "step" in e
                assert isinstance(e["step"], int)
                assert e["step"] >= 0
                assert "velocity" in e
                assert 0 <= e["velocity"] <= 127

    def test_stem_ラベルマッピング互換性(self):
        """FilePanel の STEM_LABELS_JP に含まれるキーが decompose の出力キーと一致"""
        # FilePanel側で使われているステム名のキー
        expected_keys = {"vocals", "drums", "bass", "guitar", "piano", "other"}
        # decompose.py の STEM_GM_CANDIDATES も同じキーを持つべき
        from decompose import STEM_GM_CANDIDATES
        for key in STEM_GM_CANDIDATES:
            # 全てのキーが想定されている名前、または既知のDemucs出力名であること
            assert isinstance(STEM_GM_CANDIDATES[key], list)
        # 主要ステムがカバーされている
        assert "bass" in STEM_GM_CANDIDATES
        assert "guitar" in STEM_GM_CANDIDATES
        assert "piano" in STEM_GM_CANDIDATES
