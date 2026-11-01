# Chrome Fever

A browser third-person shooter set in a rainy cyberpunk night market. You fight waves of gangers, drones, gunners and brutes with an SMG, a shotgun and a katana, slow time with Overclock, and pick a cyberware upgrade after each wave. Every fifth wave is a boss fight.

The game runs entirely in the browser with Three.js. There is no build step, no backend and no asset files: characters, textures, the city, sound effects and music are all generated in code at load time. The in-game text is German.

**Status:** playable prototype. Desktop (mouse and keyboard) and touch devices are supported.

## Run locally

Serve the repository root over HTTP and open it in a browser with WebGL:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from the file system does not work reliably, because the game is an ES module. An internet connection is required: Three.js loads from cdnjs/jsDelivr and the fonts from Google Fonts.

## Repository layout

| Path | Contents |
|---|---|
| `index.html` | Page markup: canvases, HUD, menus and the Three.js import map |
| `src/main.js` | The whole game as one ES module, split into commented sections |
| `src/styles.css` | HUD, menu and overlay styles |
| `docs/` | Technical documentation |

## Documentation

- [Gameplay and controls](docs/gameplay.md): controls, weapons, enemies, bosses, upgrades and scoring.
- [Architecture](docs/architecture.md): how `main.js` is organised, the game loop, rendering, audio and persistence.
- [Development](docs/development.md): running, testing and deploying the game, and where to change common things.
- [Contributing conventions](CONTRIBUTING.md)
