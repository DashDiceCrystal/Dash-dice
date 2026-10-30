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
    players: room.players.map(p => ({ userId: p.userId, username: p.username, avatar: p.avatar || null })),
  };
}

function emitState(room, lastEvent = null) {
  io.to(room.code).emit('state', {
    room: roomInfo(room),
    game: room.game ? engine.publicState(room.game) : null,
    lastEvent,
  });
}

function describeEvent(type, game, actorName, detail) {
  return { type, actorName, detail, at: Date.now() };
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

  socket.on('setAvatar', ({ avatar } = {}) => {
    try {
      const room = getRoom();
      const p = room.players.find(p => p.userId === socket.user.id);
      if (!p) return;
      p.avatar = validAvatar(avatar);
      emitState(room);
    } catch (e) { /* not in a room: local choice already applied */ }
  });

  socket.on('startGame', (_, ack) => {
    try {
      const room = getRoom();
      requireSeat(room);
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
        room.players = room.players.filter(p => p.userId !== socket.user.id);
        socket.leave(room.code);
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
      currentCode = null;
      ack({ ok: true });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('disconnect', () => {
    // Keep it simple: treat like leaving (rejoin = new join).
    const room = currentCode && rooms.get(currentCode);
    if (room) {
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
