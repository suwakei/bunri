# bunri DAW — Technical Reference

This document is the factual deep-dive for developers and power users.
For the quick overview, see [README.md](../README.md).

---

## Table of Contents

1. [Feature List](#feature-list)
2. [API Endpoints](#api-endpoints)
3. [Development Commands](#development-commands)
4. [Architecture](#architecture)
5. [Design Principles](#design-principles)

---

## Feature List

### DAW Screen (`/`)

Layout: header / learning-flow progress bar / left panel (resizable, 280–520 px) + center (timeline above, piano roll below) / status bar.

- **Startup**: no tracks are created. The center shows an empty state with 「曲を取り込んで始める」 (import a song, the
  learning flow) and 「自由に作る」 (one blank track for free use).
- **Progress bar** (under the header): ① 曲を取り込む ② カルテを見る ③ パートに分ける ④ 打ち込む ⑤ 差分で直す.
  Each step is done / current / not yet, derived from the actual state (a 原曲 track or imported file, a chart, part
  tracks, notes on a practice track, a diff against a non-empty attempt). Clicking a step opens the place where that
  step is done. Collapsible; the collapsed state is remembered per viewer (localStorage).
- **Left panel tabs**: 学ぶ (sub-tabs 曲とパート / カルテ / ガイド / 差分) / 音作り (シンセ / ドラム / FX) /
  ファイル (audio file loading, monophonic analysis, recording). 学ぶ is the default.

| Feature | Detail |
|---|---|
| Song import (取り込む) | One file picker (mp3 / wav / flac / ogg / m4a / aac / aiff). The audio is decoded in the browser and placed on a track named 原曲; if the WebView cannot decode it, `/api/convert/wav` (ffmpeg) is tried, otherwise the status bar says so. The chart is built at the same time, and its tempo, meter and downbeat become the project grid (see "Bar numbering" below) |
| Part separation | `/api/decompose` with the project grid. One track per part holding the part's audio and its お手本 (`referenceNotes`); the editable notes stay **empty**. Part tracks start muted (the 原曲 already plays everything). Drums keep the transcribed rhythm as notes and are excluded from the diff coach |
| Practice a part (このパートを練習する) | From the part list or the part's track header: creates/selects the practice track (「ベースの練習」) next to the part, opens it in the piano roll with the part's お手本 as the ghost overlay, scrolls to the お手本's pitch and first bar, sets the diff pair (reference = part, attempt = practice track) and unmutes the part's audio, then opens the practice view (below). 「お手本をノートとして取り込む」 (after an inline confirmation) copies the お手本 into the part's own notes |
| Playhead | A line in the timeline and the piano roll, moved with requestAnimationFrame while playing (idle: checked every 200 ms). Auto-scrolls to keep it visible; 「再生位置を追う」 next to the seek bar turns that off (remembered per viewer) |
| Chart / guide / diff links | Clicking a chord cell or a section row in the chart, a bar chip in the guide, or an issue in the diff list seeks playback there and scrolls the timeline and piano roll (the diff also scrolls vertically to the pitch) |
| Bar numbering | Piano roll, timeline ruler, playback, metronome and the diff coach count bars from the project grid: tempo (decimals allowed) and the offset of bar 1 (`gridOffset`, seconds). After importing a song this is the chart's grid, so chart bar N and piano-roll bar N are the same moment. Free use: offset 0 |
| Timeline | Place clips on tracks. Drag to move, beat-snapping, drag-and-drop audio files (anything the WebView can decode). Right-click a clip (or Shift+F10 / the menu key on a focused clip) for a small menu: 複製 (duplicate right after it, same audio buffer) / 削除. A focused clip is deleted with Delete |
| Track header | Name (+ note count), 練習する (part tracks), a "…" menu (名前を変更 / 上へ移動 / 下へ移動 / トラックを削除), ▶ M S, pan and volume sliders. Deleting is in the menu, not next to S |
| Track volume / pan | Volume −60…+6 dB (0.5 dB steps), pan left 100…right 100. Numeric readouts ("−6.0 dB", "左 30") that are also the sliders' `aria-valuetext`; keyboard accessible; double-click resets to 0 dB / centre. Applied live to the track's Web Audio nodes, used by playback and WAV export, saved in projects (`gain`, `pan`) |
| Piano roll | Per-track, independent. C0–B8 range. Double-click to add a note, drag to move (horizontal = position, vertical = pitch), drag the right edge to resize, Delete / Backspace to remove. Placing a note, changing its pitch, or pressing a key on the keyboard column plays that pitch |
| Piano roll selection | Rubber-band (drag from an empty spot), Shift+click to add/remove, Cmd/Ctrl+A (only while the piano roll has focus). Selected notes move/resize together. Arrow keys: ←→ by the grid step (1 beat), ↑↓ by a semitone, Shift+↑↓ by an octave. Esc clears. お手本 (ghost) notes are never selectable |
| Piano roll clipboard | Cmd/Ctrl+C / X / V / D. Paste goes to the playhead (rounded down to the grid; bar 1 if before it), duplicate goes right after the selection. The clipboard is in-app and works across tracks |
| Piano roll zoom | Horizontal 5–60 px per step (default 20) via the 横 −/＋ buttons or Cmd/Ctrl+wheel / trackpad pinch (anchored at the pointer); vertical 10–24 px per row via 縦 −/＋. Notes, ghost notes, grid and playhead all derive from the same step width, so bar alignment with the timeline (`lib/grid.ts`) is unchanged |
| Undo / redo | One project-wide history (see "Undo history" below). Header buttons ↶ / ↷ (title says what will be undone), Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y. Inside text fields the shortcuts are left to the field (native text undo; in the desktop app the default macOS Edit menu provides it). Deleting a track or clip shows a toast 「〜を削除しました — 元に戻す」 (`role="status"`, 10 s) instead of a confirmation |
| Synthesizer | 4 basic waveforms (sine / square / sawtooth / triangle), 6 instrument presets (guitar / violin / chorus / flute / bass / organ), 84 GM voices via FluidSynth (MuseScore_General.sf3) |
| Drum machine | 4 patterns (8-beat / 4-on-the-floor / bossa nova / reggae), configurable bars and volume |
| Effects | 3-band EQ / compressor / reverb / delay / normalize / pitch shift / time stretch |
| Monophonic analysis | pyin pitch detection converts a single-voice WAV to piano roll notes |
| Transport | BPM (20–300), time signature (4/4, 3/4, 6/8), play / stop / record, metronome, seekbar. Space toggles play / pause |
| Recording | Microphone input recorded to a track |
| Project file (保存 / 別名で保存 / 開く) | One `.bunri` file per song (SQLite, format 2.0; see song-chart-design.md "プロジェクトの保存"): tracks (role, part, practice partner, name, mute/solo/volume/pan), notes and お手本, clips **with audio** (integer-PCM WAV stored as FLAC, others as-is; deduplicated by SHA-256), grid (tempo, meter, `gridOffset`), the chart, the learn state (ghost choice, diff pair, last diff result), the practice-view settings (loop, speed, listen, お手本, input), the learning history, and copies of the cached guide / coach explanations. ⌘S saves (first time: native save dialog, default `~/Documents/bunri/<曲名>.bunri`), ⇧⌘S saves as, ⌘O opens (list of recent projects + 「ほかのファイルを選ぶ…」). Reopening restores the learning session without re-analysis or Claude calls. Opening clears the undo history. Dev browser path: asks for a name and stores in the data dir's `projects/` |
| Recent projects (最近使ったプロジェクト) | In the empty state and the header ▾ menu. Kept by the desktop shell in the data dir (`recent-projects.json`, 12 entries). Entries can be removed (the file is not deleted); missing files are shown as 「見つかりません」 |
| Unsaved changes | The window title and the header show the project name and 「●」 while there are unsaved changes (compared against the snapshot taken at save/open, so undoing back to the saved state clears it). Opening, 新しいプロジェクト and closing the window / ⌘Q ask 保存 / 保存しない / キャンセル |
| Legacy projects (以前の形式) | Old `projects/*.json` appear in the open list with a 「以前の形式」 badge. Clips have no audio: they are placeholders listed in a bar with 「音声を読み込み直す」. Saving converts to `.bunri`; the JSON file is kept |
| Learning history (学習の記録) | Every 「お手本と比べる」 records time, bar range, match rate (= the diff's `accuracy`), issue counts by kind and the explanation key. The 差分 tab shows 「一致 67% 前回より +34%」, a trend and the last 5 attempts. Saved in the project |
| データの整理 | In the ファイル tab: disk usage of the data dir by category and a cleanup of temporary files (uploads, generated audio, chart work files, project working copies older than 5 minutes; never the open project, cached guides/explanations, `projects/`, or files outside the data dir) |
| MIDI keyboard input | Play a connected keyboard into the piano roll: step input (advance one note at a time) or real-time recording while the transport runs (optional one-bar count-in; a latency offset moves played notes earlier, defaulting to the audio output latency). Note velocity is recorded. Web MIDI in Chrome / Edge; the desktop app receives MIDI natively |
| MIDI export | Piano-roll notes of every track as a standard MIDI file (format 1, one MIDI track per track). Notes carry their velocity (96 when a note has none) |
| MIDI import | Notes of a standard MIDI file (format 0 or 1) as new tracks, or as a reference to practise against. Positions and lengths are rounded to 16th notes; velocity is kept |
| WAV export | Offline mixdown to WAV. Follows mute and solo, the same as playback |

#### Undo history

- **What is recorded:** note add / delete / move / resize / pitch change / paste / duplicate / cut, bulk note replacement
  (お手本をノートとして取り込む, monophonic analysis, MIDI-input recording), track add / delete / rename / reorder /
  mute / solo / volume / pan, clip add / move / duplicate / delete / effect, song import, part separation, 練習する,
  project load.
- **Entry = two project snapshots** (`lib/project-snapshot.ts`): before and after the operation. Undo applies only the
  fields that differ between the two, so unrecorded changes (e.g. typing a new BPM) are not rolled back by an unrelated
  undo; tempo/meter/offset are restored only when that operation changed them. Snapshots reference audio buffers and
  the `Track` objects themselves (a deleted track comes back with the same id and audio nodes); note arrays are shared
  between consecutive snapshots when their content is unchanged.
- **Coalescing:** a drag (note or clip) is one entry from press to release; slider movements of the same track, repeated
  arrow-key nudges and MIDI real-time recording are merged while they continue (1–4 s window). Undo/redo stops merging.
- **Limits:** 100 entries and a budget of 200 000 unshared notes/clips across entries; the oldest are dropped first.
  A new operation clears the redo list.
- Code that changes the project wraps the change in the store's `record(label, fn)` / `recordAsync` / `beginEdit`
  (`lib/store.tsx`).

#### Practice view (練習画面)

Opened by 「このパートを練習する」, a practice track's 練習画面 button, or its menu (練習画面で開く); left with
「← アレンジに戻る」 or Esc. The timeline, left panel and progress bar are hidden with CSS (not unmounted, so the piano roll
and the audio engine keep their state); the piano roll fills the centre with the same `PianoRollEngine`. Leaving restores
the piano roll's open track, zoom and scroll, the timeline scroll, the お手本 overlay choice and the MIDI record mode.

| Part | Detail |
|---|---|
| Header | ← アレンジに戻る, 練習: part (song file), 一致 N% (from the last 比べる; greyed when stale) and 「▲前回より +8%」: the difference from the previous learning-history record for the same お手本, practice track and bar range (`useMatchSummary` + `deltaText`; a new range starts with 「はじめての記録」). Before comparing, the previous record's rate for the current range is shown as a hint |
| Bands | 構成 / コード / 小節, positioned from seconds via `lib/grid.ts` with the piano roll's step width and scroll (`PianoRollEngine.onView`). With the chart grid applied, chart bar N and piano-roll bar N coincide, so a chord cell's left edge is on the bar line. Dragging on 小節 sets the loop; clicking a section sets the loop to it |
| Loop (区間ループ) | Bars (inclusive), bar inputs, ‹ › (or `[` `]`), L toggles. The engine schedules one pass at a time at exact AudioContext times with 1.5 s lookahead (`lib/loop.ts` + `AudioEngine._playLoop`): clips are started with `start(when, offset, duration)` and 4 ms edge fades, notes and metronome clicks per pass, so passes join without gaps and the playhead (`getCurrentTime`) wraps. Shown dimmed outside the range in the piano roll and as a gold strip in the timeline ruler (also after leaving) |
| Speed (速度) | 50/60/75/90/100 %, pitch preserved. The part's audio for the loop region (plus 0.1 s margins) is time-stretched once per speed with WSOLA (`lib/stretch.ts`) in a Web Worker (`lib/stretch.worker.ts`, same-origin, no CSP change) and cached (last 3, `lib/practice-audio.ts`). Notes and metronome follow by tempo scaling. While preparing, playback stays at 100 % with a message; without a loop the speed does not apply (stretching a whole song would hold 2× its audio in memory at 50 %). Measured on the dev Mac (Node, stereo 44.1 kHz): 8 s region → 43 ms at 50 %, 16 s → 138 ms, 30 s → 175 ms. `playbackRate` is not used because it lowers the pitch |
| Listen (聴く) | パート / 自分 / 両方 via `AudioEngine.listenOverride` (playback only; track mute/solo, the project and the undo history are untouched; WAV export still follows mute/solo). お手本 見せる / 隠す switches the overlay |
| Input (入力) | マウス / MIDI ステップ / MIDI リアルタイム, driving the one `useMidiInput` instance the centre area owns (the normal piano-roll header uses the same). Step input starts at the loop start and stops at its end. Real-time recording in a loop **overdubs**: notes are added on every pass (an identical pitch at the same step is not added twice), each pass is its own undo entry, and a note held across the loop end is cut at the end. Overdub was chosen over replace so that a pass where you only listen, or play part of the phrase, does not erase earlier notes |
| Compare (比べる) | Diffs the notes starting inside the loop (or the whole track), records a learning-history attempt with the loop's bar range (match rate = matched お手本 notes in range ÷ お手本 notes in range = `summary.accuracy`), colours notes (see [coach-diff-design.md](coach-diff-design.md) 「練習画面」), lists 「この区間の指摘」 in time order; clicking an issue selects and flashes its notes and scrolls there, clicking a coloured note shows its issue. Editing notes or the loop clears the colours and shows 「もう一度比べてください」 |
| Keys | Space play/pause (header), L, `[` `]`, Esc (not while typing, a dialog or a menu is open, or the piano roll used Esc to clear a selection) |
| State | `practice` in the store (`PracticeState`: partId, trackId, loop {startBar, endBar, enabled}, speed, listen, showGhost, input) — small and JSON-serialisable; kept after leaving so re-entering resumes. Saved in the project as the `practice` state section (tracks by index; `lib/practice-project.ts`). Opening a project restores the settings but does not reopen the practice view (it opens in the arrangement; no MIDI connection or time-stretching starts on its own). Changing a setting marks the project unsaved; entering/leaving does not. Diff results are not kept (the attempts are in the learning history) |

#### Not implemented

- **Automation** (parameter curves over time). An automation lane used to be shown under the piano roll, but it was
  never connected to the playback engine: points could be drawn and saved, and had no effect on the sound. The lane
  was removed from the screen. Projects saved by older versions may contain an `automation` field; it is ignored on
  load and dropped on the next save.
- **AI note generation.** The former "AI" tab (natural-language prompt → generated notes, via Ollama or Claude) was
  removed, together with `/api/assistant/*` and `music_assistant.py`. It contradicted the product principle that the
  LLM only explains and never outputs a note (see [reproduction-guide-design.md](reproduction-guide-design.md)).

### Tools Screen (`/tools`)

| Tab | Detail |
|---|---|
| Part separation and transcription (パート分離と採譜) | Demucs 6-stem separation → per-stem polyphonic pitch detection → instrument estimation → JSON output |
| Part separation (パート分離) | Demucs 2 / 4 / 6 stems (htdemucs / htdemucs_ft / htdemucs_6s). The 6-part mode can also split drums into kick / snare / toms / cymbals |
| Analysis | Frequency band distribution, estimated instrument composition, tempo estimation |
| Edit | Trim / cut / range copy / silence insert / loop |
| Effects | EQ / compressor / reverb / delay / volume / fade in-out / pan / reverse / pitch shift / time stretch / speed change |
| Batch edit | Apply the same operation to multiple files at once |
| Audio merge | Overlay-mix two WAV files |
| Convert | MP4/AVI/MKV to WAV or MP3 (via ffmpeg) |
| WAV optimizer | Polyphase resample + TPDF dither to reduce file size |

### Help Screen (`/help`)

Operation guide, screen layout explanation, and keyboard shortcut reference.

---

## API Endpoints

All endpoints are served by FastAPI (`backend/web/api.py`).

The backend serves the API only. The screens (`/` DAW, `/tools`, `/help`) are routes of the React app, which the desktop app displays.

### Synth / Sequencer

| Method | Path | Form fields | Description |
|---|---|---|---|
| POST | `/api/synth/note` | `note`, `octave`, `duration`, `waveform`, `volume`, `attack`, `decay`, `sustain`, `release` | Generate a single note as WAV |
| POST | `/api/synth/sequence` | `notes_json`, `bpm`, `waveform`, `volume`, `attack`, `decay`, `sustain`, `release`, `instrument`, `gm_program` | Render a step sequence as WAV |
| POST | `/api/synth/drum` | `pattern`, `bpm`, `bars`, `volume` | Render a drum pattern as WAV |
| GET | `/api/gm-instruments` | — | Returns list of available GM instruments |
| POST | `/api/metronome` | `bpm`, `beats_per_bar`, `bars`, `volume` | Generate a metronome click track |

### Effects

| Method | Path | Form fields | Description |
|---|---|---|---|
| POST | `/api/effects/{effect_name}` | `file`, `params` (JSON) | Apply a named effect to the uploaded file |

Supported `effect_name` values and their `params` keys:

| Name | Params |
|---|---|
| `eq` | `low`, `mid`, `high` (dB) |
| `compressor` | `threshold`, `ratio`, `attack`, `release` |
| `reverb` | `room_size`, `wet` |
| `delay` | `delay_ms`, `feedback`, `wet` |
| `volume` | `db` |
| `normalize` | *(none)* |
| `fade_in` | `duration` |
| `fade_out` | `duration` |
| `pan` | `pan` (-1.0 to 1.0) |
| `reverse` | *(none)* |
| `pitch_shift` | `semitones` |
| `time_stretch` | `rate` |
| `speed` | `speed` |

### Edit

| Method | Path | Form fields | Description |
|---|---|---|---|
| POST | `/api/edit/{action}` | `file`, `params` (JSON) | Apply a named edit operation |

Supported `action` values and their `params` keys:

| Action | Params |
|---|---|
| `trim` | `start`, `end` |
| `cut` | `start`, `end` |
| `copy_range` | `start`, `end`, `insert_at` |
| `silence` | `position`, `length` |
| `loop` | `start`, `end`, `count` |

### Batch Operations

| Method | Path | Form fields | Description |
|---|---|---|---|
| POST | `/api/batch/edit` | `files[]`, `action`, `params` | Apply one edit action to multiple files |
| POST | `/api/batch/effects` | `files[]`, `effect_name`, `params` | Apply one effect to multiple files |

Returns a JSON array: `[{filename, url, status}, ...]`

### Mixer

| Method | Path | Form fields | Description |
|---|---|---|---|
| POST | `/api/mixer` | `files[]`, `config` (JSON) | Mix up to 4 tracks with per-track vol/pan/mute and master volume |

`config` schema:
```json
{
  "tracks": [{"vol": 0, "pan": 0, "mute": false}],
  "master_vol": 0
}
```

### Analysis & Separation

| Method | Path | Form fields | Description |
|---|---|---|---|
| POST | `/api/analyze` | `file`, `bpm`, `sensitivity` | pyin pitch detection → piano roll note data |
| POST | `/api/deep-analyze` | `file` | Frequency band, instrument composition, tempo estimation |
| POST | `/api/separate` | `file`, `model`, `two_stems` | Demucs stem separation |
| POST | `/api/deep-separate` | `file`, `depth`, `split_drums` | htdemucs_6s + recursive "other" re-separation. `split_drums=true` also splits the drum stem into kick / snare / toms / cymbals (add-on model `drumsep`, downloaded on first use, ~160 MB; 503 if it cannot be fetched) |
| POST | `/api/decompose` | `file`, `bpm` (float, 0 = detect), `grid_offset` (seconds of step 0), `sensitivity` | Full pipeline: separate → pitch detect → instrument estimate. Notes are counted from `grid_offset`; notes before it (pickup) are dropped |

Demucs `model` values: `htdemucs` (default, recommended), `htdemucs_ft` (slow, higher quality), `htdemucs_6s` (6-stem).

### WAV & Conversion

| Method | Path | Form fields | Description |
|---|---|---|---|
| POST | `/api/wav/info` | `file` | Returns sample rate, channels, bit depth, duration, file size |
| POST | `/api/wav/optimize` | `file`, `target_sr`, `target_bit_depth` | Polyphase resample + TPDF dither |
| POST | `/api/convert/{target}` | `file`, `bitrate` | Convert to `wav` or `mp3` via ffmpeg |

### Project & Download

| Method | Path | Form / Path | Description |
|---|---|---|---|
| POST | `/api/project/audio/missing` | JSON `{base, hashes}` | Which audio hashes still need uploading for a save (`{missing}`) |
| PUT | `/api/project/audio/{hash}` | raw body, `?name=` | Stage one audio file (SHA-256 must match) |
| POST | `/api/project/document` | JSON `{base, document}` | Write the project document to a working copy `work/<token>.bunri`; returns `{token, size_bytes, audio_count, duration_sec}` |
| POST | `/api/project/open/{token}` | path param | Open a working copy (migrates v1, restores the chart file and cached guide/coach copies); returns the document |
| GET | `/api/project/{token}/audio/{hash}` | path params | One audio file of an opened project (FLAC returned as WAV) |
| GET | `/api/project/library` | — | `.bunri` and legacy JSON in the data dir's `projects/` |
| POST | `/api/project/library/save` | JSON `{token, name}` or `{token, file}` | Dev browser path: place a working copy in `projects/` |
| POST | `/api/project/library/open` | JSON `{file}` | `.bunri` → `{token}`; legacy JSON → `{document}` |
| GET | `/api/storage` | — | Data dir usage by category |
| POST | `/api/storage/cleanup` | JSON `{keep_tokens, keep_charts}` | Delete temporary files (409 while a job runs) |
| POST | `/api/project/save` | `data` (JSON string) | Legacy: write an old-format JSON project (kept for opening old files and for tests) |
| GET | `/api/project/list` / `/api/project/load/{name}` | — | Legacy JSON list / read |
| GET | `/api/download/{filename}` | path param | Download a file from `results/` |

---

## Development Commands

```bash
make install           # Install backend Python dependencies
make install-frontend  # Install frontend npm dependencies (web-ui/)
make install-desktop   # Install the Tauri CLI
make desktop           # Run the desktop app in development mode (npm run tauri dev)
make desktop-build     # Build the .app / .dmg
make test              # Run all tests (frontend + backend)
make lint              # Run ESLint + ruff
make clean             # Delete results/, uploads/, projects/, dist/, node_modules/, caches
```

### Running tests individually

```bash
# Frontend (Vitest, ~36 tests)
cd web-ui && npm test

# Backend (pytest, ~113 tests)
python -m pytest test/back/ -v

# Type check only
cd web-ui && npx tsc --noEmit
```

---

## Architecture

### Directory structure

```
bunri/
├── .github/workflows/ci.yml     CI (lint → type-check → test → build)
├── web-ui/                      React 19 + TypeScript + Vite 8 frontend
│   └── src/
│       ├── pages/               DawPage / ToolsPage / HelpPage
│       ├── components/          HeaderBar / LeftPanel / CenterArea / StatusBar /
│       │                        WelcomeGuide / ChartPanel / GuidePanel / CoachPanel / GridEditor
│       ├── lib/                 engine.ts (AudioEngine) / store.tsx (Context)
│       ├── styles/              global.css
│       └── __tests__/           Vitest tests
├── test/back/                   pytest tests (12 files)
│
├── backend/                     All Python code (flat modules; bundled as one directory)
│   ├── web/api.py           FastAPI backend (30+ endpoints)
│   ├── separate.py              Demucs source separation (htdemucs standard)
│   ├── deep_separate.py         6-stem detailed separation (htdemucs_6s)
│   ├── decompose.py             Separation → pitch detect → instrument estimate pipeline
│   ├── analyze.py               pyin pitch detection → note data conversion
│   ├── synth.py                 Synth / drum machine / step sequencer / GM voices
│   ├── edit.py                  15 audio edit operations
│   ├── effects.py               EQ / compressor / reverb / delay
│   ├── pitch_time.py            Phase vocoder pitch shift / time stretch
│   ├── wav_optimize.py          Polyphase resample + TPDF dither
│   ├── mixer.py                 Up to 4-track mixer
│   ├── metronome.py             Metronome generation / BPM utilities
│   ├── overlay.py               Audio merge (overlay)
│   ├── convert.py               Format conversion via ffmpeg
│   ├── recorder.py              Microphone recording
│   ├── audio_utils.py           load_audio / save_tmp / to_stereo utilities
│   ├── _demucs_runner.py        torchaudio save patch
│   └── run_web.py               API server entry point (started by the desktop app as a sidecar)
├── src-tauri/                   Desktop app shell (Tauri v2 / Rust): window, first-run setup, sidecar lifecycle
├── scripts/prepare-desktop.mjs  Fetches the bundled uv binary and stages backend/ for the desktop build
├── package.json                 Entry point for `npm run tauri dev` / `npm run tauri build`
├── pyproject.toml               Python dependencies / ruff configuration
├── uv.lock                      Locked dependency versions
└── Makefile                     Development commands
```

### Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11 / FastAPI / uvicorn |
| Desktop shell | Tauri v2 (Rust) + Python sidecar — see [desktop-architecture.md](desktop-architecture.md) |
| Audio processing | Demucs / librosa / NumPy / SciPy / soundfile / PyFluidSynth |
| Frontend | React 19 / TypeScript / Vite 8 / React Router 7 |
| Testing | Vitest + Testing Library (frontend) / pytest (backend) |
| Linting | ESLint + typescript-eslint (frontend) / ruff (backend) |
| CI | GitHub Actions |
| Reproduction guide (LLM) | Anthropic Claude API via the official `anthropic` SDK (optional; explains the song chart, never generates notes) |

### Demucs models

| Model | Stems | Notes |
|---|---|---|
| `htdemucs` | vocals, drums, bass, other | Recommended; CPU-friendly |
| `htdemucs_ft` | vocals, drums, bass, other | Higher quality; very slow on CPU |
| `htdemucs_6s` | vocals, drums, bass, guitar, piano, other | 6-stem; used by full decompose |
| `drumsep` (add-on) | kick, snare, toms, cymbals | Splits a drum stem. [inagoy/drumsep](https://github.com/inagoy/drumsep), MIT. Not fetched by Demucs; see `backend/stem_models.py` |

---

## Design Principles

**CPU-first.** No GPU required. Designed to run on low-spec machines. Demucs is called with `segment=7` (short processing segments to reduce peak memory) and `jobs=1` (single CPU job to minimise load).

**WAV as default I/O.** Avoids the encode/decode overhead of lossy formats during internal processing. Only convert to MP3 when the user explicitly requests it.

**Lazy imports.** Heavy modules (numpy, librosa, torch, etc.) are imported inside function bodies, not at module top-level. This keeps server startup fast and avoids loading unused dependencies.

**Shared utilities.** All modules use `audio_utils.load_audio` and `audio_utils.save_tmp` for consistent loading and temporary file handling. New modules should do the same.

**Temporary files.** Intermediate results use Python's `tempfile` module. Final outputs are written to `results/`. Uploads land in `uploads/`.

**No global state in Python modules.** Each API call is stateless. Projects are persisted as JSON files in `projects/`.
