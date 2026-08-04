/**
 * skills.ts — Build SEP-2640 skill entries: the shape returned by `skills/list`
 * and `skills/get`. Replaces the removed `skill://index.json` document.
 *
 * An entry is:
 *   {
 *     "uri": "skill://<authority>/SKILL.md",
 *     "frontmatter": { <all YAML fields, incl. name+description> },
 *     "resources": [ { "uri": "skill://<authority>/<relPath>", "digest": "sha256:<hex>" }, ... ]
 *   }
 *
 * `resources` is the COMPLETE per-file digest set (SEP §Resources: every file of the
 * skill, each exactly once, including an entry for SKILL.md). It MAY be omitted only
 * for dynamically generated skills; the corpus has none, so faithful skills always
 * carry it.
 *
 * Adversarial overrides (kept out of the faithful set; see adversarial/index.ts):
 *   - indexFrontmatterOverride — entry.frontmatter diverges from the served SKILL.md
 *     (adv-frontmatter-mismatch).
 *   - omitFromResources — relPaths dropped from `resources`, so a served file is
 *     UNLISTED; a read of an unlisted file is a verification failure
 *     (adv-supporting-file-digest-swap, now expressed against the complete set).
 *   - indexUrlOverride — replaces the SKILL.md entry/`resources` URI with an
 *     out-of-scheme URL; each `resources` URI MUST be a skill:// file within the dir
 *     (adv-file-url).
 */
import { fileUri, sha256, skillAuthority, type Skill } from './corpus.js';

export interface ResourceDigest {
  uri: string;
  digest: string;
}

export interface SkillEntry {
  /** Resource URI of the skill's SKILL.md. */
  uri: string;
  /** Verbatim SKILL.md frontmatter as JSON. */
  frontmatter: Record<string, unknown>;
  /** Complete per-file digest set. Omitted only for dynamically generated skills. */
  resources?: ResourceDigest[];
}

type WithOverrides = Skill & {
  indexFrontmatterOverride?: Record<string, unknown>;
  indexUrlOverride?: string;
  omitFromResources?: string[];
};

/** Build the complete `resources` digest set for a skill (every served file, SKILL.md included). */
export function buildResourceDigests(skill: Skill): ResourceDigest[] {
  const s = skill as WithOverrides;
  const omit = new Set(s.omitFromResources ?? []);
  const entries: ResourceDigest[] = [];
  for (const file of skill.files) {
    if (omit.has(file.relPath)) continue;
    const uri =
      file.relPath === 'SKILL.md' && s.indexUrlOverride
        ? s.indexUrlOverride
        : fileUri(skill, file.relPath);
    entries.push({ uri, digest: sha256(file.bytes) });
  }
  return entries;
}

/** Build one SEP skill entry (uri + frontmatter + complete resources). */
export function buildSkillEntry(skill: Skill): SkillEntry {
  const s = skill as WithOverrides;
  return {
    uri: s.indexUrlOverride ?? fileUri(skill, 'SKILL.md'),
    frontmatter: s.indexFrontmatterOverride ?? skill.frontmatter,
    resources: buildResourceDigests(skill),
  };
}

/** Build the full catalog of entries, ordered by URI (stable). */
export function buildSkillsCatalog(skills: Skill[]): SkillEntry[] {
  return skills.map(buildSkillEntry).sort((a, b) => a.uri.localeCompare(b.uri));
}

export { skillAuthority };
