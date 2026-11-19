# 分離モデル・実行基盤の比較方法

対象は bunri の分離精度、音量保持、実行時間、メモリ。アプリ本体の依存を変える前に、
独立した環境で同じWAVを処理する。比較入口は `backend/separation_bench.py`。

## 入力と指標

2026-11-19 の比較入力は次の5ケース。結果を見て区間を選び直さない。

- 利用者の手元のゲーム音楽：30秒開始と90秒開始の各15秒。各パートの正解は無い。
- [SigSep公式の7秒サンプル](https://zenodo.org/records/3270814)：testをファイル名の辞書順に並べた先頭3曲。
  デコード実長は6.8秒。AACの混合ファイルと参照和に差があるため、正解4パートの和を全モデル共通入力にする。
  サンプルの配布条件は曲ごとに異なる。元音声・分離音声をリポジトリや外部サービスへ送らない。

サンプルZIPの公式MD5は `dc2bdfac5b46ce742bd60009866758a5`、取得した実体のSHA-256は
`365f66acffc57282e474a4c24b32afec3678258c50b8d45646ac849b0a287df3`。
2曲目には公式の「synth vocals mixed into other」という正解側の注記がある。
これは短いスモーク比較で、MUSDB全体やゲーム音楽全般の順位を示さない。

音量を正規化せず、時間ずれを探索して合わせず、各パートの左右を保って比較する。
レートは評価時だけ入力へそろえる。6パート版のギター・ピアノは「その他」へ合算する。

| 指標 | 意味と制約 |
|---|---|
| 波形SDR | `10 log10(参照エネルギー / 誤差エネルギー)`。音量を合わせない。論文のBSS Evalとは別物 |
| SI-SDR | 投影によって音量倍率を除いた補助指標。音量保持の判定に単独では使わない。推定が無音なら未定義 |
| RMS音量差 | 推定と正解のRMS比。0 dBが同じ。混入によるエネルギーも含み、正しい楽器の音量だけを測る値ではない |
| 投影ゲイン | 正解に沿った成分の倍率と極性。相関する楽器の影響を受ける |
| 再構成誤差 | 全パートを足した音と入力の差。各楽器へ正しく分かれた証明には使わない |
| 経過時間 | プロセス起動・import・モデル読込・ハッシュ検証・推論・保存を含む。runner側で可能な範囲の内訳も記録 |
| 最大RSS | macOS/Linuxのwait4で測るCPUプロセスの値。GPU/ANE/別サービスを含む総メモリではない |

各ケースは一回ずつ、同時にモデルを走らせず固定順に計測する。時間はそのMacと条件に限る。
GPUの別プロセスやバックグラウンド負荷まで完全には統制していない。

## 実行

入力の作成もCLIで再現できる。公式ZIPを取得した上で、新しい出力先を指定する。
既存の入力は上書きしない。

```sh
uv run --frozen python backend/_bench_inputs.py \
  --local-file 'music/対象曲.mp3' \
  --public-archive /tmp/bunri-model-bench/data/MUSDB18-7-STEMS.zip \
  --output-dir results/separation-bench/new-run/inputs
```

実験用のマニフェストは次の形。コマンドは配列で渡し、shellを経由しない。
入力の絶対パスと正解ディレクトリ、各runnerの環境は、そのマシンで用意する。

```json
{
  "cases": [{"id": "case-01", "input": "/path/mixture.wav", "references": "/path/references"}],
  "candidates": [{
    "id": "demucs-ft-cpu", "device": "cpu",
    "command": ["/path/bunri/.venv/bin/python", "/path/bunri/backend/separation_bench.py", "demucs",
                "--input", "{input}", "--output-dir", "{output_dir}", "--model", "htdemucs_ft"]
  }]
}
```

```sh
uv run --frozen python backend/separation_bench.py run \
  --manifest /path/comparison.json --output-dir results/separation-bench/run-01 --resume
uv run --frozen python backend/separation_bench.py report \
  --manifest /path/comparison.json --output-dir results/separation-bench/run-01
```

各runnerは `--input` / `--output-dir` を受け、直下へfloat32のパートWAVと `metadata.json` を出す。
全体は `benchmark.json` に入力・出力のハッシュ、コマンド、コードハッシュ、経過時間、RSS、失敗を残す。
`report.json` と、ローカル音声を再生できる `report.html` を生成する。6パートの聴き比べ用「その他」も合算する。
再評価コマンドはモデルを動かさず出力ハッシュを照合し、実行時の指紋を残したまま評価コードのハッシュを追記する。
失敗した方式は消さずに表示する。モデル推論は通常のpytestでは実行しない。

## 比較する実装

| 実装 | 役割と条件 |
|---|---|
| `separation_bench.py demucs` | 既存FTと6s。CPU4threads、segment7、jobs1、shifts1、seed0。保存時の音量変更なし |
| `_bench_subroformer.py` | 知覚調整済み4パート。同じ重みのCPU FP32 / MPS FP16 autocast / Core ML FP16。2秒・4重オーバーラップ |
| `_bench_roformer.py` | BS-RoFormer-SWの6パートをMLXで実行。13.35秒・50%重複。公開変換重みを全パラメータ照合。許諾unknownのため実験専用で配布対象外 |
| `_bench_scnet_onnx.py` | 小型SCNet int8をJavaScript＋ONNX Runtime Node CPU4threadsで実行。SCNet XLやfloat32版と同じモデルとして扱わない |

SubRoformerはCPU/MPS/Core MLで数値精度が異なるため、「言語だけ」の比較ではない。
SCNetは公式JavaScript実装のSTFT・標準化・振幅復元・区間処理をそのまま用いる。
Rust/C++で実装する場合は、このONNX結果との一致を先に確認する。言語を変えたことだけで精度向上とはしない。

## 固定した外部環境

以下は実験環境の再現用。通常の `pyproject.toml` / `uv.lock` へ混ぜない。
取得した重みは各runnerに記した固定SHAと照合する。モデル取得を通常の単体テストへ入れない。

### SubRoformer

公式コード `https://github.com/ArchiMickey/SubRoformer` の
`bf4e35aff7905c8cd43b8d7365ffd1bcc7d1df02` を別ディレクトリへcheckoutする。
固定HF revision `391ad82f0db325724fcefd40850d51ae27a9c115` の知覚調整済みsafetensorsと
同版Core ML artifactを使う。取得と各ファイルのハッシュ照合はrunnerが行う。
モデルの全学習依存を入れる代わりに、既存bunriの環境を読み取り専用で参照した独立venvへ不足依存だけ追加する。
全解決版は結果の `evidence/` 配下のfreezeを保存する。既存環境の版が変われば同条件ではない。

```sh
uv venv --python .venv/bin/python /tmp/bunri-model-bench/subroformer/venv
.venv/bin/python - <<'PY'
from pathlib import Path
target = Path('/tmp/bunri-model-bench/subroformer/venv/lib/python3.11/site-packages')
target.joinpath('bunri-readonly-dependencies.pth').write_text(str(Path('.venv/lib/python3.11/site-packages').resolve()) + '\n')
PY
uv pip install --python /tmp/bunri-model-bench/subroformer/venv/bin/python --no-deps \
  omegaconf==2.3.0 ml-collections==1.1.0 antlr4-python3-runtime==4.9.3
```

今回の基底環境はtorch 2.15.0、numpy 2.4.6、librosa 0.11.0、scipy 1.17.1、
soundfile 0.14.0、coremltools 9.0を含んだ。Core MLはmacOS 15以上。
基底環境にCore ML用の依存が無い場合は実験環境へ `coremltools==9.0 pyaml==26.7.0 attrs==26.1.0 cattrs==26.2.1`
を追加し、残りの依存も保存したfreezeに合わせる。
Torch 2.15はcoremltoolsの検証範囲外という上流の警告があるので、動作した区間以外まで互換性を保証しない。

```sh
/tmp/bunri-model-bench/subroformer/venv/bin/python backend/_bench_subroformer.py \
  --input /path/mixture.wav --output-dir /path/result \
  --source-dir /tmp/bunri-model-bench/subroformer/source --device mps
```

### RoFormer / MLX

`https://github.com/ssmall256/mlx-audio-separator` を
`2f55dca7441cf8b243f4937d28dfe3dc4d60a8d3` へ固定。
別venvにそのcheckoutとsoundfile/scipyを入れる。HFの `ssmall256/mlx-audio-separator`、
revision `679ec88c16a262170d617b02ee7f25da6dd137eb` から
`models/bs-roformer-sw/{model.safetensors,config.json}` を取得する。
重みの許諾が未確認なので、この実験結果だけでアプリに搭載しない。

```sh
/tmp/bunri-model-bench/roformer/venv/bin/python backend/_bench_roformer.py \
  --input /path/mixture.wav --output-dir /path/result --device mlx
```

### SCNet / JavaScript / ONNX

`https://github.com/audiojs/neural` を
`6df9aedb25cc10e54e9acddad673aac587c079a9` へ固定。
別のNode環境へ `@audio/neural-runtime@0.2.0`、`@audio/resample-sinc@1.1.2`、
`fourier-transform@2.4.1`、`onnxruntime-node@1.29.0` を導入し、そのnode_modulesを
checkoutの `packages/neural-separate/node_modules` から参照する。
HF `square-zero-labs/scnet` の revision `af9bf78fdf676109a67211b32a3b54a1069acd40` から
`scnet.int8.onnx` とLICENSEを取得。Node lockfileも結果のevidenceへ保管する。

```sh
uv run --frozen python backend/_bench_scnet_onnx.py \
  --input /path/mixture.wav --output-dir /path/result --device cpu
```

いずれの外部checkoutもコードのコミットIDとtracked変更なしを検証する。
単体テストで取得・実推論は行わない。
