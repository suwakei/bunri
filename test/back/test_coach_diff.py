"""差分コーチの土台（coach_diff）のテスト

お手本と打ち込みの差分が、機械的に決まる形で出ることを確かめる。
"""
import pytest
from httpx import ASGITransport, AsyncClient

import coach_diff
from coach_diff import DiffError, diff_notes


def n(note, octave, step, length=4):
    return {"note": note, "octave": octave, "step": step, "length": length}


# お手本: 1 小節目に C4 E4 G4 を 4 分音符で、2 小節目の頭に C5
REFERENCE = [n("C", 4, 0), n("E", 4, 4), n("G", 4, 8), n("C", 5, 16)]


def kinds(result):
    return [(issue["kind"], issue["bar"], issue["beat"]) for bar in result["bars"] for issue in bar["issues"]]


class TestExact:
    def test_同じなら指摘なしで正確さは1(self):
        result = diff_notes(REFERENCE, [dict(x) for x in REFERENCE])
        assert result["bars"] == [] and result["worst_bars"] == []
        assert result["summary"]["exact"] == 4
        assert result["summary"]["accuracy"] == 1.0
        assert all(result["summary"][kind] == 0 for kind in coach_diff.KINDS)

    def test_順番が違っても結果は同じ(self):
        shuffled = [REFERENCE[2], REFERENCE[0], REFERENCE[3], REFERENCE[1]]
        assert diff_notes(REFERENCE, shuffled)["summary"]["exact"] == 4

    def test_入力を書き換えない(self):
        attempt = [n("C", 4, 0)]
        diff_notes(REFERENCE, attempt)
        assert attempt == [n("C", 4, 0)]
        assert "pitch" not in REFERENCE[0]


class TestKinds:
    def test_抜け(self):
        result = diff_notes(REFERENCE, [REFERENCE[0], REFERENCE[2], REFERENCE[3]])
        assert kinds(result) == [("missing", 1, 2)]
        issue = result["bars"][0]["issues"][0]
        assert issue["expected"] == n("E", 4, 4) and issue["actual"] is None
        assert result["summary"]["missing"] == 1
        assert result["summary"]["accuracy"] == 0.75

    def test_余分(self):
        result = diff_notes(REFERENCE, REFERENCE + [n("A", 3, 24)])
        assert kinds(result) == [("extra", 2, 3)]
        issue = result["bars"][0]["issues"][0]
        assert issue["expected"] is None and issue["actual"] == n("A", 3, 24)
        assert result["summary"]["accuracy"] == 1.0

    def test_オクターブ違い(self):
        attempt = [n("C", 4, 0), n("E", 3, 4), n("G", 4, 8), n("C", 5, 16)]
        result = diff_notes(REFERENCE, attempt)
        assert kinds(result) == [("octave", 1, 2)]
        issue = result["bars"][0]["issues"][0]
        assert issue["expected"]["octave"] == 4 and issue["actual"]["octave"] == 3
        assert result["summary"]["missing"] == 0 and result["summary"]["extra"] == 0

    def test_音の間違い(self):
        attempt = [n("C", 4, 0), n("F", 4, 4), n("G", 4, 8), n("C", 5, 16)]
        result = diff_notes(REFERENCE, attempt)
        assert kinds(result) == [("pitch", 1, 2)]
        assert result["bars"][0]["issues"][0]["actual"]["note"] == "F"

    def test_離れた高さは間違いではなく抜けと余分(self):
        attempt = [n("C", 4, 0), n("A", 4, 4), n("G", 4, 8), n("C", 5, 16)]
        assert sorted(k for k, _, _ in kinds(diff_notes(REFERENCE, attempt))) == ["extra", "missing"]

    def test_位置のずれ(self):
        attempt = [n("C", 4, 0), n("E", 4, 5), n("G", 4, 8), n("C", 5, 16)]
        result = diff_notes(REFERENCE, attempt)
        assert kinds(result) == [("timing", 1, 2)]
        assert result["bars"][0]["issues"][0]["offset_steps"] == 1
        # 位置の小さなずれは「合っている」側に数える
        assert result["summary"]["accuracy"] == 1.0
        assert result["summary"]["exact"] == 3

    def test_許容より大きくずれたら抜けと余分(self):
        attempt = [n("C", 4, 0), n("E", 4, 7), n("G", 4, 8), n("C", 5, 16)]
        assert sorted(k for k, _, _ in kinds(diff_notes(REFERENCE, attempt))) == ["extra", "missing"]
        assert kinds(diff_notes(REFERENCE, attempt, timing_tolerance=3)) == [("timing", 1, 2)]

    def test_長さの違い(self):
        attempt = [n("C", 4, 0, 2), n("E", 4, 4), n("G", 4, 8), n("C", 5, 16)]
        result = diff_notes(REFERENCE, attempt)
        assert kinds(result) == [("length", 1, 1)]
        assert result["bars"][0]["issues"][0]["length_diff"] == -2

    def test_位置も長さも違えば両方指摘する(self):
        attempt = [n("C", 4, 1, 8), n("E", 4, 4), n("G", 4, 8), n("C", 5, 16)]
        assert kinds(diff_notes(REFERENCE, attempt)) == [("timing", 1, 1), ("length", 1, 1)]


class TestMatching:
    def test_同じ高さが続くとき_近いほうどうしを組にする(self):
        reference = [n("C", 4, 0, 2), n("C", 4, 2, 2), n("C", 4, 4, 2)]
        attempt = [n("C", 4, 0, 2), n("C", 4, 4, 2)]
        result = diff_notes(reference, attempt)
        assert kinds(result) == [("missing", 1, 1)]
        assert result["bars"][0]["issues"][0]["expected"]["step"] == 2

    def test_和音の一部だけ違うとき_合っている音は巻き込まない(self):
        reference = [n("C", 4, 0), n("E", 4, 0), n("G", 4, 0)]
        attempt = [n("C", 4, 0), n("D#", 4, 0), n("G", 4, 0)]
        result = diff_notes(reference, attempt)
        assert kinds(result) == [("pitch", 1, 1)]
        assert result["summary"]["exact"] == 2

    def test_何も打ち込んでいなければ全部抜け(self):
        result = diff_notes(REFERENCE, [])
        assert result["summary"]["missing"] == 4 and result["summary"]["accuracy"] == 0.0
        assert [bar["bar"] for bar in result["bars"]] == [1, 2]


class TestBars:
    def test_小節と拍は1始まりで_拍子に従う(self):
        result = diff_notes([n("C", 4, 30)], [], steps_per_bar=12, steps_per_beat=4)
        assert kinds(result) == [("missing", 3, 2)]

    def test_指摘の重い小節から並ぶ(self):
        reference = [n("C", 4, s) for s in (0, 4, 8, 12)] + [n("D", 4, s) for s in (16, 20)] + [n("E", 4, 32)]
        attempt = [n("C", 4, 0), n("D", 4, 16), n("D", 4, 21), n("E", 4, 32)]   # 1 小節目で 3 つ抜け、2 小節目は位置ずれ
        result = diff_notes(reference, attempt)
        assert result["worst_bars"] == [1, 2]
        assert [bar["bar"] for bar in result["bars"]] == [1, 2]

    def test_最大5小節まで(self):
        reference = [n("C", 4, bar * 16) for bar in range(8)]
        assert len(diff_notes(reference, [])["worst_bars"]) == 5


class TestBarStats:
    """小節ごとの「お手本のノートの数」と「合っていた数」（学習の記録に残し、練習の地図が使う）"""

    def test_お手本のノートが在る小節だけを_小節順に持つ(self):
        # 1 小節目に 3 つ、2 小節目に 1 つ、4 小節目に 1 つ（3 小節目は空）
        reference = REFERENCE + [n("D", 4, 48)]
        result = diff_notes(reference, [REFERENCE[0], REFERENCE[3]])
        assert result["bar_stats"] == [
            {"bar": 1, "reference_count": 3, "matched": 1},
            {"bar": 2, "reference_count": 1, "matched": 1},
            {"bar": 4, "reference_count": 1, "matched": 0},
        ]

    def test_合っていた数は一致率と同じ数え方(self):
        # 位置のずれ（許容内）と長さの違いは、合っている側。高さの違い・オクターブ違い・抜けは、合っていない側
        attempt = [n("C", 4, 1), n("E", 4, 4, length=8), n("G", 5, 8), n("D", 5, 16), n("A", 2, 20)]
        result = diff_notes(REFERENCE, attempt)
        assert result["bar_stats"] == [
            {"bar": 1, "reference_count": 3, "matched": 2},
            {"bar": 2, "reference_count": 1, "matched": 0},
        ]
        assert result["summary"]["accuracy"] == 0.5

    @pytest.mark.parametrize("attempt", [
        [],
        [n("C", 4, 0)],
        [n("C", 4, 2), n("E", 4, 4), n("G", 4, 30), n("C", 5, 17), n("C", 5, 33), n("F", 3, 40)],
        [dict(x) for x in REFERENCE],
    ])
    def test_小節ごとの合計は_全体の数と食い違わない(self, attempt):
        reference = REFERENCE + [n("C", 5, 32), n("E", 5, 36), n("G", 3, 70)]
        result = diff_notes(reference, attempt)
        total = sum(row["reference_count"] for row in result["bar_stats"])
        matched = sum(row["matched"] for row in result["bar_stats"])
        assert total == result["summary"]["reference_count"] == len(reference)
        assert result["summary"]["accuracy"] == round(matched / total, 4)
        assert all(0 <= row["matched"] <= row["reference_count"] for row in result["bar_stats"])

    def test_小節は_お手本のノートの位置と拍子で決まる(self):
        # 3 拍子（1 小節 12 ステップ）。打ち込みが隣の小節へずれていても、お手本の小節に数える
        result = diff_notes([n("C", 4, 11), n("D", 4, 12)], [n("C", 4, 12), n("D", 4, 11)], steps_per_bar=12)
        assert result["bar_stats"] == [
            {"bar": 1, "reference_count": 1, "matched": 1},
            {"bar": 2, "reference_count": 1, "matched": 1},
        ]

    def test_範囲で切ったノートを渡しても_小節番号はそのまま(self):
        # 練習画面の区間ループは、区間の中のノートだけを、ステップを変えずに渡す
        reference = [n("C", 4, 64), n("E", 4, 68), n("G", 4, 80)]
        result = diff_notes(reference, [n("C", 4, 64)])
        assert [row["bar"] for row in result["bar_stats"]] == [5, 6]

    def test_ステップが小数でも_小節は整数(self):
        assert coach_diff._bar_of(31.5, 16) == 2 and isinstance(coach_diff._bar_of(31.5, 16), int)
        assert coach_diff._bar_of(32.0, 16) == 3 and isinstance(coach_diff._bar_of(32.0, 16), int)

    def test_強さを比べても_既存の欄は変わらない(self):
        reference = [{**x, "velocity": 100} for x in REFERENCE]
        attempt = [{**x, "velocity": 40} for x in REFERENCE[:3]]
        plain = diff_notes(reference, attempt)
        midi = diff_notes(reference, attempt, reference_source="midi")
        assert midi["bar_stats"] == plain["bar_stats"]
        assert set(plain) == {"summary", "bars", "worst_bars", "velocity", "bar_stats"}
        # 全体の件数（言語化に渡す事実の元）に、小節ごとの数は混ぜない
        assert set(plain["summary"]) == {"reference_count", "attempt_count", "exact", "accuracy", *coach_diff.KINDS}


class TestValidation:
    def test_お手本が空なら比べられない(self):
        with pytest.raises(DiffError, match="お手本のノートがありません"):
            diff_notes([], [n("C", 4, 0)])

    @pytest.mark.parametrize("bad", [
        None, "x", [None], [{"note": "H", "octave": 4, "step": 0, "length": 4}],
        [{"note": "C", "octave": 4.5, "step": 0, "length": 4}],
        [{"note": "C", "octave": 4, "step": -1, "length": 4}],
        [{"note": "C", "octave": 4, "step": 0, "length": 0}],
        [{"note": "C", "octave": 4, "step": True, "length": 4}],
        [{"note": "C", "octave": 4, "step": 0}],
    ])
    def test_形の違うノートは受け付けない(self, bad):
        with pytest.raises(DiffError):
            diff_notes(REFERENCE, bad)
        with pytest.raises(DiffError):
            diff_notes(bad, REFERENCE)

    def test_多すぎるノートは受け付けない(self):
        with pytest.raises(DiffError, match="多すぎます"):
            diff_notes(REFERENCE, [n("C", 4, 0)] * (coach_diff.MAX_NOTES + 1))

    @pytest.mark.parametrize("kwargs", [{"steps_per_bar": 0}, {"steps_per_beat": -1}, {"timing_tolerance": -1}, {"steps_per_bar": 1.5}])
    def test_設定が不正なら失敗(self, kwargs):
        with pytest.raises(DiffError):
            diff_notes(REFERENCE, REFERENCE, **kwargs)


# ドラムの種類ごとの高さ（画面の lib/drums.ts と同じ。差分は高さを種類として扱うだけで、この対応は知らない）
KICK, SNARE, HAT, TOM = ("C", 2), ("D", 2), ("F#", 2), ("A", 2)


def hit(kind, step, length=1):
    return n(kind[0], kind[1], step, length)


# お手本: 1 小節。キックが 1・3 拍、スネアが 2・4 拍、ハイハットが 8 分で 8 つ（キック・スネアと同時に鳴る）
DRUM_REFERENCE = ([hit(KICK, 0), hit(KICK, 8), hit(SNARE, 4), hit(SNARE, 12)]
                  + [hit(HAT, step) for step in range(0, 16, 2)])


class TestDrums:
    """ドラムの比べ方（mode="drums"）: 同じ種類どうしの位置だけを比べる。"""

    def test_同じなら指摘なしで一致率は1(self):
        result = diff_notes(DRUM_REFERENCE, [dict(x) for x in DRUM_REFERENCE], mode="drums")
        assert result["bars"] == [] and result["summary"]["accuracy"] == 1.0
        assert result["summary"]["exact"] == len(DRUM_REFERENCE)

    def test_長さは比べない(self):
        # 打ち込みの長さが、お手本と違っていても（マウスで置くと 4 ステップ）、指摘にならず、ぴったりに数える
        attempt = [hit(kind, x["step"], length=4) for x in DRUM_REFERENCE
                   for kind in [(x["note"], x["octave"])]]
        result = diff_notes(DRUM_REFERENCE, attempt, mode="drums")
        assert kinds(result) == [] and result["summary"]["length"] == 0
        assert result["summary"]["exact"] == len(DRUM_REFERENCE)
        # ふつうの比べ方では、長さの違いになる
        assert diff_notes(DRUM_REFERENCE, attempt)["summary"]["length"] == len(DRUM_REFERENCE)

    def test_種類を間違えた打音は_抜けと余分になる(self):
        # 2 拍目のスネア（D2）を、タムの高さ（A2）と、キックの隣の高さ（C#2）に置いた
        for wrong in (TOM, ("C#", 2), ("D", 3)):
            attempt = [x for x in DRUM_REFERENCE if not (x["note"] == "D" and x["step"] == 4)] + [hit(wrong, 4)]
            result = diff_notes(DRUM_REFERENCE, attempt, mode="drums")
            assert sorted(kinds(result)) == [("extra", 1, 2), ("missing", 1, 2)], wrong
            assert result["summary"]["pitch"] == 0 and result["summary"]["octave"] == 0
        # ふつうの比べ方では、半音となりは高さの違い、オクターブ上はオクターブ違いになる
        near = [x for x in DRUM_REFERENCE if not (x["note"] == "D" and x["step"] == 4)] + [hit(("C#", 2), 4)]
        assert diff_notes(DRUM_REFERENCE, near)["summary"]["pitch"] == 1

    def test_同時に鳴る別の種類は_別々に比べる(self):
        # 1 拍目のキックだけを抜く。同じ位置のハイハットは合っている
        attempt = [x for x in DRUM_REFERENCE if not (x["note"] == "C" and x["step"] == 0)]
        result = diff_notes(DRUM_REFERENCE, attempt, mode="drums")
        assert kinds(result) == [("missing", 1, 1)]
        assert result["bars"][0]["issues"][0]["expected"] == hit(KICK, 0)

    def test_位置のずれは16分音符1個まで(self):
        assert coach_diff.TIMING_TOLERANCE == {"notes": 2, "drums": 1}
        late = diff_notes([hit(SNARE, 4)], [hit(SNARE, 5)], mode="drums")
        assert kinds(late) == [("timing", 1, 2)] and late["summary"]["accuracy"] == 1.0
        assert late["bars"][0]["issues"][0]["offset_steps"] == 1
        # 2 個ずれたら、別の打音（抜けと余分）。ふつうの比べ方では、まだ位置のずれ
        far = diff_notes([hit(SNARE, 4)], [hit(SNARE, 6)], mode="drums")
        assert sorted(kinds(far)) == [("extra", 1, 2), ("missing", 1, 2)] and far["summary"]["accuracy"] == 0.0
        assert kinds(diff_notes([hit(SNARE, 4)], [hit(SNARE, 6)])) == [("timing", 1, 2)]
        # 許容は、渡せば変えられる
        assert kinds(diff_notes([hit(SNARE, 4)], [hit(SNARE, 6)], mode="drums", timing_tolerance=2)) == [("timing", 1, 2)]

    def test_16分で刻むハイハットを半分だけ打っても_隣を取り違えない(self):
        # お手本は 16 分で 16 個。打ち込みは 8 分の裏（奇数のステップ）だけ
        reference = [hit(HAT, step) for step in range(16)]
        attempt = [hit(HAT, step) for step in range(1, 16, 2)]
        result = diff_notes(reference, attempt, mode="drums")
        # 打ったものは全部ぴったり合い、打っていないものだけが抜けになる（位置のずれにも余分にもならない）
        assert result["summary"]["exact"] == 8 and result["summary"]["missing"] == 8
        assert result["summary"]["timing"] == 0 and result["summary"]["extra"] == 0
        assert result["summary"]["accuracy"] == 0.5

    @pytest.mark.parametrize("attempt", [
        [],
        [hit(KICK, 0), hit(SNARE, 5), hit(HAT, 2), hit(TOM, 14)],
        [dict(x) for x in DRUM_REFERENCE],
    ])
    def test_小節ごとの合計と結果の形は_ふつうの比べ方と同じ(self, attempt):
        reference = DRUM_REFERENCE + [hit(KICK, 16), hit(SNARE, 20), hit(KICK, 40)]
        result = diff_notes(reference, attempt, mode="drums")
        assert set(result) == set(diff_notes(reference, attempt))
        assert set(result["summary"]) == set(diff_notes(reference, attempt)["summary"])
        assert result["velocity"] is None
        stats = result["bar_stats"]
        assert [s["bar"] for s in stats] == [1, 2, 3]
        assert sum(s["reference_count"] for s in stats) == result["summary"]["reference_count"] == len(reference)
        assert sum(s["matched"] for s in stats) == round(result["summary"]["accuracy"] * len(reference))
        for issue in (i for bar in result["bars"] for i in bar["issues"]):
            assert issue["kind"] in ("missing", "extra", "timing")

    def test_比べ方を渡さなければ_これまでと同じ(self):
        attempt = [n("C", 4, 1), n("E", 5, 4), n("G", 4, 8, 2)]
        assert diff_notes(REFERENCE, attempt) == diff_notes(REFERENCE, attempt, mode="notes") \
            == diff_notes(REFERENCE, attempt, timing_tolerance=2, mode=None)

    @pytest.mark.parametrize("mode", ["drum", "", 1, ["drums"], {"a": 1}])
    def test_知らない比べ方は受け付けない(self, mode):
        with pytest.raises(DiffError, match="mode"):
            diff_notes(REFERENCE, REFERENCE, mode=mode)


def v(note, octave, step, velocity=None, length=4):
    """強さつきのノート（``velocity`` が None なら、強さを持たないノート）"""
    out = n(note, octave, step, length)
    if velocity is not None:
        out["velocity"] = velocity
    return out


def line(velocities, note="C", octave=3):
    """4 分音符を並べたノート列（1 小節に 4 ノート）。強さは ``velocities`` の順"""
    return [v(note, octave, i * 4, velocity) for i, velocity in enumerate(velocities)]


def findings(result):
    return [(f["kind"], f["direction"], f["start_bar"], f["end_bar"]) for f in result["velocity"]["findings"]]


class TestVelocity:
    """強さ（ベロシティ）の違い。お手本が MIDI ファイルから読み込んだもののときだけ比べる"""

    # お手本: 2 小節。強さは 80 でそろっている
    EVEN = line([80] * 8)

    def test_MIDIのお手本で_強さが同じなら_指摘は無い(self):
        result = diff_notes(self.EVEN, line([80] * 8), reference_source="midi")
        velocity = result["velocity"]
        assert velocity["compared"] == 8 and velocity["weaker"] == 0 and velocity["stronger"] == 0
        assert velocity["findings"] == [] and velocity["notes"] == []
        assert velocity["median_diff"] == 0
        assert velocity["reference"] == velocity["attempt"] == {"min": 80, "max": 80, "median": 80}
        assert velocity["tolerance"] == coach_diff.VELOCITY_TOLERANCE == 16

    @pytest.mark.parametrize("diff, flagged", [(16, 0), (17, 8), (-16, 0), (-17, 8)])
    def test_許す幅の境目(self, diff, flagged):
        """差が 16 までは同じ強さ。17 からが違い"""
        velocity = diff_notes(self.EVEN, line([80 + diff] * 8), reference_source="midi")["velocity"]
        assert velocity["weaker"] + velocity["stronger"] == flagged == len(velocity["notes"])
        assert velocity["weaker"] == (flagged if diff < 0 else 0)
        assert bool(velocity["findings"]) == bool(flagged)

    @pytest.mark.parametrize("source", [None, "transcription", "audio", "", "MIDI", 1, True, ["midi"]])
    def test_採譜のお手本と_出どころの分からないお手本では_強さに触れない(self, source):
        result = diff_notes(self.EVEN, line([20] * 8), reference_source=source)
        assert result["velocity"] is None
        assert result["bars"] == [] and result["summary"]["exact"] == 8

    def test_出どころを渡さなければ_強さに触れない(self):
        assert diff_notes(self.EVEN, line([20] * 8))["velocity"] is None

    @pytest.mark.parametrize("attempt", [
        line([20] * 8),                                                   # 強さだけが違う
        line([127] * 6),                                                  # 抜けも在る
        [v("C", 3, 1, 30), v("D", 3, 4, 30), v("C", 4, 8, 30), v("C", 3, 12, 30, length=2), v("G", 5, 20, 30)],
        [],
    ])
    def test_強さを比べても_一致率も指摘も変わらない(self, attempt):
        plain = diff_notes(self.EVEN, attempt)
        with_velocity = diff_notes(self.EVEN, attempt, reference_source="midi")
        for key in ("summary", "bars", "worst_bars"):
            assert with_velocity[key] == plain[key]
        # 強さを消したノートで比べても同じ（強さは、位置・高さ・長さの突き合わせに入らない）
        stripped = diff_notes([n(x["note"], x["octave"], x["step"], x["length"]) for x in self.EVEN],
                              [n(x["note"], x["octave"], x["step"], x["length"]) for x in attempt])
        assert stripped == plain
        # 指摘のノートに、強さは載せない
        for bar in with_velocity["bars"]:
            for issue in bar["issues"]:
                assert "velocity" not in (issue["expected"] or {}) and "velocity" not in (issue["actual"] or {})

    def test_比べるのは_位置と高さが合った組だけ(self):
        # C3 の 3 つは合う（1 つは位置が 1 ステップずれ）。D3 は高さの違い、5 つ目以降は抜け
        attempt = [v("C", 3, 0, 20), v("C", 3, 5, 20), v("C", 3, 8, 20), v("D", 3, 12, 20)]
        result = diff_notes(self.EVEN, attempt, reference_source="midi")
        assert result["summary"]["pitch"] == 1 and result["summary"]["missing"] == 4
        assert result["velocity"]["compared"] == 3 and result["velocity"]["weaker"] == 3

    def test_強さを持たないノートは_96として比べる(self):
        velocity = diff_notes(line([96] * 4 + [60] * 4), line([None] * 8), reference_source="midi")["velocity"]
        assert velocity["attempt_unset"] == 8 and velocity["default_velocity"] == 96
        assert velocity["attempt"] == {"min": 96, "max": 96, "median": 96}
        assert velocity["stronger"] == 4 and velocity["weaker"] == 0
        assert velocity["notes"][0] == {
            "bar": 2, "beat": 1, "diff": 36,
            "expected": {"note": "C", "octave": 3, "step": 16, "length": 4, "velocity": 60},
            "actual": {"note": "C", "octave": 3, "step": 16, "length": 4, "velocity": 96},
        }

    @pytest.mark.parametrize("value, expected", [("強い", 96), (None, 96), (True, 96), (float("nan"), 96),
                                                 (200, 127), (0, 1), (-5, 1), (63.5, 64), (63.4, 63)])
    def test_強さの形がおかしくても断らない(self, value, expected):
        attempt = [{**note, "velocity": value} for note in line([80] * 8)]
        velocity = diff_notes(self.EVEN, attempt, reference_source="midi")["velocity"]
        assert velocity["attempt"]["max"] == expected
        # 強さを比べないときも、これまでどおり受け付ける
        assert diff_notes(self.EVEN, attempt)["summary"]["exact"] == 8

    def test_全体に弱い(self):
        result = diff_notes(line([100] * 8), line([60] * 8), reference_source="midi")
        assert findings(result) == [("overall", "weaker", 1, 2)]
        finding = result["velocity"]["findings"][0]
        assert (finding["count"], finding["compared"], finding["median_diff"]) == (8, 8, -40)
        assert finding["notes"] == list(range(8))

    def test_全体に強い_は4分の3から(self):
        # 8 ノートのうち 6 ノート（4 分の 3）が強い → 全体に強い。同じ向きの小節の範囲は言い直さない
        result = diff_notes(line([60] * 8), line([100] * 6 + [60] * 2), reference_source="midi")
        assert findings(result) == [("overall", "stronger", 1, 2)]
        # 5 ノートなら全体とは言わず、小節の範囲で言う（1 小節目は 4 ノートとも強い。2 小節目は 4 ノート中 1 つ）
        result = diff_notes(line([60] * 8), line([100] * 5 + [60] * 3), reference_source="midi")
        assert findings(result) == [("section", "stronger", 1, 1)]

    def test_小節の範囲が弱い(self):
        # 4 小節。3〜4 小節だけ弱い
        result = diff_notes(line([90] * 16), line([90] * 8 + [50] * 8), reference_source="midi")
        assert findings(result) == [("section", "weaker", 3, 4)]
        finding = result["velocity"]["findings"][0]
        assert (finding["count"], finding["compared"], finding["median_diff"]) == (8, 8, -40)
        assert [result["velocity"]["notes"][i]["bar"] for i in finding["notes"]] == [3] * 4 + [4] * 4

    def test_離れた小節は_別々の範囲にする(self):
        attempt = line([50] * 4 + [90] * 4 + [50] * 4 + [90] * 4)
        result = diff_notes(line([90] * 16), attempt, reference_source="midi")
        assert findings(result) == [("section", "weaker", 1, 1), ("section", "weaker", 3, 3)]

    def test_1から2ノートだけの違いは_まとまりとして言わない(self):
        result = diff_notes(line([90] * 8), line([90, 40, 90, 90, 90, 90, 127, 90]), reference_source="midi")
        velocity = result["velocity"]
        assert velocity["findings"] == []
        # 数には入る（どのノートかも分かる）
        assert (velocity["weaker"], velocity["stronger"]) == (1, 1)
        assert [(note["bar"], note["beat"], note["diff"]) for note in velocity["notes"]] == [(1, 2, -50), (2, 3, 37)]

    def test_強弱が付いていない(self):
        # お手本は 1 拍目が強く、3 拍目が弱い。打ち込みはマウスで置いた（全部 96）
        reference = line([120, 96, 60, 96] * 2)
        result = diff_notes(reference, line([None] * 8), reference_source="midi")
        assert findings(result) == [("flat", None, 1, 2)]
        finding = result["velocity"]["findings"][0]
        # 違うのは、強いノート 2 つと弱いノート 2 つ
        assert (finding["count"], finding["compared"]) == (4, 8)
        assert result["velocity"]["reference"] == {"min": 60, "max": 120, "median": 96}

    def test_お手本の強さの幅が小さければ_強弱が付いていないとは言わない(self):
        # お手本の幅は 30（許す幅の 2 倍以内）。打ち込みは一定
        result = diff_notes(line([110, 80] * 4), line([96] * 8), reference_source="midi")
        assert result["velocity"]["findings"] == [] and result["velocity"]["notes"] == []

    def test_アクセントが付いていない(self):
        # お手本は各小節の 1 拍目が強い。打ち込みは強弱が在るが、1 拍目が強くない
        reference = line([120, 80, 80, 80] * 4)
        attempt = line([90, 70, 95, 80] * 4)
        result = diff_notes(reference, attempt, reference_source="midi")
        assert findings(result) == [("accent", "weaker", 1, 4)]
        finding = result["velocity"]["findings"][0]
        assert (finding["count"], finding["compared"], finding["median_diff"]) == (4, 4, -30)
        assert [result["velocity"]["notes"][i]["beat"] for i in finding["notes"]] == [1, 1, 1, 1]

    def test_アクセントが1つだけなら言わない(self):
        reference = line([120, 80, 80, 80, 80, 80, 80, 80])
        attempt = line([90, 70, 95, 80, 90, 70, 95, 80])
        result = diff_notes(reference, attempt, reference_source="midi")
        assert result["velocity"]["findings"] == [] and result["velocity"]["weaker"] == 1

    def test_アクセントが付いていれば言わない(self):
        reference = line([120, 80, 80, 80] * 4)
        attempt = line([110, 70, 95, 80] * 4)
        assert diff_notes(reference, attempt, reference_source="midi")["velocity"]["findings"] == []

    def test_全体に弱いときは_アクセントを言い直さない(self):
        reference = line([120, 80, 80, 80] * 4)
        result = diff_notes(reference, line([70, 40, 55, 40] * 4), reference_source="midi")
        assert findings(result) == [("overall", "weaker", 1, 4)]

    def test_合ったノートが無ければ_比べるものが無い(self):
        velocity = diff_notes(self.EVEN, [], reference_source="midi")["velocity"]
        assert velocity["compared"] == 0 and velocity["findings"] == [] and velocity["notes"] == []
        assert velocity["median_diff"] is None and velocity["reference"] is None and velocity["attempt"] is None

    def test_入力を書き換えない(self):
        reference, attempt = line([100] * 4), line([None] * 4)
        diff_notes(reference, attempt, reference_source="midi")
        assert reference == line([100] * 4) and attempt == line([None] * 4)


# 8 分の三連（1 拍を 3 つ）の位置と長さ。1 拍 = 4 ステップなので、4/3 ステップおき
T = 4 / 3


def numbers(value):
    """結果の中の数（bool を除く）を、入れ子をたどって全部取り出す"""
    if isinstance(value, dict):
        return [x for item in value.values() for x in numbers(item)]
    if isinstance(value, list):
        return [x for item in value for x in numbers(item)]
    return [value] if isinstance(value, (int, float)) and not isinstance(value, bool) else []


class TestFractionalSteps:
    """16 分より細かい位置と長さ（三連符・32 分音符）。``step`` と ``length`` は 16 分音符単位のまま、小数を許す"""

    # お手本: 1 小節目の 1〜2 拍に、8 分の三連で C3 を 6 つ
    TRIPLETS = [n("C", 3, i * T, T) for i in range(6)]

    def test_三連どうしは合う(self):
        # 同じ位置を、別の式で作った小数（丸めの誤差が違う）と、桁を切った小数で渡す
        attempt = [n("C", 3, 0, 1.3333), n("C", 3, 1.33333, 4 / 3), n("C", 3, 8 / 3, 1.333333),
                   n("C", 3, 4, T), n("C", 3, 4 + 4 / 3, T), n("C", 3, 20 / 3, T)]
        result = diff_notes(self.TRIPLETS, attempt)
        assert result["bars"] == [] and result["summary"]["exact"] == 6
        assert result["summary"]["accuracy"] == 1.0

    def test_三連の裏と8分の裏の違いは_位置のずれとして指摘する(self):
        # お手本はシャッフル（拍の頭と、三連の 3 つ目）。打ち込みは、裏を 8 分音符の位置（ステップ 2・6）に置いた
        reference = [n("C", 3, 0, T), n("C", 3, 2 * T, T), n("C", 3, 4, T), n("C", 3, 4 + 2 * T, T)]
        attempt = [n("C", 3, 0, T), n("C", 3, 2, T), n("C", 3, 4, T), n("C", 3, 6, T)]
        result = diff_notes(reference, attempt)
        assert kinds(result) == [("timing", 1, 1), ("timing", 1, 2)]
        issue = result["bars"][0]["issues"][0]
        # ずれは 2 − 8/3 = −2/3 ステップ（早い）。1/60 ステップの倍数で返る
        assert issue["offset_steps"] == -40 / 60 and issue["length_diff"] == 0
        assert issue["expected"] == n("C", 3, 160 / 60, 80 / 60) and issue["actual"] == n("C", 3, 2, 80 / 60)
        # 位置のずれは、合っている側に数える（一致率は変わらない）
        assert result["summary"]["accuracy"] == 1.0 and result["summary"]["exact"] == 2

    def test_3分の1ステップの違いは指摘しない(self):
        # 16 分のお手本に対して、三連の隣の位置（1 と 4/3、3 と 8/3）。差は 1/3 ステップ
        reference = [n("C", 3, 0, 1), n("C", 3, 1, 1), n("C", 3, 3, 1)]
        attempt = [n("C", 3, 0, 1), n("C", 3, T, 1), n("C", 3, 2 * T, 1)]
        result = diff_notes(reference, attempt)
        assert result["bars"] == [] and result["summary"]["exact"] == 3
        assert result["summary"]["timing"] == 0 and result["summary"]["accuracy"] == 1.0

    @pytest.mark.parametrize("offset, flagged", [(29 / 60, False), (0.5, True), (-0.5, True), (-29 / 60, False), (1, True)])
    def test_位置のずれの下限は半ステップ(self, offset, flagged):
        assert coach_diff.MIN_TIMING_ISSUE_STEPS == 0.5
        result = diff_notes([n("C", 3, 4)], [n("C", 3, 4 + offset)])
        assert result["summary"]["timing"] == (1 if flagged else 0)
        assert result["summary"]["exact"] == (0 if flagged else 1)

    @pytest.mark.parametrize("length, flagged", [(1, False), (T + 0.4, False), (2, True), (T - 0.5, True), (0.5, True)])
    def test_長さの違いの下限も半ステップ(self, length, flagged):
        # お手本の長さは 4/3（8 分の三連）。16 分音符 1 個（差 1/3）は指摘せず、8 分音符（差 2/3）は指摘する
        assert coach_diff.MIN_LENGTH_ISSUE_STEPS == 0.5
        result = diff_notes([n("C", 3, 0, T)], [n("C", 3, 0, length)])
        assert result["summary"]["length"] == (1 if flagged else 0)

    def test_32分音符の位置と長さを比べられる(self):
        reference = [n("C", 3, 0, 0.5), n("D", 3, 0.5, 0.5), n("E", 3, 1, 0.5), n("F", 3, 1.5, 0.5)]
        result = diff_notes(reference, [n("C", 3, 0, 0.5), n("D", 3, 1, 0.5), n("E", 3, 1, 1), n("F", 3, 1.5, 0.5)])
        assert kinds(result) == [("timing", 1, 1), ("length", 1, 1)]
        assert [issue["offset_steps"] for issue in result["bars"][0]["issues"]] == [0.5, 0]
        assert [issue["length_diff"] for issue in result["bars"][0]["issues"]] == [0, 0.5]

    def test_許容の境目は_小数でも丸めの誤差で変わらない(self):
        # 13/6 と 25/6 の差は、ちょうど 2 ステップ（小数のまま引くと 2.0000000000000004 になり、許容 2 を超える）
        assert 25 / 6 - 13 / 6 > 2
        result = diff_notes([n("C", 3, 13 / 6)], [n("C", 3, 25 / 6)])
        assert kinds(result) == [("timing", 1, 1)] and result["bars"][0]["issues"][0]["offset_steps"] == 2
        # 許容より 1/60 ステップだけ外なら、別の音（抜けと余分）
        result = diff_notes([n("C", 3, 13 / 6)], [n("C", 3, 25 / 6 + 1 / 60)])
        assert sorted(kinds(result)) == [("extra", 1, 2), ("missing", 1, 1)]
        # 0.2 と 0.7 の差は、ちょうど 0.5 ステップ（小数のまま引くと 0.49999999999999994 になり、下限に届かない）
        assert 0.7 - 0.2 < 0.5
        result = diff_notes([n("C", 3, 0.2)], [n("C", 3, 0.7)])
        assert kinds(result) == [("timing", 1, 1)] and result["bars"][0]["issues"][0]["offset_steps"] == 0.5

    def test_値は60分の1ステップの倍数に丸める(self):
        # 1.3333 も 1.33334 も、80/60（= 4/3 にいちばん近い倍精度の値）になる
        result = diff_notes([n("C", 3, 1.3333, 1.33334)], [])
        expected = result["bars"][0]["issues"][0]["expected"]
        assert expected["step"] == expected["length"] == 80 / 60 == 1.3333333333333333
        # 端数がちょうど 0.5（0.375 × 60 = 22.5）なら、大きいほうへ（画面の Math.round と同じ。
        # Python の round は偶数へ丸めるので 22 になる）
        assert diff_notes([n("C", 3, 0.375)], [])["bars"][0]["issues"][0]["expected"]["step"] == 23 / 60

    def test_整数になる値は_整数で返す(self):
        # 小数で渡しても、整数になる値は int（JSON にしたとき 4.0 ではなく 4）
        as_float = [{**x, "step": float(x["step"]), "length": float(x["length"])} for x in REFERENCE]
        attempt = [n("C", 4, 1.0), n("E", 4, 4.0, 8.0), n("G", 5, 8.0), n("A", 3, 24.0)]
        result = diff_notes(as_float, attempt, reference_source="midi")
        assert result == diff_notes(REFERENCE, [n("C", 4, 1), n("E", 4, 4, 8), n("G", 5, 8), n("A", 3, 24)],
                                    reference_source="midi")
        assert all(isinstance(x, int) for x in numbers({key: result[key] for key in ("bars", "worst_bars", "bar_stats")}))
        import json
        assert ".0" not in json.dumps(result["bars"])

    def test_小節と拍は_位置が小数でも整数(self):
        # 2 小節目の 3 拍目の、三連の 3 つ目（ステップ 16 + 8 + 8/3）
        result = diff_notes([n("C", 3, 24 + 2 * T, T)], [], reference_source="midi")
        issue = result["bars"][0]["issues"][0]
        assert (issue["bar"], issue["beat"]) == (2, 3)
        assert isinstance(issue["bar"], int) and isinstance(issue["beat"], int)
        assert result["worst_bars"] == [2] and result["bar_stats"] == [{"bar": 2, "reference_count": 1, "matched": 0}]

    @pytest.mark.parametrize("attempt", [
        [],
        [n("C", 3, i * T, T) for i in range(0, 24, 2)],
        [n("C", 3, i * T + 1 / 3, T) for i in range(24)],
        [n("C", 3, i, 1) for i in range(32)],
    ])
    def test_小節ごとの合計は_全体の数と食い違わない(self, attempt):
        # 2 小節ぶんの三連（1 小節に 12 個）と、3 小節目の頭
        reference = [n("C", 3, i * T, T) for i in range(24)] + [n("C", 3, 32, T)]
        result = diff_notes(reference, attempt)
        assert [row["bar"] for row in result["bar_stats"]] == [1, 2, 3]
        assert [row["reference_count"] for row in result["bar_stats"]] == [12, 12, 1]
        matched = sum(row["matched"] for row in result["bar_stats"])
        assert result["summary"]["accuracy"] == round(matched / 25, 4)
        assert all(isinstance(row["bar"], int) for row in result["bar_stats"])

    def test_ドラムの比べ方でも_三連の位置を比べられる(self):
        # シャッフルのハイハット（拍の頭と三連の 3 つ目）とキック
        reference = [hit(HAT, beat * 4 + offset, T) for beat in range(4) for offset in (0, 2 * T)] + [hit(KICK, 0), hit(KICK, 8)]
        same = diff_notes(reference, [dict(x) for x in reference], mode="drums")
        assert same["bars"] == [] and same["summary"]["accuracy"] == 1.0
        # 裏を 8 分音符の位置（ステップ 2、6、…）に打つと、位置のずれ（2/3 ステップ。許容 1 の内側）
        straight = [hit(HAT, beat * 4 + offset) for beat in range(4) for offset in (0, 2)] + [hit(KICK, 0), hit(KICK, 8)]
        result = diff_notes(reference, straight, mode="drums")
        assert result["summary"]["timing"] == 4 and result["summary"]["missing"] == result["summary"]["extra"] == 0
        # 16 分の隣（3 と 8/3。差は 1/3）は、ずれにしない。長さは比べない
        near = [hit(HAT, beat * 4 + offset) for beat in range(4) for offset in (0, 3)] + [hit(KICK, 0), hit(KICK, 8)]
        assert diff_notes(reference, near, mode="drums")["bars"] == []

    def test_強さの違いも_小数の位置で比べられる(self):
        reference = [{**x, "velocity": 100} for x in self.TRIPLETS]
        attempt = [{**x, "velocity": 50} for x in self.TRIPLETS]
        velocity = diff_notes(reference, attempt, reference_source="midi")["velocity"]
        assert velocity["compared"] == 6 and velocity["weaker"] == 6
        assert [(note["bar"], note["beat"]) for note in velocity["notes"]] == [(1, 1)] * 3 + [(1, 2)] * 3
        assert velocity["notes"][1]["expected"] == {**n("C", 3, 80 / 60, 80 / 60), "velocity": 100}

    @pytest.mark.parametrize("bad", [
        {"step": float("nan")}, {"step": float("inf")}, {"step": -0.5}, {"step": 1e308}, {"step": "1.5"},
        {"length": float("nan")}, {"length": float("inf")}, {"length": -1.5}, {"length": 0.0},
        # 丸めると 0 になる長さ（1/120 ステップより短い）
        {"length": 0.001}, {"length": False},
    ])
    def test_数でない値と_負の位置と_0以下の長さは受け付けない(self, bad):
        note = {**n("C", 3, 0), **bad}
        with pytest.raises(DiffError, match="形式が正しくありません"):
            diff_notes([note], [])
        with pytest.raises(DiffError, match="形式が正しくありません"):
            diff_notes(REFERENCE, [note])

    def test_入力を書き換えない(self):
        reference, attempt = [n("C", 3, 1.3333, 1.3333)], [n("C", 3, 4.0, 2.0)]
        diff_notes(reference, attempt)
        assert reference == [n("C", 3, 1.3333, 1.3333)] and attempt == [n("C", 3, 4.0, 2.0)]
        assert isinstance(attempt[0]["step"], float)


class TestApi:
    @pytest.fixture
    def client(self):
        from web.api import app

        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.mark.asyncio
    async def test_小数の位置と長さのノートが通る(self, client):
        # 画面は、三連符や 32 分音符のノートを、16 分音符単位の小数で送る
        reference = [n("C", 3, 0, T), n("C", 3, 2 * T, T), n("C", 3, 4, 0.5)]
        attempt = [n("C", 3, 0, T), n("C", 3, 2, T), n("C", 3, 4, 0.5)]
        resp = await client.post("/api/coach/diff", json={"reference": reference, "attempt": attempt})
        assert resp.status_code == 200
        body = resp.json()
        assert body["summary"]["timing"] == 1 and body["summary"]["exact"] == 2
        issue = body["bars"][0]["issues"][0]
        assert issue["offset_steps"] == -40 / 60 and issue["expected"]["step"] == 160 / 60
        # 整数になる値は、JSON でも整数のまま
        assert '"step":2,' in resp.text.replace(" ", "") and '"step":2.0' not in resp.text.replace(" ", "")
        # ドラムの比べ方でも通る。数でない位置は、これまでどおり 400
        assert (await client.post("/api/coach/diff", json={"reference": reference, "attempt": attempt,
                                                           "mode": "drums"})).status_code == 200
        bad = await client.post("/api/coach/diff", json={"reference": reference, "attempt": [n("C", 3, "1.5")]})
        assert bad.status_code == 400

    @pytest.mark.asyncio
    async def test_差分を返す(self, client):
        resp = await client.post("/api/coach/diff", json={"reference": REFERENCE, "attempt": REFERENCE[:3]})
        assert resp.status_code == 200
        body = resp.json()
        assert body["summary"]["missing"] == 1
        assert body["bars"][0]["bar"] == 2

    @pytest.mark.asyncio
    async def test_不正な入力は400で理由を返す(self, client):
        resp = await client.post("/api/coach/diff", json={"reference": [], "attempt": []})
        assert resp.status_code == 400
        assert "お手本" in resp.json()["detail"]
        resp = await client.post("/api/coach/diff", json={"reference": REFERENCE, "attempt": [{"note": "H"}]})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_ドラムの比べ方を渡すと_種類ごとの位置だけを比べる(self, client):
        # スネアを 1 つ、長さ違いで 1 ステップ遅く置き、キックを 1 つタムの高さに置いた
        attempt = [hit(KICK, 0), hit(TOM, 8), hit(SNARE, 5, length=4), hit(SNARE, 12)] \
            + [hit(HAT, step) for step in range(0, 16, 2)]
        body = {"reference": DRUM_REFERENCE, "attempt": attempt}
        drums = (await client.post("/api/coach/diff", json={**body, "mode": "drums"})).json()
        assert sorted(kinds(drums)) == [("extra", 1, 3), ("missing", 1, 3), ("timing", 1, 2)]
        assert drums["summary"]["accuracy"] == round(11 / 12, 4)
        # 渡さなければ、ふつうの比べ方（長さの違いが出る）
        plain = (await client.post("/api/coach/diff", json=body)).json()
        assert plain["summary"]["length"] == 1
        resp = await client.post("/api/coach/diff", json={**body, "mode": "nope"})
        assert resp.status_code == 400 and "mode" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_MIDIのお手本と伝えたときだけ_強さを比べる(self, client):
        reference = line([100] * 8)
        attempt = line([60] * 8)
        body = {"reference": reference, "attempt": attempt}
        plain = (await client.post("/api/coach/diff", json=body)).json()
        assert plain["velocity"] is None
        for source in ("transcription", "", None, 3, ["midi"]):
            resp = await client.post("/api/coach/diff", json={**body, "reference_source": source})
            assert resp.status_code == 200 and resp.json() == plain
        midi = (await client.post("/api/coach/diff", json={**body, "reference_source": "midi"})).json()
        assert midi["velocity"]["findings"][0]["kind"] == "overall"
        assert {key: midi[key] for key in ("summary", "bars", "worst_bars")} == \
            {key: plain[key] for key in ("summary", "bars", "worst_bars")}
