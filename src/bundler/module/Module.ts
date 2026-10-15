import { BundlerError } from '../../errors/BundlerError';
import { Bundler } from '../bundler';
import { Evaluation } from './Evaluation';
import { HotContext } from './hot';

export interface IDependencyEvent {
  specifier: string;
}

export class Module {
  id: string;
  filepath: string;
  isEntry = false;
  source: string;
  compiled: string | null;
  bundler: Bundler;
  evaluation: Evaluation | null = null;
  hot: HotContext;

  compilationError: BundlerError | null = null;

  dependencies: Set<string>;
  // Keeping this seperate from dependencies as there might be duplicates otherwise
  dependencyMap: Map<string, string>;

  constructor(filepath: string, source: string, isCompiled: boolean = false, bundler: Bundler) {
    this.id = filepath;
    this.filepath = filepath;
    this.source = source;
    this.compiled = isCompiled ? source : null;
    this.dependencies = new Set();
    this.dependencyMap = new Map();
    this.bundler = bundler;
    this.hot = new HotContext(this);
  }

  get initiators() {
    return this.bundler.getInitiators(this.id);
  }

  isHot(): boolean {
    return Boolean(this.hot.hmrConfig?.isHot());
  }

  /** Add dependency */
  async addDependency(depSpecifier: string): Promise<void> {
    const resolved = await this.bundler.resolveAsync(depSpecifier, this.filepath);
    this.dependencies.add(resolved);
    this.dependencyMap.set(depSpecifier, resolved);
    this.bundler.addInitiator(resolved, this.id);
  }

  async compile(): Promise<void> {
    if (this.compiled != null || this.compilationError != null) {
      return;
    }
    try {
      const preset = this.bundler.preset;
      if (!preset) {
        throw new Error('Preset has not been initialized');
      }

      const transformers = preset.getTransformers(this);
      if (!transformers.length) {
        throw new Error(`No transformers found for ${this.filepath}`);
      }

      let code = this.source;
      for (const [transformer, config] of transformers) {
        const transformationResult = await transformer.transform(
          {
            module: this,
            code,
          },
          config
        );

        if (transformationResult instanceof BundlerError) {
          this.compilationError = transformationResult;
        } else {
          code = transformationResult.code;
          await Promise.all(
            Array.from(transformationResult.dependencies).map((d) => {
              return this.addDependency(d);
            })
          );
        }
      }

      this.compiled = code;
    } catch (err: any) {
      this.compilationError = err;
    }
  }

  resetCompilation(): void {
    // We always reset compilation errors as this will be non-null while compilation is null
    this.compilationError = null;

    // Skip modules that don't have any compilation
    if (this.compiled == null) return;

    this.compiled = null;
    this.evaluation = null;

    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(true);
    } else {
      // for (let initiator of this.initiators) {
      //   const module = this.bundler.getModule(initiator);
      //   module?.resetCompilation();
      // }

      // // If this is an entry we want all direct entries to be reset as well.
      // // Entries generally have side effects
      // if (this.isEntry) {
      //   for (let dependency of this.dependencies) {
      //     const module = this.bundler.getModule(dependency);
      //     module?.resetCompilation();
      //   }
      // }

      location.reload();
    }

    this.bundler.transformModule(this.filepath);
  }

  /**
   * AINative tree-shaking fix (issue builder-ainative-studio#1089).
   *
   * A narrower sibling of resetCompilation(), for exactly one case:
   * Bundler.collectAppBarrelUsage()'s widen-detection in compile()
   * discovers that a node_modules barrel file (e.g. lucide-react's main
   * entry) was already compiled under a stale, too-narrow set of
   * allowed re-export names -- an app-level HMR edit added a new named
   * import this file's previous compile had trimmed away.
   *
   * resetCompilation() is the wrong tool here: it is designed for a
   * module whose SOURCE changed and that needs either a real HMR-dirty
   * flag (if something called module.hot.accept() on it) or a full page
   * reload (if nothing did -- its only other option). A third-party
   * npm package's own file is never itself HMR-aware (nothing inside
   * lucide-react calls module.hot.accept()), so resetCompilation() would
   * unconditionally take the reload branch here -- turning a normal,
   * already-successful HMR update of the APP's own file (which DOES have
   * an HMR context, via react-refresh) into a disruptive full-page
   * reload, every time a widen is detected. That's a real regression
   * (confirmed via a live HMR test: without this method, re-running
   * resetCompilation() on the barrel file reloaded the iframe and the
   * app lost its render until the reload's own fresh compile finished).
   *
   * This file's *source* never changed -- only which of its exports this
   * compile decided to keep. There's nothing to "hot swap" in the
   * running page for this file specifically (it has never been
   * evaluated under a wider name set, so there's no stale closure of
   * its previous, narrower exports living in memory that needs
   * invalidating client-side); the module whose evaluated state actually
   * changes is the APP file that gained the new import, and recompiling
   * that is already the entry-point walk's normal job, triggered the
   * normal way, already happening for entirely separate reasons as part
   * of this same compile. All this needs to do is make sure the NEXT
   * time something resolves this file's path, it re-runs Module.compile
   * instead of returning the stale cached result -- clear the compiled
   * output and dependency bookkeeping, and re-queue a transform, with no
   * HMR-dirty flag and no reload.
   */
  resetForWidenedBarrelUsage(): void {
    this.compilationError = null;
    this.compiled = null;
    this.evaluation = null;
    this.dependencies = new Set();
    this.dependencyMap = new Map();
    this.bundler.transformModule(this.filepath);
  }

  evaluate(): Evaluation {
    if (this.evaluation) {
      return this.evaluation;
    }

    if (this.hot.hmrConfig) {
      // this.bundler.setHmrStatus('dispose');
      // Call module.hot.dispose handler
      // https://webpack.js.org/api/hot-module-replacement/#dispose-or-adddisposehandler-
      this.hot.hmrConfig.callDisposeHandler();
      // this.bundler.setHmrStatus('apply');
    }

    // Reset hmr context while keeping the previous hot data
    this.hot = this.hot.clone();
    // AINative fix (issue builder-ainative-studio#1089): assign BEFORE
    // running the module body (Evaluation.run(), below), not after. See
    // Evaluation.ts's doc comment -- this ordering is what lets a
    // circular require hit evaluate()'s `if (this.evaluation) return
    // this.evaluation` short-circuit instead of recursing into a fresh
    // Evaluation (and fresh module-body execution) every time, which is
    // what caused a real RangeError: Maximum call stack size exceeded on
    // a genuine Builder app's victory-vendor/d3-interpolate circular
    // require (value.js <-> array.js).
    this.evaluation = new Evaluation(this);
    this.evaluation.run();

    // this.bundler.setHmrStatus('apply');
    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(false);
      this.hot.hmrConfig.callAcceptCallback();
    }
    // this.bundler.setHmrStatus('idle');

    return this.evaluation;
  }
}
