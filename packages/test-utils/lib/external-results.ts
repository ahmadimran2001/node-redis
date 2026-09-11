import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getExternalConfig, getExternalSkipReasons, isExternalMode, type ResolvedExternalConfig } from './external-config';

interface MochaLikeTest {
  title: string;
  fullTitle(): string;
  file?: string;
  duration?: number;
  state?: string;
  type?: string;
  currentRetry?: () => number;
  retries?: () => number;
}

interface MochaLikeRunner {
  on(event: 'pass' | 'pending', listener: (test: MochaLikeTest) => void): this;
  on(event: 'fail', listener: (test: MochaLikeTest, error: unknown) => void): this;
  once(event: 'end', listener: () => void): this;
  stats?: Record<string, number | undefined>;
}

interface FailureDetail {
  name?: string;
  message?: string;
  stack?: string;
  actual?: unknown;
  expected?: unknown;
}

interface TestResult {
  title: string;
  fullTitle: string;
  file?: string;
  status: 'passed' | 'failed' | 'pending';
  durationMs?: number;
  retries: number;
  error?: FailureDetail;
}

interface HookResult {
  title: string;
  status: 'failed';
  error: FailureDetail;
}

interface ResultDocument {
  schemaVersion: 1;
  mode: 'external';
  runId: string;
  instanceId: string;
  packageName?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: 'running' | 'passed' | 'failed' | 'interrupted';
  summary: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
  };
  tests: Array<TestResult>;
  hooks: Array<HookResult>;
  skipReasons: Array<string>;
}

interface RunContext {
  runId: string;
  instanceId: string;
  directory: string;
  resultsPath: string;
  startedAt: number;
  document: ResultDocument;
  finished: boolean;
  writeFailure?: Error;
}

const sensitiveKey = /(password|secret|token|credential|authorization|privateKey)/i;
const identifier = /^[A-Za-z0-9._-]+$/;

function errorDetail(error: unknown): FailureDetail {
  if (!(error instanceof Error)) return { message: String(error) };
  const detail: FailureDetail = { name: error.name, message: error.message, stack: error.stack };
  const candidate = error as Error & { actual?: unknown; expected?: unknown };
  if (candidate.actual !== undefined) detail.actual = candidate.actual;
  if (candidate.expected !== undefined) detail.expected = candidate.expected;
  return detail;
}

export function redact(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  return value;
}

function repositoryRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { workspaces?: unknown };
      if (Array.isArray(packageJson.workspaces)) return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function valueOrGenerated(value: string | undefined, fallback: string): string {
  const result = value || fallback;
  if (!identifier.test(result)) throw new Error(`Run identifiers must match ${identifier}`);
  return result;
}

function outputLocation(startedAt: number): { root: string; runId: string; instanceId: string; directory: string } {
  const runId = valueOrGenerated(process.env.RUN_ID, new Date(startedAt).toISOString().replace(/[:.]/g, '-'));
  const instanceId = valueOrGenerated(process.env.INSTANCE_ID, `${process.pid}-${randomUUID()}`);
  const root = resolve(process.env.REDIS_EXTERNAL_OUTPUT_DIR || join(repositoryRoot(process.env.INIT_CWD || process.cwd()), 'out'));
  const directory = join(root, runId, instanceId);
  if (existsSync(directory)) throw new Error(`External result directory already exists: ${directory}`);
  mkdirSync(join(root, runId), { recursive: true });
  mkdirSync(directory, { recursive: false });
  return { root, runId, instanceId, directory };
}

function packageName(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string };
      if (packageJson.name) return packageJson.name;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function redactedArguments(args: Array<string>): Array<string> {
  const result = [...args];
  for (let i = 0; i < result.length; i++) {
    if (/^(--?(?:password|pass|token|secret)|(?:REDIS_)?(?:PASSWORD|TOKEN|SECRET))$/i.test(result[i])) {
      if (result[i + 1]) result[i + 1] = '[REDACTED]';
    } else if (/^(--?(?:password|pass|token|secret))=/i.test(result[i])) {
      result[i] = `${result[i].split('=')[0]}=[REDACTED]`;
    }
  }
  return result;
}

function selectedTestFiles(args: Array<string>): Array<string> {
  return args.filter(argument => /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(argument));
}

function runnerFilters(args: Array<string>): Array<string> {
  return args.filter(argument => /^(?:--(?:grep|fgrep|invert|exclude|spec|ignore))(?:=|$)/u.test(argument));
}

function environmentDocument(): Record<string, unknown> {
  const environment: Record<string, unknown> = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd()
  };
  for (const key of [
    'RUN_ID',
    'INSTANCE_ID',
    'REDIS_EXTERNAL_CONFIG',
    'NODE_ENV',
    'CI',
    'npm_lifecycle_event',
    'npm_package_name',
    'npm_config_workspace',
    'MOCHA_FILE',
    'MOCHA_GREP',
    'MOCHA_INVERT'
  ]) {
    if (process.env[key] !== undefined) environment[key] = key === 'REDIS_EXTERNAL_CONFIG' ? '[CONFIG_PATH]' : process.env[key];
  }
  return environment;
}

function configurationDocument(
  config: ResolvedExternalConfig | undefined,
  root: string,
  packageNameValue: string | undefined,
  initializationError?: unknown
): unknown {
  const args = process.argv.slice(2);
  return redact({
    external: config,
    effectiveRESP: {
      server: config?.server?.RESP ?? 2,
      cluster: config?.cluster?.RESP ?? 2
    },
    selectedTestFiles: selectedTestFiles(args),
    filters: runnerFilters(args),
    runnerArguments: redactedArguments(args),
    arguments: redactedArguments(process.argv),
    workspace: {
      root,
      packageName: packageNameValue,
      cwd: process.cwd()
    },
    packageName: packageNameValue,
    cwd: process.cwd(),
    cleanupMode: 'flush-all',
    cleanup: 'flush-all',
    ...(initializationError === undefined ? {} : { initializationError: errorDetail(initializationError) })
  });
}

export function createExternalResultsContext(): RunContext {
  if (!isExternalMode()) throw new Error('External result output requires external mode');
  const startedAt = Date.now();
  const location = outputLocation(startedAt);
  const config = getExternalConfig();
  const document: ResultDocument = {
    schemaVersion: 1,
    mode: 'external',
    runId: location.runId,
    instanceId: location.instanceId,
    packageName: packageName(process.cwd()),
    startedAt: new Date(startedAt).toISOString(),
    status: 'running',
    summary: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 },
    tests: [],
    hooks: [],
    skipReasons: getExternalSkipReasons(config)
  };
  const context: RunContext = {
    runId: location.runId,
    instanceId: location.instanceId,
    directory: location.directory,
    resultsPath: join(location.directory, 'results.json'),
    startedAt,
    document,
    finished: false
  };
  atomicWrite(join(location.directory, 'config.json'), configurationDocument(config, location.root, document.packageName));
  atomicWrite(join(location.directory, 'env.json'), environmentDocument());
  atomicWrite(context.resultsPath, context.document);
  return context;
}

export function writeExternalInitializationFailure(error: unknown): void {
  try {
    const startedAt = Date.now();
    const location = outputLocation(startedAt);
    const packageNameValue = packageName(process.cwd());
    const document: ResultDocument = {
      schemaVersion: 1,
      mode: 'external',
      runId: location.runId,
      instanceId: location.instanceId,
      packageName: packageNameValue,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      status: 'failed',
      summary: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 },
      tests: [],
      hooks: [{ title: 'external initialization', status: 'failed', error: errorDetail(error) }],
      skipReasons: ['external results initialization failed']
    };
    atomicWrite(join(location.directory, 'config.json'), configurationDocument(undefined, location.root, packageNameValue, error));
    atomicWrite(join(location.directory, 'env.json'), environmentDocument());
    atomicWrite(join(location.directory, 'results.json'), document);
  } catch (writeError) {
    process.exitCode = 1;
    console.error(`Unable to write external initialization results: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
  }
}

function updateSummary(document: ResultDocument): void {
  document.summary = {
    total: document.tests.length,
    passed: document.tests.filter(test => test.status === 'passed').length,
    failed: document.tests.filter(test => test.status === 'failed').length,
    pending: document.tests.filter(test => test.status === 'pending').length,
    skipped: document.tests.filter(test => test.status === 'pending').length
  };
}

function testKey(test: MochaLikeTest): string {
  return `${test.file || ''}\u0000${test.fullTitle()}`;
}

function toTestResult(test: MochaLikeTest, status: TestResult['status'], error?: unknown): TestResult {
  return {
    title: test.title,
    fullTitle: test.fullTitle(),
    file: test.file,
    status,
    durationMs: test.duration,
    retries: test.currentRetry?.() || 0,
    ...(error === undefined ? {} : { error: errorDetail(error) })
  };
}

export function writePartialResults(context: RunContext, status: ResultDocument['status'] = 'interrupted'): void {
  if (context.finished) return;
  context.document.status = status;
  context.document.endedAt = new Date().toISOString();
  context.document.durationMs = Date.now() - context.startedAt;
  updateSummary(context.document);
  try {
    atomicWrite(context.resultsPath, context.document);
  } catch (error) {
    context.writeFailure = error instanceof Error ? error : new Error(String(error));
    process.exitCode = 1;
  }
}

export function finalizeResults(context: RunContext, failed: boolean): void {
  if (context.finished) return;
  context.finished = true;
  context.document.status = failed || context.document.hooks.length > 0 || context.writeFailure !== undefined ? 'failed' : 'passed';
  context.document.endedAt = new Date().toISOString();
  context.document.durationMs = Date.now() - context.startedAt;
  updateSummary(context.document);
  try {
    atomicWrite(context.resultsPath, context.document);
  } catch (error) {
    context.writeFailure = error instanceof Error ? error : new Error(String(error));
    process.exitCode = 1;
    console.error(`Unable to write external test results: ${context.writeFailure.message}`);
  }
}

export function recordExternalTest(
  context: RunContext,
  tests: Map<string, TestResult>,
  test: MochaLikeTest,
  status: TestResult['status'],
  error?: unknown
): void {
  const result = toTestResult(test, status, error);
  tests.set(testKey(test), result);
  context.document.tests = [...tests.values()];
  updateSummary(context.document);
  try {
    atomicWrite(context.resultsPath, context.document);
  } catch (writeError) {
    process.exitCode = 1;
    context.writeFailure = writeError instanceof Error ? writeError : new Error(String(writeError));
    console.error(`Unable to update external test results: ${errorDetail(writeError).message}`);
  }
}

export function recordExternalHook(context: RunContext, test: MochaLikeTest, error: unknown): void {
  context.document.hooks.push({ title: test.fullTitle(), status: 'failed', error: errorDetail(error) });
  try {
    atomicWrite(context.resultsPath, context.document);
  } catch (writeError) {
    process.exitCode = 1;
    context.writeFailure = writeError instanceof Error ? writeError : new Error(String(writeError));
    console.error(`Unable to update external test results: ${errorDetail(writeError).message}`);
  }
}

export type { ResultDocument, RunContext, TestResult, MochaLikeTest, MochaLikeRunner };
