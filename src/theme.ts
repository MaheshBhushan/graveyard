// One Theme, resolved once from the environment. Nothing downstream in
// render.ts looks at process.stdout/process.env again -- this is the single
// place that decides how output degrades.
//
// Precedence (per T9 spec):
//   1. NO_COLOR set (any value, including empty)      -> no ANSI at all
//   2. not a TTY (piped)                              -> no ANSI, no box
//      drawing / unicode glyphs, no spinner
//   3. TERM=dumb                                      -> ASCII fallback glyphs
//   4. otherwise                                      -> full colour + unicode
//
// --json bypasses this file entirely; it is not a theme.

export interface Theme {
  /** ANSI colour is safe to emit. */
  color: boolean;
  /** Box drawing / status glyphs beyond plain ASCII are safe to emit. */
  unicode: boolean;
  /** Usable columns, already clamped. */
  width: number;
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  width?: number;
}

// Below this, box drawing wraps raggedly -- degrade to compact rows instead.
export const MIN_WIDTH = 20;
export const MAX_WIDTH = 200;
const DEFAULT_WIDTH = 80;

const clamp = (n: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.trunc(n)));

export function resolveTheme(opts: ResolveOptions = {}): Theme {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stdout?.isTTY);
  const dumb = env.TERM === "dumb";

  const color = env.NO_COLOR !== undefined ? false : dumb ? false : isTTY;
  // Piping kills unicode too (no box drawing, no spinner) -- a dumb TERM does
  // the same even on a real TTY.
  const unicode = isTTY && !dumb;

  return { color, unicode, width: resolveWidth(env, opts.width, isTTY) };
}

function resolveWidth(
  env: Record<string, string | undefined>,
  explicit: number | undefined,
  isTTY: boolean,
): number {
  if (explicit !== undefined && Number.isFinite(explicit)) return clamp(explicit);
  const cols = Number(env.COLUMNS);
  if (Number.isFinite(cols) && cols > 0) return clamp(cols);
  const stdout = process.stdout?.columns;
  if (isTTY && Number.isFinite(stdout) && (stdout as number) > 0) return clamp(stdout as number);
  return DEFAULT_WIDTH;
}
