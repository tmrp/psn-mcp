---
"psn-mcp": patch
---

Fix purchased-game requests rejected by Apollo CSRF protection by adding a preflight header, and include GraphQL error messages in HTTP failures. Fix browser login timeouts caused by command IDs outside Chrome's signed 32-bit range, read cookies through the browser debugging target, and retry temporary profile cleanup while the browser shuts down.

Bound debugger HTTP requests and WebSocket handshakes, report protocol errors and disconnects promptly, and clean up listeners on every command outcome. Validate cookie responses and ignore malformed error fields without hiding useful diagnostics.
