#!/usr/bin/env bash
set -euo pipefail

cat <<'TEXT'
WhatsApp Web Poll Auto-Voter smoke helper (read-only)

1) Load unpacked extension from this project directory.
2) Open https://web.whatsapp.com/ in active tab.
3) Use docs/manual-smoke-test.md and run all nine checks.
4) Verify status transitions and latency values in popup.

This helper does not mutate repo or browser state.
TEXT
