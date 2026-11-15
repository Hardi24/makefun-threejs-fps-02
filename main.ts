// Dustline Yard — a threejs-fps-02 entry (Node 22, standard library only).
//
// The game is this directory's game/ folder: plain static files the browser loads as ES
// modules with three.js 0.187.0 from an import map, no build step and no network request.
// It is a round-based tactical FPS in the Counter-Strike style, with an original map, art,
// sounds and names: Vanguard (the player plus two bots) defends the Foundry (A) and Depot
// (B) sites in an industrial yard against four Raider bots who try to plant a charge.
// Rounds are won by elimination, by detonation, by defusal, or on the clock; money earned
// between rounds buys five weapons and armour. First to 5 rounds takes the match.
// The v3 build adds a fifth weapon (Riot-12 Scattergun), aim-down-sights, a death-cam,
// a scoreboard, an event feed and a damage-direction indicator on top of that core.
//
// This program hands the game in. It copies game/ and screenshots/ from beside this file
// to /output and writes /output/dossier.json, the summary the judge reads, with the
// vendored make.fun library. It writes the same bytes on every run: game/ and
// screenshots/ are fixed files in this repository, and buildDossier is deterministic.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Screenshots (screenshots/, first by name is the cover) are real renders of the game's
// own code, taken in a headless browser with the game's ?shot= modes (see shots.json):
//   1-start.jpg  the start screen over the Vanguard spawn
//   2-play.jpg   mid-round combat in Mid, crosshair on a Raider
//   3-buy.jpg    the buy phase between rounds
//   4-end.jpg    the round-won banner at the Foundry site

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the others refuse an entry the
// scorer would refuse (more than 4 screenshots or one over 256 KiB; more than 993 files in game/ or 48 MiB of game
// files, in all: game/ counts beside /output's own 1000-entry cap, its screenshots/ and dossier.json).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: 163840, screenshots: { max: 4, max_bytes: 262144 }, game_max_files: 993, game_max_bytes: 50331648 }),
);
