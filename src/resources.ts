/**
 * resources.ts — The resource registry. Turns the loaded corpus (+ optional
 * adversarial profile) into:
 *   - the SEP-2640 skill entries served by `skills/list` and `skills/get`,
 *   - a flat map of readable resources (each SKILL.md, each supporting file, and any
 *     crafted archive blob a deferred fixture supplies),
 *   - a directory tree for `resources/directory/read`.
 *
 * SEP model: skills are individually addressable resources. Enumeration is a method
 * (`skills/list`), not a `skill://index.json` document, and each entry carries a
 * COMPLETE per-file `resources` digest set. A skill is readable from its URI alone
 * whether or not it appears in a listing — the resource map is the source of truth
 * for reads, and `skills/get` answers for any served skill by URI.
 *
 * Archive distribution is a DEFERRED feature: it is NOT part of the v1 SEP (see the
 * SEP's "Appendix: Deferred Features"). It is retained in this corpus on purpose — the
 * archive-safety fixtures are a research contribution and a landing spot should archives
 * be reconsidered. Faithful skills pack no archives; only crafted deferred fixtures supply
 * archive blobs, served as ordinary resource bytes. Archive blobs never appear in a
 * `skills/list` entry (the v1 listing has no archive form), and archive-only skills are
 * excluded from the listing entirely (they cannot be expressed in the individual-file model).
 */
import { archiveUri, fileUri, loadCorpus, skillAuthority, type Skill } from './corpus.js';
import type { ArchiveBlob } from './archives.js';
import { buildSkillEntry, type SkillEntry } from './skills.js';
import { buildAdversarialFixtures, type AdversarialFixture } from './adversarial/index.js';

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

/** A page of `skills/list` results. */
export interface SkillsPage {
  skills: SkillEntry[];
  nextCursor?: string;
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
/** Cursor prefix for the adv-enumeration-exhaustion endless-pagination tail. */
const OVERFLOW_CURSOR = 'adv-overflow-';

export class ResourceRegistry {
  private resources = new Map<string, ReadableResource>();
  private directories = new Map<string, DirectoryNode>();
  private readCounts = new Map<string, number>();
  /** Directory children that are intentionally unreadable / out-of-subtree (adv-directory-walk-escape). */
  private escapeChildren = new Map<string, string>();
  private entries: SkillEntry[] = [];
  private entryByUri = new Map<string, SkillEntry>();
  private skills: Skill[] = [];
  private fixtures: AdversarialFixture[] = [];
  private hasPaginationOverflow = false;

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

    for (const skill of faithful) {
      this.addSkill(skill);
    }
    for (const fx of this.fixtures) {
      this.addSkill(fx.skill, fx);
    }

    // Build the skill-entry catalog (skills/list + skills/get), ordered by URI.
    // Archive-only skills (deferred feature) cannot be expressed in the individual-file
    // listing, so they are excluded from the catalog.
    this.entries = this.skills
      .filter((s) => (s.delivery ?? 'individual') !== 'archive-only')
      .map(buildSkillEntry)
      .sort((a, b) => a.uri.localeCompare(b.uri));
    for (const e of this.entries) this.entryByUri.set(e.uri, e);
  }

  private addSkill(skill: Skill, fixture?: AdversarialFixture): void {
    const auth = skillAuthority(skill);
    const delivery = skill.delivery ?? 'individual';

    // Archives are a DEFERRED feature (not in the v1 SEP): faithful skills pack none.
    // Only a crafted deferred fixture supplies archive blobs, served as ordinary bytes.
    const archives: ArchiveBlob[] = fixture?.archives ?? [];
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

    // Archive-only skills (a deferred-archive fixture, e.g. refunds) are not
    // individually addressable: serve only the archive blob, register no files, and
    // leave them out of the skills/list catalog (built in init from non-archive-only skills).
    if (delivery === 'archive-only') {
      this.skills.push(skill);
      return;
    }

    // Register each served file as a readable resource + build the directory tree.
    for (const file of skill.files) {
      const uri = fileUri(skill, file.relPath);
      let bytes: Buffer | ((readCount: number) => Buffer) = file.bytes;
      if (fixture?.rotateSkillMd && file.relPath === 'SKILL.md') {
        bytes = fixture.rotateSkillMd;
      }
      const isSkillMd = file.relPath === 'SKILL.md';
      // SEP Resource Metadata: a SKILL.md resource SHOULD carry name/description from
      // frontmatter and MAY expose the rest under the reserved _meta prefix.
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

    // adv-directory-walk-escape: list a child whose URI escapes the skill subtree.
    // It is NOT a served resource and NOT in the entry's `resources`, so a host that
    // fetches it gets -32602, and a host checking against `resources` rejects it.
    const escapeChild = (skill as Skill & { directoryEscapeChildUri?: string }).directoryEscapeChildUri;
    if (escapeChild) {
      const rootUri = `skill://${auth}`;
      this.ensureDir(rootUri, auth.split('/').pop() ?? auth);
      this.linkChild(rootUri, escapeChild);
      this.escapeChildren.set(escapeChild, escapeChild.split('/').pop() ?? 'escape');
    }

    // adv-enumeration-exhaustion: mark that skills/list must paginate without end.
    if ((skill as Skill & { paginationOverflow?: boolean }).paginationOverflow) {
      this.hasPaginationOverflow = true;
    }

    this.skills.push(skill);
  }

  /** Ensure directory nodes exist for every path segment of a file, and link children. */
  private registerDirectoriesForFile(auth: string, relPath: string): void {
    const segments = relPath.split('/');
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
    if (typeof r.bytes !== 'function') item.size = r.bytes.length;
    if (r.description !== undefined) item.description = r.description;
    if (r.meta !== undefined) item._meta = r.meta;
    return item;
  }

  /** All resources for resources/list (SKILL.mds + supporting files + any archive blobs). */
  listResources(): ResourceListItem[] {
    return [...this.resources.values()]
      .map((r) => this.toListItem(r))
      .sort((a, b) => a.uri.localeCompare(b.uri));
  }

  /**
   * `skills/list`: a page of skill entries. Faithful pagination returns every entry
   * in one page with no cursor. When the adv-enumeration-exhaustion fixture is served,
   * the first page carries a `nextCursor` into an endless synthetic tail — a host MUST
   * bound how far it follows.
   */
  skillsList(cursor?: string): SkillsPage {
    if (cursor && cursor.startsWith(OVERFLOW_CURSOR)) {
      const n = Number(cursor.slice(OVERFLOW_CURSOR.length)) || 1;
      return { skills: [this.syntheticOverflowEntry(n)], nextCursor: `${OVERFLOW_CURSOR}${n + 1}` };
    }
    const page: SkillsPage = { skills: this.entries };
    if (this.hasPaginationOverflow) page.nextCursor = `${OVERFLOW_CURSOR}1`;
    return page;
  }

  /** One benign synthetic entry for the endless-pagination tail. */
  private syntheticOverflowEntry(n: number): SkillEntry {
    const uri = `skill://adv-enumeration-exhaustion/page-${n}/SKILL.md`;
    return {
      uri,
      frontmatter: { name: `page-${n}`, description: `synthetic overflow entry ${n}` },
      resources: [{ uri, digest: 'sha256:' + '0'.repeat(64) }],
    };
  }

  /** `skills/get`: the entry for a single skill by its SKILL.md URI, or undefined. */
  skillsGet(uri: string): SkillEntry | undefined {
    return this.entryByUri.get(uri);
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
        const res = this.resources.get(childUri);
        if (res) return this.toListItem(res);
        // An escape child (adv-directory-walk-escape): listed but not a served resource.
        return { uri: childUri, name: this.escapeChildren.get(childUri) ?? 'unknown', mimeType: 'text/markdown' };
      })
      .sort((a, b) => a.uri.localeCompare(b.uri));
  }

  getFixtures(): AdversarialFixture[] {
    return this.fixtures;
  }

  servedCount(): number {
    return this.skills.length;
  }
}

export { DIRECTORY_MIME };
