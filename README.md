# Gridlock

Daily traffic-planning puzzle in the Connect the Thoughts arcade. Spec:
`connectthethoughts/docs/superpowers/specs/2026-09-12-gridlock-design.md`.

- Engine: `engine.js` (pure, deterministic, tested with `npm test`).
- Cities are BAKED offline: `uv venv .venv && uv pip install -p .venv osmnx`
  then `.venv/bin/python scripts/bake-city.py charlottetown`. Never fetched at
  runtime. `npm run check:cities` fences every baked file; `npm run balance`
  prints the puzzle-worthiness report.
- Loader-delivery classic game: shared assets come from `/shared/arcade-loader.js`.
  Local dev: run the `arcade-root` launch entry and open
  http://127.0.0.1:5236/gridlock/
