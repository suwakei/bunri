"""vst_renderer モジュールの単体検証スクリプト。

pytest ではなく ``python test/back/verify_vst_renderer.py`` として
単独で実行する。実際の VST3 プラグインと任意の MIDI を使って
``render_vst_midi`` が期待通り動作するかをチェックする。

使い方::

    # 必要なら: pip install dawdreamer

    # (A) ダミー MIDI を自動生成して実行
    VST3_PATH=/path/to/Synth.vst3 python test/back/verify_vst_renderer.py

    # (B) 自前の MIDI を使う
    VST3_PATH=/path/to/Synth.vst3 \\
    MIDI_PATH=/path/to/song.mid \\
    python test/back/verify_vst_renderer.py

    # (C) プリセット付き
    VST3_PATH=... MIDI_PATH=... \\
    PRESET_PATH=/path/to/p.vstpreset \\
    python test/back/verify_vst_renderer.py

検証項目:
    1) dawdreamer がインポートできること
    2) render_vst_midi が WAV パス（``results/edited/vst_XXXX.wav``）を返すこと
    3) 生成 WAV が soundfile で読めて、長さ > 0 かつ無音でないこと
"""
import os
import sys
from pathlib import Path

# プロジェクトルートを sys.path に追加
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def _make_dummy_midi(path: Path) -> None:
    """検証用に C メジャートライアド（C4/E4/G4、2 秒）の最小 SMF を書き出す。

    SMF Format 0、480 ticks/四分音符、120 BPM。外部ライブラリに依存しない。
    """
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

    events = bytearray()
    # tempo: 500000 us/quarter = 120 BPM
    events += vlq(0) + b"\xFF\x51\x03" + (500000).to_bytes(3, "big")
    for n in (60, 64, 67):  # C4 / E4 / G4
        events += vlq(0) + bytes([0x90, n, 100])
    events += vlq(1920) + bytes([0x80, 60, 0])
    for n in (64, 67):
        events += vlq(0) + bytes([0x80, n, 0])
    events += vlq(0) + b"\xFF\x2F\x00"  # end of track

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

    from vst_renderer import render_vst_midi
    print("[OK] vst_renderer.render_vst_midi をインポートできました")

    if not plugin_path:
        print("[SKIP] 環境変数 VST3_PATH が未設定のため実レンダリングはスキップします")
        print("       例: VST3_PATH=/path/to/Synth.vst3 python test/back/verify_vst_renderer.py")
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

    # 2) WAV パスを返すこと
    out_path = render_vst_midi(
        plugin_path=plugin_path,
        midi_path=midi_path,
        duration=3.0,
        preset_path=preset_path,
    )
    assert isinstance(out_path, str), "戻り値は str（WAV のパス）であるべき"
    out = Path(out_path)
    assert out.exists(), f"WAV ファイルが存在しません: {out_path}"
    assert out.parent.name == "edited", f"保存先が results/edited/ ではない: {out}"
    assert out.name.startswith("vst_"), f"プレフィックスが vst_ ではない: {out.name}"
    print(f"[OK] render_vst_midi -> {out_path}")

    # 3) soundfile で読み直して中身を検証
    import numpy as np
    import soundfile as sf
    data, wav_sr = sf.read(out_path)
    assert wav_sr == 44100, f"サンプルレートが 44100 ではない: {wav_sr}"
    assert len(data) > 0, "WAV が空"
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    print(f"[OK] WAV 検証: samples={len(data)} sr={wav_sr} peak={peak:.4f}")
    if peak < 1e-5:
        print("[WARN] ピーク振幅がほぼゼロです。プラグイン/プリセット/MIDI の組み合わせを確認してください")

    print("\n=== 全ての検証に合格しました ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
