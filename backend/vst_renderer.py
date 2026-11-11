"""VST3プラグインをホストしてMIDIから音声を生成するレンダラーモジュール。

dawdreamer を使って VST3 プラグイン（ソフトシンセ等）を読み込み、
MIDI ファイルからオフラインでオーディオを生成する。

インターフェースは ``synth.py`` の FluidSynth 系関数（``_fluidsynth_render``
/ ``step_sequencer``）に揃えてある:

- 入り口は関数 1 本（``render_vst_midi``）
- 内部処理はすべて ``numpy.ndarray`` で完結
- ファイル I/O は ``audio_utils.save_tmp`` 経由の ``soundfile`` のみ
- 戻り値は ``results/edited/vst_XXXX.wav`` のパス文字列

使用例::

    from vst_renderer import render_vst_midi
    path = render_vst_midi(
        plugin_path="/path/to/Synth.vst3",
        midi_path="/path/to/song.mid",
        duration=30.0,
    )
"""
from pathlib import Path
from typing import Optional

from audio_utils import save_tmp


def _load_preset(plugin, preset_path: str) -> None:
    """プリセットファイルを VST3 プラグインに適用する内部ヘルパ。

    拡張子で ``load_preset`` / ``load_state`` を自動選択し、不明な拡張子は
    順にフォールバックする。

    Args:
        plugin: ``dawdreamer`` の ``PluginProcessor``。
        preset_path (str): プリセットファイルパス。
            ``.vstpreset`` / ``.fxp`` / ``.fxb`` → ``load_preset``
            ``.vst3state`` / ``.bin`` → ``load_state``
            それ以外 → ``load_preset`` → ``load_state`` の順に試行。

    Raises:
        FileNotFoundError: preset_path が存在しない場合。
        RuntimeError: どのロード方式でも失敗した場合。
    """
    pp = Path(preset_path)
    if not pp.exists():
        raise FileNotFoundError(f"プリセットが見つかりません: {preset_path}")

    suffix = pp.suffix.lower()
    try:
        if suffix in (".vstpreset", ".fxp", ".fxb"):
            plugin.load_preset(str(pp))
        elif suffix in (".vst3state", ".bin"):
            plugin.load_state(str(pp))
        else:
            try:
                plugin.load_preset(str(pp))
            except Exception:
                plugin.load_state(str(pp))
    except Exception as e:
        raise RuntimeError(
            f"プリセットを読み込めませんでした: {preset_path} ({e})"
        ) from e


def render_vst_midi(
    plugin_path: str,
    midi_path: str,
    duration: float,
    preset_path: Optional[str] = None,
    sr: int = 44100,
    buffer_size: int = 512,
) -> str:
    """VST3 プラグインで MIDI をレンダリングし WAV ファイルとして保存する。

    ``synth._fluidsynth_render`` と同じインターフェース設計:

    - 内部処理は ``numpy.ndarray`` のみ（dawdreamer の ``get_audio()`` も
      numpy 配列を返す）
    - ファイル出力は ``audio_utils.save_tmp`` 経由の ``soundfile`` のみ
    - 戻り値は ``results/edited/vst_XXXX.wav`` のパス文字列

    dawdreamer は重いライブラリなのでモジュール読み込み時ではなく
    関数内で遅延インポートする（プロジェクト規約）。

    Args:
        plugin_path (str): VST3 プラグインのパス（``.vst3`` ファイル/バンドル）。
        midi_path (str): 入力 MIDI ファイルのパス（``.mid`` / ``.midi``）。
        duration (float): レンダリング時間（秒）。正の値。
        preset_path (str | None): 任意のプリセットファイル
            （``.vstpreset`` / ``.fxp`` / ``.vst3state`` 等）。
            None の場合はプラグインのデフォルト状態でレンダリング。
        sr (int): サンプルレート（Hz）。デフォルトはプロジェクト標準の 44100。
        buffer_size (int): dawdreamer のバッファサイズ。CPU 環境では
            512 を推奨。

    Returns:
        str: 生成した WAV ファイルのパス（``results/edited/vst_XXXX.wav``）。

    Raises:
        ImportError: ``dawdreamer`` が未インストールの場合。
        FileNotFoundError: plugin_path / midi_path / preset_path が
            存在しない場合。
        ValueError: duration が 0 以下の場合。
        RuntimeError: プリセットのロードに失敗した場合。
    """
    import numpy as np
    try:
        import dawdreamer as daw
    except ImportError as e:
        raise ImportError(
            "dawdreamer がインストールされていません。"
            "`pip install dawdreamer` を実行してください。"
        ) from e

    if duration <= 0:
        raise ValueError(f"duration は正の値にしてください: {duration}")

    pp = Path(plugin_path)
    if not pp.exists():
        raise FileNotFoundError(f"VST3 が見つかりません: {plugin_path}")

    mp = Path(midi_path)
    if not mp.exists():
        raise FileNotFoundError(f"MIDI が見つかりません: {midi_path}")

    sr = int(sr)

    # dawdreamer エンジンに VST3 をロード
    engine = daw.RenderEngine(sr, int(buffer_size))
    plugin = engine.make_plugin_processor("vst", str(pp))

    if preset_path:
        _load_preset(plugin, preset_path)

    # MIDI をロード → オフラインレンダリング
    plugin.load_midi(str(mp))
    engine.load_graph([(plugin, [])])
    engine.render(float(duration))

    # dawdreamer.get_audio() は shape=(channels, N) の numpy 配列を返す。
    # 既存モジュール（audio_utils.load_audio）の shape 規約 (N,) / (N, 2)
    # に合わせて転置する
    audio = np.asarray(engine.get_audio(), dtype=np.float32)
    if audio.ndim == 2 and audio.shape[0] in (1, 2):
        audio = audio.T  # (channels, N) -> (N, channels)
    if audio.ndim == 2 and audio.shape[1] == 1:
        audio = audio[:, 0]  # モノラルは 1 次元

    # クリップ保険（プラグイン出力が 1 を超えることがある）
    np.clip(audio, -1.0, 1.0, out=audio)

    # audio_utils.save_tmp 経由で results/edited/ 以下に WAV 保存
    return save_tmp(audio, sr, "vst")
