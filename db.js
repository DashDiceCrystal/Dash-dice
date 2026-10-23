'use strict';

/**
 * SQLite storage: accounts, sessions, persistent scores / levels.
 * Uses Node's built-in node:sqlite (no native dependencies).
 *
 * Levels: 1 level per 5 games played. Each level unlocks a dice skin
 * (cosmetic). If Crystal wants levels to nudge luck instead, that is a
 * design decision with fairness implications for multiplayer — ask first.
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

const DICE_SKINS = [
  'Classic Ivory',  // level 1
  'Street Crimson', // level 2
  'Midnight',       // level 3
  'Emerald',        // level 4
  'Golden',         // level 5
  'Royal Purple',   // level 6
  'Diamond',        // level 7
  'Cosmic',         // level 8
];

/** Games needed to reach the next level (levels advance every 5 games). */
function gamesToNextLevel(gamesPlayed) {
  return 5 - (Math.max(0, gamesPlayed) % 5);
}

function levelForGames(games) {
  return 1 + Math.floor(Math.max(0, games) / 5);
}

function skinForLevel(level) {
  return DICE_SKINS[Math.min(level - 1, DICE_SKINS.length - 1)];
}

function publicProfile(row) {
  const level = levelForGames(row.games_played);
  const nextSkin = level < DICE_SKINS.length ? DICE_SKINS[level] : null;
  return {
    id: row.id,
    username: row.username,
    gamesPlayed: row.games_played,
    wins: row.wins,
    totalPoints: row.total_points,
    level,
    diceSkin: skinForLevel(level),
    gamesToNextLevel: gamesToNextLevel(row.games_played),
    nextSkin,
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
};
