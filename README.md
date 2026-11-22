# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ChristaNavisa/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ChristaNavisa/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and `mend` reads each as [SPEC.md](SPEC.md) says. Every file is
changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>`
for a move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>`
line per failed edit and `failed: <k> of <n> edits`, and writes nothing.
Exit 2 prints exactly one line for a usage error, an unreadable patch file,
an undetected format, or a patch that cannot be parsed.

## Matching

An edit's old lines are found at the first of three tiers at which they
occur: exact, then ignoring trailing spaces and tabs, then ignoring leading
and trailing spaces and tabs. At the third tier the new lines are re-indented
from the patch's indentation to the file's. Unified hunks take the occurrence
nearest the line number the hunk names; SEARCH/REPLACE blocks fail as
ambiguous when the old lines occur more than once; V4A chunks follow a cursor
from their anchor.

## Files

- `main.ts` — the CLI. Node 22, standard library only.
- `runner.ts` — the kit's runner, kept as it is. In a trial it reads the
  checks from the env and runs `main.ts` on each one.
- `check.ts` — the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md` — the specification; the whole contract.
- `LICENSE` — MIT.

## Grade locally

The kit carries the 100 public practice checks with their expected outcomes
at `program/generator/practice.json`:

    node check.ts /path/to/kit/program/generator/practice.json
    node check.ts /path/to/kit/program/generator/practice.json u-offset s-basic
