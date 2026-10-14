import * as logger from '../../utils/logger';
import evaluate from './eval';
import { HotContext } from './hot';
import { Module } from './Module';

class EvaluationContext {
  exports: any;
  globals: any;
  hot: HotContext;
  id: string;

  constructor(evaluation: Evaluation) {
    this.exports = {};
    this.globals = {};
    this.hot = evaluation.module.hot;
    this.id = evaluation.module.id;
  }
}

export class Evaluation {
  module: Module;
  context: EvaluationContext;

  // AINative fix (issue builder-ainative-studio#1089, 2026-10-14): split
  // construction from running the module body.
  //
  // Real bug, confirmed live: a genuine Builder app importing from
  // `recharts` hit `RangeError: Maximum call stack size exceeded` and a
  // ~38s compile, traced to victory-vendor's `d3-interpolate/src/value.js`
  // and `array.js`, which require each other (a completely normal,
  // Node-safe circular CommonJS require). The bug was here: the old code
  // ran the ENTIRE module body (`evaluate(...)`, which can itself call
  // back into `require` for every dependency) inside this constructor,
  // and only Module.evaluate() assigned the finished Evaluation instance
  // to `module.evaluation` -- AFTER the constructor returned. So while
  // value.js's body was still running and hit `require('./array.js')`,
  // array.js's `module.evaluation` was still null (its own constructor,
  // reached via the same circular chain, hadn't returned yet either) --
  // Module.evaluate()'s short-circuit (`if (this.evaluation) return
  // this.evaluation`) never fired, so every require around the cycle
  // created a brand-new Evaluation and re-ran the module body from
  // scratch, recursing until the call stack blew up. This is exactly the
  // failure mode Node's own module system exists to prevent: a circular
  // require must return the (possibly still-incomplete) `module.exports`
  // of the module already in progress, never re-execute it.
  //
  // Fix: register `this` as `module.evaluation` in the constructor BEFORE
  // running the module body (moved to a separate `run()` step, called
  // from Module.evaluate() right after the assignment). A circular
  // require landing back on an in-progress module now hits the existing
  // `this.evaluation` and returns its (partially populated, exactly as
  // real Node CJS semantics guarantee) `context.exports` instead of
  // re-entering. Zero change to non-circular require behavior --
  // `context.exports` is the same live object either way, just populated
  // incrementally as the body runs instead of all at once before anyone
  // can see it.
  constructor(module: Module) {
    this.module = module;
    this.context = new EvaluationContext(this);
  }

  run(): void {
    const code = this.module.compiled + `\n//# sourceURL=${location.origin}${this.module.filepath}`;
    this.context.exports = evaluate(code, this.require.bind(this), this.context, {}, {});
  }

  require(specifier: string): any {
    const moduleFilePath = this.module.dependencyMap.get(specifier);
    if (!moduleFilePath) {
      logger.debug('Require', {
        dependencies: this.module.dependencyMap,
        specifier,
      });

      throw new Error(`Dependency "${specifier}" not collected from "${this.module.filepath}"`);
    }
    const module = this.module.bundler.getModule(moduleFilePath);
    if (!module) {
      throw new Error(`Module "${moduleFilePath}" has not been transpiled`);
    }
    return module.evaluate().context.exports ?? {};
  }
}
