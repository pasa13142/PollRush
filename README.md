# WhatsApp Web Ultra-Fast Poll Auto-Voter

Chrome extension (MV3, vanilla JS) that watches WhatsApp Web and votes on newly arriving polls in the currently open chat using 1-based index selection.

## Features

- Arms/disarms from popup UI.
- Input:
  - `primaryIndex` (required, integer >= 1)
  - `secondaryIndex` (optional, integer >= 1)
- One-pass selection logic:
  1. Try primary index.
  2. Fallback to secondary index if primary missing.
  3. Skip if neither index exists.
- New-poll-only behavior after arm (historical content ignored).
- Single-attempt semantics per poll key (dedupe protection).
- Operates only when WhatsApp tab is visible and focused.
- Armed state persists across reload; indexes do not.

## Load Unpacked

1. Open Chrome and visit `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project folder.
4. Open `https://web.whatsapp.com/`.
5. Open extension popup, enter indexes, click **Arm / Update**.

## Status Fields in Popup

- **State**: Armed/Disarmed (+ index required state).
- **Result**: Last outcome code (`primary_voted`, etc.).
- **Latency**: Last measured detect-to-click dispatch latency.
- **Focus/Visibility**: Current eligibility state.

## Smoke Test

- Detailed checklist: `docs/manual-smoke-test.md`
- Quick helper: `scripts/smoke-helper.sh`
