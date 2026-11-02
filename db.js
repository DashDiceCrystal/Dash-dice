'use strict';

/**
 * SQLite storage: accounts, sessions, persistent scores / levels.
 * Uses Node's built-in node:sqlite (no native dependencies).
 *
 * Levels: 1 level per 5 games played. Each level unlocks dice skins
 * (cosmetic). From level 4 up, players may also pick any die they have
 * unlocked on the dice page (chosen_skin); the pick never affects luck.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'farkle.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  total_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS game_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  played_at TEXT NOT NULL DEFAULT (datetime('now')),
  winner_username TEXT NOT NULL,
  win_reason TEXT NOT NULL DEFAULT '',
  player_count INTEGER NOT NULL DEFAULT 0,
  scores_json TEXT NOT NULL DEFAULT '[]'
);
`);

// Chosen dice skin arrived after the original schema, so older databases
// gain the column on boot instead of needing a rebuild.
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('chosen_skin')) {
  db.exec('ALTER TABLE users ADD COLUMN chosen_skin TEXT');
}

// All dice skins. Looks are cosmetic only — never luck. `css` is the
// client-side class; `bg` is the representative color used for
// table-contrast math. Bonus dice unlock alongside the ladder dice.
const SKINS = [
  { name: 'Classic Ivory', unlockLevel: 1, css: 'skin-0', bg: '#ffffff' },
  { name: 'Street Crimson', unlockLevel: 2, css: 'skin-1', bg: '#ffd9d9' },
  { name: 'Midnight', unlockLevel: 3, css: 'skin-2', bg: '#1c1c2a' },
  { name: 'Emerald', unlockLevel: 4, css: 'skin-3', bg: '#fff3c4' },
  { name: 'Camo', unlockLevel: 4, css: 'skin-8', bg: '#4a5d23' },
  { name: 'Golden', unlockLevel: 5, css: 'skin-4', bg: '#e8fbff' },
  { name: 'Neon Pink', unlockLevel: 5, css: 'skin-9', bg: '#ff2e88' },
  { name: 'Royal Purple', unlockLevel: 6, css: 'skin-5', bg: '#f3e8ff' },
  { name: 'Black Gold Marble', unlockLevel: 6, css: 'skin-10', bg: '#111111' },
  { name: 'Diamond', unlockLevel: 7, css: 'skin-6', bg: '#ffffff' },
  { name: 'Neon Blue', unlockLevel: 7, css: 'skin-11', bg: '#00e5ff' },
  { name: 'Cosmic', unlockLevel: 8, css: 'skin-7', bg: '#0f0c29' },
  { name: 'Neon Lime', unlockLevel: 8, css: 'skin-12', bg: '#b6ff00' },
  { name: 'Sunset Orange', unlockLevel: 9, css: 'skin-13', bg: '#ff7a00' },
  { name: 'Silver', unlockLevel: 10, css: 'skin-14', bg: '#c0c0c0' },
];

// The original level ladder, kept exactly: a player's level die never
// changes out from under them when bonus dice are added.
const LADDER_SKINS = [
  'Classic Ivory', 'Street Crimson', 'Midnight', 'Emerald',
  'Golden', 'Royal Purple', 'Diamond', 'Cosmic',
];

function skinByName(name) {
  return SKINS.find(s => s.name === name) || null;
}

/** Games needed to reach the next level (levels advance every 5 games). */
function gamesToNextLevel(gamesPlayed) {
  return 5 - (Math.max(0, gamesPlayed) % 5);
}

function levelForGames(games) {
  return 1 + Math.floor(Math.max(0, games) / 5);
}

function skinForLevel(level) {
  return LADDER_SKINS[Math.min(Math.max(level, 1) - 1, LADDER_SKINS.length - 1)];
}

// The die a player actually rolls with: their chosen die when set and
// unlocked, otherwise their level die.
function effectiveSkin(row, level) {
  const chosen = row.chosen_skin && skinByName(row.chosen_skin);
  if (chosen && level >= chosen.unlockLevel) return chosen.name;
  return skinForLevel(level);
}

function publicProfile(row) {
  const level = levelForGames(row.games_played);
  const next = SKINS.find(s => s.unlockLevel > level);
  return {
    id: row.id,
    username: row.username,
    gamesPlayed: row.games_played,
    wins: row.wins,
    totalPoints: row.total_points,
    level,
    diceSkin: effectiveSkin(row, level),
    chosenSkin: row.chosen_skin || null,
    gamesToNextLevel: gamesToNextLevel(row.games_played),
    nextSkin: next ? next.name : null,
  };
}

/**
 * Record a finished game. entries: [{userId, username, score}].
 */
function recordGameHistory(entries, winnerUsername, winReason) {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  db.prepare(
    'INSERT INTO game_history (winner_username, win_reason, player_count, scores_json) VALUES (?, ?, ?, ?)'
  ).run(winnerUsername, winReason || '', sorted.length, JSON.stringify(sorted));
}

function getRecentGames(limit = 10) {
  return db.prepare(
    'SELECT * FROM game_history ORDER BY id DESC LIMIT ?'
  ).all(limit).map(r => ({
    id: r.id,
    playedAt: r.played_at,
    winner: r.winner_username,
    winReason: r.win_reason,
    playerCount: r.player_count,
    scores: JSON.parse(r.scores_json),
  }));
}

function createUser(username, password) {
  const clean = String(username || '').trim();
  if (clean.length < 3 || clean.length > 20) throw new Error('username must be 3-20 characters');
  if (!/^[a-zA-Z0-9_]+$/.test(clean)) throw new Error('username: letters, numbers, underscore only');
  if (String(password || '').length < 6) throw new Error('password must be at least 6 characters');
  const pwHash = bcrypt.hashSync(password, 10);
  try {
    const info = db.prepare('INSERT INTO users (username, pw_hash) VALUES (?, ?)').run(clean, pwHash);
    return publicProfile(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('username is taken');
    throw e;
  }
}

function verifyUser(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!row || !bcrypt.compareSync(password || '', row.pw_hash)) {
    throw new Error('invalid username or password');
  }
  return row;
}

/** Pick a die on the dice page: only dice the player has unlocked. */
function setChosenSkin(userId, skinName) {
  const skin = skinByName(String(skinName || '').trim());
  if (!skin) throw new Error('unknown dice');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw new Error('user not found');
  const level = levelForGames(row.games_played);
  if (level < skin.unlockLevel) {
    throw new Error(`${skin.name} dice unlock at Level ${skin.unlockLevel}`);
  }
  db.prepare('UPDATE users SET chosen_skin = ? WHERE id = ?').run(skin.name, userId);
  return publicProfile(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(
    'SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?'
  ).get(token);
  return row ? publicProfile(row) : null;
}

function getUserRowById(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? publicProfile(row) : null;
}

/** Called when a game finishes. pointsByUserId: {userId: finalScore}. */
function recordGameResult(pointsByUserId, winnerUserId) {
  const update = db.prepare(
    'UPDATE users SET games_played = games_played + 1, total_points = total_points + ?, wins = wins + ? WHERE id = ?'
  );
  db.exec('BEGIN');
  try {
    for (const [userId, points] of Object.entries(pointsByUserId)) {
      update.run(points, Number(userId) === Number(winnerUserId) ? 1 : 0, userId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function leaderboard(limit = 20) {
  return db.prepare(
    'SELECT * FROM users ORDER BY wins DESC, total_points DESC LIMIT ?'
  ).all(limit).map(publicProfile);
}

module.exports = {
  createUser,
  verifyUser,
  createSession,
  getUserByToken,
  getUserRowById,
  recordGameResult,
  recordGameHistory,
  getRecentGames,
  leaderboard,
  levelForGames,
  skinForLevel,
  gamesToNextLevel,
  SKINS,
  setChosenSkin,
};
