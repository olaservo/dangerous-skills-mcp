/**
 * corpus.ts — Read the vendored "dangerous skills" corpus from disk and model it
 * as addressable skill resources under the `skill://` URI scheme (SEP-2640).
 *
 * Corpus: gricha/dangerous-skills, MIT (c) 2026 Greg Pstrucha. Payloads are benign
 * (write markers / print canaries). We never serve EXPLANATION.md (it is corpus meta).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default corpus root, relative to this file: ../third_party/dangerous-skills/skills */
export const DEFAULT_SKILLS_ROOT = path.resolve(__dirname, '..', 'third_party', 'dangerous-skills', 'skills');

export function resolveSkillsRoot(): string {
  return process.env.SKILLS_ROOT ? path.resolve(process.env.SKILLS_ROOT) : DEFAULT_SKILLS_ROOT;
}

/** A single served file within a skill. `relPath` is POSIX-style, relative to the skill dir. */
export interface SkillFile {
  /** POSIX-relative path within the skill, e.g. "SKILL.md" or "scripts/foo.sh". */
  relPath: string;
  /** Absolute path on disk (undefined for synthetic adversarial files held in memory). */
  absPath?: string;
  /** Raw bytes. */
  bytes: Buffer;
  mimeType: string;
  /** True for text mime types served as `text`, false for blobs served as base64 `blob`. */
  isText: boolean;
}

export interface Skill {
  /** frontmatter.name — the final `<skill-path>` segment in the skill:// URI. */
  name: string;
  /** All YAML frontmatter fields (must include name + description). */
  frontmatter: Record<string, unknown>;
  /** Files served for this skill (SKILL.md first). EXPLANATION.md is excluded. */
  files: SkillFile[];
  /** sha256 of the raw SKILL.md bytes (the skill-entry digest in index.json). */
  skillMdDigest: string;
  /**
   * Optional archive path prefix for naming-collision fixtures. When set, the
   * skill:// authority becomes `<pathPrefix>/<name>` rather than just `<name>`.
   * Faithful corpus skills leave this undefined.
   */
  pathPrefix?: string;
  /**
   * SEP-2640 delivery configuration for this skill's index entry:
   *   - undefined / `'both'`: individually-addressable `url`+`digest` AND archives
   *     (the default; what the faithful corpus uses).
   *   - `'archive-only'`: files are NOT individually addressable — only the archive
   *     is served and the index entry omits `url`/`digest`. The host must unpack the
   *     archive locally to address its contents (SEP "Archives": archive-only path).
   *   - `'url-only'`: individually addressable via `url`+`digest`; no archive offered.
   */
  delivery?: 'archive-only' | 'url-only';
}

/** Files we never serve as part of a skill (corpus meta). */
const EXCLUDED_FILES = new Set(['EXPLANATION.md']);

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.sh',
  '.py',
  '.js',
  '.ts',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.cfg',
  '.ini',
  '.example',
  '.dockerfile',
  '.env',
  '.gitignore',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.example': 'text/plain',
};

export function mimeForPath(relPath: string): string {
  const base = path.basename(relPath).toLowerCase();
  if (base === 'dockerfile') return 'text/x-dockerfile';
  const ext = path.extname(relPath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function isTextPath(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  if (base === 'dockerfile') return true;
  const ext = path.extname(relPath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function sha256(bytes: Buffer): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/** Parse the YAML frontmatter block delimited by leading `---` fences. */
export function parseFrontmatter(skillMd: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match) {
    throw new Error('SKILL.md is missing a YAML frontmatter block');
  }
  const parsed = parseYaml(match[1]);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('SKILL.md frontmatter did not parse to an object');
  }
  return parsed as Record<string, unknown>;
}

async function walkFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs, base)));
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs));
    }
    // Symlinks in the faithful corpus (e.g. ssh-helper) are followed as files by
    // isFile() only when they resolve; if they dangle we simply skip them.
  }
  return out;
}

async function loadSkillDir(skillDir: string): Promise<Skill> {
  const skillMdAbs = path.join(skillDir, 'SKILL.md');
  const skillMdBytes = await fs.readFile(skillMdAbs);
  const frontmatter = parseFrontmatter(skillMdBytes.toString('utf8'));
  const name = frontmatter.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Skill at ${skillDir} has no string frontmatter.name`);
  }
  if (typeof frontmatter.description !== 'string') {
    throw new Error(`Skill "${name}" frontmatter is missing a string description`);
  }
  // SEP-2640 / Agent Skills: the name (final skill-path segment) MUST be lowercase
  // letters, digits, and hyphens only. Enforce it rather than trusting the corpus.
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Skill "${name}" has an invalid name (must match /^[a-z0-9-]+$/)`);
  }

  const relFiles = (await walkFiles(skillDir))
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => !EXCLUDED_FILES.has(path.basename(p)));
  // SEP-2640: a SKILL.md MUST NOT appear in any descendant directory of a skill.
  const nestedSkillMd = relFiles.find((p) => p !== 'SKILL.md' && path.basename(p) === 'SKILL.md');
  if (nestedSkillMd) {
    throw new Error(`Skill "${name}" has a nested SKILL.md at ${nestedSkillMd} (skills must not nest)`);
  }

  // SKILL.md first, then a stable sort for determinism.
  relFiles.sort((a, b) => {
    if (a === 'SKILL.md') return -1;
    if (b === 'SKILL.md') return 1;
    return a.localeCompare(b);
  });

  const files: SkillFile[] = [];
  for (const relPath of relFiles) {
    const absPath = path.join(skillDir, ...relPath.split('/'));
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absPath);
    } catch {
      // Dangling symlink (e.g. ssh-helper's id_rsa.example may point off-box on
      // some checkouts). Skip rather than crash — the faithful corpus is read-only.
      continue;
    }
    files.push({
      relPath,
      absPath,
      bytes,
      mimeType: mimeForPath(relPath),
      isText: isTextPath(relPath),
    });
  }

  return {
    name,
    frontmatter,
    files,
    skillMdDigest: sha256(skillMdBytes),
  };
}

/** Load every skill subdirectory under the corpus root. */
export async function loadCorpus(root = resolveSkillsRoot()): Promise<Skill[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const loaded: Array<{ dir: string; skill: Skill }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(root, entry.name);
    try {
      loaded.push({ dir: entry.name, skill: await loadSkillDir(skillDir) });
    } catch (err) {
      // Surface but don't abort the whole corpus for one malformed skill.
      process.stderr.write(`[corpus] skipping ${entry.name}: ${(err as Error).message}\n`);
    }
  }

  // SEP-2640: a skill is addressed by its skill:// authority, whose final segment
  // is frontmatter.name. Two corpus skills that declare the SAME frontmatter.name
  // (e.g. dirs `code-review` and `code-review-remote` both use `name: review-staged`)
  // would otherwise collapse to one authority — one silently overwriting the other
  // in the resource map and yielding two index entries with the same `url` but
  // different `digest` (so a host verifying the losing entry gets a digest mismatch
  // and MUST refuse legitimate content). Disambiguate by giving each colliding skill
  // its source-directory name as a path prefix (`skill://<dir>/<name>/…`) — exactly
  // the prefix mechanism the SEP defines for this case (final segment stays the
  // name). Non-colliding skills are left prefix-free.
  const byName = new Map<string, Array<{ dir: string; skill: Skill }>>();
  for (const item of loaded) {
    const group = byName.get(item.skill.name) ?? [];
    group.push(item);
    byName.set(item.skill.name, group);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const { dir, skill } of group) {
      skill.pathPrefix = dir;
      process.stderr.write(
        `[corpus] frontmatter.name collision on "${skill.name}": disambiguating to skill://${dir}/${skill.name}\n`,
      );
    }
  }

  const skills = loaded.map((l) => l.skill);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** The skill:// authority (path) for a skill: `<pathPrefix>/<name>` or `<name>`. */
export function skillAuthority(skill: Skill): string {
  return skill.pathPrefix ? `${skill.pathPrefix}/${skill.name}` : skill.name;
}

/** Build the skill:// URI for a file within a skill. */
export function fileUri(skill: Skill, relPath: string): string {
  return `skill://${skillAuthority(skill)}/${relPath}`;
}

/** Build the skill:// URI for a skill's archive of the given kind. */
export function archiveUri(skill: Skill, kind: 'tar.gz' | 'zip'): string {
  return `skill://${skillAuthority(skill)}.${kind}`;
}
