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

    def test_三連のグリッドでは_1拍を3つに割った位置に丸める(self):
        from decompose import seconds_to_step
        # 120 BPM の 1 拍は 0.5 秒。三連の 2 つ目は 1/6 秒、3 つ目は 1/3 秒（ステップでは 4/3、8/3）
        assert seconds_to_step(0.0, 0.125, grid_feel="triplet") == 0
        assert seconds_to_step(0.17, 0.125, grid_feel="triplet") == 80 / 60
        assert seconds_to_step(0.33, 0.125, grid_feel="triplet") == 160 / 60
        # 拍の頭は整数で返す（16 分のグリッドの値と同じ）
        beat = seconds_to_step(0.51, 0.125, grid_feel="triplet")
        assert beat == 4 and isinstance(beat, int)
        # 16 分の裏（0.375 秒 = ステップ 3）は、近いほうの三連の位置（8/3）になる
        assert seconds_to_step(0.375, 0.125, grid_feel="triplet") == 160 / 60
        # 1 小節目の位置から数え、それより前の音は置かない
        assert seconds_to_step(0.75 + 1 / 6, 0.125, offset_sec=0.75, grid_feel="triplet") == 80 / 60
        assert seconds_to_step(0.5, 0.125, offset_sec=0.75, grid_feel="triplet") is None

    def test_渡さなければ_これまでどおり16分に丸めて整数を返す(self):
        from decompose import seconds_to_step
        for sec in (0.0, 0.17, 0.33, 0.51, 1.06):
            step = seconds_to_step(sec, 0.125)
            assert step == seconds_to_step(sec, 0.125, grid_feel="straight") and isinstance(step, int)

    def test_長さも同じグリッドに丸める(self):
        from decompose import seconds_to_length
        # 16 分: 1 以上の整数（これまでと同じ）
        assert [seconds_to_length(sec, 0.125) for sec in (0.01, 0.125, 0.2, 0.5)] == [1, 1, 2, 4]
        assert all(isinstance(seconds_to_length(sec, 0.125), int) for sec in (0.01, 0.2))
        # 三連: 4/3 の倍数（いちばん短くて 4/3）。1 拍ぶんは整数の 4
        assert [seconds_to_length(sec, 0.125, "triplet") for sec in (0.01, 0.17, 0.3, 0.5)] == [80 / 60, 80 / 60, 160 / 60, 4]


def _beat_onsets(offsets, bars=8, bpm=120, jitter_ms=0.0, seed=0, shift=0.0, drift=0.0, keep=1.0):
    """1 拍の中の位置（ステップ）``offsets`` を、毎拍くり返したときの音の始まり（秒）。

    ``jitter_ms`` は 1 音ごとの揺らぎ（標準偏差。ミリ秒）、``shift`` は全体の遅れ（秒）、``drift`` はテンポの誤差
    （0.005 = 0.5%。後ろほどずれる）、``keep`` は拍の頭でない音を残す割合。
    """
    rng = np.random.default_rng(seed)
    step = 60 / bpm / 4
    positions = [beat * 4 + offset for beat in range(bars * 4) for offset in offsets
                 if offset == 0 or rng.random() < keep]
    times = np.array(positions) * step * (1 + drift) + shift
    return list(times + rng.normal(0, jitter_ms / 1000, len(times)))


# 1 拍の中の位置（ステップ）。三連は 4/3 おき、シャッフルは拍の頭と三連の 3 つ目
TRIPLET, SHUFFLE = [0, 4 / 3, 8 / 3], [0, 8 / 3]


class TestGridFeel:
    """採譜のグリッドの見分け（16 分か、三連か）。合成した音の始まりで、取り違えないことを確かめる

    ふつうの曲を三連と取り違えるほうが害が大きいので、迷うときは 16 分になる（docs/coach-diff-design.md
    「採譜のグリッド（16 分か、三連か）」）。
    """

    def _feel(self, onsets, bpm=120, offset_sec=0.0):
        from decompose import detect_grid_feel
        parts = onsets if isinstance(onsets, dict) else {"drums": onsets}
        return detect_grid_feel(parts, 60 / bpm / 4, offset_sec)["grid_feel"]

    @pytest.mark.parametrize("bpm", [70, 100, 120, 150])
    @pytest.mark.parametrize("offsets", [TRIPLET, SHUFFLE])
    def test_三連の刻みとシャッフルは_三連(self, offsets, bpm):
        # 揺らぎは 6 ミリ秒（オンセット検出の刻みの幅ぶん）
        for seed in range(5):
            assert self._feel(_beat_onsets(offsets, bpm=bpm, jitter_ms=6, seed=seed), bpm) == "triplet"

    @pytest.mark.parametrize("bpm", [70, 100, 120, 150])
    @pytest.mark.parametrize("jitter_ms", [0, 6, 15, 30])
    @pytest.mark.parametrize("offsets", [
        [0, 2],                      # 8 分
        [0, 1, 2, 3],                # 16 分
        [0, 2, 3],                   # タッタタ
        [0, 3],                      # 付点 8 分 + 16 分
        [0],                         # 4 分だけ（どちらのグリッドにも合う）
        [0, 1 + 1 / 3, 2, 3 + 1 / 3],  # 16 分のスウィング（8 分の裏は、ふつうの位置）
        [0, 2.3],                    # 軽いスウィング（裏が 57.5% の位置。三連は 66.7%）
        [0, 2 / 3, 4 / 3, 2, 8 / 3, 10 / 3],  # 16 分の三連（1 拍 6 つ。見分けの対象にしていない）
    ])
    def test_ふつうの刻みは_揺らいでいても三連にしない(self, offsets, jitter_ms, bpm):
        for seed in range(5):
            assert self._feel(_beat_onsets(offsets, bpm=bpm, jitter_ms=jitter_ms, seed=seed), bpm) == "straight"

    def test_抜けの多い16分も_三連にしない(self):
        for seed in range(10):
            assert self._feel(_beat_onsets([0, 1, 2, 3], jitter_ms=10, seed=seed, keep=0.5)) == "straight"

    def test_でたらめな位置の音は_三連にしない(self):
        for seed in range(10):
            rng = np.random.default_rng(seed)
            assert self._feel(list(rng.uniform(0, 16, 200))) == "straight"

    def test_音が少なければ判定しない(self):
        from decompose import GRID_FEEL_MIN_ONSETS, detect_grid_feel
        assert GRID_FEEL_MIN_ONSETS == 32
        # 三連で 2 小節（24 個）。きれいに三連でも、16 分のまま
        few = detect_grid_feel({"drums": _beat_onsets(TRIPLET, bars=2)}, 0.125)
        assert few["onsets"] == 24 and few["grid_feel"] == "straight"
        assert few["triplet_error"] < 0.01 < few["straight_error"]
        # 3 小節（36 個）からは判定する
        assert self._feel(_beat_onsets(TRIPLET, bars=3)) == "triplet"
        # 音が無い
        assert detect_grid_feel({}, 0.125) == {"grid_feel": "straight", "onsets": 0,
                                               "straight_error": None, "triplet_error": None}

    def test_揺らぎの大きい三連は_16分に倒す(self):
        # 120 BPM で 30 ミリ秒の揺らぎ（1 ステップの 4 分の 1）。三連と言い切れないので、これまでどおり 16 分
        for seed in range(5):
            assert self._feel(_beat_onsets(SHUFFLE, jitter_ms=30, seed=seed)) == "straight"

    def test_三連と16分が半々の曲は_16分に倒す(self):
        half = _beat_onsets(TRIPLET, bars=8, jitter_ms=6)
        rest = [t + 16.0 for t in _beat_onsets([0, 1, 2, 3], bars=8, jitter_ms=6, seed=1)]
        assert self._feel(half + rest) == "straight"
        # ほとんど（16 小節のうち 15 小節）が三連なら、三連
        mostly = _beat_onsets(TRIPLET, bars=15, jitter_ms=6) + [t + 30.0 for t in _beat_onsets([0, 1, 2, 3], bars=1)]
        assert self._feel(mostly) == "triplet"

    def test_全体の遅れとテンポの小さな誤差では_判定が変わらない(self):
        # オンセット検出の遅れ・1 拍目の位置の誤差（40 ミリ秒）と、テンポの誤差（0.5%。16 小節で 16 分音符 1 個強ずれる）
        for seed in range(5):
            kwargs = dict(bars=16, jitter_ms=6, seed=seed, shift=0.04, drift=0.005)
            assert self._feel(_beat_onsets(SHUFFLE, **kwargs)) == "triplet"
            assert self._feel(_beat_onsets(TRIPLET, **kwargs)) == "triplet"
            assert self._feel(_beat_onsets([0, 2], **kwargs)) == "straight"
            assert self._feel(_beat_onsets([0, 1, 2, 3], **kwargs)) == "straight"

    def test_1拍目の位置から数え_それより前の音は数えない(self):
        from decompose import detect_grid_feel
        onsets = [t + 0.75 for t in _beat_onsets(SHUFFLE, bars=4)]
        result = detect_grid_feel({"drums": [0.1, 0.2, 0.3] + onsets}, 0.125, offset_sec=0.75)
        assert result["onsets"] == 32 and result["grid_feel"] == "triplet"

    def test_同時に鳴った音は_1つに数える(self):
        from decompose import detect_grid_feel
        # 和音（同じ時刻の 3 音）と、キックとハイハット（0.01 秒ずれ）
        onsets = _beat_onsets(TRIPLET, bars=2)
        result = detect_grid_feel({"piano": onsets * 3, "drums": onsets + [t + 0.01 for t in onsets]}, 0.125)
        assert result["onsets"] == 48

    def test_曲全体で1つに決める_揺れの大きいパートも同じグリッドになる(self):
        # シャッフルの曲: ドラムとベースは揃っていて、ボーカルは揺れが大きく、ピアノは拍の頭だけ
        song = {
            "drums": _beat_onsets(SHUFFLE, bars=16, jitter_ms=5, seed=1),
            "bass": _beat_onsets(SHUFFLE, bars=16, jitter_ms=10, seed=2, keep=0.5),
            "vocals": _beat_onsets(TRIPLET, bars=16, jitter_ms=25, seed=3, keep=0.5),
            "piano": _beat_onsets([0], bars=16, jitter_ms=10, seed=4),
        }
        assert self._feel(song) == "triplet"
        # パートごとに決めると、ボーカルとピアノは 16 分になり、パートどうしでグリッドが食い違う
        assert self._feel({"vocals": song["vocals"]}) == "straight"
        assert self._feel({"piano": song["piano"]}) == "straight"

    def test_1つのパートだけが三連の曲は_16分のまま(self):
        # ふつうの 8 分の曲で、ギターだけが三連のフレーズを弾いている（曲全体で決めるので、16 分に倒れる）
        song = {
            "drums": _beat_onsets([0, 2], bars=16, jitter_ms=5, seed=1),
            "bass": _beat_onsets([0, 2], bars=16, jitter_ms=10, seed=2),
            "guitar": _beat_onsets(TRIPLET, bars=16, jitter_ms=8, seed=3),
        }
        assert self._feel(song) == "straight"

    def test_パートごとに採譜の遅れが違っても_判定が変わらない(self):
        # ドラム（オンセット検出）とベース（basic-pitch）で、遅れが 30 ミリ秒ちがう
        song = {
            "drums": _beat_onsets(SHUFFLE, bars=8, jitter_ms=5, seed=1, shift=0.03),
            "bass": _beat_onsets(SHUFFLE, bars=8, jitter_ms=5, seed=2),
        }
        assert self._feel(song) == "triplet"
        straight = {
            "drums": _beat_onsets([0, 1, 2, 3], bars=8, jitter_ms=5, seed=1, shift=0.03),
            "bass": _beat_onsets([0, 2], bars=8, jitter_ms=5, seed=2),
        }
        assert self._feel(straight) == "straight"


# ---- ドラムの採譜（種類ごとに分けた音声から） ----

DRUM_SR = 22050
# 120 BPM の 16 分音符（1 ステップ）は 0.125 秒
STEP = 0.125


def _drum_hit(kind):
    """ドラムの打音 1 つぶんの波形（合成）。キックは下がるサイン波、スネアはノイズ + 短い音、ハイハットは高域のノイズ。"""
    rng = np.random.default_rng(7)
    if kind == "kick":
        t = np.arange(int(0.18 * DRUM_SR)) / DRUM_SR
        freq = 50 + 90 * np.exp(-t * 30)
        return np.sin(2 * np.pi * np.cumsum(freq) / DRUM_SR) * np.exp(-t * 22)
    if kind == "snare":
        t = np.arange(int(0.12 * DRUM_SR)) / DRUM_SR
        return (0.7 * rng.standard_normal(len(t)) + 0.5 * np.sin(2 * np.pi * 190 * t)) * np.exp(-t * 35) * 0.6
    if kind == "toms":
        t = np.arange(int(0.2 * DRUM_SR)) / DRUM_SR
        freq = 110 + 60 * np.exp(-t * 20)
        return np.sin(2 * np.pi * np.cumsum(freq) / DRUM_SR) * np.exp(-t * 16)
    # ハイハット・シンバル: 高域だけのノイズ（差分を取って低域を落とす）
    t = np.arange(int(0.05 * DRUM_SR)) / DRUM_SR
    noise = np.diff(rng.standard_normal(len(t) + 1))
    return noise / np.max(np.abs(noise)) * np.exp(-t * 90)


def _drum_track(hits, total=2.5):
    """``hits``（``(種類, 秒, 振幅)`` の並び）を置いた、ドラムの音声の配列。"""
    data = np.zeros(int(total * DRUM_SR), dtype=np.float32)
    for kind, sec, amp in hits:
        wave = _drum_hit(kind) * amp
        i = int(sec * DRUM_SR)
        data[i:i + len(wave)] += wave[:len(data) - i].astype(np.float32)
    return data


def _write_drums(path, hits, total=2.5):
    import soundfile as sf
    sf.write(str(path), _drum_track(hits, total), DRUM_SR)
    return str(path)


def _steps(events, kind):
    return [e["step"] for e in events if e["type"] == kind]


# 1 小節のパターン（ステップ）: キックが 1・3 拍、スネアが 2・4 拍、ハイハットが 8 分
KICK_STEPS, SNARE_STEPS, HAT_STEPS = [0, 8], [4, 12], list(range(0, 16, 2))


def _pattern_stems(tmp_path, kick_extra=(), toms=None):
    """種類ごとに分けたステムの WAV を書いて、``transcribe_drum_stems`` に渡す形で返す。"""
    stems = {
        "kick": _write_drums(tmp_path / "kick.wav", [("kick", s * STEP, 0.8) for s in KICK_STEPS] + list(kick_extra)),
        "snare": _write_drums(tmp_path / "snare.wav", [("snare", s * STEP, 0.7) for s in SNARE_STEPS]),
        "cymbals": _write_drums(tmp_path / "cymbals.wav", [("hat", s * STEP, 0.3) for s in HAT_STEPS]),
    }
    if toms is not None:
        stems["toms"] = _write_drums(tmp_path / "toms.wav", toms)
    return stems


class TestTranscribeDrumStems:
    """種類ごとに分けた音声からの採譜。合成した音源（打音の位置が分かっている）で確かめる。"""

    def test_種類ごとに_決まった位置のイベントになる(self, tmp_path):
        from decompose import transcribe_drum_stems
        events = transcribe_drum_stems(_pattern_stems(tmp_path), bpm=120)
        assert _steps(events, "kick") == KICK_STEPS
        assert _steps(events, "snare") == SNARE_STEPS
        assert _steps(events, "cymbals") == HAT_STEPS
        assert all(set(e) == {"type", "step", "velocity"} and 1 <= e["velocity"] <= 127 for e in events)
        # ステップ順に並ぶ
        assert [e["step"] for e in events] == sorted(e["step"] for e in events)

    def test_同時に鳴った種類が_両方出る(self, tmp_path):
        from decompose import transcribe_drum_stems, transcribe_drums
        stems = _pattern_stems(tmp_path)
        events = transcribe_drum_stems(stems, bpm=120)
        at = lambda step: sorted(e["type"] for e in events if e["step"] == step)  # noqa: E731
        assert at(0) == ["cymbals", "kick"] and at(4) == ["cymbals", "snare"]
        # これまでの振り分け（混ざった 1 本の音から）は、1 つの位置に 1 つの種類しか出せない
        mixed = _write_drums(tmp_path / "mixed.wav", [("kick", s * STEP, 0.8) for s in KICK_STEPS]
                             + [("snare", s * STEP, 0.7) for s in SNARE_STEPS] + [("hat", s * STEP, 0.3) for s in HAT_STEPS])
        spectral = transcribe_drums(mixed, bpm=120)
        assert len({e["step"] for e in spectral}) == len(spectral)

    def test_1拍目の位置から数える(self, tmp_path):
        from decompose import transcribe_drum_stems
        # 曲頭に 0.75 秒の間が在る。その前の打音（弱起）は置かない
        stems = {"kick": _write_drums(tmp_path / "kick.wav", [("kick", 0.25, 0.8), ("kick", 0.75, 0.8), ("kick", 1.75, 0.8)])}
        assert _steps(transcribe_drum_stems(stems, bpm=120, offset_sec=0.75), "kick") == [0, 8]

    def test_漏れ込んだ別の種類は_その種類の打音にしない(self, tmp_path):
        from decompose import transcribe_drum_stems
        # キックのステムに、スネアが薄く（−20 dB）残っている
        leak = [("snare", s * STEP, 0.07) for s in SNARE_STEPS]
        events = transcribe_drum_stems(_pattern_stems(tmp_path, kick_extra=leak), bpm=120)
        assert _steps(events, "kick") == KICK_STEPS
        assert _steps(events, "snare") == SNARE_STEPS

    def test_本物の打音が無いステムの漏れ込みは_影として捨てる(self, tmp_path):
        from decompose import transcribe_drum_stems
        # タムのステムに在るのは、スネアの薄い残りだけ（曲にタムは無い）
        shadow = [("snare", s * STEP, 0.08) for s in SNARE_STEPS]
        events = transcribe_drum_stems(_pattern_stems(tmp_path, toms=shadow), bpm=120)
        assert _steps(events, "toms") == []
        assert _steps(events, "snare") == SNARE_STEPS

    def test_ほかの種類と重ならないタムは_小さくても残す(self, tmp_path):
        from decompose import transcribe_drum_stems
        # スネアよりずっと小さいが、スネアの無い位置で鳴っている（フィル）
        fill = [("toms", s * STEP, 0.1) for s in (13, 14, 15)]
        events = transcribe_drum_stems(_pattern_stems(tmp_path, toms=fill), bpm=120)
        assert _steps(events, "toms") == [13, 14, 15]

    def test_ハイハットは_キックやスネアと同時でずっと小さくても残す(self, tmp_path):
        from decompose import transcribe_drum_stems
        # 4 分で刻むハイハット（どれもキックかスネアと同時）。シンバルは「影」の判定をしない
        stems = _pattern_stems(tmp_path)
        stems["cymbals"] = _write_drums(tmp_path / "quarter.wav", [("hat", s * STEP, 0.05) for s in (0, 4, 8, 12)])
        assert _steps(transcribe_drum_stems(stems, bpm=120), "cymbals") == [0, 4, 8, 12]

    def test_残響の2つ目の山を_2度打ちに数えない(self, tmp_path):
        from decompose import transcribe_drum_stems
        # 打音の 0.04 秒あとに、弱い 2 つ目の山（フラムや響き）が在る
        echo = [("snare", s * STEP + 0.04, 0.4) for s in SNARE_STEPS]
        stems = {"snare": _write_drums(tmp_path / "snare.wav", [("snare", s * STEP, 0.7) for s in SNARE_STEPS] + echo)}
        assert _steps(transcribe_drum_stems(stems, bpm=120), "snare") == SNARE_STEPS

    def test_無音のステムからは何も出ない(self, tmp_path):
        from decompose import transcribe_drum_stems
        assert transcribe_drum_stems({"kick": _write_drums(tmp_path / "silent.wav", [])}, bpm=120) == []


class TestDrumHits:
    """打音（秒と大きさ）の後処理。音声を通さずに、決まりだけを確かめる。"""

    def test_近すぎる打音は1つにまとめ_強いほうを残す(self):
        from decompose import DRUM_MIN_INTERVAL_SEC, _merge_close_hits
        assert DRUM_MIN_INTERVAL_SEC == 0.05
        hits = [(1.00, 0.5), (1.03, 0.9), (1.10, 0.4), (1.16, 0.2)]
        assert _merge_close_hits(hits) == [(1.03, 0.9), (1.10, 0.4), (1.16, 0.2)]

    def test_32分音符の連打は_別の打音のまま(self):
        from decompose import _merge_close_hits
        # 120 BPM の 32 分音符は 0.0625 秒
        roll = [(i * 0.0625, 0.5) for i in range(8)]
        assert _merge_close_hits(roll) == roll

    def test_小さすぎる打音を捨てる(self):
        from decompose import _drop_drum_bleed
        hits = {"kick": [(0.0, 0.8), (0.5, 0.1), (1.0, 0.8), (1.5, 0.7)], "cymbals": [(0.0, 0.004), (0.5, 0.005)]}
        kept, typical = _drop_drum_bleed(hits)
        # キックの 0.1 は、ふつうの大きさ（0.8 前後）の 2 割より小さい。シンバルは絶対の下限より小さい
        assert [time for time, _ in kept["kick"]] == [0.0, 1.0, 1.5]
        assert kept["cymbals"] == []
        assert 0.7 <= typical["kick"] <= 0.8

    def test_ステップに丸めて_同じ種類の同じステップは1つにする(self):
        from decompose import drum_hits_to_events
        hits = {"kick": [(0.0, 0.8), (0.99, 0.4), (1.02, 0.8)], "snare": [(0.5, 0.6)]}
        events = drum_hits_to_events(hits, STEP)
        assert events == [
            {"type": "kick", "step": 0, "velocity": 96},
            {"type": "snare", "step": 4, "velocity": 96},
            {"type": "kick", "step": 8, "velocity": 96},
        ]

    def test_強さは_その種類のふつうの打音を96とした相対の値(self):
        from decompose import drum_hits_to_events
        events = drum_hits_to_events({"kick": [(0.0, 0.8), (0.5, 0.4)], "cymbals": [(0.0, 0.1), (0.5, 0.2)]}, STEP,
                                     typical={"kick": 0.8, "cymbals": 0.1})
        assert {(e["type"], e["step"]): e["velocity"] for e in events} == {
            ("kick", 0): 96, ("kick", 4): 48, ("cymbals", 0): 96, ("cymbals", 4): 127,
        }


class TestDecomposeDrums:
    """``decompose`` のドラムの経路。Demucs は動かさず、分離の結果を差し替えて確かめる。"""

    @pytest.fixture
    def stems(self, tmp_path):
        """分離の結果のふりをするファイル。ドラムと、種類ごとに分けたもの。"""
        hits = ([("kick", s * STEP, 0.8) for s in KICK_STEPS] + [("snare", s * STEP, 0.7) for s in SNARE_STEPS]
                + [("hat", s * STEP, 0.3) for s in HAT_STEPS])
        full = {"drums": Path(_write_drums(tmp_path / "drums.wav", hits))}
        parts = {f"drums_{kind}": Path(path) for kind, path in _pattern_stems(tmp_path).items()}
        return full, parts

    def _run(self, monkeypatch, tmp_path, deep, **kwargs):
        import audio_utils
        import decompose
        import separate
        monkeypatch.setattr(separate, "deep_separate", deep)
        monkeypatch.setattr(audio_utils, "results_dir", lambda *parts: _mkdir(tmp_path.joinpath("results", *parts)))
        return decompose.decompose(str(tmp_path / "song.wav"), bpm=120, **kwargs)

    def test_種類ごとに分けた音から採譜し_分けた音はパートにしない(self, tmp_path, monkeypatch, stems):
        full, parts = stems
        calls = []

        def deep(input_path, output_dir, segment, jobs, recursive_depth, split_drums, job, on_drum_split_error=None, model="htdemucs_ft"):
            calls.append((segment, jobs, split_drums))
            return {**full, **parts}

        result = self._run(monkeypatch, tmp_path, deep, split_drums=True)
        assert calls == [(7, 1, True)]
        assert list(result["stems"]) == ["drums"]
        drums = result["stems"]["drums"]
        assert drums["drum_source"] == result["drum_source"] == "stems" and result["drum_fallback"] is None
        assert _steps(drums["drum_events"], "kick") == KICK_STEPS
        assert _steps(drums["drum_events"], "cymbals") == HAT_STEPS
        assert drums["notes"] == []

    def test_頼まれなければ_ドラムを分けない(self, tmp_path, monkeypatch, stems):
        full, _ = stems
        calls = []

        def deep(input_path, output_dir, segment, jobs, recursive_depth, split_drums, job, on_drum_split_error=None, model="htdemucs_ft"):
            calls.append(split_drums)
            return dict(full)

        result = self._run(monkeypatch, tmp_path, deep)
        assert calls == [False]
        assert result["drum_source"] == "spectral" and result["drum_fallback"] is None
        assert {e["type"] for e in result["stems"]["drums"]["drum_events"]} <= {"kick", "snare", "hihat"}

    def test_追加のモデルを用意できなければ_これまでの振り分けに落とす(self, tmp_path, monkeypatch, stems):
        import stem_models
        full, _ = stems
        calls = []

        def deep(input_path, output_dir, segment, jobs, recursive_depth, split_drums, job, on_drum_split_error=None, model="htdemucs_ft"):
            calls.append(split_drums)
            if split_drums:
                raise stem_models.ModelUnavailableError("分離用の追加モデルをダウンロードできませんでした。")
            return dict(full)

        result = self._run(monkeypatch, tmp_path, deep, split_drums=True)
        # 失敗にせず、ドラムを分けない分離をやり直す
        assert calls == [True, False]
        drums = result["stems"]["drums"]
        assert drums["drum_source"] == result["drum_source"] == "spectral"
        assert "ダウンロードできませんでした" in result["drum_fallback"]
        assert drums["drum_events"] and {e["type"] for e in drums["drum_events"]} <= {"kick", "snare", "hihat"}

    def test_分けた音がどれも無音なら_これまでの振り分けに落とす(self, tmp_path, monkeypatch, stems):
        import decompose
        full, _ = stems

        def deep(input_path, output_dir, segment, jobs, recursive_depth, split_drums, job, on_drum_split_error=None, model="htdemucs_ft"):
            # 無音のステムは、分離の側で結果から外れる
            return dict(full)

        result = self._run(monkeypatch, tmp_path, deep, split_drums=True)
        assert result["drum_source"] == "spectral"
        assert result["drum_fallback"] == decompose.DRUM_FALLBACK_NO_HITS

    def _run_split_failure(self, monkeypatch, tmp_path, stems, on_split):
        """本物の ``deep_separate`` を通して、ドラムの細分化（drumsep の Demucs）だけを差し替えて動かす。

        6 ステムの分離（``separate_audio``）は、分離の結果のふりをするファイルを返すだけにする。
        細分化の子プロセス（``demucs_progress.run``）は、書きかけのファイルを置いてから ``on_split`` を呼ぶ。

        Returns:
            tuple: ``(decompose の結果, ジョブ, 6 ステムの分離を呼んだ回数, 書きかけを置いたディレクトリ)``。
        """
        import audio_utils
        import background_jobs
        import decompose
        import demucs_progress
        import separate
        full, _ = stems
        first_calls = []
        partial = []

        def separate_audio(**kwargs):
            first_calls.append(kwargs.get("stage", "separate"))
            return dict(full)

        def run(cmd, model, job=None, stage="separate", model_stage="model"):
            # separate_drums が出力を置く場所（<out>/<モデル>/<入力の名前>）に、書きかけを置く
            out = Path(cmd[cmd.index("--out") + 1]) / model / Path(cmd[-1]).stem
            out.mkdir(parents=True, exist_ok=True)
            (out / "kick.wav").write_bytes(b"partial")
            partial.append(out)
            job.enter_stage(stage)
            return on_split()

        monkeypatch.setattr(separate, "separate_audio", separate_audio)
        monkeypatch.setattr(separate, "_ensure_drum_model", lambda job: tmp_path / "drumsep.safetensors")
        monkeypatch.setattr(demucs_progress, "run", run)
        monkeypatch.setattr(audio_utils, "results_dir", lambda *parts: _mkdir(tmp_path.joinpath("results", *parts)))
        job = background_jobs.Job(kind="decompose", stages=decompose.decompose_stages(detect_bpm=False, split_drums=True))
        result = decompose.decompose(str(tmp_path / "song.wav"), bpm=120, split_drums=True, job=job)
        return result, job, first_calls, partial

    def test_ドラムの細分化が失敗しても_分けずに採譜して続ける(self, tmp_path, monkeypatch, stems):
        # 低スペック PC のメモリ不足などで、drumsep の Demucs が失敗した（終了コードが 0 でない）
        result, job, first_calls, partial = self._run_split_failure(monkeypatch, tmp_path, stems, lambda: 1)
        drums = result["stems"]["drums"]
        assert drums["drum_source"] == result["drum_source"] == "spectral"
        assert drums["drum_events"] and {e["type"] for e in drums["drum_events"]} <= {"kick", "snare", "hihat"}
        # 理由は利用者に見せる文。分けずに採譜したことが分かる
        assert "ドラム" in result["drum_fallback"] and "分けられませんでした" in result["drum_fallback"]
        # 済んだ 6 ステムの分離はやり直さない
        assert first_calls == ["separate"]
        # 細分化の書きかけは、ジョブが成功しても残さない
        assert partial and not partial[0].exists()
        # ジョブは最後のステージまで進んでいる
        snap = job.snapshot()
        assert snap["stage_key"] == "transcribe" and snap["stage_index"] == snap["stage_count"] - 1

    def test_ドラムの細分化の途中でキャンセルされたら_キャンセルを伝える(self, tmp_path, monkeypatch, stems):
        import background_jobs

        def cancelled():
            raise background_jobs.JobCancelled()

        with pytest.raises(background_jobs.JobCancelled):
            self._run_split_failure(monkeypatch, tmp_path, stems, cancelled)

    def test_deep_separate単体では_ドラムの細分化の失敗をそのまま伝える(self, tmp_path, monkeypatch, stems):
        # /api/deep-separate は、頼まれた細分化ができなければ失敗にする（これまでどおり）
        import separate
        full, _ = stems
        monkeypatch.setattr(separate, "separate_audio", lambda **kwargs: dict(full))
        monkeypatch.setattr(separate, "_ensure_drum_model", lambda job: tmp_path / "drumsep.safetensors")

        def fail(*args, **kwargs):
            raise RuntimeError("ドラムの細分化（Demucs）の実行に失敗しました。")

        monkeypatch.setattr(separate, "separate_drums", fail)
        with pytest.raises(RuntimeError):
            separate.deep_separate(str(tmp_path / "song.wav"), output_dir=str(tmp_path / "out"), split_drums=True)

    def test_ステージの並び(self):
        from decompose import decompose_stages
        keys = lambda **kwargs: [key for key, _ in decompose_stages(**kwargs)]  # noqa: E731
        assert keys() == ["tempo", "model", "separate", "transcribe"]
        assert keys(detect_bpm=False, split_drums=True) == ["model", "separate", "separate_drums", "transcribe"]
        assert keys(split_drums=True, download_drum_model=True) == [
            "tempo", "drum_model", "model", "separate", "separate_drums", "transcribe"]
        # ドラムを分けないなら、ダウンロードのステージも無い
        assert keys(download_drum_model=True) == keys()


def _mkdir(path):
    path.mkdir(parents=True, exist_ok=True)
    return path


class TestSeparationModel:
    @pytest.mark.parametrize("model", ["htdemucs_ft", "htdemucs", "htdemucs_6s"])
    def test_選んだモデルで一度だけ分けて音量を変えずに渡す(self, tmp_path, monkeypatch, model):
        import audio_utils
        import decompose
        import separate
        import soundfile as sf

        # 左右の定位、1を超えるピーク、小さい成分を含め、音声のコピーで変更しないことを確かめる。
        samples = np.tile(np.array([[1.2, -0.3], [0.0002, -0.0001]], dtype=np.float32), (2205, 1))
        source = tmp_path / "other.wav"
        sf.write(source, samples, 44100, subtype="FLOAT")
        calls = []

        def deep(input_path, **kwargs):
            calls.append(kwargs)
            return {"other": source}

        monkeypatch.setattr(separate, "deep_separate", deep)
        monkeypatch.setattr(audio_utils, "results_dir", lambda *parts: _mkdir(tmp_path.joinpath("results", *parts)))
        monkeypatch.setattr(decompose, "polyphonic_events", lambda *args, **kwargs: [])
        monkeypatch.setattr(decompose, "estimate_instrument", lambda *args: None)
        result = decompose.decompose(str(tmp_path / "song.wav"), bpm=120, model=model)
        assert result["model"] == model
        assert len(calls) == 1 and calls[0]["model"] == model and calls[0]["recursive_depth"] == 0
        copied, rate = sf.read(result["stems"]["other"]["audio_path"], dtype="float32")
        assert rate == 44100
        np.testing.assert_array_equal(copied, samples)


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


def _write_line(path, starts, dur, total, midis=(45, 48, 50, 52, 55, 57), sr=22050):
    """``starts`` の各位置（秒）から ``dur`` 秒だけ鳴る、減衰する音（倍音つき。音の高さは順に変える）の WAV を書く。"""
    import soundfile as sf
    data = np.zeros(int(total * sr), dtype=np.float32)
    n = int(dur * sr)
    t = np.arange(n) / sr
    env = np.minimum(1.0, np.minimum(np.arange(n), n - np.arange(n)) / 150.0) * np.exp(-t * 4)
    for index, start in enumerate(starts):
        freq = 440.0 * 2 ** ((midis[index % len(midis)] - 69) / 12)
        wave = sum(a * np.sin(2 * np.pi * freq * k * t) for k, a in ((1, 0.4), (2, 0.2), (3, 0.1)))
        i = int(start * sr)
        data[i:i + n] += (wave * env).astype(np.float32)[:len(data) - i]
    sf.write(str(path), data, sr)
    return str(path)


class TestDecomposeGridFeel:
    """``decompose`` は、曲全体のグリッド（16 分か三連か）を 1 つ決めて、全部のパートを同じグリッドに丸める

    Demucs は動かさず、分離の結果を差し替える。合成した音声（位置が分かっている）を、本物のオンセット検出と
    採譜（basic-pitch）に通す。
    """

    BPM, BARS = 90, 4
    STEP_SEC = 60 / 90 / 4

    def _song(self, tmp_path, offsets):
        """ドラム（キック 1・3 拍、スネア 2・4 拍、ハイハットが ``offsets`` の刻み）と、同じ刻みのベースの音声を書く。"""
        beats = range(self.BARS * 4)
        total = self.BARS * 16 * self.STEP_SEC + 1.0
        at = lambda step: step * self.STEP_SEC  # noqa: E731
        kick = [("kick", at(beat * 4), 0.8) for beat in beats if beat % 2 == 0]
        snare = [("snare", at(beat * 4), 0.7) for beat in beats if beat % 2 == 1]
        hat = [("hat", at(beat * 4 + offset), 0.3) for beat in beats for offset in offsets]
        return {
            "drums": Path(_write_drums(tmp_path / "drums.wav", kick + snare + hat, total)),
            "bass": Path(_write_line(tmp_path / "bass.wav", [at(beat * 4 + offset) for beat in beats for offset in offsets],
                                     self.STEP_SEC * 0.8, total)),
            "drums_kick": Path(_write_drums(tmp_path / "kick.wav", kick, total)),
            "drums_snare": Path(_write_drums(tmp_path / "snare.wav", snare, total)),
            "drums_cymbals": Path(_write_drums(tmp_path / "cymbals.wav", hat, total)),
        }

    def _run(self, monkeypatch, tmp_path, stems, **kwargs):
        import audio_utils
        import decompose
        import separate

        def deep(input_path, split_drums=False, **rest):
            return {name: path for name, path in stems.items() if split_drums or not name.startswith("drums_")}

        monkeypatch.setattr(separate, "deep_separate", deep)
        monkeypatch.setattr(audio_utils, "results_dir", lambda *parts: _mkdir(tmp_path.joinpath("results", *parts)))
        return decompose.decompose(str(tmp_path / "song.wav"), bpm=self.BPM, **kwargs)

    @staticmethod
    def _ticks(value):
        import note_steps
        return note_steps.to_ticks(value)

    def test_シャッフルの曲は_全部のパートを三連のグリッドに丸める(self, tmp_path, monkeypatch):
        result = self._run(monkeypatch, tmp_path, self._song(tmp_path, SHUFFLE), split_drums=True)
        assert result["grid_feel"] == "triplet"
        assert {name: stem["grid_feel"] for name, stem in result["stems"].items()} == {"drums": "triplet", "bass": "triplet"}
        drums = result["stems"]["drums"]
        assert drums["drum_source"] == "stems"
        # ハイハット: 拍の頭（整数）と、三連の 3 つ目（拍の頭 + 8/3。16 分に丸めると + 3 になっていた位置）
        hats = _steps(drums["drum_events"], "cymbals")
        assert hats == [value for beat in range(16) for value in (beat * 4, (beat * 240 + 160) / 60)]
        assert all(isinstance(step, int) for step in hats[::2])
        # キックとスネアは拍の頭なので、16 分のグリッドのときと同じ整数
        assert _steps(drums["drum_events"], "kick") == [0, 8, 16, 24, 32, 40, 48, 56]
        assert _steps(drums["drum_events"], "snare") == [4, 12, 20, 28, 36, 44, 52, 60]
        # ベースのノートも、位置と長さが三連のグリッド（4/3 ステップ = 80 刻みの倍数）に載る。裏（8/3）のノートが在る
        notes = result["stems"]["bass"]["notes"]
        assert notes and all(self._ticks(n["step"]) % 80 == 0 and self._ticks(n["length"]) % 80 == 0 for n in notes)
        assert sum(1 for n in notes if self._ticks(n["step"]) % 240 == 160) >= 8
        assert all(n["length"] >= 80 / 60 for n in notes)

    def test_ドラムを分けない経路でも_三連のグリッドに丸める(self, tmp_path, monkeypatch):
        result = self._run(monkeypatch, tmp_path, self._song(tmp_path, SHUFFLE))
        assert result["grid_feel"] == "triplet" and result["drum_source"] == "spectral"
        steps = [e["step"] for e in result["stems"]["drums"]["drum_events"]]
        assert steps and all(self._ticks(step) % 80 == 0 for step in steps)
        assert sum(1 for step in steps if self._ticks(step) % 240 == 160) >= 8

    @pytest.mark.parametrize("offsets", [[0, 2], [0, 1, 2, 3]])
    def test_8分と16分の曲は_これまでどおり16分に丸める(self, tmp_path, monkeypatch, offsets):
        result = self._run(monkeypatch, tmp_path, self._song(tmp_path, offsets), split_drums=True)
        assert result["grid_feel"] == "straight"
        assert all(stem["grid_feel"] == "straight" for stem in result["stems"].values())
        drums = result["stems"]["drums"]
        assert _steps(drums["drum_events"], "cymbals") == [beat * 4 + offset for beat in range(16) for offset in offsets]
        # 位置も長さも整数のまま（JSON にしても、これまでと同じ形）
        numbers = [e["step"] for e in drums["drum_events"]]
        numbers += [value for n in result["stems"]["bass"]["notes"] for value in (n["step"], n["length"])]
        assert numbers and all(isinstance(value, int) for value in numbers)

    def test_結果の形(self, tmp_path, monkeypatch):
        result = self._run(monkeypatch, tmp_path, self._song(tmp_path, [0, 2]))
        assert set(result) == {"bpm", "model", "grid_offset_sec", "grid_feel", "drum_source", "drum_fallback", "stems"}
        assert set(result["stems"]["drums"]) == {"audio_path", "notes", "drum_events", "gm_program", "mix",
                                                 "drum_source", "grid_feel"}
        assert set(result["stems"]["bass"]) == {"audio_path", "notes", "drum_events", "gm_program", "mix", "grid_feel"}


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
