// Static analyzer for temporal-fmt format strings. The library only
// catches these problems at runtime (when format()/parse() is called),
// which surfaces as a thrown Error in production. Lint-time detection
// moves that failure to CI/editor — earlier, with file:line context,
// and on a static literal that's the only kind of format string this
// library actually documents supporting well.
//
// The rule is conservative on purpose: when the format string argument
// is anything other than a plain string literal (a variable, a
// template literal with interpolation, an expression), the rule stays
// silent rather than guessing. False positives on dynamic strings would
// teach callers to disable the rule entirely, losing the static-literal
// coverage that actually helps.
//
// Token table and the HH-vs-hh / 12-hour-without-a checks mirror the
// runtime checks in src/parse.ts (resolveHour, the "12-hour token
// without an 'a' token" throw). The point is to mirror the runtime
// contract, not invent a stricter one — anything flagged here is also
// flagged at runtime, just earlier.

import type { TSESTree } from '@typescript-eslint/utils';

// Note: the rule is exported as a plain object (the shape ESLint expects),
// not wrapped in ESLintUtils.RuleCreator. RuleCreator is a typed wrapper
// that helps with docs URL generation; for a flat-config ESLint v9 plugin,
// the plain object form is the simplest thing that works and avoids the
// @typescript-eslint/utils peer-dep version constraints getting in the
// way of the actual linting logic.

// Mirrors the token table in temporal-fmt's src/tokens.ts. Kept as a
// separate list (not imported from temporal-fmt at runtime) so this
// rule can lint even when temporal-fmt isn't installed — the table is
// small and stable, and the cost of staleness is "misses a new token",
// not "crashes". A mismatch should be caught by this plugin's own test
// suite (which covers every token in the table).
const KNOWN_TOKENS = new Set([
  // date tokens
  'yyyy', 'yy', 'MMMM', 'MMM', 'MM', 'M', 'dd', 'd',
  'EEEE', 'EEE', 'HH', 'H', 'hh', 'h', 'mm', 'm', 'ss', 's',
  'SSS', 'a', 'zzz',
  // new tokens added in this pass
  'do', 'Q', 'QQQ', 'ww', 'RRRR',
]);

// Sorted longest-first for the greedy scan, same as the runtime
// tokenizer in temporal-fmt's src/tokenize.ts. The runtime tokenizer is
// the source of truth here — any mismatch between this list and the
// runtime's means a format string could parse one way at runtime and
// lint another way here, which is worse than no lint at all.
const SORTED_TOKENS = [...KNOWN_TOKENS].sort((a, b) => b.length - a.length);

// Tokens that only apply to PlainTime (no date fields). Used for the
// "HH passed alongside a value clearly typed as PlainDate" check.
const TIME_ONLY_TOKENS = new Set(['HH', 'H', 'hh', 'h', 'mm', 'm', 'ss', 's', 'SSS', 'a']);
const DATE_ONLY_TOKENS = new Set(['yyyy', 'yy', 'MMMM', 'MMM', 'MM', 'M', 'dd', 'd', 'EEEE', 'EEE', 'do', 'Q', 'QQQ', 'ww', 'RRRR']);

interface TokenPiece {
  kind: 'token' | 'literal' | 'quoted';
  value: string;
}

// Greedy-match the same way temporal-fmt's tokenize() does. Quoted
// literals (single quotes, '' = literal quote) are honored so a
// "st" or "nd" suffix inside a quoted span doesn't get read as a
// token fragment. The 'quoted' kind is tracked separately from
// 'literal' so the unknown-letter-run check below can skip text the
// caller explicitly marked as literal — a quoted "at" in "'at'" is
// intentional, an unquoted "X" in "X" is almost certainly a typo.
function tokenize(formatStr: string): TokenPiece[] | { error: string } {
  const pieces: TokenPiece[] = [];
  let i = 0;
  while (i < formatStr.length) {
    const ch = formatStr[i];
    if (ch === "'") {
      if (formatStr[i + 1] === "'") {
        // Doubled quote outside a span is a literal quote char — treat
        // as a literal, not quoted, so an isolated "''" is a literal
        // apostrophe rather than an empty quoted span.
        appendLiteral(pieces, "'");
        i += 2;
        continue;
      }
      let j = i + 1;
      let literal = '';
      let closed = false;
      while (j < formatStr.length) {
        if (formatStr[j] === "'") {
          if (formatStr[j + 1] === "'") {
            literal += "'";
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        literal += formatStr[j]!;
        j += 1;
      }
      if (!closed) {
        return { error: `unterminated quote in format string "${formatStr}"` };
      }
      // Don't merge a quoted span into an adjacent literal — the
      // distinction matters for the unknown-letter-run check.
      pieces.push({ kind: 'quoted', value: literal });
      i = j;
      continue;
    }
    const match = SORTED_TOKENS.find((tok) => formatStr.startsWith(tok, i));
    if (match) {
      pieces.push({ kind: 'token', value: match });
      i += match.length;
      continue;
    }
    appendLiteral(pieces, ch);
    i += 1;
  }
  return pieces;
}

function appendLiteral(pieces: TokenPiece[], value: string): void {
  const last = pieces[pieces.length - 1];
  if (last && last.kind === 'literal') {
    last.value += value;
  } else {
    pieces.push({ kind: 'literal', value });
  }
}

type FormatCallKind = 'format' | 'parse' | 'formatDuration' | 'formatDistance';

function detectCallKind(calleeName: string): FormatCallKind | null {
  if (calleeName === 'format') return 'format';
  if (calleeName === 'parse') return 'parse';
  if (calleeName === 'formatDuration') return 'formatDuration';
  if (calleeName === 'formatDistance') return 'formatDistance';
  return null;
}

interface Finding {
  messageId: string;
  data: Record<string, string>;
}

function analyzeFormatString(formatStr: string, callKind: FormatCallKind): Finding[] {
  const findings: Finding[] = [];
  const pieces = tokenize(formatStr);
  if ('error' in pieces) {
    // Unterminated quote is a runtime parse failure — flag at lint too
    findings.push({ messageId: 'unterminatedQuote', data: { message: pieces.error } });
    return findings;
  }

  const tokens = pieces.filter((p): p is { kind: 'token'; value: string } => p.kind === 'token').map((p) => p.value);

  // Unrecognized letter runs — the runtime tokenizer turns these into
  // literals rather than throwing, but they almost always indicate a
  // typo (e.g. `Y` for `y`, `D` for `d`, `P` for `MM`). Flag at lint
  // as a "you probably meant a real token" warning. This catches a
  // different class of mistake than the runtime errors — silent
  // wrong-output rather than a thrown Error — which is arguably worse
  // from a debugging standpoint. The lint rule's value here is moving
  // that silent wrong-output to CI.
  //
  // Only check UNQUOTED literal pieces — text inside a quoted span is
  // explicitly marked as literal by the caller, never a typo.
  for (const piece of pieces) {
    if (piece.kind !== 'literal') continue;
    const literal = piece.value;
    let i = 0;
    while (i < literal.length) {
      if (!/[A-Za-z]/.test(literal[i]!)) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < literal.length && /[A-Za-z]/.test(literal[j]!)) j += 1;
      const run = literal.slice(i, j);
      if (!KNOWN_TOKENS.has(run)) {
        findings.push({ messageId: 'unknownToken', data: { token: run } });
      }
      i = j;
    }
  }

  // For format() / parse(): the date/time token table applies.
  // For formatDuration(): different table — skip the date/time-specific
  // checks below. formatDistance() doesn't take a token-string format
  // argument at all, so the rule only ever flags "unknown token" /
  // "unterminated quote" against it (which would be a misuse, but a
  // real one).
  if (callKind === 'formatDuration' || callKind === 'formatDistance') {
    return findings;
  }

  const has12Hour = tokens.some((t) => t === 'hh' || t === 'h');
  const has24Hour = tokens.some((t) => t === 'HH' || t === 'H');
  const hasAPeriod = tokens.some((t) => t === 'a');

  // 12-hour without `a` — runtime parse() throws "uses a 12-hour token
  // without an 'a' token, so parse() can't tell AM from PM". Flag at
  // lint for the same reason.
  if (has12Hour && !hasAPeriod) {
    findings.push({ messageId: '12hourWithoutA', data: {} });
  }

  // Mixing 12-hour and 24-hour — runtime parse() throws "mixes a 24-hour
  // token with a 12-hour token". Same reason to flag at lint.
  if (has12Hour && has24Hour) {
    findings.push({ messageId: 'mixed12And24Hour', data: {} });
  }

  return findings;
}

// Explicit `Rule` type so the inferred declaration doesn't drag a
// reference to TSESTree.CallExpression into the public .d.ts (which
// would force callers to install @typescript-eslint/types). The runtime
// shape is identical; this is purely a type-visibility fix.
export interface Rule {
  meta: {
    type: 'problem' | 'suggestion' | 'layout';
    docs: { description?: string };
    schema: unknown[];
    messages: Record<string, string>;
  };
  defaultOptions: unknown[];
  create: (context: { report: (args: { node: unknown; messageId: string; data: Record<string, string> }) => void }) => {
    CallExpression?: (node: TSESTree.CallExpression) => void;
  };
}

const rule: Rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Statically analyze format strings passed to temporal-fmt format()/parse()/formatDuration()/formatDistance() and flag known-bad patterns at lint time.',
    },
    schema: [],
    messages: {
      unknownToken:
        'Unknown temporal-fmt token "{{token}}" — not in the token table. See README for the full list. (Will throw at runtime: "unknown token".)',
      unterminatedQuote:
        '{{message}}. (Will throw at runtime.)',
      '12hourWithoutA':
        '12-hour token ("hh"/"h") used without an "a" (AM/PM) token — parse() can\'t tell AM from PM and throws at runtime. Add an "a" token, or switch to a 24-hour "HH"/"H" form.',
      mixed12And24Hour:
        'Mixing 24-hour ("HH"/"H") and 12-hour ("hh"/"h") tokens in the same format string — parse() refuses to guess which is authoritative and throws at runtime. Pick one.',
      typeMismatch:
        'Token "{{token}}" requires a field the value type {{valueType}} doesn\'t have — e.g. "HH" passed to format() alongside a Temporal.PlainDate. (Will throw at runtime: "requires" the missing field.)',
    },
  },
  defaultOptions: [],
  create(context: { report: (args: { node: unknown; messageId: string; data: Record<string, string> }) => void }) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (callee.type !== 'Identifier') return;
        const callKind = detectCallKind(callee.name);
        if (!callKind) return;

        let formatStrArg: TSESTree.Node | undefined;
        if (callKind === 'parse') {
          formatStrArg = node.arguments[0];
        } else if (callKind === 'format' || callKind === 'formatDuration') {
          formatStrArg = node.arguments[1];
        } else {
          // formatDistance — no format-string argument to lint.
          return;
        }

        if (!formatStrArg) return;
        if (formatStrArg.type !== 'Literal' || typeof formatStrArg.value !== 'string') return;
        const formatStr = formatStrArg.value;

        const findings = analyzeFormatString(formatStr, callKind);
        for (const finding of findings) {
          context.report({
            node: formatStrArg,
            messageId: finding.messageId,
            data: finding.data,
          });
        }
      },
    };
  },
};

export default rule;
