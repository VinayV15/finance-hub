#!/bin/bash
# Start Finance Hub. Leave this window open; Ctrl+C to stop.
cd "$(dirname "$0")"

# Rebuild the screens if the front-end code changed since the last build.
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/index.html -newer web/dist/index.html -print -quit)" ]; then
  echo "Building the app screens…"
  [ -d web/node_modules ] || (cd web && npm install --silent)
  (cd web && npm run build --silent) || { echo "Build failed."; exit 1; }
fi

exec .venv/bin/python app.py
