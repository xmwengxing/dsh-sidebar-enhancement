/**
 * Host half of `dsh-sidebar-enhancement`.
 *
 * The client half renders the Sidebar files tree and an editable document
 * renderer; this half exposes the mutation routes those surfaces call:
 * save, create file, create directory, rename, remove and upload — plus one
 * read route, `download`, which serves a file as-is or packs a directory into
 * a ZIP built here (no dependency beyond `node:zlib`).
 *
 * Every route is fenced by the Host/Origin trust check the composition
 * installs as `ctx.connection`, then validated against the Session's own
 * workspace root resolved through the platform `workspaceFileScope` lookup —
 * the same resolution `dsh-api-workspace-files` uses for its reads.
 */
import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** Mutation route paths (the client fetches these as plain `fetch` URLs). */
const SAVE_PATH = '/sidebar-enhancer/save';
const CREATE_PATH = '/sidebar-enhancer/create';
const MKDIR_PATH = '/sidebar-enhancer/mkdir';
const RENAME_PATH = '/sidebar-enhancer/rename';
const REMOVE_PATH = '/sidebar-enhancer/remove';
const UPLOAD_PATH = '/sidebar-enhancer/upload';
/** Read route: a GET the browser streams a file or directory archive from. */
const DOWNLOAD_PATH = '/sidebar-enhancer/download';
/**
 * Quick-command library routes. This state belongs to the user, not to a
 * Session workspace: it lives in one JSON file under the harness home, so the
 * library survives a restart, a changed port, and a different browser — all of
 * which reset the browser-local copy the client also keeps.
 */
const QUICK_LOAD_PATH = '/sidebar-enhancer/quick/load';
const QUICK_SAVE_PATH = '/sidebar-enhancer/quick/save';
/** Directory and file holding the library under the harness home. */
const QUICK_STORE_DIR = 'sidebar-enhancement';
const QUICK_STORE_FILE = 'quick-commands.json';
/** Document tag the client writes and the backup file repeats. */
const QUICK_DOCUMENT_FORMAT = 'dsh-sidebar-enhancement.quick-commands';
/** Caps on one library document. */
const QUICK_MAX_COMMANDS = 5000;
const QUICK_MAX_COMMAND_CHARS = 100_000;
const QUICK_MAX_BYTES = 8 * 1024 * 1024;

/** Upper bounds for the content-bearing routes. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Content-character cap behind the editable renderer's save path. */
const MAX_TEXT_CHARS = 8_000_000;
/** Largest single file this route hands back. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** Archive caps: entry count and total uncompressed bytes held in memory. */
const ZIP_MAX_ENTRIES = 4000;
const ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** @returns {unknown} the connection guard installed by the composition. */
const connectionOf = (ctx) => Reflect.get(ctx, 'connection');

/**
 * Per-call fs-sandbox policy for one session. `ctx.fs.writeText` fences every
 * write against THIS policy's mode and workspace root; omitting it falls back
 * to the deployment root, which usually does not contain the session
 * workspace and denies the write (`FS_SANDBOX_DENIED`). Prefer the live
 * session so its sandbox-mode override is honored; a header-shaped stub keeps
 * the session workspace writable when the session is not live yet.
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {string} workspaceRoot
 */
function policyFor(ctx, sessionId, workspaceRoot) {
  let live;
  try {
    live = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined;
  } catch {
    live = undefined;
  }
  const requests = [];
  if (live !== undefined && live !== null) requests.push({ session: live });
  if (typeof workspaceRoot === 'string' && workspaceRoot !== '') {
    requests.push({ session: { id: sessionId, header: { cwd: workspaceRoot } } });
  }
  requests.push({});
  for (const request of requests) {
    try {
      return ctx.sandboxPolicy.resolve(request);
    } catch {
      // try the next, more conservative shape
    }
  }
  return {};
}

/**
 * Enforce the session's sandbox mode on the raw node mutations the platform
 * fs does not fence (mkdir/rename/remove/upload go through `node:fs` directly;
 * containment is enforced separately by `resolveInside`).
 */
function assertWritable(policy) {
  if (policy.mode === 'read-only') {
    const error = new Error('file access denied under read-only mode');
    error.code = 'FS_SANDBOX_DENIED';
    throw error;
  }
}

/** Serialize one JSON response. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res) {
  res.statusCode = 405;
  res.setHeader('allow', 'POST');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } }));
}

const failure = (code, message) => ({ ok: false, error: { code, message } });

/**
 * Read one request body into a string, refusing anything over `maxBytes`.
 * @returns {Promise<string|null>} the body text, or null when it is too large.
 */
function readBoundedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.resume();
        finish(resolve, null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => finish(reject, error));
  });
}

const isJsonRequest = (req) => {
  const raw = String(req.headers['content-type'] ?? '').split(';', 1)[0];
  return (raw ?? '').trim().toLowerCase() === 'application/json';
};

const isAbsoluteTarget = (value) =>
  value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[/\\]/.test(value);

/**
 * Resolve an absolute candidate and require it strictly inside `root`.
 * @returns {string|null} the native absolute target, or null when rejected.
 */
function resolveInside(root, candidate) {
  if (typeof candidate !== 'string' || candidate === '' || candidate.includes('\0')) return null;
  if (!isAbsoluteTarget(candidate)) return null;
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (relative === '' || path.isAbsolute(relative)) return null;
  if (relative.split(path.sep)[0] === '..') return null;
  return target;
}

const asNonEmptyString = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Resolve the Session workspace root through the platform lookup — the same
 * `workspaceFileScope` resolution `dsh-api-workspace-files` registers.
 * @returns {Promise<{sessionId:string, workspaceRoot:string}|undefined>}
 */
async function scopeOf(ctx, sessionId) {
  try {
    const lookups = ctx.typert === undefined ? undefined : ctx.typert.lookups;
    const provider = lookups === undefined ? undefined : lookups.get('workspaceFileScope');
    if (provider === undefined) return undefined;
    const scope = await provider.resolve(sessionId);
    if (scope === undefined || typeof scope.workspaceRoot !== 'string') return undefined;
    return { sessionId: scope.sessionId, workspaceRoot: scope.workspaceRoot };
  } catch {
    return undefined;
  }
}

/**
 * Build one route handler: trust fence → method → content type → bounded
 * body → JSON parse → field parse → workspace resolution → operation.
 *
 * @param {object} ctx
 * @param {{maxBytes: number, parse: (body: any) => object|null, run: (target: string, fields: any, res: any, ctx: any, scope: any) => Promise<void>}} spec
 */
function makeHandler(ctx, spec) {
  return async (req, res) => {
    const rejection = connectionOf(ctx).requestRejection(req);
    if (rejection !== void 0) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    if (!isJsonRequest(req)) {
      sendJson(res, 415, failure('unsupported-media-type', 'content-type must be application/json'));
      return;
    }
    let text;
    try {
      text = await readBoundedBody(req, spec.maxBytes);
    } catch (error) {
      sendJson(res, 400, failure('bad-request', String(error?.message ?? error)));
      return;
    }
    if (text === null) {
      sendJson(res, 413, failure('payload-too-large', 'request body is too large'));
      return;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      sendJson(res, 400, failure('bad-request', 'request body is not valid JSON'));
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendJson(res, 400, failure('bad-request', 'request body must be a JSON object'));
      return;
    }
    const sessionId = asNonEmptyString(body.sessionId);
    if (sessionId === null) {
      sendJson(res, 400, failure('invalid-request', 'sessionId is required'));
      return;
    }
    const fields = spec.parse(body);
    if (fields === null) {
      sendJson(res, 400, failure('invalid-request', 'invalid request fields'));
      return;
    }
    try {
      const scope = await scopeOf(ctx, sessionId);
      if (scope === undefined) {
        sendJson(res, 404, failure('unknown-workspace', 'unknown session workspace'));
        return;
      }
      const target = resolveInside(scope.workspaceRoot, fields.path);
      if (target === null) {
        sendJson(res, 403, failure('outside-workspace', 'path is outside the workspace'));
        return;
      }
      await spec.run(target, { ...fields, sessionId }, res, ctx, scope);
    } catch (error) {
      if (res.writableEnded) return;
      sendJson(res, 500, failure('failed', String(error?.message ?? error)));
    }
  };
}

/** Map a caught fs/route error onto an HTTP response. */
function sendOpError(res, error) {
  const code = error?.code;
  if (code === 'EEXIST' || code === 'FS_NOT_OBSERVED') {
    sendJson(res, 409, failure('exists', 'target already exists'));
    return;
  }
  if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
    sendJson(res, 404, failure('not-found', 'path does not exist'));
    return;
  }
  if (code === 'FS_STALE_VERSION') {
    sendJson(res, 409, failure('conflict', 'file changed on disk'));
    return;
  }
  if (code === 'FS_SANDBOX_DENIED') {
    sendJson(res, 403, failure('denied', String(error?.message ?? error)));
    return;
  }
  if (code === 'FS_PERMISSION_DENIED' || code === 'EACCES' || code === 'EPERM') {
    sendJson(res, 403, failure('denied', String(error?.message ?? error)));
    return;
  }
  sendJson(res, 500, failure('failed', String(error?.message ?? error)));
}

/**
 * CRC-32 with the IEEE polynomial every ZIP reader checks. The table is built
 * once per isolate; `zlib.crc32` exists on recent Node, but the table keeps
 * this route usable on the older runtimes the harness also supports.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** @returns {number} the CRC-32 checksum of one buffer. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One DOS date/time pair for a timestamp (2-second resolution, 1980 epoch). */
function dosStamp(date) {
  const year = date.getFullYear() < 1980 ? 1980 : date.getFullYear();
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive in memory. Entries are deflated when that actually
 * shrinks them and stored otherwise; names carry the UTF-8 flag so non-ASCII
 * files survive a round trip. No ZIP64: the caps above keep every offset
 * inside 32 bits.
 *
 * @param {{name: string, data: Buffer, mtime: Date|undefined}[]} entries
 * @returns {Buffer} the archive bytes.
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const isDirectory = entry.name.endsWith('/');
    const raw = entry.data ?? Buffer.alloc(0);
    const deflated = isDirectory || raw.length === 0 ? raw : zlib.deflateRawSync(raw);
    const method = isDirectory || deflated.length >= raw.length ? 0 : 8;
    const body = method === 8 ? deflated : raw;
    const checksum = crc32(raw);
    const stamp = dosStamp(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(isDirectory ? 0x10 : 0, 38); // DOS directory bit
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** An archive too large to build, mapped by the client onto its own copy. */
function tooLargeError(detail) {
  const error = new Error(detail);
  error.code = 'ARCHIVE_TOO_LARGE';
  return error;
}

/**
 * Walk one directory into archive entries, breadth of the tree in name order.
 * Symbolic links are skipped rather than followed, so a link cannot pull a
 * file from outside the workspace into the archive (or loop the walk).
 *
 * @returns {Promise<{name: string, data: Buffer, mtime: Date}[]>}
 */
async function collectEntries(rootDir) {
  const entries = [];
  let total = 0;
  const walk = async (dir, prefix) => {
    const dirents = await nodeFs.readdir(dir, { withFileTypes: true });
    dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const child = path.join(dir, dirent.name);
      const info = await nodeFs.lstat(child);
      if (entries.length >= ZIP_MAX_ENTRIES) throw tooLargeError('the directory has too many entries to archive');
      if (info.isDirectory()) {
        entries.push({ name: `${prefix}${dirent.name}/`, data: Buffer.alloc(0), mtime: info.mtime });
        await walk(child, `${prefix}${dirent.name}/`);
        continue;
      }
      if (!info.isFile()) continue;
      if (total + info.size > ZIP_MAX_TOTAL_BYTES) throw tooLargeError('the directory is too large to archive');
      const data = await nodeFs.readFile(child);
      total += data.length;
      entries.push({ name: `${prefix}${dirent.name}`, data, mtime: info.mtime });
    }
  };
  await walk(rootDir, '');
  return entries;
}

/** One attachment header, ASCII-safe with the UTF-8 name alongside. */
function attachmentHeader(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Read one file's bytes through the platform fs (so a sandboxed backend still
 * answers), falling back to `node:fs` on a host that predates `readBytes`.
 * @returns {Promise<Buffer>}
 */
async function readBytesFor(ctx, target, maxBytes) {
  if (typeof ctx.fs?.readBytes === 'function') {
    const resolved = await ctx.fs.resolve(target);
    return Buffer.from(await ctx.fs.readBytes(resolved, undefined, maxBytes));
  }
  const data = await nodeFs.readFile(target);
  if (data.length > maxBytes) {
    const error = new Error('file is too large to download');
    error.code = 'FS_TOO_LARGE';
    throw error;
  }
  return data;
}

/**
 * The `download` route: a read-only GET the browser fetches into a blob. A
 * directory is packed into a ZIP named after it; a file is served byte for
 * byte, so binary formats arrive intact.
 *
 * @param {object} ctx
 */
function makeDownloadHandler(ctx) {
  return async (req, res) => {
    const rejection = connectionOf(ctx).requestRejection(req);
    if (rejection !== void 0) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET');
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(failure('method-not-allowed', 'method not allowed')));
      return;
    }
    let sessionId;
    let requested;
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      sessionId = asNonEmptyString(query.get('sessionId'));
      requested = asNonEmptyString(query.get('path'));
    } catch {
      sessionId = null;
      requested = null;
    }
    if (sessionId === null || requested === null) {
      sendJson(res, 400, failure('invalid-request', 'sessionId and path are required'));
      return;
    }
    try {
      const scope = await scopeOf(ctx, sessionId);
      if (scope === undefined) {
        sendJson(res, 404, failure('unknown-workspace', 'unknown session workspace'));
        return;
      }
      const target = resolveInside(scope.workspaceRoot, requested);
      if (target === null) {
        sendJson(res, 403, failure('outside-workspace', 'path is outside the workspace'));
        return;
      }
      const info = await nodeFs.lstat(target);
      if (info.isSymbolicLink()) {
        sendJson(res, 403, failure('denied', 'symbolic links are not downloadable'));
        return;
      }
      const name = path.basename(target);
      if (info.isDirectory()) {
        const entries = await collectEntries(target);
        const archive = buildZip(entries);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/zip');
        res.setHeader('content-disposition', attachmentHeader(`${name}.zip`));
        res.setHeader('content-length', String(archive.length));
        res.setHeader('cache-control', 'no-store');
        res.end(req.method === 'HEAD' ? void 0 : archive);
        return;
      }
      if (!info.isFile()) {
        sendJson(res, 404, failure('not-found', 'path is not a regular file'));
        return;
      }
      if (info.size > MAX_DOWNLOAD_BYTES) {
        sendJson(res, 413, failure('payload-too-large', 'file is too large to download'));
        return;
      }
      const data = await readBytesFor(ctx, target, MAX_DOWNLOAD_BYTES);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', attachmentHeader(name));
      res.setHeader('content-length', String(data.length));
      res.setHeader('cache-control', 'no-store');
      res.end(req.method === 'HEAD' ? void 0 : data);
    } catch (error) {
      if (error?.code === 'ARCHIVE_TOO_LARGE') {
        sendJson(res, 413, failure('archive-too-large', String(error.message ?? error)));
        return;
      }
      if (error?.code === 'FS_TOO_LARGE') {
        sendJson(res, 413, failure('payload-too-large', 'file is too large to download'));
        return;
      }
      sendOpError(res, error);
    }
  };
}

/** Field parsers. */

function textFields(body) {
  const pathValue = asNonEmptyString(body.path);
  if (pathValue === null) return null;
  if (typeof body.content !== 'string') return null;
  if (body.content.length > MAX_TEXT_CHARS) return null;
  let baseVersion;
  if (body.baseVersion === undefined || body.baseVersion === null) {
    baseVersion = undefined;
  } else {
    baseVersion = asNonEmptyString(body.baseVersion);
    if (baseVersion === null) return null;
  }
  return { path: pathValue, content: body.content, baseVersion };
}

function pathFields(body) {
  const pathValue = asNonEmptyString(body.path);
  return pathValue === null ? null : { path: pathValue };
}

function renameFields(body) {
  const from = asNonEmptyString(body.from);
  const to = asNonEmptyString(body.to);
  return from === null || to === null ? null : { path: from, to };
}

function uploadFields(body) {
  const pathValue = asNonEmptyString(body.path);
  const data = asNonEmptyString(body.data);
  if (pathValue === null || data === null) return null;
  return { path: pathValue, data, overwrite: body.overwrite === true };
}

/** Route operations. */

const SPECS = {
  save: {
    maxBytes: MAX_TEXT_BYTES,
    parse: textFields,
    run: async (target, fields, res, ctx, scope) => {
      try {
        const resolved = await ctx.fs.resolve(target);
        const outcome = await ctx.fs.writeText(
          resolved,
          fields.content,
          fields.baseVersion === undefined ? undefined : { kind: 'replaceIfVersion', version: fields.baseVersion },
          undefined,
          policyFor(ctx, fields.sessionId, scope.workspaceRoot),
        );
        sendJson(res, 200, { ok: true, version: outcome.version, operation: outcome.operation });
      } catch (error) {
        sendOpError(res, error);
      }
    },
  },
  create: {
    maxBytes: 8 * 1024,
    parse: pathFields,
    run: async (target, fields, res, ctx, scope) => {
      try {
        const policy = policyFor(ctx, fields.sessionId, scope.workspaceRoot);
        assertWritable(policy);
        const existing = await ctx.fs.stat(await ctx.fs.resolve(target));
        if (existing !== undefined) {
          sendJson(res, 409, failure('exists', 'target already exists'));
          return;
        }
        await nodeFs.mkdir(path.dirname(target), { recursive: true });
        const outcome = await ctx.fs.writeText(await ctx.fs.resolve(target), '', { kind: 'createIfAbsent' }, undefined, policy);
        sendJson(res, 200, { ok: true, version: outcome.version });
      } catch (error) {
        sendOpError(res, error);
      }
    },
  },
  mkdir: {
    maxBytes: 8 * 1024,
    parse: pathFields,
    run: async (target, fields, res, ctx, scope) => {
      try {
        assertWritable(policyFor(ctx, fields.sessionId, scope.workspaceRoot));
        const existing = await ctx.fs.stat(await ctx.fs.resolve(target));
        if (existing !== undefined) {
          sendJson(res, 409, failure('exists', 'target already exists'));
          return;
        }
        await nodeFs.mkdir(target, { recursive: true });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendOpError(res, error);
      }
    },
  },
  rename: {
    maxBytes: 16 * 1024,
    parse: renameFields,
    run: async (target, fields, res, ctx, scope) => {
      try {
        assertWritable(policyFor(ctx, fields.sessionId, scope.workspaceRoot));
        const toTarget = resolveInside(scope.workspaceRoot, fields.to);
        if (toTarget === null) {
          sendJson(res, 403, failure('outside-workspace', 'path is outside the workspace'));
          return;
        }
        const fromInfo = await ctx.fs.stat(await ctx.fs.resolve(target));
        if (fromInfo === undefined) {
          sendJson(res, 404, failure('not-found', 'path does not exist'));
          return;
        }
        const toInfo = await ctx.fs.stat(await ctx.fs.resolve(toTarget));
        if (toInfo !== undefined) {
          sendJson(res, 409, failure('exists', 'target already exists'));
          return;
        }
        await nodeFs.rename(target, toTarget);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendOpError(res, error);
      }
    },
  },
  remove: {
    maxBytes: 8 * 1024,
    parse: pathFields,
    run: async (target, fields, res, ctx, scope) => {
      try {
        await nodeFs.lstat(target);
      } catch {
        sendJson(res, 404, failure('not-found', 'path does not exist'));
        return;
      }
      try {
        assertWritable(policyFor(ctx, fields.sessionId, scope.workspaceRoot));
        await nodeFs.rm(target, { recursive: true, force: false });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendOpError(res, error);
      }
    },
  },
  upload: {
    maxBytes: MAX_UPLOAD_BYTES,
    parse: uploadFields,
    run: async (target, fields, res, ctx, scope) => {
      try {
        assertWritable(policyFor(ctx, fields.sessionId, scope.workspaceRoot));
        const buffer = Buffer.from(fields.data, 'base64');
        if (buffer.length > 48 * 1024 * 1024) {
          sendJson(res, 413, failure('payload-too-large', 'decoded file is too large'));
          return;
        }
        await nodeFs.mkdir(path.dirname(target), { recursive: true });
        await nodeFs.writeFile(target, buffer, { flag: fields.overwrite ? 'w' : 'wx' });
        sendJson(res, 200, { ok: true, bytes: buffer.length });
      } catch (error) {
        sendOpError(res, error);
      }
    },
  },
};

/**
 * The harness home: `$DSH_HOME` when set, else `~/.dsh` — the same precedence
 * `@deepseek-ai/dsh-home-paths` documents. Spelled out here because this plugin
 * resolves its own imports from the user's checkout, not from the platform's
 * package table.
 * @returns {string} the absolute harness home.
 */
function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured !== '' ? configured : path.join(os.homedir(), '.dsh');
}

/** @returns {string} the absolute path of the library file. */
const quickLibraryFile = () => path.join(dshHome(), QUICK_STORE_DIR, QUICK_STORE_FILE);

/** Symbolic display of the library path: never an absolute machine path. */
function quickLibraryDisplay() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  const home = configured !== '' ? '$DSH_HOME' : '~/.dsh';
  return `${home}/${QUICK_STORE_DIR}/${QUICK_STORE_FILE}`;
}

/** One optional string field of a stored command, or null when it is not text. */
function optionalText(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : null;
}

/**
 * Validate and normalize one library document. Anything unusable rejects the
 * whole document: a partially applied library is worse than a refused write.
 *
 * @param {unknown} value
 * @returns {{format: string, version: number, savedAt: string, commands: object[]}|null}
 */
function sanitizeQuickDocument(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Array.isArray(value.commands)) return null;
  if (value.commands.length > QUICK_MAX_COMMANDS) return null;
  const commands = [];
  let total = 0;
  for (const entry of value.commands) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const id = optionalText(entry.id);
    const name = optionalText(entry.name);
    const group = optionalText(entry.group);
    const note = optionalText(entry.note);
    const command = optionalText(entry.command);
    if (id === null || name === null || group === null || note === null || command === null) return null;
    if (command.trim() === '' || command.length > QUICK_MAX_COMMAND_CHARS) return null;
    total += command.length + name.length + group.length + note.length;
    if (total > QUICK_MAX_BYTES) return null;
    commands.push({ id, name, group, note, command: command.replace(/\r\n/g, '\n') });
  }
  const savedAt = typeof value.savedAt === 'string' ? value.savedAt : '';
  return { format: QUICK_DOCUMENT_FORMAT, version: 1, savedAt, commands };
}

/** @returns {Promise<object|null>} the stored document, or null when absent/unreadable. */
async function readQuickDocument() {
  try {
    const raw = await nodeFs.readFile(quickLibraryFile(), 'utf8');
    return sanitizeQuickDocument(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Publish the library by atomic rewrite: a reader never sees a torn file. */
async function writeQuickDocument(document) {
  const file = quickLibraryFile();
  await nodeFs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await nodeFs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await nodeFs.rename(temporary, file);
}

/**
 * Build one library handler: trust fence → POST → content type → bounded body
 * → JSON. Unlike the workspace routes this one needs no Session: the library is
 * user-level state, and the fence already proves the caller is this harness's
 * own page.
 *
 * @param {object} ctx
 * @param {{maxBytes: number, run: (body: any, res: any) => Promise<void>}} spec
 */
function makeLibraryHandler(ctx, spec) {
  return async (req, res) => {
    const rejection = connectionOf(ctx).requestRejection(req);
    if (rejection !== void 0) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    if (!isJsonRequest(req)) {
      sendJson(res, 415, failure('unsupported-media-type', 'content-type must be application/json'));
      return;
    }
    let text;
    try {
      text = await readBoundedBody(req, spec.maxBytes);
    } catch (error) {
      sendJson(res, 400, failure('bad-request', String(error?.message ?? error)));
      return;
    }
    if (text === null) {
      sendJson(res, 413, failure('payload-too-large', 'request body is too large'));
      return;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      sendJson(res, 400, failure('bad-request', 'request body is not valid JSON'));
      return;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, failure('bad-request', 'request body must be a JSON object'));
      return;
    }
    try {
      await spec.run(body, res);
    } catch (error) {
      if (res.writableEnded) return;
      sendJson(res, 500, failure('failed', String(error?.message ?? error)));
    }
  };
}

/** The two library route operations. */
const LIBRARY_SPECS = {
  load: {
    maxBytes: 64 * 1024,
    run: async (body, res) => {
      sendJson(res, 200, { ok: true, document: await readQuickDocument(), path: quickLibraryDisplay() });
    },
  },
  save: {
    maxBytes: QUICK_MAX_BYTES,
    run: async (body, res) => {
      const document = sanitizeQuickDocument(body.document);
      if (document === null) {
        sendJson(res, 400, failure('invalid-document', 'the command library is malformed or too large'));
        return;
      }
      const savedAt = new Date().toISOString();
      await writeQuickDocument({ ...document, savedAt });
      sendJson(res, 200, { ok: true, savedAt, count: document.commands.length, path: quickLibraryDisplay() });
    },
  },
};

export function apply(ctx, config) {
  const routes = [
    [SAVE_PATH, SPECS.save],
    [CREATE_PATH, SPECS.create],
    [MKDIR_PATH, SPECS.mkdir],
    [RENAME_PATH, SPECS.rename],
    [REMOVE_PATH, SPECS.remove],
    [UPLOAD_PATH, SPECS.upload],
  ];
  for (const [routePath, spec] of routes) {
    const handler = makeHandler(ctx, spec);
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: routePath, handler }), `sidebar-enhancement: ${routePath}`);
  }
  const download = makeDownloadHandler(ctx);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: DOWNLOAD_PATH, handler: download }), `sidebar-enhancement: ${DOWNLOAD_PATH}`);

  // The quick-command library: one durable JSON file in the harness home,
  // readable and writable from any browser that reaches this harness.
  const libraryRoutes = [
    [QUICK_LOAD_PATH, LIBRARY_SPECS.load],
    [QUICK_SAVE_PATH, LIBRARY_SPECS.save],
  ];
  for (const [routePath, spec] of libraryRoutes) {
    const handler = makeLibraryHandler(ctx, spec);
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: routePath, handler }), `sidebar-enhancement: ${routePath}`);
  }
}

export const inject = ['webServer', 'connection', 'fs', 'typert', 'sessions', 'sandboxPolicy'];
