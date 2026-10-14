# Security

Agents HQ sees what your AI agents work on, so security reports get priority.

## Reporting

Email **ahoj@bonusround.sk** with the subject `Agents HQ security`.
Please do not open a public issue for a vulnerability.
We reply within 7 days.

## What Agents HQ promises

- It only reads Claude Code and Codex session logs; it never writes to them.
- No code path sends input to an agent, starts or stops one.
- The server listens on `127.0.0.1` only and requires a random per-start token,
  a loopback `Host` header and a same-origin `Origin`.
- The page's Content-Security-Policy allows connections to this server only.
- It writes only to `~/.agents-hq` (`0700` directory, `0600` files).

Anything that breaks one of these promises is in scope, for example: reading files
outside the session-log folders, writing anywhere else, XSS in the office UI,
connecting to the office from another site, or leaking session content off the machine.
