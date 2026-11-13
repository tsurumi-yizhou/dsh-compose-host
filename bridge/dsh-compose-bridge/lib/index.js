// compose extension host: device-authenticated native views, actions, inventory and files.
// The browser reports slot occupancy through Connection's owner-only Fetch registry;
// Android's editor reaches that registry through the compose application protocol.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATUS_CODES } from "node:http";
import { createPluginConfig, pluginConfigUnavailable } from "./plugin-config.js";
import { createSessionDeletion, sessionDeletionUnavailable } from "./session-deletion.js";
import { createMediaWorks } from "./media-works.mjs";
import { NativeCore } from "./native/core.js";
import { effectiveLimits } from "./native/limits.js";
import { STREAM_PATH, createNativeRoutes } from "./native/routes.js";

export const name = "dsh-compose-bridge";

const PREFIX = "/compose/extensions";
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** App↔Engine bridge contract version. Bump only for breaking wire changes; the app negotiates by intersection. */
export const CONTRACT = 1;
/** Capabilities this bridge exposes; the app intersects these with what it supports and degrades gracefully. */
export const CAPABILITIES = Object.freeze([
  "native-protocol-v1",
  "plugin-config",
  "session-deletion",
  "media-works",
  "route-guard",
  "inventory",
  "occupancy",
]);

/**
 * Intersect the app's supported capabilities with this bridge's. The app should disable any
 * feature whose capability is absent so an older/newer engine degrades gracefully instead of failing.
 * @param {unknown} appCapabilities
 * @returns {string[]}
 */
export function negotiate(appCapabilities) {
  const have = new Set(CAPABILITIES);
  const wanted = Array.isArray(appCapabilities) ? appCapabilities : [];
  return wanted.filter((cap) => typeof cap === "string" && have.has(cap));
}
const ORIGINAL = Symbol.for("cordis.original");
const MAX_BODY = 512 * 1024;
const MAX_SLOTS = 400;
const MAX_OCCUPANTS = 200;
const SLOT_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isOfficial = (pkg) => typeof pkg === "string" && pkg.startsWith("@deepseek-ai/");
const str = (v, max) => (typeof v === "string" && v.length <= max ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const int = (v) => Math.round(num(v));

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`; paths and `cordis:` rows -> undefined. */
function packageOf(specifier) {
  if (typeof specifier !== "string" || specifier === "" || /^(\.|\/|file:|cordis:|[A-Za-z]:)/.test(specifier)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
}

function cachePath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(home, "cache", "dsh-compose-bridge", "occupancy.json");
}

/** A right pane tab type (`sidebar.right.pane.tab(.title)` occupants): what it is called, how it opens. */
function sanitizeTab(t) {
  if (!isObject(t)) return undefined;
  const id = str(t.id, 214);
  const kind = str(t.kind, 214);
  if (id === undefined || kind === undefined) return undefined;
  const guide = (Array.isArray(t.guide) ? t.guide.slice(0, 20) : []).filter(isObject).map((g) => {
    const entry = { id: str(g.id, 214) ?? "", order: int(g.order) };
    const title = str(g.title, 256);
    if (title !== undefined) entry.title = title;
    return entry;
  }).filter((g) => g.id !== "");
  const out = { id, kind, guide };
  const title = str(t.title, 256);
  if (title !== undefined) out.title = title;
  if (t.multiple === true) out.multiple = true;
  return out;
}

/** One occupant in wire format; entries the page could not attribute to a package are dropped. */
function sanitizeOccupant(o) {
  if (!isObject(o)) return undefined;
  const pkg = str(o.package, 214);
  if (pkg === undefined || pkg === "" || pkg === name) return undefined;
  const out = {
    package: pkg,
    cell: str(o.cell, 256) ?? "",
    order: int(o.order),
    official: isOfficial(pkg),
    priority: int(o.priority),
    active: o.active === true,
  };
  const label = str(o.label, 256);
  if (label !== undefined) out.label = label;
  const registrant = str(o.registrant, 214);
  if (registrant !== undefined) out.registrant = registrant;
  const tab = sanitizeTab(o.tab);
  if (tab !== undefined) out.tab = tab;
  return out;
}

/** Validated occupancy report, or a status code. */
function parseReport(body) {
  if (!isObject(body) || !isObject(body.slots)) return 400;
  const bootRev = str(body.bootRev, 128);
  if (bootRev === undefined) return 400;
  const keys = Object.keys(body.slots);
  if (keys.length > MAX_SLOTS) return 413;
  const slots = {};
  for (const key of keys) {
    const list = body.slots[key];
    if (!SLOT_KEY.test(key) || !Array.isArray(list) || list.length > MAX_OCCUPANTS) return 400;
    const occupants = list.map(sanitizeOccupant).filter((o) => o !== undefined);
    if (occupants.length > 0) slots[key] = occupants;
  }
  const report = { bootRev, reportedAt: Date.now(), slots };
  const attribution = str(body.attribution, 16);
  if (attribution !== undefined) report.attribution = attribution;
  if (typeof body.unresolved === "number") report.unresolved = int(body.unresolved);
  return report;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) over = true;
      else if (!over) chunks.push(chunk);
    });
    req.on("end", () => (over ? reject(Object.assign(new Error("body too large"), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = typeof body === "string" ? `${body}\n` : JSON.stringify(body);
  headers["content-type"] = typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
  res.writeHead(status, headers);
  res.end(text);
}

/** Device authentication is shared with the compose request and event routes. */
function rejectionOf(ctx, req) {
  const protocol = ctx.get("composeProtocol");
  return protocol === undefined ? 503 : protocol.reject(req);
}

function packageList(ctx, graph) {
  const packages = new Map();
  for (const entry of graph?.entries ?? []) {
    if (typeof entry?.id === "string") packages.set(entry.id, { name: entry.id, hasClient: true, rev: entry.rev ?? null, official: isOfficial(entry.id) });
  }
  try {
    for (const entry of ctx.get("loader")?.entries() ?? []) {
      if (entry.disabled || entry.fiber === undefined) continue;
      const pkg = packageOf(entry.options?.name);
      if (pkg !== undefined && !packages.has(pkg)) packages.set(pkg, { name: pkg, hasClient: false, rev: null, official: isOfficial(pkg) });
    }
  } catch (error) {
    ctx.logger?.warn?.(error);
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function apply(ctx, config) {
  const options = isObject(config) ? config : {};
  const persist = options.persist !== false;
  let occupancy;
  if (persist) {
    try {
      const stored = JSON.parse(readFileSync(cachePath(), "utf8"));
      const saved = parseReport(stored);
      if (typeof saved === "object") occupancy = { ...saved, reportedAt: num(stored.reportedAt) };
    } catch {}
  }
  const save = (value) => {
    if (!persist) return;
    try {
      const path = cachePath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(value));
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      ctx.logger?.warn?.(error);
    }
  };

  // Native plugin protocol: the service exists whenever the bridge runs (no cost without plugins).
  const native = new NativeCore(ctx, effectiveLimits(options.native), VERSION);
  ctx.effect(() => () => native.dispose(), "dsh-compose-bridge: native core");
  ctx.provide("dshCompose", native.service);
  ctx.on("internal/plugin", () => native.markDirty());
  let pluginConfig;
  ctx.on("internal/status", (fiber) => { native.markDirty(); pluginConfig?.statusChanged(fiber); });

  ctx.inject(["webServer", "composeProtocol", "connection"], (webCtx) => {
    const inventory = async () => {
      let graph;
      try {
        graph = webCtx.get("clientModules")?.graph();
      } catch (error) {
        webCtx.logger?.warn?.(error);
      }
      const currentRev = typeof graph?.rev === "string" ? graph.rev : null;
      return {
        v: 1,
        bridge: VERSION,
        contract: CONTRACT,
        capabilities: CAPABILITIES,
        release: isObject(graph?.release) ? graph.release : null,
        // bootRev names the boot graph the occupancy table was taken from; currentRev is the
        // graph a page loaded now would boot (they differ after a plugin change).
        ...(occupancy === undefined ? {} : { bootRev: occupancy.bootRev }),
        currentRev,
        packages: packageList(webCtx, graph),
        slots: occupancy === undefined ? null : occupancy.slots,
        occupancy: occupancy === undefined ? null : {
          reportedAt: occupancy.reportedAt,
          stale: occupancy.bootRev !== currentRev,
          ...(occupancy.attribution === undefined ? {} : { attribution: occupancy.attribution }),
          ...(occupancy.unresolved === undefined ? {} : { unresolved: occupancy.unresolved }),
        },
        routeGuard: true,
        routeGuardMode: "device",
      };
    };

    const acceptReport = (report) => {
      if (typeof report === "number") return report;
      const worse = occupancy !== undefined && occupancy.bootRev === report.bootRev
        && (report.unresolved ?? 0) > (occupancy.unresolved ?? 0);
      if (!worse) { occupancy = report; save(report); }
      return 204;
    };
    webCtx.connection.registerFetchRoute(webCtx, {
      path: "/api/compose/occupancy",
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const headers = { "cache-control": "no-store" };
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
          return new Response(null, { status: 415, headers });
        const parts = [];
        let size = 0;
        try {
          if (request.body) for await (const part of request.body) {
            size += part.length;
            if (size > MAX_BODY) return new Response(null, { status: 413, headers });
            parts.push(part);
          }
          const status = acceptReport(parseReport(JSON.parse(Buffer.concat(parts).toString("utf8"))));
          return new Response(null, { status, headers });
        } catch { return new Response(null, { status: 400, headers }); }
      },
    });

    const nativeRoutes = createNativeRoutes(native);
    pluginConfig = createPluginConfig(webCtx, { readBody, send });
    const sessionDeletion = createSessionDeletion(webCtx, { readBody, send });
    const mediaWorks = createMediaWorks({ readBody, send });
    webCtx.effect(() => () => nativeRoutes.dispose(), "dsh-compose-bridge: native routes");
    webCtx.effect(() => webCtx.webServer.registerUpgrade({
      path: STREAM_PATH,
      handler: (req, socket, head) => {
        const rejection = rejectionOf(webCtx, req);
        if (rejection !== undefined) {
          socket.end(`HTTP/1.1 ${rejection} ${STATUS_CODES[rejection]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
          return;
        }
        webCtx.composeProtocol.trackUpgrade(req, socket);
        nativeRoutes.upgrade(req, socket, head);
      },
    }), "dsh-compose-bridge: native stream");

    const handler = async (req, res) => {
      const rejection = rejectionOf(webCtx, req);
      if (rejection !== undefined) return send(res, rejection, rejection === 503 && (sessionDeletionUnavailable(req) || pluginConfigUnavailable(req)) || STATUS_CODES[rejection]);
      webCtx.composeProtocol.track(req, res);
      const url = new URL(req.url ?? "/", "http://dsh-compose.invalid");
      const path = url.pathname;
      if (await sessionDeletion.handle(req, res, path)) return;
      if (await mediaWorks.handle(req, res, path, url)) return;
      if (await pluginConfig.handle(req, res, path)) return;
      if (path.startsWith(`${PREFIX}/v1/`) && await nativeRoutes.handle(req, res, path, url)) return;
      if (path === `${PREFIX}/v1/capabilities`) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
        return send(res, 200, { contract: CONTRACT, bridge: VERSION, capabilities: CAPABILITIES });
      }
      if (path === `${PREFIX}/v1/inventory`) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
        return send(res, 200, await inventory());
      }
      if (path === `${PREFIX}/v1/occupancy`) {
        if (req.method !== "POST") return send(res, 405, "method not allowed");
        if (String(req.headers["content-type"]).split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          req.resume();
          return send(res, 415, "content-type must be application/json");
        }
        let report;
        try {
          report = parseReport(JSON.parse((await readBody(req, MAX_BODY)).toString("utf8")));
        } catch (error) {
          return send(res, error?.status ?? 400, error?.status === 413 ? "body too large" : "body is not JSON");
        }
        return send(res, acceptReport(report));
      }
      return send(res, 404, "not found");
    };

    webCtx.effect(() => webCtx.webServer.register({ kind: "prefix", path: PREFIX, handler }), "dsh-compose-bridge: compose extension routes");
  });
}
