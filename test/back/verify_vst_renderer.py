"""vst_renderer モジュールの単体検証スクリプト。

このスクリプトは pytest ではなく ``python test/back/verify_vst_renderer.py``
として単独で実行するためのもの。実際の VST3 プラグインと任意の MIDI
ファイルを使って、追加した ``VST3Renderer`` が期待通り動作するかを
チェックする。

使い方:
    # 必要なら: pip install dawdreamer
    # 任意の VST3 プラグインと MIDI を用意して以下のように実行する

    VST3_PATH="/path/to/Synth.vst3" \\
    MIDI_PATH="/path/to/song.mid" \\
    python test/back/verify_vst_renderer.py

    # プリセットを渡したい場合
    PRESET_PATH="/path/to/p.vstpreset" \\
    VST3_PATH=... MIDI_PATH=... python test/back/verify_vst_renderer.py

実行すると以下を検証する:
    1) dawdreamer がインポートできること
    2) VST3Renderer が VST3 / プリセットを読み込めること
    3) render_midi が (N,) または (N, 2) の numpy 配列を返すこと
    4) render_midi_to_wav が有効な WAV を results/edited/ に書き出すこと
    5) render_vst_midi ワンショットヘルパが同様に動くこと
"""
import os
import sys
from pathlib import Path

# プロジェクトルートを sys.path に追加
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def _make_dummy_midi(path: Path) -> None:
    """検証用に Cメジャートライアド（C4/E4/G4、2秒）を鳴らす単純なMIDIを書く。

    外部ライブラリに依存せず、SMF Format 0 のバイナリを手書きで生成する。
    """
    # Format 0, 1 track, 480 ticks / quarter
    header = b"MThd" + (6).to_bytes(4, "big") + \
             (0).to_bytes(2, "big") + (1).to_bytes(2, "big") + \
             (480).to_bytes(2, "big")

    def vlq(n: int) -> bytes:
        out = bytearray([n & 0x7F])
        n >>= 7
        while n:
            out.insert(0, (n & 0x7F) | 0x80)
            n >>= 7
        return bytes(out)

    # 120 BPM, 3ノート（C4, E4, G4）を同時に鳴らし 2秒 = 1920 ticks 伸ばす
    events = bytearray()
    # tempo: 500000us/quarter = 120BPM
    events += vlq(0) + b"\xFF\x51\x03" + (500000).to_bytes(3, "big")
    for n in (60, 64, 67):  # C4, E4, G4
        events += vlq(0) + bytes([0x90, n, 100])
    events += vlq(1920) + bytes([0x80, 60, 0])
    for n in (64, 67):
        events += vlq(0) + bytes([0x80, n, 0])
    # end of track
    events += vlq(0) + b"\xFF\x2F\x00"

    track = b"MTrk" + len(events).to_bytes(4, "big") + bytes(events)
    path.write_bytes(header + track)


def main() -> int:
    plugin_path = os.environ.get("VST3_PATH")
    midi_path = os.environ.get("MIDI_PATH")
    preset_path = os.environ.get("PRESET_PATH") or None

    # 1) dawdreamer の有無
    try:
        import dawdreamer  # noqa: F401
        print("[OK] dawdreamer をインポートできました")
    except ImportError:
        print("[NG] dawdreamer が未インストールです。`pip install dawdreamer` を実行してください")
        return 1

    # 2) VST3Renderer クラスがインポートできること
    from vst_renderer import VST3Renderer, render_vst_midi
    print("[OK] vst_renderer をインポートできました")

    if not plugin_path:
        print("[SKIP] 環境変数 VST3_PATH が未設定のため実レンダリングはスキップします")
        print("       例: VST3_PATH=/path/to/Synth.vst3 MIDI_PATH=/path/to/a.mid \\")
        print("           python test/back/verify_vst_renderer.py")
        return 0

    if not Path(plugin_path).exists():
        print(f"[NG] VST3 が見つかりません: {plugin_path}")
        return 1

    # MIDI が無ければダミーを自動生成
    if not midi_path:
        midi_path = str(ROOT / "uploads" / "_verify_vst.mid")
        Path(midi_path).parent.mkdir(parents=True, exist_ok=True)
        _make_dummy_midi(Path(midi_path))
        print(f"[OK] ダミー MIDI を生成しました: {midi_path}")

    # 3) numpy 配列での出力検証
    import numpy as np
    import soundfile as sf

    with VST3Renderer(sample_rate=44100) as r:
        r.load_plugin(plugin_path, preset_path)
        print(f"[OK] load_plugin: {plugin_path}")
        if preset_path:
            print(f"[OK] load_preset: {preset_path}")

        audio, sr = r.render_midi(midi_path, duration=3.0)
        assert isinstance(audio, np.ndarray), "numpy.ndarray を返すべき"
        assert sr == 44100
        assert audio.ndim in (1, 2), f"shape は (N,) か (N, 2) であるべき: {audio.shape}"
        if audio.ndim == 2:
            assert audio.shape[1] in (1, 2), f"チャンネル数が不正: {audio.shape}"
        assert audio.dtype == np.float32
        print(f"[OK] render_midi -> shape={audio.shape} dtype={audio.dtype} sr={sr}")

        # 4) WAV 保存検証
        wav_path = r.render_midi_to_wav(midi_path, duration=3.0, prefix="verify")
        assert Path(wav_path).exists(), "WAV ファイルが存在しない"
        data, wav_sr = sf.read(wav_path)
        assert wav_sr == 44100
        assert len(data) > 0
        print(f"[OK] render_midi_to_wav -> {wav_path} ({len(data)} samples, sr={wav_sr})")

    # 5) ワンショットヘルパ
    wav2 = render_vst_midi(plugin_path, midi_path, duration=2.0, preset_path=preset_path)
    assert Path(wav2).exists()
    print(f"[OK] render_vst_midi (ヘルパ) -> {wav2}")

    print("\n=== 全ての検証に合格しました ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
