# YouTube の音声を保存する

ターミナルで URL を貼り付け、MP3 または WAV を選んで保存する独立したツール。
保存先はこのリポジトリ直下の `music/`（`./music`）。別の場所から起動しても変わらない。
フォルダは自動作成され、音源は Git の管理対象にならない。

初回に必要なもの（macOS）:

```bash
brew install uv ffmpeg deno
```

リポジトリ直下で実行する:

```bash
make dl 'https://www.youtube.com/watch?v=動画ID'
```

`dl` のあとに貼り付けた URL を引数として渡す。`&` や `?` をシェルに解釈させないため、URL は引用符で囲む。
次の選択肢が出るので、番号を入力して Enter を押す（`mp3` / `wav` も入力できる）。

```text
保存形式を選んでください:
  1) MP3
  2) WAV
選択 [1/2]（Enter: 1 = MP3）:
```

形式の入力で Enter だけを押すと MP3。依存の `yt-dlp` は uv が専用環境に用意する。
bunri 本体の Python 依存やデスクトップアプリのインストールは不要。

形式を直接指定する場合や URL も対話入力したい場合は、Python の入口を使う:

```bash
uv run scripts/youtube_audio.py 'https://www.youtube.com/watch?v=動画ID' --format mp3
uv run scripts/youtube_audio.py 'https://youtu.be/動画ID' --format wav
uv run scripts/youtube_audio.py
```

保存名は「動画タイトル [動画ID].mp3（または .wav）」。既存の同名ファイルは上書きしない。
プレイリスト付きの動画 URL でも動画1本だけを取得する。プレイリスト単独やチャンネルの URL は拒否する。
取得中はプログレスバー・進捗率・取得量を表示する。総量が不明な場合は取得量のみ表示する。
取得が終わると「音声を変換中」、変換が終わると保存先を表示する（取得の100%は変換完了を意味しない）。
中止は Ctrl+C。

URL の不足・不正、形式の入力間違い、uv / FFmpeg の不足、保存先の権限不足や容量不足、
通信・取得・変換の失敗をエラーとして扱う。形式の入力間違いは選び直せる。
取得・変換の失敗時は元のエラーと確認項目を表示し、終了コードを失敗にする。
通信の応答待ちは30秒、取得の再試行は3回まで。中断時も取得プロセスを終了する。

取得と変換には [yt-dlp](https://github.com/yt-dlp/yt-dlp) と FFmpeg を使う。
YouTube の取得処理に必要な JavaScript 実行環境は Deno、またはインストール済みの Node.js を利用する。
取得に失敗した場合は表示されたエラーを確認する。YouTube 側の変更で失敗するときは、
`uv run --refresh scripts/youtube_audio.py` で取得用の依存を更新して試せる。
