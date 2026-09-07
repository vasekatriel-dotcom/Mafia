# Mafia Live

A 20-player live Mafia party game: Node/Express + Socket.io backend, plain
HTML/CSS/JS frontend (no build step). In-memory game state, mobile-friendly
UI, secret-code rejoin, private Mafia chat, Day/Night phases with a
timestamp-based tie-breaker, a one-shot Detective role that appears once
exactly 6 Villagers remain, and an arithmetic mini-game that gives eliminated
players a shot at a second-chance powerup.

## Architecture

```
mafia-game/
├── package.json
├── server/
│   ├── index.js       # Express static server + Socket.io event routing
│   ├── gameState.js   # Authoritative game logic (roles, phases, votes,
│   │                    tie-break, Detective trigger, puzzle, dagger)
│   ├── names.js        # Pool of 20 gender-neutral 1920s names
│   └── config.js        # Role counts, timers, puzzle settings — tweak here
└── public/
    ├── index.html      # All views: join, lobby, role card, day/night stage,
    │                     spectator/puzzle area, game over
    ├── style.css        # Responsive/mobile styling
    └── app.js           # Socket wiring + UI rendering (no game logic)
```

**Design principle:** `gameState.js` is the single source of truth. The
client never computes outcomes — it sends intents (`vote:cast`,
`mafia:vote`, `puzzle:submit`, ...) and the server validates, resolves, and
broadcasts. Secret codes and roles live only in server memory and in the
per-socket "private state" payload sent to that player alone.

## Quick install & run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in up to 20 browser tabs/devices (or a mix —
each tab is one player). Click **Join Game**, note the secret code shown in
the alert (it's also saved to that browser's `localStorage` for
reconnect), and wait in the lobby. The **first player to join is the lobby
host** and sees a **Start Game** button — start once at least 5 players
(20 recommended) have joined.

To simulate 20 players from one machine for testing, open 20 tabs in
**incognito/private windows** (regular tabs share `localStorage`, which is
fine — each tab still gets its own socket/player — but private windows make
it easy to tell them apart visually).

## How to deploy

### Render / Railway / Heroku (any Node host)
1. Push this repo to GitHub.
2. Create a new Web Service pointing at the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. No environment variables are required. Set `PORT` only if your host
   doesn't inject it automatically (most do).

### Vercel
Vercel's default hosting is serverless and doesn't hold the long-lived
in-memory state or persistent WebSocket connections this game needs. To
deploy there, wrap `server/index.js` as a Vercel **Node.js server**
(not a serverless function) via their "Other Frameworks" / custom server
support, or simpler: use Vercel only for a static preview and run the
actual game on Render/Railway/Heroku/Fly.io, which all support standard
long-running Node servers with WebSockets out of the box.

## How to use the host / Narrator panel

- **Pre-game (lobby host):** the first joiner can **Start Game** and
  **kick** players while still in the lobby.
- **In-game (Narrator role):** whoever is randomly dealt the Narrator role
  gets a control panel on the Game tab with:
  - **Force end Day / Force end Night** — skip the timer and resolve the
    phase immediately (useful if everyone's ready early).
  - **End game** — abort the game at any time.
  - **Announce** — broadcast a narrated message into the public feed that
    all players (including spectators) see.
- Phases also auto-resolve on a timer (default: 60s Day, 45s Night) — see
  `server/config.js` → `TIMERS`.

## How to test the puzzle reward and Detective activation

**Puzzle reward:**
1. In an early Day (Round 1 or 2), vote out a player.
2. That player's private view now shows a **spectator** screen with an
   **Attempt puzzle** button (only if they were eliminated in Round 1 or 2 —
   this is enforced server-side, not just hidden in the UI).
3. They solve 10 arithmetic questions within 30 seconds.
   - If they were a **Villager**: on success, the **Doctor** privately sees
     "extra save active" that Night and can select **two** save targets
     instead of one.
   - If they were **Mafia**: on success, they get a **dagger** they can
     bestow (from the spectator screen) on any living player — that
     player's vote counts double in the very next Day's tally, then the
     effect expires.
4. The public feed and the spectator "Scoreboard" panel show puzzle
   outcomes so the whole town stays engaged.

**Detective activation:**
1. Play through Day/Night cycles, eliminating players, until the number of
   players still holding the plain **Villager** role (i.e. not Mafia,
   Doctor, Narrator) reaches exactly **6**.
2. At that moment the server randomly promotes one of those six Villagers
   to **Detective**. Their private role view updates immediately and a
   line appears in the public feed (without naming who).
3. That Night, the Detective's panel lets them investigate one living
   player and privately see "IS Mafia" / "is NOT Mafia".
4. At the end of that Night, the Detective automatically reverts to
   Villager (or, if they were killed that Night, the role is simply gone) —
   this is a one-round-only power per the spec, and it is only ever granted
   once per game.

For fast manual testing without waiting through 8+ real rounds, you can
also drive `GameState` directly from a Node REPL/script (see
`node -e "..."` examples we used during development, or write a quick
script requiring `server/gameState.js` and calling its methods) — this
bypasses sockets and lets you fast-forward eliminations.

## Configuration

Edit `server/config.js`:
- `ROLES.MAFIA_COUNT`, `DOCTOR_COUNT`, `NARRATOR_COUNT` (Villagers fill the
  remainder of `MAX_PLAYERS`).
- `DETECTIVE_TRIGGER_COUNT` — villager headcount that promotes a Detective
  (default 6).
- `TIMERS.VOTING_SECONDS`, `NIGHT_SECONDS`, `PUZZLE_SECONDS`.
- `PUZZLE.QUESTION_COUNT`, `REQUIRED_CORRECT` (accuracy threshold, default
  10/10), `SINGLE_ATTEMPT_PER_ELIMINATION`.
- `USE_REDIS` — flag only; see "Production notes" below for what wiring
  Redis would involve.

## Security notes

- Secret codes are generated with `crypto.randomBytes(24)` server-side and
  are only ever sent to the owning socket (`state:private`), never
  broadcast.
- All game actions are validated server-side against the caller's actual
  role/alive-status/phase (e.g. `mafia:vote` checks the caller is a living
  Mafia member; puzzle grading re-checks the stored answer key rather than
  trusting a client-submitted score).
- The Mafia chat is a Socket.io room whose membership is rebuilt from
  "currently living Mafia" after every elimination/round, so eliminated or
  never-Mafia players cannot read it.

## Production notes / potential improvements

This is built to run as a single Node process for a party-game-sized
group; if you wanted to harden it for real production use, consider:

- **Redis-backed state** (the `USE_REDIS` config flag is a placeholder):
  swap the in-memory `Map`s in `GameState` for a Redis-backed store, so
  the game survives server restarts and can scale beyond one process.
- **Reconnect grace window**: currently a disconnected player's socket is
  marked `connected: false` but they can rejoin any time via their secret
  code; you could add a timeout that auto-kicks or replaces long-disconnected
  players so the game doesn't stall.
- **Rate limiting** on chat/vote events to prevent spam.
- **Automated tests**: the demo script below can be adapted into a
  Playwright/Cypress suite that drives 20 headless browser contexts.
- **Accessibility pass** and richer audio cues (currently a simple WebAudio
  beep, toggleable).
- **Narrator override for Detective timing** (spec item 8 mentions "force
  assign Detective early" as optional) — not wired into the UI yet; would
  be a small addition to `gameState.js` + a Narrator-panel button.
- **Persistent achievement feed** across multiple games (currently resets
  each game).

## End-to-end demo script

See `demo-script.md` for a step-by-step walkthrough (join → roles → Day
vote with a tie → Night mafia kill + chat → puzzle success → Doctor extra
save → Detective activation at 6 villagers) you can follow with real
browser tabs, plus the equivalent as a scripted Node check (which is what
was used to validate the tie-breaker, Detective trigger, and puzzle/dagger
logic during development).
