# Twitter / X — Tweet Drafts

---

## English

### Launch Tweet (pin this)

```
Bunri — turn any song into an editable piano roll, fully offline.

Drop in a WAV/MP3 → Demucs separates stems → polyphonic pitch detection → notes appear in the piano roll.

Open source. No subscription. Runs on CPU.

[DEMO VIDEO LINK]

github.com/[YOUR_USERNAME]/bunri
```

(268 chars with placeholder — trim the demo link once you have the real URL)

---

### Thread (post as replies to the launch tweet)

**Tweet 2 — the pipeline:**

```
How it works:

1/ Demucs (Meta AI) splits the track into 6 stems: vocals, drums, bass, guitar, piano, other

2/ Each stem runs pitch detection — polyphonic STFT for melody/chords, onset+spectral for drums

3/ Notes land in a piano roll you can edit, swap instruments, and export
```

**Tweet 3 — AI assistant:**

```
There's also an AI composition assistant.

Type "4-bar sad chord progression in Am" → notes appear in the piano roll.

Runs on Ollama + Gemma 3 locally (free, offline). Falls back to Claude API if you want it.

No data leaves your machine either way.
```

**Tweet 4 — stack:**

```
Tech stack for the curious:

Backend: Python / FastAPI
Audio: Demucs / librosa / PyFluidSynth (84 GM voices)
Frontend: React 19 / TypeScript / Vite 8
AI: Ollama (Gemma 3 4B/12B) + optional Anthropic API

CPU only, no GPU needed.
```

**Tweet 5 — call to action:**

```
The polyphonic transcription is home-rolled — no Basic Pitch yet.

Works well on bass lines and single-instrument stems. Dense chords in busy mixes are harder.

Would love contributors, especially on the pitch detection side.

github.com/[YOUR_USERNAME]/bunri
```

---

## Japanese

### Launch Tweet

```
Bunri — 曲をピアノロールに変換するオープンソースDAW。完全オフライン。

WAV/MP3を読み込む → Demucsでステム分離 → ポリフォニックピッチ検出 → ピアノロールに自動配置

サブスクなし、GPU不要、ローカル動作。

[デモ動画リンク]

github.com/[YOUR_USERNAME]/bunri
```

---

### Japanese Thread

**ツイート2:**

```
パイプラインの説明

1/ Demucs（Meta AI）で6ステム分離：ボーカル/ドラム/ベース/ギター/ピアノ/その他

2/ 各ステムにピッチ検出（メロディはSTFT倍音解析、ドラムはオンセット検出）

3/ 検出したノートをピアノロールに自動配置、編集・書き出し可能
```

**ツイート3:**

```
AIアシスタント機能もあります。

「4小節の切ないコード進行（Aマイナー）」と入力するとノートを提案。

Ollama + Gemma 3でローカル推論（無料・オフライン）、オプションでAnthropic Claude APIも使えます。

データは一切外に出ません。
```

**ツイート4:**

```
技術スタック

バックエンド：Python / FastAPI
音声処理：Demucs / librosa / PyFluidSynth（GM音源84音色）
フロントエンド：React 19 / TypeScript / Vite 8
AI：Ollama（Gemma 3）+ Claude API（任意）

GPU不要、CPU動作。8GBのラップトップで動作確認済み。
```

---

## Timing Notes

- Post the launch tweet and the first 2-3 thread replies at the **same time** — don't drip them over hours on launch day.
- Pin the launch tweet to your profile immediately.
- If you have a demo video, the launch tweet should have the video embedded, not just a link.
- Best window: Tuesday–Thursday, 9–11am US Pacific (12pm–2pm Eastern).
- Tag `#opensource`, `#musicproduction`, `#buildinpublic` on the launch tweet. Don't over-hashtag.
