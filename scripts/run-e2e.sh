#!/usr/bin/env bash
# Build, then run Playwright against the Electron app.
#
# This script used to rebuild better-sqlite3 against Electron's Node ABI and
# flip back on EXIT. better-sqlite3 13 is an N-API addon whose prebuilt
# binaries are keyed by platform-arch alone, so one binary serves both the
# system Node and Electron ABIs and there is nothing left to flip.
set -euo pipefail

node scripts/run-build-with-timeout.mjs
npx playwright test "$@"
