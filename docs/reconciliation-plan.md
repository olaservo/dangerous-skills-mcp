# Reconciliation plan: `index.json` → `skills/list` + `skills/get` (+ new fixtures)

Status: draft for review. Not yet implemented. This branch (`adv/sep-reconciliation-and-new-fixtures`) adds the catalog entries and fixture scaffolds; the serving changes below are the follow-up.

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

| Fixture | Threat | State on this branch | Serving hook needed |
| :--- | :--- | :--- | :--- |
| `adv-nested-consent` | T9 nested-skill consent | **Live** — built + registered | none; nested `SKILL.md` is served as an ordinary supporting file today |
| `adv-directory-walk-escape` | T5 confused deputy | scaffolded, not registered | `resources.ts` `directoryChildren()` must inject `directoryEscapeChildUri` as a child of the skill root **and** omit it from `resources` |
| `adv-name-collision` | T8 impersonation | scaffolded, not registered | conformance harness must serve this skill under a **second server identity** colliding with `crossOriginShadowOf` (a genuinely cross-origin topology) |
| `adv-enumeration-exhaustion` | T6 exhaustion | scaffolded, not registered | `skills/list` (and `directory/read`) serving must honor `paginationOverflow` by always returning a fresh `nextCursor` and never terminating |

The three scaffolds are exported from `src/adversarial/index.ts` but intentionally **not** in `buildAdversarialFixtures()`. The smoke client skips catalog keys with no served fixture (`continue`), so nothing reports a false pass in the meantime. Wiring + registering them is the last step of the reconciliation.

## Suggested sequence

1. **Discovery swap** — `index.json` → `skills/list`/`skills/get`, populate `resources` per file. (Largest change; unblocks everything else.)
2. **Archive demotion** — move archive fixtures behind a deferred profile.
3. **`denItem` field** — generalize + update the smoke-client prefix.
4. **Wire the three pending fixtures** — implement the three serving hooks above, then register the builders.

Each step is independently reviewable and could be its own PR; 1 is the prerequisite for 4.
