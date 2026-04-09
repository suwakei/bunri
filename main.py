"""音源分離・編集ツール — Gradio UI"""
import tempfile
import shutil
from pathlib import Path

import gradio as gr
import soundfile as sf

from separate import MODELS


# ---- 音源分離 ----

def run_separation(file_obj, model_label: str) -> tuple:
    from separate import separate_audio

    if file_obj is None:
        raise gr.Error("WAVファイルをアップロードしてください")

    model = model_choices[model_label]

    with tempfile.TemporaryDirectory() as tmp_dir:
        src = Path(file_obj)
        dst = Path(tmp_dir) / src.name
        shutil.copy(src, dst)

        out_dir = Path(tmp_dir) / "out"
        paths = separate_audio(
            input_path=str(dst),
            output_dir=str(out_dir),
            model=model,
            two_stems=True,
            mp3_output=False,
            segment=7,
            jobs=1,
        )

        result_dir = Path("results") / src.stem
        result_dir.mkdir(parents=True, exist_ok=True)

        result = {}
        for key, path in paths.items():
            dest = result_dir / path.name
            shutil.copy(path, dest)
            result[key] = str(dest)

    return result.get("vocals"), result.get("no_vocals")


# ---- 編集ヘルパー（gr.Error でラップ） ----

def _gr_wrap(module_name, func_name):
    """モジュールから関数を遅延インポートし、ValueError を gr.Error に変換するラッパー"""
    def wrapped(*args, **kwargs):
        import importlib
        mod = importlib.import_module(module_name)
        fn = getattr(mod, func_name)
        try:
            return fn(*args, **kwargs)
        except ValueError as e:
            raise gr.Error(str(e))
    return wrapped


def get_duration(file_obj):
    if file_obj is None:
        return (gr.update(),) * 7 + ("",)
    data, sr = sf.read(file_obj)
    duration = len(data) / sr
    dur_text = f"長さ: {duration:.1f} 秒 / サンプルレート: {sr} Hz"
    up_0 = gr.update(maximum=duration, value=0)
    up_end = gr.update(maximum=duration, value=duration)
    return (
        up_0,                                                   # trim_start
        up_end,                                                 # trim_end
        up_0,                                                   # split_pos
        up_0,                                                   # cp_start
        gr.update(maximum=duration, value=min(10, duration)),   # cp_end
        up_0,                                                   # cp_insert
        gr.update(maximum=duration, value=0),                   # sil_pos
        dur_text,
    )


# ---- UI 定義 ----

model_choices = {f"{k}  —  {v}": k for k, v in MODELS.items()}

with gr.Blocks(title="音源分離・編集ツール") as demo:
    gr.Markdown("# 音源分離・編集ツール")

    with gr.Tabs():
        # === タブ1: 音源分離 ===
        with gr.Tab("音源分離"):
            gr.Markdown("WAVファイルをボーカルと伴奏に分離します（CPU処理）")
            with gr.Row():
                with gr.Column():
                    sep_file = gr.File(
                        label="WAVファイルをアップロード",
                        file_types=[".wav"],
                    )
                    model_radio = gr.Radio(
                        choices=list(model_choices.keys()),
                        value=list(model_choices.keys())[0],
                        label="モデル選択（標準を推奨）",
                    )
                    sep_btn = gr.Button("分離開始", variant="primary")
                    gr.Markdown("**注意**: CPU環境では処理に数分かかります。")

                with gr.Column():
                    out_vocals = gr.Audio(label="ボーカル", type="filepath")
                    out_backing = gr.Audio(label="伴奏（ボーカルなし）", type="filepath")

            sep_btn.click(
                fn=run_separation,
                inputs=[sep_file, model_radio],
                outputs=[out_vocals, out_backing],
            )

        # === タブ2: 音声編集 ===
        with gr.Tab("音声編集"):
            gr.Markdown("WAVファイルの切り出し・カット・分割などができます。")

            edit_file = gr.File(
                label="編集するWAVファイル",
                file_types=[".wav"],
            )
            edit_info = gr.Markdown("")

            with gr.Tabs():
                # -- 切り出し（トリム） --
                with gr.Tab("切り出し（トリム）"):
                    gr.Markdown("指定した範囲だけを取り出します。")
                    with gr.Row():
                        trim_start = gr.Slider(0, 600, value=0, step=0.1, label="開始（秒）")
                        trim_end = gr.Slider(0, 600, value=60, step=0.1, label="終了（秒）")
                    trim_btn = gr.Button("切り出し実行", variant="primary")
                    trim_out = gr.Audio(label="切り出し結果", type="filepath")
                    trim_btn.click(fn=_gr_wrap("edit", "trim_audio"),
                                   inputs=[edit_file, trim_start, trim_end],
                                   outputs=[trim_out])

                # -- 範囲コピー --
                with gr.Tab("範囲コピー"):
                    gr.Markdown("指定範囲をコピーして、別の位置に挿入します。")
                    with gr.Row():
                        cp_start = gr.Slider(0, 600, value=0, step=0.1, label="コピー開始（秒）")
                        cp_end = gr.Slider(0, 600, value=10, step=0.1, label="コピー終了（秒）")
                    cp_insert = gr.Slider(0, 600, value=0, step=0.1, label="挿入位置（秒）")
                    cp_btn = gr.Button("コピー挿入実行", variant="primary")
                    cp_out = gr.Audio(label="コピー挿入結果", type="filepath")
                    cp_btn.click(fn=_gr_wrap("edit", "copy_range"),
                                 inputs=[edit_file, cp_start, cp_end, cp_insert],
                                 outputs=[cp_out])

                # -- カット（範囲削除） --
                with gr.Tab("カット（範囲削除）"):
                    gr.Markdown("指定した範囲を削除し、前後を繋げます。")
                    with gr.Row():
                        cut_start = gr.Slider(0, 600, value=0, step=0.1, label="開始（秒）")
                        cut_end = gr.Slider(0, 600, value=10, step=0.1, label="終了（秒）")
                    cut_btn = gr.Button("カット実行", variant="primary")
                    cut_out = gr.Audio(label="カット結果", type="filepath")
                    cut_btn.click(fn=_gr_wrap("edit", "cut_audio"),
                                  inputs=[edit_file, cut_start, cut_end],
                                  outputs=[cut_out])

                # -- 分割 --
                with gr.Tab("分割"):
                    gr.Markdown("指定位置で前半・後半の2ファイルに分割します。")
                    split_pos = gr.Slider(0, 600, value=30, step=0.1, label="分割位置（秒）")
                    split_btn = gr.Button("分割実行", variant="primary")
                    with gr.Row():
                        split_a = gr.Audio(label="前半", type="filepath")
                        split_b = gr.Audio(label="後半", type="filepath")
                    split_btn.click(fn=_gr_wrap("edit", "split_at"),
                                    inputs=[edit_file, split_pos],
                                    outputs=[split_a, split_b])

                # -- 音量調整 --
                with gr.Tab("音量調整"):
                    gr.Markdown("音量をdB単位で上げ下げします。")
                    vol_db = gr.Slider(-20, 20, value=0, step=0.5, label="音量変更（dB）")
                    vol_btn = gr.Button("音量変更", variant="primary")
                    vol_out = gr.Audio(label="音量変更結果", type="filepath")
                    vol_btn.click(fn=_gr_wrap("edit", "change_volume"),
                                  inputs=[edit_file, vol_db],
                                  outputs=[vol_out])

                # -- フェードイン --
                with gr.Tab("フェードイン"):
                    gr.Markdown("先頭から徐々に音量を上げます。")
                    fi_dur = gr.Slider(0.1, 30, value=3, step=0.1, label="フェード時間（秒）")
                    fi_btn = gr.Button("フェードイン適用", variant="primary")
                    fi_out = gr.Audio(label="フェードイン結果", type="filepath")
                    fi_btn.click(fn=_gr_wrap("edit", "fade_in"),
                                 inputs=[edit_file, fi_dur],
                                 outputs=[fi_out])

                # -- フェードアウト --
                with gr.Tab("フェードアウト"):
                    gr.Markdown("末尾に向かって徐々に音量を下げます。")
                    fo_dur = gr.Slider(0.1, 30, value=3, step=0.1, label="フェード時間（秒）")
                    fo_btn = gr.Button("フェードアウト適用", variant="primary")
                    fo_out = gr.Audio(label="フェードアウト結果", type="filepath")
                    fo_btn.click(fn=_gr_wrap("edit", "fade_out"),
                                 inputs=[edit_file, fo_dur],
                                 outputs=[fo_out])

                # -- 無音挿入 --
                with gr.Tab("無音挿入"):
                    gr.Markdown("指定位置に無音区間を挿入します。")
                    with gr.Row():
                        sil_pos = gr.Slider(0, 600, value=0, step=0.1, label="挿入位置（秒）")
                        sil_len = gr.Slider(0.1, 30, value=1, step=0.1, label="無音の長さ（秒）")
                    sil_btn = gr.Button("無音挿入", variant="primary")
                    sil_out = gr.Audio(label="無音挿入結果", type="filepath")
                    sil_btn.click(fn=_gr_wrap("edit", "insert_silence"),
                                  inputs=[edit_file, sil_pos, sil_len],
                                  outputs=[sil_out])

                # -- ノーマライズ --
                with gr.Tab("ノーマライズ"):
                    gr.Markdown("音量を自動で最大レベルに正規化します。")
                    norm_btn = gr.Button("ノーマライズ実行", variant="primary")
                    norm_out = gr.Audio(label="ノーマライズ結果", type="filepath")
                    norm_btn.click(fn=_gr_wrap("edit", "normalize_audio"),
                                   inputs=[edit_file],
                                   outputs=[norm_out])

                # -- リバース（逆再生） --
                with gr.Tab("リバース"):
                    gr.Markdown("音声を逆再生にします。")
                    rev_btn = gr.Button("リバース実行", variant="primary")
                    rev_out = gr.Audio(label="リバース結果", type="filepath")
                    rev_btn.click(fn=_gr_wrap("edit", "reverse_audio"),
                                  inputs=[edit_file],
                                  outputs=[rev_out])

                # -- ループ（繰り返し） --
                with gr.Tab("ループ"):
                    gr.Markdown("指定範囲をN回繰り返します。伴奏ループの作成などに。")
                    with gr.Row():
                        loop_start = gr.Slider(0, 600, value=0, step=0.1, label="開始（秒）")
                        loop_end = gr.Slider(0, 600, value=10, step=0.1, label="終了（秒）")
                    loop_count = gr.Slider(2, 50, value=4, step=1, label="繰り返し回数")
                    loop_btn = gr.Button("ループ実行", variant="primary")
                    loop_out = gr.Audio(label="ループ結果", type="filepath")
                    loop_btn.click(fn=_gr_wrap("edit", "loop_range"),
                                   inputs=[edit_file, loop_start, loop_end, loop_count],
                                   outputs=[loop_out])

                # -- 左右バランス（パン） --
                with gr.Tab("左右バランス"):
                    gr.Markdown("音声の左右バランスを調整します。")
                    pan_val = gr.Slider(-1.0, 1.0, value=0, step=0.05,
                                        label="パン（-1.0=左 / 0=中央 / 1.0=右）")
                    pan_btn = gr.Button("パン適用", variant="primary")
                    pan_out = gr.Audio(label="パン結果", type="filepath")
                    pan_btn.click(fn=_gr_wrap("edit", "pan_audio"),
                                  inputs=[edit_file, pan_val],
                                  outputs=[pan_out])

                # -- 速度変更 --
                with gr.Tab("速度変更"):
                    gr.Markdown("再生速度を変更します（ピッチも変わります）。")
                    speed_val = gr.Slider(0.25, 3.0, value=1.0, step=0.05,
                                          label="速度（1.0=等速 / 0.5=半速 / 2.0=倍速）")
                    speed_btn = gr.Button("速度変更", variant="primary")
                    speed_out = gr.Audio(label="速度変更結果", type="filepath")
                    speed_btn.click(fn=_gr_wrap("edit", "change_speed"),
                                    inputs=[edit_file, speed_val],
                                    outputs=[speed_out])

                # -- MP3書き出し --
                with gr.Tab("MP3書き出し"):
                    gr.Markdown("WAVをMP3（またはFLAC）に変換します。\n\n"
                                "MP3にはlameまたはffmpegが必要です。なければFLACで出力します。")
                    mp3_br = gr.Slider(64, 320, value=192, step=32, label="ビットレート (kbps)")
                    mp3_btn = gr.Button("書き出し", variant="primary")
                    mp3_out = gr.File(label="書き出し結果")
                    mp3_btn.click(fn=_gr_wrap("edit", "export_mp3"),
                                  inputs=[edit_file, mp3_br],
                                  outputs=[mp3_out])

            # ファイルアップロード時にスライダー上限を自動調整
            edit_file.change(
                fn=get_duration,
                inputs=[edit_file],
                outputs=[trim_start, trim_end, split_pos,
                         cp_start, cp_end, cp_insert, sil_pos, edit_info],
            )

        # === タブ3: ファイル結合 ===
        with gr.Tab("ファイル結合"):
            gr.Markdown("2つのWAVファイルを順番に繋げて1つにします。")
            with gr.Row():
                concat_f1 = gr.File(label="1番目のファイル", file_types=[".wav"])
                concat_f2 = gr.File(label="2番目のファイル", file_types=[".wav"])
            concat_btn = gr.Button("結合実行", variant="primary")
            concat_out = gr.Audio(label="結合結果", type="filepath")
            concat_btn.click(fn=_gr_wrap("edit", "concat_audio"),
                             inputs=[concat_f1, concat_f2],
                             outputs=[concat_out])

        # === タブ4: 音源合成（オーバーレイ） ===
        with gr.Tab("音源合成"):
            gr.Markdown(
                "ベース音源の上に別の音源を重ねます。\n\n"
                "例: 伴奏の上にボーカルを乗せて1つの曲にする"
            )
            with gr.Row():
                with gr.Column():
                    ovl_base = gr.File(label="ベース音源（伴奏など）", file_types=[".wav"])
                    ovl_base_vol = gr.Slider(-20, 10, value=0, step=0.5,
                                             label="ベース音量調整（dB）")
                with gr.Column():
                    ovl_over = gr.File(label="重ねる音源（ボーカルなど）", file_types=[".wav"])
                    ovl_over_vol = gr.Slider(-20, 10, value=0, step=0.5,
                                             label="重ねる音源の音量調整（dB）")
            ovl_offset = gr.Slider(
                0, 600, value=0, step=0.1,
                label="重ねる音源の開始オフセット（秒）— ベースの何秒目から重ねるか",
            )
            ovl_btn = gr.Button("合成実行", variant="primary")
            ovl_out = gr.Audio(label="合成結果", type="filepath")
            ovl_btn.click(fn=_gr_wrap("overlay", "overlay_audio"),
                          inputs=[ovl_base, ovl_over, ovl_offset,
                                  ovl_base_vol, ovl_over_vol],
                          outputs=[ovl_out])

        # === タブ5: フォーマット変換 ===
        with gr.Tab("フォーマット変換"):
            gr.Markdown(
                "MP4/動画ファイルから音声を抽出してWAVまたはMP3に変換します。\n\n"
                "**ffmpeg が必要です。**"
            )
            conv_file = gr.File(
                label="MP4ファイルをアップロード",
                file_types=[".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4a"],
            )
            with gr.Tabs():
                with gr.Tab("→ WAV"):
                    gr.Markdown("音声をWAV（無圧縮）として抽出します。")
                    wav_btn = gr.Button("WAVに変換", variant="primary")
                    wav_out = gr.File(label="変換結果（WAV）")
                    wav_btn.click(fn=_gr_wrap("convert", "mp4_to_wav"),
                                  inputs=[conv_file],
                                  outputs=[wav_out])

                with gr.Tab("→ MP3"):
                    gr.Markdown("音声をMP3として抽出します。")
                    conv_br = gr.Slider(64, 320, value=192, step=32, label="ビットレート (kbps)")
                    mp3_btn = gr.Button("MP3に変換", variant="primary")
                    mp3_out = gr.File(label="変換結果（MP3）")
                    mp3_btn.click(fn=_gr_wrap("convert", "mp4_to_mp3"),
                                  inputs=[conv_file, conv_br],
                                  outputs=[mp3_out])

if __name__ == "__main__":
    demo.launch(share=False, inbrowser=True, theme=gr.themes.Soft())
