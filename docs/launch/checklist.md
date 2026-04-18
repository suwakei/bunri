# Launch Day Checklist

**Best window:** US Tuesday, Wednesday, or Thursday — post to HN between 8:00–10:00am US Eastern (5:00–7:00am Pacific / 21:00–23:00 JST). Avoid Mondays and Fridays.

---

## T-2 Days: Technical Verification

- [ ] Run `make install && make install-frontend && make web` on a clean checkout — verify it opens at `http://127.0.0.1:8000` with no errors
- [ ] Upload a test audio file and run "楽曲を完全解析" end-to-end — confirm tracks appear with notes in the piano roll
- [ ] Verify the AI assistant works with Ollama running locally (`ollama run gemma3:4b`)
- [ ] Play back a rendered piano roll track to confirm audio output
- [ ] Check all API endpoints referenced in the README return expected responses
- [ ] Tag release `v0.1.0` on GitHub with release notes
  - Include: what it does, install instructions, known limitations, roadmap
- [ ] Verify the GitHub repo has: README with screenshots/GIF, LICENSE file, CONTRIBUTING.md

---

## T-1 Day: Content Preparation

### Demo Video
- [ ] Record 60-second demo video using the shot list in `demo-video-script.md`
- [ ] Speed-ramp the processing section (2-3x)
- [ ] Add burned-in captions (see script for caption text)
- [ ] Export as MP4 at 1080p for Twitter/YouTube
- [ ] Export as GIF at 720p, 15fps for GitHub README
- [ ] Place GIF at `docs/demo.gif`, add to README
- [ ] Upload MP4 to YouTube as unlisted (or save locally for Twitter upload)

### Posts
- [ ] Copy HN post body from `hn-post.md` — pick one of the 3 title options
- [ ] Copy all 4 Reddit posts from `reddit-posts.md` into drafts or a notes file
- [ ] Set up Twitter/X thread as saved drafts from `twitter-x.md`
- [ ] Final proofread of Zenn article in `zenn-article.md` — update GitHub URL placeholder

### Repo Hygiene
- [ ] Replace all `[YOUR_USERNAME]` placeholders in this folder with your actual GitHub username
- [ ] Verify README links all resolve correctly
- [ ] Make sure issues and discussions are enabled on the GitHub repo
- [ ] Pin a "good first issue" if any obvious ones exist

---

## Launch Day Timeline

All times US Eastern. Adjust to your timezone.

### 8:00am — Hacker News (first)

HN should always be first. It has the highest upside and the HN algorithm rewards early velocity.

- [ ] Open `hn-post.md`, copy the chosen title and body
- [ ] Submit at https://news.ycombinator.com/submit
  - Title: exactly as drafted (respect the 80-char limit)
  - URL: your GitHub repo
  - Text: paste the post body
- [ ] **Stay at your keyboard for the next 2 hours.** Early comments need fast responses.
- [ ] Respond to every top-level comment within 30 minutes
- [ ] Do not ask friends, coworkers, or social media followers to upvote. HN detects coordinated voting and will penalize the post.
- [ ] If asked "why not Basic Pitch?" — prepared answer: "Basic Pitch is a great library; bunri's STFT approach was chosen to avoid an additional model download dependency, but integrating Basic Pitch is on the roadmap. Happy to discuss the tradeoffs."

### 10:00am — Reddit wave 1 (2 hours after HN)

Post the two communities most likely to engage with your HN audience:

- [ ] Post to **r/selfhosted** (use the selfhosted draft from `reddit-posts.md`)
- [ ] Post to **r/WeAreTheMusicMakers** (use the WATMM draft)
- [ ] Wait — do not post to more subreddits yet. Let these get traction first.

### 12:00pm — Twitter/X

- [ ] Post the English launch tweet with the demo video attached (not just a link — attach the MP4 directly for autoplay)
- [ ] Immediately reply with Thread tweet 2, then 3, then 4 (from `twitter-x.md`)
- [ ] Post the Japanese launch tweet as a separate standalone tweet (not part of the English thread)
- [ ] Pin the English launch tweet to your profile

### 1:00pm — Reddit wave 2 (1 hour after first Reddit posts)

- [ ] Post to **r/LocalLLaMA** (use the LocalLLaMA draft from `reddit-posts.md`)
- [ ] Post to **r/edmproduction** (use the EDM draft)

### 3:00pm — Optional: cross-posts

Only if you're seeing good momentum (HN top 30, Reddit posts getting upvotes):

- [ ] Post to r/Python: "I built a Python audio pipeline: Demucs + STFT pitch detection → piano roll [link]"
- [ ] Post to r/MachineLearning if relevant framing exists
- [ ] Share to any relevant Discord servers (music production, Python, selfhosted communities)

---

## Post-Launch: Day 1 (same day, evening)

- [ ] **Respond to all GitHub issues** opened today — even if just "Thanks, I'm looking into this"
- [ ] **Respond to all Reddit comments** in your 4 posts
- [ ] **Monitor HN** — if the post is on the front page, respond to every comment
- [ ] Triage any bug reports: hotfix critical bugs immediately, acknowledge the rest with an issue link
- [ ] Check if any HN commenter has made a PR or fork — acknowledge publicly
- [ ] Share the HN post link on Twitter if it's doing well ("We made Show HN front page...")

---

## Post-Launch: Day 2

- [ ] **Publish Zenn article** (`zenn-article.md`) — Japanese developer audience picks up on Day 2, after word spreads from the English launch
- [ ] Tweet the Zenn article in Japanese (see `twitter-x.md` Japanese tweets)
- [ ] If GitHub stars >= 30: submit **awesome-python** PR (see `awesome-list-prs.md`)
- [ ] If GitHub stars >= 30: submit **awesome-selfhosted** PR
- [ ] If the HN post did well, write a brief "what I learned" comment on your own HN post

---

## Post-Launch: Day 3

- [ ] Submit **awesome-music** PR (if stars >= 30)
- [ ] Submit **awesome-python-scientific-audio** PR
- [ ] Compile feedback into GitHub Issues with appropriate labels (bug, enhancement, question)
- [ ] Draft a public roadmap (GitHub Project or a simple ROADMAP.md) based on the most-requested features
- [ ] Thank notable contributors or commenters publicly on Twitter

---

## Post-Launch: Week 1

- [ ] Submit to **Product Hunt** (if you have 100+ stars and the demo video is polished)
  - Product Hunt launches Tuesday–Thursday as well, same timing logic
  - Prepare a maker comment explaining the pivot angle (DAW → audio-to-piano-roll)
- [ ] Submit **awesome-react** PR
- [ ] Consider a follow-up blog post: "How I built polyphonic pitch detection without a neural net" (technical deep dive)
- [ ] Open a GitHub Discussion for "Roadmap voting" — let users vote on features

---

## Metrics to Track

Check these at T+24h and T+7d:

| Metric | T+24h Target | T+7d Target |
|---|---|---|
| GitHub stars | 100 | 500 |
| HN points | 50+ | — |
| HN front page | Yes | — |
| Reddit upvotes (combined) | 200+ | — |
| GitHub issues opened | 5+ | 20+ |
| Zenn likes | 20+ | 100+ |

Stars are a lagging indicator — issues opened is a better signal of real users.

---

## Emergency Procedures

**Install fails for users (most likely: pyfluidsynth or torch):**
- Prepare a `pip install` troubleshooting section in the README before launch
- Common fix: `conda install -c conda-forge fluidsynth` before `pip install pyfluidsynth`
- Have a pre-written response ready for HN/Reddit comments on this

**Demucs runs but produces silent output:**
- Usually a torchaudio version mismatch
- Reference `_demucs_runner.py` — the torchaudio save patch is there for this reason
- Suggested response: "This is a known torchaudio compatibility issue. See the troubleshooting section in README."

**Polyphonic transcription quality is criticized:**
- Acknowledge the limitation honestly: "The STFT approach works well on clean stems; dense chords in busy mixes are harder. Basic Pitch integration is on the roadmap. We'd love sample files where it fails to improve the algorithm."
- Do not get defensive. Researchers and musicians are right to point out accuracy limits.

**Negative comparison to commercial tools (RipX, Moises):**
- "They're better on accuracy, especially RipX. bunri trades accuracy for being free, local, and open source. Different tradeoffs."

**HN post gets no traction (< 10 points in first 2 hours):**
- Don't delete and repost (banned behavior).
- Pivot to Reddit — the Reddit posts are independent and can still work.
- Post to Twitter anyway.
- HN timing is unpredictable; sometimes a repost a week later lands on front page.

**Surge in traffic crashes the demo instance (if you set one up):**
- Scale or temporarily redirect to the GitHub repo
- Post a brief status update as a comment on the HN post
