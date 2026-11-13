# Coldline

Browser team shooter (three.js). One player hosts a match in their browser and shares a
5-character invite code; others join peer-to-peer (WebRTC via PeerJS). Modes: Deathmatch,
Capture the Flag, Infiltration. Bots are optional. Seven maps.

Play: https://nullservices.github.io/coldline/ (or serve the folder from any static host —
`index.html` plus `assets/`).

## Build

```
npm install
npm run build      # bundles src/ into index.html (and dist/index.html); assets/ is loaded at runtime
npm run check      # validates every map: sizes, spawn/base reachability, bot nav coverage, ray casts
```

Open `index.html?test` for an offline practice match against bots (no matchmaking).
Options: `&map=shopfront`, `&mode=ctf|inf`, `&bots=6`, `&pos=x,y,z,yaw,pitch` to spawn at a point.
Served from `file://` the character model needs Chrome's `--allow-file-access-from-files`; any
local HTTP server works without it.

## Maps

All maps are symmetric (the second half is the first rotated 180°), so both teams get the same
base. Every one has several height levels: step height 0.4 m, jump reaches 1.45 m (desks,
planters, low walls), **crouch-jump fits through windows** (standing does not), ladders: face
the rungs and hold W. Glass walls can be seen and shot through but not walked through; railings
never stop bullets.

| map | setting | what makes it play |
|---|---|---|
| **Campus** | glass office towers around a plaza | three-floor towers with a set-back terrace and roof, parking decks as flank routes, a two-floor pavilion in the middle |
| **Shopfront** | a city block under siege | two-storey shops with flats above, a hotel with rooms, balconies and a roof terrace, a garage, an alley fire-escape ladder, a scaffold deck and a bank in the middle of the street with its own roof |
| **Store** (asymmetric) | a department store under siege, after SoF2's *The Shop* | sales floor with shelf aisles, a three-storey atrium with galleries, offices, a warehouse mezzanine holding the case, a rooftop battlefield with a lower warehouse roof, and two towers; Blue starts on the tall tower and the case must be carried back up to it |
| **Invasion** (asymmetric) | a town block, after SoF2's *The Shop Invasion* | Red base in the west under an open light well, Blue base upstairs in the east, two streets and four alleys between two-storey buildings (apartments, garage, bar with a roof terrace, bank, hotel with balconies, market, car park) and the shop in the middle with a rooftop bulkhead |
| **Hacienda** | walled villas in the hills | courtyard houses with an upstairs gallery, garden balcony and tiled roof reached by ladder, a barn with a hayloft, a water tower, low terrace walls to vault and a ruin between the compounds |
| **Rooftops** | the top of a hospital-sized building, street far below | penthouse terraces with a stair bulkhead, a machine-room summit at three levels, an exposed catwalk along the edge, a lift tower with a two-storey ladder, a helipad and duct runs for cover |
| **Switchyard** | a snowed-in rail depot | container stacks, a warehouse with a mezzanine and catwalks, long sightlines down the tracks |

The design brief came from the Soldier of Fortune II multiplayer set (shop / hotel / finca /
hospital-roof / depot settings, 4–10 distinct floor heights, ladders as risky shortcuts). Store
and Invasion follow the room structure and flow of *The Shop* and *The Shop Invasion* on this
engine's 2.5 m grid; the others are original layouts in the same spirit. No game data is used.

### Making a map (`src/maps/`)

A map is a file exporting `{ id, name, desc, kinds, theme, layers }`. `layers` is the top half
of the map as stacked ASCII grids (ground, +2.8 m, +5.6 m, …); `kinds` remaps a character's
material (`{'#': 'stone', '=': 'floor2'}`), `theme` sets ground/outer textures, sun, fog, sky,
exposure and skyline (`city` / `hills`). Register it in `src/maps/index.js` and run `npm run check`.

| char | meaning | char | meaning |
|---|---|---|---|
| `#` `B` `p` `W` | wall blocks, full layer (concrete / brick / plaster / wood by default) | `g` | glass curtain wall, full layer |
| `=` `r` `R` | floor slab / deck with railings / roof slab | `m` | floor tile |
| `C` `c` `h` | container 2.4 · crate 1.2 · wall 1.4 (vault over) | `l` `P` `d` `k` | barrier 1.0 · planter 0.9 · desk 0.75 · market stall |
| `^ v < >` | stairs rising toward the arrow | `L` | ladder (stack across layers) |
| `w` / `a` | window (sill 1.0, header 2.2) / doorway header | `o` / `*` | pillar / ceiling lamp |
| `S` `D` `F` | team spawn · DM spawn · flag (team by map half) | `1` `2` `G` | red / blue spawn and blue flag for asymmetric maps (`sym: 'none'`, full layout instead of a mirrored half) |

## Hit detection

Shots and bot line-of-sight use an exact ray cast through the level solids (`rayMap` in
`src/map.js` walks the cell grid and intersects every box and stair ramp analytically), so thin
floors and pillars are never skipped. The host re-checks every reported hit for line of sight
from the shooter's eye before applying damage, and bots drop a target they can no longer see.

## Assets

- Textures in `assets/tex/` are CC0 photo-scanned PBR sets from [ambientCG](https://ambientcg.com)
  (colour 1K, normal/roughness/AO 512), packed with `tools/packtex.py`.
- `assets/models/soldier.glb` is the Mixamo "Vanguard" character with Idle/Walk/Run clips, as
  shipped in the three.js examples. Aim pitch and crouch are layered on top of the clips at
  runtime.
- Everything else (weapons, railings, ladders, lamps, skyline) is built from primitives in code.
