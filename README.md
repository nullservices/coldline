# Coldline

Browser team shooter (three.js). One player hosts a match in their browser and shares a
5-character invite code; others join peer-to-peer (WebRTC via PeerJS). Modes: Deathmatch,
Capture the Flag, Infiltration. Bots are optional.

Play: https://nullservices.github.io/coldline/ (or serve the folder from any static host —
`index.html` plus `assets/`).

## Build

```
npm install
npm run build      # bundles src/ into index.html (and dist/index.html); assets/ is loaded at runtime
npm run check      # validates the map: sizes, spawn/base reachability, bot nav coverage
```

Open `index.html?test` for an offline practice match against bots (no matchmaking).
Options: `&mode=ctf|inf`, `&bots=6`, `&pos=x,y,z,yaw,pitch` to spawn at a point.
Served from `file://` the model needs Chrome's `--allow-file-access-from-files`; any local
HTTP server works without it.

## The map — "Campus"

An office campus on four height levels. The layout lives in `src/map.js` as stacked ASCII
layers (ground, +2.8 m, +5.6 m, +8.4 m); the bottom half is the top half rotated 180°, so
both teams get the same base.

- **Office towers (team bases)** — glass curtain walls (see and shoot through, no walking
  through), a marble lobby with the flag, two office floors with desks and pillars, a
  stairwell up the west side, a set-back third floor whose roof is a **terrace** with railings,
  and a roof with parapet above that. An exterior ladder on the east face reaches the terrace.
- **Parking deck** beside each tower: ground level under a raised deck with stairs at both
  ends — the long flank route.
- **Pavilion** in the centre of the plaza: glass ground floor, a second floor reached by an
  outdoor stair, and a roof terrace overlooking both approaches. Planters and low walls
  break up the plaza.

Movement rules worth knowing: step height 0.4 m, jump reaches 1.45 m (desks, planters,
containers from a crate), **crouch-jump fits through windows** (standing does not), ladders:
face the rungs and hold W.

### Map legend (`src/map.js`)

| char | meaning | char | meaning |
|---|---|---|---|
| `#` `B` `p` | concrete / brick / plaster block, full layer | `g` | glass curtain wall, full layer |
| `=` `r` `R` | office floor slab / terrace deck with railings / roof slab | `m` | marble floor tile |
| `C` `c` | container 2.4 · crate 1.2 | `l` `P` `d` | barrier 1.0 · planter 0.9 · desk 0.75 |
| `^ v < >` | stairs rising toward the arrow | `L` | ladder (stack across layers) |
| `w` / `a` | window (sill 1.0, header 2.2) / doorway header | `o` / `*` | pillar / ceiling lamp |
| `S` `D` `F` | team spawn · DM spawn · flag | | |

Run `npm run check` after editing; it prints a height overview and fails if any spawn or
base is unreachable.

## Assets

- Textures in `assets/tex/` are CC0 photo-scanned PBR sets from [ambientCG](https://ambientcg.com)
  (colour 1K, normal/roughness/AO 512), packed by `tools/` from the original 1K-JPG sets.
- `assets/models/soldier.glb` is the Mixamo "Vanguard" character with Idle/Walk/Run clips, as
  shipped in the three.js examples. Aim pitch and crouch are layered on top of the clips at
  runtime.
- Everything else (weapons, railings, ladders, lamps, skyline) is built from primitives in code.
