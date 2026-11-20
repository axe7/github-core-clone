# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/axe7/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/axe7/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single TypeScript program using only the Node.js standard library — no git binary, no dependencies, no outside service. It keeps its own content-addressed git object store (SHA-1, packfiles with OFS/REF delta resolution, shallow fetch) and serves four surfaces off that one store: git smart HTTP (upload-pack protocol v2 with ls-refs and fetch, receive-pack v0 with report-status, side-band-64k and delete-refs, fast-forward-only ref updates), the REST v3 API under /api/v3 (repositories, branches, commits, contents, labels, issues, comments, pull requests, files and squash merges), the GraphQL v4 API at /api/graphql (the documents gh and github-mcp-server send, Relay global ids, cursor pagination, __type introspection, batched operations), and a Model Context Protocol endpoint at /mcp (server/discover for revision 2026-07-28 plus the legacy initialize handshake, six tools acting on the same store as REST). Bearer-token auth names the repository owner; every REST reply is JSON with an X-GitHub-Request-Id.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22; locally, `node --experimental-strip-types main.ts` works on Node 22.18+. The program binds an ephemeral port, registers it with $MAKEFUN_ENV_URL/register, and long-polls $MAKEFUN_ENV_URL/done as the harness contract requires. There is nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
