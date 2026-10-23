# Play Store + App Store + Monetization

Your game is a web app, which is actually the fastest route to both stores —
one codebase, no rewrites. Here's the honest path.

## 0. Pick a name that isn't "Farkle" (important)

"Farkle" is a registered trademark (owned by PlayMonster/Patch Products).
Publishing an app called "Farkle" risks a takedown or a rejected listing.
Your own title already has the answer — ship it as **"Dice Dash 12,000"**
or **"Crystal's Dice Dash"**. The rules are yours; the brand should be too.

## 1. What you just got: PWA-ready

The app is now an installable Progressive Web App:
- `frontend/manifest.json` — name, icons, colors
- `frontend/sw.js` — offline app shell
- `frontend/icon-*.png` — store-quality icons (dice on felt, your theme)

Anyone can already "install" it from their phone browser (Add to Home Screen).
That works today, free, no store needed.

## 2. Google Play Store — the easy one

Use **PWABuilder** (pwabuilder.com):
1. Deploy the game to a public HTTPS URL (see `DEPLOY.md`).
2. Paste the URL into PWABuilder → it packages your PWA as an Android
   app (TWA — a Google-blessed wrapper, not a hack).
3. Download the `.aab` bundle, upload to the Play Console ($25 one-time fee).
4. Fill in the store listing (description, screenshots, the icon).

No code changes needed. This is the standard indie path.

## 3. Apple App Store — the harder one

Apple doesn't accept TWA-style wrappers the way Google does. The proven
route is **Capacitor** (capacitorjs.com), which wraps your web app in a real
native shell:

```bash
npm install @capacitor/core @capacitor/cli
npx cap init "Dice Dash" com.crystal.dicedash
npx cap add ios
npx cap add android
```

Then your same `frontend/` + `server/` client code runs inside the native app.
Two honest caveats:
- **Building for iOS requires a Mac** (Xcode). No Mac? Use a CI service like
  Codemagic or Appflow to build in the cloud.
- Apple rejects apps that feel like "just a website." Stack the deck: add
  haptics on dice rolls, push notifications ("your turn!"), and a native
  share sheet via Capacitor plugins. Your multiplayer game has real
  functionality, which helps a lot.
- Apple Developer Program: **$99/year**.

Realistic order: ship Play Store first (weeks), then iOS.

## 4. Monetization

For a dice game, the safe and proven mix:

- **Ads (AdMob).** Banner on the lobby, interstitial between games — never
  mid-turn. Via the Capacitor AdMob plugin when you wrap the app.
- **Remove Ads (one-time IAP).** The classic $2.99–$4.99 purchase.
- **Cosmetic IAPs.** Premium dice skins and table themes. This fits your
  level system perfectly — free skins from playing, fancier ones for sale.
- **Use RevenueCat** (revenuecat.com) for purchases — one integration that
  handles both Play Billing and Apple's IAP, free until you're making money.

**Stay cosmetic-only.** Never sell luck, better dice odds, or anything that
affects gameplay — especially in multiplayer. That's both a fairness issue
and a fast track to store policy trouble. Real-money betting is completely
off the table.

## 5. Your market read

You're right that the specific "progressive 10,000 to 12,000" variant is
absent from the stores while people search for it — that's a real niche,
and niches are where indie games win. Two things that decide it from here:
getting it in front of those searchers (store listing keywords like
"progressive farkle dice 10000 12000", a short gameplay video), and the
multiplayer — games people play *with their crew* spread themselves.

## Checklist

- [ ] Rename public branding to "Dice Dash 12,000" (code already uses it)
- [ ] Deploy to a public URL (`DEPLOY.md`)
- [ ] PWABuilder → Play Store ($25)
- [ ] Capacitor wrap → App Store ($99/yr, needs Mac or CI)
- [ ] AdMob + RevenueCat when downloads start coming
