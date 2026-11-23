# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/paelra/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/paelra/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format: it applies an edit an AI model wrote to a tree of text files, reading a patch in any of four formats — unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits — locating each edit's lines at the first of three matching tiers, and writing every change or none, printing what it changed or why it failed.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=1a9c58a2&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

---

# mend — one patch tool for every AI edit format

`mend` applies an edit an AI model wrote to a tree of text files, as
SPEC.md (version 1) specifies. It reads a patch in any of four formats —
unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits — finds the lines
each edit names at the first of three matching tiers (exact, trailing-space
insensitive, fully trimmed, with re-indentation at the loosest tier), and
writes every change or none, printing what it changed or why it failed.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Layout: `main.ts` is the command line and the all-or-nothing write;
`mend-core.ts` holds the file model, the tree and tier matching;
`mend-formats.ts` holds the four format readers. `runner.ts` and `check.ts`
are the kit's trial runner and practice harness, kept as the kit has them:
`node check.ts <practice.json>` runs the public practice checks.
