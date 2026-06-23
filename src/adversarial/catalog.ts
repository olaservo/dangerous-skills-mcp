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
    sepClause: 'Archives §"Unpacking" MUSTs: reject entries that escape the destination directory',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST refuse to unpack: every entry path must resolve inside the skill dir; ".." segments and absolute paths MUST be rejected (no Zip-Slip).',
  },
  {
    key: 'adv-archive-symlink-escape',
    summary: 'symlink entry "id_rsa.example" -> ../../../etc/passwd (benign decoy)',
    sepClause: 'Archives §"Unpacking" MUSTs: symlink entries that resolve outside the destination MUST be rejected',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST NOT create symlinks on unpack (or MUST verify the resolved target stays inside the skill dir); a link escaping the dir MUST be rejected.',
  },
  {
    key: 'adv-archive-hardlink-escape',
    summary: 'hard-link entry "creds.example" -> ../../../etc/passwd (benign decoy)',
    sepClause: 'Archives §"Unpacking" MUSTs: reject symlinks OR HARD LINKS that resolve outside the skill dir',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST reject hard links (tar typeflag 1) as well as symlinks when the link target resolves outside the skill dir; the current SEP names hard links explicitly.',
  },
  {
    key: 'adv-decompression-bomb',
    summary: 'few-KB tar.gz expanding to ~128 MiB (single entry over any sane bound)',
    sepClause: 'Archives §"Unpacking" MUSTs: enforce a maximum expanded size / entry count',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST cap total expanded bytes and per-entry size; an archive exceeding the bound MUST be rejected before fully expanding.',
  },
  {
    key: 'adv-archive-setuid',
    summary: 'supporting file "tools/escalate" with setuid bit (mode 04755)',
    sepClause: 'Archives §"Unpacking" (Den-proposed expansion): clear setuid/setgid/sticky bits; extract as host uid/gid',
    denItem: 'C1',
    expectedAction: 'sanitize',
    oracle:
      'Host MUST clear setuid/setgid/sticky bits and extract as the host\'s own uid/gid; it MUST NOT preserve a server-authored setuid bit. (Den-proposed; not yet in the SEP.)',
  },
  {
    key: 'adv-archive-non-regular',
    summary: 'non-regular file entry "pipe.fifo" (FIFO, typeflag 6)',
    sepClause: 'Archives §"Unpacking" (Den-proposed expansion): reject non-regular file types (device nodes, FIFOs)',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST reject archive entries that are not regular files, directories, or (in-dir) links — device nodes and FIFOs MUST NOT be materialized. (Den-proposed; not yet in the SEP.)',
  },
  {
    key: 'adv-cumulative-budget',
    summary: 'two ~30 MiB archives from one server (~60 MiB aggregate, over a 50 MiB budget)',
    sepClause: 'Archives §"Unpacking" (Den-proposed expansion): per-archive AND cumulative per-server size limits',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      "Host MUST enforce a cumulative per-server unpack budget, not just per-archive: once the server's budget is spent, further unpacking (e.g. the 2nd of several ~30 MiB skills from one server) MUST be refused. (Den-proposed; not yet in the SEP.)",
  },
  {
    key: 'adv-archive-windows-paths',
    summary: 'tar entries with backslash, drive-absolute (C:\\) and UNC (\\\\host\\share) names',
    sepClause: 'Archives §"Unpacking" MUSTs: entry paths MUST be relative and "/"-separated — Windows anchors are absolute/non-conforming',
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
    sepClause: 'Archives §"Unpacking" MUSTs: reject traversal/absolute paths — applies to ZIP delivery too',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST apply Zip-Slip guards in its ZIP extractor (not only tar): ".." and absolute entry paths MUST be rejected before unpacking.',
  },
  {
    key: 'adv-zip-symlink-escape',
    summary: 'ZIP symlink "id_rsa.example" -> ../../../etc/passwd via S_IFLNK external attrs',
    sepClause: 'Archives §"Unpacking" MUSTs: reject links resolving outside the skill dir — applies to ZIP symlinks too',
    denItem: 'C1',
    expectedAction: 'reject',
    oracle:
      'Host MUST detect ZIP symlinks (S_IFLNK in the central-directory external attributes), not just tar symlink entries; a link resolving outside the skill dir MUST be rejected.',
  },
  {
    key: 'adv-frontmatter-mismatch',
    summary: 'index.json frontmatter differs field-by-field from served SKILL.md',
    sepClause:
      'index.json §"frontmatter" (current MUST): "The frontmatter object MUST be identical in content to the frontmatter of the SKILL.md it describes" — this index diverges from the served SKILL.md; Den B2(1) escalates to field-by-field host re-verification',
    denItem: 'B2',
    expectedAction: 'gate',
    oracle:
      "The served index VIOLATES a current SEP MUST (index frontmatter MUST be identical to the SKILL.md's); a host MUST re-parse the SKILL.md it actually fetched and treat the mismatch as a verification failure — index frontmatter is not authoritative. (Field-by-field re-verification is Den B2(1)'s proposed escalation.)",
  },
  {
    key: 'adv-supporting-file-digest-swap',
    summary: 'url-only skill; supporting scripts/helper.sh is fetched undigested (only SKILL.md is pinned)',
    sepClause: 'index.json §"digest": only SKILL.md is digested; supporting files fetched via resources/read are unpinned',
    denItem: 'B1',
    expectedAction: 'gate',
    oracle:
      'Host MUST NOT assume supporting files are integrity-protected; bytes not covered by a digest MUST be treated as untrusted and gated before any execution.',
  },
  {
    key: 'adv-live-read-divergence',
    summary: 'archive copy of scripts/helper.sh is digest-verified; live resources/read returns different bytes',
    sepClause:
      'Integrity & verification (Den-proposed B2(2)): after digest-verifying an archive, serve every file read from the verified unpacked copy, not live resources/read',
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
      'A host that re-verifies MUST reject the rotated read — the new bytes no longer match the index digest (SEP line 204). Beyond that, Den D7 PROPOSES binding any persisted per-skill approval to the SKILL.md digest and re-prompting when a later read advertises a different digest under the same URI. (Digest-bound approval is Den-proposed; not yet in the SEP.)',
  },
  {
    key: 'refunds',
    summary: 'two archive-only skills at skill://acme/{billing,support}/refunds, frontmatter.name="refunds"',
    sepClause:
      'Archives §addressing: the CURRENT SEP unpacks archive-only skills under skill://<frontmatter.name>/… — Den A2 proposes preserving the full path prefix',
    denItem: 'A2',
    expectedAction: 'reject',
    oracle:
      'Per the CURRENT SEP, archive-only skills are addressed by frontmatter.name, so both "refunds" collapse to skill://refunds/… and COLLIDE — this fixture demonstrates the A2 bug. Den A2 PROPOSES keying by the full skill:// authority (preserving the path prefix) so the two stay distinct. (Den-proposed; not yet in the SEP.)',
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
    summary: 'index advertises a file: artifact url, both file:///… and the no-authority file:/… form',
    sepClause:
      'Skills §resource addressing + trust boundary (Den D4, adjacent): artifact urls are skill:// MCP resource URIs; a file: url is an out-of-band local-file origin — surfaced in the PR #831 hardening follow-up',
    denItem: 'D4',
    expectedAction: 'reject',
    oracle:
      'Host MUST refuse non-skill:// artifact urls — especially file: — and MUST match on the URL SCHEME, not a "file://" prefix: the no-authority RFC 8089 forms file:/etc/passwd and file:etc/passwd slip past a startswith("file://") check yet still read the local filesystem. (Research: PR #831 follow-up; not yet in the SEP.)',
  },
];

const byKey = new Map(ADVERSARIAL_CASES.map((c) => [c.key, c]));

/** Look up a case by key; throws if missing (a builder referenced an unknown case). */
export function requireCase(key: string): AdversarialCase {
  const c = byKey.get(key);
  if (!c) throw new Error(`No adversarial case in catalog for key "${key}"`);
  return c;
}
