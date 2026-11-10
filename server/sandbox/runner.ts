/**
 * Runner abstraction: the service decides WHAT runs (authorization, quotas, queue, timeouts, statuses) and a runner
 * decides HOW (Docker today). Tests inject a fake runner with `setSandboxRunner()`.
 */
export interface SandboxLimits {
  timeout_s: number;
  memory_mb: number;
  cpus: number;
  pids: number;
  tmpfs_mb: number;
}

export interface SandboxExecution {
  runId: string;
  containerName: string;
  image: string;
  /** Profile argv: `{input}` and `{app}` are already resolved, `{entry}` is resolved inside the container. */
  command: string[];
  input: { name: string; data: Buffer };
  extract: boolean;
  entryCandidates: string[];
  limits: SandboxLimits;
  ociRuntime: string | null;
  inputMode: 'auto' | 'bind' | 'stdin';
}

export interface SandboxIo {
  /** Raw container output (stdout and stderr). The service caps and sanitises it. */
  onOutput(chunk: Buffer): void;
  /** Aborted with reason 'timeout' or 'cancel': the runner must kill the container and resolve promptly. */
  signal: AbortSignal;
}

export interface SandboxOutcome {
  exitCode: number | null;
  /** Runtime failure (daemon unreachable, image missing...), never user program output. */
  error?: string;
}

export interface RuntimeCheck {
  ok: boolean;
  version?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface SandboxRunner {
  readonly name: string;
  check(ociRuntime?: string | null): Promise<RuntimeCheck>;
  execute(job: SandboxExecution, io: SandboxIo): Promise<SandboxOutcome>;
  /** Best-effort forced stop of a container that may belong to a previous process. */
  kill(containerName: string): Promise<void>;
  /** Removes this instance's sandbox containers that are not in `keep`. Returns the number removed. */
  removeLeftovers(keep: Set<string>): Promise<number>;
  pull?(image: string): Promise<{ ok: boolean; output: string }>;
}

/** Inside the container. `/work` is a tmpfs; the build is copied to /work/build and archives are extracted to /work/app. */
export const containerPaths = { build: '/work/build', app: '/work/app', input: '/input', entry: '/sandbox/entry.sh' } as const;

/** Keeps only safe characters so the name can be used in a path and by the entry script. */
export function safeBuildName(originalName: string): string {
  const cleaned = originalName.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '').replace(/_+/g, '_').slice(-100);
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `build${cleaned ? `_${cleaned}` : ''}`.slice(0, 100);
}

export function resolveCommand(command: string[], buildName: string): string[] {
  return command.map((value) => value === '{input}' ? `${containerPaths.build}/${buildName}` : value === '{app}' ? containerPaths.app : value);
}
