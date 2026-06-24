/**
 * index-json.ts — Build the `skill://index.json` document per SEP-2640.
 *
 * Shape:
 * {
 *   "skills": [
 *     {
 *       "url": "skill://<authority>/SKILL.md",
 *       "digest": "sha256:<hex of raw SKILL.md bytes>",
 *       "frontmatter": { <all yaml fields, incl. name+description> },
 *       "archives": [ { "url": "skill://<authority>.tar.gz", "mimeType": "...", "digest": "sha256:<hex of archive bytes>" } ]
 *     }
 *   ]
 * }
 */
import { archiveUri, fileUri, skillAuthority, type Skill } from './corpus.js';
import type { ArchiveBlob } from './archives.js';

export interface IndexArchiveEntry {
  url: string;
  mimeType: string;
  digest: string;
}

export interface IndexSkillEntry {
  /** Resource URI of SKILL.md. Present unless the skill is archive-only. */
  url?: string;
  /** sha256 of raw SKILL.md bytes. Present iff `url` is present (SEP: "absent otherwise"). */
  digest?: string;
  frontmatter: Record<string, unknown>;
  /** Archive forms. Present unless the skill is url-only. Per SEP, when present it is non-empty. */
  archives?: IndexArchiveEntry[];
}

export interface SkillsIndex {
  skills: IndexSkillEntry[];
}

/** A skill plus its built archive blobs, as held by the server. */
export interface ServedSkill {
  skill: Skill;
  archives: ArchiveBlob[];
}

/**
 * Build one index entry. Honors:
 *   - `skill.delivery` — archive-only entries omit `url`/`digest`; url-only entries
 *     omit `archives` (SEP: "Every entry MUST include url, a non-empty archives, or
 *     both"; "digest MUST be present when url is present, absent otherwise").
 *   - the adversarial `indexFrontmatterOverride`: when present, the index advertises
 *     tampered frontmatter while the served SKILL.md keeps the honest one
 *     (frontmatter-mismatch fixture, Den B2).
 *   - the adversarial `indexUrlOverride`: when present, the entry's `url` is replaced
 *     (e.g. a `file:` URL) while the real SKILL.md stays served at its skill:// URI
 *     (file-url fixture).
 */
export function buildIndexEntry(served: ServedSkill): IndexSkillEntry {
  const { skill, archives } = served;
  const override = (skill as Skill & { indexFrontmatterOverride?: Record<string, unknown> })
    .indexFrontmatterOverride;
  const entry: IndexSkillEntry = { frontmatter: override ?? skill.frontmatter };
  if (skill.delivery !== 'archive-only') {
    const urlOverride = (skill as Skill & { indexUrlOverride?: string }).indexUrlOverride;
    entry.url = urlOverride ?? fileUri(skill, 'SKILL.md');
    entry.digest = skill.skillMdDigest;
  }
  if (archives.length > 0) {
    entry.archives = archives.map((a) => ({
      url: archiveUri(skill, a.kind),
      mimeType: a.mimeType,
      digest: a.digest,
    }));
  }
  return entry;
}

/** Stable sort key: the entry's url, or its first archive url for archive-only entries. */
function entrySortKey(e: IndexSkillEntry): string {
  return e.url ?? e.archives?.[0]?.url ?? '';
}

export function buildIndex(served: ServedSkill[]): SkillsIndex {
  return {
    skills: served
      .map(buildIndexEntry)
      .sort((a, b) => entrySortKey(a).localeCompare(entrySortKey(b))),
  };
}

export function indexJsonBytes(index: SkillsIndex): Buffer {
  return Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf8');
}

export { skillAuthority };
