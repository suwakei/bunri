# Awesome-List PR Submissions

For each list: the exact file to edit, where to insert the entry, suggested PR title, and the one-line description to use.

---

## 1. awesome-python

**Repo:** https://github.com/vinta/awesome-python
**File to edit:** `README.md`
**Section:** Find `## Audio` (search exactly for that heading). Entries within the section are alphabetical. `bunri` goes between whatever falls alphabetically before/after it.

**Entry to insert:**
```markdown
* [bunri](https://github.com/[YOUR_USERNAME]/bunri) - Local DAW that separates any audio into stems via Demucs and transcribes each stem into an editable piano roll, backed by FastAPI and a React 19 frontend.
```

**PR Title:**
> Add bunri to Audio section

**PR Body:**
```
bunri is an open-source, offline-first DAW that combines Demucs (Meta AI) stem
separation with polyphonic pitch detection (librosa pyin + STFT harmonic analysis)
to generate editable piano rolls from any audio file.

Stack: Python / FastAPI / librosa / PyFluidSynth / React 19 / TypeScript
License: Apache-2.0
No GPU required.

Repo: https://github.com/[YOUR_USERNAME]/bunri
```

**Notes:** vinta/awesome-python has relatively high submission volume. Keep the description under 200 chars and focus on the Python angle (FastAPI, librosa, PyFluidSynth). They sometimes ask for a PyPI package — bunri doesn't have one, but it's a full application not a library, which is acceptable in the Audio section.

---

## 2. awesome-selfhosted

**Repo:** https://github.com/awesome-selfhosted/awesome-selfhosted
**File to edit:** `README.md`
**Section:** Look for `## Audio Recording` or the general `## Media Streaming` area. If there is an `## Audio` section, use that.

The format is a strict markdown list. Check the current format around the insertion point — it uses:
```
- [Name](url) - Description. `License` `Language`
```

**Entry to insert:**
```markdown
- [bunri](https://github.com/[YOUR_USERNAME]/bunri) - Browser-based DAW that separates audio into stems with Demucs and generates editable piano rolls via polyphonic pitch detection. Includes Ollama-powered AI composition assistant. `Apache-2.0` `Python`
```

**PR Title:**
> Add bunri (local offline DAW with stem separation and piano roll)

**PR Body:**
```
bunri is a self-hosted, offline-first digital audio workstation.

Relevance to awesome-selfhosted:
- 100% local: no telemetry, no required accounts or API keys
- Ollama integration for local AI composition assistant (Gemma 3 4B/12B)
- FastAPI backend + React SPA, reverse-proxy friendly
- Projects stored as local JSON in a configurable directory
- CPU only — runs on modest hardware (tested on 8GB RAM laptop)

Setup: pip install + npm build + python run_web.py
License: Apache-2.0
Repo: https://github.com/[YOUR_USERNAME]/bunri
```

**Notes:** awesome-selfhosted requires projects to be self-hostable without mandatory cloud dependency. bunri qualifies — the Anthropic API key is explicitly optional. Their CONTRIBUTING.md currently requires: working demo/screenshots, clear license, and the project must be maintained. Check CONTRIBUTING.md for current star requirements before submitting.

---

## 3. awesome-music

**Repo:** https://github.com/ciconia/awesome-music
**File to edit:** `README.md`
**Section:** `## Audio Tools` or `## Music Analysis` — check the current section headings, they shift between versions. If there is an `## Audio Analysis` section, that's the best fit.

Entries are alphabetical within section.

**Entry to insert:**
```markdown
* [bunri](https://github.com/[YOUR_USERNAME]/bunri) - Open-source DAW combining Demucs stem separation with polyphonic pitch detection (STFT harmonic analysis + pyin); automatically generates editable piano rolls from audio files.
```

**PR Title:**
> Add bunri to Audio Tools / Music Analysis

**PR Body:**
```
bunri provides a complete pipeline from audio to symbolic representation:
1. Demucs (htdemucs_6s) — 6-stem separation (vocals/drums/bass/guitar/piano/other)
2. librosa pyin — monophonic pitch tracking for vocals and bass
3. STFT harmonic analysis — polyphonic pitch detection for guitar/piano (up to 4 notes)
4. Spectral centroid classification — kick/snare/hihat from drum stems

Output is a piano roll with editable notes, GM instrument playback (84 voices via
FluidSynth), effects chain, and WAV export.

License: Apache-2.0
Repo: https://github.com/[YOUR_USERNAME]/bunri
```

---

## 4. awesome-python-scientific-audio

**Repo:** https://github.com/faroit/awesome-python-scientific-audio
**File to edit:** `README.md`
**Section:** `## Feature Extraction and Transformation` or `## Symbolic Music / MIDI`

If there is no Symbolic/MIDI section, `## Feature Extraction` is the closest fit for the pitch detection pipeline.

**Entry to insert:**
```markdown
* [bunri](https://github.com/[YOUR_USERNAME]/bunri) - Full-stack pipeline: Demucs stem separation → STFT polyphonic pitch detection → piano roll. FastAPI + React. CPU-only, offline. Apache-2.0.
```

**PR Title:**
> Add bunri to Symbolic Music / Feature Extraction

**PR Body:**
```
bunri's audio analysis pipeline is relevant to scientific audio computing:

Pitch detection (decompose.py):
- STFT with n_fft=4096 for high frequency resolution
- Harmonic weighting: energy = sum(amplitude[h*f0] / h) for h=1..4
- Voiced/unvoiced frame tracking with configurable sensitivity threshold

Drum classification (decompose.py):
- librosa onset detection with configurable delta
- Spectral centroid thresholds for kick/snare/hihat classification

Output: JSON note representation {note, octave, step, length, velocity}

License: Apache-2.0
Repo: https://github.com/[YOUR_USERNAME]/bunri
```

---

## 5. awesome-react

**Repo:** https://github.com/enaqx/awesome-react
**File to edit:** `README.md`
**Section:** Look for `## React Tools and Components` or `## Apps and Frameworks`. If there is a subsection for audio/media apps, use that; otherwise use a general "Apps" category.

**Entry to insert:**
```markdown
- [bunri](https://github.com/[YOUR_USERNAME]/bunri) - Browser DAW built with React 19 + TypeScript + Vite 8; features a canvas-based piano roll, timeline, automation curves, and an Ollama-powered AI composition assistant.
```

**PR Title:**
> Add bunri (React 19 DAW with piano roll, timeline, Ollama AI)

**PR Body:**
```
bunri is a full digital audio workstation built in React 19 + TypeScript + Vite 8.

React-specific implementation highlights:
- DawProvider (Context API) manages global state: BPM, playback, track version
- useRef for AudioEngine and canvas-based components (piano roll, timeline,
  automation) that live outside React's render cycle to avoid re-render overhead
- React Router 7 for SPA routing: / (DAW) | /tools | /help
- Vitest + @testing-library/react test suite (36 tests across 3 files)
- AssistantPanel: controlled chat component backed by Ollama/Claude API

Backend: Python / FastAPI (separate process, proxied in dev via Vite)

License: Apache-2.0
Repo: https://github.com/[YOUR_USERNAME]/bunri
```

**Notes:** awesome-react is high-volume and sometimes slow to merge non-library submissions. The React 19 + Vite 8 angle is current enough to be interesting. If there's no suitable "apps" section, skip this one and prioritize the others.

---

## Submission Process & Timing

### Before submitting any PR

1. Verify the repo has at least 30-50 stars (most lists have informal minimums).
2. Make sure the project README has:
   - A screenshot or GIF of the UI
   - Clear install instructions
   - License badge
   - A brief description that matches the PR entry
3. Read the target repo's `CONTRIBUTING.md` — requirements change frequently.

### Order and timing

Submit in this order on launch day, spaced at least 30 minutes apart:

1. `awesome-python` (highest traffic, most credibility)
2. `awesome-selfhosted` (most targeted audience)
3. `awesome-music` (niche but highly relevant)
4. `awesome-python-scientific-audio` (technical audience)
5. `awesome-react` (optional, lower priority)

Do not submit all at once — it reads as spam and some maintainers cross-check GitHub activity.

### Branch naming convention

Use `add/bunri` or `add-bunri` consistently across all PRs.

### After submitting

- If a maintainer requests changes (description length, section placement), respond and update within 24 hours.
- Don't close and re-open PRs. Edit in place.
- If a PR sits without response for 2 weeks, leave a polite comment asking for a review.
