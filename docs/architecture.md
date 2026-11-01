# Architecture

Chrome Fever is a static web page. `index.html` holds the markup, `src/styles.css` the styles and `src/main.js` the whole game as a single ES module. There is no bundler, framework or server code.

## Dependencies

| Dependency | Version | Source | Used for |
|---|---|---|---|
| Three.js | 0.160.0 | cdnjs (core), jsDelivr (addons) | WebGL rendering |
| Three.js addons | 0.160.0 | jsDelivr | `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `ShaderPass`, `OutputPass`, `mergeGeometries` |
| Google Fonts | n/a | fonts.googleapis.com | Big Shoulders Display, Chakra Petch, Noto Sans JP |

The versions are pinned in the import map in `index.html`. To upgrade Three.js, change both URLs there and test post-processing, since addon APIs change between releases.

## Why one module

The game shares a lot of mutable state (player, enemies, timers, pools) between systems. ES module imports are read-only bindings, so splitting the file would require wrapping that state in objects first. Until that is worth the effort, `main.js` stays one file, organised into sections. Each section starts with a banner comment that says what it contains:

| Section | Responsibility |
|---|---|
| helpers & persistence | DOM shorthand, palette, maths helpers, seeded RNG, `store` |
| renderer | WebGL renderer, scene, camera, resize handling |
| materials & geometry | Anime toon shader patch, material factories, geometry cache, canvas textures |
| audio, music | Synthesized sound effects and the synthwave sequencer |
| world, static batching, smoke, map detail, rain | Building and animating the night market |
| post-processing | Ink outline pass, colour/FX pass, quality presets |
| particles | Pooled sparks, impact stars, ground rings |
| anime sprite characters | Canvas-drawn character sprites and their animation frames |
| characters, projectiles, debris | 3D rigs (drone, HYDRA-7), afterimages, bullet pools, debris, weapons |
| state, input, UI, run flow | Run state, controls, menus and the wave/upgrade cycle |
| abilities, spawning, collisions, combat | Gameplay rules |
| update | Per-frame simulation and enemy/boss AI |
| camera & player visuals, overlay, HUD | Presentation |
| loop | Main loop and start-up |

## Start-up

1. The module creates the renderer. Without WebGL it shows an error in the menu and stops.
2. It waits up to 2.5 s for the display and Japanese fonts, because signs and sprites are drawn into canvases with those fonts.
3. `buildWorld()` builds the market with a seeded RNG, so the layout is the same on every load, then merges static geometry.
4. `makeFrames()` pre-renders every sprite animation frame for each character type.
5. The state switches from `loading` to `menu` and the start button unlocks. The menu shows the city with an orbiting camera.

## Game states

`state` drives the whole loop:

| State | Meaning |
|---|---|
| `loading` | Building the world; start button disabled |
| `menu` | Title screen, attract camera |
| `play` | Simulation running |
| `pause` | Frozen, pause panel open |
| `upgrade` | Frozen, cyberware cards open after a wave |
| `dying` | Short slow-motion death sequence |
| `over` | Result screen |

## Main loop and time

`frame()` runs on every `requestAnimationFrame`:

1. It computes `rdt`, the real frame time, capped at 50 ms so a stalled tab does not cause huge steps.
2. In `play` it calls `update(rdt)`. The player moves in real time; enemies and enemy bullets use `dt = rdt × 0.2` while Overclock is active. Short hit-stop pauses skip the simulation entirely.
3. Unless paused, it advances effects, the world animation, rain, the player sprite and the camera.
4. It renders through the effect composer (or directly on the lowest quality), then draws the 2D overlay and updates the DOM HUD.

## Rendering

- **Toon shading:** `animeify()` patches `MeshToonMaterial` shaders for three-tone shading with halftone dots in the shadows and an optional magenta/cyan rim light.
- **Outlines:** small objects use inverted-hull outlines (`part()`, `OUTLINE`); the ink post pass adds depth-based silhouette lines across the whole frame.
- **Characters:** human characters are 2D billboard sprites drawn with Canvas 2D at start-up. The drone and the HYDRA-7 boss are 3D models built from primitives.
- **Post-processing:** ink pass, bloom (neon materials use HDR colours above 1 so they bloom), output pass, then the FX pass for chromatic aberration, Overclock hue shift, hurt tint, vignette, contrast grading and grain.
- **Overlay:** a second canvas (`#fx`) above WebGL draws damage numbers, wave banners, the boss bar, crosshair, radar and hit markers.

### Performance measures

- Static decoration is merged into one mesh per material (`addBatch()` and `flushBatches()`).
- Geometries are cached by size, materials for signs are cached by text and colour.
- Particles, rain, smoke, stars, rings, bullets, afterimages and debris use fixed pools and typed arrays.
- Rain only fills a 48 m box around the camera.
- Shadows are only enabled on the two highest presets.

### Quality presets

| Preset | Max pixel ratio | Bloom, ink, FX passes | Rain drops | Shadow map |
|---|---|---|---|---|
| ultra | 1.6 | Yes | 1,300 | 2048 |
| hoch | 1.4 | Yes | 1,100 | 1024 |
| mittel | 1.15 | Yes | 800 | Off |
| niedrig | 1.0 | No | 450 | Off |

Touch devices default to `mittel`, other devices to `ultra`.

## Collision

The arena is the square from `-A` to `A` (24 m) on the x/z plane. Stalls, crates, vending machines and other blockers are registered as axis-aligned boxes in `OBST`. Characters are circles pushed out of those boxes by `collide()`, which also returns the contact normal used for ricochets. Bullets are tested as segments against enemy hit spheres.

## Audio

All audio is generated with the Web Audio API. Sound effects combine oscillators with a shared white-noise buffer. The music is a four-bar synthwave loop at 112 BPM, scheduled about 120 ms ahead by a 25 ms timer. Drums play only during combat, and a low-pass filter muffles the music in menus, pause, upgrades and Overclock. The `AudioContext` is created on the first user gesture, as browsers require.

## Persistence

Settings and the best score are stored in `localStorage` through `store`, which falls back to defaults when storage is unavailable.

| Key | Value |
|---|---|
| `chromefever3d-best` | Best score |
| `chromefever3d-quality2` | Quality preset |
| `chromefever-muted` | All sound muted |
| `chromefever-music` | Music on |

## Accessibility

The game respects `prefers-reduced-motion`: screen shake is reduced to a quarter, speed lines are skipped and CSS animations are disabled. Buttons are real `<button>` elements with keyboard support, and the upgrade cards can be chosen with 1 to 3.
