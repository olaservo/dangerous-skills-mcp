/**
 * skills.ts — Build SEP-2640 skill entries: the shape returned by `skills/list`
 * and `skills/get`. Replaces the removed `skill://index.json` document.
 *
 * An entry is:
 *   {
 *     "uri": "skill://<authority>/SKILL.md",
 *     "frontmatter": { <all YAML fields, incl. name+description> },
 *     "resources": [ { "uri": "skill://<authority>/<relPath>",
 *                      "digest": "sha256:<hex>", "size": <bytes> }, ... ]
 *                  | "dynamic"
 *   }
 *
 * `resources` is REQUIRED on every entry (stable spec §Resources) and takes one of
 * two forms:
 *   - the COMPLETE per-file set: every file of the skill, each exactly once, including
 *     an entry for SKILL.md itself. Each item carries the sha256 `digest` of the raw
 *     bytes AND their byte `size` — a read whose length differs from `size` is a
 *     verification failure equivalent to a digest mismatch, so `size` is computed
 *     from the very same bytes the digest covers;
 *   - the string "dynamic", for a skill whose content is generated such that stable
 *     digests cannot be published. An entry with no `resources` at all is invalid and
 *     hosts MUST NOT load it, so a generated skill is expressed with "dynamic" rather
 *     than by omission.
 * The corpus has no dynamic skills, so every faithful entry carries the array; the
 * `dynamic` override exists so a generated skill can be expressed the spec's way.
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
 *   - dynamic — entry.resources is the string "dynamic" (no fixture uses it today).
 * Every override leaves the remaining fields honest: `digest` and `size` are always
 * computed from the bytes actually registered for the file, so a fixture's deliberate
 * violation stays its only one.
 */
import { fileUri, sha256, skillAuthority, type Skill } from './corpus.js';

/** One item of a skill entry's `resources` array (spec `SkillResource`). */
export interface SkillResource {
  /** Resource URI of the file (a skill:// URI within the skill directory). */
  uri: string;
  /** `sha256:<64 lowercase hex>` over the file's raw bytes. */
  digest: string;
  /** Byte length of the raw content the digest covers. */
  size: number;
}

/** @deprecated Older name for {@link SkillResource}; kept for readers of earlier revisions. */
export type ResourceDigest = SkillResource;

export interface SkillEntry {
  /** Resource URI of the skill's SKILL.md. */
  uri: string;
  /** Verbatim SKILL.md frontmatter as JSON. */
  frontmatter: Record<string, unknown>;
  /** Complete per-file set, or the string "dynamic" for a generated skill. REQUIRED. */
  resources: SkillResource[] | 'dynamic';
}

type WithOverrides = Skill & {
  indexFrontmatterOverride?: Record<string, unknown>;
  indexUrlOverride?: string;
  omitFromResources?: string[];
  dynamic?: boolean;
};

/** Build the complete `resources` set for a skill (every served file, SKILL.md included). */
export function buildResourceDigests(skill: Skill): SkillResource[] {
  const s = skill as WithOverrides;
  const omit = new Set(s.omitFromResources ?? []);
  const entries: SkillResource[] = [];
  for (const file of skill.files) {
    if (omit.has(file.relPath)) continue;
    const uri =
      file.relPath === 'SKILL.md' && s.indexUrlOverride
        ? s.indexUrlOverride
        : fileUri(skill, file.relPath);
    // digest and size are computed from the SAME raw bytes, as the spec requires.
    entries.push({ uri, digest: sha256(file.bytes), size: file.bytes.length });
  }
  return entries;
}

/** Build one SEP skill entry (uri + frontmatter + complete resources or "dynamic"). */
export function buildSkillEntry(skill: Skill): SkillEntry {
  const s = skill as WithOverrides;
  return {
    uri: s.indexUrlOverride ?? fileUri(skill, 'SKILL.md'),
    frontmatter: s.indexFrontmatterOverride ?? skill.frontmatter,
    resources: s.dynamic ? 'dynamic' : buildResourceDigests(skill),
  };
}

/** Build the full catalog of entries, ordered by URI (stable). */
export function buildSkillsCatalog(skills: Skill[]): SkillEntry[] {
  return skills.map(buildSkillEntry).sort((a, b) => a.uri.localeCompare(b.uri));
}

export { skillAuthority };
