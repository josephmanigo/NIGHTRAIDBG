# Loop 4: Multi-screenshot round merging

This loop adds an isolated round-submission reader. It reads every canonical screenshot in one stored submission independently, then merges overlapping leaderboard rows.

The service:

- matches repeated team rows using rank, team code, and player-slot evidence;
- compares team totals, player slots, exact player names, and player kills;
- removes repeated ranks, teams, and player slots;
- preserves unique rows from every screenshot;
- returns every conflicting candidate and its screenshot source instead of choosing silently;
- requires manual review for field conflicts, screenshot failures, and kill-total mismatches;
- checks that four readable player kills sum to the displayed team total.

It is not connected to Google Sheets.

```js
import { createRoundSubmissionReader } from './bot/game-results-round-reader.js'

const reader = createRoundSubmissionReader()
const combinedRound = await reader.readSubmission(storedSubmission)
await reader.close()
```

Run the Loop 4 tests with:

```sh
npm run test:game-results-round
```
