# 32. Dashboard: React + Vite + MUI client, `node:http` server, one long-running command (Phase 4)

The dashboard is the one exception to "the CLI is one-shot": `orch ui` serves until interrupted.
It is optional, loopback-only, and reads the same database the CLI writes, so nothing about jobs
depends on it. The client is React 19 + Material UI built by Vite into `web/dist` (shipped, so a
user never runs Vite); the server is `node:http` with a dozen routes rather than a framework. React
and MUI are dev dependencies: their output is static files. Hash routing, a 40-line Markdown
renderer, and polling were chosen over a router, a Markdown library, and websockets.
