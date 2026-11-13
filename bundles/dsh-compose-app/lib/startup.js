// Derived from @deepseek-ai/dsh-web-app 0.2.2-rc.1 (MIT; see LICENSE).
import { parsePublicUrl } from "./public-url.js";
import { isWildcardHost } from "@deepseek-ai/dsh-host-webserver";
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
//#region lib/types/startup.js
/**
* The web app's command-line provider: it parses the `dsh --profile compose` flag
* family (`--host`, `--port`, `--public-url`, `--trusted-host`, `--no-open`, TLS)
* and its `--help` text, then provides the immutable values as
* {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that service before
* reading it from lazy config.
* @module dsh-compose-app/startup
*/
/** Stable Cordis plugin name. */
const name = "compose-startup";
/** Services required before the flags can be resolved. */
const inject = ["cmdlineArgs"];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
const WEB_STARTUP_SERVICE = "webStartup";
/**
* This app's command: its flags, its description, and its help text.
* @returns a fresh program, so one process can parse more than once (tests).
*/
function webCommand() {
	return new Command().name("dsh --profile compose").description("Serve the DeepSeek Harness native-client API.").helpOption("-h, --help", "show this help").option("--host <host>", "bind address: one concrete IPv4 or IPv6 literal of a local interface; wildcard addresses are rejected").option("--no-open", "ignored; Compose never opens a browser").option("--port <port>", "listen port; pass 0 to let the OS pick a free one").option("--public-url <url>", "advertise this HTTP(S) root in the printed, runtime-context, and DSH_WEB_URL forms; grants no trust").option("--trusted-host <authority...>", "extra authority the /api browser-trust fence accepts (host or host:port; repeatable)").option("--tls-cert <file>", "PEM server certificate chain; requires --tls-key").option("--tls-key <file>", "unencrypted PEM private key; requires --tls-cert").addHelpText("after", `
Examples:
  dsh --profile compose                          serve on the composed host and port
  dsh --profile compose --no-open                accepted but ignored; no browser is opened
  dsh --profile compose --port 8080              serve on another port
  dsh --profile compose --host 10.0.0.7          bind one local interface address
  dsh --profile compose --public-url https://app.example/ui/ --trusted-host app.example
                                             advertise a prefix-stripping HTTPS proxy entry and admit its authority
  dsh --profile compose --tls-cert ./server-chain.pem --tls-key ./server-key.pem
                                             serve HTTPS with an existing certificate and key
`);
}
/**
* Parse and provide the Web invocation as an ordinary Cordis service. The
* command's action publishes the flags this invocation named. Invalid flags,
* including an unpaired TLS certificate or key, are usage errors; rejection
* and `--help` provide no service.
* @param ctx - plugin context carrying the command line.
*/
function apply(ctx) {
	const program = webCommand();
	program.action(() => {
		const options = program.opts();
		if (options.host !== void 0 && isWildcardHost(options.host)) program.error(`error: --host ${options.host} is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address instead`);
		if (options.port !== void 0 && !/^\d+$/.test(options.port)) program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
		let tls;
		if (options.tlsCert !== void 0 && options.tlsKey !== void 0) tls = {
			certFile: options.tlsCert,
			keyFile: options.tlsKey
		};
		else if (options.tlsCert !== void 0 || options.tlsKey !== void 0) program.error("error: --tls-cert and --tls-key must be supplied together");
		if (options.publicUrl !== void 0) try {
			parsePublicUrl(options.publicUrl, "--public-url");
		} catch (error) {
			program.error(`error: ${error.message}`);
		}
		ctx.provide(WEB_STARTUP_SERVICE, {
			openBrowser: options.open,
			...options.host !== void 0 && { host: options.host },
			...options.port !== void 0 && { port: Number(options.port) },
			...options.publicUrl !== void 0 && { publicUrl: options.publicUrl },
			...tls !== void 0 && { tls },
			trustedHosts: options.trustedHost ?? []
		});
	});
	parseCmdline(ctx, program);
}
//#endregion
export { WEB_STARTUP_SERVICE, apply, inject, name };
