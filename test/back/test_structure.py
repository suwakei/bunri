"""structure モジュールのテスト（グリッド推定・セクション検出）"""
import numpy as np
import pytest

import grid_materials
import structure


def _pick(cases, names):
    """材料の一覧から、名前で選んだものを pytest のパラメータにする。"""
    by_name = {name: (kind, kwargs) for name, kind, kwargs in cases}
    return [pytest.param(*by_name[name], id=name) for name in names]


def _estimate(tmp_path, kind, kwargs):
    """合成音源を書き出してグリッドを推定し、``(grid, truth)`` を返す。"""
    truth = grid_materials.write_song(tmp_path / "song.wav", kind, **kwargs)
    grid = structure.estimate_grid(str(tmp_path / "song.wav"), beats_per_bar=truth["beats_per_bar"])
    return grid, truth


# 正解の分かっている合成音源のうち、テストで毎回確かめる代表。
# 全件（157 件）の誤差は test/back/bench_grid.py で測る
_DESIGN = _pick(grid_materials.design_cases(), [
    "report1 click_chords 120 16bars",   # 利用者の報告: 1 拍目が 3 拍目にずれた材料
    "tempo click_chords 90",             # 同じ強さのクリック。音の大きさでは小節頭が決まらない
    "tempo piano_chords 100",
    "tempo band 128",
    "style band_backbeat 120",           # スネア（2・4 拍）がいちばん大きい
    "tempo arpeggio 160",                # 8 分音符が続く。以前は 2/3 倍（付点 4 分）に取った
    "tempo band 174",                    # 以前は半分に取った
    "lead click_chords 120 lead0.35",    # 無音の前置き
    "lead band 120 lead1.3",
    "meter3 band 120",                   # 3 拍子
    "meter3 piano_chords 90",
    "pickup1 band 120",                  # 弱起
    "drift2% band 120",                  # テンポの揺れ
    "short band 120 4bars",              # 短い曲
    "style pad_chords 100",              # 1 小節に 1 回しか音が立ち上がらない。以前は 5/4 倍に取った
    "style band_2chords 120",            # コードが半小節ごとに変わる
])
_HOLDOUT = _pick(grid_materials.holdout_cases(), [
    "rock 133 lead0.0 rev0.0",
    "house 124 lead0.27 rev0.25",
    "sixteenth 97 lead0.9 rev0.25",
    "push 111 lead0.0 rev0.0",           # コードが小節線の 8 分音符前に変わる
    "waltz 133 lead0.27 rev0.25",
    "five 147 lead0.0 rev0.0",           # 5 拍子
])


class TestGridOnKnownMaterials:
    """正解の分かっている合成音源で、テンポ・拍の位置・1 拍目の位置が合う"""

    @pytest.mark.parametrize("kind, kwargs", _DESIGN + _HOLDOUT)
    def test_tempo_beats_and_downbeat(self, tmp_path, kind, kwargs):
        grid, truth = _estimate(tmp_path, kind, kwargs)
        errors = grid_materials.grid_errors(grid, truth)
        tempo, beats_ok, downbeat_ok = grid_materials.judge(errors)

        assert tempo == "ok", f"BPM {grid['bpm']:.2f}（正解 {truth['bpm']}）"
        assert beats_ok, f"拍の位置の誤差 {errors['beat_err_ms']:.1f}ms"
        assert downbeat_ok, (
            f"1 拍目 {grid['downbeat_offset_sec']:.3f} 秒（正解 {truth['downbeat']:.3f}）、"
            f"{errors['downbeat_err_beats']} 拍ずれ"
        )

    @pytest.mark.parametrize("kind, kwargs", _DESIGN[:6] + _HOLDOUT[:2])
    def test_grid_is_self_consistent(self, tmp_path, kind, kwargs):
        """BPM・1 拍目の位置・ビート列が、互いに食い違わない"""
        grid, truth = _estimate(tmp_path, kind, kwargs)
        beats = grid["beat_times_sec"]

        assert beats[0] == pytest.approx(grid["downbeat_offset_sec"])
        assert all(beats[i] < beats[i + 1] for i in range(len(beats) - 1))
        assert 60.0 / float(np.median(np.diff(beats))) == pytest.approx(grid["bpm"], rel=0.03)
        # 曲の終わりまでグリッドが届いている（最後の小節が外れない）
        assert beats[-1] >= truth["beat_times"][-1] - 0.05

    def test_report_sine_notes(self, tmp_path):
        """利用者の報告: サイン波の単音を 2 秒ずつ 4 つ。以前は BPM 60・拍 3 つになった

        音の立ち上がりが 1 小節に 1 回しか無いので、テンポは確実とは言えない。
        それでも、BPM とビート列が食い違わず、グリッドが曲の全体を覆うこと。
        """
        kind, kwargs = _pick(grid_materials.design_cases(), ["report2 sine_notes 120 4bars"])[0].values
        grid, truth = _estimate(tmp_path, kind, kwargs)

        assert grid["bpm"] == pytest.approx(120.0, rel=0.02)
        assert grid["downbeat_offset_sec"] == pytest.approx(0.0, abs=0.06)
        assert len(grid["beat_times_sec"]) >= 16
        assert grid["bpm_confidence"] < 0.7


class TestGridConfidence:
    """決め手が無いときは、値は出すが確信度を下げる"""

    def test_clear_material_is_certain(self, tmp_path):
        """拍も小節頭もはっきりした材料は「確実」になる"""
        grid, _ = _estimate(tmp_path, *_DESIGN[0].values)
        assert grid["bpm_confidence"] >= 0.7

    def test_octave_ambiguous_tempo_is_not_asserted(self, tmp_path):
        """倍・半分のどちらとも取れる材料（8 分の刻みが在る 70 BPM）は「自信なし」になる

        70 と 140 のどちらを返してもよいが、拍は音に乗っていること。
        """
        kind, kwargs = _pick(grid_materials.design_cases(), ["tempo band 70"])[0].values
        grid, truth = _estimate(tmp_path, kind, kwargs)
        errors = grid_materials.grid_errors(grid, truth)

        assert grid_materials.judge(errors)[0] in ("ok", "x2")
        assert errors["downbeat_err_beats"] == 0
        assert grid["bpm_confidence"] < 0.4

    def test_downbeat_without_cues_is_not_asserted(self, tmp_path):
        """小節頭の手がかりが無い材料（和音の無いドラムだけ）は「確実」にならない

        キックが 1・3 拍、スネアが 2・4 拍の型は、1 拍目と 3 拍目を音からは区別できない。
        """
        kind, kwargs = _pick(grid_materials.design_cases(), ["style drums 120"])[0].values
        grid, truth = _estimate(tmp_path, kind, kwargs)

        assert grid_materials.judge(grid_materials.grid_errors(grid, truth))[0] == "ok"
        assert grid["bpm_confidence"] < 0.7

    @pytest.mark.xfail(strict=True, reason="既知の弱点: 拍ごとに動くベースでは、小節頭を 3 拍目に取る")
    def test_walking_bass_downbeat(self, tmp_path):
        """ルート・3 度・5 度・6 度と動き続けるベースでも、小節頭が合う（まだ合わない）

        小節の中の音の動きのほうが、小節の境目でのコードの変化より大きくなるため、
        「コードの変わり目」の手がかりが 3 拍目を指す。直せたら strict=True がそれを知らせる。
        """
        kind, kwargs = _pick(grid_materials.holdout_cases(), ["shuffle 111 lead0.0 rev0.0"])[0].values
        grid, truth = _estimate(tmp_path, kind, kwargs)
        assert grid_materials.grid_errors(grid, truth)["downbeat_err_beats"] == 0


class TestTempoPrior:
    def test_peaks_at_center_and_is_symmetric_in_octaves(self):
        """120 BPM が頂点で、倍と半分は同じ重みになる"""
        assert structure._tempo_prior(120.0) == pytest.approx(1.0)
        assert structure._tempo_prior(60.0) == pytest.approx(structure._tempo_prior(240.0))
        assert structure._tempo_prior(90.0) > structure._tempo_prior(180.0)
        assert structure._tempo_prior(0.0) == 0.0


class TestHarmonicChange:
    @staticmethod
    def _chroma(pitch_classes_per_bar, frames_per_beat=10, beats_per_bar=4):
        """小節ごとに決まった音だけが鳴る、人工のクロマと拍の位置を作る。"""
        frames_per_bar = frames_per_beat * beats_per_bar
        chroma = np.zeros((12, frames_per_bar * len(pitch_classes_per_bar)))
        for bar, pitch_classes in enumerate(pitch_classes_per_bar):
            chroma[pitch_classes, bar * frames_per_bar:(bar + 1) * frames_per_bar] = 1.0
        return chroma, np.arange(0, chroma.shape[1], frames_per_beat)

    def test_peaks_where_the_chord_changes(self):
        """コードが変わる拍（小節頭）でいちばん大きくなる"""
        chroma, beats = self._chroma([[0, 4, 7], [7, 11, 2], [9, 0, 4], [5, 9, 0]] * 2)
        change = structure._harmonic_change(chroma, beats, span_beats=2)

        by_phase = [change[phase::4].mean() for phase in range(4)]
        assert int(np.argmax(by_phase)) == 0
        assert by_phase[2] == pytest.approx(0.0, abs=1e-9)

    def test_start_of_sound_is_not_a_change(self):
        """鳴り始め（手前が無音）は「変化」に数えない"""
        chroma, beats = self._chroma([[], [0, 4, 7], [0, 4, 7]])
        change = structure._harmonic_change(chroma, beats, span_beats=2)
        assert np.all(change == 0.0)


class TestPhaseProfile:
    def test_bar_pattern_is_fully_explained(self):
        """小節ごとに同じ強弱が繰り返していれば、説明率は 1 に近く、強い位置の効果量が正になる"""
        effects, explained = structure._phase_profile(np.tile([1.0, 0.0, 0.2, 0.0], 8), 4)
        assert explained == pytest.approx(1.0)
        assert int(np.argmax(effects)) == 0

    def test_pattern_that_does_not_fit_the_bar_is_not_explained(self):
        """小節に収まらない周期（3 拍ごと）は、4 拍子の小節内の位置では説明できない"""
        _, explained = structure._phase_profile(np.tile([1.0, 0.0, 0.0], 16), 4)
        assert explained < 0.1

    def test_degenerate_input_is_safe(self):
        """拍が少ない・値が一定でも例外を投げない"""
        assert structure._phase_profile(np.ones(3), 4)[1] == 0.0
        assert structure._phase_profile(np.ones(32), 4)[1] == 0.0


class TestRepairEdgeBeats:
    def test_first_beat_is_moved_onto_the_grid(self):
        """最初の 1 拍だけ間隔から外れていたら、隣の間隔に合わせて置き直す"""
        beats = np.array([16, 32, 52, 72, 92, 112, 132])
        repaired = structure._repair_edge_beats(beats)
        assert repaired[0] == 12
        assert list(repaired[1:]) == list(beats[1:])

    def test_regular_beats_are_untouched(self):
        """間隔がそろっていれば何もしない"""
        beats = np.arange(10, 200, 20)
        assert list(structure._repair_edge_beats(beats)) == list(beats)


class TestCombPeriodicity:
    def test_uses_bar_level_repetition(self):
        """拍の間隔に繰り返しが無くても、1 小節の間隔で繰り返していれば点が付く"""
        autocorrelation = np.zeros(200)
        autocorrelation[0] = 1.0
        autocorrelation[80] = 0.9   # 80 フレームごとに繰り返す（20 フレームの拍なら 4 拍 = 1 小節）
        assert structure._comb_periodicity(autocorrelation, 20.0, 4) == pytest.approx(0.9 / 4)
        assert structure._comb_periodicity(autocorrelation, 16.0, 4) == 0.0


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

    def test_frame_quantized_beats_still_reach_song_start(self):
        """拍の位置がフレーム幅に丸められていても、1 小節目を落とさない

        120 BPM の拍は、フレーム幅（約 23ms）に丸めると 0.4876 秒と 0.5108 秒の間隔が混ざる。
        間隔の中央値（0.5108 秒）で 1 小節の長さを見積もると 2.043 秒になり、2.02 秒に在る
        小節頭から「1 小節も遡れない」と判断して 1 小節目を落としていた。
        """
        hop = structure.HOP_LENGTH / structure.ANALYSIS_SR
        beats = [round((2.02 + i * 0.5) / hop) * hop for i in range(16)]
        assert float(np.median(np.diff(beats))) > 0.5   # 中央値は丸めの分だけ長い

        extended, offset = structure._extend_grid_backward(beats, phase=0, beats_per_bar=4)
        assert offset == pytest.approx(0.02, abs=0.03)
        assert len(extended) == len(beats) + 4

    def test_tiny_overshoot_is_clamped_to_zero(self):
        """遡った先が 0 秒よりわずかに前なら、曲頭ちょうどに置く"""
        beats = [1.98 + i * 0.5 for i in range(8)]
        extended, offset = structure._extend_grid_backward(beats, phase=0, beats_per_bar=4)
        assert offset == 0.0
        assert all(extended[i] < extended[i + 1] for i in range(len(extended) - 1))


class TestExtendGridForward:
    def test_extends_to_the_end_of_sound(self):
        """音が鳴り終わる位置まで、同じ間隔で拍を足す"""
        beats = [i * 0.5 for i in range(8)]   # 最後の拍は 3.5 秒
        extended = structure._extend_grid_forward(beats, sound_end_sec=5.0, duration_sec=5.6)
        assert extended[:8] == beats
        assert extended[-1] == pytest.approx(5.0)
        assert np.allclose(np.diff(extended), 0.5)

    def test_does_not_run_past_the_audio(self):
        """音声の長さを越える拍は足さない"""
        beats = [i * 0.5 for i in range(8)]
        extended = structure._extend_grid_forward(beats, sound_end_sec=5.0, duration_sec=4.2)
        assert extended[-1] <= 4.2

    def test_nothing_to_extend(self):
        """すでに届いていれば入力のまま"""
        beats = [i * 0.5 for i in range(8)]
        assert structure._extend_grid_forward(beats, sound_end_sec=3.5, duration_sec=10.0) == beats


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

    def test_last_section_ends_at_the_last_bar(self, tmp_path):
        """小節の境目で終わる 16 小節の曲で、最後の区間が 16 小節目で終わる

        グリッドは音が鳴り終わる位置（= 17 小節目の頭）まで伸びるが、その拍は最後の小節を
        閉じる線で、新しい小節ではない。
        """
        grid, _ = _estimate(tmp_path, *_DESIGN[0].values)
        sections = structure.detect_sections(str(tmp_path / "song.wav"), grid["beat_times_sec"])

        assert sections
        assert sections[0]["start_bar"] == 1
        assert sections[-1]["end_bar"] == 16

    def test_insufficient_beats_returns_empty(self, chord_song):
        """ビートが少なすぎる場合は空リストを返す"""
        path, _ = chord_song
        assert structure.detect_sections(path, []) == []
        assert structure.detect_sections(path, [0.0, 0.5, 1.0]) == []
