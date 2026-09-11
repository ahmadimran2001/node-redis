import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExternalResultsReporter from './external-results-reporter';
import { resetExternalConfigForTests } from './external-config';

class FakeRunner extends EventEmitter {
  stats = { failures: 1 };
}

function test(title: string, status: 'passed' | 'failed' | 'pending' = 'passed', file = 'test.spec.ts') {
  return {
    title,
    file,
    type: 'test',
    fullTitle: () => `suite ${title}`,
    duration: 12,
    currentRetry: () => 1,
    retries: () => 2,
    status
  };
}

describe('external result reporter', () => {
  let directory: string;
  let configPath: string;
  const originalExitCode = process.exitCode;
  const environment = {
    REDIS_EXTERNAL_CONFIG: process.env.REDIS_EXTERNAL_CONFIG,
    REDIS_EXTERNAL_OUTPUT_DIR: process.env.REDIS_EXTERNAL_OUTPUT_DIR,
    RUN_ID: process.env.RUN_ID,
    INSTANCE_ID: process.env.INSTANCE_ID
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'redis-external-results-'));
    configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify({ server: { host: '127.0.0.1', password: 'secret' } }), 'utf8');
    process.env.REDIS_EXTERNAL_CONFIG = configPath;
    process.env.REDIS_EXTERNAL_OUTPUT_DIR = directory;
    process.env.RUN_ID = 'run';
    process.env.INSTANCE_ID = `instance-${Date.now()}`;
    resetExternalConfigForTests();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    resetExternalConfigForTests();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('writes results, configuration, environment, and redacted credentials', () => {
    const runner = new FakeRunner();
    new ExternalResultsReporter(runner);
    runner.emit('pass', test('passes'));
    runner.emit('pending', test('waits'));
    runner.emit('fail', test('fails'), new Error('expected failure'));
    runner.emit('end');

    const output = join(directory, 'run', process.env.INSTANCE_ID!, '');
    const results = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8')) as {
      status: string;
      summary: { total: number; passed: number; failed: number; pending: number; skipped: number };
      tests: Array<{ status: string; error?: { message?: string } }>;
    };
    const config = JSON.parse(readFileSync(join(output, 'config.json'), 'utf8')) as { external: { server: { password?: string } } };
    const environmentFile = JSON.parse(readFileSync(join(output, 'env.json'), 'utf8')) as Record<string, unknown>;

    assert.equal(results.status, 'failed');
    assert.deepEqual(results.summary, { total: 3, passed: 1, failed: 1, pending: 1, skipped: 1 });
    assert.equal(results.tests[2].error?.message, 'expected failure');
    assert.equal(config.external.server.password, '[REDACTED]');
    assert.equal(environmentFile.REDIS_EXTERNAL_CONFIG, '[CONFIG_PATH]');
    assert.equal(environmentFile.PASSWORD, undefined);
  });

  it('preserves a failed initialization as a result artifact', () => {
    writeFileSync(configPath, '{', 'utf8');
    resetExternalConfigForTests();
    new ExternalResultsReporter(new FakeRunner());

    const output = join(directory, 'run', process.env.INSTANCE_ID!, '');
    const results = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8')) as {
      status: string;
      hooks: Array<{ error?: { message?: string } }>;
    };

    assert.equal(results.status, 'failed');
    assert.match(results.hooks[0].error?.message || '', /Invalid JSON|Expected property/);
  });
});
