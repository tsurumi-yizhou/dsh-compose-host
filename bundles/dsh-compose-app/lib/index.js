// Derived from @deepseek-ai/dsh-web-app and dsh-host-frontend-static
// 0.2.2-rc.1 (MIT; see LICENSE). Native-client shell, without browser UI.
import z from "@deepseek-ai/schemastery";
import { auditStartupEntries } from "@deepseek-ai/dsh-app-boot";
import { parsePublicUrl } from "./public-url.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createInvitation, refreshInvitation, formatInvitation } from "./protocol/devices.mjs";

export const name = "compose-app";
export const inject = ["webServer", "connection"];
export const Config = z.object({
  printPairingCode: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  publicUrl: z.transform(z.string(), (value) => parsePublicUrl(value).href),
});

const SHELL = '<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Harness</title></head><body><p>Connect using the native Android app.</p></body></html>';
const ANNOUNCED_ROOTS = new WeakSet();

export function apply(ctx, config) {
  const appRootUrl = () => config.publicUrl ?? ctx.webServer.getOrigin();
  ctx.provide("webApp", { getAdvertisedUrl: appRootUrl });

  // Same response adapter as frontend-static: Connection owns refusals.
  const authorizeIndex = (request) => {
    let status = 401;
    let headers = new Headers();
    let body;
    return ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = new Headers(nextHeaders);
      },
      end(text) {
        body = text;
      },
    }) ? undefined : new Response(body, { status, headers });
  };
  ctx.effect(() => ctx.webServer.registerFallback({
    resource: async (request, peer) => {
      if (new URL(request.url).pathname !== "/") return new Response(null, { status: 404 });
      if (peer === undefined) {
        const refusal = authorizeIndex(request);
        if (refusal !== undefined) return refusal;
      }
      const html = ctx.webServer.renderIndex(SHELL, peer ?? ctx.connection.browserPeer);
      return new Response(request.method === "HEAD" ? null : html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  }), "compose-app: fallback seat");

  if (config.surfaceContext) ctx.inject(["shellEnv"], (runtimeCtx) => {
    runtimeCtx.shellEnv.register({
      name: "web-runtime",
      variables: { DSH_WEB_URL: { description: "Advertised URL of the DeepSeek Harness serving this session." } },
      resolve: () => ({ DSH_WEB_URL: appRootUrl() }),
    });
  });
  if (config.printPairingCode) ctx.inject(["connection", "composeProtocol"], (connectionCtx) => {
    const announceReady = () => {
      if (ANNOUNCED_ROOTS.has(connectionCtx.root)) return;
      const directory = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles/compose/.state/transport');
      const code = createInvitation(directory);
      if (process.env.DSH_COMPOSE_READY_FILE) {
        const token = new URL(connectionCtx.connection.authenticatedUrl(appRootUrl())).searchParams.get('token');
        writeFileSync(process.env.DSH_COMPOSE_READY_FILE, JSON.stringify({ token }), { mode: 0o600, flag: 'wx' });
      }
      ANNOUNCED_ROOTS.add(connectionCtx.root);
      const printCode = value => console.log(`Pairing code (one use, expires in 5 minutes): ${formatInvitation(value)}`);
      printCode(code);
      connectionCtx.effect(() => {
        const timer = setInterval(() => {
          try {
            const next = refreshInvitation(directory);
            if (next !== undefined) printCode(next);
          } catch (error) { console.error('Could not refresh pairing code:', error.message); }
        }, 1000);
        timer.unref();
        return () => { clearInterval(timer); ANNOUNCED_ROOTS.delete(connectionCtx.root); };
      }, "compose-app: pairing code renewal");
    };
    const settled = connectionCtx.get("loader")?.await();
    if (settled === undefined) announceReady();
    else settled.then(async () => {
      await auditStartupEntries(connectionCtx.root, "dsh compose", () => {});
      if (connectionCtx.get("webServer") !== undefined && connectionCtx.get("connection") !== undefined) announceReady();
    }).catch(() => {});
  });
}
