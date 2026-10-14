import type { PluginItem } from '@babel/core';
import * as babel from '@babel/standalone';

import * as logger from '../../../utils/logger';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { ITranspilationResult } from '../Transformer';
import { loadPlugin, loadPreset } from './babel-plugin-registry';
import { collectDependencies } from './dep-collector';

export interface ITransformData {
  code: string;
  filepath: string;
  config: any;
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

async function transform({ code, filepath, config }: ITransformData): Promise<ITranspilationResult> {
  const requires: Set<string> = new Set();
  const isNodeModule = /node_modules/.test(filepath);
  const presets = await getPresets(config?.presets ?? [], isNodeModule);
  const plugins = await getPlugins(config?.plugins ?? []);
  plugins.push(collectDependencies(requires));
  const transformed = babel.transform(code, {
    filename: filepath,
    presets,
    plugins,
    // no ast needed for now
    ast: false,
    sourceMaps: 'inline',
    compact: isNodeModule,
  });

  // no-op module
  if (!transformed.code) {
    transformed.code = 'module.exports = {};';
  }

  return {
    code: transformed.code,
    dependencies: requires,
  };
}

new WorkerMessageBus({
  channel: 'sandpack-babel',
  endpoint: self,
  handleNotification: () => Promise.resolve(),
  handleRequest: (method, data) => {
    switch (method) {
      case 'transform':
        return transform(data);
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
