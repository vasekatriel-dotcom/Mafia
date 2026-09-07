# End-to-end demo script

Two ways to run through the flow: (A) manually in real browser tabs, which
exercises the full UI/sockets stack, or (B) a scripted check against
`GameState` directly, which is faster for verifying rules logic without
clicking through 20 tabs. Both are described below; (B) is literally the
script used during development to validate the tie-breaker, Detective
trigger, and puzzle/dagger mechanics (see the "Validated behavior" section).

## A. Manual browser walkthrough (20 simulated players)

1. **Start the server:** `npm run dev`, open `http://localhost:3000`.
2. **Join 20 times.** Open 20 browser tabs (private/incognito windows make
   it easiest to tell them apart). In each, click **Join Game** and note
   the alert showing that tab's secret code — each tab is now one distinct
   player with a random 1920s name.
3. **Name assignment check:** the Lobby list should show 20 distinct
   1920s-style names (Arthur, Beatrice, Cedric, ... Winifred).
4. **Start the game:** the tab that joined first sees a **Start Game**
   button (lobby host). Click it.
5. **Role assignment check:** every tab's **My Role** view now privately
   shows that player's role (4 Mafia, 1 Doctor, 1 Narrator, 14 Villager by
   default). No tab shows anyone else's role.
6. **Day 1 vote (with a tie):** have two clusters of players vote for two
   different targets so the counts tie (e.g. 3 votes on Player X, 3 votes
   on Player Y, with X having received its first vote earlier in real
   time). End of Day either auto-resolves on the timer or the Narrator
   clicks **Force end Day**. Confirm the player who was voted *first*
   among the tied targets is the one eliminated — this is the
   timestamp-based tie-break rule.
7. **Night 1 — Mafia kill + chat:** the 4 Mafia tabs now see the Mafia
   panel. Have them exchange a couple of messages in **Mafia chat** (only
   Mafia tabs can see this) and pick a target via **Target**. The Doctor
   tab picks a **Save** target. Force-end the Night (Narrator) or wait for
   the timer.
8. **Reveal:** the public feed shows either "X was eliminated during the
   night" or "the Doctor saved them," depending on whether the Doctor
   guessed the Mafia's target correctly.
9. **Puzzle success (early-round eliminated player):** whichever player
   was voted out in Round 1 (step 6) now sees a **Spectator** view with an
   **Attempt puzzle** button. Click it, answer all 10 arithmetic questions
   correctly within the 30-second timer, and submit.
   - If that player was a **Villager**, the Doctor's Night panel on the
     *next* Night shows "(extra save active tonight — pick up to two)" and
     the Doctor can click **Save** on two different names.
   - If that player was **Mafia**, their Spectator view now shows a
     **Dagger** panel — bestow it on a living player; that player's vote
     will count double in the next Day's tally (visible as an inflated
     vote count next to their name).
10. **Continue playing** Day/Night cycles, eliminating players, until the
    public player list shows exactly **6** players still shown as plain
    Villagers (not Mafia/Doctor/Narrator). At that instant, one of those
    six is randomly promoted: their **My Role** tab updates to
    **Detective**, and the public feed posts a (name-free) hint that a
    Detective has emerged.
11. **Detective investigates:** that Night, the Detective's tab shows an
    **Investigate** panel; pick a living player and confirm a private
    "IS Mafia" / "is NOT Mafia" result appears only in that tab.
12. **Detective reverts:** at the end of that Night, the Detective's role
    automatically reverts to Villager (check their **My Role** tab).
13. **Game over:** keep playing until either all Mafia are eliminated
    (Town wins) or Mafia count ≥ remaining Town count (Mafia wins). Every
    tab should switch to the **Game Over** screen showing the correct
    winner and that player's role.

## B. Scripted logic-level equivalent

The following was run against `server/gameState.js` directly (bypassing
sockets/UI) during development to validate the rules programmatically —
useful as a starting point for an automated test suite:

```js
const { GameState } = require('./server/gameState');
const g = new GameState();

// 1. Join 20 players, confirm unique names.
for (let i = 0; i < 20; i++) g.addPlayer('sock' + i);

// 2. Start game, confirm default role distribution
//    (4 Mafia / 1 Doctor / 1 Narrator / 14 Villager).
g.startGame();

// 3. Tie-breaker: cast two targets to equal vote counts, first-voted wins.
const alive = Array.from(g.players.values());
g.castVote(alive[2].id, alive[0].id); // A's first vote
g.castVote(alive[3].id, alive[1].id); // B's first vote (later)
g.castVote(alive[4].id, alive[0].id);
g.castVote(alive[5].id, alive[1].id);
const result = g.endDayPhase(); // -> eliminates A (earliest first-vote)

// 4. Night: set a Mafia target and a Doctor save, resolve.
// (find role holders, call g.setMafiaVote / g.setDoctorSave, then g.endNightPhase())

// 5. Puzzle success + reward:
//    g.generatePuzzle(eliminatedPlayerId) -> 10 questions
//    g.submitPuzzleResult(id, answers, elapsedSeconds) -> grants Doctor
//    extra save (if Villager) or a dagger (if Mafia).

// 6. Detective trigger: eliminate villagers down to exactly 6 remaining
//    plain Villagers; g._maybePromoteDetective() (called automatically
//    inside endDayPhase()) randomly assigns Detective once.

// 7. Win condition: g.checkWinCondition() returns 'town' | 'mafia' | null.
```

## Validated behavior (from development testing)

- ✅ 20 players joined, all names unique.
- ✅ Default role split: 4 Mafia / 1 Doctor / 1 Narrator / 14 Villager.
- ✅ Tie-break correctly eliminates the target with the earliest first
  vote when vote counts are equal.
- ✅ Detective is promoted exactly once, exactly when plain-Villager
  headcount hits 6.
- ✅ A Villager eliminated in Round 1 who solves the puzzle within time
  grants the Doctor a one-time extra save.
- ✅ A Mafia member eliminated in Round 1 who solves the puzzle earns a
  dagger; bestowing it sets the target's next-Day vote weight to 2.
- ✅ Server boots, serves `index.html` and the Socket.io client script.
