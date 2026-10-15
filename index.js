/**
 * Host half of `dsh-sidebar-enhancement`.
 *
 * The client half renders the Sidebar files tree and an editable document
 * renderer; this half exposes the mutation routes those surfaces call:
 * save, create file, create directory, rename, remove and upload.
 *
 * Every route is fenced by the Host/Origin trust check the composition
 * installs as `ctx.connection`, then validated against the Session's own
 * workspace root resolved through the platform `workspaceFileScope` lookup —
 * the same resolution `dsh-api-workspace-files` uses for its reads.
 */
import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

/** Mutation route paths (the client fetches these as plain `fetch` URLs). */
const SAVE_PATH = '/sidebar-enhancer/save';
const CREATE_PATH = '/sidebar-enhancer/create';
const MKDIR_PATH = '/sidebar-enhancer/mkdir';
const RENAME_PATH = '/sidebar-enhancer/rename';
const REMOVE_PATH = '/sidebar-enhancer/remove';
const UPLOAD_PATH = '/sidebar-enhancer/upload';

/** Upper bounds for the content-bearing routes. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Content-character cap behind the editable renderer's save path. */
const MAX_TEXT_CHARS = 8_000_000;

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
}

export const inject = ['webServer', 'connection', 'fs', 'typert', 'sessions', 'sandboxPolicy'];
