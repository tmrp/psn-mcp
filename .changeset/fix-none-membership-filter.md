---
"psn-mcp": patch
---

Fix purchased games returning an empty library for membership NONE by filtering unfiltered library pages locally. Apply pagination and play-time enrichment to matching entitlements, look ahead before returning nextOffset, and return exact totals only after reaching the end of the library. Clarify that NONE includes free entitlements and does not imply a paid purchase.
