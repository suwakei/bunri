# SCNet の前後処理とモデルの来歴

`backend/scnet_inference.py` の STFT・反射パディング・標準化と振幅復元・区間処理は、
次の JavaScript 実装を基準にした Python 移植です。JavaScript / Node 自体は同梱・実行しません。

- 参照実装: https://github.com/audiojs/neural
- 固定コミット: `6df9aedb25cc10e54e9acddad673aac587c079a9`
- 参照ファイル: `packages/neural-separate/separate.js`
- Copyright (c) Dmitry Iv、MIT。全文は `LICENSE.audiojs`。
- 参照実装が掲げる追加の帰属通知は `NOTICE.audiojs` に原文のまま保存しています。
  これは上流製品全体の通知で、そこに並ぶ全モデルやコードを bunri に取り込んだという意味ではありません。

SCNet のモデル本体の出典は https://github.com/starrytong/SCNet です。
Copyright (c) 2024 starrytong、MIT。モデル配布に添えられた全文を `LICENSE.SCNet` に保存しています。

bunri が初回に取得するのは、audiojs の変換・量子化形式に基づく小型 SCNet の ONNX 配布物です。
学習済み重みそのものはこのソースツリー・アプリバンドルには含めず、利用者のデータ置き場へ取得します。

- 配布元: https://huggingface.co/square-zero-labs/scnet
- 固定リビジョン: `af9bf78fdf676109a67211b32a3b54a1069acd40`
- ファイル: `scnet.int8.onnx`
- SHA-256: `98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845`
- 取得・ハッシュ検証の正本: `backend/modern_models.py`

上記のライセンス・帰属通知は、推論コードとともにデスクトップ版の runtime に再帰コピーします。
