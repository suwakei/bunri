"""ノートの位置と長さ（``step`` / ``length``）の数の決まり

ノートの ``step`` と ``length`` は 16 分音符単位（1 = 16 分音符）で、小数を許す
（0.5 = 32 分音符、4/3 = 8 分の三連、2/3 = 16 分の三連）。値は **1/60 ステップの倍数に丸めて** 持つ。
60 は 3・4・5 のどれでも割れるので、三連符・32 分・64 分・5 連符が、どれも刻みの上に乗る。

- 丸め方は、画面の ``Math.round(x * 60) / 60`` と同じ（0.5 は切り上げ。Python の ``round`` は偶数へ丸めるので使わない）。
  どちらも「整数 ÷ 60」の割り算 1 回なので、同じ倍精度の値になる
- **整数になる値は、整数（``int``）で返す**（``4.0`` ではなく ``4``）。整数だけのノートから作る結果・保存・
  Claude に渡す事実が、小数を許す前と 1 文字も変わらないようにするため
- 比べるときは、刻みの数（整数）に直してから比べる（``to_ticks``）。小数のまま引き算すると、
  ``25/6 - 13/6`` が 2.0000000000000004、``0.7 - 0.2`` が 0.49999999999999994 になるような誤差が、
  許容や指摘の下限の境目で効いてしまう

差分（``coach_diff``）・保存（``bunri_file`` ``project_store``）・採譜（``decompose``）が、同じ関数を使う。
"""

# 1 ステップ（16 分音符）を、いくつに割って持つか
STEP_DIVISIONS = 60


def to_ticks(value):
    """位置や長さ（ステップ）を、刻みの数（1/60 ステップ単位の整数）に直す。

    Args:
        value: ステップ（整数か小数）。

    Returns:
        int | None: 刻みの数。数でない・bool・NaN・無限なら None。
    """
    from math import floor, isfinite

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, int):
        return value * STEP_DIVISIONS
    scaled = value * STEP_DIVISIONS
    if not isfinite(scaled):
        return None
    # Math.round と同じ丸め方（端数がちょうど 0.5 なら、大きいほうへ）
    whole = floor(scaled)
    return whole + 1 if scaled - whole >= 0.5 else whole


def from_ticks(ticks):
    """刻みの数を、ステップに戻す。整数になる値は ``int``、そうでなければ ``float``。"""
    whole, rest = divmod(ticks, STEP_DIVISIONS)
    return whole if rest == 0 else ticks / STEP_DIVISIONS


def normalize(value):
    """位置や長さ（ステップ）を、1/60 ステップの倍数に丸める。

    Args:
        value: ステップ（整数か小数）。

    Returns:
        int | float | None: 丸めた値（整数になる値は ``int``）。数でない・bool・NaN・無限なら None。
    """
    ticks = to_ticks(value)
    return None if ticks is None else from_ticks(ticks)
