'use strict';

/**
 * Progressive Farkle multiplayer server.
 *
 * - REST: register / login / profile / leaderboard
 * - Socket.IO: authenticated real-time rooms (2-6 players)
 * - The game engine is authoritative: dice are rolled server-side and every
 *   keep/bank is validated. Clients only send intents.
 *
 * Run:  npm install && npm start   (PORT env, default 3000)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./db');
const engine = require('./engine');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

function authFromHeader(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? db.getUserByToken(m[1]) : null;
}

app.post('/api/register', (req, res) => {
  try {
    const profile = db.createUser(req.body.username, req.body.password);
    const token = db.createSession(profile.id);
    res.json({ token, user: profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const row = db.verifyUser(req.body.username, req.body.password);
    const token = db.createSession(row.id);
    res.json({ token, user: db.getUserRowById(row.id) });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/me', (req, res) => {
  const user = authFromHeader(req);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  res.json({ user });
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: db.leaderboard() });
});

app.get('/api/history', (req, res) => {
  res.json({ games: db.getRecentGames() });
});

// Serve the client.
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// Socket.IO rooms
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const user = db.getUserByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('not authenticated'));
  socket.user = user;
  next();
});

const rooms = new Map(); // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Avatars: players pick one from this fixed set on the setup card; anything
// else is ignored so a client can't inject arbitrary text into player lists.
const AVATARS = ['😀','😎','🤠','🦁','🐶','🐱','🦊','🐼','🦄','👾','🤖','👽'];
function validAvatar(a) { return AVATARS.includes(a) ? a : null; }

function roomInfo(room) {
  return {
    code: room.code,
    bankRule: room.bankRule,
    hostId: room.hostId,
    started: !!room.game,
    solo: !!room.solo,
    players: room.players.map(p => ({ userId: p.userId, username: p.username, avatar: p.avatar || null })),
  };
}

function emitState(room, lastEvent = null) {
  io.to(room.code).emit('state', {
    room: roomInfo(room),
    game: room.game ? engine.publicState(room.game) : null,
    lastEvent,
  });
  scheduleBot(room);
}

function describeEvent(type, game, actorName, detail) {
  return { type, actorName, detail, at: Date.now() };
}

// ---------------------------------------------------------------------------
// Computer opponent (solo games)
// ---------------------------------------------------------------------------
// The computer is just another player id ('cpu') rolling the SAME server-side
// dice through the SAME engine calls as a human — same chances, no rigging.
// It plays a sensible casual game: keep every scoring die, bank whenever the
// rules allow (and, in the final round, only when banking overtakes the
// leader — otherwise it keeps rolling, since banking short of the lead
// cannot win). It can bust and lose like anyone else.
// Solo games are practice: they never touch the database (no levels, no
// history), so a solo win can't farm progress.
const BOT_ID = 'cpu';
const BOT_NAME = 'Computer';

// Which dice the computer keeps from the current roll: every die of a face
// that scores in the current context (1s, 5s, activated faces, or faces that
// reach 3 of a kind with dice already kept this roll set). Straight / three
// pairs on a fresh six are kept all at once for the combo. This mirrors the
// engine's own keep validation, so the selection is always legal.
function botKeepIndices(game) {
  const t = game.turn;
  const dice = t.rolled;
  if (t.freshSix && dice.length === 6 && (engine.isStraight(dice) || engine.isThreePairs(dice))) {
    return dice.map((_, i) => i);
  }
  const counts = engine.countValues(dice);
  const keep = [];
  for (const key of Object.keys(counts)) {
    const f = Number(key);
    const scores = f === 1 || f === 5 || !!t.activated[f] || (t.counts[f] || 0) + counts[key] >= 3;
    if (scores) dice.forEach((v, i) => { if (v === f) keep.push(i); });
  }
  return keep.sort((a, b) => a - b);
}

function botShouldBank(game) {
  if (!game.finalRound) return true;
  const leader = game.players[game.finalRound.leader];
  const bot = game.players[game.current];
  return bot.score + game.turn.turnTotal >= leader.score + 50;
}

// Schedule the computer's next move after a state change, if it is the
// computer's turn (or throw) and no move is already pending. One timer per
// room, so moves never double-fire.
function scheduleBot(room) {
  if (!room || !room.solo || !room.game || room.botTimer) return;
  const game = room.game;
  const botIdx = game.players.findIndex(p => p.id === BOT_ID);
  if (botIdx < 0) return;
  if (game.phase === 'rolloff') {
    if (!game.rolloff || !game.rolloff.contenders.includes(botIdx)) return;
    if (game.rolloff.rolls[botIdx] !== undefined) return;
    room.botTimer = setTimeout(() => { room.botTimer = null; doBotMove(room); }, 1000);
  } else if (game.phase === 'play') {
    if (!game.turn || game.players[game.current].id !== BOT_ID) return;
    const delay = game.turn.awaiting === 'keep' ? 700 : 900;
    room.botTimer = setTimeout(() => { room.botTimer = null; doBotMove(room); }, delay);
  }
}

function doBotMove(room) {
  if (rooms.get(room.code) !== room) return; // room deleted (player left)
  const game = room.game;
  if (!game) return;
  const botIdx = game.players.findIndex(p => p.id === BOT_ID);
  if (botIdx < 0) return;
  try {
    if (game.phase === 'rolloff') {
      if (!game.rolloff || !game.rolloff.contenders.includes(botIdx)) return;
      if (game.rolloff.rolls[botIdx] !== undefined) return;
      const value = engine.rollOffThrow(game, botIdx);
      const res = engine.resolveRollOff(game);
      if (res.done) {
        const firstName = room.players.find(p => p.userId === game.players[game.current].id).username;
        emitState(room, describeEvent('gameStarted', game, firstName, { first: firstName }));
      } else if (res.tied) {
        emitState(room, describeEvent('rolloffTie', game, BOT_NAME, { tied: res.tied }));
      } else {
        emitState(room, describeEvent('rolloffThrow', game, BOT_NAME, { player: botIdx, value }));
      }
      return;
    }
    if (game.phase !== 'play' || !game.turn) return;
    if (game.players[game.current].id !== BOT_ID) return;
    const t = game.turn;
    if (t.awaiting === 'keep') {
      const indices = botKeepIndices(game);
      if (indices.length === 0) return; // cannot happen: a keepable roll always has a scoring die
      const res = engine.keep(game, indices);
      if (res.hotDice) emitState(room, describeEvent('hotDice', game, BOT_NAME, { kept: res.kept, delta: res.delta, combo: res.combo }));
      else if (res.doubles) emitState(room, describeEvent('doubles', game, BOT_NAME, { kept: res.kept, delta: res.delta }));
      else emitState(room, describeEvent('kept', game, BOT_NAME, { kept: res.kept, delta: res.delta, combo: res.combo }));
      return;
    }
    if (t.awaiting === 'roll' || t.awaiting === 'decision') {
      if (t.awaiting === 'decision' && engine.canBank(game) && botShouldBank(game)) {
        const res = engine.bank(game);
        emitState(room, describeEvent(game.phase === 'over' ? 'gameOver' : 'banked', game, BOT_NAME, { banked: res.banked, score: res.score }));
        return;
      }
      const res = engine.roll(game);
      if (res.instantWin) emitState(room, describeEvent('instantWin', game, BOT_NAME, { dice: res.dice }));
      else if (res.bust) emitState(room, describeEvent('bust', game, BOT_NAME, { dice: res.dice }));
      else if (res.doubles) emitState(room, describeEvent('doubles', game, BOT_NAME, { dice: res.dice }));
      else emitState(room, describeEvent('rolled', game, BOT_NAME, { dice: res.dice }));
      return;
    }
  } catch (e) { console.error('bot move:', e.message); }
}

io.on('connection', (socket) => {
  let currentCode = null;
  const me = () => ({ userId: socket.user.id, username: socket.user.username });

  function getRoom() {
    const room = currentCode && rooms.get(currentCode);
    if (!room) throw new Error('not in a room');
    return room;
  }

  function requireSeat(room) {
    if (!room.players.some(p => p.userId === socket.user.id)) {
      throw new Error('not seated in this room');
    }
  }

  socket.on('createRoom', ({ bankRule, avatar } = {}, ack) => {
    try {
      if (currentCode) throw new Error('already in a room');
      const code = makeCode();
      const room = {
        code,
        bankRule: bankRule === 'classic' ? 'classic' : 'house',
        hostId: socket.user.id,
        players: [{ ...me(), socketId: socket.id, avatar: validAvatar(avatar) }],
        game: null,
      };
      rooms.set(code, room);
      currentCode = code;
      socket.join(code);
      ack({ ok: true, code });
      emitState(room, describeEvent('roomCreated', null, socket.user.username, { code }));
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('joinRoom', ({ code, avatar } = {}, ack) => {
    try {
      if (currentCode) throw new Error('already in a room');
      const room = rooms.get(String(code || '').toUpperCase());
      if (!room) throw new Error('room not found');
      if (room.solo) throw new Error('this is a solo game');
      if (room.game) throw new Error('game already started');
      if (room.players.length >= 6) throw new Error('room is full');
      if (room.players.some(p => p.userId === socket.user.id)) throw new Error('already in room');
      room.players.push({ ...me(), socketId: socket.id, avatar: validAvatar(avatar) });
      currentCode = room.code;
      socket.join(room.code);
      ack({ ok: true, code: room.code });
      emitState(room, describeEvent('playerJoined', null, socket.user.username, {}));
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  // Solo game against the computer: no room code to share, no waiting.
  // The game starts in the roll-off at once; the computer plays through the
  // bot driver (scheduleBot/doBotMove above).
  socket.on('solo', ({ bankRule, avatar } = {}, ack) => {
    try {
      if (currentCode) throw new Error('already in a room');
      const code = makeCode();
      const rule = bankRule === 'classic' ? 'classic' : 'house';
      const room = {
        code,
        bankRule: rule,
        hostId: socket.user.id,
        solo: true,
        players: [
          { ...me(), socketId: socket.id, avatar: validAvatar(avatar) },
          { userId: BOT_ID, username: BOT_NAME, socketId: null, avatar: '🤖', bot: true },
        ],
        game: engine.createGame([socket.user.id, BOT_ID], { bankRule: rule }),
        botTimer: null,
        abandonTimer: null,
      };
      rooms.set(code, room);
      currentCode = code;
      socket.join(code);
      ack({ ok: true, code });
      emitState(room, describeEvent('rolloffStarted', room.game, socket.user.username, { solo: true }));
    } catch (e) { ack({ ok: false, error: e.message }); }
  });
  // the server forgot this socket's room, so a player already in the game
  // must be able to come back and catch up instead of tapping on a stale screen.
  // Rejoin after a dropped connection (e.g. the tab went to the background):
  // the server forgot this socket's room, so a player already in the game
  // must be able to come back and catch up instead of tapping on a stale screen.
  socket.on('rejoin', ({ code, avatar } = {}, ack) => {
    try {
      const r = rooms.get(String(code || '').toUpperCase());
      if (!r) throw new Error('room not found');
      if (r.abandonTimer) { clearTimeout(r.abandonTimer); r.abandonTimer = null; }
      const inGame = r.game && r.game.players.some(p => p.id === socket.user.id);
      let player = r.players.find(p => p.userId === socket.user.id);
      if (!player && !inGame) throw new Error('not in this room');
      if (!player) r.players.push({ ...me(), socketId: socket.id, avatar: validAvatar(avatar) });
      else player.socketId = socket.id;
      currentCode = r.code;
      socket.join(r.code);
      ack({ ok: true });
      emitState(r, describeEvent('playerRejoined', r.game, socket.user.username, {}));
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('setAvatar', ({ avatar } = {}) => {
    try {
      const room = getRoom();
      const p = room.players.find(p => p.userId === socket.user.id);
      if (!p) return;
      p.avatar = validAvatar(avatar);
      emitState(room);
    } catch (e) { /* not in a room: local choice already applied */ }
  });

  // Taunts: preset phrases, emoji reactions, and short custom comments.
  // Broadcast as their own event (not game state) so they never disturb the
  // game; everyone in the room sees a speech bubble. One taunt per player
  // per 2 seconds so nobody can flood the table.
  const TAUNT_PHRASES = [
    "you're burnt", 'run it back', 'haha', 'my turn', 'dice are loaded',
    "it's gettin' heavy", 'no more', 'rolling', 'All money',
    'get yo kids out the street', "gud lookin' out", 'awe', 'Sweet', 'YES',
    'fuck', "that's bullshit", "oops, didn't mean to take your dice",
  ];
  const TAUNT_EMOJIS = ['😊', '😠', '😢', '😨', '🤬', '😬'];
  let lastTauntAt = 0;
  socket.on('taunt', ({ kind, text } = {}) => {
    try {
      const room = getRoom();
      const now = Date.now();
      if (now - lastTauntAt < 2000) return;
      let clean = null;
      if (kind === 'phrase' && TAUNT_PHRASES.includes(text)) clean = text;
      else if (kind === 'emoji' && TAUNT_EMOJIS.includes(text)) clean = text;
      else if (kind === 'comment' && typeof text === 'string') {
        const t = text.trim();
        if (t.length >= 1 && t.length <= 120) clean = t;
      }
      if (clean === null) return;
      lastTauntAt = now;
      const p = room.players.find(p => p.userId === socket.user.id);
      io.to(room.code).emit('taunt', {
        userId: socket.user.id,
        username: socket.user.username,
        avatar: p ? p.avatar : null,
        kind, text: clean, at: now,
      });
    } catch (e) { /* not in a room: nothing to taunt in */ }
  });

  socket.on('startGame', (_, ack) => {
    try {
      const room = getRoom();
      requireSeat(room);
      if (room.solo) throw new Error('solo game already running');
      if (room.hostId !== socket.user.id) throw new Error('only the host can start');
      if (room.players.length < 2) throw new Error('need at least 2 players');
      const game = engine.createGame(room.players.map(p => p.userId), { bankRule: room.bankRule });
      room.game = game;
      ack({ ok: true });
      emitState(room, describeEvent('rolloffStarted', game, socket.user.username, {}));
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('rolloffThrow', (_, ack) => {
    try {
      const room = getRoom();
      requireSeat(room);
      const game = room.game;
      if (!game || game.phase !== 'rolloff') throw new Error('roll-off is not running');
      const playerIdx = game.players.findIndex(p => p.id === socket.user.id);
      if (playerIdx < 0) throw new Error('not in this game');
      const value = engine.rollOffThrow(game, playerIdx);
      const res = engine.resolveRollOff(game);
      ack({ ok: true, value });
      if (res.done) {
        const firstName = room.players.find(p => p.userId === game.players[game.current].id).username;
        emitState(room, describeEvent('gameStarted', game, firstName, { first: firstName }));
      } else if (res.tied) {
        emitState(room, describeEvent('rolloffTie', game, socket.user.username, { tied: res.tied }));
      } else {
        emitState(room, describeEvent('rolloffThrow', game, socket.user.username, { player: playerIdx, value }));
      }
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  function guardTurn(room) {
    requireSeat(room);
    if (!room.game || room.game.phase !== 'play') throw new Error('no game in progress');
    const game = room.game;
    const currentUserId = game.players[game.current].id;
    if (currentUserId !== socket.user.id) throw new Error('not your turn');
    return game;
  }

  function afterAction(room, game, event) {
    // Solo games are practice: never persist scores or history.
    if (room.solo) { emitState(room, event); return; }
    // Persist scores + history when the game ends.
    if (game.phase === 'over') {
      const points = {};
      const entries = [];
      for (const p of game.players) {
        points[p.id] = p.score;
        const rp = room.players.find(r => r.userId === p.id);
        entries.push({ userId: p.id, username: rp ? rp.username : 'Player', score: p.score });
      }
      const winnerId = game.players[game.winner].id;
      const winnerEntry = entries.find(e => e.userId === winnerId);
      try {
        db.recordGameResult(points, winnerId);
        db.recordGameHistory(entries, winnerEntry ? winnerEntry.username : '?', game.winReason);
      } catch (e) { console.error('record game:', e.message); }
      // Refresh profiles (levels may have changed).
      for (const p of room.players) {
        const fresh = db.getUserRowById(p.userId);
        if (fresh) p.username = fresh.username;
      }
    }
    emitState(room, event);
  }

  socket.on('roll', (_, ack) => {
    try {
      const room = getRoom();
      const game = guardTurn(room);
      const res = engine.roll(game);
      ack({ ok: true, rolled: res.dice });
      const name = socket.user.username;
      if (res.instantWin) {
        afterAction(room, game, describeEvent('instantWin', game, name, { dice: res.dice }));
      } else if (res.bust) {
        afterAction(room, game, describeEvent('bust', game, name, { dice: res.dice }));
      } else if (res.doubles) {
        emitState(room, describeEvent('doubles', game, name, { dice: res.dice }));
      } else {
        emitState(room, describeEvent('rolled', game, name, { dice: res.dice }));
      }
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('keep', ({ indices } = {}, ack) => {
    try {
      const room = getRoom();
      const game = guardTurn(room);
      const res = engine.keep(game, indices);
      ack({ ok: true, kept: res.kept, delta: res.delta });
      const name = socket.user.username;
      if (res.hotDice) {
        emitState(room, describeEvent('hotDice', game, name, { kept: res.kept, delta: res.delta, combo: res.combo }));
      } else if (res.doubles) {
        emitState(room, describeEvent('doubles', game, name, { kept: res.kept, delta: res.delta }));
      } else {
        emitState(room, describeEvent('kept', game, name, { kept: res.kept, delta: res.delta, combo: res.combo }));
      }
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('bank', (_, ack) => {
    try {
      const room = getRoom();
      const game = guardTurn(room);
      const res = engine.bank(game);
      ack({ ok: true, banked: res.banked });
      afterAction(room, game, describeEvent(
        game.phase === 'over' ? 'gameOver' : 'banked',
        game, socket.user.username, { banked: res.banked, score: res.score }
      ));
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('rematch', (_, ack) => {
    try {
      const room = getRoom();
      requireSeat(room);
      if (room.hostId !== socket.user.id) throw new Error('only the host can start a rematch');
      if (!room.game || room.game.phase !== 'over') throw new Error('current game is not over yet');
      if (room.players.length < 2) throw new Error('need at least 2 players');
      const game = engine.createGame(room.players.map(p => p.userId), { bankRule: room.bankRule });
      room.game = game;
      ack({ ok: true });
      emitState(room, describeEvent('rolloffStarted', game, socket.user.username, { rematch: true }));
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('leaveRoom', (_, ack) => {
    try {
      const room = currentCode && rooms.get(currentCode);
      if (room) {
        socket.leave(room.code);
        if (room.solo) {
          // Leaving a solo game ends it at once: nobody else is in it.
          if (room.botTimer) clearTimeout(room.botTimer);
          if (room.abandonTimer) clearTimeout(room.abandonTimer);
          rooms.delete(room.code);
        } else {
        room.players = room.players.filter(p => p.userId !== socket.user.id);
        if (room.players.length === 0) {
          rooms.delete(room.code);
        } else {
          if (room.hostId === socket.user.id) room.hostId = room.players[0].userId;
          // If they leave mid-roll-off, drop them from the throwers; a lone
          // remaining thrower wins outright so the game never stalls.
          if (room.game && room.game.phase === 'rolloff' && room.game.rolloff) {
            const g = room.game;
            const idx = g.players.findIndex(p => p.id === socket.user.id);
            if (idx >= 0) {
              g.rolloff.contenders = g.rolloff.contenders.filter(i => i !== idx);
              delete g.rolloff.rolls[idx];
              if (g.rolloff.contenders.length === 1) {
                g.current = g.rolloff.contenders[0];
                g.phase = 'play';
                g.rolloff = null;
                engine.startTurn(g);
              } else if (g.rolloff.contenders.length > 1) {
                engine.resolveRollOff(g);
              }
            }
          }
          // If their turn is abandoned mid-game, just pass it on.
          if (room.game && room.game.phase === 'play' &&
              room.game.players[room.game.current].id === socket.user.id) {
            room.game.turn = null;
            engine.nextTurn(room.game);
          }
          emitState(room, describeEvent('playerLeft', room.game, socket.user.username, {}));
        }
        }
      }
      currentCode = null;
      ack({ ok: true });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('disconnect', () => {
    // Keep it simple: treat like leaving (rejoin = new join).
    const room = currentCode && rooms.get(currentCode);
    if (room) {
      if (room.solo) {
        // Dropped connection in a solo game: keep the game so the player can
        // rejoin (same fix as multiplayer rejoin); delete it after 5 idle
        // minutes if they never come back. The computer keeps playing its
        // own turns meanwhile, and waits on the human's turns.
        if (room.abandonTimer) clearTimeout(room.abandonTimer);
        room.abandonTimer = setTimeout(() => {
          if (room.botTimer) clearTimeout(room.botTimer);
          rooms.delete(room.code);
        }, 5 * 60 * 1000);
        currentCode = null;
        return;
      }
      room.players = room.players.filter(p => p.userId !== socket.user.id);
      if (room.players.length === 0) {
        rooms.delete(room.code);
      } else {
        if (room.hostId === socket.user.id) room.hostId = room.players[0].userId;
        // If they leave mid-roll-off, drop them from the throwers; a lone
        // remaining thrower wins outright so the game never stalls.
        if (room.game && room.game.phase === 'rolloff' && room.game.rolloff) {
          const g = room.game;
          const idx = g.players.findIndex(p => p.id === socket.user.id);
          if (idx >= 0) {
            g.rolloff.contenders = g.rolloff.contenders.filter(i => i !== idx);
            delete g.rolloff.rolls[idx];
            if (g.rolloff.contenders.length === 1) {
              g.current = g.rolloff.contenders[0];
              g.phase = 'play';
              g.rolloff = null;
              engine.startTurn(g);
            } else if (g.rolloff.contenders.length > 1) {
              engine.resolveRollOff(g);
            }
          }
        }
        if (room.game && room.game.phase === 'play' &&
            room.game.players[room.game.current].id === socket.user.id) {
          room.game.turn = null;
          engine.nextTurn(room.game);
        }
        emitState(room, describeEvent('playerLeft', room.game, socket.user.username, {}));
      }
    }
    currentCode = null;
  });
});

server.listen(PORT, () => {
  console.log(`Farkle server listening on port ${PORT}`);
});
