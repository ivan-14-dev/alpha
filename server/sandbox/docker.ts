import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, chown, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '../platform/log.js';
import { appOrigin } from '../platform/settings.js';
import { tmpSizeMb } from './config.js';
import { containerPaths, type RuntimeCheck, type SandboxExecution, type SandboxIo, type SandboxOutcome, type SandboxRunner } from './runner.js';

/** Unprivileged uid/gid used inside every sandbox container (`nobody` in Alpine/Debian images). */
export const SANDBOX_UID = 65534;

/**
 * Docker endpoint and paths come from the environment only (never from the admin console).
 * ALPHA_SANDBOX_DOCKER_HOST (e.g. tcp://sandbox-host:2376 with TLS) is passed to the docker CLI as DOCKER_HOST.
 */
export function dockerSettings() {
  return {
    bin: process.env.ALPHA_SANDBOX_DOCKER_BIN || 'docker',
    host: process.env.ALPHA_SANDBOX_DOCKER_HOST || process.env.DOCKER_HOST || null,
    tlsVerify: process.env.ALPHA_SANDBOX_DOCKER_TLS_VERIFY ?? process.env.DOCKER_TLS_VERIFY ?? null,
    certPath: process.env.ALPHA_SANDBOX_DOCKER_CERT_PATH ?? process.env.DOCKER_CERT_PATH ?? null,
    workDir: resolve(process.env.ALPHA_SANDBOX_WORK_DIR || 'data/sandbox-work'),
    entryScript: resolve(process.env.ALPHA_SANDBOX_ENTRY || 'sandbox/entry.sh'),
  };
}

export function isRemoteDocker(host = dockerSettings().host): boolean {
  return !!host && !/^(unix|npipe):\/\//.test(host);
}

/** Label distinguishing this platform instance's containers on a shared sandbox daemon. */
export function instanceId(): string {
  return process.env.ALPHA_SANDBOX_INSTANCE || createHash('sha256').update(appOrigin()).digest('hex').slice(0, 12);
}

/** Minimal environment for the docker CLI: application secrets (session keys, SMTP, providers...) never reach it. */
function dockerEnv(): NodeJS.ProcessEnv {
  const settings = dockerSettings();
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.ALPHA_SANDBOX_DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.ALPHA_SANDBOX_DOCKER_CONFIG;
  if (settings.host) env.DOCKER_HOST = settings.host;
  if (settings.tlsVerify) env.DOCKER_TLS_VERIFY = settings.tlsVerify;
  if (settings.certPath) env.DOCKER_CERT_PATH = settings.certPath;
  return env;
}

interface CommandResult { code: number | null; stdout: string; stderr: string; error?: string }

/** Short auxiliary docker command (argv array, never a shell), killed after `timeoutMs`. */
export function dockerCommand(args: string[], timeoutMs = 15000, maxBytes = 1024 * 1024): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(dockerSettings().bin, args, { env: dockerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null, stdout, stderr, error: 'Délai dépassé.' }); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < maxBytes) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < maxBytes) stderr += chunk.toString('utf8'); });
    child.once('error', (error: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr,
      error: error.code === 'ENOENT' ? 'Client Docker introuvable (ALPHA_SANDBOX_DOCKER_BIN).' : 'Impossible de lancer le client Docker.' }));
    child.once('close', (code) => finish({ code, stdout, stderr }));
  });
}

function nprocLimit(pids: number) {
  // RLIMIT_NPROC is counted per uid across containers sharing uid 65534; --pids-limit is the real per-container bound.
  return Math.max(256, pids * 4);
}

/** Full `docker run` argv. Exported for tests: every isolation flag is asserted there. */
export function dockerRunArgs(job: SandboxExecution, mode: 'bind' | 'stdin', mounts: { inputDir?: string; entryScript?: string; entrySource?: string }): string[] {
  const limits = job.limits;
  const args = [
    'run', '--rm', '--name', job.containerName,
    '--label', 'alpha.sandbox=1', '--label', `alpha.sandbox.instance=${instanceId()}`, '--label', `alpha.sandbox.run=${job.runId}`,
    '--pull', 'never', '--log-driver', 'none', '--init',
    '--network', 'none', '--hostname', 'sandbox', '--ipc', 'private',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${SANDBOX_UID}:${SANDBOX_UID}`,
    '--pids-limit', String(limits.pids),
    '--memory', `${limits.memory_mb}m`, '--memory-swap', `${limits.memory_mb}m`,
    '--cpus', limits.cpus.toFixed(2),
    '--oom-score-adj', '500',
    '--ulimit', 'nofile=256:256', '--ulimit', `nproc=${nprocLimit(limits.pids)}:${nprocLimit(limits.pids)}`, '--ulimit', 'core=0:0',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${tmpSizeMb(limits)}m,mode=1777`,
    '--tmpfs', `/work:rw,exec,nosuid,nodev,size=${limits.tmpfs_mb}m,uid=${SANDBOX_UID},gid=${SANDBOX_UID},mode=0700`,
    '--workdir', '/work',
    '--env', 'HOME=/work', '--env', 'TMPDIR=/tmp', '--env', 'LANG=C.UTF-8',
    '--env', `ALPHA_INPUT_NAME=${job.input.name}`, '--env', `ALPHA_INPUT_MODE=${mode}`, '--env', `ALPHA_INPUT_SIZE=${job.input.data.length}`,
    '--env', `ALPHA_EXTRACT=${job.extract ? 1 : 0}`, '--env', `ALPHA_ENTRY_CANDIDATES=${job.entryCandidates.join(' ')}`,
    // In-container watchdog: still kills the program if this process dies before its own timeout fires.
    '--env', `ALPHA_TIMEOUT=${limits.timeout_s + 10}`,
  ];
  if (job.ociRuntime) args.push('--runtime', job.ociRuntime);
  if (mode === 'bind') {
    if (!mounts.inputDir || !mounts.entryScript) throw new Error('bind mounts missing');
    args.push('--volume', `${mounts.inputDir}:${containerPaths.input}:ro`, '--volume', `${mounts.entryScript}:${containerPaths.entry}:ro`,
      '--entrypoint', '/bin/sh', job.image, containerPaths.entry, ...job.command);
  } else {
    if (!mounts.entrySource) throw new Error('entry source missing');
    args.push('--interactive', '--entrypoint', '/bin/sh', job.image, '-c', mounts.entrySource, 'alpha-entry', ...job.command);
  }
  return args;
}

export function inputModeFor(requested: SandboxExecution['inputMode']): 'bind' | 'stdin' {
  if (requested === 'auto') return isRemoteDocker() ? 'stdin' : 'bind';
  return requested;
}

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Per-run host directory: `<workDir>` is 0700 so other host users cannot reach it; the run copy is read-only. */
async function prepareBindInput(job: SandboxExecution, entrySource: string) {
  const { workDir } = dockerSettings();
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await chmod(workDir, 0o700);
  const runDir = join(workDir, job.runId);
  const inputDir = join(runDir, 'input');
  await mkdir(inputDir, { recursive: true, mode: 0o700 });
  const buildPath = join(inputDir, job.input.name);
  const entryPath = join(runDir, 'entry.sh');
  await writeFile(buildPath, job.input.data, { mode: 0o400, flag: 'wx' });
  await writeFile(entryPath, entrySource, { mode: 0o400, flag: 'wx' });
  try {
    // Running as root: hand the files to the sandbox uid and keep them private (0500/0400).
    await chown(buildPath, SANDBOX_UID, SANDBOX_UID);
    await chown(entryPath, SANDBOX_UID, SANDBOX_UID);
    await chown(inputDir, SANDBOX_UID, SANDBOX_UID);
    await chmod(inputDir, 0o500);
  } catch {
    // Unprivileged server: the container uid reads through the mount; the 0700 parent still hides it on the host.
    await chmod(buildPath, 0o444);
    await chmod(entryPath, 0o444);
    await chmod(inputDir, 0o555);
  }
  await chmod(runDir, 0o700);
  return { runDir, inputDir, entryPath };
}

async function removeRunDir(runDir: string) {
  await chmod(join(runDir, 'input'), 0o700).catch(() => undefined);
  await rm(runDir, { recursive: true, force: true }).catch((error) => log.warn('sandbox.workdir_cleanup_failed', { error }));
}

/** Removes per-run directories left behind by a crash. */
export async function pruneWorkDir(maxAgeMs: number, keep: Set<string>) {
  const { workDir } = dockerSettings();
  const entries = await readdir(workDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (keep.has(entry) || !/^[a-zA-Z0-9-]+$/.test(entry)) continue;
    const info = await stat(join(workDir, entry)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > maxAgeMs) await removeRunDir(join(workDir, entry));
  }
}

export async function readEntryScript(): Promise<string> {
  return readFile(dockerSettings().entryScript, 'utf8');
}

export const dockerRunner: SandboxRunner = {
  name: 'docker',

  async check(ociRuntime) {
    const result = await dockerCommand(['info', '--format', '{{json .}}'], 15000);
    if (result.code !== 0) {
      return { ok: false, error: result.error ?? (result.stderr.trim().split('\n').pop()?.slice(0, 300) || 'Démon Docker injoignable.') };
    }
    try {
      const info = JSON.parse(result.stdout) as { ServerVersion?: string; Runtimes?: Record<string, unknown>; DefaultRuntime?: string;
        SecurityOptions?: string[]; OperatingSystem?: string; CgroupVersion?: string; KernelVersion?: string; Architecture?: string };
      const runtimes = Object.keys(info.Runtimes ?? {});
      const security = info.SecurityOptions ?? [];
      const details = {
        server_version: info.ServerVersion ?? null, operating_system: info.OperatingSystem ?? null, kernel: info.KernelVersion ?? null,
        architecture: info.Architecture ?? null, cgroup_version: info.CgroupVersion ?? null, runtimes, default_runtime: info.DefaultRuntime ?? null,
        rootless: security.some((item) => item.includes('rootless')), userns: security.some((item) => item.includes('userns')),
        seccomp: security.some((item) => item.includes('seccomp')), apparmor: security.some((item) => item.includes('apparmor')),
        remote: isRemoteDocker(),
      };
      if (!info.ServerVersion) return { ok: false, error: 'Réponse inattendue du démon Docker.', details };
      if (ociRuntime && !runtimes.includes(ociRuntime)) {
        return { ok: false, version: info.ServerVersion, error: `Le runtime OCI « ${ociRuntime} » n’est pas installé sur le démon.`, details };
      }
      return { ok: true, version: info.ServerVersion, details } satisfies RuntimeCheck;
    } catch {
      return { ok: false, error: 'Réponse illisible du démon Docker.' };
    }
  },

  async execute(job: SandboxExecution, io: SandboxIo): Promise<SandboxOutcome> {
    if (io.signal.aborted) return { exitCode: null };
    const mode = inputModeFor(job.inputMode);
    if (mode === 'bind' && isRemoteDocker()) {
      return { exitCode: null, error: 'Le mode « bind » exige un démon Docker local : utilisez « stdin » avec un démon distant.' };
    }
    let entrySource: string;
    try { entrySource = await readEntryScript(); }
    catch { return { exitCode: null, error: 'Script d’entrée du bac à sable introuvable (sandbox/entry.sh).' }; }

    let prepared: Awaited<ReturnType<typeof prepareBindInput>> | null = null;
    try {
      if (mode === 'bind') prepared = await prepareBindInput(job, entrySource);
      if (io.signal.aborted) return { exitCode: null };
      const args = dockerRunArgs(job, mode, prepared ? { inputDir: prepared.inputDir, entryScript: prepared.entryPath } : { entrySource });
      const child = spawn(dockerSettings().bin, args, { env: dockerEnv(), stdio: [mode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      let closed = false;
      const exit = new Promise<{ code: number | null; error?: string }>((resolvePromise) => {
        child.once('error', (error: NodeJS.ErrnoException) => resolvePromise({ code: null,
          error: error.code === 'ENOENT' ? 'Client Docker introuvable (ALPHA_SANDBOX_DOCKER_BIN).' : 'Impossible de lancer le client Docker.' }));
        child.once('close', (code) => { closed = true; resolvePromise({ code }); });
      });
      child.stdout!.on('data', (chunk: Buffer) => io.onOutput(chunk));
      child.stderr!.on('data', (chunk: Buffer) => io.onOutput(chunk));
      if (mode === 'stdin') {
        child.stdin!.on('error', () => undefined);
        child.stdin!.end(job.input.data);
      }
      const onAbort = () => {
        void (async () => {
          // The container may not exist yet when the abort arrives: retry until the CLI exits.
          for (let attempt = 0; attempt < 15 && !closed; attempt += 1) {
            await dockerCommand(['kill', job.containerName], 10000);
            await Promise.race([exit, delay(1000)]);
          }
          if (!closed) {
            child.kill('SIGKILL');
            await dockerCommand(['rm', '--force', job.containerName], 15000);
          }
        })().catch((error) => log.error('sandbox.kill_failed', { error, run_id: job.runId }));
      };
      io.signal.addEventListener('abort', onAbort, { once: true });
      if (io.signal.aborted) onAbort();
      const result = await exit;
      io.signal.removeEventListener('abort', onAbort);
      return { exitCode: result.code, ...(result.error ? { error: result.error } : {}) };
    } finally {
      if (prepared) await removeRunDir(prepared.runDir);
    }
  },

  async kill(containerName) {
    await dockerCommand(['rm', '--force', containerName], 15000);
  },

  async removeLeftovers(keep) {
    const listed = await dockerCommand(['ps', '--all', '--filter', 'label=alpha.sandbox=1', '--filter', `label=alpha.sandbox.instance=${instanceId()}`,
      '--format', '{{.Names}}'], 15000);
    if (listed.code !== 0) throw new Error(listed.error ?? 'docker ps a échoué');
    const names = listed.stdout.split('\n').map((name) => name.trim()).filter((name) => /^alpha-sbx-[a-zA-Z0-9-]+$/.test(name) && !keep.has(name));
    if (!names.length) return 0;
    const removed = await dockerCommand(['rm', '--force', ...names], 30000);
    if (removed.code !== 0) log.warn('sandbox.leftover_cleanup_failed', { stderr: removed.stderr.slice(0, 300) });
    return names.length;
  },

  async pull(image) {
    const result = await dockerCommand(['pull', image], 10 * 60000, 64 * 1024);
    return { ok: result.code === 0, output: (result.error ?? `${result.stdout}${result.stderr}`).slice(-4000) };
  },
};
