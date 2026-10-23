'use strict';

/**
 * Progressive Farkle — server-authoritative game engine.
 * Implements Crystal's ruleset (see ../../rules.md).
 *
 * JUDGMENT CALLS (flagged to Crystal — easy to change):
 *  1. §6 vs §7 conflict: "activated extra dice score face x 100" vs the
 *     four/five-of-a-kind tables. The engine uses the TABLES as the total
 *     value for 4/5 of a kind (marginals: FOUR-THREE, FIVE-FOUR).
 *  2. Activated single 1s score 1000 each (per §6). Very strong — confirm.
 *  3. The doubles rule starts a NEW roll set (activation resets), same as
 *     AND ROLLING, since the player receives 6 fresh dice.
 *  4. Six of a kind accumulated across multiple keeps in one roll set is NOT
 *     an instant win — instant win requires all six in ONE roll of six dice.
 *  5. Straight / three-pairs must be kept all-at-once from a single fresh
 *     6-dice roll to score the combo. Keeping a scoring subset is allowed
 *     (combo broken).
 *  6. Final round: overtaking the leader requires beating them by 50+.
 *     Winner = leader after every remaining player has had their final turn.
 *  7. A player is NOT forced to keep every scoring die on a roll.
 */

const THREE_OAK = { 1: 1000, 2: 200, 3: 300, 4: 400, 5: 500, 6: 600 };
const FOUR_OAK  = { 1: 4000, 2: 800, 3: 1200, 4: 1600, 5: 2000, 6: 2400 };
const FIVE_OAK  = { 1: 5000, 2: 1000, 3: 1500, 4: 2000, 5: 2500, 6: 3000 };
const STRAIGHT_SCORE = 1500;
const THREE_PAIRS_SCORE = 1000;
const WIN_GOAL = 12000;
const BANK_MIN = 1000;
const OVERTAKE_MARGIN = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rollDie(game) {
  if (game.rng) return game.rng();
  return 1 + Math.floor(Math.random() * 6);
}

function countValues(dice) {
  const c = {};
  for (const v of dice) c[v] = (c[v] || 0) + 1;
  return c;
}

function isStraight(dice) {
  if (dice.length !== 6) return false;
  return [...dice].sort((a, b) => a - b).join('') === '123456';
}

function isThreePairs(dice) {
  if (dice.length !== 6) return false;
  const vals = Object.values(countValues(dice));
  return vals.length === 3 && vals.every(n => n === 2);
}

function allSame(dice) {
  return dice.length > 0 && dice.every(v => v === dice[0]);
}

/**
 * Total value of `count` kept dice of face `f` within a single roll set.
 * Tables are authoritative totals, so completing 3/4/5 of a kind always lands
 * exactly on the table value no matter how the dice were kept.
 */
function faceTotal(f, count) {
  if (count <= 0) return 0;
  if (count <= 2) {
    if (f === 1) return count * 100;
    if (f === 5) return count * 50;
    return 0;
  }
  if (count === 3) return THREE_OAK[f];
  if (count === 4) return FOUR_OAK[f];
  if (count === 5) return FIVE_OAK[f];
  // 6th+ die accumulated across keeps in one roll set (not an instant win):
  // fall back to the activated-single rate.
  return FIVE_OAK[f] + (count - 5) * (f === 1 ? 1000 : f * 100);
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------

function createGame(playerIds, options = {}) {
  if (!Array.isArray(playerIds) || playerIds.length < 2 || playerIds.length > 6) {
    throw new Error('game needs 2-6 players');
  }
  return {
    players: playerIds.map(id => ({ id, score: 0, hasEntered: false })),
    bankRule: options.bankRule === 'classic' ? 'classic' : 'house',
    current: 0,
    phase: 'rolloff', // rolloff -> play -> over
    turn: null,
    finalRound: null, // { leader, remaining: [playerIdx...] }
    winner: null,
    winReason: null,
    rng: options.rng || null,
  };
}

/** Roll-off: everyone rolls one die, highest starts, ties re-roll. */
function doRollOff(game) {
  if (game.phase !== 'rolloff') throw new Error('roll-off already done');
  let contenders = game.players.map((_, i) => i);
  const rounds = [];
  while (true) {
    const rolls = contenders.map(i => ({ player: i, value: rollDie(game) }));
    rounds.push(rolls);
    const max = Math.max(...rolls.map(r => r.value));
    contenders = rolls.filter(r => r.value === max).map(r => r.player);
    if (contenders.length === 1) break;
  }
  game.current = contenders[0];
  game.phase = 'play';
  startTurn(game);
  return { rounds, first: contenders[0] };
}

function startTurn(game) {
  game.turn = {
    diceRemaining: 6,
    rolled: [],      // dice currently on the table (unkept)
    counts: {},      // per-face kept counts, this roll set
    activated: {},    // faces activated this roll set
    turnTotal: 0,
    freshSix: false, // current table dice are a fresh roll of 6
    awaiting: 'roll',// roll -> keep -> decision -> roll ...
  };
}

// ---------------------------------------------------------------------------
// Turn actions
// ---------------------------------------------------------------------------

function hasScoringDie(game, dice) {
  const t = game.turn;
  if (dice.length === 6 && t.freshSix) {
    if (isStraight(dice) || isThreePairs(dice)) return true;
  }
  const dc = countValues(dice);
  for (const key of Object.keys(dc)) {
    const f = Number(key);
    if (f === 1 || f === 5) return true;
    if (t.activated[f]) return true;
    if ((t.counts[f] || 0) + dc[key] >= 3) return true;
  }
  return false;
}

function roll(game) {
  const t = game.turn;
  if (game.phase !== 'play' || !t) throw new Error('no active turn');
  if (t.awaiting !== 'roll' && t.awaiting !== 'decision') {
    throw new Error('cannot roll now');
  }
  const n = t.diceRemaining;
  const dice = [];
  for (let i = 0; i < n; i++) dice.push(rollDie(game));
  t.rolled = dice;
  t.freshSix = (n === 6);
  t.awaiting = 'keep';

  // Six of a kind in one roll of six dice = instant win.
  if (n === 6 && allSame(dice)) {
    game.phase = 'over';
    game.winner = game.current;
    game.winReason = 'sixOfAKind';
    game.turn = null;
    return { dice, instantWin: true };
  }

  if (!hasScoringDie(game, dice)) {
    const bustedPlayer = game.current;
    game.turn = null;
    nextTurn(game);
    return { dice, bust: true, bustedPlayer };
  }
  return { dice };
}

function keep(game, indices) {
  const t = game.turn;
  if (game.phase !== 'play' || !t) throw new Error('no active turn');
  if (t.awaiting !== 'keep') throw new Error('cannot keep now');
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error('must keep at least one die');
  }
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (!Number.isInteger(sorted[i]) || sorted[i] < 0 || sorted[i] >= t.rolled.length) {
      throw new Error('invalid die index');
    }
    if (i > 0 && sorted[i] === sorted[i - 1]) throw new Error('duplicate die index');
  }
  const selected = sorted.map(i => t.rolled[i]);
  const indexSet = new Set(sorted);

  let combo = null;
  let delta = 0;

  // Combo claim: all six fresh dice kept at once.
  if (t.freshSix && selected.length === 6) {
    if (isStraight(selected)) { combo = 'straight'; delta = STRAIGHT_SCORE; }
    else if (isThreePairs(selected)) { combo = 'threePairs'; delta = THREE_PAIRS_SCORE; }
  }

  if (!combo) {
    // Validate every selected face is scoring in the current context.
    // A face scores if it's a 1/5, already activated, or the kept dice
    // (previously kept this roll set + this selection) reach 3 of a kind.
    const selCounts = countValues(selected);
    for (const key of Object.keys(selCounts)) {
      const f = Number(key);
      const ok =
        f === 1 || f === 5 ||
        !!t.activated[f] ||
        (t.counts[f] || 0) + selCounts[key] >= 3;
      if (!ok) throw new Error(`die showing ${f} is not scoring`);
    }
    // Score = change in per-face totals.
    for (const key of Object.keys(selCounts)) {
      const f = Number(key);
      const before = t.counts[f] || 0;
      delta += faceTotal(f, before + selCounts[key]) - faceTotal(f, before);
    }
  }

  // Apply.
  if (!combo) {
    const selCounts = countValues(selected);
    for (const key of Object.keys(selCounts)) {
      const f = Number(key);
      t.counts[f] = (t.counts[f] || 0) + selCounts[key];
      if (t.counts[f] >= 3) t.activated[f] = true;
    }
  } else {
    // Combo consumed all six dice — mark everything scoring for hot-dice flow.
    for (const v of selected) {
      t.counts[v] = (t.counts[v] || 0) + 1;
      if (t.counts[v] >= 3) t.activated[v] = true;
    }
  }
  t.turnTotal += delta;

  const remaining = t.rolled.filter((_, i) => !indexSet.has(i));

  // AND ROLLING: every die scored — fresh six, new roll set, activation resets.
  if (remaining.length === 0) {
    resetRollSet(t);
    return { kept: selected, delta, combo, hotDice: true };
  }
  // Doubles rule: exactly 2 dice remain and they match — fresh six, new roll set.
  if (remaining.length === 2 && remaining[0] === remaining[1]) {
    resetRollSet(t);
    return { kept: selected, delta, combo, doubles: true };
  }

  t.diceRemaining = remaining.length;
  t.rolled = [];
  t.freshSix = false;
  t.awaiting = 'decision';
  return { kept: selected, delta, combo };
}

function resetRollSet(t) {
  t.counts = {};
  t.activated = {};
  t.diceRemaining = 6;
  t.rolled = [];
  t.freshSix = false;
  t.awaiting = 'roll';
}

function bankDiceNeeded(game) {
  return game.bankRule === 'classic' ? 2 : 1;
}

function canBank(game) {
  const t = game.turn;
  if (game.phase !== 'play' || !t || t.awaiting !== 'decision') return false;
  return t.turnTotal >= BANK_MIN && t.diceRemaining <= bankDiceNeeded(game);
}

function bank(game) {
  const t = game.turn;
  if (!canBank(game)) throw new Error('cannot bank now');
  const p = game.players[game.current];
  const banked = t.turnTotal;
  p.score += banked;
  p.hasEntered = true;

  if (!game.finalRound && p.score >= WIN_GOAL) {
    const order = [];
    for (let k = 1; k < game.players.length; k++) {
      order.push((game.current + k) % game.players.length);
    }
    game.finalRound = { leader: game.current, remaining: order };
  } else if (game.finalRound) {
    const fr = game.finalRound;
    if (p.score >= game.players[fr.leader].score + OVERTAKE_MARGIN) {
      fr.leader = game.current;
    }
  }

  game.turn = null;
  nextTurn(game);
  return { banked, score: p.score };
}

function nextTurn(game) {
  if (game.phase === 'over') return;
  if (game.finalRound) {
    const fr = game.finalRound;
    fr.remaining = fr.remaining.filter(i => i !== game.current);
    if (fr.remaining.length === 0) {
      game.phase = 'over';
      game.winner = fr.leader;
      game.winReason = 'finalRound';
      game.turn = null;
      return;
    }
    game.current = fr.remaining[0];
  } else {
    game.current = (game.current + 1) % game.players.length;
  }
  startTurn(game);
}

// ---------------------------------------------------------------------------
// Public state (safe to send to clients)
// ---------------------------------------------------------------------------

function publicState(game) {
  return {
    phase: game.phase,
    current: game.current,
    bankRule: game.bankRule,
    players: game.players.map(p => ({ id: p.id, score: p.score, hasEntered: p.hasEntered })),
    winner: game.winner,
    winReason: game.winReason,
    finalRound: game.finalRound
      ? { leader: game.finalRound.leader, remaining: [...game.finalRound.remaining] }
      : null,
    turn: game.turn
      ? {
          diceRemaining: game.turn.diceRemaining,
          rolled: [...game.turn.rolled],
          counts: { ...game.turn.counts },
          activated: { ...game.turn.activated },
          turnTotal: game.turn.turnTotal,
          awaiting: game.turn.awaiting,
          canBank: canBank(game),
          bankNeedsDice: bankDiceNeeded(game),
        }
      : null,
  };
}

module.exports = {
  createGame,
  doRollOff,
  startTurn,
  roll,
  keep,
  bank,
  canBank,
  nextTurn,
  publicState,
  // exported for tests
  faceTotal,
  isStraight,
  isThreePairs,
  allSame,
  countValues,
  constants: { THREE_OAK, FOUR_OAK, FIVE_OAK, STRAIGHT_SCORE, THREE_PAIRS_SCORE, WIN_GOAL, BANK_MIN, OVERTAKE_MARGIN },
};
