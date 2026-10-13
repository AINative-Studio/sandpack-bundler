import { decode as decodeMsgPack } from '@msgpack/msgpack';
import urlJoin from 'url-join';

import { retryFetch } from '../../utils/fetch';
import { DepMap } from '.';

/**
 * AINative fork notice (issue #1073, builder-ainative-studio):
 *
 * Upstream codesandbox/sandpack-bundler's module-cdn.ts talked to
 * `https://sandpack-cdn-staging.blazingly.io/` via a `/dep_tree/{b64}` +
 * `/package/{b64}` protocol (CDN_VERSION=5, custom `btoa("5(" + json + ")")`
 * encoding, response shape `IResolvedDependency[]` / `ICDNModule{f,m}`).
 *
 * That domain is NOT part of any codesandbox-owned infra we could find
 * (no codesandbox.io subdomain, no ownership signal beyond this one
 * hardcoded string — verified live 2026-10-13: it resolves, Fly+Cloudflare
 * fronted, and genuinely answers with real msgpack dependency data in the
 * exact shape this file expects) and is NOT the same API as the *actual*
 * public, Apache-2.0 codesandbox/sandpack-cdn repo we forked for #1071,
 * which only exposes a different v2 protocol:
 *   GET /v2/deps/{base64(pkg@range;pkg2@range2;...)} -> ResolutionsMap
 *     (msgpack map: { [pkgName]: "resolvedVersion" })
 *   GET /v2/mod/{base64(pkg@version)} -> FileMap
 *     (msgpack map: { [filePath]: rawFileBytes })
 *
 * We are NOT depending on the unverified blazingly.io host. This file is
 * now a thin protocol adapter: it keeps fetchManifest/fetchModule's exact
 * exported signatures and return shapes (so NodeModule.ts, index.ts, and
 * everything else in this bundler is untouched), but internally speaks
 * sandpack-cdn's real v2 routes against our own self-hosted deployment.
 *
 * Correctness note on ICDNModuleFile.t (isTranspiled): sandpack-cdn's
 * /v2/mod/ route (src/router/routes_v2/route_mod.rs -> download_package_
 * content) serves RAW npm package file bytes with no transpile step
 * anywhere in that Rust service. Claiming t:true here would tell this
 * bundler's own Module pipeline (see module-registry/index.ts's
 * _writePrecompiledModule, which constructs `new Module(path, file.c,
 * true, ...)` when t is true) to SKIP transpilation of content that was
 * never transpiled -- a silent correctness bug, not an optimization. We
 * always set t:false so the bundler's own transform step still runs, and
 * d:[] (no reliable per-file transient-dependency list from sandpack-cdn)
 * so the bundler discovers imports itself during that transform, exactly
 * as t:false signals it to do.
 */

/** Configurable origin for our self-hosted sandpack-cdn fork (issue #1071).
 *  Falls back to a loopback dev default; MUST be overridden in any real
 *  deployment via this global before the bundler boots. */
declare global {
  interface Window {
    __AINATIVE_SANDPACK_CDN_URL__?: string;
  }
}

function getCdnRoot(): string {
  if (typeof window !== 'undefined' && window.__AINATIVE_SANDPACK_CDN_URL__) {
    return window.__AINATIVE_SANDPACK_CDN_URL__;
  }
  // Placeholder until #1071 posts its real deployed URL -- intentionally
  // loopback so a misconfigured deployment fails fast and loudly (connection
  // refused) instead of silently hitting someone else's infrastructure.
  return 'http://localhost:8080/';
}

export interface IResolvedDependency {
  // name
  n: string;
  // version
  v: string;
  // depth
  d: number;
}

/** sandpack-cdn's actual /v2/deps/ response shape: a flat map of
 *  resolved package name -> exact version string (BTreeMap<String,
 *  Version> in dep_tree_builder.rs, serde-encoded as a plain object). */
type SandpackCdnResolutionsMap = Record<string, string>;

/** sandpack-cdn's actual /v2/mod/ response shape: a flat map of file
 *  path -> raw file bytes (HashMap<String, Vec<u8>> in
 *  package_content.rs). msgpack decodes byte-vec values as Uint8Array. */
type SandpackCdnFileMap = Record<string, Uint8Array>;

/** sandpack-cdn's base64 query encoding is plain base64 of a
 *  semicolon-joined "name@range" list (see route_deps.rs's parse_query /
 *  decode_base64) -- NOT the versioned "N(json)" scheme the upstream
 *  blazingly.io protocol used. Browser-safe base64 (btoa on a UTF-8 string
 *  requires escaping for non-Latin1 chars; package specifiers are ASCII
 *  so plain btoa is safe here). */
function encodeDepsQuery(deps: DepMap): string {
  const parts = Object.entries(deps).map(([name, range]) => `${name}@${range}`);
  return btoa(parts.join(';'));
}

function encodeModSpecifier(name: string, version: string): string {
  return btoa(`${name}@${version}`);
}

/** retryFetch (../../utils/fetch) retries on 408/429/424/499/444/502/503/
 *  504/599 up to maxRetries times, but has NO per-attempt timeout -- a
 *  hung connection to a flaky CDN would hang each attempt indefinitely,
 *  which is exactly the bug class this whole project exists to fix.
 *
 * We do NOT pass a single shared AbortController into retryFetch's own
 * retryOpts: retryFetch retries by recursing internally, and a single
 * controller's signal is permanently aborted after it fires once --
 * every subsequent internal retry attempt would see an already-aborted
 * signal and fail instantly, turning "5 retries with a fresh timeout
 * each" into "1 real attempt, then 4 guaranteed-instant failures". That
 * would silently defeat the retry count this function is given.
 *
 * Instead, each call to fetchWithTimeout IS one full attempt (its own
 * fresh AbortController + timeout), and WE drive the retry loop here,
 * calling retryFetch with maxRetries:0 (no retrying inside a single
 * attempt) so every one of our outer attempts gets its own full timeout
 * window. */
const CDN_FETCH_TIMEOUT_MS = 15000;

async function fetchOnceWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_FETCH_TIMEOUT_MS);
  try {
    return await retryFetch(url, { maxRetries: 0, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(
  url: string,
  retryOpts: { maxRetries: number; retryDelay?: number }
): Promise<Response> {
  const { maxRetries, retryDelay = 500 } = retryOpts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchOnceWithTimeout(url);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }
  throw lastErr;
}

export async function fetchManifest(deps: DepMap): Promise<IResolvedDependency[]> {
  const encodedQuery = encodeDepsQuery(deps);
  const url = urlJoin(getCdnRoot(), `/v2/deps/${encodedQuery}`);
  const result = await fetchWithTimeout(url, { maxRetries: 5, retryDelay: 1000 });
  const buffer = await result.arrayBuffer();
  const resolutions = decodeMsgPack(buffer) as SandpackCdnResolutionsMap;

  // Adapt sandpack-cdn's flat {name: version} map into this bundler's
  // expected IResolvedDependency[] shape. sandpack-cdn's resolver doesn't
  // report per-package depth in the tree (it returns only the final
  // resolution, not the resolution path) -- depth is used elsewhere in
  // this bundler only as a priority/ordering hint for preloadModules'
  // Promise.all, which has no ordering dependency on depth being accurate,
  // so a constant 0 is a correct (if less optimized) value, not a
  // correctness bug.
  return Object.entries(resolutions).map(([n, v]) => ({ n, v, d: 0 }));
}

export type CDNModuleFileType = ICDNModuleFile | number;

export interface ICDNModuleFile {
  // content
  c: string;
  // dependencies
  d: string[];
  // is transpiled
  t: boolean;
}

export interface ICDNModule {
  // files
  f: Record<string, CDNModuleFileType>;
  // transient dependencies
  m: string[];
}

// Non-strict TextDecoder silently substitutes U+FFFD replacement
// characters for invalid byte sequences rather than throwing -- decoding
// a genuinely binary file (a .node native binding, a font, an image
// bundled inside an npm package) through it would corrupt the bytes
// without any error signal. ICDNModule.files[path].c is typed `string`
// throughout this bundler (Module's constructor takes `source: string`)
// -- there is no binary-file path in this bundler's module pipeline at
// all, upstream included. sandpack-cdn's own /v2/mod/ route (route_mod.rs
// -> download_package_content) returns EVERY file in the npm tarball
// verbatim with no filtering, unlike whatever CodeSandbox's actual
// hosted pipeline does internally (not public, so its exact behavior
// here can't be confirmed) -- so unlike the original blazingly.io
// integration, this adapter cannot assume upstream already filtered
// binaries out before they reach us. A strict decoder throws instead of
// silently corrupting; genuinely binary files are skipped (never handed
// into the bundler as corrupted "source") rather than crashing the whole
// module fetch over one unused binary asset most packages don't even
// reference from their JS entry points.
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true });

export async function fetchModule(name: string, version: string): Promise<ICDNModule> {
  const encodedSpecifier = encodeModSpecifier(name, version);
  const url = urlJoin(getCdnRoot(), `/v2/mod/${encodedSpecifier}`);
  const result = await fetchWithTimeout(url, { maxRetries: 5 });
  const buffer = await result.arrayBuffer();
  const rawFiles = decodeMsgPack(buffer) as SandpackCdnFileMap;

  const files: Record<string, ICDNModuleFile> = {};
  for (const [path, bytes] of Object.entries(rawFiles)) {
    let content: string;
    try {
      content = strictTextDecoder.decode(bytes);
    } catch {
      // Genuinely binary (fatal:true threw) -- skip rather than hand
      // corrupted "source" into the bundler's transform pipeline. If
      // something actually imports this file, that import will fail to
      // resolve with a clear "module not found"-class error instead of
      // a silent, hard-to-diagnose content-corruption bug.
      continue;
    }
    files[path] = {
      c: content,
      d: [],
      // See file header: always false. sandpack-cdn serves raw, untranspiled
      // source -- claiming true here would skip this bundler's own
      // transform step on content that still needs it.
      t: false,
    };
  }

  // sandpack-cdn's /v2/mod/ doesn't report transient (second-order)
  // dependencies separately from the package's own package.json -- this
  // bundler's dependency walk (ModuleRegistry.fetchManifest, called with
  // the full flattened dep set up front) already resolves the full tree,
  // so an empty transient-modules list here is correct: nothing downstream
  // relies on this field to discover additional packages beyond what
  // fetchManifest already resolved.
  return { f: files, m: [] };
}
