# パート分離の品質と音量

2026-11-19。「分けた音に別の楽器が混ざる・音が欠ける・小さくなる」という利用者の指摘への変更。

## 分け方

「学ぶ」の `POST /api/decompose` は Form の `model` で次を選ぶ。省略時は `subroformer`。
未対応の値は HTTP 422 で、処理やモデル取得を始めずに拒否する。成功結果の `model` は使った値。

| 値 | 画面での扱い | 出力 |
|---|---|---|
| `subroformer` | 精度を優先（既定）。対応MacはMPS、他はCPU | ボーカル・ドラム・ベース・その他 |
| `scnet` | 速さを優先。ONNX RuntimeのCPU | 同上 |
| `htdemucs_ft` | 従来の分離優先版 | 同上 |
| `htdemucs` | 速さを優先 | 同上 |
| `htdemucs_6s` | ギター・ピアノも分ける | 上記にギター・ピアノを追加 |

FT は標準の約4倍の処理時間が目安で、どの曲でも改善する保証ではない。
6パート版は実験的なモデルで、特にピアノへの混入や音の崩れが公式に記載されている。
[Demucs 公式説明](https://github.com/facebookresearch/demucs#separating-tracks)

「その他」を同じ6パートモデルへ再投入する処理は、学ぶ経路では実行しない。
元の「その他」をそのまま残す。`deep_separate` の明示した `recursive_depth > 0` と
`/api/deep-separate` の明示した `depth` による再分離は維持する。

## 音量の保持

分離パートの音量は、それぞれを同じ大きさにそろえない。Demucs の既定の `rescale` は、
パートごとのピーク次第で振幅を縮め、相対音量を変えるため、WAV は `--clip-mode none --float32` を使う。
`_demucs_runner.py` の保存パッチも `PCM_F` / `bits_per_sample` を尊重する。
Demucs 4.1 は `torchaudio.save` を通らず独自の `encode_wav` で浮動小数点もクリップするため、
その浮動小数点の経路も soundfile へ差し替える。整数 PCM の経路は変えない。
1を超えるピークもクリップせず保存する。MP3 へ明示出力する経路は従来のクリップ対策を保つ。

分離音声はWAVのままコピーする。入力がMP3でも、ダウンロード名・Content-TypeはWAVに合わせる。
フロントは測定した `mix.volume_db` / `mix.pan` / 残響を音声へ重ねて適用しない。
分離音にすでに含まれている音量・定位・残響を二重に変えないため。

無音判定は全チャンネルのピークが −80 dBFS 未満かで行う。ステレオをモノラルに平均しない。
左右逆相・曲の短い区間だけ鳴るパート・小さい音を、曲全体のRMSだけで消さない。
ファイルをブロック単位で読み、無音判定だけのために全体をメモリへ置かない。

ここで保証するのは、**モデルが出した音を保存・取り込み時に余計に縮めないこと**。
モデル自身の混入・欠落や、分離結果の和が原曲と完全一致することは保証しない。
真の単独パートがない曲では、そのパートの正しい音量を一意に検証できない。

## 新しいモデルの実装

SubRoformerと小型SCNetのエンジンを実装し、通常の画面から選べるようにした。
既定はSubRoformer。初回は選んだモデルだけを取得する（約207 MB / 約13 MB）。
固定revisionの重みをSHA-256とサイズで照合し、使う直前にも破損を確認する。
SubRoformerのコードと設定・MITライセンスは `backend/_vendor/subroformer/` に同梱する。
SCNetは比較したJavaScriptの処理をNumPy/SciPy/ONNX Runtimeへ移植し、Nodeを不要にした。
通常動作で比較環境・`/tmp`・外部checkout・実行時コンパイラを必要としない。

モデルの取得も推論も子プロセス内で行う。取得バイト数と処理区間数で進み具合を表示し、
中止時は子プロセスと変換用ffmpegを終了する。取得途中の`.part`と分離途中の出力は消し、
取得済みの正常な重みは残す。失敗理由はジョブ経由で画面へ伝え、別モデルへ黙って切り替えない。
再分離を頼んだ場合も、モデル専用の中間出力だけを初期化し、画面の旧パートは成功するまで保持する。

導入前の調査で確認した事項:

- [SubRoformer 公式](https://github.com/ArchiMickey/SubRoformer) は4パート、CPU・MPS対応、safetensorsを配布。
  作者の公開値はMUSDB18-HQでの評価で、対象のゲーム音楽での優位性は未検証。
  パッケージ全体は学習用依存も多いため、推論に必要な部分をMITで同梱し、学習用依存は入れない。
- [BS-RoFormer-Infer 公式](https://github.com/openmirlab/bs-roformer-infer) は推論用だが、
  既定6パート重みの来歴・ライセンス未確認を明記し、追加モデルをsafetensorsに限る既存方針にもそのまま合わない。

導入判断には同一区間の混入・欠落、CPU時間、ピークメモリの比較が要る。
パート数や単一ベンチマークの値だけで既定エンジンを替えない。

その後、5モデル・7実行条件・5区間の実比較を実施した。
[比較結果と次の導入候補](benchmarks/separation-2026-11-19.md)、
[比較ツールと再現方法](benchmarks/separation-method.md) を参照。
比較時点では既定を替えず、その後の本番実装でSubRoformerへ変更した。

## 検証

`test_separation_fidelity.py` は浮動小数点保存の振幅、左右差、フルスケール超過、
実Demucs引数の受け付け、無音判定とモデル選択を確かめる。
`test_decompose.py` は選んだモデルへ一度だけ渡し、左右・小音・ピークをコピーで変えないことを確認。
`test_job_routes.py` はモデル選択・不正値の拒否・WAV名と実体・進捗を確認する。
`learn.test.tsx` と `learn.spec.ts` は画面の選択とAPIへ渡す値を確認する。
本物の窓の `smoke.test.ts` の音楽取り込みケースでは、float32 ステレオ WAV を取り込み、
Rust の描画後も入力とピークが一致することを確認する（分離計算の応答は合成）。
通常のテストで実モデルの重みをダウンロードしたり、実LLMを呼んだりしない。

本番実装では `test_modern_models.py` / `test_modern_separate.py` / `test_modern_inference.py` で
取得・破損検出・進捗・中止と後片付け・左右と振幅・再実行を検証する。
同梱コードと設定・ライセンスはvendorとprepare-desktopのテストで確認する。
SCNet移植版は正解付き6.8秒と15秒の実出力で比較時JavaScript版と照合し、最大絶対差は1.1〜2.4×10⁻⁷。

本物の窓の実モデル検証は、固定重みを用意したときだけ明示的に実行する。
`BUNRI_E2E_MODEL_FIXTURES` は `modern_models.py` の2つのファイル名で重みを置いたディレクトリ。
テストは隔離した置き場へコピーし、新モデルのUI選択→実API→同梱worker→音声デコードと連続再分離を確認する。

```sh
cd web-ui
node e2e-desktop/build.mjs
BUNRI_E2E_MODEL_FIXTURES=/absolute/path/to/models npx vitest run \
  --config e2e-desktop/vitest.config.ts -t '同梱sidecarでSubRoformer'
```
