# Getting your Farkle app online

Your game is two parts that deploy as one service:

- `server/` — Node.js + Express + Socket.IO (game rooms, accounts, levels)
- `frontend/` — the web client (served automatically by the server)

No native dependencies — it uses Node's built-in SQLite, so any Node 22+ host works.

## Option A: Render.com (recommended, free)

1. **Put the code on GitHub.**
   In the `farkle/` folder:
   ```bash
   git init
   git add .
   git commit -m "Progressive Farkle multiplayer"
   # create an empty repo on github.com, then:
   git remote add origin https://github.com/YOURNAME/farkle.git
   git push -u origin main
   ```
   (Push the whole `farkle/` folder — `server/`, `frontend/`, `rules.md`.)

2. **Create the web service.**
   - Go to [render.com](https://render.com) → New → Web Service → connect your repo.
   - Or use the blueprint: New → Blueprint → point at the repo (uses `render.yaml`).
   - Build command: `npm install` — run from the `server/` directory
     (set **Root Directory** to `server`).
   - Start command: `npm start`.

3. **Keep the database.**
   The free tier wipes files on redeploy, so the blueprint attaches a 1 GB
   persistent disk at `/data` and sets `DB_PATH=/data/farkle.db`.
   Without this, accounts and scores reset on every deploy.

4. **Open your URL.**
   Render gives you `https://your-app.onrender.com`. Share it — anyone who
   signs up can create a room and play. The free tier sleeps after inactivity;
   the first load takes ~30 seconds to wake up.

## Option B: Railway / Fly.io / a VPS

Same idea anywhere Node runs:

```bash
cd server
npm install
PORT=3000 DB_PATH=/data/farkle.db npm start
```

Make sure `DB_PATH` points at storage that survives restarts.

## Playing

1. Open the URL, sign up (username + password).
2. Create a room → share the 4-letter code with your crew (2–6 players).
3. Everyone joins, the host starts, highest roll-off goes first.
4. Scores, wins and levels are saved to each account. One level per 5 games,
   each unlocking a new dice skin.

## Housekeeping

- Run the engine tests anytime: `cd server && npm test` (22 tests).
- To change rules (banking, goal score, overtake margin), edit
  `server/game/engine.js` constants at the top — the tests will tell you if
  anything breaks.
- "Better dice" per level is currently cosmetic skins. If you want levels to
  affect luck, say so — it's a fairness decision for multiplayer.
