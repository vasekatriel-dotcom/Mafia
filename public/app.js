// public/app.js
// All game logic lives server-side; this file only renders state and
// forwards user intents over Socket.io. No secret data (other players'
// roles, votes-by-whom) is ever computed or stored client-side.

const socket = io();

let myId = null;
let myToken = localStorage.getItem('mafia_token') || null;
let publicState = null;
let privateState = null;
let phaseEndsAt = null;
let soundOn = true;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showView(id) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#${id}`).classList.remove('hidden');
}

function fmtTime(sec) {
  if (sec == null || sec < 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

setInterval(() => {
  if (phaseEndsAt) {
    const remaining = Math.max(0, (phaseEndsAt - Date.now()) / 1000);
    $('#timer').textContent = fmtTime(remaining);
  }
}, 500);

// ---------- Join / rejoin ----------

$('#btnJoin').addEventListener('click', () => {
  socket.emit('lobby:join', {}, (res) => {
    if (!res.ok) return alert(res.error);
    myId = res.playerId;
    myToken = res.token;
    localStorage.setItem('mafia_token', myToken);
    alert(`Your secret code (save it!): ${myToken}`);
  });
});

$('#btnRejoin').addEventListener('click', (e) => {
  e.preventDefault();
  const token = myToken || prompt('Enter your secret code:');
  if (!token) return;
  socket.emit('lobby:rejoin', { token }, (res) => {
    if (!res.ok) return alert(res.error);
    myId = res.playerId;
    myToken = res.token;
    localStorage.setItem('mafia_token', myToken);
  });
});

// ---------- Lobby ----------

$('#btnStart').addEventListener('click', () => {
  socket.emit('lobby:start', {}, (res) => { if (!res.ok) alert(res.error); });
});

// ---------- Audio ----------

$('#audioToggle').addEventListener('click', () => {
  soundOn = !soundOn;
  $('#audioToggle').textContent = soundOn ? '🔊' : '🔇';
});

function playCue(name) {
  if (!soundOn) return;
  // Lightweight beep via WebAudio -- no external audio files required.
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = name === 'night' ? 220 : name === 'day' ? 440 : 660;
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) { /* audio not available */ }
}

// ---------- Tabs (mobile) ----------

$$('.tabbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tabbtn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    showView(btn.dataset.tab);
  });
});

// ---------- Socket state handlers ----------

socket.on('state:public', (state) => {
  const prevPhase = publicState && publicState.phase;
  publicState = state;
  if (prevPhase && prevPhase !== state.phase) {
    playCue(state.phase);
  }
  render();
});

socket.on('state:private', (state) => {
  privateState = state;
  render();
});

socket.on('lobby:host', ({ hostId }) => {
  window.__isHost = privateState && hostId === privateState.id;
  render();
});

socket.on('phase:timer', ({ endsAt }) => {
  phaseEndsAt = endsAt;
});

socket.on('mafia:chat', (msg) => appendChat('#mafiaChatLog', msg));
socket.on('spectator:chat', (msg) => {
  appendChat('#spectatorChatLog', msg);
});

socket.on('game:over', ({ winner }) => {
  showView('view-gameover');
  $('#tabbar').classList.add('hidden');
  const titles = {
    town: '🏆 The Town Wins!',
    mafia: '🔪 The Mafia Wins!',
    aborted: 'Game Ended'
  };
  $('#gameOverTitle').textContent = titles[winner] || 'Game Over';
  $('#gameOverBody').textContent = privateState
    ? `You were the ${privateState.role || 'a player'}.`
    : '';
});

function appendChat(sel, msg) {
  const log = $(sel);
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="from">${escapeHtml(msg.from)}:</span> ${escapeHtml(msg.text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---------- Master render ----------

function render() {
  if (!privateState && !publicState) return;

  // Which top-level view are we in?
  if (!myId) { showView('view-join'); return; }

  if (publicState && publicState.winner) {
    // game:over event already switches the view; nothing else to do.
  }

  if (publicState && !publicState.started) {
    renderLobby();
    showView('view-lobby');
    return;
  }

  $('#tabbar').classList.remove('hidden');

  if (privateState) {
    renderRoleCard();
  }

  const amAlive = privateState && privateState.alive;
  if (amAlive) {
    renderStage();
    if (!document.querySelector('.tabbtn.active[data-tab="view-role"]')) showView('view-stage');
  } else if (privateState) {
    renderSpectator();
    showView('view-spectator');
    $('#tabbar').classList.add('hidden');
  }

  if (publicState) {
    $('#phaseBadge').textContent = publicState.phase.toUpperCase();
  }
}

// ---------- Lobby rendering ----------

function renderLobby() {
  $('#lobbyCount').textContent = `(${publicState.playerCount}/${publicState.maxPlayers})`;
  const list = $('#lobbyList');
  list.innerHTML = '';
  publicState.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name;
    list.appendChild(li);
  });
  const isHost = window.__isHost;
  $('#btnStart').classList.toggle('hidden', !isHost);
  $('#lobbyHint').textContent = isHost
    ? 'You are the host. Start once everyone has joined (min. 5 players).'
    : 'Waiting for the host to start the game...';
}

// ---------- Role card ----------

const FLAVOR = {
  Mafia: 'Eliminate the town before they eliminate you. Coordinate secretly at Night.',
  Doctor: 'Choose one player to save each Night.',
  Narrator: 'You control phase flow and can narrate events to everyone.',
  Villager: 'Find the Mafia and vote them out by Day.',
  Detective: 'You may investigate one player tonight to learn if they are Mafia. This power lasts one round only.'
};

function renderRoleCard() {
  $('#myName').textContent = privateState.name;
  $('#myToken').textContent = privateState.token;
  $('#myRole').textContent = privateState.role || '(not yet assigned)';
  $('#roleFlavor').textContent = privateState.role ? FLAVOR[privateState.role] || '' : '';
}
$('#btnCopyToken').addEventListener('click', () => {
  navigator.clipboard && navigator.clipboard.writeText(privateState.token);
});

// ---------- Main stage ----------

function renderStage() {
  const counts = publicState.players.reduce((acc, p) => {
    if (p.alive) acc.alive++;
    return acc;
  }, { alive: 0 });
  $('#factionCounts').textContent = `${counts.alive} alive of ${publicState.playerCount}`;

  const isDay = publicState.phase === 'day';
  const isNight = publicState.phase === 'night';
  $('#dayPanel').classList.toggle('hidden', !isDay);
  $('#nightPanel').classList.toggle('hidden', !isNight);

  if (isDay) {
    $('#dayRound').textContent = publicState.round;
    renderVoteList();
  }
  if (isNight) {
    $('#nightRound').textContent = publicState.round;
    renderNightPanels();
  }

  const narratorPanel = $('#narratorPanel');
  narratorPanel.classList.toggle('hidden', privateState.role !== 'Narrator');

  renderFeed('#publicFeed');
}

function renderVoteList() {
  const list = $('#voteList');
  list.innerHTML = '';
  const myAliveTargets = publicState.players.filter(p => p.alive);
  const countsByTarget = new Map(publicState.voteCounts.map(v => [v.targetId, v.count]));
  myAliveTargets.forEach(p => {
    const li = document.createElement('li');
    const count = countsByTarget.get(p.id) || 0;
    li.innerHTML = `<span>${p.name} ${count ? `(${count} vote${count > 1 ? 's' : ''})` : ''}</span>`;
    if (p.id !== privateState.id) {
      const btn = document.createElement('button');
      btn.textContent = 'Vote';
      btn.addEventListener('click', () => {
        socket.emit('vote:cast', { targetId: p.id }, (res) => { if (!res.ok) alert(res.error); });
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  });
}

function renderNightPanels() {
  const role = privateState.role;
  const alivePlayers = publicState.players.filter(p => p.alive);

  $('#mafiaPanel').classList.toggle('hidden', role !== 'Mafia');
  $('#doctorPanel').classList.toggle('hidden', role !== 'Doctor');
  $('#detectivePanel').classList.toggle('hidden', role !== 'Detective');
  $('#waitingPanel').classList.toggle('hidden', ['Mafia', 'Doctor', 'Detective'].includes(role));

  if (role === 'Mafia') {
    const list = $('#mafiaTargetList');
    list.innerHTML = '';
    alivePlayers.filter(p => p.id !== privateState.id).forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.name}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Target';
      btn.addEventListener('click', () => socket.emit('mafia:vote', { targetId: p.id }));
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  if (role === 'Doctor') {
    $('#doctorExtraHint').textContent = privateState.doctorExtraSaveActive
      ? '(extra save active tonight — pick up to two)' : '';
    const list = $('#doctorTargetList');
    list.innerHTML = '';
    let picked = [];
    alivePlayers.forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.name}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Save';
      btn.addEventListener('click', () => {
        const max = privateState.doctorExtraSaveActive ? 2 : 1;
        picked = picked.includes(p.id) ? picked.filter(x => x !== p.id) : [...picked, p.id].slice(-max);
        socket.emit('doctor:save', { targetIds: picked });
        btn.textContent = picked.includes(p.id) ? '✓ Saved' : 'Save';
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  if (role === 'Detective') {
    const list = $('#detectiveTargetList');
    list.innerHTML = '';
    alivePlayers.filter(p => p.id !== privateState.id).forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.name}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Investigate';
      btn.addEventListener('click', () => {
        socket.emit('detective:investigate', { targetId: p.id }, (res) => {
          if (!res.ok) return alert(res.error);
          $('#detectiveResult').textContent = res.result.isMafia
            ? `${p.name} IS Mafia.` : `${p.name} is NOT Mafia.`;
        });
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }
}

$('#btnMafiaSend').addEventListener('click', sendMafiaChat);
$('#mafiaChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMafiaChat(); });
function sendMafiaChat() {
  const input = $('#mafiaChatInput');
  if (!input.value.trim()) return;
  socket.emit('mafia:chat', { text: input.value }, (res) => { if (!res.ok) alert(res.error); });
  input.value = '';
}

$('#btnForceEndDay').addEventListener('click', () => socket.emit('day:forceEnd', {}, r => !r.ok && alert(r.error)));
$('#btnForceEndNight').addEventListener('click', () => socket.emit('night:forceEnd', {}, r => !r.ok && alert(r.error)));
$('#btnForceEndGame').addEventListener('click', () => {
  if (confirm('End the game now?')) socket.emit('narrator:forceEndGame', {}, r => !r.ok && alert(r.error));
});
$('#btnNarratorSend').addEventListener('click', () => {
  const input = $('#narratorMsgInput');
  if (!input.value.trim()) return;
  socket.emit('narrator:message', { text: input.value }, (res) => { if (!res.ok) alert(res.error); });
  input.value = '';
});

function renderFeed(sel) {
  const log = $(sel);
  log.innerHTML = '';
  (publicState.feed || []).forEach(f => {
    const div = document.createElement('div');
    div.className = 'msg';
    div.textContent = f.text;
    log.appendChild(div);
  });
  log.scrollTop = log.scrollHeight;
}

// ---------- Spectator / eliminated ----------

function renderSpectator() {
  $('#daggerPanel').classList.toggle('hidden', !privateState.hasDagger);
  if (privateState.hasDagger) {
    const list = $('#daggerTargetList');
    list.innerHTML = '';
    publicState.players.filter(p => p.alive).forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.name}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Bestow dagger';
      btn.addEventListener('click', () => {
        if (confirm(`Give the dagger to ${p.name}? This doubles their vote next Day.`)) {
          socket.emit('dagger:bestow', { targetId: p.id }, (res) => { if (!res.ok) alert(res.error); });
        }
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  const pz = privateState.puzzle;
  const puzzlePanel = $('#puzzlePanel');
  puzzlePanel.classList.toggle('hidden', !pz.eligible);
  if (pz.eligible) {
    $('#btnStartPuzzle').classList.toggle('hidden', pz.attempted);
    $('#puzzleIntro').textContent = pz.attempted
      ? (pz.solved ? 'You solved it! Reward applied.' : 'You already attempted this puzzle.')
      : `Solve ${10}/${10} arithmetic questions within 30 seconds to earn a reward.`;
  }

  renderScoreboard();
  renderFeed('#publicFeedSpectator');
}

let puzzleStartTime = null;
let puzzleTickInterval = null;

$('#btnStartPuzzle').addEventListener('click', () => {
  socket.emit('puzzle:request', {}, (res) => {
    if (!res.ok) return alert(res.error);
    renderPuzzleForm(res.questions, res.timeLimitSeconds);
  });
});

function renderPuzzleForm(questions, timeLimitSeconds) {
  $('#puzzleQuizArea').classList.remove('hidden');
  $('#btnStartPuzzle').classList.add('hidden');
  const form = $('#puzzleForm');
  form.innerHTML = '';
  questions.forEach(q => {
    const div = document.createElement('div');
    div.className = 'q';
    div.innerHTML = `<span>${q.a} ${q.op} ${q.b} =</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.dataset.id = q.id;
    div.appendChild(input);
    form.appendChild(div);
  });

  puzzleStartTime = Date.now();
  const endsAt = puzzleStartTime + timeLimitSeconds * 1000;
  clearInterval(puzzleTickInterval);
  puzzleTickInterval = setInterval(() => {
    const remaining = Math.max(0, (endsAt - Date.now()) / 1000);
    $('#puzzleTimer').textContent = fmtTime(remaining);
    if (remaining <= 0) {
      clearInterval(puzzleTickInterval);
      submitPuzzle();
    }
  }, 200);
}

$('#btnSubmitPuzzle').addEventListener('click', submitPuzzle);

function submitPuzzle() {
  clearInterval(puzzleTickInterval);
  const answers = $$('#puzzleForm input').map(input => ({
    id: Number(input.dataset.id),
    value: input.value
  }));
  const elapsedSeconds = (Date.now() - puzzleStartTime) / 1000;
  socket.emit('puzzle:submit', { answers, elapsedSeconds }, (res) => {
    if (!res.ok) return alert(res.error);
    $('#puzzleQuizArea').classList.add('hidden');
    const r = res.result;
    $('#puzzleResult').textContent = r.passed
      ? `Success! ${r.correct}/${r.total} correct in time. Reward applied.`
      : `Not this time (${r.correct}/${r.total}, within time: ${r.withinTime}).`;
  });
}

function renderScoreboard() {
  const list = $('#scoreboardList');
  list.innerHTML = '';
  (publicState.scoreboard || []).forEach(s => {
    const li = document.createElement('li');
    li.textContent = `${s.name} — ${s.solved ? '✅ solved the puzzle' : '❌ did not solve'}`;
    list.appendChild(li);
  });
}

$('#btnSpectatorSend').addEventListener('click', sendSpectatorChat);
$('#spectatorChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendSpectatorChat(); });
function sendSpectatorChat() {
  const input = $('#spectatorChatInput');
  if (!input.value.trim()) return;
  socket.emit('spectator:chat', { text: input.value }, (res) => { if (!res.ok) alert(res.error); });
  input.value = '';
}
