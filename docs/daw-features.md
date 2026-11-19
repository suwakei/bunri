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
| Part separation | `/api/decompose` with the project grid. One track per part holding the part's audio and its お手本 (`referenceNotes`); the editable notes stay **empty**. Part tracks start muted (the 原曲 already plays everything). **Drums have the same shape**: the transcribed hits become the お手本, each kind on a fixed pitch (キック C2 / スネア D2 / ハイハット・シンバル F#2 / タム A2, the GM drum map; one table in `lib/drums.ts`), length 1 step, and the editable notes stay empty. With 「ドラムを種類ごとに分ける」 checked (`split_drums=true`) the drum stem is first split into kick / snare / toms / cymbals by the add-on model `drumsep` and each stem's onsets become that kind's hits, so a kick and a cymbal hit at the same time both appear; otherwise (or when the model cannot be fetched: no failure, the reason is shown) the old single-stem spectral-centroid classification is used (kick / snare / hihat, one kind per onset). The checkbox is pre-checked only when the model is already on disk; checking it when it is not says that ~160 MB will be downloaded (never downloaded without that choice). Part separation started by the assistant splits drums only when the model is already there. Drum tracks made by older versions (rhythm placed directly as notes, no お手本) still open and play; their 「このパートを練習する」 is shown disabled with the reason (分け直すと使える) |
| Practice a part (このパートを練習する) | From the part list or the part's track header: creates/selects the practice track (「ベースの練習」) next to the part, opens it in the piano roll with the part's お手本 as the ghost overlay, scrolls to the お手本's pitch and first bar, sets the diff pair (reference = part, attempt = practice track) and unmutes the part's audio, then opens the practice view (below). 「お手本をノートとして取り込む」 (after an inline confirmation) copies the お手本 into the part's own notes |
| Playhead | A line in the timeline and the piano roll, moved with requestAnimationFrame while playing (idle: checked every 200 ms). Auto-scrolls to keep it visible; 「再生位置を追う」 next to the seek bar turns that off (remembered per viewer) |
| Chart / guide / diff links | Clicking a chord cell or a section row in the chart, a bar chip in the guide, or an issue in the diff list seeks playback there and scrolls the timeline and piano roll (the diff also scrolls vertically to the pitch) |
| Bar numbering | Piano roll, timeline ruler, playback, metronome and the diff coach count bars from the project grid: tempo (decimals allowed) and the offset of bar 1 (`gridOffset`, seconds). After importing a song this is the chart's grid, so chart bar N and piano-roll bar N are the same moment. Free use: offset 0 |
| Timeline | Place clips on tracks. Drag to move, beat-snapping, drag-and-drop audio files (anything the WebView can decode). Right-click a clip (or Shift+F10 / the menu key on a focused clip) for a small menu: 複製 (duplicate right after it, same audio buffer, keeping the trimmed range and fades) / 再生位置で分割 / フェード… / 削除. A focused clip is deleted with Delete and split at the playhead with S |
| Clip trim / split / fade (縮める・分割・フェード) | **Non-destructive**: a clip keeps its audio buffer untouched and stores where in the audio it starts (`audioStart`, seconds), how long it sounds (`duration`) and the fade lengths (`fadeIn` / `fadeOut`, seconds, linear, never overlapping). A clip without these fields (older projects, a freshly added clip) plays the whole audio as before. **Trim**: drag the left or right edge (6 px); an edge cannot go past the ends of the audio or before 0 s, snaps to beats like moving (hold Option/Alt for no snap), and dragging it back restores what was hidden. Moving the left edge keeps the audio where it is on the timeline. **Split**: 「再生位置で分割」 in the clip menu or S on a focused clip; the two clips share the same `AudioBuffer` (nothing is copied, and the project file still stores that audio once). The left part keeps the fade-in, the right part the fade-out. Disabled with the reason (`data-blocked`) while the playhead is outside the clip. **Fade**: drag the round handles at the clip's top corners (shown on hover / focus / when a fade is set; hidden on clips narrower than 36 px), or 「フェード…」 in the menu for a small dialog that takes seconds (the keyboard path; rejects a sum longer than the clip). One drag / one dialog / one split = one undo entry. The same calculations (`lib/clip.ts`) drive normal playback (also when starting mid-fade), the loop (`clipInSegment` + `_startLoopSource`: the clip fade and the 4 ms loop-edge fade are separate gain nodes), WAV export (`mixdown`), song length, and the practice-speed stretch (`extractRegion` reads only the visible range and bakes the fade in), so what is heard, exported and drawn agree. A drag that changes nothing says why (`'hint'`) |
| Clip waveform | Each clip shows its waveform and the fade shape (darkened triangle + gain line; the waveform height is scaled by the fade gain). Peaks (min/max per 256 samples across channels) are computed once per `AudioBuffer` and kept in a `WeakMap` (`lib/waveform.ts`): split and duplicated clips share them, and zoom, scrolling, re-rendering and playback never recompute them. Audio up to 2^18 samples is done on the spot; longer audio in slices of 2^20 samples between timers, then only the waveform canvases are redrawn (a 5-minute song does not block the UI). Each clip has one canvas covering just the visible part plus 240 px margins (never the whole clip width), redrawn on scroll when the view leaves the drawn range. Main-thread code and a plain canvas: no `blob:` or inline script, so the CSP is unchanged. Clips without audio (legacy placeholders) show no waveform |
| Track header | Name (+ note count), 練習する (part tracks), a "…" menu (名前を変更 / 上へ移動 / 下へ移動 / トラックを削除), ▶ M S, pan and volume sliders. Deleting is in the menu, not next to S |
| Track volume / pan | Volume −60…+6 dB (0.5 dB steps), pan left 100…right 100. Numeric readouts ("−6.0 dB", "左 30") that are also the sliders' `aria-valuetext`; keyboard accessible; double-click resets to 0 dB / centre. Applied live to the track's Web Audio nodes, used by playback and WAV export, saved in projects (`gain`, `pan`) |
| Piano roll | Per-track, independent. C0–B8 range. Double-click to add a note, drag to move (horizontal = position, vertical = pitch), drag the right edge to resize, Delete / Backspace to remove. Placing a note, changing its pitch, or pressing a key on the keyboard column plays that pitch. **Drum tracks** (a drum part and its practice track; `lib/drums.ts` `isDrumTrack`): the keyboard column widens and shows the kind names on the drum rows instead of note names (キック C2 / スネア D2 / ハイハット・シンバル F#2 / タム A2), the view scrolls so those rows are visible, the snap grid defaults to 16th notes (1 step; other tracks: 1 beat; see "Piano roll snap grid" below), and notes on the drum rows sound as small synthesized drums (`lib/drum-sound.ts` `playDrum`: kick = falling sine, snare = noise + short tone, hi-hat / cymbal = high-passed noise, tom = falling sine; velocity scales the level; one function for playback, loop, WAV export, key audition and MIDI monitoring; notes on other rows stay triangle). A stop-gap until the Rust instrument engine |
| Piano roll snap grid (刻み / スウィング) | Two `<select>`s in the piano roll header (arrangement and practice view; `components/SnapBar.tsx`, maths in `lib/snap.ts`). **刻み**: 4 分 / 8 分 / 16 分 / 32 分 / 8 分の三連 / 16 分の三連. Placing (double-click: the grid position at or before the pointer, length = one grid cell), moving, resizing (lengths are multiples of the cell, never shorter than one), paste (playhead rounded down to the grid), duplicate, ←→ and MIDI step input all follow it. Defaults keep the old behaviour: 4 分 on normal tracks, 16 分 on drum tracks; the choice is remembered per viewer, separately for the two kinds (localStorage `bunri-snap` / `bunri-snap-drums`). **Units**: `step` and `length` stay in 16th-note steps and may be fractional (0.5 = 32nd, 4/3 = 8th triplet, 2/3 = 16th triplet). Every value is kept as a multiple of 1/60 step (`lib/grid.ts` `normStep`, same rounding as `backend/note_steps.py`); integers stay integers, and differences / equality / range tests are done on the integer tick count (`toTicks`). All snap arithmetic is done in those ticks (4 分 = 240, 8 分 = 120, 16 分 = 60, 32 分 = 30, 8 分の三連 = 80, 16 分の三連 = 40), so repeated nudging never accumulates error (three triplet nudges = exactly one beat). **スウィング** (only with 8 分 or 16 分; otherwise disabled with the reason): 50 % (none) / 54 / 58 / 62 / 67 % (= 2/3, the triplet position) / 71 / 75 %. It moves the off-beat grid positions later: positions come in pairs of two cells, and the off-beat sits at `swing × 2 cells` into the pair (rounded to 1/60 step). Only the snap positions and the grid lines move; notes are stored at the swung (fractional) step and playback just plays them. With swing, a placed note lasts until the next grid position, ←→ steps to the neighbouring grid position, and resizing snaps the note end. Swing is a property of the song: it is stored in the project grid (`grid.swing`, omitted when 0.5), restored on open, part of the unsaved-changes comparison and of undo snapshots, exactly like tempo and meter. **Grid lines**: beat and bar lines as before; between them the lines of the chosen grid (triplet positions for triplets, swung positions with swing, the usual 16th lines for 4 分 / 8 分 / 16 分), thinned to a coarser grid or dropped when cells would be narrower than 8 px. Notes narrower than 30 px keep a third of their width as the resize grip so they can still be dragged. When practice starts on a part whose お手本 sits on a triplet grid (detected from the note positions, `gridFeelOf`; `/api/decompose` also reports `grid_feel`), the grid is set to 8 分の三連 once per part and the status bar says so; this does not overwrite the remembered choice |
| Piano roll selection | Rubber-band (drag from an empty spot), Shift+click to add/remove, Cmd/Ctrl+A (only while the piano roll has focus). Selected notes move/resize together. Arrow keys: ←→ by one cell of the snap grid (1 beat by default), ↑↓ by a semitone, Shift+↑↓ by an octave. Esc clears. お手本 (ghost) notes are never selectable |
| Piano roll clipboard | Cmd/Ctrl+C / X / V / D. Paste goes to the playhead (rounded down to the grid; bar 1 if before it), duplicate goes right after the selection. The clipboard is in-app and works across tracks |
| Piano roll zoom | Horizontal 5–100 px per step (default 20; the top levels make 32nd notes and 16th triplets easy to place) via the 横 −/＋ buttons or Cmd/Ctrl+wheel / trackpad pinch (anchored at the pointer); vertical 10–24 px per row via 縦 −/＋. Notes, ghost notes, grid and playhead all derive from the same step width, so bar alignment with the timeline (`lib/grid.ts`) is unchanged |
| Key / chord tones in the piano roll (キーの音 / コードの音) | Two `aria-pressed` toggles in the piano roll header (arrangement and practice view; same `PianoRollEngine`), both ON by default, remembered per viewer (localStorage `bunri-hint-key` / `bunri-hint-chord`). **キーの音**: rows whose pitch is in the chart key's scale (major, or natural minor) get a very faint gold tint (`--accent`, alpha 0.06; the tonic row 0.12), and the keyboard column gets the same mark (a gold edge; the tonic also has a gold note name). The chart has one key for the whole song, so one key is painted (no per-section keys). **コードの音**: for each chart chord, from its `start_sec` to its `end_sec` (cut at the next chord's start; gaps where no chord was detected are left unpainted), the rows of the chord tones get a faint teal tint (`--secondary`, alpha 0.10; the root row 0.18). Seconds → steps go through the project grid (`lib/grid.ts`), the same conversion as the practice view's コード band, so the left edges line up with it (and with the bar lines when the chart's grid is the project grid). Steps may be fractional. Chord tones come from the chord symbol via `lib/pitch-hints.ts` (`CHORD_INTERVALS` / `CHORD_SUFFIX`), which must equal `backend/music_theory.py` (`CHORD_TEMPLATES` / `CHORD_SUFFIX`): both sides are tested against `test/fixtures/chord-qualities.json`, and the Vitest also reads the Python source. Unreadable symbols and `N` are not painted. Drawn on the grid canvas as the bottom layer (under the loop shading, grid lines, ghost notes, notes, diff marks, selection, playhead), only for visible rows and the chord regions overlapping the viewport (binary search); regions are precomputed when the chart or grid changes. The toggles are disabled, with the reason in the tooltip, when there is no chart (自由に作る), the key / chords were not detected, or the open track is a drum track (pitch has no scale meaning there). No LLM. Not a 「場所を示す」 target of the assistant |
| Undo / redo | One project-wide history (see "Undo history" below). Header buttons ↶ / ↷ (title says what will be undone), Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y. Inside text fields the shortcuts are left to the field (native text undo; in the desktop app the default macOS Edit menu provides it). Deleting a track or clip shows a toast 「〜を削除しました — 元に戻す」 (`role="status"`, 10 s) instead of a confirmation |
| Synthesizer | 4 basic waveforms (sine / square / sawtooth / triangle), 6 instrument presets (guitar / violin / chorus / flute / bass / organ), 84 GM voices via FluidSynth (MuseScore_General.sf3) |
| Drum machine | 4 patterns (8-beat / 4-on-the-floor / bossa nova / reggae), configurable bars and volume |
| Effects | 3-band EQ / compressor / reverb / delay / normalize / pitch shift / time stretch. Applied to a clip's **visible range only**: the result becomes new audio and the clip then plays it from its start (`audioStart` back to 0, so the hidden parts can only be brought back by undo); fades stay as clip settings (clamped to the new length). Other clips sharing the old audio (the other half of a split, a duplicate) are unchanged |
| Monophonic analysis | pyin pitch detection converts a single-voice WAV to piano roll notes |
| Transport | BPM (20–300), time signature (4/4, 3/4, 6/8), play / stop / record, metronome, seekbar. Space toggles play / pause |
| Recording | Microphone input recorded to a track |
| Project file (保存 / 別名で保存 / 開く) | One `.bunri` file per song (SQLite, format 2.0; see song-chart-design.md "プロジェクトの保存"): tracks (role, part, practice partner, name, mute/solo/volume/pan), notes and お手本 (fractional steps round-trip unchanged), clips **with audio** (integer-PCM WAV stored as FLAC, others as-is; deduplicated by SHA-256, so the two halves of a split clip store one audio) and their trimmed range and fades, grid (tempo, meter, `gridOffset`, `swing`), the chart, the learn state (ghost choice, diff pair, last diff result), the practice-view settings (loop, speed, listen, お手本, input), the learning history, and copies of the cached guide / coach explanations. ⌘S saves (first time: native save dialog, default `~/Documents/bunri/<曲名>.bunri`), ⇧⌘S saves as, ⌘O opens (list of recent projects + 「ほかのファイルを選ぶ…」). Reopening restores the learning session without re-analysis or Claude calls. Opening clears the undo history. Dev browser path: asks for a name and stores in the data dir's `projects/` |
| Recent projects (最近使ったプロジェクト) | In the empty state and the header ▾ menu. Kept by the desktop shell in the data dir (`recent-projects.json`, 12 entries). Entries can be removed (the file is not deleted); missing files are shown as 「見つかりません」 |
| Unsaved changes | The window title and the header show the project name and 「●」 while there are unsaved changes (compared against the snapshot taken at save/open, so undoing back to the saved state clears it). Opening, 新しいプロジェクト and closing the window / ⌘Q ask 保存 / 保存しない / キャンセル |
| Autosave and crash recovery (自動保存 / 前回の続き) | While there are unsaved changes, the screen writes a recovery copy into the data dir's `recovery/` (30 s after the last change, at most 2 min after the first unwritten change; `lib/autosave.ts`). **The user's file is never written automatically**, the 「●」 stays, `project` (path / file / token) and the undo history are untouched, and the status bar stays quiet (one notice after 3 consecutive failures). Autosave waits while playing, but writes anyway once the first unwritten change is 5 min old (looping a section while entering notes is the longest way the app is used); while keys are being played in realtime MIDI recording (count-in, or a key pressed / released within the last 3 s) it waits for a pause in the playing, and writes after 10 min at the latest. It does not write mid-drag, while a job runs, or while the API is unreachable, and never overlaps a user save (an in-flight autosave is cancelled and the save goes first). The recovery copy is deleted when the changes are saved, undone back to the saved state, or given up with 保存しない (open / new / close). On the next launch, if a copy remains, a modal asks 「前回、保存していない変更が残っています」 with the project name and time: 「続きを開く」 restores the project with its name and original path / file as **unsaved** (⌘S then writes the original file; if there was none, it asks as on a first save), 「捨てる」 deletes the copy |
| Legacy projects (以前の形式) | Old `projects/*.json` appear in the open list with a 「以前の形式」 badge. Clips have no audio: they are placeholders listed in a bar with 「音声を読み込み直す」. Reloading keeps the clip's position, trimmed range and fades and fits the range to the new audio (it never exceeds the audio length; `fitClipToBuffer`); clips sharing the same missing audio (split / duplicated) are reloaded together. Saving converts to `.bunri`; the JSON file is kept |
| Learning history (学習の記録) | Every 「お手本と比べる」 records time, bar range, match rate (= the diff's `accuracy`), issue counts by kind, the explanation key, and **per-bar results** (`barStats`: for each bar in the range that has お手本 notes, the number of お手本 notes and how many matched; from the diff's `bar_stats`, same counting as `accuracy`, so the per-bar sums equal the record's totals). The 差分 tab shows 「一致 67% 前回より +34%」, a trend and the last 5 attempts. Saved in the project (`learning_history.bar_stats`; records saved before this have no per-bar results and still open) |
| Practice map (練習の地図) | At the top of 学ぶ → 差分 (above 差分チェック; reachable from ⑤ 差分で直す), `components/PracticeMap.tsx`. A grid: rows = every track that has お手本 notes (no part type is special-cased), columns = the chart's sections in order (seconds → project bars with `secondsToBars`, the same conversion as the practice view's 構成 band; without chart sections, 4-bar blocks up to the last お手本 bar). Each cell shows the match rate of that part in that section: for each bar, the **newest** learning-history record that covers it is used (only records of the pair お手本 = the part, 打ち込み = its practice track; a record's bar is ignored when its お手本 note count differs from the current お手本, so records from before a re-separation, a deleted track or a time-signature change never show); the section value is matched ÷ お手本 notes summed over its compared bars. States: empty box = not compared yet (まだ比べていません), 「N%」 = all bars with お手本 notes compared, 「N% 途中」 with a dashed border = only some of them compared (the rate is of the compared bars), 「–」 = no お手本 notes in the section (not pressable). Levels: ≥ 80 % `--ok`, 50–79 % `--warn`, < 50 % `--error` as a faint tint plus a bottom line whose length is the rate; never colour alone (number, 途中, legend, `aria-label` / tooltip like 「ベース・サビ（17〜24 小節）: 一致 72%（お手本のノートが在る 8 小節のうち、6 小節を比べました）」). Old records without per-bar results are spread evenly over their range (tooltip says 「以前の記録なので、小節ごとの内訳はありません」). Pressing a cell runs the same 「このパートを練習する」 (`practicePart`) and sets the loop to the section through `updatePractice` (sections longer than 32 bars: the first 32). Keyboard: `role="grid"` with a roving tab stop; arrow keys / Home / End move, Enter / Space press. With many sections only the table scrolls sideways (sticky part names). Empty state: 「お手本と比べると、ここに曲全体の進み具合が出ます」. Moving through cells never marks the project unsaved (pressing one changes the saved loop, as in the practice view). Aggregation: `lib/practice-map.ts` (pure). No LLM; not an assistant tool |
| データの整理 | In the ファイル tab: disk usage of the data dir by category and a cleanup of temporary files (uploads, generated audio, chart work files, project working copies older than 5 minutes; never the open project, cached guides/explanations, `projects/`, the recovery copy in `recovery/`, or files outside the data dir) |
| Assistant (アシスタント) | A chat dock on the right (header button 「アシスタント」; stays visible in the practice view). The user asks in plain words and Claude operates the DAW through tools: read the project / notes / chart / saved guide, play / stop / seek, tempo and time signature, add / rename / delete / open tracks, mute / solo / gain / pan, add / remove / replace notes on any track (steps and lengths may be fractional: 0.5 = 32nd note, 4/3 = 8th triplet; values are rounded to 1/60 step), transform notes without rewriting them (transpose / shift / quantize to 32nd, 16th, 8th, quarter, half, whole or 8th / 16th triplets / repeat / velocity, optionally only the notes selected in the piano roll), compare with the reference (`check_diff`: facts from the DSP diff, no extra Claude call; colours the notes when it matches the practice view's range), open / close the practice view and set its loop / speed / listen, metronome, connect MIDI input, start / watch / cancel part separation, move / delete / duplicate / trim / split / fade audio clips (`trim_clip`, `split_clip`, `fade_clip`: the same code path as the timeline), apply effects to a clip, export WAV / MIDI, save the project, and point at a place in the UI (`show_in_app`: opens the tab and pulses the control; importing a song stays a user action). Replies stream. The empty chat offers three example requests picked from the current state (no Claude call). Each tool call shows as one line of the **operation log** (操作ログ) in the chat (✓ summary or ✕ reason); opening a line shows the activity-log lines that happened during that operation. Everything changed by one request is a single undo entry (「アシスタント: …」), also reachable from the 「元に戻す」 button under the reply. The loop runs in the UI and the backend makes one stateless Claude call per step (`POST /api/assistant/step`, up to 12 per request); usage shares the guide's ledger and daily limit, counted per request. The chat (text and operation-log lines, not the API messages) is saved in the project file and restored on open; a long or restored conversation is restarted from a rule-based record of what was said and done (no Claude call). Design: `docs/assistant-design.md` |
| Activity log (動きの記録) | What just happened, in order: clicked controls, changed values, shortcut keys, status-bar messages, backend calls (path, status, duration), MIDI input (connect, key presses, placed notes; on desktop also the raw messages with the port name) and uncaught errors. The 「記録」 button in the status bar opens the list (newest at the bottom; it follows new lines unless you scrolled up). The desktop app also appends every line to `logs/activity.log` in the data directory so an agent can read the same record. Text being typed, API keys, the sidecar token, request/response bodies and query-string values are never recorded (project, track and file names do appear, in status messages, button names and API paths). The list keeps the last 500 lines; the file rotates at 1 MB |
| Notices (知らせ) | Failures and "why nothing happened" float as a toast near the bottom of the window, in addition to the status bar line (`lib/notice.ts`, `components/NoticeToast.tsx`, mounted once in `main.tsx` so the tools page gets it too). Two kinds: `error` (red edge: what happened + what to do next) and `hint` (blue edge: not a failure, but the action could not be done — why, and how to make it possible). Successful results stay in the status bar only. In the DAW, `setStatus(text, 'error' \| 'hint')` raises the toast; an optional action button does the next step in place (e.g. 「MIDI 入力を始める」). The same text arriving again restarts the timer instead of stacking (at most 3 shown); a repeat within 1.5 s (a held key, rapid MIDI notes) neither re-animates the toast nor rewrites the status bar or the activity log. Toasts close after 7–20 s depending on kind and length, stay while one of their buttons is hovered or focused, and have a ✕. Clicks on the toast text pass through to the screen below (it sits over the piano roll); only its buttons take clicks. While the sidecar-stopped banner is shown, toasts stack above it. **Pressing a disabled control** shows why it is disabled: its `data-blocked` reason (`blockedBy(...)`) or, failing that, 「いまは使えません。」 + its tooltip. Covered no-ops include: play with nothing to play or every sounding track muted, undo/redo with nothing to step, piano-roll double-click with no track open, copy / cut / duplicate / delete with no selection, paste with nothing copied, nudging past the edge, an out-of-range velocity, an empty track name, a recording that could not be decoded, a part whose audio failed to load, and MIDI keys pressed with no track selected. The screen reader channel stays the status bar (`role="alert"` for failures); text that appears nowhere else (a disabled control's reason, the MIDI device notice) goes to an always-present polite live region (`#notice-live`). In the activity log a failure is prefixed 「エラー: 」 and a hint 「知らせ: 」 |
| MIDI keyboard input | Play a connected keyboard into the piano roll: step input (advance one note at a time; one step = one cell of the piano roll's snap grid by default, so triplets step through triplet positions and swing through the swung positions; a fixed length 16 分〜全音符 can be chosen instead) or real-time recording while the transport runs (optional one-bar count-in; a latency offset moves played notes earlier, defaulting to the audio output latency; positions and lengths are rounded to 16th notes, or to the snap grid when it is 32 分 or a triplet; with swing it still rounds to straight 16ths). Note velocity is recorded. Web MIDI in Chrome / Edge; the desktop app receives MIDI natively. Until 「MIDI 入力」 is pressed nothing reaches the app, so on desktop the app lists the connected ports once at startup (`midi_ports`, without opening them) and, if a MIDI device is there, shows a notice with a 「MIDI 入力を始める」 button (not shown again once MIDI input has been started or the notice was closed with ✕; `bunri-midi-intro-seen`). The reason a note was not placed is shown once per situation, not on every key. 「再検出」 closes the previous input before reopening (otherwise each key arrived twice on desktop). Pressing keys with no track selected, outside the piano-roll range, or (real-time) while stopped says why no note was placed; connecting with no keyboard found says to plug it in and press 「再検出」 |
| MIDI export | Piano-roll notes of every track as a standard MIDI file (format 1, one MIDI track per track, 480 ticks per quarter). Notes carry their velocity (96 when a note has none). One step is 120 ticks and note positions are multiples of 1/60 step = 2 ticks, so triplets, 32nds and swung notes are written exactly |
| MIDI import | Notes of a standard MIDI file (format 0 or 1) as new tracks, or as a reference to practise against. Positions and lengths are rounded to 1/24 of a beat (1/6 step), so 16ths, 32nds and 8th / 16th triplets come in unchanged (they used to be pulled onto 16th notes); the shortest length is a 32nd note. The number of notes that were actually rounded is shown before importing. Import → export keeps positions. Velocity is kept |
| WAV export | Offline mixdown to WAV. Follows mute and solo, the same as playback. Trimmed clips contribute only their visible range, with their fades |

#### Undo history

- **What is recorded:** note add / delete / move / resize / pitch change / paste / duplicate / cut, bulk note replacement
  (お手本をノートとして取り込む, monophonic analysis, MIDI-input recording), track add / delete / rename / reorder /
  mute / solo / volume / pan, clip add / move / duplicate / delete / trim / split / fade / effect, song import, part separation, 練習する,
  project load.
- **Entry = two project snapshots** (`lib/project-snapshot.ts`): before and after the operation. A clip snapshot holds the
  buffer reference, position, name, sounding length and, when set, `audioStart` / `fadeIn` / `fadeOut` / `missing`. Undo applies only the
  fields that differ between the two, so unrecorded changes (e.g. typing a new BPM) are not rolled back by an unrelated
  undo; tempo/meter/offset are restored only when that operation changed them. Snapshots reference audio buffers and
  the `Track` objects themselves (a deleted track comes back with the same id and audio nodes); note arrays are shared
  between consecutive snapshots when their content is unchanged.
- **Coalescing:** a drag (note, clip, clip edge or fade handle) is one entry from press to release; slider movements of the same track, repeated
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
| Bands | 構成 / コード / 小節, positioned from seconds via `lib/grid.ts` with the piano roll's step width and scroll (`PianoRollEngine.onView`). With the chart grid applied, chart bar N and piano-roll bar N coincide, so a chord cell's left edge is on the bar line. Dragging on 小節 sets the loop; clicking a section sets the loop to it. Each section also carries a small badge with the match rate of the part being practised in that section (empty box = not compared yet, 「N% 途中」 = partly compared, 「–」 = no お手本 notes; same aggregation as the practice map, `lib/practice-map.ts`), updated right after 比べる. The state is in the tooltip and the button's accessible description; the button's name and click are unchanged |
| Loop (区間ループ) | Bars (inclusive), bar inputs, ‹ › (or `[` `]`), L toggles. The engine schedules one pass at a time at exact AudioContext times with 1.5 s lookahead (`lib/loop.ts` + `AudioEngine._playLoop`): clips are started with `start(when, offset, duration)` and 4 ms edge fades, notes and metronome clicks per pass, so passes join without gaps and the playhead (`getCurrentTime`) wraps. Shown dimmed outside the range in the piano roll and as a gold strip in the timeline ruler (also after leaving) |
| Speed (速度) | 50/60/75/90/100 %, pitch preserved. The part's audio for the loop region (plus 0.1 s margins) is time-stretched once per speed with WSOLA (`lib/stretch.ts`) in a Web Worker (`lib/stretch.worker.ts`, same-origin, no CSP change) and cached (last 3, `lib/practice-audio.ts`). Notes and metronome follow by tempo scaling. While preparing, playback stays at 100 % with a message; without a loop the speed does not apply (stretching a whole song would hold 2× its audio in memory at 50 %). Measured on the dev Mac (Node, stereo 44.1 kHz): 8 s region → 43 ms at 50 %, 16 s → 138 ms, 30 s → 175 ms. `playbackRate` is not used because it lowers the pitch |
| Listen (聴く) | パート / 自分 / 両方 via `AudioEngine.listenOverride` (playback only; track mute/solo, the project and the undo history are untouched; WAV export still follows mute/solo). お手本 見せる / 隠す switches the overlay |
| Input (入力) | マウス / MIDI ステップ / MIDI リアルタイム, driving the one `useMidiInput` instance the centre area owns (the normal piano-roll header uses the same). The snap grid and swing selects of the piano roll header are shown here too and apply to all three. Step input starts at the loop start and stops at its end. Real-time recording in a loop **overdubs**: notes are added on every pass (an identical pitch at the same step is not added twice; "same step" is compared in 1/60-step ticks), each pass is its own undo entry, and a note held across the loop end is cut at the end. Overdub was chosen over replace so that a pass where you only listen, or play part of the phrase, does not erase earlier notes |
| Compare (比べる) | Diffs the notes starting inside the loop (or the whole track), records a learning-history attempt with the loop's bar range (match rate = matched お手本 notes in range ÷ お手本 notes in range = `summary.accuracy`), colours notes (see [coach-diff-design.md](coach-diff-design.md) 「練習画面」), lists 「この区間の指摘」 in time order; clicking an issue selects and flashes its notes and scrolls there, clicking a coloured note shows its issue. Issues and notes are matched by pitch and by position / length in 1/60-step ticks, so fractional (triplet, 32nd) notes are never confused with their neighbours. Offsets are worded by note value (「8 分の三連符 1 個ぶん遅い」「32 分音符 1 個ぶん早い」; whole steps stay 「16 分音符 2 個ぶん」/「1 拍ぶん」; `lib/snap.ts` `spanLabel`). Editing notes or the loop clears the colours and shows 「もう一度比べてください」. **Drum parts** are compared by rhythm only (`mode: "drums"`, chosen by `lib/drums.ts` `diffModeOf` for the diff panel, the practice view and the assistant alike): only hits of the same kind (= same pitch) are paired, within one 16th note (other parts: two); length is ignored; a hit on the wrong kind is 抜け + 余分なノート; issue kinds are 抜け / 余分なノート / 位置のずれ only, worded with the kind name (「1 小節 2 拍目: スネア が抜けています」). The match rate, `bar_stats` and the result shape are unchanged, so the learning history and the practice map work as for any part. The Claude explanation is not offered for drums (a fixed sentence instead; no Claude call) |
| Keys | Space play/pause (header), L, `[` `]`, Esc (not while typing, a dialog or a menu is open, or the piano roll used Esc to clear a selection) |
| State | `practice` in the store (`PracticeState`: partId, trackId, loop {startBar, endBar, enabled}, speed, listen, showGhost, input) — small and JSON-serialisable; kept after leaving so re-entering resumes. Saved in the project as the `practice` state section (tracks by index; `lib/practice-project.ts`). Opening a project restores the settings but does not reopen the practice view (it opens in the arrangement; no MIDI connection or time-stretching starts on its own). Changing a setting marks the project unsaved; entering/leaving does not. Diff results are not kept (the attempts are in the learning history) |

#### Not implemented

- **Clip gain, fade curves, crossfades.** A clip has no volume of its own (use the track volume), fades are linear
  only, and overlapping clips are simply summed. Clip edges cannot be trimmed from the keyboard (split with S and
  delete the unwanted part instead); fades can (the 「フェード…」 dialog).
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
| POST | `/api/decompose` | `file`, `bpm` (float, 0 = detect), `grid_offset` (seconds of step 0), `sensitivity`, `split_drums` | Full pipeline: separate → pitch detect → instrument estimate. Notes are counted from `grid_offset`; notes before it (pickup) are dropped. `split_drums=true` splits the drum stem into kick / snare / toms / cymbals first (add-on model `drumsep`, downloaded on first use, ~160 MB) and transcribes each kind from its own stem; if the model cannot be fetched it falls back to the single-stem classification instead of failing. Result: `drum_source` (`"stems"` / `"spectral"` / null when there is no drum part; also on each drum stem) and `drum_fallback` (reason sentence when splitting was requested but not used, else null). Drum `drum_events[].type` is `kick` `snare` `toms` `cymbals` (stems) or `kick` `snare` `hihat` (spectral). The split stems are not returned as parts. `grid_feel` (`"straight"` / `"triplet"`; one value for the whole song, also on each stem) is the grid the notes and drum events were rounded to: 16th notes, or 8th-note triplets (3 per beat) when the onsets of all parts clearly sit on a triplet grid (shuffle / triplet feel; when in doubt it stays `"straight"`). With `"triplet"`, `notes[].step` / `notes[].length` and `drum_events[].step` are multiples of 4/3 in 16th-note units (fractional; whole values stay integers); with `"straight"` they are integers as before |
| POST | `/api/coach/diff` | JSON `{reference, attempt, steps_per_bar?, steps_per_beat?, timing_tolerance?, reference_source?, mode?}` | Diff of the user's notes against the お手本 (no LLM): `summary`, `bars`, `worst_bars`, `velocity`, `bar_stats`. `mode: "drums"` compares rhythm only (same pitch = same drum kind, position within `timing_tolerance`, default 1 step; length ignored; no pitch / octave / length issues). Without `mode`: pitch, position (default 2 steps) and length. Note `step` / `length` are in 16th-note units and may be fractional (0.5 = 32nd note, 4/3 = 8th-note triplet; rounded to multiples of 1/60 step; whole values are returned as integers, so results for integer-only notes are unchanged). A position or length difference is reported as an issue only when it is at least 0.5 step; issue `bar` / `beat` are always integers |

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
| POST | `/api/project/recovery` | JSON `{token, name, path, file}` | Autosave: turn the working copy `work/<token>.bunri` into the recovery copy (moved into `recovery/`, marker `recovery.json` replaced atomically, previous copy removed); returns `{name, path, file, saved_at, size_bytes}`. `path` / `file` are only remembered, never opened |
| GET | `/api/project/recovery` | — | `{recovery: {name, path, file, saved_at, size_bytes}}`, or `{recovery: null}` when there is nothing to recover |
| POST | `/api/project/recovery/open` | — | Copy the recovery copy to a new working copy; returns `{token, name, path, file}` (then `POST /api/project/open/{token}`). The recovery copy is kept. 404 when there is none |
| DELETE | `/api/project/recovery` | — | Delete the recovery copy and its marker; returns `{removed}` |
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
