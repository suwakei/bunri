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
uv run scripts/youtube_audio.py
```

URL を貼り付けて Enter、次に `mp3` または `wav` を入力する。
形式の入力で Enter だけを押すと MP3。依存の `yt-dlp` は uv が専用環境に用意する。
bunri 本体の Python 依存やデスクトップアプリのインストールは不要。

引数でも指定できる（URL は引用符で囲む）:

```bash
uv run scripts/youtube_audio.py 'https://www.youtube.com/watch?v=動画ID' --format mp3
uv run scripts/youtube_audio.py 'https://youtu.be/動画ID' --format wav
```

保存名は「動画タイトル [動画ID].mp3（または .wav）」。既存の同名ファイルは上書きしない。
プレイリスト付きの動画 URL でも動画1本だけを取得する。進み具合と変換後の保存先はターミナルに表示する。
中止は Ctrl+C。

取得と変換には [yt-dlp](https://github.com/yt-dlp/yt-dlp) と FFmpeg を使う。
YouTube の取得処理に必要な JavaScript 実行環境は Deno、またはインストール済みの Node.js を利用する。
取得に失敗した場合は表示されたエラーを確認する。YouTube 側の変更で失敗するときは、
`uv run --refresh scripts/youtube_audio.py` で取得用の依存を更新して試せる。
