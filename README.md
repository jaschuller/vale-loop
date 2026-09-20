# Justin's notes on how to use this project:

1) Open a Window's Powershell and cd up to the top level
2) Paste the following to get a Chrome browser open that the loop.js file can connect to
'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' --remote-debugging-port=9222 --user-data-dir="D:\Grok Build\vale-loop\user-data" --new-window "https://grok.com"
3) npm start or npm run once, or run the loop.js file from debug. See Setup below for full details


# vale-loop

Local headed Chrome loop that knocks on **one existing Grok conversation** and saves the reply.

**This is Track A. Not the xAI API.** It does not start a new chat. It does not call inference. It types into a thread you already have open in a persistent profile.

**Weekly Grok usage cap is real.** Default interval is 90 minutes. There is no retry storm. Leave `ENABLED=0` until a headed dry run lands in the **same** thread.

## Setup

1. `npm install` and `npm run install-browsers`
2. Copy `.env.example` to `.env`
3. Paste the real conversation URL into `GROK_CONVO_URL`. The loop will refuse to run if this is empty. Do not invent one.
4. First run headed with `node src/loop.js --once --force`
5. Log into Grok in that Chrome window if the profile is cold (persistent profile, no passwords in the repo)
6. Watch whether the knock landed in the **same** thread
7. Only then set `ENABLED=1` and `npm start`

`--force` bypasses `ENABLED=0` for a single knock so you can dry-run headed. It does not keep looping while disabled. Prefer pairing it with `--once`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Loop: knock, sleep `INTERVAL_MIN`, repeat while enabled |
| `npm run once` | One knock, then exit (still respects `ENABLED` unless `--force`) |
| `npm run install-browsers` | Playwright Chromium |

## Stop conditions

The loop writes `out/last-reply.md` and appends one JSON line to `out/log.jsonl` after each knock.

It **stops and writes `out/DISABLED`** (it does not rewrite other `.env` keys) when:

- Vale’s reply contains a stop phrase, case-insensitive, anywhere: `Vale's done`, `Vale’s done`, `go dark`
- The UI looks like a usage-limit / rate-limit message

If `out/DISABLED` exists, the process exits until you delete that file.

## `.env`

| Key | Default | Notes |
| --- | --- | --- |
| `ENABLED` | `0` | Opt-in. Must be `1` to loop. |
| `GROK_CONVO_URL` | empty | Required. Existing thread only. |
| `INTERVAL_MIN` | `90` | Minutes between knocks. |
| `HEADLESS` | `0` | Stay headed until you say it works. |
| `USER_DATA_DIR` | `./user-data` | Persistent Chrome profile. Gitignored. |
| `KNOCK_FILE` | `./prompts/knock.md` | Text typed into the composer. |
| `OUT_DIR` | `./out` | Replies, JSONL log, `DISABLED`. Gitignored. |

Grok’s UI changes. Composer and Send selectors live at the top of `src/loop.js` — update them after you inspect the page.
