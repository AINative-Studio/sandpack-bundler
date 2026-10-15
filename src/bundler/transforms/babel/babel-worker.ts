import type { PluginItem } from '@babel/core';
import * as babel from '@babel/standalone';

import * as logger from '../../../utils/logger';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { ITranspilationResult } from '../Transformer';
import { loadPlugin, loadPreset } from './babel-plugin-registry';
import { BarrelAllowedNames, barrelAwarePlugin } from './barrel-usage';
import { collectDependencies } from './dep-collector';

export interface ITransformData {
  code: string;
  filepath: string;
  config: any;
  /** AINative tree-shaking fix (issue builder-ainative-studio#1089). See
   *  barrel-usage.ts's doc comment for the full design. When set (only
   *  ever for a node_modules file bundler.ts has identified as a barrel
   *  whose usage is fully known), the barrel-trimming plugin runs on this
   *  transform call and removes `export { X } from './y'` specifiers
   *  whose exported name isn't in this list. Omitted (undefined) means
   *  "transform exactly as before this fix" -- the only way this field
   *  ever affects output is by REMOVING re-export statements this fix can
   *  prove are unused; it never changes any other statement. */
  barrelAllowedNames?: BarrelAllowedNames;
}

function getNameFromConfigEntry(entry: any): string | null {
  if (typeof entry === 'string') {
    return entry;
  } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
    return entry[0];
  } else {
    return null;
  }
}

// TODO: Normalize preset names
//
// AINative fork notice (issue builder-ainative-studio#1082): `useBuiltIns:
// 'usage'` + `corejs: '3.22'` makes @babel/preset-env SCAN EVERY FILE for
// syntax/APIs that need a core-js polyfill and INJECT A REAL IMPORT of the
// matching core-js submodule when it finds one. That's the right thing to
// do for the app's OWN source (written for a modern target, may still use
// e.g. Array.prototype.flat on an old browserslist target) -- but it is
// never correct for a file already inside /node_modules/: that code is
// published, already-built npm package output. Re-scanning it for
// "needs a polyfill" on every compile:
//   1. Is semantically wrong -- a package author already decided its own
//      compat story (ship pre-polyfilled, ship modern-only, bundle its own
//      core-js, etc.); the bundler silently overriding that with ITS OWN
//      opinion is not how any real bundler (webpack, esbuild, Vite, the
//      stock CodeSandbox bundler this fork replaces) treats node_modules.
//   2. Is a real, measured performance bug: every npm package compiled
//      through this path pulls in a SEPARATE transitive dependency on
//      core-js (3.22.7 alone ships 3003 files per the real sandpack-cdn
//      payload), and this bundler's dependency walker
//      (bundler.ts _transformModule) has no tree-shaking -- it transforms
//      every file core-js's own barrel reaches, for every package, on
//      every compile. Confirmed live: a trivial app importing a single
//      lucide-react icon (whose own ESM barrel separately re-exports all
//      ~1436 icons, a related but distinct issue) took ~30s wall-clock to
//      compile with this config, via a real Railway-deployed instrumented
//      build (handleCompile:start -> evaluate:success span, see PR
//      description) -- comfortably past Builder's 15s SandpackResilientTimeout
//      watchdog, so Sandpack never finishes before Builder falls back to the
//      legacy flattened-Babel iframe. That's the actual "renders blank
//      against the self-hosted bundler, same code renders fine against the
//      stock CodeSandbox bundler" symptom this issue reports.
//
// Fix: skip useBuiltIns/corejs injection for anything under /node_modules/.
// Scoped, safe, and matches the precedent this file already sets for
// node_modules-specific transform behavior (see `compact:
// /node_modules/.test(filepath)` below in transform()). This does not fully
// eliminate the lucide-react-class barrel-reexport cost (a deeper,
// CJS-runtime-model-constrained issue -- see this PR's description) but it
// removes a large, unconditional, always-present contributor (core-js)
// that applies on every single compile regardless of what the app actually
// imports.
async function getPresets(presets: any, isNodeModule: boolean): Promise<PluginItem[]> {
  const result: PluginItem[] = [
    [
      'env',
      isNodeModule
        ? {
            targets: '> 2.5%, not ie 11, not dead, not op_mini all',
            useBuiltIns: false,
            exclude: ['@babel/plugin-transform-regenerator'],
          }
        : {
            targets: '> 2.5%, not ie 11, not dead, not op_mini all',
            useBuiltIns: 'usage',
            corejs: '3.22',
            exclude: ['@babel/plugin-transform-regenerator'],
          },
    ],
    'typescript',
  ];
  if (!Array.isArray(presets)) {
    return result;
  }
  for (const preset of presets) {
    const presetName = getNameFromConfigEntry(preset);
    if (presetName !== null) {
      if (!babel.availablePresets[presetName]) {
        babel.availablePresets[presetName] = await loadPreset(presetName);
      }

      const foundIndex = result.findIndex((v) => getNameFromConfigEntry(v) === presetName);
      if (foundIndex > -1) {
        result[foundIndex] = preset;
        continue;
      }
    }
    result.push(preset);
  }
  return result;
}

// TODO: Normalize plugin names
async function getPlugins(plugins: any): Promise<PluginItem[]> {
  const result: PluginItem[] = [];
  if (!Array.isArray(plugins)) {
    return result;
  }
  for (const plugin of plugins) {
    const pluginName = getNameFromConfigEntry(plugin);
    if (pluginName !== null) {
      if (!babel.availablePlugins[pluginName]) {
        babel.availablePlugins[pluginName] = await loadPlugin(pluginName);
      }

      const foundIndex = result.findIndex((v) => getNameFromConfigEntry(v) === pluginName);
      if (foundIndex > -1) {
        result[foundIndex] = plugin;
        continue;
      }
    }
    result.push(plugin);
  }
  return result;
}

// AINative perf-profiling instrumentation (issue builder-ainative-studio#1089).
// Temporary: real wall-clock breakdown of where transform() time actually
// goes, per call -- preset/plugin resolution vs. the babel.transform() call
// itself vs. total. Reported back over the existing debug channel so it is
// visible from the host page (the worker's own console is not reachable
// from outside the iframe). Guarded by a global flag so it's a no-op unless
// explicitly enabled -- never runs in normal operation.
declare const self: any;
let PROFILE_ENABLED = false;
let __profileBuf: any[] = [];
function profileLog(entry: any) {
  if (!PROFILE_ENABLED) return;
  __profileBuf.push(entry);
  if (__profileBuf.length >= 25) {
    flushProfile();
  }
}
function flushProfile() {
  if (!PROFILE_ENABLED || __profileBuf.length === 0) return;
  const batch = __profileBuf;
  __profileBuf = [];
  try {
    (self as any).postMessage({ channel: 'sandpack-profile', entries: batch });
  } catch {
    // best-effort only
  }
}
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (evt: any) => {
    if (evt?.data?.channel === 'sandpack-profile-enable') {
      PROFILE_ENABLED = true;
    }
  });
  // Bounded periodic flush (not unbounded -- fixed 500ms cadence, buffer
  // capped at 25 entries above) so a compile with < 25 transformed files
  // still reports its profile data instead of sitting in the buffer forever.
  setInterval(() => flushProfile(), 500);
}

// AINative perf fix (issue builder-ainative-studio#1089): content-addressed
// transform cache.
//
// Real profiling (see this PR's description for full numbers) found the
// dominant cost compiling a barrel-exporting package like lucide-react is
// NOT any specific misconfigured transform (preset/plugin setup measured
// at <1ms/call) -- it's the sheer VOLUME of babel.transform() calls, most
// of them on tiny node_modules files that are byte-identical on every
// single compile: our self-hosted sandpack-cdn always serves raw,
// never-pre-transpiled bytes (see module-cdn.ts's correctness note on
// ICDNModuleFile.t), so this bundler's dependency walker pays the full
// Babel cost for every node_modules file on every compile, with no reuse
// across compiles even when the input is identical. A single real compile
// of a trivial one-icon app made ~1455 babel.transform() calls; 1405 of
// those were on lucide-react's individual icon files averaging ~620 bytes
// each but ~19ms apiece of call overhead, summing to ~26s alone.
//
// Fix: cache the full transform RESULT (code + discovered dependency set
// -- both are required downstream; dependencies drive Module.compile's
// addDependency walk, see Module.ts) keyed by a hash of the exact input
// (code + filepath's node_modules-ness + a digest of the resolved
// presets/plugins config). Node_modules source is immutable per package
// version, so the mapping (code, config) -> (compiledCode, dependencies)
// is pure and safe to memoize for the lifetime of this worker -- which
// lives for one bundler/iframe instance (one Sandpack preview session),
// not across page loads, so there is no staleness risk from a package
// version changing between sessions.
//
// Bounded, not unbounded: a plain Map would grow without limit across a
// long editing session (HMR recompiles constantly touch the same
// node_modules files, which is exactly the case this cache targets, but a
// pathological session importing many huge/distinct packages over time
// could otherwise accumulate indefinitely). CACHE_MAX_ENTRIES caps entry
// count with simple FIFO eviction (oldest inserted key dropped first) --
// not true LRU, but sufficiently effective here since the hot set (the
// current app's actual dependency graph, typically a few hundred files at
// most) is far smaller than the cap, so eviction in practice only trims
// truly cold entries from a prior, now-abandoned dependency graph.
const CACHE_MAX_ENTRIES = 4000;
const transformCache = new Map<string, ITranspilationResult>();

// Fast, non-cryptographic string hash (FNV-1a, 32-bit). This is a cache
// key, not a security boundary -- collision resistance only needs to be
// "good enough to not matter in practice for a few thousand entries",
// and FNV-1a is dramatically cheaper than crypto.subtle.digest (no
// async round-trip, no Promise overhead per call -- which would itself
// reintroduce a per-call tax against the exact problem this cache
// exists to remove).
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Also fold in length -- fnv1a over very different strings that happen
  // to collide in the 32-bit space is already astronomically unlikely,
  // but length gives a second cheap discriminant for near-free extra
  // safety margin.
  return (hash >>> 0).toString(36) + ':' + str.length;
}

function cacheKeyFor(
  code: string,
  filepath: string,
  isNodeModule: boolean,
  config: any,
  barrelAllowedNames: BarrelAllowedNames | undefined
): string {
  // Only the parts of `config` that actually affect output need to be in
  // the key. In practice config is static per isNodeModule bucket (see
  // getPresets/getPlugins above), so isNodeModule is almost always
  // sufficient on its own -- but a caller-supplied config.presets/plugins
  // array is cheap to fold in too, and doing so makes this correct even
  // if that assumption ever stops holding, rather than relying on it.
  const configDigest = config ? fnv1a(JSON.stringify(config)) : 'noconfig';
  // AINative tree-shaking fix (issue #1089): barrelAllowedNames changes
  // this transform's OUTPUT (which re-export statements survive), so it
  // MUST be part of the cache key -- otherwise a later compile (e.g. an
  // HMR recompile after the app's imports changed, or simply a different
  // real app in a different preview session reusing a still-warm worker)
  // could serve a trim computed for a DIFFERENT app's narrower import set
  // against this one, silently resolving a real import to undefined. An
  // unsorted array is intentionally normalized (sorted) before hashing so
  // the same logical set in a different collection order still hits the
  // same cache entry.
  const barrelDigest =
    barrelAllowedNames === undefined
      ? 'nobarrel'
      : barrelAllowedNames === 'ALL'
        ? 'all'
        : fnv1a(Array.from(barrelAllowedNames).sort().join(','));
  return `${isNodeModule ? '1' : '0'}|${configDigest}|${barrelDigest}|${fnv1a(code)}|${filepath.slice(filepath.lastIndexOf('/') + 1)}`;
}

async function transform({
  code,
  filepath,
  config,
  barrelAllowedNames,
}: ITransformData): Promise<ITranspilationResult> {
  const t0 = PROFILE_ENABLED ? performance.now() : 0;
  const isNodeModule = /node_modules/.test(filepath);

  // Only cache node_modules files. App source is actively edited (HMR),
  // so caching it would need invalidation machinery for no real benefit
  // -- the volume problem this cache targets is entirely in node_modules
  // (1454/1455 and 1513/1514 of all transform calls in the two real
  // profiling runs backing this fix were on node_modules files).
  const cacheKey = isNodeModule ? cacheKeyFor(code, filepath, isNodeModule, config, barrelAllowedNames) : null;
  if (cacheKey) {
    const cached = transformCache.get(cacheKey);
    if (cached) {
      // transformCache only ever stores the success shape (see the write
      // site below -- a BundlerError is never cached), so this cast is
      // safe.
      const typed = cached as { code: string; dependencies: Set<string> };
      if (PROFILE_ENABLED) {
        const t1 = performance.now();
        profileLog({
          filepath,
          isNodeModule,
          codeLen: code.length,
          presetsSetupMs: 0,
          babelTransformMs: 0,
          totalMs: +(t1 - t0).toFixed(3),
          numRequires: typed.dependencies.size,
          cacheHit: true,
        });
      }
      // Sets are mutable and this cache value may be returned to many
      // callers -- hand back a fresh Set each time so one caller mutating
      // its result (nothing in this bundler currently does, but Module.ts
      // only reads it via Array.from/iteration, so this is a defensive
      // copy, not a workaround for an observed bug) can never corrupt the
      // cached entry for the next hit.
      return { code: typed.code, dependencies: new Set(typed.dependencies) };
    }
  }

  const requires: Set<string> = new Set();
  const presets = await getPresets(config?.presets ?? [], isNodeModule);
  const plugins = await getPlugins(config?.plugins ?? []);
  // AINative tree-shaking fix (issue #1089): the barrel-trimming visitor
  // MUST run before preset-env's own commonjs-module transform converts
  // `export { X } from './y'` into a require() call -- plugins and
  // presets merge into one traversal and plugins' visitors fire first on
  // the way down (confirmed empirically, see this fix's PR description),
  // so pushing it into `plugins` (not `presets`) here, same as
  // collectDependencies below, is what makes a removed specifier never
  // become a require() at all, rather than removing a require() after the
  // fact (which dep-collector would already have recorded).
  if (barrelAllowedNames !== undefined) {
    plugins.push(barrelAwarePlugin({ allowedNames: barrelAllowedNames }));
  }
  plugins.push(collectDependencies(requires));
  const t1 = PROFILE_ENABLED ? performance.now() : 0;
  const transformed = babel.transform(code, {
    filename: filepath,
    presets,
    plugins,
    // no ast needed for now
    ast: false,
    sourceMaps: 'inline',
    compact: isNodeModule,
  });
  const t2 = PROFILE_ENABLED ? performance.now() : 0;

  if (PROFILE_ENABLED) {
    profileLog({
      filepath,
      isNodeModule,
      codeLen: code.length,
      presetsSetupMs: +(t1 - t0).toFixed(3),
      babelTransformMs: +(t2 - t1).toFixed(3),
      totalMs: +(t2 - t0).toFixed(3),
      numRequires: requires.size,
      cacheHit: false,
    });
  }

  // no-op module
  if (!transformed.code) {
    transformed.code = 'module.exports = {};';
  }

  const result: ITranspilationResult = {
    code: transformed.code,
    dependencies: requires,
  };

  if (cacheKey) {
    if (transformCache.size >= CACHE_MAX_ENTRIES) {
      // FIFO eviction: Map iteration order is insertion order, so the
      // first key is the oldest. O(1) amortized, no extra bookkeeping
      // structure needed.
      const oldestKey = transformCache.keys().next().value;
      if (oldestKey !== undefined) {
        transformCache.delete(oldestKey);
      }
    }
    transformCache.set(cacheKey, result);
  }

  return result;
}

export interface ICollectImportsData {
  code: string;
  filepath: string;
  // No `config` field -- unlike `transform()`, this never needs the real
  // per-filetype preset/plugin config (see collectImports()'s doc
  // comment below for why that was tried and reverted after a measured
  // regression). A fixed, minimal `typescript` + `react` preset pair
  // parses any real JS/JSX/TS/TSX syntax this bundler's presets support
  // today (both the react and solid presets only ever register
  // `babel-transformer` for js/jsx/ts/tsx files -- see ReactPreset.ts/
  // SolidPreset.ts's mapTransformers()).
}

export interface ICollectImportsResult {
  /** Plain-object wire format: specifier -> ('ALL' | string[] of named
   *  bindings used). See barrel-usage.ts. */
  usage: Record<string, BarrelAllowedNames>;
}

// AINative tree-shaking fix (issue builder-ainative-studio#1089): a
// separate, lightweight worker RPC used ONLY during bundler.ts's
// pre-pass (collectAppBarrelUsage, called once per cold compile, before
// any node_modules file is transformed). Deliberately NOT reusing
// `transform` with some "collect-only" flag bolted on: this method never
// needs a content-hash cache (app files aren't immutable across a
// session, see babel-worker.ts's existing node_modules-only caching
// rationale above) and never needs to report `requires`/dependencies --
// keeping it a separate, minimal function makes both of those omissions
// structural rather than something a future edit could accidentally
// break by sharing code with the real transform path.
//
// Deliberately uses a MUCH lighter config than getPresets()/getPlugins()
// (the real transform's config) -- a real regression was found and fixed
// here: the pre-pass runs over EVERY file bundler.compile() is given,
// which for a real Builder app includes not just the app's own ~10-15
// files but the full getBuiltinFiles() shared shadcn/AIKit bundle
// (~109 JS/TS-like files, confirmed live) -- 100+ EXTRA dispatches
// through the SAME small (POOL_SIZE=4) worker pool the real compile's
// own node_modules transforms are racing to finish through, all fired
// essentially simultaneously via collectAppBarrelUsage's Promise.all
// BEFORE the entry-point walk even starts. Measured regression on a real
// app (T1i-e_AP3tK-LP6X16XJ2): baseline ~11.5-12s, this fix with the
// FULL real-transform config for collectImports ~14-17.5s -- slower than
// never tree-shaking at all, reproducible across 4 back-to-back runs.
// The real `env`/`typescript`/`react` preset pipeline this pre-pass was
// originally reusing exists to produce CORRECT RUNTIME OUTPUT (ES target
// lowering, JSX runtime wiring) -- none of which this pre-pass needs: it
// only ever reads `path.node.source`/`path.node.specifiers` off
// already-parsed AST nodes, which requires PARSING the file's real
// syntax (JSX, TypeScript types) but never requires LOWERING or
// generating output code. Dropping `env` (the expensive preset -- it's
// what does broad per-file bugfix/feature-detection AST scanning) and
// requesting `ast: true, code: false` (skip codegen entirely) measured
// ~3.5x faster per call in isolation and removes the only genuinely
// heavy preset from this path, while keeping the exact same visitor,
// same AST node shapes, same correctness.
async function collectImports({ code, filepath }: ICollectImportsData): Promise<ICollectImportsResult> {
  const sink = new Map<string, BarrelAllowedNames>();
  try {
    babel.transform(code, {
      filename: filepath,
      presets: ['typescript', ['react', { runtime: 'automatic' }]],
      plugins: [barrelAwarePlugin({ sink })],
      ast: true,
      code: false,
      sourceMaps: false,
    });
  } catch (err) {
    // A file that fails to parse during this pre-pass will also fail to
    // parse during its REAL compile later -- that failure surfaces
    // normally and correctly there (as a real compilation error the app
    // author sees), via the existing, unrelated error path. Silently
    // skipping it here (empty usage) rather than throwing is correct and
    // safe: this pre-pass exists only to make the tree-shaking narrower
    // for files that parse fine, never to gate whether compilation can
    // proceed -- that gate is the real compile step, untouched by this
    // fix.
    return { usage: {} };
  }
  return { usage: Object.fromEntries(sink) };
}

new WorkerMessageBus({
  channel: 'sandpack-babel',
  endpoint: self,
  handleNotification: () => Promise.resolve(),
  handleRequest: (method, data) => {
    switch (method) {
      case 'transform':
        return transform(data);
      case 'collectImports':
        return collectImports(data);
      default:
        return Promise.reject(new Error('Unknown method'));
    }
  },
  handleError: (err) => {
    logger.error(err);
    return Promise.resolve();
  },
  timeoutMs: 30000,
});
