// server/gameState.js
// Authoritative, server-side game state. Clients never mutate this directly --
// they emit intents (vote, chat, etc.) which the socket layer validates and
// routes into these methods. All secret data (tokens, roles, votes-by-whom)
// lives only here and in the private payloads built for each player.

const crypto = require('crypto');
const NAMES = require('./names');
const config = require('./config');

const ROLES = {
  MAFIA: 'Mafia',
  DOCTOR: 'Doctor',
  NARRATOR: 'Narrator',
  VILLAGER: 'Villager',
  DETECTIVE: 'Detective'
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeToken() {
  // Non-guessable secret code, server-side only. Never sent to other clients.
  return crypto.randomBytes(config.SESSION.TOKEN_BYTES).toString('base64url');
}

class GameState {
  constructor() {
    this.reset();
  }

  reset() {
    this.players = new Map(); // playerId -> player object
    this.namePool = shuffle(NAMES);
    this.phase = 'lobby'; // lobby | day | night | ended
    this.round = 0;
    this.winner = null; // 'town' | 'mafia' | null

    // Voting state for the current Day phase.
    this.votes = new Map(); // voterId -> targetId
    this.firstVoteTimestamp = new Map(); // targetId -> ms timestamp of first vote received
    this.doubleVoteHolder = null; // playerId whose vote counts double this Day (dagger effect)

    // Night action state.
    this.mafiaTarget = null; // playerId chosen by mafia consensus (last vote wins, simple majority-ish)
    this.mafiaVotes = new Map(); // mafia playerId -> target playerId (for simple plurality)
    this.doctorSaveTargets = []; // array of playerId, length 1 (or 2 with extra save)
    this.doctorExtraSaveActive = false; // granted by a successful Villager puzzle
    this.detectiveTargetId = null;
    this.detectiveResult = null; // { targetId, isMafia }

    // Detective bookkeeping.
    this.currentDetectiveId = null;
    this.detectiveActiveRound = null;
    this.detectiveHasUsedThisGame = false; // only ever assigned once, per spec ("assign ... at that moment")

    // Puzzle / powerup bookkeeping.
    this.daggerHolders = new Map(); // playerId -> { used: bool, expiresAfterRound }
    this.publicFeed = []; // { ts, text } - shown to everyone incl. spectators

    // Narrator control.
    this.narratorId = null;
    this.started = false;
  }

  // ---------- Lobby ----------

  addPlayer(socketId) {
    if (this.players.size >= config.MAX_PLAYERS) {
      throw new Error('Game is full (20/20 players).');
    }
    if (this.started) {
      throw new Error('Game already started.');
    }
    const id = crypto.randomUUID();
    const name = this.namePool.pop() || `Player${this.players.size + 1}`;
    const token = makeToken();
    const player = {
      id,
      socketId,
      name,
      token,
      role: null,
      alive: true,
      connected: true,
      eliminatedRound: null,
      eliminatedPhase: null, // 'day' | 'night'
      isDetectiveNow: false,
      puzzle: { eligible: false, attempted: false, solved: false, quiz: null },
      originalRoleAtElimination: null // captured for puzzle reward logic
    };
    this.players.set(id, player);
    this._logPublic(`${name} joined the lobby (${this.players.size}/${config.MAX_PLAYERS}).`);
    return player;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (!this.started) {
      // Free the name back to the pool and remove entirely pre-game.
      this.namePool.push(p.name);
      this.players.delete(playerId);
    } else {
      p.connected = false; // keep them in-game state; they may reconnect with token
    }
  }

  reconnectByToken(token, newSocketId) {
    for (const p of this.players.values()) {
      if (p.token === token) {
        p.socketId = newSocketId;
        p.connected = true;
        return p;
      }
    }
    return null;
  }

  setNarratorSocket(playerId) {
    this.narratorId = playerId;
  }

  // ---------- Role assignment ----------

  startGame() {
    if (this.started) throw new Error('Game already started.');
    if (this.players.size < 5) throw new Error('Need at least 5 players to start.');
    this.started = true;

    const ids = shuffle(Array.from(this.players.keys()));
    const { MAFIA_COUNT, DOCTOR_COUNT, NARRATOR_COUNT } = config.ROLES;

    let cursor = 0;
    for (let i = 0; i < MAFIA_COUNT; i++) this.players.get(ids[cursor++]).role = ROLES.MAFIA;
    for (let i = 0; i < DOCTOR_COUNT; i++) this.players.get(ids[cursor++]).role = ROLES.DOCTOR;
    for (let i = 0; i < NARRATOR_COUNT; i++) this.players.get(ids[cursor++]).role = ROLES.NARRATOR;
    for (; cursor < ids.length; cursor++) this.players.get(ids[cursor]).role = ROLES.VILLAGER;

    this._logPublic('Roles have been dealt in secret. The town falls quiet...');
    this.round = 1;
    this.startDayPhase();
  }

  // ---------- Day phase / voting ----------

  startDayPhase() {
    this.phase = 'day';
    this.votes.clear();
    this.firstVoteTimestamp.clear();
    // doubleVoteHolder persists only for the Day it was granted for; clear after resolution.
    this._logPublic(`Day ${this.round} begins. Discuss, then vote.`);
  }

  castVote(voterId, targetId) {
    const voter = this.players.get(voterId);
    const target = this.players.get(targetId);
    if (!voter || !voter.alive) throw new Error('Only living players may vote.');
    if (this.phase !== 'day') throw new Error('Voting is only allowed during the Day phase.');
    if (!target || !target.alive) throw new Error('Invalid or dead vote target.');

    this.votes.set(voterId, targetId);
    if (!this.firstVoteTimestamp.has(targetId)) {
      this.firstVoteTimestamp.set(targetId, Date.now());
    }
    // Vote counts and the tie-break timestamp are visible; *who* voted for whom is not.
    return this.getVoteCounts();
  }

  getVoteCounts() {
    const counts = new Map();
    for (const [voterId, targetId] of this.votes.entries()) {
      const weight = voterId === this.doubleVoteHolder ? 2 : 1;
      counts.set(targetId, (counts.get(targetId) || 0) + weight);
    }
    return Array.from(counts.entries()).map(([targetId, count]) => ({
      targetId,
      count,
      firstVoteAt: this.firstVoteTimestamp.get(targetId) || null
    }));
  }

  // Resolves voting: highest weighted count wins; ties broken by earliest first-vote timestamp.
  endDayPhase() {
    if (this.phase !== 'day') throw new Error('Not in Day phase.');
    const counts = this.getVoteCounts();
    let eliminatedId = null;

    if (counts.length > 0) {
      const maxCount = Math.max(...counts.map(c => c.count));
      const tied = counts.filter(c => c.count === maxCount);
      tied.sort((a, b) => (a.firstVoteAt || Infinity) - (b.firstVoteAt || Infinity));
      eliminatedId = tied[0].targetId;
    }

    // The dagger's double-vote effect is single-use and expires at the end of this Day regardless.
    this.doubleVoteHolder = null;

    let eliminatedPlayer = null;
    if (eliminatedId) {
      eliminatedPlayer = this._eliminate(eliminatedId, 'day');
    } else {
      this._logPublic('No votes were cast -- no one is eliminated today.');
    }

    const winner = this.checkWinCondition();
    if (winner) {
      this.phase = 'ended';
      this.winner = winner;
      return { eliminatedPlayer, winner };
    }

    this._maybePromoteDetective();
    this.startNightPhase();
    return { eliminatedPlayer, winner: null };
  }

  // ---------- Night phase ----------

  startNightPhase() {
    this.phase = 'night';
    this.mafiaTarget = null;
    this.mafiaVotes.clear();
    this.doctorSaveTargets = [];
    this.detectiveTargetId = null;
    this.detectiveResult = null;
    this._logPublic('Night falls. The town sleeps.');
  }

  setMafiaVote(mafiaPlayerId, targetId) {
    const mafia = this.players.get(mafiaPlayerId);
    if (!mafia || mafia.role !== ROLES.MAFIA || !mafia.alive) {
      throw new Error('Only a living Mafia member may choose a target.');
    }
    if (this.phase !== 'night') throw new Error('Mafia may only act at Night.');
    this.mafiaVotes.set(mafiaPlayerId, targetId);
    // Simple plurality among mafia; last-mover-breaks-ties is acceptable for a party game.
    const tally = new Map();
    for (const t of this.mafiaVotes.values()) tally.set(t, (tally.get(t) || 0) + 1);
    let best = null, bestCount = -1;
    for (const [t, c] of tally.entries()) {
      if (c > bestCount) { best = t; bestCount = c; }
    }
    this.mafiaTarget = best;
    return this.mafiaTarget;
  }

  setDoctorSave(doctorPlayerId, targetIds) {
    const doctor = this.players.get(doctorPlayerId);
    if (!doctor || doctor.role !== ROLES.DOCTOR || !doctor.alive) {
      throw new Error('Only the living Doctor may save.');
    }
    if (this.phase !== 'night') throw new Error('The Doctor may only act at Night.');
    const maxTargets = this.doctorExtraSaveActive ? 2 : 1;
    const list = Array.isArray(targetIds) ? targetIds.slice(0, maxTargets) : [targetIds];
    this.doctorSaveTargets = list.filter(Boolean);
    return this.doctorSaveTargets;
  }

  setDetectiveInvestigate(detectivePlayerId, targetId) {
    const det = this.players.get(detectivePlayerId);
    if (!det || det.role !== ROLES.DETECTIVE || !det.alive) {
      throw new Error('Only the living, active Detective may investigate.');
    }
    if (this.phase !== 'night') throw new Error('The Detective may only act at Night.');
    const target = this.players.get(targetId);
    if (!target) throw new Error('Invalid investigation target.');
    this.detectiveTargetId = targetId;
    this.detectiveResult = { targetId, isMafia: target.role === ROLES.MAFIA };
    return this.detectiveResult;
  }

  // Resolves the night: mafia kill vs doctor save(s), applies result, reverts Detective.
  endNightPhase() {
    if (this.phase !== 'night') throw new Error('Not in Night phase.');

    let killedPlayer = null;
    if (this.mafiaTarget) {
      const saved = this.doctorSaveTargets.includes(this.mafiaTarget);
      if (saved) {
        this._logPublic('Someone was attacked in the night but the Doctor saved them.');
      } else {
        killedPlayer = this._eliminate(this.mafiaTarget, 'night');
      }
    } else {
      this._logPublic('The Mafia made no move -- the town wakes unharmed.');
    }

    // The one-time extra save, if it was used this Night, is consumed either way.
    this.doctorExtraSaveActive = false;

    // Detective is active for exactly one round; revert/clear regardless of outcome.
    if (this.currentDetectiveId) {
      const det = this.players.get(this.currentDetectiveId);
      if (det && det.alive) {
        det.role = ROLES.VILLAGER;
        det.isDetectiveNow = false;
        this._logPublic(`${det.name}'s detective work is done -- they return to being a Villager.`);
      }
      this.currentDetectiveId = null;
      this.detectiveActiveRound = null;
    }

    const winner = this.checkWinCondition();
    if (winner) {
      this.phase = 'ended';
      this.winner = winner;
      return { killedPlayer, winner };
    }

    this.round += 1;
    this.startDayPhase();
    return { killedPlayer, winner: null };
  }

  // ---------- Detective trigger ----------

  _maybePromoteDetective() {
    if (this.detectiveHasUsedThisGame) return; // spec: promoted once, "at that moment"
    const pureVillagers = Array.from(this.players.values()).filter(
      p => p.alive && p.role === ROLES.VILLAGER
    );
    if (pureVillagers.length === config.DETECTIVE_TRIGGER_COUNT) {
      const chosen = pureVillagers[Math.floor(Math.random() * pureVillagers.length)];
      chosen.role = ROLES.DETECTIVE;
      chosen.isDetectiveNow = true;
      this.currentDetectiveId = chosen.id;
      this.detectiveActiveRound = this.round;
      this.detectiveHasUsedThisGame = true;
      this._logPublic('A Detective has emerged from among the Villagers tonight...');
    }
  }

  // ---------- Elimination / win condition ----------

  _eliminate(playerId, phase) {
    const p = this.players.get(playerId);
    if (!p || !p.alive) return null;
    p.alive = false;
    p.eliminatedRound = this.round;
    p.eliminatedPhase = phase;
    p.originalRoleAtElimination = p.role;

    // Detective bookkeeping if the detective themself dies.
    if (this.currentDetectiveId === playerId) {
      this.currentDetectiveId = null;
      this.detectiveActiveRound = null;
    }

    // Puzzle eligibility: only rounds 1-2, per config.
    p.puzzle.eligible = config.PUZZLE.EARLY_ROUNDS_ELIGIBLE.includes(this.round);

    this._logPublic(`${p.name} (${p.role}) was eliminated during the ${phase}.`);
    return p;
  }

  checkWinCondition() {
    const alive = Array.from(this.players.values()).filter(p => p.alive);
    const mafiaAlive = alive.filter(p => p.role === ROLES.MAFIA).length;
    const townAlive = alive.length - mafiaAlive;
    if (mafiaAlive === 0) return 'town';
    if (mafiaAlive >= townAlive) return 'mafia';
    return null;
  }

  // ---------- Puzzle mini-game ----------

  generatePuzzle(playerId) {
    const p = this.players.get(playerId);
    if (!p) throw new Error('Unknown player.');
    if (p.alive) throw new Error('Only eliminated players may attempt the puzzle.');
    if (!p.puzzle.eligible) throw new Error('This puzzle is only offered to players eliminated in Round 1 or 2.');
    if (config.PUZZLE.SINGLE_ATTEMPT_PER_ELIMINATION && p.puzzle.attempted) {
      throw new Error('You already used your single puzzle attempt.');
    }
    const ops = ['+', '-', '*', '/'];
    const max = config.PUZZLE.OPERAND_MAX;
    const questions = [];
    for (let i = 0; i < config.PUZZLE.QUESTION_COUNT; i++) {
      const op = ops[Math.floor(Math.random() * ops.length)];
      let a = 1 + Math.floor(Math.random() * max);
      let b = 1 + Math.floor(Math.random() * max);
      let answer;
      if (op === '+') answer = a + b;
      else if (op === '-') { if (b > a) [a, b] = [b, a]; answer = a - b; }
      else if (op === '*') answer = a * b;
      else { // division: construct so it divides evenly
        b = 1 + Math.floor(Math.random() * max);
        answer = 1 + Math.floor(Math.random() * max);
        a = answer * b;
      }
      questions.push({ id: i, a, b, op, answer }); // answer kept server-side only in real deployment;
      // included here for a self-contained demo grader -- see submitPuzzleResult().
    }
    p.puzzle.quiz = questions;
    p.puzzle.attempted = true;
    return questions.map(({ id, a, b, op }) => ({ id, a, b, op })); // strip answers before sending to client
  }

  // Server grades the submission itself using the stored quiz (never trusts client-reported score).
  submitPuzzleResult(playerId, submittedAnswers, elapsedSeconds) {
    const p = this.players.get(playerId);
    if (!p || !p.puzzle.quiz) throw new Error('No active puzzle for this player.');

    let correct = 0;
    for (const q of p.puzzle.quiz) {
      const given = submittedAnswers.find(sa => sa.id === q.id);
      if (given && Number(given.value) === q.answer) correct++;
    }
    const withinTime = elapsedSeconds <= config.TIMERS.PUZZLE_SECONDS;
    const passed = correct >= config.PUZZLE.REQUIRED_CORRECT && withinTime;

    p.puzzle.solved = passed;
    p.puzzle.quiz = null; // consumed

    if (passed) {
      if (p.originalRoleAtElimination === ROLES.VILLAGER) {
        this.doctorExtraSaveActive = true;
        this._logPublic(`${p.name} solved the puzzle! The Doctor gains an extra save for the next Night.`);
      } else if (p.originalRoleAtElimination === ROLES.MAFIA) {
        this.daggerHolders.set(playerId, { used: false, expiresAfterRound: this.round + 1 });
        this._logPublic(`${p.name} solved the puzzle and forged a dagger to bestow on a living player.`);
      }
    } else {
      this._logPublic(`${p.name} attempted the puzzle but did not earn a reward (${correct}/${config.PUZZLE.QUESTION_COUNT}, ${elapsedSeconds}s).`);
    }

    return { correct, total: config.PUZZLE.QUESTION_COUNT, withinTime, passed };
  }

  bestowDagger(fromPlayerId, toPlayerId) {
    const holder = this.daggerHolders.get(fromPlayerId);
    if (!holder || holder.used) throw new Error('No unused dagger available.');
    if (holder.expiresAfterRound < this.round) throw new Error('This dagger has expired.');
    const target = this.players.get(toPlayerId);
    if (!target || !target.alive) throw new Error('Dagger must be given to a living player.');
    holder.used = true;
    this.doubleVoteHolder = toPlayerId;
    this._logPublic(`A dagger was bestowed in secret... someone's vote will count double today.`);
    return true;
  }

  // ---------- Feed / serialization ----------

  _logPublic(text) {
    this.publicFeed.push({ ts: Date.now(), text });
    if (this.publicFeed.length > 200) this.publicFeed.shift();
  }

  aliveCountsByFaction() {
    const alive = Array.from(this.players.values()).filter(p => p.alive);
    return {
      mafia: alive.filter(p => p.role === ROLES.MAFIA).length,
      town: alive.filter(p => p.role !== ROLES.MAFIA).length,
      total: alive.length
    };
  }

  // Public view: safe for everyone, including spectators. No roles, no tokens, no vote-by-whom.
  getPublicState() {
    return {
      phase: this.phase,
      round: this.round,
      started: this.started,
      winner: this.winner,
      playerCount: this.players.size,
      maxPlayers: config.MAX_PLAYERS,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        eliminatedRound: p.eliminatedRound,
        isDetectiveNow: p.isDetectiveNow
      })),
      voteCounts: this.phase === 'day' ? this.getVoteCounts() : [],
      feed: this.publicFeed.slice(-50),
      scoreboard: Array.from(this.players.values())
        .filter(p => !p.alive && p.puzzle.attempted)
        .map(p => ({ name: p.name, solved: p.puzzle.solved }))
    };
  }

  // Private view: only this player's own secrets (role, token, puzzle, dagger).
  getPrivateStateFor(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      token: p.token,
      role: p.role,
      alive: p.alive,
      isDetectiveNow: p.isDetectiveNow,
      puzzle: {
        eligible: p.puzzle.eligible,
        attempted: p.puzzle.attempted,
        solved: p.puzzle.solved,
        hasActiveQuiz: !!p.puzzle.quiz
      },
      hasDagger: this.daggerHolders.has(p.id) && !this.daggerHolders.get(p.id).used,
      doctorExtraSaveActive: p.role === ROLES.DOCTOR ? this.doctorExtraSaveActive : undefined,
      isMafia: p.role === ROLES.MAFIA
    };
  }

  livingMafiaIds() {
    return Array.from(this.players.values())
      .filter(p => p.alive && p.role === ROLES.MAFIA)
      .map(p => p.id);
  }
}

module.exports = { GameState, ROLES };
