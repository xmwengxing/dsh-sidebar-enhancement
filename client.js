/**
 * Client half of `dsh-sidebar-enhancement`.
 *
 * Two UI pieces, both additive to the shipped Sidebar:
 *
 * 1. A shadow body for the Files tab (`priority: -1`, so it renders instead of
 *    the built-in tree while keeping the built-in tab type and title). It keeps
 *    the same listing look and the same `sidebar.right.tab.files.actions` slot,
 *    and adds rename, create file/directory, upload and delete — through the
 *    Host routes registered by this bundle's `index.js`.
 * 2. An editable document renderer (`sidebar.right.tab.document`, registered
 *    with a `documentPreviews` definition at `priority: 'extension'`). It reads
 *    the whole file through the workspace-files Remote, lets the user edit it
 *    in a textarea, and saves through the same Host routes with optimistic
 *    concurrency (`replaceIfVersion`), with a confirm-and-force fallback.
 */

window.__ModuleLoader__.load({
  id: "dsh-sidebar-enhancement",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
    const React = require("react");
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    //#region constants and small helpers

    /** This package's copy namespace. */
    const NS = "sidebarEnhancer";
    /** The built-in files body this package shadows. */
    const FILES_ID = "@deepseek-ai/dsh-client-ui-sidebar-files";
    /** The editable renderer's implementation identity. */
    const EDITOR_ID = "dsh-sidebar-enhancement/editor";

    /** The built-in terminal tab whose body this package can re-seat below the composer. */
    const TERMINAL_ID = "@deepseek-ai/dsh-client-ui-sidebar-terminal";
    /** The terminal package's lazy chunk that owns xterm and `TerminalBody`. */
    const TERMINAL_CHUNK = "client.terminal.js";
    /** The bottom panel entry identity (`conversation.composer.dock` is a list slot). */
    const DOCK_ID = "dsh-sidebar-enhancement/terminal-panel";
    /** The header button identity (`conversation.session.header.utilities` is a list slot). */
    const PANEL_BUTTON_ID = "dsh-sidebar-enhancement/terminal-panel-button";
    /** localStorage key persisting the panel visibility and height. */
    const DOCK_STORE_KEY = "dsh-sidebar-enhancement.terminalPanel";

    /** Host mutation routes registered by this bundle's host half. */
    const ROUTES = {
      save: "/sidebar-enhancer/save",
      create: "/sidebar-enhancer/create",
      mkdir: "/sidebar-enhancer/mkdir",
      rename: "/sidebar-enhancer/rename",
      remove: "/sidebar-enhancer/remove",
      upload: "/sidebar-enhancer/upload",
    };

    /** One uploaded file's largest size (the Host decodes at 48 MiB, body cap 64 MiB). */
    const MAX_UPLOAD_BYTES = 47 * 1024 * 1024;
    /** Editable renderer caps: about six million characters over at most 1500 pages. */
    const MAX_READ_CHARS = 6_000_000;
    const MAX_READ_PAGES = 1500;

    /** Minimal `clsx`: strings/numbers plus truthy-keyed objects. */
    function cx(...parts) {
      let out = "";
      for (const part of parts) {
        if (part === undefined || part === null || part === false || part === "") continue;
        if (typeof part === "string" || typeof part === "number") {
          if (out !== "") out += " ";
          out += String(part);
          continue;
        }
        if (typeof part === "object") {
          for (const key of Object.keys(part)) {
            if (part[key]) {
              if (out !== "") out += " ";
              out += key;
            }
          }
        }
      }
      return out;
    }

    /** The absolute path of one child entry, joined with `/` whatever the parent's separators. */
    function childPath(parent, name) {
      return `${parent.replace(/[/\\]+$/, "")}/${name}`;
    }

    /** Whether a new file or directory name is a single usable segment. */
    function validName(value) {
      return (
        typeof value === "string" &&
        value !== "" &&
        value !== "." &&
        value !== ".." &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !value.includes("\0")
      );
    }

    //#endregion

    //#region file addresses (copied from the shipped workspace-path helpers)

    /** The scheme and type every file address opens with. */
    const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

    /** Component-encode one id or path segment, keeping `:` literal for drive letters. */
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ":");
    }

    /** Encode a `/`-separated path segment by segment. */
    function encodePath(path) {
      return path.split("/").map(encodeSegment).join("/");
    }

    /** Whether a decoded first path segment is a Windows drive (`C:`). */
    function isDriveSegment(segment) {
      return segment !== void 0 && /^[A-Za-z]:$/.test(segment);
    }

    /** Build the address of a file read through one Session. */
    function sessionFileAddress(sessionId, path) {
      const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
    }

    /** Read a file address back into its parts without resolving `.` or `..`. */
    function parseFileAddress(address) {
      try {
        if (!address.startsWith(FILE_ADDRESS_PREFIX)) return void 0;
        const end = address.search(/[?#]/);
        const [scope, ...rest] = address.slice(20, end === -1 ? void 0 : end).split("/");
        if (scope === "session") {
          const [id, ...segments] = rest;
          if (id === void 0 || id === "" || segments.length === 0) return void 0;
          return {
            scope,
            sessionId: decodeURIComponent(id),
            path: segments.map(decodeURIComponent).join("/"),
          };
        }
        if (scope === "absolute") {
          const unc = rest[0] === "" && rest.length > 1;
          const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
          if (segments.length === 0 || segments[0] === "") return void 0;
          if (unc) return { scope, path: `//${segments.join("/")}` };
          return {
            scope,
            path: isDriveSegment(segments[0]) ? segments.join("/") : `/${segments.join("/")}`,
          };
        }
        return;
      } catch {
        return;
      }
    }

    /** Whether a path uses a Windows drive or UNC prefix. */
    function isWindowsStylePath(value) {
      return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
    }

    /** Whether a path is absolute in either spelling the Host accepts. */
    function isAbsoluteWorkspacePath(path) {
      return path.startsWith("/") || isWindowsStylePath(path);
    }

    /**
     * The address for a path as a caller holds it: relative, or absolute inside
     * the Session's workspace, becomes a session-scoped address; anything else
     * keeps its absolute path inside the same Session's address.
     */
    function fileAddressFor(sessionId, cwd, path) {
      const normalized = path.replace(/\\/g, "/");
      if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
      const root = cwd === void 0 ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
      if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
      if (root !== "" && normalized.startsWith(`${root}/`)) {
        return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
      }
      return sessionFileAddress(sessionId, normalized);
    }

    //#endregion

    //#region ordering and failure copy

    /** Natural, case-insensitive name order, so `file2` precedes `file10`. */
    const byName = new Intl.Collator(void 0, { numeric: true, sensitivity: "base" });

    /** Order one level's entries for display: directories first, then by name. */
    function orderEntries(entries) {
      return [...entries].sort((left, right) => {
        const group = Number(right.type === "directory") - Number(left.type === "directory");
        return group !== 0 ? group : byName.compare(left.name, right.name);
      });
    }

    /** Render a byte count the way a person reads one. */
    function humanBytes(bytes) {
      if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
      if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${bytes} B`;
    }

    /** Say why a directory could not be listed, in terms of the directory. */
    function failureLine(t, failure) {
      switch (failure.code) {
        case "workspace-file/not-found": return t("error.notFound");
        case "workspace-file/outside-workspace": return t("error.outsideWorkspace");
        case "workspace-file/not-directory": return t("error.notDirectory");
        default: return t("error.unavailable", { message: failure.message });
      }
    }

    /** Say why a file could not be read for editing, in terms of the file. */
    function readFailureLine(t, failure) {
      switch (failure.code) {
        case "workspace-file/not-found": return t("error.notFound");
        case "workspace-file/too-large": return t("error.tooLarge", { limit: humanBytes(failure.details?.limit ?? 0) });
        case "workspace-file/not-text": return t("error.notText");
        case "workspace-file/not-regular-file": return t("error.notRegularFile");
        default: return t("error.unavailable", { message: failure.message });
      }
    }

    /** Human copy for one mutation-route failure. */
    function opMessage(t, error) {
      if (error === undefined || error === null) return t("op.failed", { message: "unknown error" });
      switch (error.code) {
        case "exists": return t("op.exists");
        case "not-found":
        case "workspace-file/not-found": return t("op.notFound");
        case "outside-workspace":
        case "workspace-file/outside-workspace": return t("op.outside");
        case "not-directory":
        case "workspace-file/not-directory": return t("error.notDirectory");
        case "conflict": return t("op.conflict");
        case "invalid":
        case "invalid-request":
        case "bad-request": return t("op.invalid");
        case "unknown-workspace": return t("op.unknownWorkspace");
        case "payload-too-large":
        case "workspace-file/too-large": return t("op.tooLarge");
        case "denied": return t("op.denied");
        case "network": return t("op.network", { message: error.message });
        default: return t("op.failed", { message: error.message ?? String(error.code ?? error) });
      }
    }

    //#endregion

    //#region route client and face

    /** POST one JSON mutation route; never throws. */
    async function callRoute(pathname, body, signal) {
      try {
        const response = await fetch(pathname, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          payload = void 0;
        }
        if (!response.ok) {
          const remote = payload !== undefined && payload !== null && typeof payload === "object" ? payload.error : void 0;
          const error = remote !== undefined && remote !== null
            ? remote
            : { code: `http-${response.status}`, message: `request failed with status ${response.status}` };
          return { ok: false, status: response.status, error };
        }
        if (payload === undefined || payload === null || typeof payload !== "object" || payload.ok !== true) {
          return { ok: false, status: response.status, error: { code: "bad-response", message: "route returned an unexpected payload" } };
        }
        return { ok: true, status: response.status, value: payload };
      } catch (error) {
        if (error !== undefined && error !== null && error.name === "AbortError") {
          return { ok: false, status: 0, error: { code: "aborted", message: "request aborted" } };
        }
        return { ok: false, status: 0, error: { code: "network", message: String(error?.message ?? error) } };
      }
    }

    /** Base64 one byte array in chunks, so large files stay under the argument cap. */
    function bytesToBase64(bytes) {
      const chunkSize = 0x8000;
      let binary = "";
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    }

    const UNAVAILABLE = { ok: false, error: { code: "workspace-file/unavailable", message: "workspace files remote is unavailable" } };

    /**
     * Build one Session-bound face: reads go through the workspace-files Remote,
     * mutations through this bundle's Host routes.
     */
    function makeFace(ctx, sessionId) {
      const wf = ctx.remote === undefined ? undefined : ctx.remote.workspaceFiles;
      const route = (pathname, body, signal) => callRoute(pathname, { sessionId, ...body }, signal);
      return {
        sessionId,
        list: (path, signal) => (wf === undefined ? UNAVAILABLE : wf.list(sessionId, path, signal)),
        stat: (path, signal) => (wf === undefined ? UNAVAILABLE : wf.stat(sessionId, path, signal)),
        /** Read the whole text file by paging lines; stops at `eof`. */
        readAll: async (path, signal) => {
          if (wf === undefined) return UNAVAILABLE;
          let offset = 1;
          let parts = "";
          let pages = 0;
          let version;
          while (pages < MAX_READ_PAGES) {
            const page = await wf.read(sessionId, path, { offset }, signal);
            if (!page.ok) return page;
            if (page.value.version !== undefined) version = page.value.version;
            if (pages > 0) parts += "\n";
            parts += page.value.text;
            pages += 1;
            if (parts.length > MAX_READ_CHARS) {
              return {
                ok: false,
                error: { code: "workspace-file/too-large", message: "file is too large to edit", details: { limit: MAX_READ_CHARS } },
              };
            }
            if (page.value.eof === true || page.value.lines === 0) {
              return { ok: true, value: { text: parts, version } };
            }
            offset += page.value.lines;
          }
          return {
            ok: false,
            error: { code: "workspace-file/too-large", message: "file is too large to edit", details: { limit: MAX_READ_CHARS } },
          };
        },
        save: (path, content, baseVersion, signal) => route(ROUTES.save, { path, content, baseVersion }, signal),
        create: (path) => route(ROUTES.create, { path }),
        mkdir: (path) => route(ROUTES.mkdir, { path }),
        rename: (from, to) => route(ROUTES.rename, { from, to }),
        remove: (path) => route(ROUTES.remove, { path }),
        upload: (path, bytes, overwrite, signal) => route(ROUTES.upload, { path, data: bytesToBase64(bytes), overwrite }, signal),
      };
    }

    //#endregion

    //#region terminal dock: chunk loader, hook bindings

    /**
     * Load the terminal package's lazy chunk (`TerminalBody` + bundled xterm)
     * without opening a terminal tab. The chunk registers its factory under
     * `<owner>/client.terminal.js` via `__ModuleLoader__.load`; when it has not
     * run yet, replicate the loader's own chunk-URL rule from the boot graph
     * row and execute it with a classic script — the same transport the module
     * system uses, and idempotent through the factory-duplicate guard.
     */
    let terminalChunkPromise = undefined;
    function ensureTerminalChunk(require) {
      if (terminalChunkPromise !== undefined) return terminalChunkPromise;
      terminalChunkPromise = (async () => {
        const chunkId = `${TERMINAL_ID}/${TERMINAL_CHUNK}`;
        try {
          return require(chunkId);
        } catch {
          // Not registered yet — load it below.
        }
        const boot = typeof window === "undefined" ? undefined : window.__DSH_BOOT__;
        const row = boot !== undefined && Array.isArray(boot.entries) ? boot.entries.find((entry) => entry?.id === TERMINAL_ID) : undefined;
        if (row === undefined || typeof row.url !== "string") {
          throw new Error("terminal dock: no boot-graph row for the terminal package");
        }
        const resourceStart = row.url.indexOf("/??");
        const revisionStart = resourceStart < 0 ? -1 : row.url.indexOf("&rev=", resourceStart + 3);
        if (resourceStart < 0 || revisionStart < 0 || row.url.slice(resourceStart + 3, revisionStart) !== `${TERMINAL_ID}/client.js`) {
          throw new Error(`terminal dock: unrecognized bundle URL ${row.url}`);
        }
        const src = `${row.url.slice(0, resourceStart)}/${TERMINAL_ID}/${TERMINAL_CHUNK}?${row.url.slice(revisionStart + 1)}`;
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.async = true;
          script.src = src;
          script.addEventListener("load", () => {
            script.remove();
            resolve();
          }, { once: true });
          script.addEventListener("error", () => {
            script.remove();
            reject(new Error(`terminal dock: chunk script failed to load`));
          }, { once: true });
          document.head.append(script);
        });
        return require(chunkId);
      })();
      terminalChunkPromise.catch(() => {
        terminalChunkPromise = undefined; // allow a retry after a failure
      });
      return terminalChunkPromise;
    }

    /** Absent observable: `getSnapshot` yields `undefined`, subscriptions are no-ops. */
    const absentSource = { getSnapshot: () => undefined, subscribe: () => () => {} };
    const identity = (value) => value;

    /**
     * Bind a bare observable to a selector hook (the renderer's
     * `bindSnapshotSelector` semantics: subscribe/getSnapshot captured once,
     * selector memoized on `Object.is`, optional equality).
     */
    const selectorHookCache = new WeakMap();
    function selectorHookFor(source) {
      let hook = selectorHookCache.get(source);
      if (hook !== undefined) return hook;
      const subscribe = (listener) => source.subscribe(listener);
      const getSnapshot = () => source.getSnapshot();
      hook = function useSelector(selector, isEqual) {
        const select = selector === undefined ? identity : selector;
        const memoized = React.useMemo(() => {
          let hasMemo = false;
          let memoSnapshot;
          let memoSelection;
          return (nextSnapshot) => {
            if (!hasMemo) {
              hasMemo = true;
              memoSnapshot = nextSnapshot;
              memoSelection = select(nextSnapshot);
              return memoSelection;
            }
            if (Object.is(memoSnapshot, nextSnapshot)) return memoSelection;
            const nextSelection = select(nextSnapshot);
            if (isEqual !== undefined && isEqual(memoSelection, nextSelection)) {
              memoSnapshot = nextSnapshot;
              return memoSelection;
            }
            memoSnapshot = nextSnapshot;
            memoSelection = nextSelection;
            return memoSelection;
          };
        }, [select, isEqual]);
        return React.useSyncExternalStore(subscribe, () => memoized(getSnapshot()));
      };
      selectorHookCache.set(source, hook);
      return hook;
    }

    /**
     * Bind a keyed observable family (`(key) => observable`) to a hook. The
     * family may return `undefined` (absent key) — that binds the absent source
     * without changing hook order, exactly like the renderer's keyed hook.
     */
    function keyedSelectorHookFor(family) {
      return function useKeyed(keyOrSelector, selector, isEqual) {
        const key = typeof keyOrSelector === "string" ? keyOrSelector : undefined;
        const select = typeof keyOrSelector === "string" ? selector : keyOrSelector;
        const equal = typeof keyOrSelector === "string" ? isEqual : selector;
        let source;
        if (key === undefined) {
          source = absentSource;
        } else {
          try {
            source = family(key) ?? absentSource;
          } catch {
            source = absentSource;
          }
        }
        return selectorHookFor(source)(select, equal);
      };
    }

    /**
     * Terminal model plumbing for the panel's own seats. Unlike the built-in
     * registration, the panel needs no sidebar occurrence: it synthesizes a
     * unique content identity per seat and lets the controller allocate a
     * fresh Host terminal (`view()` is idempotent per key; a brand-new key
     * with no saved terminalId means "create"). This keeps the panel fully
     * independent of the sidebar layout — the sidebar never sees these tabs.
     *
     * Content identity: a seat must NOT keep a fixed `contentId`, because
     * `webTerminals` caches its bindings by `(sessionId, contentId)`. Once the
     * controller has seen one identity, re-asking for the same identity after
     * the Host terminal is gone returns the OLD terminalId — `view()` then
     * restores with `createWhenMissing=false` and the built-in body renders
     * "此终端已不存在" with a non-working new-terminal button (its button
     * calls the sidebar's `openTab`, which the panel stubs out). So every
     * lookup mints a fresh identity: a re-created seat gets a new terminal.
     */
    function makePanelHelpers(ctx, sessionId) {
      const view = (key) => {
        const seat = panelSeats.items.find((item) => item.key === key);
        if (seat === undefined) return absentView;
        if (seat.contentId === undefined) {
          // Defensive: seats normally mint their identity at creation time.
          seat.contentId = mintSeatContentId(sessionId, key);
        }
        return ctx.webTerminals.view(
          sessionId,
          key,
          seat.contentId,
          seat.terminalId,
          seat.shellPath,
        );
      };
      const stateHook = keyedSelectorHookFor((key) => {
        try {
          return view(key).state;
        } catch {
          return undefined;
        }
      });
      /** Close the seat's process and forget the seat entirely. */
      const close = (key) => {
        const seat = panelSeats.items.find((item) => item.key === key);
        panelSeats.remove(key);
        // The panel render reconciles `panelStore.active` on the spot: when
        // the closed seat was active it falls back to the remaining tab, so
        // there is no window with no live seat (which would strand the
        // pointer and make later clicks inert).
        if (panelStore.active === key) panelStore.setActive(undefined);
        if (seat === undefined) return;
        // The controller is the only owner of close bookkeeping: `close()`
        // records the intent, deletes the (session, contentId) binding and
        // the view, then runs the Host close out of band — surviving DOM
        // unmount and reload, and retrying itself on failure. Calling
        // `view.close()` directly instead would kill the Host process while
        // the controller still counted the seat among the session's
        // terminals, so the per-session limit (8) would fill with phantom
        // terminals and every later seat would fail with
        // "terminal/limit-reached" (which is what the user saw).
        ctx.webTerminals.close(sessionId, key, seat.contentId, seat.terminalId);
      };
      return { view, stateHook, close };
    }

    /** A inert stand-in `TerminalView` used while an occurrence is vanishing. */
    const absentView = {
      state: absentSource,
      mount: () => () => {},
      refresh: () => Promise.resolve(),
      connect: () => {},
      acknowledge: () => {},
      write: () => {},
      resize: () => {},
      rename: () => Promise.resolve(),
      close: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    };

    /** The theme observable the built-in body expects as its `hooks.theme`. */
    function themeSourceFor(ctx) {
      return {
        getSnapshot: () => ctx.theme.getTheme(),
        subscribe: (listener) => ctx.on("theme/change", listener),
      };
    }

    //#endregion

    //#region styles

    const STYLE_ID = "dsh-sidebar-enhancement/client.css";

    const CSS = `
.dse-root{height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);flex-direction:column;flex:auto;line-height:1.5;display:flex}
.dse-header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;align-items:center;gap:4px;height:38px;padding:0 6px 0 16px;display:flex}
.dse-path{margin-right:12px}
.dse-headerTools{margin-left:auto;align-items:center;gap:2px;display:flex}
.dse-body{scrollbar-gutter:stable;flex:auto;min-height:0;margin-right:2px;padding:8px 0 8px 8px;overflow:auto}
.dse-body::-webkit-scrollbar-track{margin:2px}
.dse-level{margin:0;padding:0;list-style:none}
.dse-level .dse-level{padding-left:18px}
.dse-item{margin:0;padding:0}
.dse-rowwrap{position:relative;border-radius:var(--dsw-radius-md)}
.dse-rowwrap.dse-rowwrapOver{background:var(--dsw-alias-interactive-bg-hover);outline:1px dashed var(--dsw-alias-border-strong,rgba(127,156,245,.55));outline-offset:-1px}
.dse-row{width:100%;min-width:0;color:inherit;font:inherit;text-align:left;border-radius:var(--dsw-radius-md);cursor:pointer;background:0 0;border:0;align-items:center;gap:6px;padding:5px 28px 5px 10px;display:flex}
.dse-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dse-rowInput,.dse-rowInput:hover{cursor:default;background:0 0}
.dse-icon{color:var(--dsw-alias-label-tertiary);flex:none}
.dse-fileIcon{flex:none}
.dse-name{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}
.dse-other{color:var(--dsw-alias-label-tertiary);cursor:default}
.dse-other:hover{background:0 0}
.dse-rowmenu{position:absolute;top:50%;right:2px;transform:translateY(-50%);width:24px;height:24px;color:var(--dsw-alias-label-tertiary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:none;opacity:0;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dse-rowwrap:hover .dse-rowmenu,.dse-rowmenu:focus-visible{opacity:1}
.dse-rowmenu:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dse-rowmenu svg{width:14px;height:14px}
.dse-input{flex:1;min-width:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-surface-raised,var(--dsw-alias-interactive-bg-hover));border:1px solid var(--dsw-alias-border-strong,rgba(127,156,245,.55));border-radius:var(--dsw-radius-sm);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);padding:2px 8px;outline:0}
.dse-note{color:var(--dsw-alias-label-tertiary);margin:0;padding:3px 10px;font-size:12px}
.dse-status{flex-direction:column;padding:12px 10px;display:flex}
.dse-statusLine{color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);margin:0;line-height:1.6}
.dse-tool{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:6px;line-height:1;display:inline-flex}
.dse-tool svg{width:15px;height:15px}
.dse-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dse-tool[data-open=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.dse-banner{box-sizing:border-box;flex:none;align-items:center;gap:10px;padding:6px 8px 6px 16px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l3);display:flex}
.dse-banner[data-kind=error]{color:var(--dsw-alias-feedback-danger-fg,#e5484d)}
.dse-bannerText{flex:1;min-width:0}
.dse-close{width:22px;height:22px;flex:none;color:inherit;background:0 0;border:0;border-radius:var(--dsw-radius-sm);cursor:pointer;justify-content:center;align-items:center;padding:4px;display:inline-flex}
.dse-close svg{width:14px;height:14px}
.dse-busy{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:4px 16px 0}
.dse-menuAnchor{position:fixed;width:0;height:0;pointer-events:none}
.dse-ed{height:100%;min-height:0;flex-direction:column;color:var(--dsw-alias-label-primary);display:flex}
.dse-edBar{flex:none;box-sizing:border-box;align-items:center;gap:8px;height:34px;padding:0 8px 0 14px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:12px;color:var(--dsw-alias-label-secondary);display:flex}
.dse-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.dse-dot[data-dirty=true]{background:var(--dsw-alias-feedback-warning-fg,#e2a336)}
.dse-edState{white-space:nowrap}
.dse-edWarn{color:var(--dsw-alias-feedback-warning-fg,#e2a336);align-items:center;gap:8px;display:flex;min-width:0}
.dse-edSpacer{flex:1}
.dse-edHint{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dse-edBtn{color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);cursor:pointer;font:inherit;font-size:12px;padding:2px 10px;white-space:nowrap}
.dse-edBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dse-edBtn:disabled{opacity:.5;cursor:default}
.dse-edNote{flex:none;box-sizing:border-box;align-items:center;gap:8px;padding:5px 8px 5px 14px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l3);display:flex}
.dse-edNote[data-kind=error]{color:var(--dsw-alias-feedback-danger-fg,#e5484d)}
.dse-edNote>span{flex:1;min-width:0;word-break:break-word}
.dse-edLoading{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 14px}
.dse-edText{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;resize:vertical;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12.5px;line-height:1.6;padding:10px 14px;tab-size:2}
.dse-tbar{flex:none;box-sizing:border-box;align-items:center;gap:6px;height:32px;padding:0 6px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:12px;color:var(--dsw-alias-label-secondary);display:flex}
.dse-tbarBtn{width:26px;height:26px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:5px;line-height:1;display:inline-flex}
.dse-tbarBtn svg{width:15px;height:15px}
.dse-tbarBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
/* The tab's close button must render on top of the tab, not inside it: a nested button inside a clickable tab is both invalid HTML and a hit-testing hazard (the parent's click swallows the child's). */
.dse-panelTabClose{position:absolute;top:50%;right:2px;transform:translateY(-50%);width:20px;height:20px;flex:none;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;border-radius:var(--dsw-radius-sm);cursor:pointer;justify-content:center;align-items:center;padding:3px;display:inline-flex}
.dse-dock{flex:0 0 100%;min-width:100%;order:99;box-sizing:border-box;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-surface-base,transparent);display:flex}
/* The built-in composer dock row must wrap so the terminal gets its own full-width line (pills stay on the first line). Scoped to the hashed InputBar dock class of the current DSH build. */
.uV2eYG_dock{flex-wrap:wrap}
.dse-dockGrip{height:6px;flex:none;cursor:ns-resize;touch-action:none}
.dse-dockGrip:hover{background:var(--dsw-alias-border-strong,rgba(127,156,245,.35))}
.dse-dockBody{flex:1;min-height:0;position:relative}
.dse-dockPh{height:100%;justify-content:center;align-items:center;flex-direction:column;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;display:flex}
/* The bottom terminal panel's tab strip: a VS-Code-like row above the terminal. */
.dse-panelBar{flex:none;box-sizing:border-box;align-items:center;gap:8px;min-height:30px;padding:0 6px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-secondary);display:flex}
.dse-panelTabs{flex:1 1 auto;min-width:0;align-items:center;gap:2px;overflow-x:auto;display:flex;scrollbar-width:thin}
/* One panel tab wrapper: the pill + its overlay close button. The wrapper is only a positioning context, so the pill's hover/active styles apply to the inner button and the x sits outside it. */
.dse-panelTabWrap{position:relative;flex:0 0 auto;display:flex}
.dse-panelTab{flex:0 0 auto;width:auto;max-width:200px;min-width:96px;align-items:center;gap:2px;padding:0 22px 0 10px;height:24px;border:0;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap;color:inherit;background:0 0;font:inherit;display:flex}
.dse-panelTab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dse-panelTabWrap[data-active=true] .dse-panelTab{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.dse-panelTabLabel{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px;line-height:1.4}
.dse-panelTabClose svg{width:12px;height:12px}
.dse-panelTabClose:hover{color:var(--dsw-alias-feedback-danger-fg,#e5484d);background:var(--dsw-alias-interactive-bg-hover)}
.dse-panelActions{flex:none;align-items:center;gap:2px;display:flex}
.dse-panelEmpty{align-self:center;color:var(--dsw-alias-label-tertiary);padding:0 6px}
`;

    /** Inject the stylesheet once; returns its disposer for `ctx.effect`. */
    function injectStyle() {
      if (typeof document === "undefined") return undefined;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return undefined;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-sidebar-enhancement";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    //#endregion

    //#region copy dictionaries

    // The locale runtime resolves keys FLAT — `dict["tool.newFile"]` — which is
    // how every shipped plugin declares its namespace. Nested objects
    // (`tool: { newFile }`) never match and silently fall back to the raw key.
    const zh = {
      noWorkspace: "此会话没有可用的工作区目录",
      loading: "读取中…",
      empty: "空目录",
      truncated: "条目过多，仅显示前一部分",
      "error.notFound": "路径不存在",
      "error.outsideWorkspace": "路径在工作区之外",
      "error.notDirectory": "不是目录",
      "error.notText": "不是文本文件",
      "error.notRegularFile": "不是普通文件",
      "error.tooLarge": "文件过大（上限 {limit}）",
      "error.unavailable": "读取失败：{message}",
      "tool.newFile": "新建文件",
      "tool.newDir": "新建目录",
      "tool.upload": "上传文件",
      "tool.refresh": "刷新",
      "menu.more": "更多操作",
      "menu.open": "打开",
      "menu.expand": "展开",
      "menu.collapse": "收起",
      "menu.newFile": "新建文件",
      "menu.newDir": "新建目录",
      "menu.uploadHere": "上传到此目录",
      "menu.rename": "重命名",
      "menu.delete": "删除",
      "create.filePlaceholder": "新文件名",
      "create.dirPlaceholder": "新目录名",
      renameHint: "Enter 确认 · Esc 取消",
      "busy.create": "正在创建…",
      "busy.mkdir": "正在创建目录…",
      "busy.rename": "正在重命名…",
      "busy.delete": "正在删除…",
      "busy.upload": "正在上传…",
      "busy.refresh": "正在刷新…",
      "confirm.deleteFile": "确定删除文件“{name}”吗？此操作不可恢复。",
      "confirm.deleteDir": "确定删除目录“{name}”及其全部内容吗？此操作不可恢复。",
      "confirm.overwrite": "“{name}”已存在，要覆盖它吗？",
      "op.exists": "目标已存在",
      "op.notFound": "路径不存在",
      "op.outside": "路径在工作区之外",
      "op.invalid": "名称无效",
      "op.conflict": "文件已被修改",
      "op.unknownWorkspace": "会话工作区未知",
      "op.tooLarge": "内容过大",
      "op.denied": "没有权限执行此操作",
      "op.network": "网络错误：{message}",
      "op.failed": "操作失败：{message}",
      "op.busy": "有操作正在进行，请稍候",
      "upload.failed": "上传“{name}”失败：{message}",
      "upload.done": "已上传 {count} 个文件",
      "banner.dismiss": "关闭提示",
      "viewer.editor": "可编辑",
      "editor.loading": "正在读取文件…",
      "editor.dirty": "未保存",
      "editor.clean": "已保存",
      "editor.saving": "保存中…",
      "editor.save": "保存",
      "editor.savedNote": "已保存到磁盘",
      "editor.conflict": "该文件已在磁盘上发生变化。仍要覆盖保存你的修改吗？",
      "editor.conflictNote": "已取消保存：磁盘上的文件已被其他来源修改。",
      "editor.diskChanged": "磁盘文件已变化，下方为你的未保存修改",
      "editor.loadDisk": "放弃修改并载入磁盘版本",
      "editor.saveFailed": "保存失败：{message}",
      "editor.loadFailed": "读取失败：{message}",
      "editor.hint": "Ctrl+S 保存",
      "tool.terminal": "终端面板",
      "panel.hide": "隐藏终端面板",
      "panel.empty": "还没有终端，点右侧 + 新建",
      "panel.tab": "终端",
      "tool.newTerminal": "新建终端",
      "dock.loading": "正在载入终端…",
      "dock.failed": "终端组件载入失败，请刷新页面重试",
    };

    const en = {
      noWorkspace: "This session has no workspace directory",
      loading: "Reading…",
      empty: "Empty directory",
      truncated: "Too many entries; showing the first part",
      "error.notFound": "Path not found",
      "error.outsideWorkspace": "Path is outside the workspace",
      "error.notDirectory": "Not a directory",
      "error.notText": "Not a text file",
      "error.notRegularFile": "Not a regular file",
      "error.tooLarge": "File too large (limit {limit})",
      "error.unavailable": "Reading failed: {message}",
      "tool.newFile": "New file",
      "tool.newDir": "New directory",
      "tool.upload": "Upload files",
      "tool.refresh": "Refresh",
      "menu.more": "More actions",
      "menu.open": "Open",
      "menu.expand": "Expand",
      "menu.collapse": "Collapse",
      "menu.newFile": "New file",
      "menu.newDir": "New directory",
      "menu.uploadHere": "Upload here",
      "menu.rename": "Rename",
      "menu.delete": "Delete",
      "create.filePlaceholder": "New file name",
      "create.dirPlaceholder": "New directory name",
      renameHint: "Enter to confirm · Esc to cancel",
      "busy.create": "Creating…",
      "busy.mkdir": "Creating directory…",
      "busy.rename": "Renaming…",
      "busy.delete": "Deleting…",
      "busy.upload": "Uploading…",
      "busy.refresh": "Refreshing…",
      "confirm.deleteFile": "Delete file “{name}”? This cannot be undone.",
      "confirm.deleteDir": "Delete directory “{name}” and everything inside? This cannot be undone.",
      "confirm.overwrite": "“{name}” already exists. Overwrite it?",
      "op.exists": "Target already exists",
      "op.notFound": "Path not found",
      "op.outside": "Path is outside the workspace",
      "op.invalid": "Invalid name",
      "op.conflict": "File changed on disk",
      "op.unknownWorkspace": "Unknown session workspace",
      "op.tooLarge": "Content too large",
      "op.denied": "Permission denied",
      "op.network": "Network error: {message}",
      "op.failed": "Operation failed: {message}",
      "op.busy": "Another operation is in progress",
      "upload.failed": "Uploading “{name}” failed: {message}",
      "upload.done": "Uploaded {count} file(s)",
      "banner.dismiss": "Dismiss",
      "viewer.editor": "Editable",
      "editor.loading": "Reading file…",
      "editor.dirty": "Unsaved changes",
      "editor.clean": "Saved",
      "editor.saving": "Saving…",
      "editor.save": "Save",
      "editor.savedNote": "Saved to disk",
      "editor.conflict": "This file changed on disk. Overwrite it with your changes?",
      "editor.conflictNote": "Save cancelled: the file on disk was modified by something else.",
      "editor.diskChanged": "The file changed on disk; your unsaved edits are below",
      "editor.loadDisk": "Discard edits and load the disk version",
      "editor.saveFailed": "Saving failed: {message}",
      "editor.loadFailed": "Reading failed: {message}",
      "editor.hint": "Ctrl+S to save",
      "tool.terminal": "Terminal panel",
      "panel.hide": "Hide the terminal panel",
      "panel.empty": "No terminals yet — use + to open one",
      "panel.tab": "Terminal",
      "tool.newTerminal": "New terminal",
      "dock.loading": "Loading the terminal…",
      "dock.failed": "Loading the terminal component failed — refresh to retry",
    };

    //#endregion

    //#region small glyphs

    const FolderPlusIcon = () => jsxs("svg", {
      viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor",
      strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      children: [
        jsx("path", { d: "M1.5 4.3a1 1 0 0 1 1-1h3l1.5 1.8h6.5a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" }),
        jsx("path", { d: "M7.4 7.6v3.4M5.7 9.3h3.4" }),
      ],
    });

    const UploadIcon = () => jsxs("svg", {
      viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor",
      strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      children: [
        jsx("path", { d: "M8 10.2V2.6M5.1 5.1 8 2.2l2.9 2.9" }),
        jsx("path", { d: "M2.6 10.4v2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-2" }),
      ],
    });

    const MoreIcon = () => jsxs("svg", {
      viewBox: "0 0 16 16", width: 14, height: 14, fill: "currentColor", "aria-hidden": true,
      children: [
        jsx("circle", { cx: 8, cy: 3.2, r: 1.25 }),
        jsx("circle", { cx: 8, cy: 8, r: 1.25 }),
        jsx("circle", { cx: 8, cy: 12.8, r: 1.25 }),
      ],
    });

    /** Dock-down glyph (kept for the header button's hover affordance). */
    const DockDownIcon = () => jsxs("svg", {
      viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor",
      strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      children: [
        jsx("path", { d: "M2.6 9.6v2.2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1V9.6" }),
        jsx("path", { d: "M8 9.4V2.4M5.4 7 8 9.6 10.6 7" }),
      ],
    });

    /** A terminal window glyph for the header toggle. */
    const TerminalGlyph = () => jsxs("svg", {
      viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor",
      strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      children: [
        jsx("rect", { x: 1.8, y: 2.8, width: 12.4, height: 10.4, rx: 1.6 }),
        jsx("path", { d: "M4.6 6.6 6.4 8.2 4.6 9.8" }),
        jsx("path", { d: "M8.2 9.9h3.2" }),
      ],
    });

    /** Chevron-down for the panel hide action. */
    const IconChevronDownSolid = () => jsx("svg", {
      viewBox: "0 0 16 16", width: 14, height: 14, fill: "currentColor", "aria-hidden": true,
      children: [jsx("path", { d: "M3.2 5.9a1 1 0 0 1 1.6-.4L8 8.3l3.2-2.8a1 1 0 1 1 1.3 1.5l-4 3.4a1 1 0 0 1-1.3 0l-4-3.4a1 1 0 0 1-.4-1.1z" })],
    });

    /** Dock-right: a pane sliding to the right edge (arrow into a right gutter). */
    const DockRightIcon = () => jsxs("svg", {
      viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor",
      strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      children: [
        jsx("path", { d: "M9.6 2.6h2.2a1 1 0 0 1 1 1v8.8a1 1 0 0 1-1 1H9.6" }),
        jsx("path", { d: "M9.4 8H2.4M7 5.4 9.6 8 7 10.6" }),
      ],
    });

    //#endregion

    //#region drag helpers

    const dragHasFiles = (event) => {
      const types = event.dataTransfer?.types;
      if (types === undefined) return false;
      for (const type of types) {
        if (type === "Files") return true;
      }
      return false;
    };

    function onDirDragOver(event, tree, path) {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      if (tree.dropPath !== path) tree.setDropPath(path);
    }

    function onDirDragLeave(event, tree, path) {
      if (tree.dropPath !== path) return;
      if (event.currentTarget.contains?.(event.relatedTarget) === true) return;
      tree.setDropPath(null);
    }

    function onDirDrop(event, tree, path) {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      tree.setDropPath(null);
      const files = event.dataTransfer?.files;
      if (files !== undefined && files.length > 0) void tree.uploadTo(path, files);
    }

    //#endregion

    //#region files tree body

    /** Class-name map, mirroring the built-in body's module shape. */
    const s = {
      root: "dse-root",
      header: "dse-header",
      path: "dse-path",
      headerTools: "dse-headerTools",
      body: "dse-body",
      level: "dse-level",
      item: "dse-item",
      rowwrap: "dse-rowwrap",
      over: "dse-rowwrapOver",
      row: "dse-row",
      rowInput: "dse-rowInput",
      rowmenu: "dse-rowmenu",
      icon: "dse-icon",
      fileIcon: "dse-fileIcon",
      name: "dse-name",
      other: "dse-other",
      note: "dse-note",
      status: "dse-status",
      statusLine: "dse-statusLine",
      tool: "dse-tool",
      input: "dse-input",
      banner: "dse-banner",
      bannerText: "dse-bannerText",
      close: "dse-close",
      busy: "dse-busy",
      menuAnchor: "dse-menuAnchor",
      ed: "dse-ed",
      edBar: "dse-edBar",
      dot: "dse-dot",
      edState: "dse-edState",
      edWarn: "dse-edWarn",
      edSpacer: "dse-edSpacer",
      edHint: "dse-edHint",
      edBtn: "dse-edBtn",
      edNote: "dse-edNote",
      edLoading: "dse-edLoading",
      edText: "dse-edText",
    };

    /** Context-menu items for one target: root, directory or file. */
    function menuItemsFor(t, target) {
      const items = [];
      if (target.kind === "file") items.push({ id: "open", label: t("menu.open") });
      if (target.kind === "directory") {
        items.push({ id: target.expanded === true ? "collapse" : "expand", label: t(target.expanded === true ? "menu.collapse" : "menu.expand") });
      }
      items.push({ id: "newFile", label: t("menu.newFile") });
      items.push({ id: "newDir", label: t("menu.newDir") });
      if (target.kind === "directory" || target.kind === "root") items.push({ id: "upload", label: t("menu.uploadHere") });
      if (target.kind === "file" || target.kind === "directory") {
        items.push({ type: "separator", id: "sep-edit" });
        items.push({ id: "rename", label: t("menu.rename") });
        items.push({ id: "delete", label: t("menu.delete"), danger: true });
      }
      return items;
    }

    /** One inline rename input. */
    function RenameInput({ tree }) {
      const current = tree.renaming;
      return jsx("input", {
        ref: tree.renameInputRef,
        className: s.input,
        value: current.value,
        spellCheck: false,
        autoComplete: "off",
        "aria-label": tree.t("menu.rename"),
        title: tree.t("renameHint"),
        "data-enh-rename-input": true,
        onChange: (event) => tree.changeRename(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void tree.submitRename();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            tree.cancelRename();
          }
        },
        onBlur: () => tree.cancelRename(),
      });
    }

    /** One inline create input, drawn inside the target level. */
    function CreateRow({ tree }) {
      const current = tree.creating;
      const isFile = current.kind === "file";
      return jsx("li", {
        className: s.item,
        "data-enh-create": current.kind,
        children: jsxs("div", {
          className: `${s.row} ${s.rowInput}`,
          children: [
            isFile
              ? jsx(P.FileTypeIcon, { kind: P.classifyFileType(current.value || "file"), className: s.fileIcon, key: "icon" })
              : jsx(P.IconFolderCloseRegular, { className: s.icon, key: "icon" }),
            jsx("input", {
              ref: tree.createInputRef,
              className: s.input,
              value: current.value,
              spellCheck: false,
              autoComplete: "off",
              placeholder: isFile ? tree.t("create.filePlaceholder") : tree.t("create.dirPlaceholder"),
              "aria-label": isFile ? tree.t("create.filePlaceholder") : tree.t("create.dirPlaceholder"),
              "data-enh-create-input": true,
              onChange: (event) => tree.changeCreate(event.target.value),
              onKeyDown: (event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void tree.submitCreate();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  tree.cancelCreate();
                }
              },
              onBlur: () => tree.cancelCreate(),
              key: "input",
            }),
          ],
        }),
      });
    }

    /** The hover `⋯` button of one row. */
    function RowMenuButton({ tree, target }) {
      return jsx("button", {
        type: "button",
        className: s.rowmenu,
        "aria-label": tree.t("menu.more"),
        title: tree.t("menu.more"),
        onClick: (event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          tree.openMenuAt(rect.left, rect.bottom + 4, target);
        },
        onContextMenu: (event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          tree.openMenuAt(rect.left, rect.bottom + 4, target);
        },
        children: jsx(MoreIcon, {}),
      });
    }

    /** One entry's row, and its children when it is an expanded directory. */
    function Entry({ parent, entry, tree }) {
      const path = childPath(parent, entry.name);
      if (entry.type === "directory") {
        const expanded = tree.expanded.includes(path);
        const renaming = tree.renaming !== null && tree.renaming.path === path;
        const target = { kind: "directory", parent, name: entry.name, path, expanded };
        return jsxs("li", {
          className: s.item,
          "data-files-entry": "directory",
          "data-files-path": path,
          children: [
            jsxs("div", {
              className: cx(s.rowwrap, tree.dropPath === path ? s.over : null),
              onDragOver: (event) => onDirDragOver(event, tree, path),
              onDragLeave: (event) => onDirDragLeave(event, tree, path),
              onDrop: (event) => onDirDrop(event, tree, path),
              onContextMenu: (event) => tree.onContext(event, target),
              children: [
                renaming
                  ? jsxs("div", { className: `${s.row} ${s.rowInput}`, children: [
                      expanded ? jsx(P.IconFolderOpenRegular, { className: s.icon }) : jsx(P.IconFolderCloseRegular, { className: s.icon }),
                      jsx(RenameInput, { tree }),
                    ], key: "renaming" })
                  : jsxs("button", {
                      type: "button",
                      className: s.row,
                      "aria-expanded": expanded,
                      onClick: () => tree.onToggle(path),
                      children: [
                        expanded ? jsx(P.IconFolderOpenRegular, { className: s.icon }) : jsx(P.IconFolderCloseRegular, { className: s.icon }),
                        jsx("span", { className: s.name, children: entry.name }),
                      ],
                      key: "row",
                    }),
                jsx(RowMenuButton, { tree, target, key: "menu" }),
              ],
              key: "wrap",
            }),
            expanded ? jsx("ul", { className: s.level, children: jsx(Level, { path, tree }) }) : null,
          ],
        });
      }
      if (entry.type === "file") {
        const renaming = tree.renaming !== null && tree.renaming.path === path;
        const target = { kind: "file", parent, name: entry.name, path };
        return jsx("li", {
          className: s.item,
          "data-files-entry": "file",
          "data-files-path": path,
          children: jsxs("div", {
            className: s.rowwrap,
            onContextMenu: (event) => tree.onContext(event, target),
            children: [
              renaming
                ? jsxs("div", { className: `${s.row} ${s.rowInput}`, children: [
                    jsx(P.FileTypeIcon, { kind: P.classifyFileType(entry.name), className: s.fileIcon }),
                    jsx(RenameInput, { tree }),
                  ], key: "renaming" })
                : jsxs("button", {
                    type: "button",
                    className: s.row,
                    onClick: () => tree.onOpen(path),
                    children: [
                      jsx(P.FileTypeIcon, { kind: P.classifyFileType(entry.name), className: s.fileIcon }),
                      jsx("span", { className: s.name, children: entry.name }),
                    ],
                    key: "row",
                  }),
              jsx(RowMenuButton, { tree, target, key: "menu" }),
            ],
          }),
        });
      }
      return jsx("li", {
        className: s.item,
        "data-files-entry": "other",
        "data-files-path": path,
        children: jsx("div", {
          className: s.rowwrap,
          children: jsx("div", { className: `${s.row} ${s.other}`, children: jsx("span", { className: s.name, children: entry.name }) }),
        }),
      });
    }

    /** One directory's listing, plus the inline create row when it is the target. */
    function Level({ path, tree }) {
      const { t, levels, creating } = tree;
      const level = levels[path];
      const children = [];
      if (creating !== null && creating.parent === path) {
        children.push(jsx(CreateRow, { tree, key: "create" }));
      }
      if (level === undefined || level.kind === "loading") {
        children.push(jsx("li", { className: s.note, "data-files-row": "loading", children: t("loading"), key: "status" }));
        return jsx(Fragment, { children });
      }
      if (level.kind === "failed") {
        children.push(jsx("li", { className: s.note, "data-files-row": "failed", children: failureLine(t, level.failure), key: "status" }));
        return jsx(Fragment, { children });
      }
      const entries = orderEntries(level.level.entries);
      if (entries.length === 0 && creating === null) {
        children.push(jsx("li", { className: s.note, "data-files-row": "empty", children: t("empty"), key: "empty" }));
      }
      entries.forEach((entry) => {
        children.push(jsx(Entry, { parent: path, entry, tree, key: entry.name }));
      });
      if (level.level.failure !== undefined && level.level.failure !== null) {
        children.push(jsx("li", { className: s.note, "data-files-row": "partial", children: failureLine(t, level.level.failure), key: "partial" }));
      }
      if (level.level.truncated === true) {
        children.push(jsx("li", { className: s.note, "data-files-row": "truncated", children: t("truncated"), key: "truncated" }));
      }
      return jsx(Fragment, { children });
    }

    /**
     * The enhanced files body: the session's workspace root, listed one level at
     * a time, with rename, create, upload and delete on every entry. Structure
     * and class layout mirror the built-in tree; behavior is this package's own.
     */
    function FilesEnhancedBody({ useTabInfo, sessionId, useSessions, t, renderSlot, makeFace }) {
      const tab = useTabInfo()?.tab;
      const signal = tab?.signal;
      const tabActions = tab?.actions;
      const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
      const face = React.useMemo(() => makeFace(sessionId), [makeFace, sessionId]);

      const [expanded, setExpanded] = React.useState([]);
      const [levels, setLevels] = React.useState({});
      const [creating, setCreating] = React.useState(null);
      const [renaming, setRenaming] = React.useState(null);
      const [menu, setMenu] = React.useState(null);
      const [banner, setBanner] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [dropPath, setDropPath] = React.useState(null);

      const levelsRef = React.useRef(levels);
      levelsRef.current = levels;
      const tokensRef = React.useRef({});
      const busyRef = React.useRef(null);
      const createRef = React.useRef(null);
      createRef.current = creating;
      const renameRef = React.useRef(null);
      renameRef.current = renaming;
      const menuRef = React.useRef(null);
      menuRef.current = menu;
      const fileInputRef = React.useRef(null);
      const uploadTargetRef = React.useRef(null);
      const renameInputRef = React.useRef(null);
      const createInputRef = React.useRef(null);

      /** List one directory; the latest request per path wins. */
      const loadLevel = React.useCallback(async (path) => {
        if (path === undefined || signal?.aborted === true) return;
        const tokens = tokensRef.current;
        const token = (tokens[path] ?? 0) + 1;
        tokens[path] = token;
        setLevels((prev) => {
          const current = prev[path];
          if (current !== undefined) return { ...prev, [path]: { ...current, refreshing: true } };
          return { ...prev, [path]: { kind: "loading" } };
        });
        let result;
        try {
          result = await face.list(path, signal);
        } catch (error) {
          if (signal?.aborted === true || tokens[path] !== token) return;
          setLevels((prev) => ({
            ...prev,
            [path]: { kind: "failed", failure: { code: "gateway/internal", message: String(error?.message ?? error) } },
          }));
          return;
        }
        if (signal?.aborted === true || tokensRef.current[path] !== token) return;
        if (result.ok) setLevels((prev) => ({ ...prev, [path]: { kind: "ready", level: result.value } }));
        else setLevels((prev) => ({ ...prev, [path]: { kind: "failed", failure: result.error } }));
      }, [face, signal]);

      /** First load of the root, whenever the workspace becomes known. */
      React.useEffect(() => {
        if (cwd === undefined) return;
        if (levels[cwd] === undefined) void loadLevel(cwd);
      }, [cwd, levels, loadLevel]);

      /** Reload every listed level (the refresh button). */
      const refreshAll = React.useCallback(() => {
        if (cwd === undefined) return;
        void loadLevel(cwd);
        for (const [path, level] of Object.entries(levelsRef.current)) {
          if (path !== cwd && level.kind !== "loading") void loadLevel(path);
        }
      }, [cwd, loadLevel]);

      /** Run one mutation with busy/banner bookkeeping; resolves true on success. */
      const runOp = React.useCallback(async (kind, fn) => {
        if (busyRef.current !== null) {
          setBanner({ kind: "info", text: t("op.busy") });
          return false;
        }
        busyRef.current = kind;
        setBusy(kind);
        setBanner(null);
        try {
          const result = await fn();
          if (result !== undefined && result !== null && result.ok !== true) {
            setBanner({ kind: "error", text: opMessage(t, result.error) });
            return false;
          }
          return true;
        } catch (error) {
          setBanner({ kind: "error", text: opMessage(t, { code: "failed", message: String(error?.message ?? error) }) });
          return false;
        } finally {
          busyRef.current = null;
          setBusy(null);
        }
      }, [t]);

      /** Drop every level and expansion under one removed/renamed directory. */
      const pruneUnder = React.useCallback((root) => {
        const prefix = root.endsWith("/") ? root : `${root}/`;
        setLevels((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== root && !key.startsWith(prefix))));
        setExpanded((prev) => prev.filter((key) => key !== root && !key.startsWith(prefix)));
      }, []);

      const openPath = React.useCallback((path) => {
        tabActions?.openResource?.(fileAddressFor(sessionId, cwd, path));
      }, [tabActions, sessionId, cwd]);

      const toggle = React.useCallback((path) => {
        setExpanded((prev) => (prev.includes(path) ? prev.filter((key) => key !== path) : [...prev, path]));
        const level = levelsRef.current[path];
        if (level === undefined || level.kind === "failed") void loadLevel(path);
      }, [loadLevel]);

      const startCreate = React.useCallback((parent, kind) => {
        setBanner(null);
        setCreating({ parent, kind, value: "" });
        setExpanded((prev) => (prev.includes(parent) ? prev : [...prev, parent]));
        const level = levelsRef.current[parent];
        if (level === undefined || level.kind === "failed") void loadLevel(parent);
      }, [loadLevel]);

      const changeCreate = React.useCallback((value) => {
        const current = createRef.current;
        if (current === null) return;
        const next = { ...current, value };
        createRef.current = next;
        setCreating(next);
      }, []);

      const submitCreate = React.useCallback(async () => {
        const current = createRef.current;
        if (current === null) return;
        const name = current.value.trim();
        createRef.current = null;
        setCreating(null);
        if (!validName(name)) {
          setBanner({ kind: "error", text: t("op.invalid") });
          return;
        }
        const target = childPath(current.parent, name);
        const ok = await runOp(current.kind === "file" ? "create" : "mkdir", () =>
          current.kind === "file" ? face.create(target) : face.mkdir(target));
        if (ok) void loadLevel(current.parent);
      }, [face, loadLevel, runOp, t]);

      const cancelCreate = React.useCallback(() => {
        createRef.current = null;
        setCreating(null);
      }, []);

      const startRename = React.useCallback((parent, path, name, kind) => {
        setBanner(null);
        setRenaming({ parent, path, name, kind, value: name });
      }, []);

      const changeRename = React.useCallback((value) => {
        const current = renameRef.current;
        if (current === null) return;
        const next = { ...current, value };
        renameRef.current = next;
        setRenaming(next);
      }, []);

      const submitRename = React.useCallback(async () => {
        const current = renameRef.current;
        if (current === null) return;
        const value = current.value.trim();
        renameRef.current = null;
        setRenaming(null);
        if (!validName(value)) {
          setBanner({ kind: "error", text: t("op.invalid") });
          return;
        }
        const to = childPath(current.parent, value);
        if (to === current.path) return;
        const ok = await runOp("rename", () => face.rename(current.path, to));
        if (ok) {
          if (current.kind === "directory") pruneUnder(current.path);
          void loadLevel(current.parent);
        }
      }, [face, loadLevel, pruneUnder, runOp, t]);

      const cancelRename = React.useCallback(() => {
        renameRef.current = null;
        setRenaming(null);
      }, []);

      const deleteEntry = React.useCallback(async (target) => {
        const message = target.kind === "directory"
          ? t("confirm.deleteDir", { name: target.name })
          : t("confirm.deleteFile", { name: target.name });
        if (typeof window === "undefined" || !window.confirm(message)) return;
        const ok = await runOp("delete", () => face.remove(target.path));
        if (ok) {
          if (target.kind === "directory") pruneUnder(target.path);
          void loadLevel(target.parent);
        }
      }, [face, loadLevel, pruneUnder, runOp, t]);

      /** Upload a file list into one directory, confirming overwrites one by one. */
      const uploadTo = React.useCallback(async (dir, fileList) => {
        const files = Array.from(fileList ?? []);
        if (files.length === 0) return;
        if (busyRef.current !== null) {
          setBanner({ kind: "info", text: t("op.busy") });
          return;
        }
        busyRef.current = "upload";
        setBusy("upload");
        setBanner(null);
        let done = 0;
        try {
          for (const file of files) {
            if (file.name.includes("/") || file.name.includes("\\")) {
              setBanner({ kind: "error", text: t("upload.failed", { name: file.name, message: t("op.invalid") }) });
              break;
            }
            if (file.size > MAX_UPLOAD_BYTES) {
              setBanner({ kind: "error", text: t("upload.failed", { name: file.name, message: t("error.tooLarge", { limit: humanBytes(MAX_UPLOAD_BYTES) }) }) });
              break;
            }
            let buffer;
            try {
              buffer = await file.arrayBuffer();
            } catch (error) {
              setBanner({ kind: "error", text: t("upload.failed", { name: file.name, message: String(error?.message ?? error) }) });
              break;
            }
            const bytes = new Uint8Array(buffer);
            const target = childPath(dir, file.name);
            let result = await face.upload(target, bytes, false, signal);
            if (!result.ok && result.error?.code === "exists") {
              if (typeof window !== "undefined" && window.confirm(t("confirm.overwrite", { name: file.name }))) {
                result = await face.upload(target, bytes, true, signal);
              }
            }
            if (!result.ok) {
              setBanner({ kind: "error", text: t("upload.failed", { name: file.name, message: opMessage(t, result.error) }) });
              break;
            }
            done += 1;
          }
        } finally {
          busyRef.current = null;
          setBusy(null);
        }
        if (done > 0) setBanner({ kind: "info", text: t("upload.done", { count: done }) });
        void loadLevel(dir);
      }, [face, loadLevel, signal, t]);

      const openMenuAt = React.useCallback((x, y, target) => {
        setMenu({ x, y, target });
      }, []);

      const onMenuSelect = React.useCallback((id) => {
        const current = menuRef.current;
        setMenu(null);
        if (current === null) return;
        const target = current.target;
        if (id === "open" && target.kind === "file") {
          openPath(target.path);
          return;
        }
        if (id === "expand" || id === "collapse") {
          toggle(target.path);
          return;
        }
        if (id === "newFile") {
          startCreate(target.parent, "file");
          return;
        }
        if (id === "newDir") {
          startCreate(target.parent, "dir");
          return;
        }
        if (id === "upload") {
          uploadTargetRef.current = target.kind === "root" ? target.path : target.path;
          const input = fileInputRef.current;
          if (input !== null) {
            input.value = "";
            input.click();
          }
          return;
        }
        if (id === "rename") {
          startRename(target.parent, target.path, target.name, target.kind);
          return;
        }
        if (id === "delete") {
          void deleteEntry(target);
        }
      }, [deleteEntry, openPath, startCreate, startRename, toggle]);

      /** Focus and preselect the inline rename input when a rename starts. */
      React.useEffect(() => {
        const el = renameInputRef.current;
        if (el === null || renaming === null) return;
        el.focus();
        const dot = renaming.name.lastIndexOf(".");
        const end = dot > 0 ? dot : renaming.name.length;
        try {
          el.setSelectionRange(0, end);
        } catch {
          /* some input types refuse selection */
        }
      }, [renaming === null ? null : renaming.path]);

      /** Focus the inline create input when a create starts. */
      React.useEffect(() => {
        const el = createInputRef.current;
        if (el === null || creating === null) return;
        el.focus();
      }, [creating === null ? null : `${creating.parent}:${creating.kind}`]);

      if (cwd === undefined) {
        return jsx("div", {
          className: s.status,
          "data-files-state": "no-workspace",
          children: jsx("p", { className: s.statusLine, children: t("noWorkspace") }),
        });
      }

      const tree = {
        t,
        cwd,
        expanded,
        levels,
        creating,
        renaming,
        dropPath,
        onToggle: toggle,
        onOpen: openPath,
        onContext: (event, target) => {
          event.preventDefault();
          event.stopPropagation();
          openMenuAt(event.clientX, event.clientY, target);
        },
        openMenuAt,
        startCreate,
        changeCreate,
        submitCreate,
        cancelCreate,
        startRename,
        changeRename,
        submitRename,
        cancelRename,
        deleteEntry,
        uploadTo,
        setDropPath,
        renameInputRef,
        createInputRef,
      };

      const headerTool = (label, icon, onClick) => jsx(P.Tooltip, {
        label,
        side: "bottom",
        delayMs: 500,
        children: jsx("button", { type: "button", className: s.tool, "aria-label": label, onClick, children: icon }),
      });

      return jsxs("div", {
        className: s.root,
        "data-files-state": "enhanced",
        "data-files-root": cwd,
        onDragOver: (event) => onDirDragOver(event, tree, cwd),
        onDragLeave: (event) => onDirDragLeave(event, tree, cwd),
        onDrop: (event) => onDirDrop(event, tree, cwd),
        onContextMenu: (event) => {
          event.preventDefault();
          openMenuAt(event.clientX, event.clientY, { kind: "root", parent: cwd, path: cwd, name: "" });
        },
        children: [
          jsxs("div", { className: s.header, key: "header", children: [
            jsx(P.PathLabel, { path: cwd, className: s.path, "data-files-path": true, key: "path" }),
            jsxs("div", { className: s.headerTools, key: "tools", children: [
              headerTool(t("tool.newFile"), jsx(P.IconPlusOutlineRegular, {}), () => startCreate(cwd, "file")),
              headerTool(t("tool.newDir"), jsx(FolderPlusIcon, {}), () => startCreate(cwd, "dir")),
              headerTool(t("tool.upload"), jsx(UploadIcon, {}), () => {
                uploadTargetRef.current = cwd;
                const input = fileInputRef.current;
                if (input !== null) {
                  input.value = "";
                  input.click();
                }
              }),
              headerTool(t("tool.refresh"), jsx(P.IconRefreshOutlineRegular, {}), refreshAll),
            ] }),
            // One declarer per slot: the shipped files tab owns this shared
            // actions seat, and renderSlot only exists when THIS entry made
            // the claim. Render the row only when we own it; otherwise skip
            // (the row's occupants stay reachable from the built-in body).
            typeof renderSlot === "function" ? renderSlot("sidebar.right.tab.files.actions", { absolutePath: cwd }) : null,
          ] }),
          banner === null ? null : jsxs("div", { className: s.banner, "data-kind": banner.kind, role: banner.kind === "error" ? "alert" : "status", key: "banner", children: [
            jsx("span", { className: s.bannerText, children: banner.text }),
            jsx("button", {
              type: "button",
              className: s.close,
              "aria-label": t("banner.dismiss"),
              onClick: () => setBanner(null),
              children: jsx(P.IconCloseOutlineRegular, {}),
            }),
          ] }),
          busy === null ? null : jsx("div", { className: s.busy, role: "status", children: t(`busy.${busy}`), key: "busy" }),
          jsx("div", { className: s.body, "data-files-body": true, key: "body", children: jsx("ul", { className: s.level, children: jsx(Level, { path: cwd, tree }) }) }),
          menu === null ? null : jsx(P.Menu, {
            open: true,
            anchor: jsx("span", { className: s.menuAnchor, style: { left: menu.x, top: menu.y } }),
            getAnchorRect: () => (typeof DOMRect === "function" ? new DOMRect(menu.x, menu.y, 0, 0) : null),
            portal: true,
            side: "bottom",
            align: "start",
            items: menuItemsFor(t, menu.target),
            onSelect: onMenuSelect,
            onClose: () => setMenu(null),
            key: "menu",
          }),
          jsx("input", {
            type: "file",
            multiple: true,
            ref: fileInputRef,
            style: { display: "none" },
            "aria-hidden": true,
            tabIndex: -1,
            onChange: (event) => {
              const files = event.target.files;
              const dir = uploadTargetRef.current;
              event.target.value = "";
              if (dir !== null && dir !== undefined && files !== null && files.length > 0) void uploadTo(dir, files);
            },
            key: "file-input",
          }),
        ],
      });
    }

    //#endregion

    //#region editable document renderer

    /**
     * Text-ish suffixes the editable renderer claims. Shipped viewers that
     * register the same suffix keep winning on registration order; this
     * definition then stays available through the viewer switcher.
     */
    const EDITOR_EXTENSIONS = [
      "txt", "text", "md", "markdown", "mdown", "mkd", "mdx", "rst", "adoc", "asciidoc",
      "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "config",
      "properties", "env", "example", "csv", "tsv", "log", "lock",
      "gitignore", "gitattributes", "gitmodules", "gitconfig", "npmignore", "dockerignore",
      "editorconfig", "npmrc", "prettierrc", "eslintrc", "babelrc", "stylelintrc",
      "browserslistrc", "nvmrc", "pylintrc",
      "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte", "astro", "css", "scss",
      "sass", "less", "styl", "html", "htm", "xml", "xsl", "xslt", "xhtml", "svg",
      "webmanifest", "map",
      "sh", "bash", "zsh", "ksh", "fish", "bat", "cmd", "ps1", "psm1", "psd1",
      "py", "pyi", "pyw", "rb", "php", "go", "rs", "java", "kt", "kts", "c", "h", "cc",
      "cpp", "cxx", "hpp", "hh", "hxx", "cs", "fs", "fsx", "fsi", "swift", "scala",
      "clj", "cljs", "cljc", "ex", "exs", "erl", "hrl", "hs", "lua", "r", "dart", "pl",
      "sql", "graphql", "gql", "proto", "gradle", "cmake", "mk", "tf", "tfvars", "hcl",
      "diff", "patch", "tex", "bib", "org", "ics", "vcf",
    ];

    /**
     * The editable renderer's body: read the whole file through its face, edit
     * in a textarea, save through the Host route with optimistic concurrency.
     * Renderer-contract versioning is honored: `content.loaded(version)` after a
     * settled read or save, `content.failed()` when the file cannot be read.
     */
    function EditorBody({ sessionId, useSessions, t, content, wrap, resourceAddress, scrollportRef, makeFace }) {
      const parsed = React.useMemo(() => parseFileAddress(resourceAddress), [resourceAddress]);
      const fileSessionId = parsed !== undefined && parsed.scope === "session" ? parsed.sessionId : sessionId;
      const cwd = useSessions((sessions) => sessions.byId[fileSessionId]?.cwd);
      const absPath = React.useMemo(() => {
        if (parsed === undefined || parsed.scope !== "session") return undefined;
        const raw = parsed.path.replace(/\\/g, "/");
        if (raw === "") return undefined;
        if (isAbsoluteWorkspacePath(raw)) return raw;
        if (cwd === undefined) return undefined;
        return childPath(cwd, raw);
      }, [parsed, cwd]);
      const face = React.useMemo(() => makeFace(fileSessionId), [makeFace, fileSessionId]);

      const [text, setText] = React.useState("");
      const [savedText, setSavedText] = React.useState("");
      const [baseVersion, setBaseVersion] = React.useState(undefined);
      const [phase, setPhase] = React.useState("loading");
      const [note, setNote] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [saving, setSaving] = React.useState(false);

      const textRef = React.useRef(text);
      textRef.current = text;
      const savedRef = React.useRef(savedText);
      savedRef.current = savedText;
      const versionRef = React.useRef(baseVersion);
      versionRef.current = baseVersion;
      const contentRef = React.useRef(content);
      contentRef.current = content;
      const savingRef = React.useRef(false);

      const renderer = content !== undefined && content !== null && content.kind === "renderer";
      const revision = renderer ? content.revision : -1;
      const dirty = text !== savedText;
      const editable = !(text === "" && savedText === "" && phase !== "ready");

      /** Adopt one settled read, unless the user edited while it was in flight. */
      const applyLoaded = React.useCallback((loadedText, version, owner) => {
        if (textRef.current !== savedRef.current) {
          setPending({ text: loadedText, version });
          return;
        }
        setText(loadedText);
        setSavedText(loadedText);
        setBaseVersion(version);
        setPhase("ready");
        setPending(null);
        setNote(null);
        owner.loaded(version);
      }, []);

      /** Read on mount and on every owner revision bump. */
      React.useEffect(() => {
        if (revision === -1) return;
        const owner = contentRef.current;
        if (owner === undefined || owner.kind !== "renderer") return undefined;
        if (absPath === undefined) {
          setPhase("error");
          setNote({ kind: "error", text: t("editor.loadFailed", { message: t("error.unavailable", { message: "unknown file address" }) }) });
          owner.failed?.();
          return undefined;
        }
        let cancelled = false;
        const controller = new AbortController();
        (async () => {
          if (textRef.current === savedRef.current) setPhase("loading");
          try {
            const result = await face.readAll(absPath, controller.signal);
            if (cancelled) return;
            if (!result.ok) {
              setPhase("error");
              setNote({ kind: "error", text: t("editor.loadFailed", { message: readFailureLine(t, result.error) }) });
              owner.failed?.();
              return;
            }
            applyLoaded(result.value.text, result.value.version, owner);
          } catch (error) {
            if (cancelled || controller.signal.aborted) return;
            setPhase("error");
            setNote({ kind: "error", text: t("editor.loadFailed", { message: String(error?.message ?? error) }) });
            owner.failed?.();
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [revision, absPath, face, t, applyLoaded]);

      /** Save the textarea's text; on a version conflict, confirm and force. */
      const save = React.useCallback(async (force) => {
        if (savingRef.current || absPath === undefined) return;
        const sent = textRef.current;
        savingRef.current = true;
        setSaving(true);
        setNote(null);
        try {
          const result = await face.save(absPath, sent, force ? undefined : versionRef.current);
          if (result.ok) {
            const version = result.value?.version;
            setSavedText(sent);
            if (version !== undefined) {
              setBaseVersion(version);
              const owner = contentRef.current;
              if (owner !== undefined && owner !== null && owner.kind === "renderer") owner.loaded(version);
            }
            setPending(null);
            setNote({ kind: "info", text: t("editor.savedNote") });
            return;
          }
          if (result.status === 409) {
            if (typeof window !== "undefined" && window.confirm(t("editor.conflict"))) {
              savingRef.current = false;
              setSaving(false);
              await save(true);
              return;
            }
            setNote({ kind: "error", text: t("editor.conflictNote") });
            return;
          }
          setNote({ kind: "error", text: t("editor.saveFailed", { message: opMessage(t, result.error) }) });
        } catch (error) {
          setNote({ kind: "error", text: t("editor.saveFailed", { message: String(error?.message ?? error) }) });
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      }, [absPath, face, t]);

      /** Apply the stashed disk version, discarding local edits. */
      const applyPending = React.useCallback(() => {
        const current = pending;
        if (current === null) return;
        setText(current.text);
        setSavedText(current.text);
        setBaseVersion(current.version);
        setPending(null);
        setNote(null);
        const owner = contentRef.current;
        if (owner !== undefined && owner !== null && owner.kind === "renderer") owner.loaded(current.version);
      }, [pending]);

      const onKeyDown = React.useCallback((event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === "s") {
          event.preventDefault();
          void save(false);
        }
      }, [save]);

      if (!renderer) return null;

      const statusText = saving ? t("editor.saving") : (dirty ? t("editor.dirty") : t("editor.clean"));

      return jsxs("div", {
        className: s.ed,
        "data-enh-editor": phase,
        children: [
          jsxs("div", { className: s.edBar, key: "bar", children: [
            jsx("span", { className: s.dot, "data-dirty": dirty ? "true" : "false", "aria-hidden": true, key: "dot" }),
            jsx("span", { className: s.edState, children: statusText, key: "state" }),
            pending === null ? null : jsxs("span", { className: s.edWarn, role: "status", key: "pending", children: [
              jsx("span", { children: t("editor.diskChanged") }),
              jsx("button", { type: "button", className: s.edBtn, onClick: applyPending, children: t("editor.loadDisk") }),
            ] }),
            jsx("span", { className: s.edSpacer, key: "spacer" }),
            jsx("span", { className: s.edHint, children: t("editor.hint"), key: "hint" }),
            jsx("button", {
              type: "button",
              className: s.edBtn,
              disabled: !dirty || saving || absPath === undefined,
              onClick: () => void save(false),
              "data-enh-save": true,
              children: saving ? t("editor.saving") : t("editor.save"),
              key: "save",
            }),
          ] }),
          note === null ? null : jsxs("div", { className: s.edNote, "data-kind": note.kind, role: note.kind === "error" ? "alert" : "status", key: "note", children: [
            jsx("span", { children: note.text }),
            jsx("button", {
              type: "button",
              className: s.close,
              "aria-label": t("banner.dismiss"),
              onClick: () => setNote(null),
              children: jsx(P.IconCloseOutlineRegular, {}),
            }),
          ] }),
          phase === "loading" && text === "" ? jsx("div", { className: s.edLoading, children: t("editor.loading"), key: "loading" }) : null,
          jsx("textarea", {
            ref: scrollportRef,
            className: s.edText,
            value: text,
            wrap: wrap === false ? "off" : "soft",
            spellCheck: false,
            autoComplete: "off",
            disabled: !editable,
            rows: 16,
            "data-enh-editor-text": true,
            "aria-label": absPath ?? "",
            onChange: (event) => setText(event.target.value),
            onKeyDown,
            key: "text",
          }),
        ],
      });
    }

    //#endregion

    //#region terminal dock bodies

    /**
     * Per-apply bindings the terminal components resolve lazily: the theme
     * hook, the built-in terminal locale translator, and the per-session view
     * helpers. Assigned once in `apply` (single plugin instance).
     */
    const terminalRuntime = {
      useTheme: undefined,
      tTerm: undefined,
    };

    /**
     * The panel's lazy chunk handle: the panel body starts loading when it
     * mounts, the promise is cached (and re-armed on failure) so switching
     * tabs never reloads it.
     */
    const terminalChunk = {
      promise: undefined,
      /** Start/load the chunk; returns a promise of `{ TerminalBody }`. */
      load(require) {
        if (this.promise === undefined) {
          this.promise = ensureTerminalChunk(require).catch((error) => {
            this.promise = undefined;
            throw error;
          });
        }
        return this.promise;
      },
      /** The cached promise, or `undefined` if loading never started. */
      peek() {
        return this.promise;
      },
    };

    /** Load the built-in terminal chunk once when enabled (`enabledKey > 0`).
     * Yields `undefined` while loading, `null` on failure (retry by bumping the
     * key), or `{ Body }` with the chunk's `TerminalBody` component.
     */
    function useTerminalChunk(enabledKey) {
      const [state, setState] = React.useState(undefined);
      React.useEffect(() => {
        if (enabledKey <= 0) return;
        let disposed = false;
        setState(undefined);
        ensureTerminalChunk(require).then(
          (chunk) => {
            if (!disposed) setState({ Body: chunk?.TerminalBody });
          },
          () => {
            if (!disposed) setState(null);
          },
        );
        return () => {
          disposed = true;
        };
      }, [enabledKey]);
      return state;
    }

    /**
     * Seat the built-in `TerminalBody` on my own inject bindings. The chunk
     * component is a plain React component whose props are exactly the five
     * below (verified against the shipped chunk: it destructures
     * `{ useTabInfo, useTerminal, useTheme, view, t }` and reads failure
     * states from the observable itself), so no slot machinery is involved.
     *
     * The seat wrapper owns `model.mount()`: the body's own mount effect only
     * runs once it renders, and it renders `null` before the first snapshot
     * arrives, which would otherwise delay the allocation to an indeterminate
     * point.
     */
    function BoundTerminalBody({ Body, helpers, useTheme, tTerm, tab }) {
      return jsx(Body, {
        useTabInfo: () => ({ tab }),
        useTerminal: helpers.stateHook,
        useTheme,
        view: helpers.view,
        t: tTerm,
      });
    }

    //#endregion

    //#region bottom terminal panel

    /**
     * The panel's own terminal tabs, fully independent of the sidebar
     * inventory: the panel owns seat lifecycle itself, so terminals opened
     * here never appear in the right sidebar (and vice versa).
     *
     * A seat is `{key, terminalId?, shellPath?, contentId}`; the seat key is
     * unique per panel tab and unrelated to any sidebar tab id. The terminal
     * process is owned by the Host (`ctx.webTerminals`); closing a seat calls
     * `view.close()` + `view.dispose()` directly, with no sidebar involvement.
     */
    const panelSeats = {
      items: [],
      nextKey: 0,
      listeners: new Set(),
      emit() {
        for (const listener of this.listeners) listener();
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      getSnapshot() {
        // The snapshot must be a STABLE array reference between mutations:
        // React bails out of re-rendering when `useSyncExternalStore`'s
        // getSnapshot returns an identical value, and re-creating it on every
        // call made every unrelated panel render (height, open) rebuild the
        // seat list and unmount/remount the active terminal — losing its
        // scrollback and, worse, resurrecting a terminal whose Host process
        // had closed.
        return this.items;
      },
      add(seat) {
        this.items = [...this.items, seat];
        this.emit();
      },
      remove(key) {
        this.items = this.items.filter((seat) => seat.key !== key);
        this.emit();
      },
    };

    /** The panel's own seats, reactive (omit when the panel is closed). */
    function usePanelSeats() {
      return React.useSyncExternalStore(
        (listener) => panelSeats.subscribe(listener),
        () => panelSeats.getSnapshot(),
      );
    }
    const panelStore = {
      open: false,
      active: undefined,
      height: 300,
      listeners: new Set(),
      restore() {
        try {
          const raw = window.localStorage.getItem(DOCK_STORE_KEY);
          if (typeof raw === "string" && raw !== "") {
            const saved = JSON.parse(raw);
            if (typeof saved?.open === "boolean") this.open = saved.open;
            if (typeof saved?.height === "number" && Number.isFinite(saved.height)) this.height = saved.height;
          }
        } catch {
          // Private-browsing or corrupt state: keep the defaults.
        }
      },
      persist() {
        try {
          window.localStorage.setItem(DOCK_STORE_KEY, JSON.stringify({ open: this.open, height: this.height }));
        } catch {
          // Storage unavailable: the choice lives for this page only.
        }
      },
      setOpen(open) {
        if (this.open === open) return;
        this.open = open;
        this.persist();
        this.emit();
      },
      setActive(active) {
        if (this.active === active) return;
        this.active = active;
        this.emit();
      },
      setHeight(height) {
        const clamped = Math.max(160, Math.min(Math.round(window.innerHeight * 0.7), Math.round(height)));
        if (this.height === clamped) return;
        this.height = clamped;
        this.persist();
        this.emit();
      },
      emit() {
        for (const listener of this.listeners) listener();
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    };
    if (typeof window !== "undefined") panelStore.restore();

    /** Stable subscription binding for React external stores. */
    const subscribeDock = (listener) => panelStore.subscribe(listener);

    /** Reactive `panelStore.open`. */
    function usePanelOpen() {
      return React.useSyncExternalStore(subscribeDock, () => panelStore.open);
    }

    /** Reactive `panelStore.height` (px). */
    function usePanelHeight() {
      return React.useSyncExternalStore(subscribeDock, () => panelStore.height);
    }

    /** Reactive `panelStore.active` (seat key | undefined). */
    function usePanelActive() {
      return React.useSyncExternalStore(subscribeDock, () => panelStore.active);
    }

    /**
     * One panel seat: the built-in `TerminalBody` mounted on the panel's own
     * inject bindings — no sidebar occurrence, so the seat is entirely the
     * panel's business. Only the active seat renders (unmounting an inactive
     * one is safe: the view survives and re-attachment starts from a complete
     * bounded screen).
     */
    function PanelSeat({ ctx, sessionId, seat, t, themeHook, tTerm, helpersFor }) {
      const [attempt, setAttempt] = React.useState(1);
      const body = useTerminalChunk(attempt);
      const helpers = helpersFor(sessionId);
      // Mount the terminal view: `TerminalView.mount()` is idempotent and the
      // view survives unmount, so mounting the seat also allocates the process
      // (first allocation) or re-attaches to the running one (switches).
      React.useEffect(() => {
        const model = helpers.view(seat.key);
        let detach = undefined;
        try {
          detach = model.mount();
        } catch {
          // Already mounted (or already closed): the view's own state tells.
        }
        return () => {
          if (typeof detach === "function") detach();
        };
      }, [helpers, seat.key]);
      const fabricated = {
        id: seat.key,
        kind: "terminal",
        visible: true,
        actions: {
          bindCommands: () => () => {},
          openResource: () => {},
          openTab: () => {},
          close: () => {},
        },
      };
      if (body === null || body === undefined) {
        return jsx("div", {
          className: "dse-dockPh",
          children: [
            body === null ? t("dock.failed") : t("dock.loading"),
            body === null && jsx("button", {
              type: "button",
              className: "dse-tbarBtn",
              title: t("menu.refresh"),
              "aria-label": t("menu.refresh"),
              onClick: () => setAttempt((value) => value + 1),
              children: jsx(P.IconRefreshOutlineRegular, {}),
            }),
          ],
        });
      }
      return jsx(BoundTerminalBody, {
        Body: body.Body,
        helpers,
        useTheme: themeHook,
        tTerm,
        tab: fabricated,
      });
    }

    /**
     * The panel body (composer-dock entry): a multi-tab terminal column owned
     * entirely by the panel. "+" allocates a new seat (the panel synthesizes a
     * unique content identity; the controller creates the Host terminal),
     * "×" closes the seat's process, tabs switch seats, and the drag grip
     * resizes the whole panel. No sidebar tab is ever touched.
     */
    function makeBottomTerminalPanel(ctx, themeHook, tTerm) {
      const helpersCache = new Map();
      const helpersOf = (sessionId) => {
        let helpers = helpersCache.get(sessionId);
        if (helpers === undefined) {
          helpers = makePanelHelpers(ctx, sessionId);
          helpersCache.set(sessionId, helpers);
        }
        return helpers;
      };

      function BottomTerminalPanel({ sessionId, t }) {
        const open = usePanelOpen();
        const height = usePanelHeight();
        const active = usePanelActive();
        const seats = usePanelSeats();
        const helpers = helpersOf(sessionId);
        const activeKey = seats.some((seat) => seat.key === active)
          ? active
          : seats.length > 0 ? seats[seats.length - 1].key : undefined;
        // Reconcile immediately: an effect would defer the switch until after
        // this render, so the click's result appears on the very next paint.
        if (activeKey !== undefined && activeKey !== panelStore.active) panelStore.setActive(activeKey);
        const activeSeat = seats.find((seat) => seat.key === activeKey);
        // Two distinct fixes:
        // 1) The effect fires on EVERY session change (the store is module
        //    level), so a second session's auto-seed previously raced the
        //    first session's click. Seed at most once per session.
        // 2) addPanelSeat sets the active key synchronously — the click's
        //    result must survive, so the seed never overrides it.
        const seeded = React.useRef(new Set());
        React.useEffect(() => {
          if (!open) return undefined;
          if (seeded.current.has(sessionId)) return undefined;
          if (panelSeats.items.length > 0) {
            seeded.current.add(sessionId);
            return undefined;
          }
          seeded.current.add(sessionId);
          addPanelSeat(sessionId, helpers);
          return undefined;
        }, [open, sessionId, helpers]);

        // Switching a tab keeps exactly one seat mounted, so the views of the
        // hidden seats must stay alive for when they come back: `mount()` was
        // already called, the process is running, and `connect()` re-attaches.
        // Close is the only path that ends a process.
        const onNew = React.useCallback(() => {
          addPanelSeat(sessionId, helpers);
        }, [sessionId, helpers]);
        const onSwitchTab = React.useCallback((key) => {
          panelStore.setActive(key);
        }, []);
        const onCloseTab = React.useCallback((key) => {
          helpers.close(key);
        }, [helpers]);
        const onHide = React.useCallback(() => {
          panelStore.setOpen(false);
        }, []);
        const onGripPointerDown = React.useCallback((event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const grip = event.currentTarget;
          grip.setPointerCapture(event.pointerId);
          const startY = event.clientY;
          const startHeight = panelStore.height;
          const onMove = (moveEvent) => {
            panelStore.setHeight(startHeight + (startY - moveEvent.clientY));
          };
          const onUp = () => {
            grip.removeEventListener("pointermove", onMove);
            grip.removeEventListener("pointerup", onUp);
            grip.removeEventListener("pointercancel", onUp);
          };
          grip.addEventListener("pointermove", onMove);
          grip.addEventListener("pointerup", onUp);
          grip.addEventListener("pointercancel", onUp);
        }, []);
        if (!open) return null;
        return jsxs("div", {
          className: "dse-dock",
          style: { height },
          "data-dse-panel": "terminal",
          children: [
            jsx("div", { className: "dse-dockGrip", onPointerDown: onGripPointerDown }),
            jsxs("div", {
              className: "dse-panelBar",
              children: [
                jsxs("div", {
                  className: "dse-panelTabs",
                  role: "tablist",
                  children: [
                    seats.length > 0 && seats.map((seat) => jsxs("div", {
                      key: seat.key,
                      className: "dse-panelTabWrap",
                      "data-active": seat.key === activeKey,
                      children: [
                        jsx("button", {
                          type: "button",
                          className: "dse-panelTab",
                          title: seat.title ?? seat.key,
                          onClick: () => onSwitchTab(seat.key),
                          children: jsx("span", { className: "dse-panelTabLabel", children: seat.title ?? t("panel.tab") }),
                        }),
                        jsx("button", {
                          type: "button",
                          className: "dse-panelTabClose",
                          title: t("menu.delete"),
                          "aria-label": t("menu.delete"),
                          onClick: () => onCloseTab(seat.key),
                          children: jsx(P.IconCloseOutlineRegular, {}),
                        }),
                      ],
                    })),
                    seats.length === 0 && jsx("span", { className: "dse-panelEmpty", children: t("panel.empty") }),
                  ],
                }),
                jsxs("div", {
                  className: "dse-panelActions",
                  children: [
                    jsx("button", { className: "dse-tbarBtn", type: "button", title: t("tool.newTerminal"), "aria-label": t("tool.newTerminal"), onClick: onNew, children: jsx(P.IconPlusOutlineRegular, {}) }),
                    jsx("button", { className: "dse-tbarBtn", type: "button", title: t("panel.hide"), "aria-label": t("panel.hide"), onClick: onHide, children: jsx(IconChevronDownSolid, {}) }),
                  ],
                }),
              ],
            }),
            jsx("div", {
              className: "dse-dockBody",
              style: { minHeight: 0 },
              children: activeSeat === undefined ? jsx("div", { className: "dse-dockPh", children: t("panel.empty") }) : jsx(PanelSeat, {
                key: activeSeat.key,
                ctx,
                sessionId,
                seat: activeSeat,
                t,
                themeHook,
                tTerm,
                helpersFor: helpersOf,
              }),
            }),
          ],
        });
      }

      return BottomTerminalPanel;
    }

    /** Allocate one fresh panel seat (unique content identity, new terminal). */
    function addPanelSeat(sessionId, helpers) {
      const key = "panel-" + panelSeats.nextKey;
      panelSeats.nextKey += 1;
      // Mint the content identity eagerly: `webTerminals.view()` caches
      // bindings per (session, contentId), so a seat reusing an identity that
      // already pointed at a closed Host terminal would restore the dead id
      // with createWhenMissing=false (the "此终端已不存在" state). A fresh
      // UUID per seat creation makes every seat allocate a real terminal.
      const seat = {
        key,
        contentId: mintSeatContentId(sessionId, key),
        shellPath: undefined,
        terminalId: undefined,
      };
      panelSeats.add(seat);
      panelStore.setActive(key);
      // Force the model's refresh chain now so the terminal allocates even
      // before its seat mounts (the view survives until explicit close).
      try {
        helpers.view(key).refresh();
      } catch {
        // The seat mounts momentarily and starts the allocation itself.
      }
      return seat;
    }

    /**
     * A content identity the controller has never seen: unique per seat, per
     * creation, and stable afterwards (cached on the seat object).
     */
    function mintSeatContentId(sessionId, key) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      let hex = "";
      for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      return `dse-panel:${sessionId}:${key}:${uuid}`;
    }

    /**
     * The session header button: shows or hides the bottom terminal panel.
     * A filled look marks the panel as open (the toggle feels like a tab).
     */
    function makeHeaderTerminalButton(ctx, t) {
      return function HeaderTerminalButton() {
        const open = usePanelOpen();
        const onClick = React.useCallback(() => {
          panelStore.setOpen(!panelStore.open);
        }, []);
        return jsx("button", {
          type: "button",
          className: "dse-tool",
          "data-open": open,
          title: t(open ? "panel.hide" : "tool.terminal"),
          "aria-label": t(open ? "panel.hide" : "tool.terminal"),
          "aria-pressed": open,
          onClick,
          children: jsx(TerminalGlyph, {}),
        });
      };
    }

    //#endregion

    /** Required client services: slots, locale, the workspace-files Remote, the document preview registry, plus the terminal dock's services. */
    const inject = ["slots", "locale", "remote", "remote.workspaceFiles", "documentPreviews", "sidebarRight", "webTerminals", "theme"];

    /**
     * Client plugin body: inject the stylesheet and dictionaries, shadow the
     * built-in files tree, register the editable renderer, and add the bottom
     * terminal panel with its header toggle button.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);

      ctx.effect(() => injectStyle(), "sidebar-enhancement: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "sidebar-enhancement: dictionaries");

      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => {
        const filesTab = {
          name: "sidebar.right.pane.tab",
          key: FILES_ID,
          priority: -1,
          locale: NS,
          inject: (sessionId) => ({ makeFace: (id) => makeFace(ctx, id ?? sessionId) }),
          children: { "sidebar.right.tab.files.actions": { kind: "list", scope: "session" } },
        };
        try {
          return ctx.slots.register(filesTab, FilesEnhancedBody);
        } catch (error) {
          // A child slot allows exactly one declarant, and the built-in files
          // tab declares `sidebar.right.tab.files.actions` before this shadow
          // entry loads. register() rejects before mutating, so fall back to
          // the same registration without re-claiming the shared declaration
          // (the body still renders it by name). Anything else rethrows.
          const message = String(error?.message ?? error);
          if (!message.includes('"sidebar.right.tab.files.actions" is already declared')) throw error;
          const { children, ...filesTabWithoutChildren } = filesTab;
          return ctx.slots.register(filesTabWithoutChildren, FilesEnhancedBody);
        }
      }), "sidebar-enhancement: files tree body");

      const previews = ctx.documentPreviews;
      if (previews !== undefined) {
        ctx.effect(() => previews.register({
          id: EDITOR_ID,
          extensions: EDITOR_EXTENSIONS,
          priority: "extension",
          title: () => t("viewer.editor"),
          loading: "renderer",
          wrap: true,
        }), "sidebar-enhancement: editable document preview");
        ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({
          name: "sidebar.right.tab.document",
          key: EDITOR_ID,
          locale: NS,
          inject: (sessionId) => ({ makeFace: (id) => makeFace(ctx, id ?? sessionId) }),
        }, EditorBody)), "sidebar-enhancement: editable document body");
      }

      // Bottom terminal panel: only when every collaborating service is present.
      const terminalReady = ctx.sidebarRight !== undefined && ctx.webTerminals !== undefined && ctx.theme !== undefined;
      if (terminalReady) {
        // Bind the runtime the terminal components resolve lazily. The theme
        // hook and the built-in terminal translator mirror the built-in body's
        // own registration (theme/change + 'sidebarTerminal' namespace).
        terminalRuntime.useTheme = selectorHookFor(themeSourceFor(ctx));
        terminalRuntime.tTerm = ctx.locale.bind("sidebarTerminal");

        // The bottom terminal panel: an independent multi-tab terminal column
        // below the composer, declared by the built-in conversation package;
        // slots.inject waits for that declaration before registering.
        const themeHook = terminalRuntime.useTheme;
        ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
          name: "conversation.composer.dock",
          id: DOCK_ID,
          locale: NS,
        }, makeBottomTerminalPanel(ctx, themeHook, terminalRuntime.tTerm))), "sidebar-enhancement: bottom terminal panel");

        // The session header button that shows/hides the panel.
        ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: PANEL_BUTTON_ID,
          locale: NS,
        }, makeHeaderTerminalButton(ctx, t))), "sidebar-enhancement: terminal panel button");
      }
    }

    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
