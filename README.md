# Coldline

Browser team shooter (three.js). One player hosts a match in their browser and shares a
5-character invite code; others join peer-to-peer (WebRTC via PeerJS). Modes: Deathmatch,
Capture the Flag, Infiltration. Bots are optional.

Play: https://nullservices.github.io/coldline/ (or open `index.html` from any static host).

## Build

```
npm install
npm run build      # bundles src/ into index.html (and dist/index.html)
npm run check      # validates the map: sizes, spawn/base reachability, bot nav coverage
```

Open `index.html?test` for an offline practice match against bots (no matchmaking).
Options: `&mode=ctf|inf`, `&bots=6`, `&pos=x,y,z,yaw,pitch` to spawn at a point.

## The map — "Switchyard"

A rail freight depot with three height levels. The layout is in `src/map.js` as stacked
ASCII layers (ground, +2.8 m, +5.6 m); the bottom half is the top half rotated 180°, so both
teams get the same base.

- **Warehouses (team bases)** — brick, two storeys plus roof. The flag sits on the ground
  floor under a grated mezzanine with railings; the mezzanine has windows over the yard,
  stairs up to the roof, and the roof has a parapet. An exterior ladder on the east wall is
  the attackers' back way up.
- **Centre** — a steel catwalk crosses the yard at 2.8 m (fast, exposed) and lands on a
  concrete plinth with stairs on both sides. The ground route goes around the plinth.
- **East dock / west alley** — a raised loading dock with railings, reachable by stairs or by
  climbing crate → container → dock. The opposite flank is a tight alley of crates and
  barriers.

Movement rules worth knowing: step height 0.4 m, jump reaches 1.45 m (crates, and
containers from a crate), **crouch-jump fits through windows** (standing does not), ladders:
face the rungs and hold W.

### Map legend (`src/map.js`)

| char | meaning | char | meaning |
|---|---|---|---|
| `#` / `B` | concrete / brick block, full layer | `=` / `r` | floor slab / slab with railings on open edges |
| `C` `c` `l` | container 2.4 · crate 1.2 · barrier 1.0 | `w` / `a` | window (sill 1.0, header 2.2) / doorway header |
| `^ v < >` | stairs rising toward the arrow | `L` | ladder (stack across layers) |
| `o` / `*` | pillar / ceiling lamp | `S` `D` `F` | team spawn · DM spawn · flag |

Run `npm run check` after editing; it prints a height overview and fails if any spawn or
base is unreachable.
