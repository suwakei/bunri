# Reddit Posts — 4 Subreddits

---

## 1. r/WeAreTheMusicMakers

**Title:**
> I built an open-source tool that turns any song into an editable piano roll — stems, notes, and a full DAW, running locally

**Body:**

Been lurking here for years and this community inspired a lot of this project.

I always wanted to do what music teachers do — take a real song, pull out each instrument part, and see the actual notes. Not just slow it down; literally see and edit the notes. Tools like Moises do the stems part, but you're still stuck transcribing by ear or paying for RipX.

So I built Bunri. Here's what it does:

1. Drop in any WAV/MP3/FLAC
2. It runs Demucs (Meta AI) and splits the track into stems — vocals, drums, bass, guitar, piano, other
3. Each stem gets polyphonic pitch detection run on it, and the notes appear in a piano roll
4. You can play them back with GM instruments (84 voices via FluidSynth), edit the notes, add effects, and export

The piano roll is fully editable. You can fix wrong notes, change the instrument, add reverb or EQ, adjust the BPM. There's also an AI assistant — type "4-bar sad progression in A minor" and it generates the notes. That part works with local Ollama (free/offline) or optionally the Anthropic Claude API.

**Limitations I want to be upfront about:** Dense chords in busy mixes don't transcribe perfectly — the pitch detection is best on clean stems with clear pitches (bass and single-instrument lines come out very well). And Demucs separation on CPU takes a few minutes.

Runs 100% offline. No account, no subscription, no data leaves your machine.

- Repo: https://github.com/[YOUR_USERNAME]/bunri
- Stack: Python/FastAPI backend + React 19/TypeScript frontend
- Tested on macOS and Linux, Windows should work but untested

Happy to answer questions about the pitch detection approach or anything else. Genuinely interested in feedback from people who actually use stems in their workflow.

---

## 2. r/edmproduction

**Title:**
> Open-source tool for stem separation + note extraction — remix prep workflow for producers

**Body:**

I know a lot of producers here use stems for remixes and analysis. I built a tool that goes one step further than just separation.

**Bunri** does:
- Demucs separation (6 stems: vocals, drums, bass, guitar, piano, other + optional deep re-separation of the "other" bus)
- Automatic note extraction from each stem → piano roll
- Drum classification: kick / snare / hihat from onset detection + spectral centroid
- Bass line extraction: monophonic transcription, outputs clean MIDI-style note data
- GM playback with 84 instrument voices (you can swap the synth patch after transcription)
- Full DAW: timeline, piano roll, automation curves, effects (EQ, comp, reverb, delay, pitch shift, time stretch)

The deep separation mode is interesting for EDM — it re-runs Demucs on the "other" stem to pull out synth pads, string arrangements, and anything that didn't fit the main 4 categories. You end up with 8-10 separate audio layers.

The pitch detection uses STFT with harmonic weighting (fundamental + 3 harmonics), so it handles basic polyphony. Chords with up to 4 simultaneous notes work reasonably well on clean stems. It's not as accurate as dedicated piano transcription models, but it's good enough to get the rough harmonic structure of a bass line or lead synth.

**For remix work:** you get the stems as WAV files (from Demucs) plus a JSON of the notes, which you can use however you want.

Everything runs offline, no subscription. CPU only.

Repo: https://github.com/[YOUR_USERNAME]/bunri

---

## 3. r/selfhosted

**Title:**
> Bunri — local, offline DAW with AI-assisted composition (Ollama/Gemma 3), no cloud required

**Body:**

Built this for people who want the kind of features Moises or Soundful offer but with zero data leaving their machine.

**What it is:** A full browser DAW backed by a Python/FastAPI server you run locally. The audio never leaves your machine.

**Features relevant to selfhosters:**

- **100% offline by design** — no telemetry, no accounts, no API keys required for core features
- **Ollama integration** — the AI composition assistant uses Ollama + Gemma 3 (4B or 12B) for local LLM inference. It takes prompts like "4-bar minor chord progression" and generates piano roll notes. No internet connection needed.
- **Runs on modest hardware** — CPU only, no GPU. Tested on a laptop (8GB RAM). Memory-efficient: Demucs processes in 7-second segments (configurable).
- **Local project storage** — projects save as JSON to a local `projects/` directory
- **Clean API** — FastAPI backend with ~30 endpoints. The frontend is React 19 + TypeScript, served from the same process. Easy to reverse-proxy with nginx or Caddy.

**Setup:**

```bash
git clone https://github.com/[YOUR_USERNAME]/bunri
cd bunri
pip install -r requirements.txt
cd web-ui && npm ci && npm run build && cd ..
python run_web.py
# opens http://127.0.0.1:8000
```

Or with make:
```bash
make install && make install-frontend && make web
```

**Docker:** Not yet shipped, but straightforward to containerize (Python + Node build stage). Happy to merge a PR for this — the Dockerfile would essentially be `pip install requirements.txt` + `npm ci && npm run build`.

The Anthropic Claude API integration is strictly optional. If you set `ANTHROPIC_API_KEY` it adds a cloud fallback for the AI assistant. If you don't set it, everything stays local.

Repo: https://github.com/[YOUR_USERNAME]/bunri

---

## 4. r/LocalLLaMA

**Title:**
> I built an Ollama-powered AI composition assistant into a DAW — Gemma 3 generates piano roll notes from natural language

**Body:**

Sharing a project that uses Ollama as its primary inference backend for a music composition assistant.

**The use case:** You're building a song in a DAW. You want a chord progression or melody but don't want to write it from scratch. You type "4-bar sad chord progression in A minor" and the AI places the notes directly into the piano roll.

**How it works:**

The system prompt constrains the LLM to output strict JSON:

```json
{
  "notes": [
    {"note": "A", "octave": 3, "step": 0, "length": 16},
    {"note": "C", "octave": 4, "step": 0, "length": 16},
    {"note": "E", "octave": 4, "step": 0, "length": 16}
  ],
  "explanation": "Am chord on beat 1..."
}
```

Where `step` is position in 16th notes and `length` is duration in 16th notes. The LLM needs to understand music theory (scales, voice leading, chord inversions) and output valid JSON simultaneously.

**Model selection:**

- Default local: `gemma3:4b` (fast, good for simple patterns)
- Better local: `gemma3:12b` (handles complex requests like "bebop melody with chromatic passing tones" much better)
- Cloud fallback: Anthropic Claude API (optional, disabled by default)

The backend auto-selects: if Ollama is running and has a model, it uses local. If not and an API key is set, it uses cloud. You can also pin either mode.

**Config:**

```bash
OLLAMA_URL=http://localhost:11434   # default
OLLAMA_MODEL=gemma3:4b              # default
ANTHROPIC_API_KEY=sk-...            # optional cloud fallback
```

**What works well locally:** Standard patterns (I-IV-V-I, pentatonic melodies, 8-bar blues), simple arpeggio patterns, bass lines. Gemma 3 4B handles these reliably with the right system prompt.

**What's harder locally:** Complex jazz harmony, polyrhythm, anything requiring multi-bar voice leading across a full arrangement. 12B helps significantly here.

**The DAW context:** It's not just a standalone AI tool — the assistant has access to the existing notes in the active piano roll, so you can ask it to "continue this melody" or "add a harmony above these notes" and it sees what's already there.

The project also does Demucs stem separation + pitch detection for transcribing real songs, but the Ollama integration is what I'd like feedback on from this community.

Repo: https://github.com/[YOUR_USERNAME]/bunri
Backend config: `music_assistant.py`

Would love to hear from people who've done structured JSON generation with Gemma 3 — I'm tuning the system prompt but not doing any fine-tuning.
