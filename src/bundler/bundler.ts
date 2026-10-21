import { BundlerError } from '../errors/BundlerError';
import { FileSystem } from '../FileSystem';
import { IFrameFSLayer } from '../FileSystem/layers/IFrameFSLayer';
import { MemoryFSLayer } from '../FileSystem/layers/MemoryFSLayer';
import { NodeModuleFSLayer } from '../FileSystem/layers/NodeModuleFSLayer';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { BundlerStatus } from '../protocol/message-types';
import { ResolverCache, resolveAsync } from '../resolver/resolver';
import { IPackageJSON, ISandboxFile } from '../types';
import { Emitter } from '../utils/emitter';
import { replaceHTML } from '../utils/html';
import * as logger from '../utils/logger';
import { NamedPromiseQueue } from '../utils/NamedPromiseQueue';
import { nullthrows } from '../utils/nullthrows';
import { ModuleRegistry } from './module-registry';
import { Module } from './module/Module';
import { Preset } from './presets/Preset';
import { getPreset } from './presets/registry';
import { BarrelAllowedNames } from './transforms/babel/barrel-usage';

export type TransformationQueue = NamedPromiseQueue<Module>;

// AINative tree-shaking fix (issue builder-ainative-studio#1089). Fast,
// non-cryptographic string hash (FNV-1a, 32-bit) -- same algorithm and
// same rationale as babel-worker.ts's fnv1a: this is a cache key for
// Bundler.barrelScanCache, not a security boundary, so collision
// resistance only needs to be "good enough to not matter in practice
// for a session's file count", which FNV-1a comfortably is. A separate
// copy rather than importing babel-worker.ts's version -- that module
// runs inside a Worker (self/postMessage globals), this one runs on the
// main thread; keeping them independent avoids coupling two files that
// otherwise have no reason to share code.
function barrelScanCacheKeyFor(code: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36) + ':' + code.length;
}

interface IBundlerOpts {
  messageBus: IFrameParentMessageBus;
}

interface IFSOptions {
  hasAsyncFileResolver?: boolean;
}

export class Bundler {
  private lastHTML: string | null = null;
  private messageBus: IFrameParentMessageBus;

  fs: FileSystem;
  moduleRegistry: ModuleRegistry;

  parsedPackageJSON: IPackageJSON | null = null;
  // Map filepath => Module
  modules: Map<string, Module> = new Map();
  transformationQueue: TransformationQueue;
  resolverCache: ResolverCache = new Map();
  hasHMR = false;
  isFirstLoad = true;
  preset: Preset | undefined;

  // Map from module id => parent module ids
  initiators = new Map<string, Set<string>>();
  runtimes: string[] = [];

  /** AINative tree-shaking fix (issue builder-ainative-studio#1089). Map
   *  from a node_modules file's RESOLVED absolute path to the set of
   *  named exports this compile's app source actually imports from it
   *  (or 'ALL' if this fix cannot safely narrow -- see barrel-usage.ts's
   *  doc comment). Populated by collectAppBarrelUsage(). Consulted in
   *  transforms/babel/index.ts's BabelTransformer, gated on
   *  barrelUsagePromise (see that field) so a node_modules file is never
   *  transformed before this map is guaranteed complete for this compile.
   *  Reset on every resetModules() (full recompile), same lifetime as
   *  `modules`. */
  barrelUsage: Map<string, BarrelAllowedNames> = new Map();

  /** AINative tree-shaking fix (issue builder-ainative-studio#1089).
   *  Content-hash cache for collectAppBarrelUsage()'s per-file scan
   *  results, scoped to this Bundler instance's lifetime (one Sandpack
   *  preview session) -- same rationale as babel-worker.ts's
   *  node_modules transform cache, applied here for a different reason:
   *  Builder's shared getBuiltinFiles() bundle (~109 JS/TS-like files,
   *  confirmed live) is BYTE-IDENTICAL across every compile in a given
   *  session (it never changes at runtime), so re-parsing it on every
   *  single HMR-triggered recompile is pure waste. Does NOT help the
   *  first, cold compile of a session (every entry is a first-time miss
   *  there) -- that is a real, known, currently-unavoidable-within-this-
   *  fix's-design cost, see collectAppBarrelUsage()'s doc comment. Keyed
   *  by a cheap non-cryptographic hash of the raw file content (same
   *  fnv1a-style reasoning as babel-worker.ts's transform cache: this is
   *  a cache key, not a security boundary). No eviction -- unlike the
   *  node_modules transform cache, the key space here is bounded by this
   *  compile's own file count (never grows across HMR edits to the same
   *  file, since re-editing a file changes its content and therefore its
   *  key), so unbounded growth is not a realistic risk for a single
   *  preview session's lifetime. */
  private barrelScanCache: Map<string, Record<string, BarrelAllowedNames>> = new Map();

  /** AINative tree-shaking fix (issue builder-ainative-studio#1089).
   *  Resolves once collectAppBarrelUsage() finishes populating
   *  barrelUsage for the CURRENT compile. compile() awaits this directly,
   *  BLOCKING the entry-point walk, before that walk starts -- see that
   *  call site's own doc comment for why: a non-blocking version of this
   *  (fire collectAppBarrelUsage(), let the entry-point walk start
   *  concurrently, only await this promise inside
   *  transforms/babel/index.ts's BabelTransformer right before reading
   *  barrelUsage for a node_modules file) was tried and REVERTED after a
   *  real correctness bug: Module.compile()'s own dependency-walk
   *  short-circuit (`compiled != null`, see Module.ts) has no knowledge
   *  of this promise at all, so an HMR update that widens a barrel's
   *  allowed-names set could reach and return a STALE, narrower-trimmed
   *  node_modules module before collectAppBarrelUsage()'s own
   *  widen-detection logic (which only runs after ITS OWN promise
   *  resolves) got a chance to reset it -- confirmed live via a real
   *  import silently resolving to undefined. Blocking here is what
   *  guarantees barrelUsage is fully settled before anything can possibly
   *  observe a half-finished scan; this field now exists only so
   *  BabelTransformer.transform() has a defense-in-depth backstop (await
   *  an already-resolved promise there, which costs nothing) rather than
   *  depending solely on this call site never changing. null before the
   *  first compile starts; reassigned to a fresh promise at the start of
   *  every compile. See collectAppBarrelUsage()'s own doc comment for the
   *  real, mitigated-but-still-present performance cost this blocking
   *  requirement imposes, and the known-barrel-package fast path that
   *  makes it cheap for the common case where it doesn't matter. */
  barrelUsagePromise: Promise<void> | null = null;

  private onStatusChangeEmitter = new Emitter<BundlerStatus>();
  onStatusChange = this.onStatusChangeEmitter.event;

  private _previousDepString: string | null = null;
  private iFrameFsLayer: IFrameFSLayer;

  constructor(options: IBundlerOpts) {
    this.transformationQueue = new NamedPromiseQueue(true, 50);
    this.moduleRegistry = new ModuleRegistry(this);
    const memoryFS = new MemoryFSLayer();
    memoryFS.writeFile('//empty.js', 'module.exports = () => {};');
    this.iFrameFsLayer = new IFrameFSLayer(memoryFS, options.messageBus);
    this.fs = new FileSystem([memoryFS, this.iFrameFsLayer, new NodeModuleFSLayer(this.moduleRegistry)]);
    this.messageBus = options.messageBus;
  }

  /** Reset all compilation data */
  resetModules(): void {
    this.preset = undefined;
    this.modules = new Map();
    this.resolverCache = new Map();
    this.barrelUsage = new Map();
    this.barrelUsagePromise = null;
  }

  configureFS(opts: IFSOptions): void {
    if (opts.hasAsyncFileResolver) {
      this.iFrameFsLayer.enableIFrameFS();
    }
  }

  async initPreset(preset: string): Promise<void> {
    if (!this.preset) {
      this.preset = getPreset(preset);
      await this.preset.init(this);
    }
  }

  registerRuntime(id: string, code: string): void {
    const filepath = `/node_modules/__csb_runtimes/${id}.js`;
    this.fs.writeFile(filepath, code);
    const module = new Module(filepath, code, false, this);
    this.modules.set(filepath, module);
    this.runtimes.push(filepath);
  }

  getModule(filepath: string): Module | undefined {
    return this.modules.get(filepath);
  }

  enableHMR(): void {
    this.hasHMR = true;
  }

  getInitiators(id: string): Set<string> {
    return this.initiators.get(id) ?? new Set();
  }

  addInitiator(moduleId: string, initiatorId: string): void {
    const initiators = this.getInitiators(moduleId);
    initiators.add(initiatorId);
    this.initiators.set(moduleId, initiators);
  }

  async processPackageJSON(): Promise<void> {
    const foundPackageJSON = await this.fs.readFileAsync('/package.json');
    try {
      this.parsedPackageJSON = JSON.parse(foundPackageJSON);
    } catch (err) {
      // Makes the bundler a bit more error-prone to invalid pkg.json's
      if (!this.parsedPackageJSON) {
        throw err;
      }
    }
  }

  async resolveEntryPoint(): Promise<string> {
    if (!this.parsedPackageJSON) {
      throw new BundlerError('No parsed package.json found!');
    }

    if (!this.preset) {
      throw new BundlerError('Preset has not been loaded yet');
    }

    const potentialEntries = new Set(
      [
        this.parsedPackageJSON.main,
        this.parsedPackageJSON.source,
        this.parsedPackageJSON.module,
        ...this.preset.defaultEntryPoints,
      ].filter((e) => typeof e === 'string')
    );

    for (let potentialEntry of potentialEntries) {
      if (typeof potentialEntry === 'string') {
        try {
          // Normalize path
          const entryPoint =
            potentialEntry[0] !== '.' && potentialEntry[0] !== '/' ? `./${potentialEntry}` : potentialEntry;
          const resolvedEntryPont = await this.resolveAsync(entryPoint, '/index.js');
          return resolvedEntryPont;
        } catch (err) {
          logger.debug(`Could not resolve entrypoint ${potentialEntry}`);
          logger.debug(err);
        }
      }
    }
    throw new BundlerError(
      `Could not resolve entry point, potential entrypoints: ${Array.from(potentialEntries).join(
        ', '
      )}. You can define one by changing the "main" field in package.json.`
    );
  }

  async loadNodeModules() {
    if (!this.parsedPackageJSON) {
      throw new BundlerError('No parsed pkg.json found!');
    }

    let dependencies = this.parsedPackageJSON.dependencies;
    if (dependencies) {
      dependencies = nullthrows(
        this.preset,
        'Preset needs to be defined when loading node modules'
      ).augmentDependencies(dependencies);

      await this.moduleRegistry.fetchManifest(dependencies);

      // Load all modules
      await this.moduleRegistry.preloadModules();
      await this.moduleRegistry.loadModuleDependencies();
    }
  }

  /**
   * AINative tree-shaking fix (issue builder-ainative-studio#1089). See
   * barrel-usage.ts's doc comment for the full design and correctness
   * argument. This is step 1-3 of that design: a pre-pass over the app's
   * OWN source files (never node_modules -- those are what this fix
   * exists to avoid eagerly transforming), run once per compile.
   *
   * Populates this.barrelUsage: resolved absolute path -> allowed names
   * (or 'ALL'). Intentionally resolves bare specifiers via
   * this.resolveAsync() the same way the real walk will -- this needs
   * node_modules file CONTENT to already be fetched (so the real call
   * site in compile() runs this after loadNodeModules(), not before;
   * fetching the manifest itself is comparatively cheap and already
   * measured as not the bottleneck, see module-cdn.ts's fetchModule
   * profiling notes) -- but the actual babel.transform() walk of those
   * files' CONTENTS is what stays deferred/narrowed.
   *
   * compile() awaits this method (via barrelUsagePromise) before
   * starting the entry-point walk -- see that call site's doc comment
   * for why a non-blocking version of this was tried and REVERTED after
   * a real correctness bug (a widened HMR import could read a stale
   * node_modules module before this method's own widen-reset got a
   * chance to run). Blocking here is what guarantees barrelUsage is
   * fully settled before anything -- app or node_modules -- can possibly
   * observe a half-finished scan.
   *
   * That correctness requirement is what makes this pre-pass's own cost
   * matter so much: Builder's shared getBuiltinFiles() bundle alone is
   * ~109 JS/TS-like files that get scanned on EVERY compile regardless
   * of whether the app itself imports anything barrel-shaped (measured
   * real cost: ~3-4s added to an app that imports zero barrel packages,
   * a genuine net loss for that app -- vs. ~2-2.5s saved on an app that
   * does, a genuine net win there). See the KNOWN_BARREL_PACKAGE_MARKERS
   * fast-path below for the one mitigation that is both safe (zero
   * correctness risk -- it can only ever decide to skip the ENTIRE
   * pre-pass, never to narrow it incorrectly) and actually closes most
   * of that gap for the large, common fraction of real apps that import
   * no barrel package at all.
   */
  async collectAppBarrelUsage(files: ISandboxFile[]): Promise<void> {
    // AINative perf-profiling instrumentation (issue builder-ainative-studio#1089).
    // Reports how long THIS pre-pass itself takes and which exit path it
    // took (same pattern as this file's other profiling blocks and
    // babel-worker.ts's profileLog) -- this is what made the known-barrel
    // fast path below verifiable independent of outer browser/CDN/machine
    // noise (which can otherwise swing a single compile's wall-clock by
    // several real seconds with zero code change, confirmed live during
    // this fix's own development). No-op unless window.__SANDPACK_PROFILE__
    // is set; never affects compilation.
    const profileStart = typeof window !== 'undefined' && (window as any).__SANDPACK_PROFILE__ ? performance.now() : 0;
    const emitPrepassTiming = (reason: string) => {
      if (typeof window !== 'undefined' && (window as any).__SANDPACK_PROFILE__) {
        try {
          window.parent.postMessage(
            {
              __sandpackProfile: 'barrel-prepass-timing',
              reason,
              ms: +(performance.now() - profileStart).toFixed(2),
              fileCount: files.length,
            },
            '*'
          );
        } catch {
          // best-effort only
        }
      }
    };
    if (!this.preset) {
      emitPrepassTiming('no-preset');
      return;
    }

    const babelTransformer = this.preset.getTransformer('babel-transformer') as
      | import('./transforms/babel').BabelTransformer
      | undefined;
    if (!babelTransformer) {
      // No babel transformer registered at all (shouldn't happen for the
      // react/solid presets, both of which always register one) -- bail
      // out silently. barrelUsage stays empty, which is the fully-eager,
      // pre-fix-equivalent behavior (every lookup elsewhere treats a
      // missing entry as "don't narrow this file").
      emitPrepassTiming('no-babel-transformer');
      return;
    }

    // AINative tree-shaking fix (issue builder-ainative-studio#1089):
    // zero-correctness-risk fast path. KNOWN_BARREL_PACKAGE_MARKERS is a
    // small, deliberately conservative allowlist of package names this
    // fix has actually been confirmed to help (today: just
    // 'lucide-react', the issue's own real target -- see this fix's PR
    // description for the measured ~1400-call barrel-walk reproduction).
    // If NONE of the compile's files contain the literal substring of
    // ANY listed package name, there is categorically nothing for this
    // pre-pass to narrow -- skipping the ENTIRE scan in that case
    // (leaving barrelUsage empty, i.e. fully eager, exactly the
    // pre-fix-equivalent behavior) is safe because it can only ever
    // trigger on a genuine, textual absence of the package name itself;
    // it is not a guess about import shape or usage the way a real
    // tree-shaking decision would be. A package NOT on this list simply
    // gets no early-exit benefit (the full per-file scan below still
    // runs, exactly as if this fast path didn't exist) -- extending this
    // fix to other barrel-shaped packages later only ever means adding
    // their name here, never touching the correctness-sensitive scan
    // logic itself.
    const KNOWN_BARREL_PACKAGE_MARKERS = ['lucide-react'];
    // Exclude package.json: a real regression was found and fixed here --
    // @codesandbox/sandpack-client (the real client this bundler serves,
    // confirmed via its own bundled source, createPackageJSON) SYNTHESIZES
    // a /package.json file from customSetup.dependencies and sends it as
    // part of `files` just like any other file -- so a package merely
    // DECLARED as a dependency (which Builder's sandpack-preview.tsx
    // always declares for lucide-react and recharts regardless of actual
    // use, see this fix's PR description and the chat-id.ts fixture's own
    // doc comment on the recharts case) makes this literal-substring check
    // fire every single time, defeating the fast path's entire purpose on
    // the exact production path it exists to help. package.json's
    // presence is a decent signal for "resolvable", never for "imported"
    // -- only real source files' content can answer that question, which
    // is exactly what the full scan below (never skipped just because
    // package.json happens to mention the name) still determines
    // correctly either way.
    const mightUseKnownBarrel = files.some(
      (f) =>
        f.path !== '/package.json' &&
        KNOWN_BARREL_PACKAGE_MARKERS.some((marker) => f.code.includes(marker))
    );
    if (!mightUseKnownBarrel) {
      this.barrelUsage = new Map();
      emitPrepassTiming('fast-path-skip');
      return;
    }

    // Raw specifier -> allowed names, merged across every app file before
    // any resolution happens (multiple files may import from the same
    // specifier with different name subsets -- e.g. one file imports
    // {Search} and another imports {Home} from 'lucide-react' -- both
    // must be unioned before a single final decision is made per
    // resolved path).
    const bySpecifier = new Map<string, BarrelAllowedNames>();

    const mergeInto = (target: Map<string, BarrelAllowedNames>, source: Record<string, BarrelAllowedNames>) => {
      for (const [specifier, names] of Object.entries(source)) {
        const existing = target.get(specifier);
        if (existing === 'ALL') continue;
        if (names === 'ALL') {
          target.set(specifier, 'ALL');
          continue;
        }
        const merged = new Set(existing ?? []);
        for (const n of names) merged.add(n);
        target.set(specifier, Array.from(merged));
      }
    };

    // AINative tree-shaking fix (issue builder-ainative-studio#1089): two
    // deliberate narrowing steps before dispatching ANY file to the
    // worker pool, both added after a measured real regression (see
    // below) -- without them this pre-pass can cost MORE than it ever
    // saves.
    //
    // 1. Cheap, PRESENCE-only pre-filter (never an extraction -- no
    //    correctness risk, since it only ever decides "maybe skip",
    //    never "here is the parsed import list"): a file with neither
    //    the substring `from` nor `require(` cannot possibly contain an
    //    import/require of anything, bare specifier or not, so it is
    //    structurally impossible for it to affect barrelUsage. This is
    //    the ONLY skip condition that is unconditionally safe without a
    //    real parse -- it is not a guess about import shape, just a
    //    necessary substring any JS/TS import or require must contain.
    //    Confirmed this does NOT help for the regression case found
    //    below (107/109 of a real app's shared builtin-bundle files do
    //    contain real imports) -- kept anyway since it is free and
    //    correctness-neutral, and helps for apps with more inert files.
    //
    // 2. Bounded concurrency instead of one unbounded Promise.all: a
    //    real app's full file set (its own ~10-20 files PLUS Builder's
    //    shared getBuiltinFiles() shadcn/AIKit bundle, confirmed
    //    ~109 JS/TS-like files in that bundle alone) firing 100+
    //    collectImports dispatches simultaneously through the SAME small
    //    (POOL_SIZE=4) worker pool the real compile's own transforms
    //    need was measured to make a real app SLOWER with this fix than
    //    without it (T1i-e_AP3tK-LP6X16XJ2: baseline ~11.5s, this
    //    pre-pass unbounded ~14-17.5s -- reproducible across repeated
    //    runs). Capping in-flight dispatches to a small number lets the
    //    worker pool interleave pre-pass and (once the entry point walk
    //    starts) real transform work more fairly, rather than the
    //    pre-pass monopolizing every worker up front.
    const PREPASS_CONCURRENCY = 2;
    const candidateFiles = files.filter((f) => /from\s*['"`]|require\s*\(/.test(f.code));
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIndex++;
        if (i >= candidateFiles.length) return;
        const file = candidateFiles[i];

        // Use a throwaway Module purely to ask the preset whether this
        // file would get a babel-transformer entry at all in the real
        // compile -- never calls module.compile() on it, never registers
        // it on this.modules. mapTransformers() throws for file types it
        // doesn't recognize at all (images, json, etc.) -- those are
        // never babel-transformed in the real walk either, so skipping
        // them here is exactly correct, not a shortcut. (Unlike an
        // earlier version of this fix, the real per-filetype transform
        // CONFIG this lookup used to also extract is deliberately not
        // threaded through to collectImports any more -- see
        // babel-worker.ts's collectImports doc comment for why: this
        // pre-pass only needs enough syntax support to PARSE the file,
        // never the full env/react preset pipeline real compilation
        // needs, and reusing that heavier config was the direct cause of
        // the measured regression above, fixed by dropping it.)
        const probeModule = new Module(file.path, file.code, false, this);
        let transformerEntries: Array<[any, any]>;
        try {
          transformerEntries = this.preset!.getTransformers(probeModule);
        } catch {
          continue;
        }
        const hasBabelEntry = transformerEntries.some(([transformer]: [any, any]) => transformer === babelTransformer);
        if (!hasBabelEntry) continue;

        const cacheKey = barrelScanCacheKeyFor(file.code);
        const cached = this.barrelScanCache.get(cacheKey);
        if (cached) {
          mergeInto(bySpecifier, cached);
          continue;
        }

        try {
          const result = await babelTransformer.collectImports({
            code: file.code,
            filepath: file.path,
          });
          this.barrelScanCache.set(cacheKey, result.usage);
          mergeInto(bySpecifier, result.usage);
        } catch (err) {
          // A genuinely broken app file will fail here AND fail its real
          // compile later (where the failure surfaces to the app author
          // normally, via the existing, unrelated compilation-error
          // path) -- never let a pre-pass parse failure block or alter
          // that. Skipping this file's contribution to barrelUsage is
          // safe: any specifier it would have narrowed simply stays
          // un-narrowed (fully eager) instead, exactly the pre-fix
          // behavior.
          logger.debug(`collectAppBarrelUsage: failed to parse ${file.path}`, err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREPASS_CONCURRENCY, candidateFiles.length) }, () => worker()));

    // Resolve each raw specifier to its real absolute target path -- the
    // same resolution a real `require(specifier)` from app code would
    // hit (same resolveAsync, same resolverCache). Multiple distinct
    // specifier strings resolving to the SAME path (e.g. a deep import
    // alias) correctly union into one barrelUsage entry rather than
    // overwriting each other, via the same mergeInto merge semantics
    // (ALL dominates; otherwise sets union).
    const resolved = new Map<string, BarrelAllowedNames>();
    await Promise.all(
      Array.from(bySpecifier.entries()).map(async ([specifier, names]) => {
        let resolvedPath: string;
        try {
          // Resolve relative to a synthetic file at the project root --
          // correct for a bare specifier (the only kind bySpecifier ever
          // contains, see barrel-usage.ts's isBareSpecifier), since bare
          // specifier resolution for node_modules packages does not
          // depend on which app file is doing the importing.
          resolvedPath = await this.resolveAsync(specifier, '/__barrel_usage_probe__.js');
        } catch (err) {
          // Can't resolve (e.g. a specifier only ever imported from a
          // file whose OTHER imports fail for an unrelated reason, or a
          // package not actually in package.json#dependencies) -- the
          // real walk will hit the same resolution failure through its
          // own normal error path; nothing to narrow here either way.
          logger.debug(`collectAppBarrelUsage: failed to resolve ${specifier}`, err);
          return;
        }
        const existing = resolved.get(resolvedPath);
        if (existing === 'ALL' || names === 'ALL') {
          resolved.set(resolvedPath, 'ALL');
        } else {
          const merged = new Set(existing ?? []);
          for (const n of names) merged.add(n);
          resolved.set(resolvedPath, Array.from(merged));
        }
      })
    );

    this.barrelUsage = resolved;
    emitPrepassTiming('full-scan-complete');

    // AINative perf-profiling instrumentation (issue builder-ainative-studio#1089).
    // Reports what this fix decided to narrow, for the same throwaway
    // debug builds that already read __sandpackWalkEntries/
    // __sandpackCdnEntries/__sandpackProfileEntries (see bundler.ts's
    // other profiling blocks and babel-worker.ts's profileLog). No-op
    // unless window.__SANDPACK_PROFILE__ is set; never affects
    // compilation.
    if (typeof window !== 'undefined' && (window as any).__SANDPACK_PROFILE__) {
      try {
        window.parent.postMessage(
          {
            __sandpackProfile: 'barrel-usage-summary',
            entries: Array.from(resolved.entries()),
          },
          '*'
        );
      } catch {
        // best-effort only
      }
    }
  }

  async resolveAsync(
    specifier: string,
    filename: string,
    extensions: string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']
  ): Promise<string> {
    try {
      const resolved = await resolveAsync(specifier, {
        filename,
        extensions,
        isFile: this.fs.isFile,
        readFile: this.fs.readFile,
        resolverCache: this.resolverCache,
      });
      return resolved;
    } catch (err) {
      logger.error(err);
      logger.error(Array.from(this.modules));
      // logger.error(Array.from(this.fs.files));
      throw err;
    }
  }

  private async _transformModule(path: string): Promise<Module> {
    // AINative perf-profiling instrumentation (issue builder-ainative-studio#1089).
    // Times the dependency-walker step itself (file read, module.compile()
    // i.e. the babel round-trip, and dependency resolution), separate from
    // the per-transform breakdown collected in babel-worker.ts. Gated the
    // same way -- no-op unless window.__SANDPACK_PROFILE__ is set.
    const profiling = typeof window !== 'undefined' && !!(window as any).__SANDPACK_PROFILE__;
    const tStart = profiling ? performance.now() : 0;

    let module = this.modules.get(path);
    if (module) {
      if (module.compiled != null) {
        return Promise.resolve(module);
      } else {
        // compilation got reset, we re-read the source to ensure it's the latest version.
        // reset happens mostly when we receive changes from the editor, so this ensures we actually output the changes...
        module.source = await this.fs.readFileAsync(path);
      }
    } else {
      const content = await this.fs.readFileAsync(path);
      module = new Module(path, content, false, this);
      this.modules.set(path, module);
    }
    const tAfterRead = profiling ? performance.now() : 0;
    await module.compile();
    const tAfterCompile = profiling ? performance.now() : 0;
    for (let dep of module.dependencies) {
      const resolvedDependency = await this.resolveAsync(dep, module.filepath);
      this.transformModule(resolvedDependency);
    }
    if (profiling) {
      const tEnd = performance.now();
      const w = window as any;
      w.__sandpackWalkEntries = w.__sandpackWalkEntries || [];
      w.__sandpackWalkEntries.push({
        path,
        readMs: +(tAfterRead - tStart).toFixed(3),
        compileMs: +(tAfterCompile - tAfterRead).toFixed(3),
        resolveDepsMs: +(tEnd - tAfterCompile).toFixed(3),
        totalMs: +(tEnd - tStart).toFixed(3),
        numDeps: module.dependencies.size,
      });
    }
    return module;
  }

  /** Transform file at a certain absolute path */
  async transformModule(path: string): Promise<Module> {
    let module = this.modules.get(path);
    if (module && module.compiled != null) {
      return Promise.resolve(module);
    }
    return this.transformationQueue.addEntry(path, () => {
      return this._transformModule(path);
    });
  }

  async moduleFinishedPromise(id: string, moduleIds: Set<string> = new Set()): Promise<any> {
    if (moduleIds.has(id)) return;

    const foundPromise = this.transformationQueue.getItem(id);
    if (foundPromise) {
      await foundPromise;
    }

    const asset = this.modules.get(id);
    if (!asset) {
      throw new BundlerError(`Asset not in the compilation tree ${id}`);
    } else {
      if (asset.compilationError != null) {
        throw asset.compilationError;
      } else if (asset.compiled == null) {
        throw new BundlerError(`Asset ${id} has not been compiled`);
      }
    }

    moduleIds.add(id);

    for (const dep of asset.dependencies) {
      if (!moduleIds.has(dep)) {
        try {
          await this.moduleFinishedPromise(dep, moduleIds);
        } catch (err) {
          logger.debug(`Failed awaiting transpilation ${dep} required by ${id}`);

          throw err;
        }
      }
    }
  }

  /** writes any new files and returns a list of updated modules */
  writeNewFiles(files: ISandboxFile[]): string[] {
    const res: string[] = [];
    for (let file of files) {
      try {
        const content = this.fs.readFileSync(file.path);
        if (content !== file.code) {
          res.push(file.path);
        }
      } catch (err) {
        // file does not exist
      }
      this.fs.writeFile(file.path, file.code);
    }
    return res;
  }

  async compile(files: ISandboxFile[]): Promise<() => any> {
    if (!this.preset) {
      throw new BundlerError('Cannot compile before preset has been initialized');
    }

    this.onStatusChangeEmitter.fire('installing-dependencies');

    // TODO: Have more fine-grained cache invalidation for the resolver
    // Reset resolver cache
    this.resolverCache = new Map();
    this.fs.resetCache();

    let changedFiles: string[] = [];
    if (!this.isFirstLoad) {
      logger.debug('Started incremental compilation');

      changedFiles = this.writeNewFiles(files);

      if (!changedFiles.length) {
        logger.debug('Skipping compilation, no changes detected');
        return () => {};
      }

      // If it's a change and we don't have any hmr modules we simply reload the application
      if (!this.hasHMR) {
        logger.debug('HMR is not enabled, doing a full page refresh');
        window.location.reload();
        return () => {};
      }
    } else {
      for (let file of files) {
        this.fs.writeFile(file.path, file.code);
      }
    }

    if (changedFiles.length) {
      const promises = [];
      for (let changedFile of changedFiles) {
        const module = this.getModule(changedFile);
        if (module) {
          module.resetCompilation();
          promises.push(this.transformModule(changedFile));
        }
      }
      await Promise.all(promises);
    }

    const pkgJsonChanged = changedFiles.find((f) => f === '/package.json');
    if (this.isFirstLoad || pkgJsonChanged) {
      logger.debug('Loading node modules');
      await this.processPackageJSON();

      const depString = Object.entries(this.parsedPackageJSON?.dependencies || {})
        .map((v) => `${v[0]}:${v[1]}`)
        .sort()
        .join(',');

      if (this._previousDepString != null && depString !== this._previousDepString) {
        logger.debug('Dependencies changed, reloading');
        location.reload();
        return () => {};
      }

      this._previousDepString = depString;

      await this.loadNodeModules();
    }

    // AINative tree-shaking fix (issue builder-ainative-studio#1089). Runs
    // on EVERY compile (not gated to cold-load-only like loadNodeModules
    // above) -- an HMR edit that adds a new named import from a barrel
    // package must widen that package's allowed-names set even though
    // loadNodeModules() itself only runs again on a package.json change.
    //
    // MUST be awaited here, blocking the entry-point walk below, despite
    // a real, measured performance cost on apps that import no
    // barrel-shaped package at all (see collectAppBarrelUsage()'s doc
    // comment -- Builder's shared getBuiltinFiles() bundle alone is
    // ~109 files that must be scanned regardless of what the app itself
    // imports, which can add real seconds on an app with nothing to
    // tree-shake). A non-blocking version of this (fire this off, let
    // the entry-point walk start concurrently, only await a
    // barrelUsagePromise inside BabelTransformer.transform() when it's
    // about to read barrelUsage for a node_modules file) was tried and
    // REVERTED after finding a real correctness bug: Module.compile()'s
    // own dependency walk (_transformModule in THIS file) short-circuits
    // on `module.compiled != null` (see that method) with NO knowledge
    // of barrelUsagePromise at all -- so on an HMR update that widens a
    // barrel's allowed names, the entry-point walk can reach and
    // short-circuit-return the STALE, narrower-trimmed barrel module
    // before this method's own widen-detection ever gets a chance to run
    // (it only runs after collectAppBarrelUsage's OWN promise resolves,
    // which races the walk, not something ordered against it). Confirmed
    // live: a widened icon import rendered "Element type is invalid...
    // got: undefined" -- a real, silent runtime breakage, strictly worse
    // than the performance problem this was trying to fix. Blocking here
    // is what guarantees barrelUsage (and any resulting widen-reset) is
    // fully settled before ANY module -- app or node_modules -- can
    // possibly reach a stale cached result through transformModule's
    // short-circuit. See collectAppBarrelUsage()'s own doc comment for
    // the mitigations that ARE safe (bounded concurrency, a cheap
    // presence pre-filter, a lighter parse-only config, and a
    // content-hash cache that makes every compile after the first one in
    // a session near-free) -- none of which relax this ordering
    // guarantee, only the raw cost of honoring it.
    const previousBarrelUsage = this.barrelUsage;
    this.barrelUsagePromise = this.collectAppBarrelUsage(files).then(() => {
      // If a node_modules file was already compiled (and therefore
      // cached as "compiled" on its Module, see Module.ts's compiled !=
      // null short-circuit) under a DIFFERENT allowed-names set than this
      // compile just computed, that cached compile is stale -- it may be
      // missing a re-export the current compile's own code needs.
      //
      // AINative fix (issue builder-ainative-studio#1126): originally
      // this only checked for WIDENING (newSet has a name oldSet
      // lacks), on the reasoning that this bundler's `Bundler` instance
      // (and therefore `this.modules`/`this.barrelUsage`) is reused
      // across compiles ONLY within one app's own HMR session, where a
      // narrower-than-before set can never happen (an app's own source
      // only ever gains imports between HMR edits in the cases this
      // fork actually triggers a recompile for, never loses the need
      // for an import that was already working). That reasoning does
      // NOT hold in production: `SandpackInstance` (src/index.ts)
      // constructs exactly one `Bundler` per iframe, and that SAME
      // iframe is reused by Builder across entirely unrelated
      // companies' previews, one after another -- not just across HMR
      // edits of a single app. When company B's own barrel usage is not
      // a strict superset of whatever company A (the previous occupant
      // of that same iframe/Bundler) left cached -- e.g. B needs a
      // DIFFERENT set of lucide-react icons than A did, not a wider
      // one -- `widened` was false, this loop skipped resetting the
      // stale module, and B's `import {...} from 'lucide-react'`
      // resolved against A's wrongly-trimmed compiled output, silently
      // missing exports B's own code actually needs. That missing
      // export becomes `undefined` at the import site, and React throws
      // "Element type is invalid... got: undefined" -- confirmed live,
      // reproducibly, on multiple real companies sharing a bundler
      // instance (beacon, dwello, foresight, pathlo, shortlist, silo,
      // clearpath -- see the issue for the live reproduction). Checking
      // set INEQUALITY instead of only superset-widening closes this
      // gap while changing nothing about the HMR case this block was
      // originally written for: a same-app HMR edit that only ever
      // widens still takes the exact same reset path as before (an
      // inequality check is a strict generalization of the previous
      // superset-only check, never a narrower one), and the reset
      // itself (resetForWidenedBarrelUsage(), below) was already fully
      // generic -- it clears this file's stale compiled output and
      // re-queues its transform with no HMR-dirty flag and no reload,
      // regardless of whether the allowed-names set grew, shrank, or
      // simply changed to a different, same-size set; nothing in it
      // assumes the change was specifically a widening.
      for (const [path, newNames] of this.barrelUsage) {
        if (newNames === 'ALL') continue;
        const oldNames = previousBarrelUsage.get(path);
        if (oldNames === 'ALL') continue;
        const newSet = new Set(newNames);
        const oldSet = new Set(oldNames ?? []);
        const changed =
          newSet.size !== oldSet.size || Array.from(newSet).some((n) => !oldSet.has(n));
        if (!changed) continue;

        const existingModule = this.modules.get(path);
        if (!existingModule) continue;

        // Only reset a module that was ACTUALLY run through a real
        // babel.transform() with the now-stale (differently-trimmed)
        // allowed-names set applied -- never one that's merely sitting
        // in this.modules as
        // ModuleRegistry's precompiled placeholder (every node_modules
        // file gets one of those pre-seeded by loadModuleDependencies(),
        // with compiled set directly to raw, never-transformed source --
        // see module-registry/index.ts's _writePrecompiledModule and
        // this fork's correctness note on ICDNModuleFile.t/d always
        // being false/[] -- so compiled != null alone does NOT mean
        // "really transformed" for a node_modules file). A real
        // transform is the only thing that ever populates dependencyMap
        // (via Module.addDependency, called from Module.compile(); the
        // placeholder's own addDependency calls are no-ops here because
        // its file.d is always empty) -- so a non-empty dependencyMap is
        // a safe, correct signal that this module was genuinely compiled
        // with (possibly stale) barrel trimming, not just pre-seeded.
        if (existingModule.dependencyMap.size === 0) continue;

        // Module.resetForWidenedBarrelUsage(), not resetCompilation() --
        // see that method's doc comment. resetCompilation() would
        // unconditionally reload the whole page here (this node_modules
        // file never has its own HMR context), turning a normal
        // app-level HMR update into a disruptive full reload every time
        // a widen is detected. Confirmed via a live regression test
        // before this fix: an app importing one more lucide-react icon
        // than its previous compile rendered blank after an HMR update,
        // because the reload raced the in-flight compile.
        // resetForWidenedBarrelUsage() clears this file's stale compiled
        // output and re-queues its transform without disturbing the
        // app-level HMR path at all.
        existingModule.resetForWidenedBarrelUsage();
      }
    });
    await this.barrelUsagePromise;

    this.onStatusChangeEmitter.fire('transpiling');

    // Transform runtimes
    if (this.isFirstLoad) {
      for (const runtime of this.runtimes) {
        await this.transformModule(runtime);
        await this.moduleFinishedPromise(runtime);
      }
    }

    // Resolve entrypoints
    const resolvedEntryPoint = await this.resolveEntryPoint();
    logger.debug('Resolved entrypoint:', resolvedEntryPoint);

    // Transform entrypoint and deps
    const entryModule = await this.transformModule(resolvedEntryPoint);
    await this.moduleFinishedPromise(resolvedEntryPoint);
    logger.debug('Bundling finished, manifest:');
    logger.debug(this.modules);

    entryModule.isEntry = true;

    const transpiledModules = Array.from(this.modules, ([name, value]) => {
      return {
        /**
         * TODO: adds trailing for backwards compatibility
         */
        [name + ':']: {
          source: {
            isEntry: entryModule.filepath === value.filepath,
            fileName: value.filepath,
            compiledCode: value.compiled,
          },
        },
      };
    }).reduce((prev, curr) => {
      return { ...prev, ...curr };
    }, {});

    this.messageBus.sendMessage('state', { state: { transpiledModules } });

    return () => {
      // Evaluate
      logger.debug('Evaluating...');

      if (this.isFirstLoad) {
        for (const runtime of this.runtimes) {
          const module = this.modules.get(runtime);
          if (!module) {
            throw new BundlerError(`Runtime ${runtime} is not defined`);
          } else {
            logger.debug(`Loading runtime ${runtime}...`);
            module.evaluate();
          }
        }

        entryModule.evaluate();
        this.isFirstLoad = false;
      } else {
        this.modules.forEach((module) => {
          if (module.hot.hmrConfig?.isDirty()) {
            module.evaluate();
          }
        });

        // TODO: Validate that this logic actually works...
        // Check if any module has been invalidated, because in that case we need to
        // restart evaluation.
        const invalidatedModules = Object.values(this.modules).filter((m: Module) => {
          if (m.hot.hmrConfig?.invalidated) {
            m.resetCompilation();
            this.transformModule(m.filepath);
            return true;
          }

          return false;
        });

        if (invalidatedModules.length > 0) {
          return this.compile(files);
        }
      }
    };
  }

  // TODO: Support template languages...
  getHTMLEntry(): string {
    const foundHTMLFilepath = ['/index.html', '/public/index.html'].find((filepath) => this.fs.isFileSync(filepath));

    if (foundHTMLFilepath) {
      return this.fs.readFileSync(foundHTMLFilepath);
    } else {
      if (!this.preset) {
        throw new BundlerError('Bundler has not been initialized with a preset');
      }
      return this.preset.defaultHtmlBody;
    }
  }

  replaceHTML() {
    const html = this.getHTMLEntry() ?? '<div id="root"></div>';
    if (this.lastHTML) {
      if (this.lastHTML !== html) {
        window.location.reload();
      }
      return;
    } else {
      this.lastHTML = html;
      replaceHTML(html);
    }
  }
}
