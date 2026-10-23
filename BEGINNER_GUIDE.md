# From Zero to Live: Your First Deploy (Beginner's Path)

You don't need to learn everything at once. There are only 4 steps between
you and a live link you can text to friends. No command line, no coding —
just clicking. Do them in order, one at a time.

**Words you'll see (plain English):**
- *Repo* = a folder stored on GitHub instead of your computer.
- *Deploy* = putting your game on a computer that's always on, so anyone
  can open it with a link.
- *Build* = the hosting company installing the pieces your game needs.
  It happens automatically.

---

## Step 1 — Get your game files (5 min)

1. Download the `dice-dash-12000.zip` file from your chat with Muse.
2. Unzip it (on Android: open the Files app, tap the zip → Extract;
   on a computer: right-click → Extract All).
3. You should see folders: `frontend/`, `server/`, plus a few guides.
   That's your whole game. Keep this folder safe.

✅ Done when: you can see the `frontend` and `server` folders.

## Step 2 — Put the files on GitHub (10 min)

GitHub is free storage for code that the hosting company can read.

1. Go to github.com and create a free account.
2. Click the **+** (top right) → **New repository**.
3. Name it `dice-dash`, leave everything else default, click
   **Create repository**.
4. On the new page, click **"uploading an existing file"**.
5. Drag in everything from your unzipped folder — the `frontend` folder,
   the `server` folder, and the `.md` guide files. (All of it, exactly as is.)
6. Click **Commit changes**.

✅ Done when: your repo page lists `frontend/`, `server/`, `DEPLOY.md`, etc.

## Step 3 — Deploy on Render (15 min, mostly waiting)

Render is the company that will run your game day and night. Free tier.

1. Go to render.com → **Get Started** → sign up **with GitHub**
   (one click, no new password).
2. Click **New +** → **Blueprint** → connect your `dice-dash` repo.
   (Blueprint reads the `render.yaml` file I made for you — it already
   knows the build and start commands.)
3. When it asks for the **Root Directory**, type: `server`
4. Click **Apply**. Now wait — the build takes ~5 minutes the first time.
   You'll see logs scroll by. That's normal.
5. When it says **Live**, Render gives you a URL like
   `https://dice-dash-xxxx.onrender.com`. **That's your game, on the internet.**

✅ Done when: opening that URL shows your Dice Dash login screen.

Note: the free tier "sleeps" after 15 minutes of nobody playing. The first
visit after sleep takes ~30 seconds to wake up. Totally normal.

## Step 4 — Play your first real online game (5 min)

1. Open your Render URL on your phone.
2. **Sign up** (pick a username + password).
3. Tap **Create Room** → you'll get a 4-letter code.
4. Open the same URL on another device (or send it to a friend),
   sign up there, tap **Join Room**, enter the code.
5. The room host taps **Start Game**. Highest roll-off roll goes first.
6. Tap dice to select them, **Keep Selected**, **Roll Dice**, **Bank Score**.

✅ Done when: two players just finished a game together, online.

---

## What comes after (later, with me)

- **Play Store:** a free tool (PWABuilder) turns your live URL into an
  Android app package. I'll walk you through it when your URL is live.
- **Monetization:** ads + "remove ads" purchase come after players arrive.
- **App Store (iPhone):** needs a Mac or cloud build service — we'll cross
  that bridge after Android.

One step at a time. Tell Muse the moment you finish Step 1 and we'll do
Step 2 together.
