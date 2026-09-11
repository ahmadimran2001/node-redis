import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getExternalSkipReasons,
  loadExternalConfig,
  parseExternalConfig,
  resetExternalConfigForTests
} from './external-config';

describe('external configuration', () => {
  const originalConfig = process.env.REDIS_EXTERNAL_CONFIG;

  afterEach(() => {
    if (originalConfig === undefined) delete process.env.REDIS_EXTERNAL_CONFIG;
    else process.env.REDIS_EXTERNAL_CONFIG = originalConfig;
    resetExternalConfigForTests();
  });

  it('resolves standalone and cluster defaults', () => {
    const config = parseExternalConfig({
      server: { host: ' standalone ' },
      cluster: { nodes: [{ host: 'cluster-a' }, { host: 'cluster-b', port: 6380 }] }
    }, 'config.json');

    assert.deepEqual(config.server, { host: 'standalone', port: 6379 });
    assert.deepEqual(config.cluster, {
      nodes: [{ host: 'cluster-a', port: 6379 }, { host: 'cluster-b', port: 6380 }]
    });
  });

  it('rejects malformed nested sections and values', () => {
    assert.throws(() => parseExternalConfig({ server: null }, 'config.json'), /server.*object/);
    assert.throws(() => parseExternalConfig({ cluster: { nodes: [null] } }, 'config.json'), /node 0.*object/);
    assert.throws(() => parseExternalConfig({ server: { host: 'x', port: 0 } }, 'config.json'), /port/);
    assert.throws(() => parseExternalConfig({ server: { host: 'x', port: null } }, 'config.json'), /port/);
    assert.throws(() => parseExternalConfig({ server: { host: 'x', RESP: 4 } }, 'config.json'), /RESP/);
    assert.throws(() => parseExternalConfig({ server: { host: 'x', password: 1 } }, 'config.json'), /password/);
  });

  it('keeps a failed load failed on repeated access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'redis-external-config-'));
    const path = join(directory, 'config.json');
    writeFileSync(path, '{"server":', 'utf8');
    process.env.REDIS_EXTERNAL_CONFIG = path;

    try {
      assert.throws(() => loadExternalConfig(), /Unexpected end/);
      assert.throws(() => loadExternalConfig(), /Unexpected end/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a command-line option without a path', () => {
    const originalArguments = process.argv;
    process.argv = [originalArguments[0], originalArguments[1] || 'test', '--redis-external-config='];
    try {
      assert.throws(() => loadExternalConfig(), /requires a file path/);
    } finally {
      process.argv = originalArguments;
    }
  });

  it('gives the command-line path precedence over the environment path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'redis-external-config-'));
    const environmentPath = join(directory, 'environment.json');
    const commandLinePath = join(directory, 'command-line.json');
    writeFileSync(environmentPath, JSON.stringify({ server: { host: 'environment' } }), 'utf8');
    writeFileSync(commandLinePath, JSON.stringify({ server: { host: 'command-line' } }), 'utf8');
    const originalArguments = process.argv;
    process.env.REDIS_EXTERNAL_CONFIG = environmentPath;
    process.argv = [originalArguments[0], originalArguments[1] || 'test', `--redis-external-config=${commandLinePath}`];
    try {
      assert.equal(loadExternalConfig()?.server?.host, 'command-line');
    } finally {
      process.argv = originalArguments;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports precise missing-fixture reasons', () => {
    const reasons = getExternalSkipReasons(parseExternalConfig({ server: { host: 'x' } }, 'config.json'));
    assert.ok(reasons.some(reason => reason.includes('cluster tests')));
    assert.ok(reasons.some(reason => reason.includes('sentinel tests')));
    assert.ok(reasons.some(reason => reason.includes('TLS tests')));
    assert.ok(reasons.some(reason => reason.includes('proxied-cluster tests')));
  });
});
