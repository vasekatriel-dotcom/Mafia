// server/index.js
// Express serves the static frontend; Socket.io drives all realtime gameplay.
// The GameState instance is the single source of truth -- sockets only
// translate client intents into GameState method calls and validate that
// the caller is allowed to perform the action (e.g. only Mafia sockets are
// admitted into the 'mafia' room; the room membership itself gatekeeps the
// private Mafia chat).

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { GameState, ROLES } = require('./gameState');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const game = new GameState();

// socket.id -> playerId, so we can find "who is this connection" quickly.
const socketToPlayer = new Map();
let lobbyHostId = null; // first player to join, pre-game admin
let dayTimer = null;
let nightTimer = null;

function clearTimers() {
  if (dayTimer) { clearTimeout(dayTimer); dayTimer = null; }
  if (nightTimer) { clearTimeout(nightTimer); nightTimer = null; }
}

function broadcastState() {
  io.emit('state:public', game.getPublicState());
  for (const p of game.players.values()) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('state:private', game.getPrivateStateFor(p.id));
    }
  }
  io.emit('lobby:host', { hostId: lobbyHostId });
}

function isNarrator(playerId) {
  const p = game.players.get(playerId);
  return !!p && p.role === ROLES.NARRATOR;
}

function isAdmin(playerId) {
  // Pre-game: the lobby host. In-game: the Narrator (per spec's host control panel).
  return playerId === lobbyHostId || isNarrator(playerId);
}

function syncMafiaRoom() {
  // Rebuild the 'mafia' room membership from current living mafia every time
  // roles are dealt or someone dies, so eliminated/former mafia lose access.
  for (const [sockId, sock] of io.sockets.sockets) {
    sock.leave('mafia');
  }
  for (const playerId of game.livingMafiaIds()) {
    const p = game.players.get(playerId);
    if (p && p.socketId) {
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) sock.join('mafia');
    }
  }
}

function scheduleDayTimer() {
  clearTimers();
  const ms = config.TIMERS.VOTING_SECONDS * 1000;
  io.emit('phase:timer', { endsAt: Date.now() + ms, phase: 'day' });
  dayTimer = setTimeout(() => {
    try { resolveDayEnd(); } catch (e) { /* no-op if already resolved */ }
  }, ms);
}

function scheduleNightTimer() {
  clearTimers();
  const ms = config.TIMERS.NIGHT_SECONDS * 1000;
  io.emit('phase:timer', { endsAt: Date.now() + ms, phase: 'night' });
  nightTimer = setTimeout(() => {
    try { resolveNightEnd(); } catch (e) { /* no-op if already resolved */ }
  }, ms);
}

function resolveDayEnd() {
  if (game.phase !== 'day') return;
  const result = game.endDayPhase();
  syncMafiaRoom();
  broadcastState();
  if (result.winner) {
    io.emit('game:over', { winner: result.winner });
    clearTimers();
  } else {
    scheduleNightTimer();
  }
}

function resolveNightEnd() {
  if (game.phase !== 'night') return;
  const result = game.endNightPhase();
  syncMafiaRoom();
  broadcastState();
  if (result.winner) {
    io.emit('game:over', { winner: result.winner });
    clearTimers();
  } else {
    scheduleDayTimer();
  }
}

io.on('connection', (socket) => {
  socket.on('lobby:join', (_payload, cb) => {
    try {
      const player = game.addPlayer(socket.id);
      socketToPlayer.set(socket.id, player.id);
      if (!lobbyHostId) lobbyHostId = player.id;
      socket.join('spectators'); // everyone starts as a spectator of the public feed
      cb && cb({ ok: true, playerId: player.id, token: player.token });
      broadcastState();
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('lobby:rejoin', ({ token } = {}, cb) => {
    const player = game.reconnectByToken(token, socket.id);
    if (!player) return cb && cb({ ok: false, error: 'Unknown or expired token.' });
    socketToPlayer.set(socket.id, player.id);
    if (player.role === ROLES.MAFIA && player.alive) socket.join('mafia');
    cb && cb({ ok: true, playerId: player.id, token: player.token });
    broadcastState();
  });

  socket.on('lobby:start', (_payload, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      if (!isAdmin(playerId)) throw new Error('Only the host may start the game.');
      game.startGame();
      syncMafiaRoom();
      broadcastState();
      scheduleDayTimer();
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('lobby:kick', ({ targetId } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      if (!isAdmin(playerId)) throw new Error('Only the host may kick players.');
      if (game.started) throw new Error('Cannot kick after the game has started.');
      game.removePlayer(targetId);
      broadcastState();
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('vote:cast', ({ targetId } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      const counts = game.castVote(playerId, targetId);
      io.emit('state:public', game.getPublicState());
      cb && cb({ ok: true, counts });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('day:forceEnd', (_payload, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      if (!isAdmin(playerId)) throw new Error('Only the Narrator/host may force-end the phase.');
      resolveDayEnd();
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('mafia:vote', ({ targetId } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      const target = game.setMafiaVote(playerId, targetId);
      io.to('mafia').emit('mafia:targetUpdate', { targetId: target });
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('mafia:chat', ({ text } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    const p = game.players.get(playerId);
    if (!p || p.role !== ROLES.MAFIA || !p.alive) {
      return cb && cb({ ok: false, error: 'Only living Mafia may use this chat.' });
    }
    if (!text || !String(text).trim()) return cb && cb({ ok: false, error: 'Empty message.' });
    io.to('mafia').emit('mafia:chat', { from: p.name, text: String(text).slice(0, 500), ts: Date.now() });
    cb && cb({ ok: true });
  });

  socket.on('doctor:save', ({ targetIds } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      const saved = game.setDoctorSave(playerId, targetIds);
      cb && cb({ ok: true, saved });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('detective:investigate', ({ targetId } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      const result = game.setDetectiveInvestigate(playerId, targetId);
      cb && cb({ ok: true, result }); // private: only returned to the calling detective
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('night:forceEnd', (_payload, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      if (!isAdmin(playerId)) throw new Error('Only the Narrator/host may force-end the phase.');
      resolveNightEnd();
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('puzzle:request', (_payload, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      const questions = game.generatePuzzle(playerId);
      cb && cb({ ok: true, questions, timeLimitSeconds: config.TIMERS.PUZZLE_SECONDS });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('puzzle:submit', ({ answers, elapsedSeconds } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      const result = game.submitPuzzleResult(playerId, answers || [], Number(elapsedSeconds) || 9999);
      broadcastState();
      cb && cb({ ok: true, result });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('dagger:bestow', ({ targetId } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      game.bestowDagger(playerId, targetId);
      broadcastState();
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('spectator:chat', ({ text } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    const p = game.players.get(playerId);
    if (!p || p.alive) return cb && cb({ ok: false, error: 'Only eliminated players use the spectator chat.' });
    if (!text || !String(text).trim()) return cb && cb({ ok: false, error: 'Empty message.' });
    io.to('spectators').emit('spectator:chat', { from: p.name, text: String(text).slice(0, 500), ts: Date.now() });
    cb && cb({ ok: true });
  });

  socket.on('narrator:message', ({ text } = {}, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      if (!isNarrator(playerId)) throw new Error('Only the Narrator may narrate.');
      if (!text || !String(text).trim()) throw new Error('Empty message.');
      game._logPublic(`[Narrator] ${String(text).slice(0, 500)}`);
      broadcastState();
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('narrator:forceEndGame', (_payload, cb) => {
    const playerId = socketToPlayer.get(socket.id);
    try {
      if (!isAdmin(playerId)) throw new Error('Only the Narrator/host may end the game.');
      game.phase = 'ended';
      game.winner = game.winner || 'aborted';
      clearTimers();
      io.emit('game:over', { winner: game.winner });
      broadcastState();
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    const playerId = socketToPlayer.get(socket.id);
    if (playerId) {
      game.removePlayer(playerId);
      socketToPlayer.delete(socket.id);
      broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mafia Live server running on http://localhost:${PORT}`);
  if (config.USE_REDIS) {
    console.log('USE_REDIS is true but Redis wiring is not implemented in this demo -- see README "Production notes".');
  }
});
