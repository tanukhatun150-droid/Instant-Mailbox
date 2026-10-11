---
name: Orval parameter exports
description: Avoid duplicate generated parameter type names in the shared API Zod package.
---

When adding query parameters to an operation that already has path parameters, check the shared generated-type barrel for duplicate operation parameter names. For mail-message routes, provider/session metadata is sent in `X-Mail-*` headers; if query parameters are needed later, alias or exclude one conflicting type export.

**Why:** Orval can generate identically named path and query parameter types for one operation, causing the shared library typecheck to fail after code generation.

**How to apply:** Run API code generation after OpenAPI edits. If parameter names collide, fix the barrel exports or use a header-based contract for provider metadata.
