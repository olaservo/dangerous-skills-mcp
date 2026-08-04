/**
 * adversarial/catalog.ts — The SINGLE source of truth for each adversarial case's
 * SEP-2640 clause, reviewer (Den Delimarsky) item, required conformant-host action,
 * and one-line oracle. Pure data: no bytes, no async.
 *
 * Both the fixture builders (./index.ts) and the smoke client import this, so a
 * rename or an oracle edit happens in exactly ONE place instead of drifting across
 * the fixtures and a hand-synced copy in the smoke client.
 *
 * `key` is the stable identifier: the fixture name for singletons, or the shared
 * prefix for families (the `refunds` name-collision pair, the cumulative-budget
 * pair). It is also the substring the smoke client matches served URIs against.
 */

/** What a conformant host MUST do when it encounters the fixture. */
export type ConformantAction = 'reject' | 'gate' | 're-prompt' | 'sanitize';

export interface AdversarialCase {
  /** Stable key + smoke-client match substring (== fixture name for singletons). */
  key: string;
  /** Human summary of what is crafted. */
  summary: string;
  /** SEP-2640 clause the fixture exercises. */
  sepClause: string;
  /** Reviewer (Den Delimarsky) item id, e.g. "C1", "B2". */
  denItem: string;
  /** The oracle: what a SEP-conformant host MUST do. */
  expectedAction: ConformantAction;
  /** One-line statement of the required host behaviour (printed by the smoke client). */
  oracle: string;
}

export const ADVERSARIAL_CASES: AdversarialCase[] = [
  {
    key: 'adv-archive-traversal',
    summary: 'tar.gz with ../../evil.txt and an absolute-path entry',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" MUSTs: reject entries that escape the destination directory',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST refuse to unpack: every entry path must resolve inside the skill dir; ".." segments and absolute paths MUST be rejected (no Zip-Slip).',
  },
  {
    key: 'adv-archive-symlink-escape',
    summary: 'symlink entry "id_rsa.example" -> ../../../etc/passwd (benign decoy)',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" MUSTs: symlink entries that resolve outside the destination MUST be rejected',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST NOT create symlinks on unpack (or MUST verify the resolved target stays inside the skill dir); a link escaping the dir MUST be rejected.',
  },
  {
    key: 'adv-archive-hardlink-escape',
    summary: 'hard-link entry "creds.example" -> ../../../etc/passwd (benign decoy)',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" MUSTs: reject symlinks OR HARD LINKS that resolve outside the skill dir',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST reject hard links (tar typeflag 1) as well as symlinks when the link target resolves outside the skill dir; the current SEP names hard links explicitly.',
  },
  {
    key: 'adv-decompression-bomb',
    summary: 'few-KB tar.gz expanding to ~128 MiB (single entry over any sane bound)',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" MUSTs: enforce a maximum expanded size / entry count',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST cap total expanded bytes and per-entry size; an archive exceeding the bound MUST be rejected before fully expanding.',
  },
  {
    key: 'adv-archive-setuid',
    summary: 'supporting file "tools/escalate" with setuid bit (mode 04755)',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" (Den-proposed expansion): clear setuid/setgid/sticky bits; extract as host uid/gid',
    denItem: 'C1',
    expectedAction: 'sanitize',
    oracle:
      'Host MUST clear setuid/setgid/sticky bits and extract as the host\'s own uid/gid; it MUST NOT preserve a server-authored setuid bit. (Den-proposed; not yet in the SEP.)',
  },
  {
    key: 'adv-archive-non-regular',
    summary: 'non-regular file entry "pipe.fifo" (FIFO, typeflag 6)',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" (Den-proposed expansion): reject non-regular file types (device nodes, FIFOs)',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST reject archive entries that are not regular files, directories, or (in-dir) links — device nodes and FIFOs MUST NOT be materialized. (Den-proposed; not yet in the SEP.)',
  },
  {
    key: 'adv-cumulative-budget',
    summary:
      'five ~45 MiB compressible archives from one server (~225 MiB unpacked aggregate, KB on the wire, over a 200 MiB budget)',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" (Den-proposed expansion): per-archive AND cumulative per-server size limits',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      "Host MUST enforce a cumulative per-server unpack budget, not just per-archive: once the server's budget is spent, further unpacking (e.g. the 5th of several ~45 MiB skills from one server) MUST be refused. (Den-proposed; not yet in the SEP.)",
  },
  {
    key: 'adv-archive-windows-paths',
    summary: 'tar entries with backslash, drive-absolute (C:\\) and UNC (\\\\host\\share) names',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" MUSTs: entry paths MUST be relative and "/"-separated — Windows anchors are absolute/non-conforming',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST reject Windows path anchors too: backslash separators, drive-absolute (C:\\...) and UNC (\\\\host\\share) entry names MUST NOT be honored — a POSIX-only "/"-split validator is insufficient on Windows.',
  },
  {
    key: 'adv-archive-normalization-collision',
    summary:
      'tar.gz ships SKILL.md AND a case-fold variant (Skill.md) that overwrites it on a case-insensitive / normalizing FS',
    sepClause:
      'Archives §"Unpacking" (Den-proposed expansion): reject Unicode-normalization / case-fold path collisions that can silently overwrite SKILL.md',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST normalize entry names (Unicode normalization + case-folding) before its duplicate/overwrite check: two names that map to the same path on a case-insensitive or normalizing filesystem (e.g. SKILL.md vs Skill.md, or an NFC/NFD pair) MUST NOT silently overwrite the digest-verified SKILL.md — the colliding entry MUST be rejected. (Den-proposed; not yet in the SEP.)',
  },
  {
    key: 'adv-zip-traversal',
    summary: 'ZIP with ../../evil.txt and an absolute-path entry (exercises the zip extractor)',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" MUSTs: reject traversal/absolute paths — applies to ZIP delivery too',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST apply Zip-Slip guards in its ZIP extractor (not only tar): ".." and absolute entry paths MUST be rejected before unpacking.',
  },
  {
    key: 'adv-zip-symlink-escape',
    summary: 'ZIP symlink "id_rsa.example" -> ../../../etc/passwd via S_IFLNK external attrs',
    sepClause: 'DEFERRED (archives are not in the v1 SEP; see the SEP Appendix). Archives §"Unpacking" MUSTs: reject links resolving outside the skill dir — applies to ZIP symlinks too',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST detect ZIP symlinks (S_IFLNK in the central-directory external attributes), not just tar symlink entries; a link resolving outside the skill dir MUST be rejected.',
  },
  {
    key: 'adv-frontmatter-mismatch',
    summary: 'skills/list entry frontmatter differs field-by-field from served SKILL.md',
    sepClause:
      'skills/list entry §"frontmatter" (current MUST): "The frontmatter object MUST be identical in content to the frontmatter of the SKILL.md it describes" — this entry diverges from the served SKILL.md, and §Integrity requires the host to re-parse the fetched SKILL.md field-by-field',
    denItem: 'B2',
    expectedAction: 'gate',
    oracle:
      "The served index VIOLATES a current SEP MUST (index frontmatter MUST be identical to the SKILL.md's); a host MUST re-parse the SKILL.md it actually fetched and treat the mismatch as a verification failure — index frontmatter is not authoritative. (Field-by-field re-verification is Den B2(1)'s proposed escalation.)",
  },
  {
    key: 'adv-supporting-file-digest-swap',
    summary: 'url-only skill; supporting scripts/helper.sh is fetched undigested (only SKILL.md is pinned)',
    sepClause: 'skills/list entry §"resources" (current MUST): the resources set MUST enumerate every file with a digest; this fixture SERVES a supporting file but OMITS it from resources, so it is unlisted — a read of it is a verification failure (§Integrity and verification)',
    denItem: 'B1',
    expectedAction: 'gate',
    oracle:
      'Host MUST NOT assume supporting files are integrity-protected; bytes not covered by a digest MUST be treated as untrusted and gated before any execution.',
  },
  {
    key: 'adv-live-read-divergence',
    summary: 'archive copy of scripts/helper.sh is digest-verified; live resources/read returns different bytes',
    sepClause:
      'DEFERRED (archive feature, not in the v1 SEP). Integrity & verification: after digest-verifying an archive, serve every file read from the verified unpacked copy, not live resources/read — the same serve-from-verified-copy principle the v1 SEP applies to the install/cache path',
    denItem: 'B2',
    expectedAction: 'gate',
    oracle:
      "Once a host digest-verifies an archive, it MUST serve every subsequent read of that skill's files from the verified unpacked copy — NOT from live resources/read, which here returns different bytes than the verified archive contained. (Den-proposed; not yet in the SEP.)",
  },
  {
    key: 'adv-allowed-tools-grant',
    summary: 'frontmatter declares allowed-tools: [Bash, Write] for an MCP-origin skill',
    sepClause: 'Security (Den-proposed): ignore permission-widening fields (allowed-tools) for MCP-origin skills',
    denItem: 'D5',
    expectedAction: 'gate',
    oracle:
      'Host MUST ignore allowed-tools (and any field that widens tool/filesystem permissions) for MCP-origin skills unless the user has explicitly approved that grant for this specific skill. (Den-proposed; not yet in the SEP.)',
  },
  {
    key: 'adv-content-rotation',
    summary: 'same URI returns different SKILL.md bytes/digest on the 2nd read (TOCTOU)',
    sepClause:
      'Integrity & verification (SEP line 204) + Den-proposed D7 (content-bound approval): re-verified content that no longer matches the digest MUST NOT be used; binding persisted approval to the digest is Den-proposed',
    denItem: 'D7',
    expectedAction: 'reject',
    oracle:
      "A host that re-verifies MUST reject the rotated read — the new bytes no longer match the entry's resources digest (§Integrity and verification). The v1 SEP also binds persisted per-skill approval to the entry's resources set (§Content-bound approval): a later entry advertising a different set revokes the approval and re-prompts.",
  },
  {
    key: 'refunds',
    summary: 'two archive-only skills at skill://acme/{billing,support}/refunds, frontmatter.name="refunds" (DEFERRED archive feature)',
    sepClause:
      'RESOLVED by the v1 SEP: a skill is identified by its `uri`, not its `name` (§Names), so these two no longer collide. Retained as a DEFERRED archive-only fixture — archives are not in the v1 SEP',
    denItem: 'A2',
    expectedAction: 'reject',
    oracle:
      'The v1 SEP resolves this for listed skills (identified by `uri`, §Names), but archives are DEFERRED — under the pre-v1 archive draft, archive-only skills were addressed by frontmatter.name, so both "refunds" collapse to skill://refunds/… and COLLIDE (the A2 bug this fixture preserves). Den A2 PROPOSES keying by the full skill:// authority (preserving the path prefix) so the two stay distinct. (Den-proposed; not yet in the SEP.)',
  },
  {
    key: 'adv-cross-server-read',
    summary: 'SKILL.md body induces resources/read of skill://other-server.example/exfil/secrets.md (different origin)',
    sepClause: 'Skills §trust boundary: a skill from one server MUST NOT cause reads against another server origin',
    denItem: 'D4',
    expectedAction: 're-prompt',
    oracle:
      'Host MUST NOT auto-follow cross-origin resource references embedded in skill content; any read of a different server origin MUST be re-prompted/confirmed and origin-isolated.',
  },
  {
    key: 'adv-file-url',
    summary: 'the skills/list entry advertises a file: URI (as the SKILL.md uri and its resources entry), both file:///… and the no-authority file:/… form',
    sepClause:
      'Resources §"Each uri MUST be the skill\'s SKILL.md or a file within the skill\'s directory" + trust boundary (Den D4, adjacent): a file: URI is an out-of-band local-file origin, never a skill:// resource — surfaced in the PR #831 hardening follow-up',
    denItem: 'D4',
    expectedAction: 'reject',
    oracle:
      'The SEP permits non-skill:// schemes for a server\'s own resources (§Resource Mapping), so the violation is NOT "the scheme isn\'t skill://" — it is that a file: URI names an out-of-band LOCAL-FILESYSTEM origin, never a resource the server serves. A host MUST NOT resolve it, and MUST match on the URL SCHEME, not a "file://" prefix: the no-authority RFC 8089 forms file:/etc/passwd and file:etc/passwd slip past a startswith("file://") check yet still read the local filesystem. (Research: PR #831 follow-up; not yet in the SEP.)',
  },
  {
    key: 'adv-oversized-payload',
    summary: 'url-only skill whose SKILL.md resource is ~16 MiB — far over any sane raw cap',
    sepClause:
      'Resource-fetch size bound (Den C1, extended to the fetch layer): size limits must apply when a resource is FETCHED/decoded, not only after any (deferred) archive unpack — surfaced in the PR #831 hardening follow-up',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST bound the raw size of a fetched resource BEFORE fully reading and base64-decoding (and hashing) it. The index is size-capped before parse; the artifact fetch (SKILL.md, archive blob, supporting file) MUST be too — honoring the advertised Resource.size and capping the read regardless — or a multi-GB payload exhausts host memory at install time. (Research: PR #831 follow-up; not yet in the SEP.)',
  },
  {
    key: 'adv-walk-budget',
    summary:
      'a url-only skill dragging ~27 MiB of undigested supporting files via the directory walk, on a server whose archives have already neared the per-server budget',
    sepClause:
      'Archives §"Unpacking" (Den C1, extended): the cumulative per-server size budget must cover the url+supporting-files directory-walk path, not only archives — surfaced in the PR #831 hardening follow-up',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      "Host MUST apply its cumulative per-server unpack budget to walk-fetched supporting files too, not only archive bytes: each file here is under a sane per-file cap, but several url-only skills from one server cumulatively exceed the budget. A budget enforced only in the archive extractor leaves this (arguably more unbounded) path open. (Research: PR #831 follow-up; not yet in the SEP.)",
  },

  // ---------------------------------------------------------------------------
  // New threats introduced by the current sep/skills-extension revision (index.json
  // -> skills/list + skills/get, per-file `resources` digests, archives deferred),
  // tracked in the WG threat model. `denItem` reuses the closest existing bucket for
  // smoke-client display; the precise, honest attribution lives in `sepClause`. See
  // docs/reconciliation-plan.md — these entries and the field's semantics are under review.
  // ---------------------------------------------------------------------------
  {
    key: 'adv-nested-consent',
    summary:
      'an approved skill bundles a nested SKILL.md (nested-danger/SKILL.md) whose frontmatter declares allowed-tools',
    sepClause:
      'Security §"Nested skill consent" (current MUST): approving a skill does not approve skills nested in it; a nested SKILL.md\'s frontmatter MUST NOT be acted on until that nested skill is itself activated under its own approval',
    denItem: 'D5',
    expectedAction: 'gate',
    oracle:
      "Host MUST treat the nested SKILL.md as an ordinary supporting file: it MUST NOT act on the nested frontmatter (allowed-tools, hooks) on the strength of the enclosing skill's approval. Activating the nested skill requires fresh, explicit per-skill consent. (SEP-current; no prior corpus fixture.)",
  },
  {
    key: 'adv-directory-walk-escape',
    summary:
      'resources/directory/read returns a child Resource whose URI resolves outside the skill subtree (or into another origin)',
    sepClause:
      'Resources §completeness + Security §"Origin-scoped resource reads": each `resources` URI MUST be within the skill dir; a read of any URI not in the entry\'s `resources` set is a verification failure',
    denItem: 'D4',
    expectedAction: 'reject',
    oracle:
      'Host MUST NOT treat a directory listing as authorization to read a URI absent from the skill\'s `resources` set: an enumerated child that resolves outside the skill subtree or into a different origin MUST be rejected, not merely gated. resources/directory/read returns metadata only; blindly fetching its children is the escape. (SEP-current; no prior corpus fixture.)',
  },
  {
    key: 'adv-name-collision',
    summary:
      "a second origin publishes a skill under a trusted skill's name (another server's or the host's filesystem skill), counting on the host to resolve its way",
    sepClause:
      'Security §"Name collisions are an impersonation surface": names are not unique across origins; a skill is identified by its `uri`, not its `name`',
    denItem: 'D4',
    expectedAction: 're-prompt',
    oracle:
      "Host MUST resolve skill names within a per-origin namespace (servers identified by a host-assigned label, not self-reported serverInfo.name) and MUST NOT let an MCP-origin skill silently shadow, replace, or intercept a same-named skill from any other origin — including the host's own filesystem skills; collisions SHOULD be surfaced to the user. (SEP-current; distinct from the archive-only `refunds` keying bug.)",
  },
  {
    key: 'adv-enumeration-exhaustion',
    summary:
      'skills/list (or resources/directory/read) returns an unbounded stream of pages via an endless nextCursor, exhausting the host at discovery time before any file is fetched',
    sepClause:
      'Enumeration §pagination (skills/list, resources/directory/read): cursor pagination is defined but neither page count nor total entry count is bounded; ttlMs/cacheScope are freshness hints, not a bound',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      "Host MUST cap the number of pages (or total entries) it will follow from a single server's enumeration and treat a listing that refuses to terminate as a resource-exhaustion attack; the exhaustion surface begins BEFORE any resource is read. (SEP-current; extends the C1 budget theme to the enumeration layer.)",
  },
];

const byKey = new Map(ADVERSARIAL_CASES.map((c) => [c.key, c]));

/** Look up a case by key; throws if missing (a builder referenced an unknown case). */
export function requireCase(key: string): AdversarialCase {
  const c = byKey.get(key);
  if (!c) throw new Error(`No adversarial case in catalog for key "${key}"`);
  return c;
}
