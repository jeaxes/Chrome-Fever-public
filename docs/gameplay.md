# Gameplay and controls

This guide describes the game as implemented in `src/main.js`. Numbers are base values before upgrades.

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Move | WASD or arrow keys | Drag on the left half of the screen (floating stick) |
| Look and aim | Mouse (click the game to capture the pointer) | Drag on the right half; light aim assist |
| Fire | Hold left mouse button | Fires while the right half is held |
| Dash | Shift | `DASH` button |
| Overclock | Space, Q, E or right mouse button | `OC` button |
| Switch weapon | 1, 2, 3 or mouse wheel | `WAFFE` button |
| Pause | Esc or P | `PAUSE` button |
| Pick upgrade | 1, 2, 3 or click | Tap a card |
| Start or restart | Enter | `Run starten` / `Nochmal` |

The game pauses automatically when the pointer lock is lost, the window loses focus or the tab is hidden.

## Run structure

1. A run starts at wave 1 with 100 HP.
2. Each wave spawns `min(60, 6 + 4 × wave)` enemies from the arena edges. Ground enemies drop in from the rooftops.
3. When the wave is cleared, the player heals 10 HP and chooses one of three cyberware cards.
4. Every fifth wave is a boss wave with a smaller escort.
5. The run ends at 0 HP. The result screen shows score, wave, kills, time and the cyberware collected. The best score is stored locally.

Enemy health grows by 13 % per wave and enemy speed by 3 % per wave, capped at +45 %. Bosses grow by 70 % per earlier boss wave.

## Weapons

| Slot | Weapon | Behaviour |
|---|---|---|
| 1 | TENSHI-SMG | Accurate automatic fire, 9.5 shots per second |
| 2 | ONI-SCHROT | Shotgun, 8 pellets with spread, strong recoil and knockback |
| 3 | KAGE-KATANA | Melee arc in front of the player; reflects enemy bullets back at double damage |

## Abilities

- **Dash:** a short, invulnerable burst of speed in the move direction (forward when standing). Cooldown 1.3 s.
- **Overclock:** fills through kills and boss hits. When full, the world runs at 20 % speed for 4 s while the player keeps moving at full speed, with afterimages and a colour-shift effect.

## Enemies

| Enemy | First wave | Behaviour |
|---|---|---|
| Ganger | 1 | Melee chaser with a telegraphed wind-up and strike |
| Drone | 2 | Fast flyer that hovers and fires |
| Gunner | 3 | Keeps distance and shoots bursts |
| Brute | 4 | Slow, heavy, charges along a red telegraph line |

From wave 7 gunners and brutes appear more often.

### Bosses

| Boss | Waves | Pattern |
|---|---|---|
| RAZORBACK | 5, 15, 25, ... | Bullet fans while chasing, then a telegraphed charge that ends in a bullet ring |
| HYDRA-7 | 10, 20, 30, ... | Flying gunship with bullet rings and spirals; summons drones |

Both bosses attack faster below half health. Defeating a boss clears all enemy bullets and drops three healing injectors.

## Pickups

Healing injectors restore 15 HP. Brutes drop them 30 % of the time, other enemies 5 %. They are pulled towards a nearby player and disappear after 14 s.

## Cyberware upgrades

After each wave the game offers three random cards from this list. Cards with a maximum level stop appearing once maxed.

| Upgrade | Effect | Max |
|---|---|---|
| Hartplasma-Munition | +25 % damage | none |
| Doppelkern-Abzug | +20 % fire rate | none |
| Split-Kammer | SMG +1 projectile, shotgun +2 pellets, katana +15 % reach | 4 |
| Durchschlag-Kern | Bullets pierce one more enemy | 3 |
| Querschläger-Chip | Bullets ricochet once more off walls and stalls | 2 |
| Zielsuch-Optik | +12 % critical hit chance (2.5× damage) | 4 |
| Subdermale Panzerung | +30 max HP and a full heal | none |
| Nano-Reparatur | Regenerate 1.5 HP per second | 3 |
| Reflex-Booster | +12 % movement speed | 4 |
| Dash-Servos | Dash recharges 30 % faster and damages enemies it passes through | 3 |
| Neuro-Overclock | Overclock lasts 1.5 s longer and charges 25 % faster | 3 |

## Scoring

Each kill scores the enemy's base points times the combo multiplier. The multiplier rises by 0.5 for every 8 kills in a combo, up to ×5. The combo ends 2.6 s after the last kill and is halved when the player takes damage.
