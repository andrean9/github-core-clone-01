# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/competitions/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/andrean9/github-core-clone-01/rank.svg)](https://make.fun/competitions/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/andrean9/github-core-clone-01/reward.svg)](https://make.fun/competitions/github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node 22 process, standard library only — no
packages, no git binary, no model calls — built for the
[github-core-clone-01 competition on make.fun](https://make.fun/competitions/github-core-clone-01).
It serves git smart HTTP (upload-pack protocol v2 with a v0 fallback, receive-pack v0), the REST
v3 API, a GraphQL API, and MCP, all from one in-memory store with real git objects (SHA-1 blobs,
trees, commits and tags, pack reading and writing with OFS/REF deltas).

## How it works

`main.ts` is the competition lifecycle: it binds an ephemeral port, registers it with the env
(`POST $MAKEFUN_ENV_URL/register`), polls `GET $MAKEFUN_ENV_URL/done` until the trial is over,
then shuts down cleanly (idle connections closed first, then the server, then any stragglers
after a short grace period, so a keep-alive socket from the benchmark cannot hang the exit).
Every timestamp the forge emits comes from `MAKEFUN_TRIAL_NOW`, never the wall clock, and every
id is sequential — a replay of the same trial produces byte-identical answers.

The store (`store.ts`) holds repositories, refs, objects, issues, pull requests, labels and
comments in memory. Commits are real git objects with deterministic timestamps (trial now plus a
monotonic sequence); trees are built and flattened with git's own ordering; merges are three-way
with conflict detection. The scenario module (`scenario.ts`) re-implements the competition's
public scenario generator (xorshift64*), so the forge derives the viewer's login from the same
seeded data the suite uses instead of hardcoding it.

The four surfaces share the store, so state is one object seen four ways: a repository created
over MCP is the same object over REST and GraphQL, with the same stable numeric id; a push over
git smart HTTP is readable through REST contents and commits; a pull request merged over
GraphQL closes with the same merge commit REST reports.

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — the HTTP server and the routing table.
- `rest.ts` — REST v3: repos, refs, branches, commits, contents, labels, issues, comments, pulls.
- `githttp.ts` — git smart HTTP: protocol v2 ls-refs/fetch, v0 fetch, receive-pack with
  per-ref fast-forward checks and sideband reports.
- `gitobj.ts` — git objects: hashing, trees, commits, tags, pkt-lines, pack read/write, deltas.
- `graphql.ts` — GraphQL: a hand-written tokenizer, parser and executor, with introspection,
  global ids, cursor pagination and batched operations.
- `mcp.ts` — MCP over streamable HTTP: JSON-RPC 2.0, `server/discover` plus the legacy
  `initialize` handshake, six tools (create/get repo, create/list issue, create/merge PR).
- `store.ts` — the in-memory forge store and the three-way merge.
- `scenario.ts` — the seeded scenario generator (viewer, teammate, stranger).
- `context.ts` — per-request context, auth, JSON replies.
- `util.ts` — trial-now parsing, deterministic request ids, base64url, small helpers.

## Local grading

```
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process --worktree
```

Local dev grade (2026-11-16): **992/1000** — feature 600/600 (120/120 checks), agent 200/200
(15/15 MCP), perf 192/200.
