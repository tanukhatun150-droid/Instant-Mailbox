---
name: Mail.tm browser access
description: CORS behavior for the disposable-mail provider used by this app
---

Mail.tm's public API response did not include `Access-Control-Allow-Origin` when checked from a browser origin.

**Why:** direct browser `fetch` calls fail at the CORS boundary even though the same API works from native clients and server-side requests.

**How to apply:** use the Replit API bridge with an absolute same-domain URL on web; native clients can call Mail.tm directly.
