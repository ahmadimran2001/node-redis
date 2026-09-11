import {
  createExternalResultsContext,
  finalizeResults,
  recordExternalHook,
  recordExternalTest,
  writePartialResults,
  type MochaLikeRunner,
  type MochaLikeTest,
  type RunContext,
  type TestResult,
  writeExternalInitializationFailure
} from './external-results';
import { isExternalMode } from './external-config';

class ExternalResultsReporter {
  readonly #context?: RunContext;
  readonly #tests = new Map<string, TestResult>();

  constructor(runner: MochaLikeRunner) {
    let external: boolean;
    try {
      external = isExternalMode();
    } catch (error) {
      process.exitCode = 1;
      writeExternalInitializationFailure(error);
      console.error(`Unable to initialize external test results: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!external) return;
    try {
      this.#context = createExternalResultsContext();
    } catch (error) {
      process.exitCode = 1;
      writeExternalInitializationFailure(error);
      console.error(`Unable to initialize external test results: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    runner.on('pass', test => this.recordTest(test, 'passed'));
    runner.on('fail', (test, error) => {
      if (test.type === 'hook') {
        recordExternalHook(this.#context!, test, error);
      } else {
        this.recordTest(test, 'failed', error);
      }
    });
    runner.on('pending', test => this.recordTest(test, 'pending'));
    runner.once('end', () => finalizeResults(this.#context!, Boolean(runner.stats?.failures)));
    process.once('exit', () => writePartialResults(this.#context!));
  }

  private recordTest(test: MochaLikeTest, status: TestResult['status'], error?: unknown): void {
    if (!this.#context) return;
    recordExternalTest(this.#context, this.#tests, test, status, error);
  }
}

export = ExternalResultsReporter;
