"""mix_profile モジュールのテスト（曲全体のミックス特性）"""
import numpy as np
import pytest
import soundfile as sf

import mix_profile


def _write(tmp_path, name, data, sr=44100):
    """テスト用の WAV を書き出してパスを返す"""
    path = tmp_path / f"{name}.wav"
    sf.write(str(path), data, sr)
    return str(path)


@pytest.fixture
def tone_stereo(tmp_path):
    """左右で位相の異なる440Hz。ステレオ幅を持つ音源"""
    t = np.arange(44100 * 3) / 44100
    left = 0.5 * np.sin(2 * np.pi * 440 * t)
    right = 0.5 * np.sin(2 * np.pi * 440 * t + 0.8)
    return _write(tmp_path, "tone_stereo", np.column_stack([left, right]))


@pytest.fixture
def tone_mono_as_stereo(tmp_path):
    """左右が完全に同一。ステレオ幅が0になるはずの音源"""
    t = np.arange(44100 * 3) / 44100
    mono = 0.5 * np.sin(2 * np.pi * 440 * t)
    return _write(tmp_path, "tone_dual", np.column_stack([mono, mono]))


class TestAnalyzeMix:
    def test_returns_all_fields(self, tone_stereo):
        """仕様どおりのキーを揃えて返す"""
        result = mix_profile.analyze_mix(tone_stereo)
        for key in ("loudness_lufs", "peak_dbfs", "dynamic_range_db",
                    "stereo_width", "bass_mono", "reverb_tail_sec", "spectrum_bands"):
            assert key in result

    def test_silence_yields_nulls(self, tmp_path):
        """無音では値を出さず None にする"""
        path = _write(tmp_path, "silence", np.zeros((44100 * 2, 2)))
        result = mix_profile.analyze_mix(path)
        assert result["loudness_lufs"] is None
        assert result["peak_dbfs"] is None

    def test_mono_has_no_stereo_fields(self, tmp_path):
        """モノラル音源では左右の差が定義できないので None にする"""
        t = np.arange(44100 * 2) / 44100
        path = _write(tmp_path, "mono", 0.4 * np.sin(2 * np.pi * 440 * t))
        result = mix_profile.analyze_mix(path)
        assert result["stereo_width"] is None
        assert result["bass_mono"] is None

    def test_spectrum_bands_cover_definition(self, tone_stereo):
        """帯域が定義どおりの数と順序で返る"""
        bands = mix_profile.analyze_mix(tone_stereo)["spectrum_bands"]
        assert len(bands) == len(mix_profile.SPECTRUM_BANDS)
        for band, (name, low, high) in zip(bands, mix_profile.SPECTRUM_BANDS):
            assert band["name"] == name
            assert band["hz"] == [low, high]
            assert isinstance(band["energy_db"], float)


class TestPeak:
    def test_full_scale_is_zero_dbfs(self, tmp_path):
        """フルスケールのピークは 0 dBFS になる"""
        signal = np.zeros((44100, 2))
        signal[100] = 1.0
        path = _write(tmp_path, "peak", signal)
        assert mix_profile.analyze_mix(path)["peak_dbfs"] == pytest.approx(0.0, abs=0.1)

    def test_half_scale_is_minus_six(self, tmp_path):
        """振幅0.5のピークは約 -6 dBFS になる"""
        t = np.arange(44100) / 44100
        signal = 0.5 * np.sin(2 * np.pi * 440 * t)
        path = _write(tmp_path, "half", np.column_stack([signal, signal]))
        assert mix_profile.analyze_mix(path)["peak_dbfs"] == pytest.approx(-6.0, abs=0.2)


class TestStereoWidth:
    def test_identical_channels_are_narrow(self, tone_mono_as_stereo):
        """左右が同一ならステレオ幅は0に近い"""
        assert mix_profile.analyze_mix(tone_mono_as_stereo)["stereo_width"] == pytest.approx(0.0, abs=0.05)

    def test_phase_shifted_channels_are_wider(self, tone_stereo, tone_mono_as_stereo):
        """位相差があるほうが幅が広く出る"""
        wide = mix_profile.analyze_mix(tone_stereo)["stereo_width"]
        narrow = mix_profile.analyze_mix(tone_mono_as_stereo)["stereo_width"]
        assert wide > narrow

    def test_is_bounded(self, tone_stereo):
        """ステレオ幅は 0.0〜1.0 に収まる"""
        assert 0.0 <= mix_profile.analyze_mix(tone_stereo)["stereo_width"] <= 1.0


class TestBassMono:
    def test_identical_low_end_is_mono(self, tmp_path):
        """低音が左右同一ならモノラルと判定される"""
        t = np.arange(44100 * 2) / 44100
        bass = 0.5 * np.sin(2 * np.pi * 60 * t)
        path = _write(tmp_path, "bass_mono", np.column_stack([bass, bass]))
        assert mix_profile.analyze_mix(path)["bass_mono"] is True

    def test_decorrelated_low_end_is_not_mono(self, tmp_path):
        """低音が左右で無関係ならモノラルと判定されない"""
        rng = np.random.RandomState(0)
        left = np.cumsum(rng.randn(44100 * 2)) * 0.001
        right = np.cumsum(rng.randn(44100 * 2)) * 0.001
        path = _write(tmp_path, "bass_wide", np.column_stack([left, right]))
        assert mix_profile.analyze_mix(path)["bass_mono"] is False


class TestLoudness:
    def test_louder_signal_has_higher_lufs(self, tmp_path):
        """音量を上げると LUFS も上がる"""
        t = np.arange(44100 * 3) / 44100
        base = np.sin(2 * np.pi * 1000 * t)
        quiet = _write(tmp_path, "quiet", np.column_stack([base * 0.1, base * 0.1]))
        loud = _write(tmp_path, "loud", np.column_stack([base * 0.8, base * 0.8]))

        quiet_lufs = mix_profile.analyze_mix(quiet)["loudness_lufs"]
        loud_lufs = mix_profile.analyze_mix(loud)["loudness_lufs"]
        assert loud_lufs > quiet_lufs

    def test_gain_change_moves_lufs_proportionally(self, tmp_path):
        """ゲインを半分にすると LUFS が約 6dB 下がる"""
        t = np.arange(44100 * 3) / 44100
        base = np.sin(2 * np.pi * 1000 * t)
        a = _write(tmp_path, "a", np.column_stack([base * 0.5, base * 0.5]))
        b = _write(tmp_path, "b", np.column_stack([base * 0.25, base * 0.25]))

        delta = mix_profile.analyze_mix(a)["loudness_lufs"] - mix_profile.analyze_mix(b)["loudness_lufs"]
        assert delta == pytest.approx(6.0, abs=0.5)

    def test_dynamic_range_is_larger_for_varying_signal(self, tmp_path):
        """音量が変動する信号のほうがラウドネスレンジが大きい"""
        t = np.arange(44100 * 8) / 44100
        base = np.sin(2 * np.pi * 1000 * t)
        steady = _write(tmp_path, "steady", np.column_stack([base * 0.5, base * 0.5]))

        varying_signal = base * (0.1 + 0.8 * (np.sin(2 * np.pi * 0.25 * t) * 0.5 + 0.5))
        varying = _write(tmp_path, "varying", np.column_stack([varying_signal, varying_signal]))

        steady_range = mix_profile.analyze_mix(steady)["dynamic_range_db"]
        varying_range = mix_profile.analyze_mix(varying)["dynamic_range_db"]
        assert varying_range > steady_range
