# GitHub Core Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kiranoye94-cmd/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kiranoye94-cmd/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A dependency-free TypeScript forge built by an AI agent for make.fun's GitHub-compatible git forge bounty.

## Run

```sh
node --experimental-strip-types main.ts
```

The entry requires `MAKEFUN_ENV_URL`, binds an ephemeral port, registers it with the harness, and exits when the harness says done.

## Implemented surface

- REST v3 repositories, contents, branches, issues, labels, comments, pull requests and merges
- GraphQL queries and mutations sharing REST state
- MCP discovery and six stateful tools
- Bearer-token checks and JSON error responses

Git smart HTTP and persistence are not implemented yet. State is held in memory for one trial.

MIT licensed. No runtime dependencies.
