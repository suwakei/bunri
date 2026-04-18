# Hacker News — Show HN Post

## Title Options

Pick one. Option A is the most direct; Option C has broader appeal.

**A (recommended):**
> Show HN: Bunri – Turn any song into an editable piano roll, fully offline

**B:**
> Show HN: Bunri – Local Demucs + pitch detection DAW (open-source Moises alternative)

**C:**
> Show HN: Bunri – I built a browser DAW that decomposes songs into stems and piano rolls

---

## Post Body Draft

---

Hey HN,

I built Bunri — an open-source, offline-first DAW that takes any audio file and turns it into an editable piano roll. Think of it as a local alternative to Moises or RipX.

**What it does:**

1. You drop in a WAV, MP3, or FLAC.
2. Demucs (Meta AI, htdemucs_6s) separates it into up to 6 stems: vocals, drums, bass, guitar, piano, other.
3. Each non-drum stem runs through polyphonic pitch detection (STFT harmonic peak detection with 4-harmonic weighting). Drums go through onset detection + spectral centroid classification for kick/snare/hihat.
4. Every stem becomes an editable piano roll track, with GM instrument auto-selection (FluidSynth + MuseScore_General.sf3) and estimated mix parameters (volume dB, pan, reverb).
5. You can edit the notes, swap the instrument, add effects (EQ, compressor, reverb, delay, pitch shift), and export a mixdown WAV.

There's also an AI assistant panel — it takes a natural language prompt ("4-bar sad chord progression in A minor") and generates note data. It runs Ollama/Gemma 3 locally or falls back to the Anthropic API if you have a key.

**Why I built it:**

I kept wanting to learn from songs by pulling out specific parts and seeing the notes. Moises does stems, but you still can't see the notes or edit them without expensive tools. Basic Pitch (Spotify) is great but it's a separate tool with no DAW integration. I wanted the whole pipeline in one place, running locally without any subscription.

**Tech stack:**

- Backend: Python / FastAPI
- Audio: Demucs, librosa (pyin for monophonic, custom STFT pipeline for polyphonic), PyFluidSynth
- Frontend: React 19 / TypeScript / Vite 8
- AI: Ollama (Gemma 3 4B/12B) + optional Anthropic Claude API
- No Docker required, no GPU required — runs fine on a laptop CPU (segment=7, jobs=1 to keep memory low)

**Caveats:**

The polyphonic transcription is home-rolled (no Basic Pitch / piano-transcription), so it's best on clean stems with clear pitches. It works well on bass and single-instrument stems; dense chords or heavily reverbed material are harder. The Demucs separation quality is whatever Demucs gives you — which is generally pretty good for mainstream music.

First separation on a 3-minute track takes ~4-8 minutes on a modern CPU (no GPU). Subsequent runs reuse cached stems.

**Repo:** https://github.com/[YOUR_USERNAME]/bunri

Would love feedback, especially on:
- The polyphonic pitch detection approach (should I just integrate Basic Pitch?)
- Whether the React migration from vanilla JS was worth it (I think yes, the Context-based state is much cleaner)
- Docker setup — is there appetite for a container image?

---

### Notes for Posting

- Post on a **Tuesday or Wednesday between 8–10am US Eastern** for best visibility.
- Do not post from a brand-new HN account. If your account is new, post from a sock puppet that has some comment karma first, or wait.
- Respond to every top-level comment within the first 2 hours. HN rewards engagement.
- Keep follow-up comments factual and specific — "great point, here's how I handle that" performs better than "thanks!"
- If someone asks "why not just use Basic Pitch?" — have a prepared answer ready (integration, offline, full DAW context).
