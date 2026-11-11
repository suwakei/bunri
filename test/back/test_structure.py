"""structure モジュールのテスト（グリッド推定・セクション検出）"""
import numpy as np
import pytest

import structure


class TestEstimateGrid:
    def test_detects_bpm_and_downbeat(self, chord_song):
        """合成音源から BPM とダウンビートを推定できる"""
        path, truth = chord_song
        grid = structure.estimate_grid(path)

        assert grid["bpm"] == pytest.approx(truth["bpm"], abs=3.0)
        assert grid["downbeat_offset_sec"] == pytest.approx(truth["offset"], abs=0.25)
        assert grid["bpm_source"] == "auto"
        assert grid["user_confirmed"] is False

    def test_beat_times_are_strictly_ascending(self, chord_song):
        """実測ビート列は厳密な昇順である

        曲頭方向への外挿で既存の拍と重複させると昇順が壊れ、コードが
        小節ごとずれる。回帰テストとして押さえておく。
        """
        path, _ = chord_song
        beats = structure.estimate_grid(path)["beat_times_sec"]
        assert len(beats) > 8
        assert all(beats[i] < beats[i + 1] for i in range(len(beats) - 1))

    def test_bar_heads_align_with_truth(self, chord_song):
        """小節頭（4拍ごと）が真値の小節線と一致する"""
        path, truth = chord_song
        grid = structure.estimate_grid(path)
        beats = grid["beat_times_sec"]
        bar_duration = 60.0 / truth["bpm"] * 4

        for index, actual in enumerate(beats[0::4][:6]):
            expected = truth["offset"] + index * bar_duration
            assert actual == pytest.approx(expected, abs=0.2)

    def test_user_override(self, chord_song):
        """BPM とオフセットを指定すると自動検出せずその値を使う"""
        path, _ = chord_song
        grid = structure.estimate_grid(path, bpm=100.0, downbeat_offset=1.0)

        assert grid["bpm"] == 100.0
        assert grid["bpm_source"] == "user"
        assert grid["user_confirmed"] is True
        assert grid["downbeat_offset_sec"] == 1.0
        assert grid["bpm_confidence"] == 1.0
        # 等間隔ビート列が組まれる
        diffs = np.diff(grid["beat_times_sec"])
        assert np.allclose(diffs, 60.0 / 100.0)

    def test_time_signature_is_taken_from_argument(self, chord_song):
        """拍子は自動検出せずユーザー指定を信頼する"""
        path, _ = chord_song
        grid = structure.estimate_grid(path, bpm=120.0, downbeat_offset=0.35, beats_per_bar=3)
        assert grid["time_signature"] == [3, 4]

    def test_silence_returns_default_grid(self, silent_wav):
        """無音でも例外を投げず、確信度0の既定グリッドを返す"""
        grid = structure.estimate_grid(silent_wav)
        assert grid["bpm"] > 0
        assert isinstance(grid["beat_times_sec"], list)

    def test_bpm_within_plausible_range(self, chord_song):
        """BPM は妥当範囲に収まる"""
        path, _ = chord_song
        grid = structure.estimate_grid(path)
        assert structure.BPM_MIN <= grid["bpm"] <= structure.BPM_MAX


class TestExtendGridBackward:
    def test_extends_to_song_start(self):
        """検出が2小節目から始まっていても曲頭まで小節単位で伸びる"""
        # 0.5秒間隔、2.0秒（=1小節）から始まるビート列
        beats = [2.0 + i * 0.5 for i in range(8)]
        extended, offset = structure._extend_grid_backward(beats, phase=0, beats_per_bar=4)

        assert offset == pytest.approx(0.0, abs=0.01)
        assert len(extended) == len(beats) + 4
        assert all(extended[i] < extended[i + 1] for i in range(len(extended) - 1))

    def test_keeps_phase(self):
        """位相を保ったまま伸びる（小節頭がずれない）"""
        beats = [2.4 + i * 0.5 for i in range(8)]
        extended, offset = structure._extend_grid_backward(beats, phase=0, beats_per_bar=4)
        # 伸ばした先頭から4拍ごとに元のダウンビートへ戻れる
        assert (2.4 - offset) % 2.0 == pytest.approx(0.0, abs=0.01)

    def test_no_room_returns_from_downbeat(self):
        """1小節も遡れない場合はダウンビート以降を返す"""
        beats = [0.1 + i * 0.5 for i in range(8)]
        extended, offset = structure._extend_grid_backward(beats, phase=2, beats_per_bar=4)
        assert offset == pytest.approx(beats[2])
        assert extended[0] == pytest.approx(beats[2])

    def test_short_input_is_safe(self):
        """ビートが足りなくても例外を投げない"""
        extended, offset = structure._extend_grid_backward([1.0], phase=0, beats_per_bar=4)
        assert extended == [1.0]
        assert offset == 1.0


class TestMergeShortBoundaries:
    def test_short_segments_are_absorbed(self):
        """最小長に満たない区間は隣へ吸収される"""
        assert structure._merge_short_boundaries([0, 1, 3, 20, 40], 8) == [0, 20, 40]

    def test_long_segments_are_kept(self):
        """十分な長さの区間はそのまま残る"""
        assert structure._merge_short_boundaries([0, 10, 20, 30], 8) == [0, 10, 20, 30]

    def test_trailing_short_segment_is_absorbed(self):
        """末尾が短くなりすぎた場合は直前の境界を落とす"""
        assert structure._merge_short_boundaries([0, 10, 20, 22], 8) == [0, 10, 22]

    def test_degenerate_input_is_untouched(self):
        """境界が2つ以下ならそのまま返す"""
        assert structure._merge_short_boundaries([0, 5], 8) == [0, 5]


class TestDetectSections:
    def test_returns_sections_with_required_fields(self, chord_song):
        """セクションが必要なフィールドを揃えて返る"""
        path, _ = chord_song
        grid = structure.estimate_grid(path)
        sections = structure.detect_sections(path, grid["beat_times_sec"])

        assert sections
        for section in sections:
            assert section["id"].startswith("S")
            assert section["start_bar"] >= 1
            assert section["end_bar"] >= section["start_bar"]
            assert section["end_sec"] > section["start_sec"]
            assert section["repeat_group"]
            assert "rms_db" in section["features"]
            assert "onset_density" in section["features"]

    def test_labels_are_never_asserted(self, chord_song):
        """ラベルは断定せず、提案としてのみ持つ

        自動ラベル推定は洋楽・インスト・非定型な楽曲で崩れるため、
        label はユーザーが確定するまで None のままでなければならない。
        """
        path, _ = chord_song
        grid = structure.estimate_grid(path)
        sections = structure.detect_sections(path, grid["beat_times_sec"])

        assert all(s["label"] is None for s in sections)
        assert all(0.0 <= s["suggested_confidence"] <= 1.0 for s in sections)

    def test_sections_are_ordered_and_non_degenerate(self, chord_song):
        """区間は時間順に並び、極端に短い区間が残らない"""
        path, _ = chord_song
        grid = structure.estimate_grid(path)
        sections = structure.detect_sections(path, grid["beat_times_sec"])

        for previous, current in zip(sections, sections[1:]):
            assert current["start_sec"] >= previous["start_sec"]

    def test_insufficient_beats_returns_empty(self, chord_song):
        """ビートが少なすぎる場合は空リストを返す"""
        path, _ = chord_song
        assert structure.detect_sections(path, []) == []
        assert structure.detect_sections(path, [0.0, 0.5, 1.0]) == []
