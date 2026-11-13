#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const command = args.shift();
let home = process.env.DSH_HOME || join(homedir(), '.dsh');
let packageDirectory = dirname(fileURLToPath(import.meta.url));
const engineArgs = [];
while (args.length) {
  const flag = args.shift();
  if (flag === '--') { engineArgs.push(...args); break; }
  if (!['--home', '--package'].includes(flag) || !args.length) {
    throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  const value = args.shift();
  if (flag === '--home') home = resolve(value);
  else packageDirectory = resolve(value);
}
home = resolve(home);
const app = join(home, 'dsh-app');
const unit = 'dsh-compose.service';
const unitDirectory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
const unitPath = join(unitDirectory, unit);
const control = join(app, 'pkg/compose.mjs');

function execute(program, argv, options = {}) {
  const result = spawnSync(program, argv, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? result.signal})`);
}
function active() {
  checkServiceHome();
  return spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore' }).status === 0;
}
function checkServiceHome() {
  if (existsSync(unitPath) && !readFileSync(unitPath, 'utf8').startsWith(`# DSH_HOME=${JSON.stringify(home)}\n`)) {
    throw new Error('The registered compose service belongs to another deployment home');
  }
}
function install() {
  for (const name of ['install.sh', 'overrides', 'install-skills.mjs', 'skills', 'version.json', 'compose.mjs']) {
    if (!existsSync(join(packageDirectory, name))) {
      throw new Error(`Missing ${name}: --package must point to an extracted host.tgz package`);
    }
  }
  const target = join(app, 'pkg');
  mkdirSync(app, { recursive: true, mode: 0o700 });
  if (resolve(packageDirectory) !== resolve(target)) {
    const stage = mkdtempSync(join(app, 'package-stage-'));
    const previous = join(app, 'package-previous');
    try {
      cpSync(packageDirectory, stage, { recursive: true });
      if (existsSync(previous)) throw new Error('An earlier package replacement needs attention: ' + previous);
      if (existsSync(target)) renameSync(target, previous);
      try { renameSync(stage, target); }
      catch (error) {
        if (existsSync(previous)) renameSync(previous, target);
        throw error;
      }
      rmSync(previous, { recursive: true, force: true });
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  execute('sh', [join(target, 'install.sh')], {
    env: { ...process.env, DSH_HOME: home, COMPOSE_APP_DIR: app },
  });
}
function installUnit() {
  if (!existsSync(control)) throw new Error('Install the compose package first');
  checkServiceHome();
  // systemd has its own quoting and percent specifiers; shell quoting is not applicable.
  const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
  const exec = [process.execPath, control, 'run', '--home', home, '--', ...engineArgs].map(quote).join(' ');
  mkdirSync(unitDirectory, { recursive: true });
  writeFileSync(unitPath, `# DSH_HOME=${JSON.stringify(home)}\n[Unit]\nDescription=DSH compose profile\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=on-failure\nRestartSec=3\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
  execute('systemctl', ['--user', 'daemon-reload']);
}
function run() {
  const launcher = join(app, 'bin/dsh');
  if (!existsSync(launcher)) throw new Error('Install the compose package first');
  const child = spawn(launcher, ['--profile', 'compose', '--no-open', ...engineArgs], {
    env: { ...process.env, DSH_HOME: home }, stdio: ['inherit', 'pipe', 'pipe'],
  });
  const redact = line => line.replace(/([?&](?:token|key)=)[^\s&#]+/gi, '$1[redacted]');
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input: stream }).on('line', line => output.write(redact(line) + '\n'));
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1); });
}
try {
  switch (command) {
    case 'install': install(); break;
    case 'update': {
      const wasActive = active();
      if (wasActive) execute('systemctl', ['--user', 'stop', unit]);
      try { install(); }
      finally { if (wasActive) execute('systemctl', ['--user', 'start', unit]); }
      break;
    }
    case 'run': run(); break;
    case 'pair': {
      const source = join(app, 'runtime/node_modules/dsh-compose-app/lib/protocol/devices.mjs');
      const { createInvitation, formatInvitation } = await import(pathToFileURL(source).href);
      const code = createInvitation(join(home, 'profiles/compose/.state/transport'));
      process.stdout.write(`Pairing code (one use, expires in 5 minutes): ${formatInvitation(code)}\n`);
      break;
    }
    case 'service': installUnit(); break;
    case 'start':
    case 'stop':
    case 'status': {
      if (!existsSync(unitPath)) throw new Error('Run service to register the user service first, or use run in the foreground');
      checkServiceHome();
      execute('systemctl', ['--user', command, unit]);
      break;
    }
    default:
      process.stdout.write('Usage: node compose.mjs install|update|pair|run|service|start|stop|status [--home DIR] [--package DIR] [-- engine options]\n');
      if (command && command !== '--help') process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
