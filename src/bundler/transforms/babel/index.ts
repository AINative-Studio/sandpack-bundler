import { CompilationError } from '../../../errors/CompilationError';
import * as logger from '../../../utils/logger';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';
import { ICollectImportsData, ICollectImportsResult, ITransformData } from './babel-worker';

// AINative perf fix (issue builder-ainative-studio#1089): a small, FIXED-size
// pool of Babel workers instead of one.
//
// Real profiling (full numbers in this PR's description) found this
// bundler's dependency walker dispatches babel.transform() calls through
// NamedPromiseQueue at concurrency 50 (bundler.ts's transformationQueue),
// but every one of those "concurrent" calls funneled through this file's
// SINGLE Worker -- a JS worker processes one message at a time, so 50-wide
// queue concurrency bought nothing: 1455 real transform calls for a
// one-icon lucide-react import were fully serialized on one thread
// regardless. Splitting those calls across a handful of real OS threads
// (Web Workers run on genuine separate threads, unlike the main-thread
// event loop) lets them actually run in parallel, which is a correctness-
// free, bounded way to cut wall-clock time on the COLD-compile path --
// unlike the content-hash cache in babel-worker.ts, which only helps
// repeat/incremental compiles (every file is a first-time miss on a cold
// compile, so caching alone does ~nothing there; measured ~5% noise-level
// difference on a cold realistic-fixture compile. See PR description).
//
// Bounded, not unbounded: a fixed pool size (not navigator.hardwareConcurrency,
// which could spin up a dozen+ workers on a high-core-count machine and
// just add dispatch/memory overhead without matching gains, and could be 1
// on constrained environments) -- POOL_SIZE is a deliberately small,
// reasonable constant. Each worker also builds its OWN independent
// transform cache (module-scoped state in babel-worker.ts) -- this costs a
// little cache-hit-rate efficiency (the same file hash could land on
// different workers across calls) but has zero correctness impact, and
// avoids the complexity/risk of sharing cache state across worker threads
// (which would need its own synchronization and is not worth it for a
// bounded pool this small).
const POOL_SIZE = 4;

export class BabelTransformer extends Transformer {
  private workers: Worker[] = [];
  private messageBuses: WorkerMessageBus[] = [];
  private nextWorkerIndex = 0;

  constructor() {
    super('babel-transformer');
  }

  async init() {
    for (let i = 0; i < POOL_SIZE; i++) {
      const worker = new Worker(new URL('./babel-worker', import.meta.url), {
        type: 'module',
      });

      // AINative perf-profiling instrumentation (issue builder-ainative-studio#1089).
      // Relay each worker's self-reported per-transform timings up to the
      // window so a throwaway debug build can collect/aggregate them from
      // outside the iframe. No-op unless window.__SANDPACK_PROFILE__ is
      // set, and even then this only ever reads data -- never affects
      // compilation.
      if (typeof window !== 'undefined' && (window as any).__SANDPACK_PROFILE__) {
        worker.postMessage({ channel: 'sandpack-profile-enable' });
        worker.addEventListener('message', (evt: MessageEvent) => {
          const data: any = evt.data;
          if (data && data.channel === 'sandpack-profile' && Array.isArray(data.entries)) {
            const w = window as any;
            w.__sandpackProfileEntries = w.__sandpackProfileEntries || [];
            w.__sandpackProfileEntries.push(...data.entries);
            // Relay straight to the hosting page too (cross-origin iframe --
            // window.parent is the only channel out). Plain postMessage, no
            // 'codesandbox' envelope, so a throwaway debug host page can
            // listen for it directly without implementing the full protocol
            // handshake. No-op (guarded above) outside profiling builds.
            try {
              window.parent.postMessage({ __sandpackProfile: 'babel-transform', entries: data.entries }, '*');
            } catch {
              // best-effort only
            }
          }
        });
      }

      const messageBus = new WorkerMessageBus({
        channel: 'sandpack-babel',
        endpoint: worker,
        handleNotification: () => Promise.resolve(),
        handleRequest: () => Promise.reject(new Error('Unknown method')),
        handleError: (err) => {
          logger.error(err);
          return Promise.resolve();
        },
        timeoutMs: 30000,
      });

      this.workers.push(worker);
      this.messageBuses.push(messageBus);
    }
  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    if (this.messageBuses.length === 0) {
      throw new Error('Babel worker pool has not been initialized');
    }

    // AINative tree-shaking fix (issue builder-ainative-studio#1089): look
    // up whether this exact file's resolved path is a barrel this
    // compile's pre-pass (Bundler.collectAppBarrelUsage) has a
    // fully-known usage set for. Deliberately a plain lookup keyed by
    // this module's own filepath, not a config field threaded through
    // Preset.mapTransformers -- the allowed-names set is dynamic
    // per-compile data computed from the app's actual source, not a
    // static per-filetype transform config.
    //
    // Awaiting barrelUsagePromise here is a defense-in-depth backstop,
    // not the real correctness guarantee -- bundler.ts's compile() ALSO
    // awaits it directly before the entry-point walk even starts (see
    // that call site's doc comment for a real correctness bug found and
    // fixed when an earlier version of this fix tried making that await
    // non-blocking: Module.compile()'s short-circuit on `compiled !=
    // null` has no knowledge of this promise, so a node_modules module
    // could be reached and returned stale before a non-blocking
    // collectAppBarrelUsage() ever got a chance to widen it). By the
    // time ANY transform call reaches this line, barrelUsagePromise is
    // therefore already resolved in the only call path this bundler
    // actually uses -- this await exists only so a future caller that
    // forgets compile()'s own await still gets the correct, if slower,
    // behavior instead of a silent stale read.
    if (ctx.module.bundler.barrelUsagePromise) {
      await ctx.module.bundler.barrelUsagePromise;
    }
    const barrelAllowedNames = ctx.module.bundler.barrelUsage?.get(ctx.module.filepath);

    const data: ITransformData = {
      code: ctx.code,
      filepath: ctx.module.filepath,
      config,
      barrelAllowedNames,
    };

    // Simple round-robin dispatch. No per-file affinity needed: each
    // worker's cache is independent and content-addressed (keyed by a
    // hash of the file content, not the worker identity), so round-robin
    // is sufficient -- no need for consistent hashing or sticky routing.
    const workerIndex = this.nextWorkerIndex;
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.messageBuses.length;
    const messageBus = this.messageBuses[workerIndex];

    try {
      return await messageBus.request('transform', data);
    } catch (err: unknown) {
      return new CompilationError(err as Error, ctx.module.filepath);
    }
  }

  /** AINative tree-shaking fix (issue builder-ainative-studio#1089). Used
   *  only by Bundler.collectAppBarrelUsage()'s pre-pass -- see that
   *  method and barrel-usage.ts's doc comment for the full design. Runs
   *  the collection-mode plugin against one app source file and returns
   *  which named bindings it imports from each bare specifier, without
   *  producing (or caching) any real transform output. */
  async collectImports(data: ICollectImportsData): Promise<ICollectImportsResult> {
    if (this.messageBuses.length === 0) {
      throw new Error('Babel worker pool has not been initialized');
    }
    const workerIndex = this.nextWorkerIndex;
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.messageBuses.length;
    const messageBus = this.messageBuses[workerIndex];
    return messageBus.request('collectImports', data);
  }
}
