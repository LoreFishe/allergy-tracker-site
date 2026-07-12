# Field Log — Allergy Tracker

A personal tool for pairing daily environmental data (weather, air quality,
pollen) with manually logged allergy symptom severity, to eventually spot
patterns. See `CLAUDE_ALLERGYTRACKER.md` in the parent development folder for
the full project directive and architecture rationale.

Live site: https://lorefishe.github.io/allergy-tracker-site/

This repo is the public, code-only half of the project — no personal data
lives here. Symptom logs and environmental history live in the private
[`allergy-tracker-data`](https://github.com/LoreFishe/allergy-tracker-data)
repo, which this page reads and writes directly from your browser.

## One-time setup

### 1. Generate a GitHub token for the browser

The page needs write access to `allergy-tracker-data` to log symptoms and
save backfilled environmental data. It never touches any other repo.

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. Token name: anything, e.g. "allergy-tracker-site"
3. Resource owner: your account
4. Repository access → **Only select repositories** → `allergy-tracker-data`
5. Permissions → Repository permissions → **Contents: Read and write**
6. Generate, copy the token (`github_pat_...`)
7. Open the live site, click the gear icon, paste the token in

The token is stored in this browser's `localStorage` only. It's never sent
anywhere except GitHub's API. Anyone with access to this unlocked browser
could use it to write to `allergy-tracker-data` — but nothing else, since
the token is scoped to just that one private repo.

### 2. Set up pollen capture (optional but recommended)

Pollen data comes from the Google Pollen API, which only knows about
*today and the next few days* — it can't answer "what was pollen like on a
day I missed." So instead of fetching it from the browser, a small script
runs locally on your Mac once a day (and whenever you log in), independent
of whether you actually open the tracker that day. See
`CLAUDE_ALLERGYTRACKER.md` → "Pollen Capture" for the full reasoning.

**Get a Google Pollen API key:**

1. [console.cloud.google.com](https://console.cloud.google.com/) → create or
   pick a project → enable billing (you'll stay within the free 5,000
   calls/month tier for personal use)
2. APIs & Services → Library → search "Pollen API" → Enable
3. APIs & Services → Credentials → Create Credentials → API key
4. On the new key, set API restrictions → restrict to **Pollen API only**

**Wire it into the local script:**

```bash
cd allergy-tracker-data/scripts
echo "GOOGLE_POLLEN_API_KEY=your-key-here" > .env
```

`.env` is gitignored — the key never leaves your machine.

**Run it once by hand to check it works:**

```bash
/usr/bin/python3 fetch_pollen.py
```

It should print a pollen reading per active location and, if anything
changed, commit + push to `allergy-tracker-data` on your behalf (using your
existing `git`/GitHub credentials on this machine — the script has no token
of its own).

**Install the LaunchAgent so it runs automatically:**

```bash
mkdir -p ~/Library/LaunchAgents
cp com.allergytracker.pollen.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.allergytracker.pollen.plist
```

It runs once at login/wake and again daily at 8am. Logs land in
`~/Library/Logs/allergy-tracker-pollen.log`.

The plist has the repo's current absolute path baked in
(`scripts/com.allergytracker.pollen.plist`). If you ever move the repo,
update that path and reload:

```bash
launchctl bootout gui/$(id -u)/com.allergytracker.pollen
# edit the plist's ProgramArguments path, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.allergytracker.pollen.plist
```

**Known limitation:** if your Mac is off or asleep for a whole day, that
day's pollen is permanently missing (weather/AQI still backfill fine later
from the browser — only pollen has this gap, since Google's API can't look
backward). Not worth solving unless it turns out to matter in practice.

## How it works

- **Weather & air quality** (Open-Meteo, free, no key): fetched by the page
  itself on load, backfilling any gap since the last saved day.
- **Pollen** (Google Pollen API): captured by the local script above,
  independent of the page.
- **Symptom logs**: filled in via the form on the page, written straight to
  `symptoms.csv` in the private repo.
- **Log completeness**: a symptom log is "complete" once environmental data
  exists for the full 30-days-before to 30-days-after window around its
  date — shown separately from logs still filling in.

No backend, no database, no CI. Two GitHub repos and one local script.

## Local development

Static files, no build step:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.
