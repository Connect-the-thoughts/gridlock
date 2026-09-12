#!/usr/bin/env bash
# Gates the Pages deploy (shared pages.yml runs this first if present).
# Must not assume the laptop: node only, no Python, no network.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run check
