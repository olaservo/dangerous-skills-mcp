# Reconciliation: `index.json` → `skills/list` + `skills/get` (+ new fixtures)

Status: **IMPLEMENTED** on this branch (`adv/sep-reconciliation-and-new-fixtures`). The corpus now serves the v1 SEP model — `skills/list` + `skills/get` with a complete per-file `resources` digest set — and the four SEP-current fixtures are wired and passing. This document records the design and what changed.

**What landed:**

- `src/skills.ts` (new) — builds SEP skill entries (`uri` + verbatim `frontmatter` + complete `resources` digest set). Replaces `src/index-json.ts` (removed).
- `src/resources.ts` — drops the `skill://index.json` resource; builds the entry catalog; adds `skillsList(cursor?)` and `skillsGet(uri)`; keeps `resources/read` + `resources/directory/read`; wires the escape-child, pagination-overflow, and `omitFromResources` hooks; excludes archive-only skills from the listing.
- `src/server.ts` — registers `skills/list` and `skills/get`; disclaimers in `instructions`.
- `src/adversarial/*` — `supporting-file-digest-swap` now expressed via `omitFromResources` (unlisted file); `file-url` via a `file:` resource URI; `name-collision` shadows the faithful `review-staged` name; the three server-behaviour fixtures (`directory-walk-escape`, `name-collision`, `enumeration-exhaustion`) are wired + registered; archive fixtures marked DEFERRED.
- `src/smoke-client.ts` — checks `skills/list` + `skills/get` + per-file digest verification (SKILL.md and a supporting file); drops the `index.json` reads.

`pnpm typecheck` clean; `pnpm smoke` and `pnpm smoke -- --adversarial` both ALL CHECKS PASSED.

## Archives: a deferred feature, retained on purpose

Archives are **not part of the v1 SEP** (see the SEP's "Appendix: Deferred Features"). They are kept in this corpus deliberately — the archive-safety fixtures are a research contribution and a landing spot should archives be reconsidered. Faithful skills pack no archives; only crafted deferred fixtures supply archive blobs, served as ordinary resource bytes and never referenced by a `skills/list` entry. Archive-only skills (e.g. `refunds`) are excluded from the listing (they cannot be expressed in the individual-file model). Every archive fixture's catalog entry is prefixed **DEFERRED**.

## Why

The corpus models discovery via a `skill://index.json` resource and treats archive distribution as a live delivery form. The canonical SEP-2640 revision on the [`sep/skills-extension`](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) branch has moved on:

- `skill://index.json` was replaced by two methods: `skills/list` (paginated enumeration) and `skills/get` (single skill by URI).
- Each skill entry now carries a `resources: [{uri, digest}]` array enumerating **every** file with a per-file SHA-256 digest. A host MUST verify each retrieved file against it, and MUST treat a read of any URI not in the set as a verification failure. This closes the old "digest covers `SKILL.md` only" (B1) gap.
- Archive distribution was removed to the SEP's *Appendix: Deferred Features*.

Current drift in `src/` (measured on this branch):

| Signal | Count | Meaning |
| :--- | ---: | :--- |
| `index.json` references | ~24 | Discovery still modeled via the removed index resource |
| `skills/list` / `skills/get` | 0 | New methods unrepresented |
| `resources`-array (per-file digest) | ~5 | New integrity primitive barely present |
| archive fixtures | ~22 | 11 `adv-archive-*` / `adv-zip-*` fixtures still active, not deferred |

The [threat model](https://github.com/modelcontextprotocol/experimental-ext-skills/blob/main/docs/threat-model.md) already tracks the current SEP. This plan realigns the corpus so its claim — "every `adv-*` is a runnable fixture with a documented oracle" — stays true against the current SEP.

## Target serving model

1. **Discovery.** Replace the `index.json` builder/server (`src/index-json.ts` and its consumers) with:
   - `skills/list` — paginated; each entry is `{ uri, frontmatter, resources }`. In protocol 2026-07-28+, also `ttlMs` / `cacheScope` (freshness hints, not integrity).
   - `skills/get` — returns one entry by URI, including skills absent from the listing; the verification-refresh path.
2. **Integrity primitive.** Populate `resources` for every skill from its `SkillFile[]` (each file's `uri` + `sha256(bytes)`). `skillMdDigest` becomes the `SKILL.md` entry within `resources` rather than a standalone field.
3. **Archives → deferred profile.** Move the 11 archive fixtures behind a distinct profile flag (e.g. `--profile deferred-archives`) or drop them from the default adversarial profile, so the baseline corpus matches the SEP's individual-file model. Keep the fixtures and their catalog entries on record (they map to the SEP's deferred-features appendix and to any future archive reintroduction).
4. **Catalog `denItem` semantics.** The `denItem` field is documented as "reviewer (Den Delimarsky) item id." The four new cases are not from that list; they use the closest bucket for smoke-client display while `sepClause` carries the honest attribution ("SEP-current"). Recommend either renaming the field to something origin-neutral (e.g. `reviewItem`) or letting it carry `"SEP-current"`, and updating the smoke-client format string that hardcodes the `Den ` prefix.

## New fixtures on this branch

| Fixture | Threat | State | How it is exercised |
| :--- | :--- | :--- | :--- |
| `adv-nested-consent` | T9 nested-skill consent | **Live** | nested `SKILL.md` served as an ordinary supporting file; smoke prints the oracle |
| `adv-directory-walk-escape` | T5 confused deputy | **Live** | `directoryChildren()` lists `directoryEscapeChildUri` (out-of-subtree) but omits it from `resources`; smoke asserts the child is listed and that reading it misses |
| `adv-name-collision` | T8 impersonation | **Live** | shadows the faithful `review-staged` name at a distinct URI; smoke asserts >1 entry named `review-staged` incl. the fixture |
| `adv-enumeration-exhaustion` | T6 exhaustion | **Live** | `skillsList()` honors `paginationOverflow`, returning an endless `nextCursor`; smoke follows it a bounded 5 pages and asserts it never terminates |

## Remaining follow-ups (not blocking)

- **`denItem` field semantics.** The field is documented as "reviewer (Den Delimarsky) item id." The SEP-current cases reuse the closest bucket for smoke display while `sepClause` carries the honest attribution ("SEP-current"). Recommend renaming the field to something origin-neutral (e.g. `reviewItem`) or letting it carry `"SEP-current"`, and updating the smoke-client format string that hardcodes the `Den ` prefix.
- **Cross-origin realism for `adv-name-collision`.** Modeled within one server as a same-name / distinct-URI collision. A fully cross-origin version would serve the shadow under a second server identity — a harness change, out of scope here.
- **Deferred-archive profile.** Archive fixtures currently load in the `--adversarial` profile with DEFERRED disclaimers. A dedicated `--profile deferred-archives` split is optional polish.
