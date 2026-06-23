/**
 * resources.ts — The resource registry. Turns the loaded corpus (+ optional
 * adversarial profile) into:
 *   - a `skill://index.json` document,
 *   - per-skill archives (.tar.gz + .zip),
 *   - a flat map of readable resources (index, each SKILL.md, each supporting
 *     file, each archive),
 *   - a directory tree for `resources/directory/read`.
 *
 * SEP MUST honored: a skill is readable from its URI alone whether or not it is
 * in the index — the resource map is the source of truth for reads.
 */
import { archiveUri, fileUri, loadCorpus, skillAuthority, sha256, type Skill, type SkillFile } from './corpus.js';
import { packTarGz, packZip, type ArchiveBlob } from './archives.js';
import { buildIndex, indexJsonBytes, type ServedSkill, type SkillsIndex } from './index-json.js';
import { buildAdversarialFixtures, type AdversarialFixture } from './adversarial/index.js';

export const INDEX_URI = 'skill://index.json';

/** A readable resource (text or blob). */
export interface ReadableResource {
  uri: string;
  name: string;
  mimeType: string;
  /** Static bytes for the resource, OR a function returning bytes per read (rotation). */
  bytes: Buffer | ((readCount: number) => Buffer);
  isText: boolean;
  /** SEP: for a SKILL.md resource, set from frontmatter.description. */
  description?: string;
  /** SEP: additional frontmatter exposed under the io.modelcontextprotocol.skills/ prefix. */
  meta?: Record<string, unknown>;
}

/** A directory node (for resources/directory/read). */
export interface DirectoryNode {
  uri: string;
  name: string;
  /** Direct child URIs (files and subdirs), in stable order. */
  children: string[];
}

export interface ResourceListItem {
  uri: string;
  name: string;
  mimeType: string;
  /** Byte length of the resource (base-MCP Resource.size). Omitted for rotating/dir resources. */
  size?: number;
  /** SEP: frontmatter.description for SKILL.md resources. */
  description?: string;
  /** SEP: additional frontmatter under the io.modelcontextprotocol.skills/ prefix. */
  _meta?: Record<string, unknown>;
}

/** Reverse-domain prefix for skill-resource _meta keys (SEP-2640 Resource Metadata). */
export const SKILLS_META_PREFIX = 'io.modelcontextprotocol.skills/';

export interface RegistryOptions {
  /** When true, also serve the adversarial fixtures (separate profile). */
  adversarial?: boolean;
  /** Override the corpus root (else SKILLS_ROOT env or the default). */
  root?: string;
}

const DIRECTORY_MIME = 'inode/directory';

export class ResourceRegistry {
  private resources = new Map<string, ReadableResource>();
  private directories = new Map<string, DirectoryNode>();
  private readCounts = new Map<string, number>();
  private index!: SkillsIndex;
  private served: ServedSkill[] = [];
  private fixtures: AdversarialFixture[] = [];

  static async build(opts: RegistryOptions = {}): Promise<ResourceRegistry> {
    const reg = new ResourceRegistry();
    await reg.init(opts);
    return reg;
  }

  private async init(opts: RegistryOptions): Promise<void> {
    const faithful = await loadCorpus(opts.root);

    if (opts.adversarial) {
      this.fixtures = await buildAdversarialFixtures();
    }

    // Pack archives + register files for every served skill.
    for (const skill of faithful) {
      await this.addSkill(skill);
    }
    for (const fx of this.fixtures) {
      await this.addSkill(fx.skill, fx);
    }

    // Build the index from the served skills/archives, then register it.
    this.index = buildIndex(this.served);
    const indexBytes = indexJsonBytes(this.index);
    this.resources.set(INDEX_URI, {
      uri: INDEX_URI,
      name: 'index.json',
      mimeType: 'application/json',
      bytes: indexBytes,
      isText: true,
    });
  }

  private async addSkill(skill: Skill, fixture?: AdversarialFixture): Promise<void> {
    const auth = skillAuthority(skill);
    const delivery = skill.delivery ?? 'both';

    // Archives: url-only skills offer none; otherwise use the fixture's crafted
    // archives if present, else pack faithfully.
    let archives: ArchiveBlob[];
    if (delivery === 'url-only') {
      archives = [];
    } else if (fixture?.archives && fixture.archives.length > 0) {
      archives = fixture.archives;
    } else {
      // supporting-file-digest-swap may want a divergent archive copy.
      const archiveOverride = (skill as Skill & { archiveHelperOverride?: Buffer }).archiveHelperOverride;
      const skillForArchive = archiveOverride ? withArchiveHelper(skill, archiveOverride) : skill;
      archives = [await packTarGz(skillForArchive), await packZip(skillForArchive)];
    }

    // Register archive blob resources.
    for (const a of archives) {
      const uri = archiveUri(skill, a.kind);
      this.resources.set(uri, {
        uri,
        name: `${auth}.${a.kind}`,
        mimeType: a.mimeType,
        bytes: a.bytes,
        isText: false,
      });
    }

    // Register each served file as a readable resource — UNLESS the skill is
    // archive-only, where the SEP says files are not individually addressable on
    // the server (the host must unpack the archive to address them). So we serve
    // only the archive blob; a direct resources/read of skill://<auth>/SKILL.md
    // and resources/directory/read of skill://<auth> both correctly miss (-32602).
    if (delivery !== 'archive-only') {
      for (const file of skill.files) {
        const uri = fileUri(skill, file.relPath);
        let bytes: Buffer | ((readCount: number) => Buffer) = file.bytes;
        if (fixture?.rotateSkillMd && file.relPath === 'SKILL.md') {
          bytes = fixture.rotateSkillMd;
        }
        const isSkillMd = file.relPath === 'SKILL.md';
        // SEP Resource Metadata: a SKILL.md resource SHOULD carry name/description
        // from frontmatter and MAY expose the rest under the reserved _meta prefix.
        this.resources.set(uri, {
          uri,
          name: isSkillMd ? skill.name : file.relPath,
          mimeType: file.mimeType,
          bytes,
          isText: file.isText,
          ...(isSkillMd
            ? {
                description:
                  typeof skill.frontmatter.description === 'string'
                    ? skill.frontmatter.description
                    : undefined,
                meta: { [`${SKILLS_META_PREFIX}frontmatter`]: skill.frontmatter },
              }
            : {}),
        });
        this.registerDirectoriesForFile(auth, file.relPath);
      }
    }

    this.served.push({ skill, archives });
  }

  /** Ensure directory nodes exist for every path segment of a file, and link children. */
  private registerDirectoriesForFile(auth: string, relPath: string): void {
    const segments = relPath.split('/');
    // The skill root directory is skill://<auth>
    let parentUri = `skill://${auth}`;
    this.ensureDir(parentUri, auth.split('/').pop() ?? auth);

    for (let i = 0; i < segments.length; i++) {
      const childPath = segments.slice(0, i + 1).join('/');
      const childUri = `skill://${auth}/${childPath}`;
      const isFile = i === segments.length - 1;
      this.linkChild(parentUri, childUri);
      if (!isFile) {
        this.ensureDir(childUri, segments[i]);
      }
      parentUri = childUri;
    }
  }

  private ensureDir(uri: string, name: string): void {
    if (!this.directories.has(uri)) {
      this.directories.set(uri, { uri, name, children: [] });
    }
  }

  private linkChild(parentUri: string, childUri: string): void {
    const dir = this.directories.get(parentUri);
    if (dir && !dir.children.includes(childUri)) {
      dir.children.push(childUri);
    }
  }

  // ---- Public query surface ----

  /** Project a stored resource to its list/metadata shape (uri/name/mimeType + size + SEP metadata). */
  private toListItem(r: ReadableResource): ResourceListItem {
    const item: ResourceListItem = { uri: r.uri, name: r.name, mimeType: r.mimeType };
    // size: byte length for static resources; omitted for rotating (function) bytes.
    if (typeof r.bytes !== 'function') item.size = r.bytes.length;
    if (r.description !== undefined) item.description = r.description;
    if (r.meta !== undefined) item._meta = r.meta;
    return item;
  }

  /** All resources for resources/list (index + SKILL.mds + supporting files + archives). */
  listResources(): ResourceListItem[] {
    return [...this.resources.values()]
      .map((r) => this.toListItem(r))
      .sort((a, b) => a.uri.localeCompare(b.uri));
  }

  /**
   * Read a resource. Returns its mimeType, whether it is text, and the bytes for
   * this read (advancing the per-URI read counter so rotation fixtures can flip).
   */
  readResource(uri: string): { mimeType: string; isText: boolean; bytes: Buffer } | undefined {
    const r = this.resources.get(uri);
    if (!r) return undefined;
    const n = this.readCounts.get(uri) ?? 0;
    this.readCounts.set(uri, n + 1);
    const bytes = typeof r.bytes === 'function' ? r.bytes(n) : r.bytes;
    return { mimeType: r.mimeType, isText: r.isText, bytes };
  }

  isDirectory(uri: string): boolean {
    return this.directories.has(uri);
  }

  /** Direct children of a directory URI (non-recursive), or undefined if not a dir. */
  directoryChildren(uri: string): ResourceListItem[] | undefined {
    const dir = this.directories.get(uri);
    if (!dir) return undefined;
    return dir.children
      .map((childUri) => {
        if (this.directories.has(childUri)) {
          return { uri: childUri, name: this.directories.get(childUri)!.name, mimeType: DIRECTORY_MIME };
        }
        return this.toListItem(this.resources.get(childUri)!);
      })
      .sort((a, b) => a.uri.localeCompare(b.uri));
  }

  getFixtures(): AdversarialFixture[] {
    return this.fixtures;
  }

  servedCount(): number {
    return this.served.length;
  }
}

/** Produce a shallow copy of a skill with one supporting file's bytes replaced. */
function withArchiveHelper(skill: Skill, helperBytes: Buffer): Skill {
  const files: SkillFile[] = skill.files.map((f) =>
    f.relPath === 'scripts/helper.sh'
      ? { ...f, bytes: helperBytes, mimeType: f.mimeType, isText: true }
      : f,
  );
  return { ...skill, files, skillMdDigest: sha256(skill.files[0].bytes) };
}

export { DIRECTORY_MIME };
