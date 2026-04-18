# Demo Video Script — 60 Seconds

Target: one unbroken screen recording. No voiceover. Captions only.
Recommended tool: OBS for capture, DaVinci Resolve or CapCut for captions + speed ramp.

---

## Shot Breakdown

### [0:00 – 0:04] Hook card

- **Screen:** Static title card over the dark DAW UI (already open, blurred in background)
- **Caption (large, centered):**
  ```
  Turn any song into an editable piano roll.
  Fully offline. Free. Open source.
  ```
- **Notes:** 4 seconds. Let it breathe. Don't rush into the demo.

---

### [0:04 – 0:10] Upload the file

- **Screen:** Left panel open on "ファイル" tab. Drag a song file (pick something recognizable — a well-known pop song works best for social proof)
- **Action:** Drag the file into the upload zone
- **Caption:** "Drop in any WAV, MP3, or FLAC"
- **Notes:** The drag animation should be smooth and visible. Use a real file, not a placeholder.

---

### [0:10 – 0:14] Trigger the analysis

- **Screen:** Click the "楽曲を完全解析" button in the file panel
- **Caption:** "One click: separate + transcribe"
- **Notes:** Show the button clearly. The click sound (if any) should be audible.

---

### [0:14 – 0:22] Processing (speed-ramped)

- **Screen:** Progress bar + status bar updating. Status messages cycling through:
  - "Demucs: ボーカルを分離中..."
  - "ベースをピアノロールに転写中..."
  - "ギターを転写中..."
- **Caption:** "Demucs separates 6 stems. Pitch detection runs on each."
- **Notes:** Speed-ramp this 2–3x. Real processing takes minutes — show 8–10 seconds of sped-up footage. Optionally show a clock in the corner counting up to indicate real time.

---

### [0:22 – 0:35] The payoff — 6 auto-generated tracks

- **Screen:** Timeline view with 6 tracks fully populated:
  - Vocals, Drums, Bass, Guitar, Piano, Other
  - Each track has a waveform clip + a color-coded piano roll bar
- **Action:** Slowly scroll down the track list to show all 6
- **Caption:** "6 tracks — audio clips and notes — auto-generated"
- **Notes:** This is the money shot. Give it time. Don't rush past it.

---

### [0:35 – 0:44] Open a piano roll and show notes

- **Screen:** Click the piano roll icon on the Bass track. Piano roll opens, showing the bass line as notes on a grid.
- **Action:** Play the bass track. Notes light up as they play.
- **Caption:** "Bass line, note by note. Edit or swap the instrument."
- **Action:** In the instrument selector, switch from "アコースティックベース" to "シンセベース1". Play again.
- **Notes:** This demonstrates the GM instrument swap — one of the most compelling features. Make sure the sound change is audible in the recording.

---

### [0:44 – 0:52] Edit a few notes

- **Screen:** Piano roll still open on the bass track
- **Action sequence:**
  1. Click a wrong note to select it, press Delete
  2. Double-click an empty cell to add a new note
  3. Drag a note left by 1 step
- **Caption:** "Fix wrong notes. Move, resize, add, delete."
- **Notes:** Keep this fast — 3 edits in 8 seconds. The point is that it's editable, not a detailed tutorial.

---

### [0:52 – 0:57] AI assistant bonus beat

- **Screen:** Switch to the AI assistant panel (left panel tab)
- **Action:** Type "4小節の切ないコード進行" and hit send. After 2 seconds (or speed-ramp): notes appear in the piano roll.
- **Caption:** "Or ask the AI. Runs on Ollama — no internet needed."
- **Notes:** This can be pre-recorded with a fast local model. If the model is too slow even on speed-ramp, pre-bake this shot separately and cut it in.

---

### [0:57 – 1:00] CTA

- **Screen:** Browser URL bar zooms in showing `localhost:8000`, then cut to the GitHub repo page
- **Caption:**
  ```
  github.com/[YOUR_USERNAME]/bunri
  Open source  •  Apache-2.0  •  CPU only
  ```
- **Notes:** End on the repo. GitHub star count visible if possible.

---

## Production Checklist

- [ ] Record at 1920x1080, browser at 100% zoom
- [ ] Use the dark "Analog Warmth" theme (default) — it looks great on screen
- [ ] Pick a recognizable song for the demo file (something people will recognize as complex)
- [ ] Make sure system audio is captured so instrument playback is audible
- [ ] Speed-ramp the processing section (2–3x), keep editing section at 1x
- [ ] Export: MP4 at 1080p for Twitter/YouTube, GIF (720p, 15fps) for GitHub README
- [ ] Add captions as burned-in text, not subtitles — more reliable across platforms
- [ ] Keep total duration at 60 seconds or under for Twitter autoplay

## What NOT to Show

- Don't show the file upload spinner for more than 2 seconds at 1x speed
- Don't show the full separation log output — it's too text-heavy for a demo
- Don't demo the tools page (separate, edit, convert) — save that for a longer tutorial video
- Don't explain the tech stack in the video — that's for the HN post
