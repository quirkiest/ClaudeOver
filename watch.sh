#!/usr/bin/env bash
# watch.sh v0.1.0 - live, readable ClaudeOver gateway log. Run on the LINUX BOX
# from the repo root:   ./watch.sh            (last 5 min, then follows)
#                       ./watch.sh 1h         (history window)
#                       VERBOSE=1 ./watch.sh  (also raw ROM events)
# Ctrl-C to stop. Q&A text shows only with LOG_TRANSCRIPTS=1 in gateway/.env.
set -euo pipefail
cd "$(dirname "$0")"
docker compose logs -f --no-log-prefix --since "${1:-5m}" gateway | node gateway/tools/pretty.js
