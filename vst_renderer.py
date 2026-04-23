"""VST3プラグインをホストしてMIDIから音声を生成するレンダラーモジュール。

dawdreamer ライブラリを使って VST3 プラグイン（ソフトシンセ等）を
読み込み、MIDI ファイルからオフラインで音声を生成する。出力は
既存の bunri DAW アーキテクチャ（numpy 配列 / WAV ファイル）と自然に
統合できる形式になっている。

使用例::

    from vst_renderer import VST3Renderer
    r = VST3Renderer(sample_rate=44100)
    r.load_plugin("/path/to/Plugin.vst3", preset_path="/path/to/p.vstpreset")
    audio, sr = r.render_midi("/path/to/song.mid", duration=30.0)
    # もしくは WAV として保存（FastAPI の FileResponse にそのまま渡せる）
    wav_path = r.render_midi_to_wav("/path/to/song.mid", duration=30.0)

dawdreamer は重めのライブラリなので、モジュール本体ではインポートせず、
``VST3Renderer.__init__`` 内で遅延インポートする。
"""
from pathlib import Path
from typing import Optional, Tuple

from audio_utils import save_tmp


class VST3Renderer:
    """VST3 プラグインをホストして MIDI からオーディオをレンダリングするクラス。

    dawdreamer の ``RenderEngine`` と ``PluginProcessor`` をラップし、
    以下の処理を提供する。

    - VST3 プラグインとプリセットの読み込み
    - MIDI ファイルの読み込みとオフラインレンダリング
    - ``numpy.ndarray`` または WAV ファイルとしての出力

    設計方針:
        - CPU 環境前提（bunri DAW 全体の方針に準拠）
        - 出力 shape は ``audio_utils.load_audio`` と同じく (N,) / (N, 2)
        - WAV 保存は ``audio_utils.save_tmp`` を使って ``results/edited/``
          以下に出力し、既存 API と同じパス形式で返す

    Attributes:
        sample_rate (int): レンダリングのサンプルレート（Hz）。
        buffer_size (int): dawdreamer のバッファサイズ。
        engine: dawdreamer.RenderEngine インスタンス。
        plugin: 読み込まれた VST3 PluginProcessor。load_plugin 後に設定。
        plugin_path (str | None): 現在読み込まれている VST3 のパス。
        preset_path (str | None): 現在読み込まれているプリセットのパス。
    """

    def __init__(self, sample_rate: int = 44100, buffer_size: int = 512):
        """VST3Renderer を初期化する。

        Args:
            sample_rate: レンダリングのサンプルレート（Hz）。デフォルトは
                プロジェクト標準の 44100。
            buffer_size: dawdreamer のバッファサイズ（サンプル数）。
                CPU 環境では 512 を推奨。

        Raises:
            ImportError: dawdreamer がインストールされていない場合。
        """
        try:
            import dawdreamer as daw
        except ImportError as e:
            raise ImportError(
                "dawdreamer がインストールされていません。"
                "`pip install dawdreamer` を実行してください。"
            ) from e

        self._daw = daw
        self.sample_rate = int(sample_rate)
        self.buffer_size = int(buffer_size)
        self.engine = daw.RenderEngine(self.sample_rate, self.buffer_size)
        self.plugin = None
        self.plugin_path: Optional[str] = None
        self.preset_path: Optional[str] = None

    def load_plugin(
        self,
        plugin_path: str,
        preset_path: Optional[str] = None,
    ) -> None:
        """VST3 プラグインと（あれば）プリセットを読み込む。

        プリセットは拡張子を見て適切なローダを自動選択する。

        - ``.vstpreset`` / ``.fxp`` / ``.fxb`` → ``load_preset``
        - ``.vst3state`` / ``.bin`` → ``load_state``
        - 拡張子不明時は ``load_preset`` → ``load_state`` の順にフォールバック

        Args:
            plugin_path: VST3 プラグインのパス（``.vst3`` ファイル / バンドル）。
            preset_path: 任意のプリセットファイル。None の場合はデフォルト状態。

        Raises:
            FileNotFoundError: plugin_path / preset_path が存在しない場合。
            RuntimeError: プリセットのどのロード方式でも失敗した場合。
        """
        p = Path(plugin_path)
        if not p.exists():
            raise FileNotFoundError(f"VST3 が見つかりません: {plugin_path}")

        # dawdreamer の PluginProcessor を生成
        self.plugin = self.engine.make_plugin_processor("vst", str(p))
        self.plugin_path = str(p)

        if preset_path is None:
            return

        pp = Path(preset_path)
        if not pp.exists():
            raise FileNotFoundError(f"プリセットが見つかりません: {preset_path}")

        suffix = pp.suffix.lower()
        last_err: Optional[Exception] = None
        try:
            if suffix in (".vstpreset", ".fxp", ".fxb"):
                self.plugin.load_preset(str(pp))
            elif suffix in (".vst3state", ".bin"):
                self.plugin.load_state(str(pp))
            else:
                # 拡張子から判定できない場合は順に試す
                try:
                    self.plugin.load_preset(str(pp))
                except Exception as e:
                    last_err = e
                    self.plugin.load_state(str(pp))
        except Exception as e:
            raise RuntimeError(
                f"プリセットを読み込めませんでした: {preset_path} "
                f"({e if last_err is None else last_err})"
            ) from e

        self.preset_path = str(pp)

    def render_midi(
        self,
        midi_path: str,
        duration: float,
    ) -> Tuple["np.ndarray", int]:
        """MIDI ファイルをプラグインでレンダリングして numpy 配列を返す。

        返り値の shape は ``audio_utils.load_audio`` と同じ形式
        （モノラル: (N,)、ステレオ: (N, 2)）。そのため既存の編集・エフェクト系
        モジュール（``edit.py`` / ``effects.py`` 等）とそのまま接続できる。

        Args:
            midi_path: 入力 MIDI ファイルのパス（``.mid`` / ``.midi``）。
            duration: レンダリング時間（秒）。0 以下は ValueError。

        Returns:
            tuple[numpy.ndarray, int]: (audio, sample_rate)。
                audio は float32、振幅 -1.0〜1.0 にクリップ済み。
                ステレオなら shape=(N, 2)、モノラルなら shape=(N,)。
                sample_rate はインスタンスの ``self.sample_rate``。

        Raises:
            RuntimeError: load_plugin が未実行の場合。
            FileNotFoundError: midi_path が存在しない場合。
            ValueError: duration が 0 以下の場合。
        """
        import numpy as np

        if self.plugin is None:
            raise RuntimeError(
                "先に load_plugin(...) でプラグインを読み込んでください"
            )
        if duration <= 0:
            raise ValueError(f"duration は正の値にしてください: {duration}")

        mp = Path(midi_path)
        if not mp.exists():
            raise FileNotFoundError(f"MIDI が見つかりません: {midi_path}")

        # MIDI をプラグインに流し込む
        self.plugin.load_midi(str(mp))

        # レンダーグラフ: プラグイン単体をそのまま出力に繋ぐ
        self.engine.load_graph([(self.plugin, [])])
        self.engine.render(float(duration))

        # dawdreamer.get_audio() は shape=(channels, N) で返す。
        # プロジェクト標準の (N,) / (N, 2) に合わせる
        audio = np.asarray(self.engine.get_audio(), dtype=np.float32)
        if audio.ndim == 2 and audio.shape[0] in (1, 2):
            audio = audio.T  # (channels, N) -> (N, channels)
        if audio.ndim == 2 and audio.shape[1] == 1:
            audio = audio[:, 0]  # モノラル時は 1 次元に

        # クリップ保険（プラグインが 1 を超える信号を出すことがある）
        np.clip(audio, -1.0, 1.0, out=audio)
        return audio, self.sample_rate

    def render_midi_to_wav(
        self,
        midi_path: str,
        duration: float,
        prefix: str = "vst",
    ) -> str:
        """MIDI をレンダリングして WAV として保存し、そのパスを返す。

        既存のシンセ系エンドポイント（``/api/synth/*``）と同じく
        ``results/edited/{prefix}_XXXX.wav`` に保存する。FastAPI の
        ``FileResponse`` にそのまま渡せる。

        Args:
            midi_path: 入力 MIDI ファイルのパス。
            duration: レンダリング時間（秒）。
            prefix: 出力ファイル名のプレフィックス。デフォルトは ``"vst"``。

        Returns:
            str: 保存した WAV ファイルのパス。
        """
        audio, sr = self.render_midi(midi_path, duration)
        return save_tmp(audio, sr, prefix)

    def close(self) -> None:
        """リソース参照を解放する。

        dawdreamer は Python の GC に任せて問題ないが、VST3 プラグインが
        内部でスレッド/ファイルを保持する場合に備え、明示的に参照を切る
        インターフェースを用意する。
        """
        self.plugin = None
        self.engine = None
        self.plugin_path = None
        self.preset_path = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False


def render_vst_midi(
    plugin_path: str,
    midi_path: str,
    duration: float,
    preset_path: Optional[str] = None,
    sample_rate: int = 44100,
) -> str:
    """1 ショット用ヘルパ。VST3 で MIDI をレンダリングして WAV パスを返す。

    FastAPI のルートや単体テストから簡潔に呼び出せるよう、
    ``VST3Renderer`` のインスタンス化→読み込み→レンダリング→クローズを
    一括で行う。既存の ``synth.step_sequencer`` 等と同じく
    「WAV ファイルのパス文字列を返す」インターフェースに揃える。

    Args:
        plugin_path: VST3 プラグインのパス。
        midi_path: 入力 MIDI ファイルのパス。
        duration: レンダリング時間（秒）。
        preset_path: 任意のプリセットファイル。
        sample_rate: サンプルレート（Hz）。デフォルトは 44100。

    Returns:
        str: 生成した WAV ファイルのパス（``results/edited/vst_XXXX.wav``）。
    """
    with VST3Renderer(sample_rate=sample_rate) as r:
        r.load_plugin(plugin_path, preset_path)
        return r.render_midi_to_wav(midi_path, duration)
