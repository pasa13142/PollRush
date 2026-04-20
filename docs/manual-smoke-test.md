# Manual Smoke Test Checklist

Use this checklist after loading the unpacked extension in Chrome and opening `https://web.whatsapp.com/`.

## Expected Result Status Values

- `primary_voted`
- `secondary_voted`
- `skipped_no_index`
- `skipped_not_new`
- `skipped_duplicate`
- `blocked_index_required`
- `attempt_failed`
- `disarmed`

## Test Cases

1. Arm with only primary index (for example `2`) and send a new poll with at least two options.
   - Expected: one click on index 2, status `primary_voted`.
2. Arm with primary and secondary (for example `5` and `2`) where poll has no 5th option but has 2nd option.
   - Expected: one click on index 2, status `secondary_voted`.
3. Arm with indexes that do not exist in poll.
   - Expected: no vote, status `skipped_no_index`.
4. Open a chat with existing old polls, then arm.
   - Expected: no vote on old polls, status remains unchanged or `skipped_not_new` during DOM updates.
5. Trigger UI re-render on same poll (scroll, resize, reopen chat).
   - Expected: no second attempt, status `skipped_duplicate` if that poll appears again in mutation stream.
6. Stay armed and switch to another chat containing old polls.
   - Expected: no vote on historical content after switch, status `skipped_not_new` for initial load mutations.
7. Keep extension armed and move WhatsApp tab to background.
   - Expected: no voting while page is hidden.
8. Reload WhatsApp while extension is armed.
   - Expected: restored as armed with `blocked_index_required`; no votes until indexes are entered again.
9. Check latency after a successful vote.
   - Expected: popup shows last latency in milliseconds, typically near target (<120ms best effort).
