/**
 * archives.ts — Archive packing helpers. Archives are a DEFERRED feature (not in
 * the v1 SEP; see the SEP's "Appendix: Deferred Features"). SKILL.md sits at archive
 * root; entries are relative. Only deferred fixtures serve archive blobs now — they
 * are ordinary blob resources and never appear in a `skills/list` entry.
 *
 * The plain `packTarGz` / `packZip` builders pack a faithful skill (unused by the
 * v1 serving path; kept for the deferred profile). The adversarial fixtures build
 * their own malformed archives via the low-level helpers (`writeRawTarGz`) re-exported below.
 */
import { createGzip, deflateRawSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { create as tarCreate } from 'tar';
import { ZipArchive } from 'archiver';
import { sha256, type Skill } from './corpus.js';

export interface ArchiveBlob {
  kind: 'tar.gz' | 'zip';
  mimeType: string;
  bytes: Buffer;
  digest: string;
}

let cacheDirPromise: Promise<string> | undefined;

/** A per-process temp cache dir for staging skill payloads before packing. */
export async function archiveCacheDir(): Promise<string> {
  if (!cacheDirPromise) {
    cacheDirPromise = fs.mkdtemp(path.join(os.tmpdir(), 'skills-over-mcp-'));
  }
  return cacheDirPromise;
}

/** Stage a skill's served files into a temp dir and return that dir's path. */
async function stageSkill(skill: Skill): Promise<string> {
  const root = await archiveCacheDir();
  const stage = path.join(root, 'stage', skill.name + '-' + Math.random().toString(36).slice(2));
  await fs.mkdir(stage, { recursive: true });
  for (const file of skill.files) {
    const dest = path.join(stage, ...file.relPath.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.bytes);
  }
  return stage;
}

/** Pack a faithful skill directory into a gzipped tar (SKILL.md at root). */
export async function packTarGz(skill: Skill): Promise<ArchiveBlob> {
  const stage = await stageSkill(skill);
  const entries = skill.files.map((f) => f.relPath).sort();
  const stream = tarCreate(
    {
      cwd: stage,
      gzip: true,
      // Deterministic packing: portable mode + a fixed mtime so the same skill
      // always yields identical bytes (and thus a stable digest) regardless of
      // when/where it is packed.
      portable: true,
      mtime: new Date(0),
    },
    entries,
  ) as unknown as Readable;
  const bytes = await streamToBuffer(stream);
  return { kind: 'tar.gz', mimeType: 'application/gzip', bytes, digest: sha256(bytes) };
}

/** Pack a faithful skill directory into a zip (SKILL.md at root). */
export async function packZip(skill: Skill): Promise<ArchiveBlob> {
  // Zip appends entries directly from in-memory bytes (no disk staging needed).
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });
  for (const file of skill.files) {
    archive.append(file.bytes, { name: file.relPath });
  }
  await archive.finalize();
  await done;
  const bytes = Buffer.concat(chunks);
  return { kind: 'zip', mimeType: 'application/zip', bytes, digest: sha256(bytes) };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// --------------------------------------------------------------------------
// Low-level builders for adversarial fixtures (malformed archives on purpose).
// --------------------------------------------------------------------------

/** One raw entry for a hand-built USTAR archive. */
export interface RawTarEntry {
  /** Entry name, written verbatim (may contain `../` or be absolute on purpose). */
  name: string;
  /** File contents (ignored for link entries). */
  body?: Buffer;
  /** Symlink target. When set, the entry is a symlink (typeflag '2'). */
  linkTarget?: string;
  /** Hard-link target. When set, the entry is a hard link (typeflag '1'). */
  hardLinkTarget?: string;
  /**
   * Explicit USTAR typeflag override (e.g. '6' FIFO, '3' char device, '4' block
   * device, '5' directory). Wins over the link/regular defaults. Used by the
   * non-regular-file fixture; such entries carry no body.
   */
  typeflag?: string;
  /** Octal mode, default 0o644. */
  mode?: number;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  // width includes the trailing space/NUL; classic tar uses NUL-terminated octal.
  const str = value.toString(8);
  return str.padStart(width - 1, '0') + '\0';
}

function writeTarHeader(entry: RawTarEntry, size: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const name = Buffer.from(entry.name, 'utf8');
  // USTAR name field is 100 bytes; long names are intentionally allowed to be
  // truncated/passed through — our fixtures keep names short enough to fit.
  name.copy(header, 0, 0, Math.min(name.length, 100));
  header.write(octal(entry.mode ?? 0o644, 8), 100, 'ascii'); // mode
  header.write(octal(0, 8), 108, 'ascii'); // uid
  header.write(octal(0, 8), 116, 'ascii'); // gid
  header.write(octal(size, 12), 124, 'ascii'); // size
  header.write(octal(0, 12), 136, 'ascii'); // mtime
  // typeflag: explicit override wins (e.g. '6' FIFO); else '2' symlink, '1' hard
  // link, '0' regular file.
  const typeflag =
    entry.typeflag ?? (entry.linkTarget !== undefined ? '2' : entry.hardLinkTarget !== undefined ? '1' : '0');
  header.write(typeflag, 156, 'ascii');
  const linkname = entry.linkTarget ?? entry.hardLinkTarget;
  if (linkname !== undefined) {
    Buffer.from(linkname, 'utf8').copy(header, 157, 0, 100); // linkname
  }
  header.write('ustar\0', 257, 'ascii'); // magic
  header.write('00', 263, 'ascii'); // version
  // checksum: spaces while summing, then write octal
  header.write('        ', 148, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(octal(sum, 8).replace(/\0$/, ' '), 148, 'ascii');
  return header;
}

/** Build a raw (uncompressed) tar from hand-specified entries, then gzip it. */
export async function writeRawTarGz(entries: RawTarEntry[]): Promise<Buffer> {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const isLink = entry.linkTarget !== undefined || entry.hardLinkTarget !== undefined;
    const body = isLink ? Buffer.alloc(0) : (entry.body ?? Buffer.alloc(0));
    blocks.push(writeTarHeader(entry, body.length));
    if (body.length > 0) {
      blocks.push(body);
      const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
      if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  // Two zero blocks terminate the archive.
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(blocks);
  const gz = createGzip();
  const out = streamToBuffer(gz as unknown as Readable);
  await pipeline(Readable.from(tar), gz);
  return out;
}

// --------------------------------------------------------------------------
// Low-level ZIP builder for adversarial fixtures (malformed zips on purpose).
// archiver(8) sanitizes `..` out of entry names and we need byte-level control
// over names + symlink external attributes, so the fixtures hand-build zips.
// --------------------------------------------------------------------------

/** One raw entry for a hand-built ZIP archive. */
export interface RawZipEntry {
  /** Entry name, written verbatim (may contain `..`, backslashes, or be absolute). */
  name: string;
  /** File contents (deflate-compressed in the zip). Ignored for symlink entries. */
  body?: Buffer;
  /** Symlink target. When set, the entry is a symlink (Unix mode S_IFLNK); the
   *  link target is stored (uncompressed) as the entry body, as zip convention. */
  linkTarget?: string;
}

/** CRC-32 (IEEE) of a buffer — required in both zip headers. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const ZIP_DOS_DATE = 0x21; // 1980-01-01, for byte-stable archives.

/** Build a raw ZIP from hand-specified entries (deflate for files, S_IFLNK for symlinks). */
export function writeRawZip(entries: RawZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const isLink = entry.linkTarget !== undefined;
    const raw = isLink ? Buffer.from(entry.linkTarget!, 'utf8') : entry.body ?? Buffer.alloc(0);
    const method = isLink ? 0 : 8; // store the symlink target; deflate file bodies
    const data = isLink ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const unixMode = isLink ? 0o120777 : 0o100644;
    const versionMadeBy = (3 << 8) | 20; // host = Unix (so external-attr mode is honored)

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(ZIP_DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(raw.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    locals.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cdh.writeUInt16LE(versionMadeBy, 4);
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12); // mod time
    cdh.writeUInt16LE(ZIP_DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE((unixMode << 16) >>> 0, 38); // external attrs (Unix mode in high 16 bits)
    cdh.writeUInt32LE(offset, 42); // local header offset
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end-of-central-directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); // size of central directory
  eocd.writeUInt32LE(offset, 16); // offset of central directory start
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, centralBuf, eocd]);
}
