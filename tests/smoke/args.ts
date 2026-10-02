// tests/smoke/args.ts — smoke's command line, parsed strictly (#1956).
//
// A typo must not quietly change what the gate measures: `--model=deepseek/…` or
// `--tag calendar` ignored would run the suite on the dev config's routing, or the whole
// suite, and still print "Gate passed". Unknown flags, `--flag=value` and missing values
// are errors.

export interface SmokeArgs {
  /** Route every agent to this model (the release gate passes the production standard tier). */
  model?: string;
  /** Run cases carrying any of these tags. */
  tags?: string[];
  /** Run cases whose name contains any of these (case-insensitive). Repeatable. */
  cases: string[];
  /** Print every agent's tool calls per case. */
  showCalls: boolean;
  /** Allow a DATABASE_URL that is not on this machine. */
  allowRemoteDb: boolean;
}

const VALUE_FLAGS = new Set(['--model', '--tags', '--case']);
const BOOLEAN_FLAGS = new Set(['--show-calls', '--allow-remote-db']);

export function parseSmokeArgs(argv: string[]): SmokeArgs {
  const args: SmokeArgs = { cases: [], showCalls: false, allowRemoteDb: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag.includes('=')) throw new Error(`write '${flag.split('=')[0]} <value>', not '${flag}'`);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === '--show-calls') args.showCalls = true;
      else args.allowRemoteDb = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`unknown argument '${flag}' — expected --model, --case, --tags, --show-calls or --allow-remote-db`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--model') {
      if (args.model !== undefined) throw new Error('--model given twice');
      args.model = value;
    } else if (flag === '--tags') {
      args.tags = [...(args.tags ?? []), ...value.split(',').map(t => t.trim()).filter(Boolean)];
    } else {
      args.cases.push(value);
    }
  }
  return args;
}
