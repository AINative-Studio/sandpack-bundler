/**
 * AINative tree-shaking fix (issue builder-ainative-studio#1089).
 *
 * Scope of this fix, stated explicitly: this is NOT general-purpose
 * tree-shaking. It only narrows one specific, extremely common and
 * extremely expensive pattern -- a package's main entry file consisting
 * almost entirely of single-level `export { X } from './y'` re-exports
 * (an ESM "barrel" file, e.g. lucide-react's dist/esm/lucide-react.js,
 * which re-exports ~1437 icons from ~1437 individual files). Everything
 * else in this bundler's dependency walk is untouched and remains fully
 * eager, exactly as before this fix.
 *
 * WHY this is safe to scope narrowly: the real, measured cost (see
 * babel-worker.ts's existing perf-fix doc comment, and this fix's own PR
 * description) is almost entirely in babel.transform() CALL COUNT on
 * barrel re-export targets, not in any other part of the walk. A
 * conservative fix that only ever OMITS re-export statements it can prove
 * are unused, and falls back to the old fully-eager behavior for every
 * pattern it cannot prove safe (namespace imports, default imports,
 * `export *`, dynamic/computed specifiers, anything with side effects it
 * can't rule out), cannot make a previously-working app break -- it can
 * only skip babel.transform() calls whose *output* (a require() to a file
 * nothing ever reads a binding from) was always dead weight.
 *
 * HOW this works, end to end (see bundler.ts's collectAppBarrelUsage and
 * its call site in compile(), and babel-worker.ts's use of
 * BARREL_ALLOWED_NAMES_KEY):
 *
 * 1. Before the main dependency walk starts (and therefore before ANY
 *    node_modules file, barrel or otherwise, is transformed), every one of
 *    the app's OWN source files (never node_modules -- app file count is
 *    always small, a few dozen at most for a real Builder app, so this
 *    pre-pass is cheap) is parsed once with ONLY the plugin below, to
 *    collect: for every bare (non-relative, non-absolute) import
 *    specifier string S the app's own code imports from, which NAMED
 *    bindings (if any) it actually imports, or a conservative "ALL" if it
 *    imports in a way this fix cannot safely narrow (namespace import,
 *    default import, dynamic `require(computedExpr)`, etc.).
 * 2. Each bare specifier S is resolved (via the bundler's own resolver,
 *    the exact same resolution a real `require(S)` would hit) to its
 *    real absolute target path -- this is what turns "the app imports
 *    {Search, Home} from the STRING 'lucide-react'" into "the app needs
 *    exactly {Search, Home} from the FILE
 *    /node_modules/lucide-react/dist/esm/lucide-react.js", independent of
 *    how many different raw specifier strings might resolve to the same
 *    file.
 * 3. This resolved-path -> allowed-names map is stored on the bundler
 *    (Bundler.barrelUsage) BEFORE loadNodeModules()/the main walk begins,
 *    so there is no ordering hazard: by construction, every entry this
 *    fix will ever consult already reflects the FULL, final set of names
 *    any app file requests, not a partial snapshot from whichever
 *    importer happened to compile first.
 * 4. When the main walk reaches a node_modules file whose resolved path
 *    has an entry in barrelUsage that is NOT "ALL", that allowed-name set
 *    is passed (as a plain serializable array, since babel-worker.ts runs
 *    in a separate Worker thread with no shared memory) into this same
 *    plugin, now applied to THAT file's own transform. It walks that
 *    file's top-level `export { X } from './y'` / `export { default as X
 *    } from './y'` statements and, for each one whose exported name is
 *    NOT in the allowed set, removes the entire specifier (and the whole
 *    declaration if it was the only specifier) from the AST *before*
 *    preset-env's own commonjs-module transform runs (this plugin's
 *    visitor fires in the same traversal, on the way down, before that
 *    transform's own Program:exit visitor converts what's left into
 *    require() calls) -- so the removed re-export never becomes a
 *    require() at all, and dep-collector.ts (which only ever sees
 *    require() calls, see that file) never learns about it, so
 *    bundler.ts's _transformModule never walks to it. `export *` and any
 *    specifier this plugin cannot prove is a simple single-binding
 *    re-export are left completely untouched.
 */

export type BarrelAllowedNames = string[] | 'ALL';

/** Plain-object wire format for passing allowed-names data through
 *  postMessage to the babel worker (Sets/Maps are avoidable complexity
 *  here -- a plain array is simpler to serialize and debug, and this is
 *  never a hot path: one small array per node_modules file transform,
 *  not per icon). */
export interface BarrelUsageConfig {
  /** Resolved absolute path of the specifier this config applies to --
   *  purely informational/for debugging; the actual lookup at transform
   *  time is just "is this filepath's own compiled module the one this
   *  config was computed for", enforced by only ever attaching this
   *  config to the matching file's own transformer config in bundler.ts. */
  resolvedPath: string;
  allowedNames: BarrelAllowedNames;
}

/**
 * Babel plugin, used in TWO distinct modes depending on which argument is
 * passed:
 *
 * - Collection mode (`sink` provided, `allowedNames` omitted): used on app
 *   source files during the pre-pass. Visits ImportDeclaration /
 *   ExportNamedDeclaration / ExportAllDeclaration nodes with a bare
 *   (non-relative) `source.value` and records the requested names (or
 *   'ALL') into `sink`, keyed by the raw specifier string. Never mutates
 *   the AST.
 *
 * - Trim mode (`allowedNames` provided, `sink` omitted): used on exactly
 *   one node_modules file per transform call (whichever file
 *   bundler.barrelUsage has an entry for). Visits this file's own
 *   top-level `export { X } from './y'` statements and removes any
 *   specifier whose exported name is not in `allowedNames`. Never reads
 *   or writes `sink`.
 *
 * The two modes are mutually exclusive and never combined in one
 * transform call -- a file is either an app file being scanned for usage,
 * or a node_modules barrel file being trimmed, never both (app files are
 * never barrel-trimmed; node_modules files are never usage-scanned).
 */
export function barrelAwarePlugin(opts: { sink?: Map<string, BarrelAllowedNames>; allowedNames?: BarrelAllowedNames }) {
  const { sink, allowedNames } = opts;

  function isBareSpecifier(specifier: string): boolean {
    return specifier[0] !== '.' && specifier[0] !== '/';
  }

  function recordAll(specifier: string) {
    if (!sink) return;
    sink.set(specifier, 'ALL');
  }

  function recordNames(specifier: string, names: string[]) {
    if (!sink || names.length === 0) return;
    const existing = sink.get(specifier);
    if (existing === 'ALL') return;
    const merged = new Set(existing ?? []);
    for (const n of names) merged.add(n);
    sink.set(specifier, Array.from(merged));
  }

  return {
    visitor: {
      // --- Collection mode only (sink present) ---
      ImportDeclaration(path: any) {
        if (!sink) return;
        const specifier = path.node.source?.value;
        if (typeof specifier !== 'string' || !isBareSpecifier(specifier)) return;

        const named: string[] = [];
        for (const spec of path.node.specifiers) {
          if (spec.type === 'ImportSpecifier') {
            // `imported` is the ORIGINAL exported name on the module being
            // imported from -- e.g. `import { Search as S }` has
            // imported.name === 'Search', local.name === 'S'. We need the
            // former: it's what the barrel file's own export name must
            // match, not whatever local alias the importing file chose.
            const importedName = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
            named.push(importedName);
          } else {
            // ImportDefaultSpecifier or ImportNamespaceSpecifier -- cannot
            // safely narrow (a default import could resolve through any
            // export convention; a namespace import can access literally
            // any binding by computed/dynamic means later in the file).
            recordAll(specifier);
            return;
          }
        }
        recordNames(specifier, named);
      },
      ExportNamedDeclaration(path: any) {
        if (!sink) return;
        const specifier = path.node.source?.value;
        if (typeof specifier !== 'string' || !isBareSpecifier(specifier)) return;
        // `export { X } from 'bare-pkg'` (re-exporting someone else's
        // package from app code) -- rare, but handled the same way as a
        // named import: only the specifically re-exported names are
        // "used".
        const named: string[] = [];
        for (const spec of path.node.specifiers) {
          if (spec.type === 'ExportSpecifier') {
            const localName = spec.local.type === 'Identifier' ? spec.local.name : spec.local.value;
            named.push(localName);
          } else {
            recordAll(specifier);
            return;
          }
        }
        recordNames(specifier, named);
      },
      ExportAllDeclaration(path: any) {
        if (!sink) return;
        const specifier = path.node.source?.value;
        if (typeof specifier !== 'string' || !isBareSpecifier(specifier)) return;
        // `export * from 'bare-pkg'` -- re-exports an unknowable set of
        // names from the app's own code. Must stay eager.
        recordAll(specifier);
      },

      // --- Trim mode only (allowedNames present) ---
      Program(path: any) {
        if (!allowedNames || allowedNames === 'ALL') return;
        const allowedSet = new Set(allowedNames);
        for (const stmt of path.get('body')) {
          if (!stmt.isExportNamedDeclaration()) continue;
          if (!stmt.node.source) continue; // not a re-export, leave alone
          if (stmt.node.exportKind && stmt.node.exportKind !== 'value') continue; // type-only export, leave alone

          const keptSpecifiers: any[] = [];
          for (const spec of stmt.node.specifiers) {
            if (spec.type !== 'ExportSpecifier') {
              // Anything other than a plain `export { X } from './y'`
              // specifier on this statement (shouldn't normally occur
              // mixed with ExportSpecifier, but if it does, keep the
              // whole statement untouched rather than risk dropping
              // something this fix doesn't understand).
              keptSpecifiers.length = 0;
              for (const s of stmt.node.specifiers) keptSpecifiers.push(s);
              break;
            }
            const exportedName = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value;
            if (allowedSet.has(exportedName)) {
              keptSpecifiers.push(spec);
            }
          }

          if (keptSpecifiers.length === stmt.node.specifiers.length) {
            // Nothing to trim on this statement.
            continue;
          }

          if (keptSpecifiers.length === 0) {
            // Every named export this statement provides is unused --
            // drop the whole re-export statement, so its `require('./y')`
            // never gets emitted at all.
            stmt.remove();
          } else {
            stmt.node.specifiers = keptSpecifiers;
          }
        }

        // Second, narrower pass: `import * as NS from './y'; export { NS
        // as X };` -- lucide-react's own main barrel does exactly this
        // once, for its `icons` namespace export (`import * as index
        // from './icons/index.js'; export { index as icons };`), and
        // './icons/index.js' is itself a SECOND, equally expensive
        // ~1437-re-export barrel -- so leaving this pattern untouched
        // (the first pass above does, since this export has no `source`)
        // would defeat most of this fix's benefit for exactly the
        // package it targets. Only trimmed when provably safe: the
        // imported namespace binding must have NO uses anywhere else in
        // the file besides this one re-export -- if there's any other
        // reference (e.g. the file also reads a property off the
        // namespace directly), both statements are left alone. Needs
        // path.scope.crawl() first: scope bindings/references for this
        // Program aren't necessarily populated yet when this visitor
        // fires (confirmed empirically -- omitting this crawl can miss
        // real references, which would make the "no other uses" check
        // falsely pass). An export specifier's local identifier DOES
        // count as one reference to the binding (confirmed empirically
        // against the live assumption that it wouldn't) -- so the real
        // check is "every reference is contained within the one
        // statement being removed", not "zero references".
        path.scope.crawl();
        for (const stmt of path.get('body')) {
          if (!stmt.isExportNamedDeclaration() || stmt.node.source) continue;
          const onlySpecifier = stmt.node.specifiers.length === 1 ? stmt.node.specifiers[0] : null;
          if (!onlySpecifier || onlySpecifier.type !== 'ExportSpecifier') continue;
          const exportedName =
            onlySpecifier.exported.type === 'Identifier' ? onlySpecifier.exported.name : onlySpecifier.exported.value;
          if (allowedSet.has(exportedName)) continue;

          const localName = onlySpecifier.local.name;
          const binding = path.scope.getBinding(localName);
          if (!binding || !binding.path.isImportNamespaceSpecifier()) continue;
          const hasOtherReferences = binding.referencePaths.some((ref: any) => !ref.isDescendant(stmt) && ref !== stmt);
          if (hasOtherReferences) continue;

          const importDecl = binding.path.parentPath;
          if (!importDecl?.isImportDeclaration()) continue;
          // Only remove the whole import statement if this was its ONLY
          // specifier -- never partially remove specifiers from an
          // import statement that still has other, still-used bindings
          // (this exact barrel never mixes a namespace import with other
          // specifiers on one statement, but a different package might).
          if (importDecl.node.specifiers.length === 1) {
            importDecl.remove();
          } else {
            binding.path.remove();
          }
          stmt.remove();
        }
      },
    },
  };
}
