"""ノートの位置と長さの数の決まり（note_steps）のテスト

``step`` と ``length`` は 16 分音符単位の小数で、1/60 ステップの倍数に丸めて持つ。画面の
``Math.round(x * 60) / 60`` と同じ値になること、整数になる値が整数で返ることを確かめる。
"""
import pytest

import note_steps


class TestNormalize:
    def test_60分の1ステップの倍数に丸める(self):
        assert note_steps.STEP_DIVISIONS == 60
        # 8 分の三連（4/3）・16 分の三連（2/3）・32 分音符（0.5）は、刻みの上に乗る
        assert note_steps.normalize(4 / 3) == 80 / 60 == 1.3333333333333333
        assert note_steps.normalize(2 / 3) == 40 / 60
        assert note_steps.normalize(0.5) == 0.5
        # 桁を切った小数も、同じ値になる
        assert note_steps.normalize(1.3333) == note_steps.normalize(1.33334) == 80 / 60
        # 1/120 ステップより小さい違いは、同じ値
        assert note_steps.normalize(4.008) == 4 and note_steps.normalize(4.009) == 241 / 60

    @pytest.mark.parametrize("value, expected", [(0, 0), (4, 4), (4.0, 4), (15.999999, 16), (-3, -3), (10 ** 18, 10 ** 18)])
    def test_整数になる値は_整数で返す(self, value, expected):
        result = note_steps.normalize(value)
        assert result == expected and isinstance(result, int)

    @pytest.mark.parametrize("value, ticks", [
        # 端数がちょうど 0.5 のときは、大きいほうへ（JavaScript の Math.round と同じ。Python の round は偶数へ丸める）
        (0.375, 23), (0.125, 8), (0.025, 2), (-0.125, -7), (-0.375, -22),
        (0.49 / 60, 0), (0.51 / 60, 1), (-0.49 / 60, 0),
    ])
    def test_丸め方は_画面のMath_roundと同じ(self, value, ticks):
        assert note_steps.to_ticks(value) == ticks

    @pytest.mark.parametrize("bad", [None, "1.5", True, False, float("nan"), float("inf"), float("-inf"), 1e308, [1], {}])
    def test_数でない値は_None(self, bad):
        assert note_steps.to_ticks(bad) is None and note_steps.normalize(bad) is None

    def test_刻みの数との往復(self):
        for ticks in (0, 1, 20, 30, 59, 60, 80, 160, 961, -40):
            value = note_steps.from_ticks(ticks)
            assert note_steps.to_ticks(value) == ticks
            assert isinstance(value, int) == (ticks % 60 == 0)
        # 小数のまま引くと誤差が出る差も、刻みの数なら正確（25/6 − 13/6 = 2、0.7 − 0.2 = 0.5）
        assert 25 / 6 - 13 / 6 > 2 and 0.7 - 0.2 < 0.5
        assert note_steps.from_ticks(note_steps.to_ticks(25 / 6) - note_steps.to_ticks(13 / 6)) == 2
        assert note_steps.from_ticks(note_steps.to_ticks(0.7) - note_steps.to_ticks(0.2)) == 0.5
