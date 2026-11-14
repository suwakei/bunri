"""song_chart モジュールのテスト（カルテ組み立て・正規化・バイト安定性）"""
import json

import numpy as np
import pytest

import song_chart


class TestConfidenceTier:
    @pytest.mark.parametrize("value,expected", [
        (1.0, song_chart.TIER_CERTAIN),
        (0.7, song_chart.TIER_CERTAIN),
        (0.69, song_chart.TIER_LIKELY),
        (0.4, song_chart.TIER_LIKELY),
        (0.39, song_chart.TIER_UNSURE),
        (0.0, song_chart.TIER_UNSURE),
        (None, song_chart.TIER_UNSURE),
    ])
    def test_tiers(self, value, expected):
        """確信度が3段階に丸められる"""
        assert song_chart.confidence_tier(value) == expected


class TestNormalizeChart:
    def test_numpy_scalars_become_python_types(self):
        """numpy のスカラ型が Python の組み込み型に落ちる"""
        result = song_chart.normalize_chart({
            "a": np.float64(1.23456789),
            "b": np.int64(7),
            "c": [np.float32(0.5)],
        })
        assert isinstance(result["a"], float)
        assert isinstance(result["b"], int)
        assert isinstance(result["c"][0], float)
        assert json.dumps(result)  # JSON化できる

    def test_floats_are_rounded(self):
        """浮動小数点が固定桁で丸められる（バイト安定性のため）"""
        result = song_chart.normalize_chart({"x": 0.1 + 0.2})
        assert result["x"] == 0.3

    def test_keys_are_sorted(self):
        """辞書のキーが並べ替えられる"""
        assert list(song_chart.normalize_chart({"z": 1, "a": 2})) == ["a", "z"]

    def test_booleans_are_preserved(self):
        """bool が int に潰れない"""
        result = song_chart.normalize_chart({"flag": True, "count": 1})
        assert result["flag"] is True
        assert isinstance(result["count"], int)

    def test_nested_structures(self):
        """入れ子の dict / list も再帰的に正規化される"""
        result = song_chart.normalize_chart({"a": {"c": [{"b": np.float64(1.0)}]}})
        assert result["a"]["c"][0]["b"] == 1.0

    def test_input_is_not_mutated(self):
        """入力の辞書を書き換えない"""
        original = {"z": 1, "a": 2}
        song_chart.normalize_chart(original)
        assert list(original) == ["z", "a"]


class TestToCanonicalJson:
    def test_key_order_is_stable(self):
        """キーの並び順に関係なく同じ JSON になる（プロンプトキャッシュ用）"""
        a = song_chart.to_canonical_json({"b": 1, "a": 2})
        b = song_chart.to_canonical_json({"a": 2, "b": 1})
        assert a == b

    def test_float_noise_does_not_change_bytes(self):
        """浮動小数点の微小な揺れがバイト列を変えない"""
        a = song_chart.to_canonical_json({"x": 0.3})
        b = song_chart.to_canonical_json({"x": 0.1 + 0.2})
        assert a == b

    def test_japanese_is_not_escaped(self):
        """日本語がエスケープされず、そのまま LLM に渡せる"""
        assert "テスト" in song_chart.to_canonical_json({"x": "テスト"})


class TestBuildChart:
    def test_structure(self, chord_song):
        """カルテが仕様どおりのキーを持つ"""
        path, _ = chord_song
        chart = song_chart.build_chart(path, filename="song.wav")

        for key in ("version", "source", "grid", "key", "sections", "chords", "mix", "unavailable"):
            assert key in chart
        assert chart["version"] == song_chart.SCHEMA_VERSION
        assert chart["source"]["filename"] == "song.wav"
        assert chart["source"]["duration_sec"] > 0

    def test_counts_bars_in_detected_triple_meter(self, waltz_song):
        """拍子を渡さなければ自動で決め、コードの小節・拍もその拍子で数える"""
        path, truth = waltz_song
        chart = song_chart.build_chart(path)
        assert chart["grid"]["time_signature"] == [truth["beats_per_bar"], 4] == [3, 4]
        assert chart["chords"]
        assert all(1 <= chord["beat"] <= 3 for chord in chart["chords"])

    def test_given_meter_is_used_for_bars(self, waltz_song):
        """拍子を渡せば、その拍子で数える（3 拍子の曲でも 4 と言われれば 4）"""
        path, _ = waltz_song
        chart = song_chart.build_chart(path, beats_per_bar=4)
        assert chart["grid"]["time_signature"] == [4, 4]
        assert any(chord["beat"] == 4 for chord in chart["chords"])

    def test_detects_key(self, chord_song):
        """キーを正しく推定する"""
        path, truth = chord_song
        chart = song_chart.build_chart(path)
        assert chart["key"]["tonic"] == truth["tonic"]
        assert chart["key"]["mode"] == truth["mode"]

    def test_chords_carry_bar_and_beat(self, chord_song):
        """コードに小節・拍の絶対位置が付く

        LLM がハイライト先を一意に指すために必須。
        """
        path, _ = chord_song
        chart = song_chart.build_chart(path)
        assert chart["chords"]
        for chord in chart["chords"]:
            assert chord["bar"] >= 1
            assert 1 <= chord["beat"] <= 4

    def test_chords_have_degrees(self, chord_song):
        """キーが取れていればコードにディグリー表記が付く"""
        path, _ = chord_song
        chart = song_chart.build_chart(path)
        assert all(chord["degree"] for chord in chart["chords"])

    def test_no_temp_paths_in_chart(self, chord_song):
        """一時パスや解析日時がカルテに混入しない（バイト安定性のため）"""
        path, _ = chord_song
        chart = song_chart.build_chart(path, filename="song.wav")
        serialized = song_chart.to_canonical_json(chart)
        assert path not in serialized
        assert "/tmp" not in serialized
        assert "created_at" not in serialized

    def test_is_deterministic(self, chord_song):
        """同じ入力からは同じバイト列が得られる（プロンプトキャッシュの前提）"""
        path, _ = chord_song
        a = song_chart.to_canonical_json(song_chart.build_chart(path, filename="s.wav"))
        b = song_chart.to_canonical_json(song_chart.build_chart(path, filename="s.wav"))
        assert a == b

    def test_grid_override(self, chord_song):
        """グリッドを指定して再計算できる（regrid 経路）"""
        path, _ = chord_song
        chart = song_chart.build_chart(path, bpm=120.0, downbeat_offset=0.35, beats_per_bar=4)
        assert chart["grid"]["bpm"] == 120.0
        assert chart["grid"]["bpm_source"] == "user"
        assert chart["grid"]["user_confirmed"] is True

    def test_missing_file_raises(self):
        """存在しないファイルでは FileNotFoundError を投げる"""
        with pytest.raises(FileNotFoundError):
            song_chart.build_chart("/存在しない/音源.wav")

    def test_silence_degrades_gracefully(self, silent_wav):
        """無音では例外を投げず、検出できない項目を unavailable に落とす"""
        chart = song_chart.build_chart(silent_wav, filename="silence.wav")
        assert chart["key"]["tonic"] is None
        assert chart["chords"] == []
        assert "key" in chart["unavailable"]
        assert all(isinstance(reason, str) and reason for reason in chart["unavailable"].values())

    def test_noise_does_not_assert_a_key(self, noise_wav):
        """調性の無い音源でキーを断定しない

        間違った値に「自信なし」ラベルを貼っても初心者は結局それを信じるため、
        値そのものを出さない方針。
        """
        chart = song_chart.build_chart(noise_wav, filename="noise.wav")
        assert chart["key"]["tonic"] is None
        assert "key" in chart["unavailable"]


class TestWaveformPeaks:
    def test_shape(self, chord_song):
        """ピーク配列が指定した点数で返る"""
        path, _ = chord_song
        peaks = song_chart.waveform_peaks(path, points=500)
        assert peaks["points"] == 500
        assert len(peaks["min"]) == 500
        assert len(peaks["max"]) == 500
        assert peaks["duration_sec"] > 0

    def test_values_are_in_range(self, chord_song):
        """値が -1.0〜1.0 に収まり、min <= max である"""
        path, _ = chord_song
        peaks = song_chart.waveform_peaks(path, points=200)
        assert all(-1.0 <= v <= 1.0 for v in peaks["min"] + peaks["max"])
        assert all(lo <= hi for lo, hi in zip(peaks["min"], peaks["max"]))

    def test_not_included_in_chart(self, chord_song):
        """ピークはカルテに含めない（サイズとバイト安定性のため）"""
        path, _ = chord_song
        chart = song_chart.build_chart(path)
        assert "peaks" not in chart
        assert "waveform" not in chart

    def test_silence(self, silent_wav):
        """無音でも例外を投げない"""
        peaks = song_chart.waveform_peaks(silent_wav, points=100)
        assert peaks["points"] == 100
        assert all(v == 0.0 for v in peaks["max"])
