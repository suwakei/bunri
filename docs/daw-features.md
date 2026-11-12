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

| Feature | Detail |
|---|---|
| Timeline | Place clips on tracks. Drag to move, beat-snapping, drag-and-drop WAV files |
| Piano roll | Per-track, independent. C0–B8 range. Double-click to add a note, drag to move (horizontal = position, vertical = pitch), drag the right edge to resize, Delete / Backspace to remove. Placing a note, changing its pitch, or pressing a key on the keyboard column plays that pitch |
| Synthesizer | 4 basic waveforms (sine / square / sawtooth / triangle), 6 instrument presets (guitar / violin / chorus / flute / bass / organ), 84 GM voices via FluidSynth (MuseScore_General.sf3) |
| Drum machine | 4 patterns (8-beat / 4-on-the-floor / bossa nova / reggae), configurable bars and volume |
| Effects | 3-band EQ / compressor / reverb / delay / normalize / pitch shift / time stretch |
| Full song analysis | One click: Demucs separation → polyphonic pitch detection → track auto-generation → piano roll population |
| Monophonic analysis | pyin pitch detection converts a single-voice WAV to piano roll notes |
| Transport | BPM (20–300), time signature (4/4, 3/4, 6/8), play / stop / record, metronome, seekbar. Space toggles play / pause |
| Recording | Microphone input recorded to a track |
| Project save/load | JSON format |
| MIDI keyboard input | Play a connected keyboard into the piano roll: step input (advance one note at a time) or real-time recording while the transport runs. Web MIDI in Chrome / Edge; the desktop app receives MIDI natively |
| MIDI export | Piano-roll notes of every track as a standard MIDI file (format 1, one MIDI track per track) |
| WAV export | Offline mixdown to WAV. Follows mute and solo, the same as playback |

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
| Part separation (パート分離) | Demucs 2 / 4 / 6 stems (htdemucs / htdemucs_ft / htdemucs_6s) |
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
| POST | `/api/deep-separate` | `file`, `depth` | htdemucs_6s + recursive "other" re-separation |
| POST | `/api/decompose` | `file`, `bpm`, `sensitivity` | Full pipeline: separate → pitch detect → instrument estimate |

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
| POST | `/api/project/save` | `data` (JSON string) | Save project; returns `{filename}` |
| GET | `/api/project/list` | — | Returns array of saved project filenames |
| GET | `/api/project/load/{name}` | path param | Returns project JSON |
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

---

## Design Principles

**CPU-first.** No GPU required. Designed to run on low-spec machines. Demucs is called with `segment=7` (short processing segments to reduce peak memory) and `jobs=1` (single CPU job to minimise load).

**WAV as default I/O.** Avoids the encode/decode overhead of lossy formats during internal processing. Only convert to MP3 when the user explicitly requests it.

**Lazy imports.** Heavy modules (numpy, librosa, torch, etc.) are imported inside function bodies, not at module top-level. This keeps server startup fast and avoids loading unused dependencies.

**Shared utilities.** All modules use `audio_utils.load_audio` and `audio_utils.save_tmp` for consistent loading and temporary file handling. New modules should do the same.

**Temporary files.** Intermediate results use Python's `tempfile` module. Final outputs are written to `results/`. Uploads land in `uploads/`.

**No global state in Python modules.** Each API call is stateless. Projects are persisted as JSON files in `projects/`.
