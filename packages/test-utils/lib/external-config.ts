import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RespVersions } from '@redis/client/index';

export interface ExternalNodeConfig {
  host: string;
  port?: number;
}

export interface ExternalServerConfig extends ExternalNodeConfig {
  username?: string | null;
  password?: string | null;
  RESP?: RespVersions;
}

export interface ExternalClusterConfig {
  nodes: Array<ExternalNodeConfig>;
  username?: string | null;
  password?: string | null;
  RESP?: RespVersions;
}

export interface ExternalConfig {
  server?: ExternalServerConfig;
  cluster?: ExternalClusterConfig;
}

export interface ResolvedExternalServer {
  host: string;
  port: number;
  username?: string;
  password?: string;
  RESP?: RespVersions;
}

export interface ResolvedExternalCluster {
  nodes: Array<{ host: string; port: number }>;
  username?: string;
  password?: string;
  RESP?: RespVersions;
}

export interface ResolvedExternalConfig {
  path: string;
  server?: ResolvedExternalServer;
  cluster?: ResolvedExternalCluster;
}

export const DEFAULT_EXTERNAL_PORT = 6379;
export const EXTERNAL_CONFIG_ARGUMENT = 'redis-external-config';
export const EXTERNAL_CONFIG_ENV_VAR = 'REDIS_EXTERNAL_CONFIG';

type LoadState =
  | { status: 'unloaded' }
  | { status: 'loaded'; config: ResolvedExternalConfig }
  | { status: 'failed'; error: Error };

let loadState: LoadState = { status: 'unloaded' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function resolveConfigPath(): string | undefined {
  const prefix = `--${EXTERNAL_CONFIG_ARGUMENT}=`;
  const args = process.argv.slice(2);
  const inline = args.find(argument => argument.startsWith(prefix));
  if (inline) {
    const value = inline.slice(prefix.length);
    if (!value) throw new Error(`--${EXTERNAL_CONFIG_ARGUMENT} requires a file path`);
    return value;
  }
  const index = args.indexOf(`--${EXTERNAL_CONFIG_ARGUMENT}`);
  if (index >= 0) {
    if (!args[index + 1]) throw new Error(`--${EXTERNAL_CONFIG_ARGUMENT} requires a file path`);
    return args[index + 1];
  }
  return process.env[EXTERNAL_CONFIG_ENV_VAR] || undefined;
}

function parsePort(port: unknown, where: string): number {
  if (port === undefined) return DEFAULT_EXTERNAL_PORT;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${where}: "port" must be an integer between 1 and 65535`);
  }
  return port;
}

function parseRESP(RESP: unknown, where: string): RespVersions | undefined {
  if (RESP === undefined) return undefined;
  if (RESP !== 2 && RESP !== 3) throw new Error(`${where}: "RESP" must be 2 or 3`);
  return RESP;
}

function parseHost(host: unknown, where: string): string {
  if (typeof host !== 'string' || host.trim().length === 0) {
    throw new Error(`${where}: "host" is required and must be a non-empty string`);
  }
  return host.trim();
}

function parseCredential(value: unknown, field: string, where: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${where}: "${field}" must be a string`);
  return value;
}

export function parseExternalConfig(raw: unknown, path: string): ResolvedExternalConfig {
  if (!isRecord(raw)) throw new Error(`${path}: the config must be a JSON object`);

  const server = raw.server;
  const cluster = raw.cluster;
  if (server === undefined && cluster === undefined) {
    throw new Error(`${path}: the config must define at least one of "server" or "cluster"`);
  }
  if (server !== undefined && !isRecord(server)) {
    throw new Error(`${path} ("server"): must be an object`);
  }
  if (cluster !== undefined && !isRecord(cluster)) {
    throw new Error(`${path} ("cluster"): must be an object`);
  }

  const resolved: ResolvedExternalConfig = { path };
  if (server) {
    const where = `${path} ("server")`;
    const username = parseCredential(server.username, 'username', where);
    const password = parseCredential(server.password, 'password', where);
    const RESP = parseRESP(server.RESP, where);
    resolved.server = {
      host: parseHost(server.host, where),
      port: parsePort(server.port, where),
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(RESP === undefined ? {} : { RESP })
    };
  }

  if (cluster) {
    const where = `${path} ("cluster")`;
    if (!Array.isArray(cluster.nodes) || cluster.nodes.length === 0) {
      throw new Error(`${where}: "nodes" must be a non-empty array of { host, port }`);
    }
    const username = parseCredential(cluster.username, 'username', where);
    const password = parseCredential(cluster.password, 'password', where);
    const RESP = parseRESP(cluster.RESP, where);
    resolved.cluster = {
      nodes: cluster.nodes.map((node, i) => {
        if (!isRecord(node)) throw new Error(`${where}, node ${i}: must be an object`);
        return {
          host: parseHost(node.host, `${where}, node ${i}`),
          port: parsePort(node.port, `${where}, node ${i}`)
        };
      }),
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(RESP === undefined ? {} : { RESP })
    };
  }
  return resolved;
}

export function loadExternalConfig(): ResolvedExternalConfig | undefined {
  if (loadState.status === 'loaded') return loadState.config;
  if (loadState.status === 'failed') throw loadState.error;

  const configPath = resolveConfigPath();
  if (!configPath) return undefined;

  try {
    const absolute = resolve(configPath);
    let contents: string;
    try {
      contents = readFileSync(absolute, 'utf-8');
    } catch (error) {
      throw new Error(`Cannot read external Redis config ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON in external Redis config ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const config = parseExternalConfig(raw, absolute);
    loadState = { status: 'loaded', config };
    logBanner(config);
    return config;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    loadState = { status: 'failed', error: failure };
    throw failure;
  }
}

export function resetExternalConfigForTests(): void {
  loadState = { status: 'unloaded' };
}

export function isExternalMode(): boolean {
  return loadExternalConfig() !== undefined;
}

export function isExternalModeEnabled(): boolean {
  try {
    return isExternalMode();
  } catch {
    return true;
  }
}

export function getExternalConfig(): ResolvedExternalConfig | undefined {
  return loadExternalConfig();
}

export function getExternalServer(): ResolvedExternalServer | undefined {
  return loadExternalConfig()?.server;
}

export function getExternalCluster(): ResolvedExternalCluster | undefined {
  return loadExternalConfig()?.cluster;
}

export function getExternalSkipReasons(config = loadExternalConfig()): Array<string> {
  if (!config) return [];
  const reasons: Array<string> = [];
  if (!config.server) reasons.push('standalone client and pool tests: no "server" endpoint is configured');
  if (!config.cluster) reasons.push('cluster tests: no "cluster" endpoint is configured');
  if (config.server && !config.server.password) reasons.push('password-protected standalone tests: no "server.password" is configured');
  if (config.cluster && !config.cluster.password) reasons.push('password-protected cluster tests: no "cluster.password" is configured');
  reasons.push('sentinel tests: external mode does not provide a controlled sentinel topology');
  reasons.push('TLS tests: external mode does not provide the Docker-generated certificates');
  reasons.push('proxied-cluster tests: external mode does not provide proxy and fault-injector containers');
  reasons.push('replica-dependent cluster tests: external mode cannot add replicas to the configured cluster');
  return reasons;
}

function formatNodes(nodes: Array<{ host: string; port: number }>): string {
  return nodes.map(({ host, port }) => `${host}:${port}`).join(', ');
}

function formatRESP(RESP: RespVersions | undefined): string {
  return RESP === undefined ? 'RESP from spec' : `RESP ${RESP}`;
}

function logBanner(config: ResolvedExternalConfig): void {
  const lines = [
    `config: ${config.path}`,
    config.server
      ? `standalone: ${config.server.host}:${config.server.port} (${formatRESP(config.server.RESP)})`
      : 'standalone: not configured - client and pool tests will be skipped',
    config.cluster
      ? `cluster: ${formatNodes(config.cluster.nodes)} (${formatRESP(config.cluster.RESP)})`
      : 'cluster: not configured - cluster tests will be skipped',
    ...getExternalSkipReasons(config)
  ];
  for (const line of lines) console.log(`[external-redis] ${line}`);
}
