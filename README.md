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
