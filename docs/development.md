# Development

## Run locally

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. Any static file server works. Reload the page after editing; there is no build or watch step.

The browser needs WebGL and access to cdnjs.cloudflare.com, cdn.jsdelivr.net and fonts.googleapis.com. Without the fonts the game still runs with fallback fonts after a 2.5 s wait.

## Checks

There is no automated test suite. Before opening a pull request:

1. Check the module for syntax errors, undefined names and unused code, for example with ESLint:

   ```sh
   npx eslint@8 --no-eslintrc --env browser,es2022 \
     --parser-options ecmaVersion:2022,sourceType:module \
     --rule 'no-undef: error' --rule 'no-unused-vars: [warn, {args: none, caughtErrors: none}]' \
     src/main.js
   ```

2. Play at least one run in the browser with the developer console open and confirm there are no errors: start a run, switch through all three weapons, dash, use Overclock, clear a wave and pick an upgrade.
3. For rendering changes, try both the `ultra` and `niedrig` quality presets.
4. For input changes, also test with touch emulation in the browser's developer tools.

Record in the pull request which of these checks you actually ran.

## Deploy

The repository root is a complete static site. To publish it, serve the root directory from any static host, for example GitHub Pages with "Deploy from a branch" pointing at the root of `main`. No files need to be generated.

## Where to change common things

| Change | Location in `src/main.js` |
|---|---|
| Weapon stats | `WEAPONS` |
| Starting player stats | `stats` in `startRun()` |
| Cyberware cards | `UPG` |
| Enemy health, speed, damage, score | `TYPES` |
| Which enemies appear in which wave | `buildQueue()` |
| Wave pacing and boss waves | `startWave()` |
| Enemy and boss behaviour | `updateEnemies()`, `bossRazor()`, `bossHydra()` |
| Character look | `SPEC` and `drawChar()` |
| City layout | `buildWorld()` and `buildDetails()` |
| Quality presets | `QUALITY` |
| Sound effects | `sfx` |
| Music | `PROG`, `SPB` and `playStep()` |
| HUD and menu text | `index.html` and the German strings in `main.js` |
| HUD and menu styling | `src/styles.css` |

## Conventions

- Keep comments in English and keep the in-game text German.
- Keep the banner comment at the top of each section of `main.js` accurate when moving code.
- Give new top-level functions a short JSDoc comment that explains what they do, not how.
- Avoid per-frame allocation in update functions; reuse pools and the shared temporary vectors.
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for commit, documentation and file-placement rules.
