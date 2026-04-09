"""詳細音声解析 + 最大レイヤー分離（htdemucs_6s: 6ステム）"""
import subprocess
import sys
import shutil
import tempfile
from pathlib import Path

import soundfile as sf

# htdemucs_6s の6ステム
STEMS_6 = ["vocals", "drums", "bass", "guitar", "piano", "other"]
STEM_LABELS = {
    "vocals": "ボーカル",
    "drums": "ドラム・パーカッション",
    "bass": "ベース",
    "guitar": "ギター",
    "piano": "ピアノ・鍵盤",
    "other": "その他（ストリングス・シンセ等）",
}


def analyze_audio(file_path: str) -> str:
    """
    音声ファイルを解析して構成情報をテキストで返す。

    周波数帯域のエネルギー分布、推定楽器構成、基本情報を出力。
    """
    import numpy as np
    import librosa

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    duration = len(y) / sr

    # RMS（全体の音量）
    rms = np.sqrt(np.mean(y ** 2))
    rms_db = 20 * np.log10(rms + 1e-10)

    # スペクトル解析
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=512))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=4096)

    # 帯域別エネルギー
    bands = {
        "サブベース (20-60Hz)": (20, 60),
        "ベース (60-250Hz)": (60, 250),
        "ローミッド (250-500Hz)": (250, 500),
        "ミッド (500Hz-2kHz)": (500, 2000),
        "ハイミッド (2-4kHz)": (2000, 4000),
        "プレゼンス (4-8kHz)": (4000, 8000),
        "エアー (8kHz+)": (8000, sr / 2),
    }

    band_energy = {}
    total_energy = np.sum(S ** 2)
    for name, (lo, hi) in bands.items():
        mask = (freqs >= lo) & (freqs < hi)
        energy = np.sum(S[mask] ** 2)
        band_energy[name] = energy / (total_energy + 1e-10) * 100

    # テンポ推定
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    if hasattr(tempo, '__len__'):
        tempo = tempo[0]

    # オンセット（打撃音・アタック）の密度
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
    onset_rate = len(onsets) / duration if duration > 0 else 0

    # スペクトル特徴
    centroid = np.mean(librosa.feature.spectral_centroid(y=y, sr=sr))
    bandwidth = np.mean(librosa.feature.spectral_bandwidth(y=y, sr=sr))
    rolloff = np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr))
    zcr = np.mean(librosa.feature.zero_crossing_rate(y))

    # 楽器推定（ヒューリスティック）
    instruments = _estimate_instruments(band_energy, centroid, onset_rate, zcr)

    # チャンネル情報
    info = sf.info(file_path)
    ch_str = "モノラル" if info.channels == 1 else f"ステレオ ({info.channels}ch)"

    # レポート生成
    lines = [
        "## 基本情報",
        f"- **長さ:** {duration:.1f} 秒",
        f"- **サンプルレート:** {info.samplerate} Hz",
        f"- **チャンネル:** {ch_str}",
        f"- **フォーマット:** {info.format} / {info.subtype}",
        f"- **平均音量:** {rms_db:.1f} dB",
        f"- **推定テンポ:** {tempo:.0f} BPM",
        "",
        "## 周波数帯域エネルギー分布",
    ]
    for name, pct in band_energy.items():
        bar = "█" * int(pct / 2) + "░" * (50 - int(pct / 2))
        lines.append(f"- {name}: {bar} {pct:.1f}%")

    lines += [
        "",
        "## スペクトル特徴",
        f"- **スペクトル重心:** {centroid:.0f} Hz（高い=明るい音色）",
        f"- **帯域幅:** {bandwidth:.0f} Hz（広い=豊かな倍音）",
        f"- **ロールオフ:** {rolloff:.0f} Hz（高周波成分の上限）",
        f"- **アタック密度:** {onset_rate:.1f} 回/秒",
        "",
        "## 推定される楽器構成",
    ]
    for inst in instruments:
        lines.append(f"- {inst}")

    lines += [
        "",
        "## 推奨レイヤー分離",
        "**htdemucs_6s（6ステム分離）で以下のレイヤーに分割できます:**",
    ]
    for stem, label in STEM_LABELS.items():
        lines.append(f"- **{stem}** → {label}")

    return "\n".join(lines)


def _estimate_instruments(band_energy, centroid, onset_rate, zcr):
    """帯域エネルギーとスペクトル特徴から楽器を推定"""
    instruments = []

    sub = band_energy.get("サブベース (20-60Hz)", 0)
    bass = band_energy.get("ベース (60-250Hz)", 0)
    low_mid = band_energy.get("ローミッド (250-500Hz)", 0)
    mid = band_energy.get("ミッド (500Hz-2kHz)", 0)
    hi_mid = band_energy.get("ハイミッド (2-4kHz)", 0)
    presence = band_energy.get("プレゼンス (4-8kHz)", 0)
    air = band_energy.get("エアー (8kHz+)", 0)

    # ドラム・パーカッション: 高いオンセット密度 + サブベース/ベース
    if onset_rate > 2.0:
        instruments.append("ドラム・パーカッション（高いアタック密度）")

    # ベース楽器: サブベース+ベース帯域が強い
    if sub + bass > 40:
        instruments.append("ベース楽器（低音域が支配的）")
    elif sub + bass > 20:
        instruments.append("ベース楽器（低音域に存在感あり）")

    # ボーカル: ミッド〜ハイミッドが強い + 適度なZCR
    if mid + hi_mid > 30 and zcr > 0.02:
        instruments.append("ボーカル（中高音域にエネルギー集中）")

    # ギター: ローミッド〜ミッドが強い
    if low_mid + mid > 35:
        instruments.append("ギター系（中低音〜中音域）")

    # ピアノ・鍵盤: 広帯域
    if bass + low_mid + mid + hi_mid > 60 and onset_rate > 1.5:
        instruments.append("ピアノ・鍵盤楽器（広帯域+アタック）")

    # ストリングス: ミッド〜プレゼンスで持続音
    if mid + hi_mid + presence > 30 and onset_rate < 3.0:
        instruments.append("ストリングス・パッド（持続的な中高音）")

    # シンバル・ハイハット: 高域が強い
    if presence + air > 15:
        instruments.append("シンバル・ハイハット等（高音域成分）")

    if not instruments:
        instruments.append("単一楽器または特殊な音源")

    return instruments


def deep_separate(
    file_path: str,
    mp3_output: bool = False,
    segment: int = 7,
) -> dict[str, str]:
    """
    htdemucs_6s で6ステム分離を実行し、各レイヤーのパスを返す。

    Returns:
        {"vocals": path, "drums": path, "bass": path,
         "guitar": path, "piano": path, "other": path}
    """
    src = Path(file_path)
    if not src.exists():
        raise ValueError(f"ファイルが見つかりません: {src}")

    with tempfile.TemporaryDirectory() as tmp_dir:
        dst = Path(tmp_dir) / src.name
        shutil.copy(src, dst)

        out_dir = Path(tmp_dir) / "out"
        runner = str(Path(__file__).parent / "_demucs_runner.py")

        cmd = [
            sys.executable, runner,
            "--out", str(out_dir),
            "-n", "htdemucs_6s",
            "--segment", str(segment),
            "--jobs", "1",
        ]
        if mp3_output:
            cmd.append("--mp3")
        cmd.append(str(dst))

        print(f"[*] 6ステム分離開始: {src.name}")
        print(f"[*] モデル: htdemucs_6s  セグメント: {segment}秒")
        print(f"[*] コマンド: {' '.join(cmd)}\n")

        result = subprocess.run(cmd, capture_output=False, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                "Demucs (htdemucs_6s) の実行に失敗しました。"
                "モデルが自動ダウンロードされます。初回は時間がかかります。"
            )

        ext = ".mp3" if mp3_output else ".wav"
        base = out_dir / "htdemucs_6s" / src.stem

        result_dir = Path("results") / "layers" / src.stem
        result_dir.mkdir(parents=True, exist_ok=True)

        output = {}
        for stem in STEMS_6:
            stem_path = base / f"{stem}{ext}"
            if stem_path.exists():
                dest = result_dir / f"{stem}{ext}"
                shutil.copy(stem_path, dest)
                output[stem] = str(dest)
            else:
                print(f"[!] {stem} が見つかりません: {stem_path}")

    return output
