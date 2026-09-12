#!/usr/bin/env node
// Prints the JS engine's own baseline delay for a city file, so the BAKE stores
// the number the shipped engine reproduces (check-cities compares with !==).
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const E = require('../../engine.js');
const path = process.argv[2];
const city = JSON.parse(readFileSync(path, 'utf8'));
const pp = path.replace(/\.json$/, '.proposals.json');
city.proposals = existsSync(pp) ? JSON.parse(readFileSync(pp, 'utf8')) : [];
process.stdout.write(String(E.solve(city, []).baselineDelayVehH));
