"""bunri DAW — 音源分離・編集・ミキシングツール"""
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


# ---- ヘルパー ----

def _gr_wrap(module_name, func_name):
    """遅延インポート + ValueError → gr.Error 変換"""
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

with gr.Blocks(title="bunri DAW") as demo:
    gr.Markdown("# bunri DAW\n音源分離・編集・ミキシングツール")

    with gr.Tabs():

        # ============================================================
        # 録音
        # ============================================================
        with gr.Tab("録音"):
            gr.Markdown("マイクから録音してWAVファイルとして保存します。")
            rec_input = gr.Audio(
                sources=["microphone"],
                type="numpy",
                label="録音",
            )
            rec_btn = gr.Button("録音を保存", variant="primary")
            rec_out = gr.File(label="保存されたWAVファイル")
            rec_btn.click(fn=_gr_wrap("recorder", "save_recording"),
                          inputs=[rec_input], outputs=[rec_out])

        # ============================================================
        # 音源分離
        # ============================================================
        with gr.Tab("音源分離"):
            gr.Markdown("WAVファイルをボーカルと伴奏に分離します（CPU処理）")
            with gr.Row():
                with gr.Column():
                    sep_file = gr.File(label="WAVファイル", file_types=[".wav"])
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
            sep_btn.click(fn=run_separation,
                          inputs=[sep_file, model_radio],
                          outputs=[out_vocals, out_backing])

        # ============================================================
        # 編集
        # ============================================================
        with gr.Tab("編集"):
            gr.Markdown("WAVファイルの切り出し・カット・コピーなど基本編集")

            edit_file = gr.File(label="編集するWAVファイル", file_types=[".wav"])
            edit_info = gr.Markdown("")

            with gr.Tabs():
                with gr.Tab("切り出し"):
                    gr.Markdown("指定した範囲だけを取り出します。")
                    with gr.Row():
                        trim_start = gr.Slider(0, 600, value=0, step=0.1, label="開始（秒）")
                        trim_end = gr.Slider(0, 600, value=60, step=0.1, label="終了（秒）")
                    trim_btn = gr.Button("切り出し", variant="primary")
                    trim_out = gr.Audio(label="結果", type="filepath")
                    trim_btn.click(fn=_gr_wrap("edit", "trim_audio"),
                                   inputs=[edit_file, trim_start, trim_end],
                                   outputs=[trim_out])

                with gr.Tab("範囲コピー"):
                    gr.Markdown("指定範囲をコピーして別の位置に挿入します。")
                    with gr.Row():
                        cp_start = gr.Slider(0, 600, value=0, step=0.1, label="コピー開始（秒）")
                        cp_end = gr.Slider(0, 600, value=10, step=0.1, label="コピー終了（秒）")
                    cp_insert = gr.Slider(0, 600, value=0, step=0.1, label="挿入位置（秒）")
                    cp_btn = gr.Button("コピー挿入", variant="primary")
                    cp_out = gr.Audio(label="結果", type="filepath")
                    cp_btn.click(fn=_gr_wrap("edit", "copy_range"),
                                 inputs=[edit_file, cp_start, cp_end, cp_insert],
                                 outputs=[cp_out])

                with gr.Tab("カット"):
                    gr.Markdown("指定した範囲を削除し、前後を繋げます。")
                    with gr.Row():
                        cut_start = gr.Slider(0, 600, value=0, step=0.1, label="開始（秒）")
                        cut_end = gr.Slider(0, 600, value=10, step=0.1, label="終了（秒）")
                    cut_btn = gr.Button("カット", variant="primary")
                    cut_out = gr.Audio(label="結果", type="filepath")
                    cut_btn.click(fn=_gr_wrap("edit", "cut_audio"),
                                  inputs=[edit_file, cut_start, cut_end],
                                  outputs=[cut_out])

                with gr.Tab("分割"):
                    gr.Markdown("指定位置で前半・後半の2ファイルに分割します。")
                    split_pos = gr.Slider(0, 600, value=30, step=0.1, label="分割位置（秒）")
                    split_btn = gr.Button("分割", variant="primary")
                    with gr.Row():
                        split_a = gr.Audio(label="前半", type="filepath")
                        split_b = gr.Audio(label="後半", type="filepath")
                    split_btn.click(fn=_gr_wrap("edit", "split_at"),
                                    inputs=[edit_file, split_pos],
                                    outputs=[split_a, split_b])

                with gr.Tab("無音挿入"):
                    gr.Markdown("指定位置に無音区間を挿入します。")
                    with gr.Row():
                        sil_pos = gr.Slider(0, 600, value=0, step=0.1, label="挿入位置（秒）")
                        sil_len = gr.Slider(0.1, 30, value=1, step=0.1, label="無音の長さ（秒）")
                    sil_btn = gr.Button("無音挿入", variant="primary")
                    sil_out = gr.Audio(label="結果", type="filepath")
                    sil_btn.click(fn=_gr_wrap("edit", "insert_silence"),
                                  inputs=[edit_file, sil_pos, sil_len],
                                  outputs=[sil_out])

                with gr.Tab("ループ"):
                    gr.Markdown("指定範囲をN回繰り返します。")
                    with gr.Row():
                        loop_start = gr.Slider(0, 600, value=0, step=0.1, label="開始（秒）")
                        loop_end = gr.Slider(0, 600, value=10, step=0.1, label="終了（秒）")
                    loop_count = gr.Slider(2, 50, value=4, step=1, label="繰り返し回数")
                    loop_btn = gr.Button("ループ", variant="primary")
                    loop_out = gr.Audio(label="結果", type="filepath")
                    loop_btn.click(fn=_gr_wrap("edit", "loop_range"),
                                   inputs=[edit_file, loop_start, loop_end, loop_count],
                                   outputs=[loop_out])

                with gr.Tab("リバース"):
                    gr.Markdown("音声を逆再生にします。")
                    rev_btn = gr.Button("リバース", variant="primary")
                    rev_out = gr.Audio(label="結果", type="filepath")
                    rev_btn.click(fn=_gr_wrap("edit", "reverse_audio"),
                                  inputs=[edit_file], outputs=[rev_out])

                with gr.Tab("速度変更"):
                    gr.Markdown("再生速度を変更します（ピッチも変わります）。")
                    speed_val = gr.Slider(0.25, 3.0, value=1.0, step=0.05,
                                          label="速度（1.0=等速）")
                    speed_btn = gr.Button("速度変更", variant="primary")
                    speed_out = gr.Audio(label="結果", type="filepath")
                    speed_btn.click(fn=_gr_wrap("edit", "change_speed"),
                                    inputs=[edit_file, speed_val],
                                    outputs=[speed_out])

                with gr.Tab("結合"):
                    gr.Markdown("2つのWAVファイルを前後に繋げます。")
                    concat_f2 = gr.File(label="後ろに繋げるファイル", file_types=[".wav"])
                    concat_btn = gr.Button("結合", variant="primary")
                    concat_out = gr.Audio(label="結果", type="filepath")
                    concat_btn.click(fn=_gr_wrap("edit", "concat_audio"),
                                     inputs=[edit_file, concat_f2],
                                     outputs=[concat_out])

            edit_file.change(
                fn=get_duration, inputs=[edit_file],
                outputs=[trim_start, trim_end, split_pos,
                         cp_start, cp_end, cp_insert, sil_pos, edit_info])

        # ============================================================
        # 音量・パン
        # ============================================================
        with gr.Tab("音量・パン"):
            gr.Markdown("音量調整、ノーマライズ、フェード、パン")

            vp_file = gr.File(label="WAVファイル", file_types=[".wav"])

            with gr.Tabs():
                with gr.Tab("音量調整"):
                    vol_db = gr.Slider(-20, 20, value=0, step=0.5, label="音量変更（dB）")
                    vol_btn = gr.Button("適用", variant="primary")
                    vol_out = gr.Audio(label="結果", type="filepath")
                    vol_btn.click(fn=_gr_wrap("edit", "change_volume"),
                                  inputs=[vp_file, vol_db], outputs=[vol_out])

                with gr.Tab("ノーマライズ"):
                    gr.Markdown("音量を自動で最大レベルに正規化します。")
                    norm_btn = gr.Button("ノーマライズ", variant="primary")
                    norm_out = gr.Audio(label="結果", type="filepath")
                    norm_btn.click(fn=_gr_wrap("edit", "normalize_audio"),
                                   inputs=[vp_file], outputs=[norm_out])

                with gr.Tab("フェードイン"):
                    fi_dur = gr.Slider(0.1, 30, value=3, step=0.1, label="フェード時間（秒）")
                    fi_btn = gr.Button("適用", variant="primary")
                    fi_out = gr.Audio(label="結果", type="filepath")
                    fi_btn.click(fn=_gr_wrap("edit", "fade_in"),
                                 inputs=[vp_file, fi_dur], outputs=[fi_out])

                with gr.Tab("フェードアウト"):
                    fo_dur = gr.Slider(0.1, 30, value=3, step=0.1, label="フェード時間（秒）")
                    fo_btn = gr.Button("適用", variant="primary")
                    fo_out = gr.Audio(label="結果", type="filepath")
                    fo_btn.click(fn=_gr_wrap("edit", "fade_out"),
                                 inputs=[vp_file, fo_dur], outputs=[fo_out])

                with gr.Tab("左右バランス"):
                    pan_val = gr.Slider(-1.0, 1.0, value=0, step=0.05,
                                        label="パン（-1.0=左 / 0=中央 / 1.0=右）")
                    pan_btn = gr.Button("適用", variant="primary")
                    pan_out = gr.Audio(label="結果", type="filepath")
                    pan_btn.click(fn=_gr_wrap("edit", "pan_audio"),
                                  inputs=[vp_file, pan_val], outputs=[pan_out])

        # ============================================================
        # エフェクト
        # ============================================================
        with gr.Tab("エフェクト"):
            gr.Markdown("EQ / コンプレッサー / リバーブ / ディレイ")

            fx_file = gr.File(label="WAVファイル", file_types=[".wav"])

            with gr.Tabs():
                with gr.Tab("EQ（3バンド）"):
                    gr.Markdown("Low (~300Hz) / Mid (300-3kHz) / High (3kHz~)")
                    eq_low = gr.Slider(-12, 12, value=0, step=0.5, label="Low (dB)")
                    eq_mid = gr.Slider(-12, 12, value=0, step=0.5, label="Mid (dB)")
                    eq_high = gr.Slider(-12, 12, value=0, step=0.5, label="High (dB)")
                    eq_btn = gr.Button("EQ適用", variant="primary")
                    eq_out = gr.Audio(label="結果", type="filepath")
                    eq_btn.click(fn=_gr_wrap("effects", "eq_3band"),
                                 inputs=[fx_file, eq_low, eq_mid, eq_high],
                                 outputs=[eq_out])

                with gr.Tab("コンプレッサー"):
                    gr.Markdown("ダイナミクスを圧縮して音量を均一化します。")
                    comp_thresh = gr.Slider(-40, 0, value=-20, step=1,
                                            label="スレッショルド (dB)")
                    comp_ratio = gr.Slider(1.0, 20.0, value=4.0, step=0.5,
                                           label="レシオ")
                    comp_attack = gr.Slider(0.1, 100, value=10, step=0.1,
                                            label="アタック (ms)")
                    comp_release = gr.Slider(10, 1000, value=100, step=10,
                                             label="リリース (ms)")
                    comp_btn = gr.Button("コンプレッサー適用", variant="primary")
                    comp_out = gr.Audio(label="結果", type="filepath")
                    comp_btn.click(fn=_gr_wrap("effects", "compressor"),
                                   inputs=[fx_file, comp_thresh, comp_ratio,
                                           comp_attack, comp_release],
                                   outputs=[comp_out])

                with gr.Tab("リバーブ"):
                    gr.Markdown("残響を付加します。")
                    rv_size = gr.Slider(0.0, 1.0, value=0.5, step=0.05,
                                        label="ルームサイズ（0=小部屋 / 1=ホール）")
                    rv_wet = gr.Slider(0.0, 1.0, value=0.3, step=0.05,
                                       label="Wet（エフェクト量）")
                    rv_btn = gr.Button("リバーブ適用", variant="primary")
                    rv_out = gr.Audio(label="結果", type="filepath")
                    rv_btn.click(fn=_gr_wrap("effects", "reverb"),
                                 inputs=[fx_file, rv_size, rv_wet],
                                 outputs=[rv_out])

                with gr.Tab("ディレイ"):
                    gr.Markdown("やまびこのような繰り返しエフェクトです。")
                    dl_ms = gr.Slider(50, 2000, value=300, step=10,
                                      label="ディレイタイム (ms)")
                    dl_fb = gr.Slider(0.0, 0.9, value=0.4, step=0.05,
                                      label="フィードバック")
                    dl_wet = gr.Slider(0.0, 1.0, value=0.3, step=0.05,
                                       label="Wet（エフェクト量）")
                    dl_btn = gr.Button("ディレイ適用", variant="primary")
                    dl_out = gr.Audio(label="結果", type="filepath")
                    dl_btn.click(fn=_gr_wrap("effects", "delay_effect"),
                                 inputs=[fx_file, dl_ms, dl_fb, dl_wet],
                                 outputs=[dl_out])

        # ============================================================
        # ピッチ・タイム
        # ============================================================
        with gr.Tab("ピッチ・タイム"):
            gr.Markdown("音程と速度を独立して変更できます。")

            pt_file = gr.File(label="WAVファイル", file_types=[".wav"])

            with gr.Tabs():
                with gr.Tab("ピッチシフト（速度維持）"):
                    gr.Markdown("速度を変えずに音程だけを変更します。")
                    ps_semi = gr.Slider(-12, 12, value=0, step=1,
                                        label="半音数（+12=1オクターブ上 / -12=1オクターブ下）")
                    ps_btn = gr.Button("ピッチシフト", variant="primary")
                    ps_out = gr.Audio(label="結果", type="filepath")
                    ps_btn.click(fn=_gr_wrap("pitch_time", "pitch_shift"),
                                 inputs=[pt_file, ps_semi], outputs=[ps_out])

                with gr.Tab("タイムストレッチ（音程維持）"):
                    gr.Markdown("音程を変えずに速度だけを変更します。")
                    ts_rate = gr.Slider(0.25, 3.0, value=1.0, step=0.05,
                                        label="速度（1.0=等速 / 0.5=半速 / 2.0=倍速）")
                    ts_btn = gr.Button("タイムストレッチ", variant="primary")
                    ts_out = gr.Audio(label="結果", type="filepath")
                    ts_btn.click(fn=_gr_wrap("pitch_time", "time_stretch"),
                                 inputs=[pt_file, ts_rate], outputs=[ts_out])

        # ============================================================
        # シンセサイザー
        # ============================================================
        with gr.Tab("シンセ"):
            gr.Markdown("ソフトウェアシンセサイザーで音を生成します。")

            with gr.Tabs():
                with gr.Tab("単音"):
                    gr.Markdown("1つの音を波形・音名・ADSRを指定して生成します。")
                    with gr.Row():
                        sn_note = gr.Dropdown(
                            choices=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"],
                            value="A", label="音名")
                        sn_oct = gr.Slider(1, 8, value=4, step=1, label="オクターブ")
                        sn_dur = gr.Slider(0.1, 5, value=1.0, step=0.1, label="長さ（秒）")
                    sn_wave = gr.Radio(["sine", "square", "sawtooth", "triangle"],
                                       value="sine", label="波形")
                    sn_vol = gr.Slider(0.0, 1.0, value=0.7, step=0.05, label="音量")
                    with gr.Row():
                        sn_a = gr.Slider(0.001, 1.0, value=0.01, step=0.001, label="Attack (秒)")
                        sn_d = gr.Slider(0.001, 1.0, value=0.1, step=0.001, label="Decay (秒)")
                        sn_s = gr.Slider(0.0, 1.0, value=0.7, step=0.05, label="Sustain (レベル)")
                        sn_r = gr.Slider(0.001, 2.0, value=0.3, step=0.001, label="Release (秒)")
                    sn_btn = gr.Button("生成", variant="primary")
                    sn_out = gr.Audio(label="結果", type="filepath")
                    sn_btn.click(fn=_gr_wrap("synth", "synth_note"),
                                 inputs=[sn_note, sn_oct, sn_dur, sn_wave, sn_vol,
                                         sn_a, sn_d, sn_s, sn_r],
                                 outputs=[sn_out])

                with gr.Tab("シーケンサー"):
                    gr.Markdown(
                        "JSON形式で音符データを入力し、メロディを生成します。\n\n"
                        "**フォーマット:** `step`=16分音符単位の開始位置、`length`=長さ（16分音符単位）\n\n"
                        '例（カエルの歌の冒頭）:\n'
                        '```json\n'
                        '[{"note":"C","octave":4,"step":0,"length":4},\n'
                        ' {"note":"D","octave":4,"step":4,"length":4},\n'
                        ' {"note":"E","octave":4,"step":8,"length":4},\n'
                        ' {"note":"F","octave":4,"step":12,"length":4},\n'
                        ' {"note":"E","octave":4,"step":16,"length":4},\n'
                        ' {"note":"D","octave":4,"step":20,"length":4},\n'
                        ' {"note":"C","octave":4,"step":24,"length":8}]\n'
                        '```'
                    )
                    sq_json = gr.Textbox(
                        label="音符データ（JSON）", lines=8,
                        value='[{"note":"C","octave":4,"step":0,"length":4},'
                              '{"note":"E","octave":4,"step":4,"length":4},'
                              '{"note":"G","octave":4,"step":8,"length":4},'
                              '{"note":"C","octave":5,"step":12,"length":8}]',
                    )
                    with gr.Row():
                        sq_bpm = gr.Slider(40, 240, value=120, step=1, label="BPM")
                        sq_wave = gr.Radio(["sine", "square", "sawtooth", "triangle"],
                                           value="square", label="波形")
                    sq_vol = gr.Slider(0.0, 1.0, value=0.5, step=0.05, label="音量")
                    with gr.Row():
                        sq_a = gr.Slider(0.001, 0.5, value=0.01, step=0.001, label="Attack")
                        sq_d = gr.Slider(0.001, 0.5, value=0.05, step=0.001, label="Decay")
                        sq_s = gr.Slider(0.0, 1.0, value=0.6, step=0.05, label="Sustain")
                        sq_r = gr.Slider(0.001, 1.0, value=0.1, step=0.001, label="Release")
                    sq_btn = gr.Button("シーケンス生成", variant="primary")
                    sq_out = gr.Audio(label="結果", type="filepath")
                    sq_btn.click(fn=_gr_wrap("synth", "step_sequencer"),
                                 inputs=[sq_json, sq_bpm, sq_wave, sq_vol,
                                         sq_a, sq_d, sq_s, sq_r],
                                 outputs=[sq_out])

        # ============================================================
        # ドラムマシン
        # ============================================================
        with gr.Tab("ドラム"):
            gr.Markdown("プリセットパターンからドラムトラックを生成します。")
            dm_pattern = gr.Radio(
                ["4つ打ち", "8ビート", "ボサノバ", "レゲエ"],
                value="8ビート", label="パターン")
            with gr.Row():
                dm_bpm = gr.Slider(40, 240, value=120, step=1, label="BPM")
                dm_bars = gr.Slider(1, 32, value=4, step=1, label="小節数")
            dm_vol = gr.Slider(0.0, 1.0, value=0.7, step=0.05, label="音量")
            dm_btn = gr.Button("ドラム生成", variant="primary")
            dm_out = gr.Audio(label="結果", type="filepath")
            dm_btn.click(fn=_gr_wrap("synth", "drum_machine"),
                         inputs=[dm_pattern, dm_bpm, dm_bars, dm_vol],
                         outputs=[dm_out])

        # ============================================================
        # メトロノーム
        # ============================================================
        with gr.Tab("メトロノーム"):
            gr.Markdown("BPMに合わせたクリック音を生成します。録音時のガイドに。")
            with gr.Row():
                mt_bpm = gr.Slider(40, 240, value=120, step=1, label="BPM")
                mt_beats = gr.Radio([2, 3, 4, 5, 6], value=4, label="拍子（1小節の拍数）")
            mt_bars = gr.Slider(1, 64, value=8, step=1, label="小節数")
            mt_vol = gr.Slider(0.0, 1.0, value=0.7, step=0.05, label="音量")
            mt_btn = gr.Button("メトロノーム生成", variant="primary")
            mt_out = gr.Audio(label="結果", type="filepath")
            mt_btn.click(fn=_gr_wrap("metronome", "generate_metronome"),
                         inputs=[mt_bpm, mt_beats, mt_bars, mt_vol],
                         outputs=[mt_out])

        # ============================================================
        # ミキサー
        # ============================================================
        with gr.Tab("ミキサー"):
            gr.Markdown(
                "最大4トラックを個別に音量・パン調整してミックスダウンします。\n\n"
                "例: 伴奏 + ボーカル + コーラス + 効果音 → 1つの楽曲に"
            )

            track_files = []
            track_vols = []
            track_pans = []
            track_mutes = []

            for i in range(1, 5):
                with gr.Row():
                    with gr.Column(scale=3):
                        f = gr.File(label=f"トラック {i}", file_types=[".wav"])
                    with gr.Column(scale=2):
                        v = gr.Slider(-20, 10, value=0, step=0.5,
                                      label=f"音量 {i} (dB)")
                    with gr.Column(scale=2):
                        p = gr.Slider(-1.0, 1.0, value=0, step=0.05,
                                      label=f"パン {i} (L/R)")
                    with gr.Column(scale=1):
                        m = gr.Checkbox(label=f"ミュート {i}", value=False)
                track_files.append(f)
                track_vols.append(v)
                track_pans.append(p)
                track_mutes.append(m)

            master_vol = gr.Slider(-20, 10, value=0, step=0.5, label="マスター音量 (dB)")
            mix_btn = gr.Button("ミックスダウン", variant="primary")
            mix_out = gr.Audio(label="ミックス結果", type="filepath")

            all_inputs = []
            for i in range(4):
                all_inputs.extend([track_files[i], track_vols[i],
                                   track_pans[i], track_mutes[i]])
            all_inputs.append(master_vol)

            mix_btn.click(fn=_gr_wrap("mixer", "mix_tracks"),
                          inputs=all_inputs, outputs=[mix_out])

        # ============================================================
        # 音源合成（オーバーレイ）
        # ============================================================
        with gr.Tab("音源合成"):
            gr.Markdown(
                "ベース音源の上に別の音源を重ねます。\n\n"
                "例: 伴奏の上にボーカルを乗せて1つの曲にする"
            )
            with gr.Row():
                with gr.Column():
                    ovl_base = gr.File(label="ベース音源（伴奏など）", file_types=[".wav"])
                    ovl_base_vol = gr.Slider(-20, 10, value=0, step=0.5,
                                             label="ベース音量 (dB)")
                with gr.Column():
                    ovl_over = gr.File(label="重ねる音源（ボーカルなど）", file_types=[".wav"])
                    ovl_over_vol = gr.Slider(-20, 10, value=0, step=0.5,
                                             label="重ねる音源の音量 (dB)")
            ovl_offset = gr.Slider(0, 600, value=0, step=0.1,
                                   label="オフセット（秒）— ベースの何秒目から重ねるか")
            ovl_btn = gr.Button("合成", variant="primary")
            ovl_out = gr.Audio(label="合成結果", type="filepath")
            ovl_btn.click(fn=_gr_wrap("overlay", "overlay_audio"),
                          inputs=[ovl_base, ovl_over, ovl_offset,
                                  ovl_base_vol, ovl_over_vol],
                          outputs=[ovl_out])

        # ============================================================
        # 解析・レイヤー分離
        # ============================================================
        with gr.Tab("解析・レイヤー分離"):
            gr.Markdown(
                "## 音声解析 + 6ステムレイヤー分離\n\n"
                "音声ファイルの構成を解析し、**htdemucs_6s** モデルで最大6レイヤーに分離します。\n\n"
                "**分離レイヤー:** ボーカル / ドラム / ベース / ギター / ピアノ / その他（ストリングス・シンセ等）"
            )

            ds_file = gr.File(
                label="音声ファイル（WAV / MP3）",
                file_types=[".wav", ".mp3", ".flac", ".ogg", ".m4a"],
            )

            with gr.Tabs():
                with gr.Tab("解析"):
                    gr.Markdown("ファイルの周波数帯域・楽器構成・テンポなどを解析します。")
                    ds_analyze_btn = gr.Button("解析開始", variant="primary")
                    ds_analyze_out = gr.Markdown(label="解析結果")
                    ds_analyze_btn.click(
                        fn=_gr_wrap("deep_separate", "analyze_audio"),
                        inputs=[ds_file],
                        outputs=[ds_analyze_out],
                    )

                with gr.Tab("レイヤー分離"):
                    gr.Markdown(
                        "htdemucs_6s モデルで6つのレイヤーに分離します。\n\n"
                        "**注意:** 初回実行時にモデルが自動ダウンロードされます。"
                        "CPU環境では処理に数分〜十数分かかります。"
                    )
                    ds_mp3 = gr.Checkbox(label="MP3で出力（デフォルトはWAV）", value=False)
                    ds_segment = gr.Slider(
                        3, 15, value=7, step=1,
                        label="セグメント長（秒）— 小さいほどメモリ節約",
                    )
                    ds_sep_btn = gr.Button("6ステム分離開始", variant="primary")
                    gr.Markdown("---")
                    gr.Markdown("### 分離結果")
                    with gr.Row():
                        with gr.Column():
                            ds_vocals = gr.Audio(label="ボーカル", type="filepath")
                            ds_drums = gr.Audio(label="ドラム・パーカッション", type="filepath")
                            ds_bass = gr.Audio(label="ベース", type="filepath")
                        with gr.Column():
                            ds_guitar = gr.Audio(label="ギター", type="filepath")
                            ds_piano = gr.Audio(label="ピアノ・鍵盤", type="filepath")
                            ds_other = gr.Audio(label="その他（ストリングス・シンセ等）", type="filepath")

                    def run_deep_sep(file_obj, mp3_out, seg):
                        from deep_separate import deep_separate
                        if file_obj is None:
                            raise gr.Error("音声ファイルをアップロードしてください")
                        result = deep_separate(
                            str(file_obj), mp3_output=mp3_out, segment=int(seg),
                        )
                        return (
                            result.get("vocals"),
                            result.get("drums"),
                            result.get("bass"),
                            result.get("guitar"),
                            result.get("piano"),
                            result.get("other"),
                        )

                    ds_sep_btn.click(
                        fn=run_deep_sep,
                        inputs=[ds_file, ds_mp3, ds_segment],
                        outputs=[ds_vocals, ds_drums, ds_bass,
                                 ds_guitar, ds_piano, ds_other],
                    )

        # ============================================================
        # フォーマット変換
        # ============================================================
        with gr.Tab("変換"):
            gr.Markdown("MP4/動画 → WAV/MP3 変換、WAV → MP3 書き出し")

            with gr.Tabs():
                with gr.Tab("動画 → WAV"):
                    gr.Markdown("動画ファイルから音声をWAVで抽出します。（要 ffmpeg）")
                    conv_wav_file = gr.File(
                        label="動画ファイル",
                        file_types=[".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4a"],
                    )
                    wav_btn = gr.Button("WAVに変換", variant="primary")
                    wav_out = gr.File(label="変換結果")
                    wav_btn.click(fn=_gr_wrap("convert", "mp4_to_wav"),
                                  inputs=[conv_wav_file], outputs=[wav_out])

                with gr.Tab("動画 → MP3"):
                    gr.Markdown("動画ファイルから音声をMP3で抽出します。（要 ffmpeg）")
                    conv_mp3_file = gr.File(
                        label="動画ファイル",
                        file_types=[".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4a"],
                    )
                    conv_br = gr.Slider(64, 320, value=192, step=32,
                                        label="ビットレート (kbps)")
                    mp3c_btn = gr.Button("MP3に変換", variant="primary")
                    mp3c_out = gr.File(label="変換結果")
                    mp3c_btn.click(fn=_gr_wrap("convert", "mp4_to_mp3"),
                                   inputs=[conv_mp3_file, conv_br],
                                   outputs=[mp3c_out])

                with gr.Tab("WAV → MP3"):
                    gr.Markdown("WAVファイルをMP3に変換します。（要 ffmpeg/lame）")
                    exp_file = gr.File(label="WAVファイル", file_types=[".wav"])
                    exp_br = gr.Slider(64, 320, value=192, step=32,
                                       label="ビットレート (kbps)")
                    exp_btn = gr.Button("MP3に変換", variant="primary")
                    exp_out = gr.File(label="変換結果")
                    exp_btn.click(fn=_gr_wrap("edit", "export_mp3"),
                                  inputs=[exp_file, exp_br], outputs=[exp_out])

if __name__ == "__main__":
    demo.launch(share=False, inbrowser=True, theme=gr.themes.Soft())
