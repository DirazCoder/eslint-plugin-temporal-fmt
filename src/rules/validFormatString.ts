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
// Phase 3 (plan section AA): the duplicate token table and tokenizer
// that used to live here were replaced with direct imports from
// temporal-fmt's exported analyzer surface. temporal-fmt is declared
// as a runtime dependency in this plugin's package.json, so importing
// it carries no new constraint. See VERIFICATION.md for the rationale
// and the deviation from the prior "lint without temporal-fmt installed"
// claim.

import type { TSESTree } from '@typescript-eslint/utils';
import { analyzeFormat, listTokens, type FormatAnalysis } from 'temporal-fmt';

// Note: the rule is exported as a plain object (the shape ESLint expects),
// not wrapped in ESLintUtils.RuleCreator. RuleCreator is a typed wrapper
// that helps with docs URL generation; for a flat-config ESLint v9 plugin,
// the plain object form is the simplest thing that works and avoids the
// @typescript-eslint/utils peer-dep version constraints getting in the
// way of the actual linting logic.

// Maps analyzeFormat() warning codes to this rule's messageIds. Adding
// a new warning to analyzeFormat() means adding a new entry here (plus
// the corresponding message string in `meta.messages` below). Kept as
// a typed Record so a typo in either direction surfaces at compile time.
const WARNING_CODE_TO_MESSAGE_ID: Record<string, string> = {
  TWELVE_HOUR_WITHOUT_A: '12hourWithoutA',
  MIXED_12_AND_24_HOUR: 'mixed12And24Hour',
  OFFSET_WITHOUT_FULL_DATE: 'offsetWithoutFullDate',
  ZZZ_WITH_OFFSET_TOKEN: 'zzzWithOffsetToken',
  AMBIGUOUS_NUMERIC_RUN: 'ambiguousNumericRun',
  FORMAT_ONLY_TOKEN: 'formatOnlyToken',
  UNKNOWN_TOKEN_NO_METADATA: 'unknownToken',
};

interface TokenPiece {
  kind: 'token' | 'literal' | 'quoted';
  value: string;
}

// The set of known token strings, sourced from temporal-fmt's
// listTokens(). Built once at module load — temporal-fmt's token
// table is static for the lifetime of the process, so caching it
// here is safe. Sorted longest-first so the greedy scan in
// findTokenAt tries "yyyy" before "yy" the same way the runtime
// tokenizer does. This is the single source of truth for "what's a
// token" — the rule no longer carries its own copy.
const SORTED_TOKENS: string[] = listTokens()
  .map((t: { name: string }) => t.name)
  .sort((a: string, b: string) => b.length - a.length);

// Greedy-match the longest token starting at position `i` in `formatStr`.
// Mirrors the runtime tokenizer's longest-first scan. Does NOT do the
// runtime's overlong-run check (where "zzzz" would be flagged as one
// unrecognized run rather than split as "zzz" + "z" literal) — keeping
// the rule's tokenizer matching the original plugin's tokenizer behavior,
// which split overlong runs into a known token + a literal. The literal
// piece then gets flagged by the unknown-letter-run check below if it
// doesn't match any token. Same end result, slightly different mechanism.
function findTokenAt(formatStr: string, i: number): string | undefined {
  for (const tok of SORTED_TOKENS) {
    if (formatStr.startsWith(tok, i)) {
      return tok;
    }
  }
  return undefined;
}

// Walks the format string tracking quoted spans (single quotes,
// doubled-quote escape) so the unknown-letter-run check below can
// skip text the caller explicitly marked as literal. The runtime
// tokenizer in temporal-fmt folds both quoted and unquoted literals
// into the same 'literal' piece because the distinction doesn't
// matter for format()/parse(). Here it does — an unquoted "X" is
// almost certainly a typo, a quoted "X" is intentional.
function tokenizeWithQuoteTracking(formatStr: string): TokenPiece[] | { error: string } {
  const pieces: TokenPiece[] = [];
  let i = 0;
  while (i < formatStr.length) {
    const ch = formatStr[i];
    if (ch === "'") {
      if (formatStr[i + 1] === "'") {
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
      pieces.push({ kind: 'quoted', value: literal });
      i = j;
      continue;
    }
    const matchedToken = findTokenAt(formatStr, i);
    if (matchedToken) {
      pieces.push({ kind: 'token', value: matchedToken });
      i += matchedToken.length;
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

function analyze(formatStr: string, callKind: FormatCallKind): Finding[] {
  const findings: Finding[] = [];

  // For format() / parse(): the date/time token table applies, and
  // temporal-fmt's analyzeFormat() handles all the cross-token checks
  // (12-hour without `a`, mixed 12/24-hour, offset without full date,
  // zzz + offset, format-only tokens, ambiguous numeric runs) for us.
  // For formatDuration(): the duration token table is different
  // (hhh/mmm/sss/etc.), and analyzeFormat would throw on those tokens
  // because the runtime tokenizer doesn't recognize them. So for
  // duration/distance calls we skip analyzeFormat entirely and rely on
  // the unknown-token walk below — which uses temporal-fmt's date/time
  // token table as the "known" set, matching the original plugin's
  // shared-table behavior (a documented pre-existing gap the original
  // plugin's test file already notes).
  if (callKind !== 'formatDuration' && callKind !== 'formatDistance') {
    let analysis: FormatAnalysis;
    try {
      analysis = analyzeFormat(formatStr);
    } catch (err) {
      // analyzeFormat throws on unterminated quotes and length-cap
      // violations. Surface as a syntax-error finding rather than
      // crashing the rule.
      const message = (err as Error).message;
      findings.push({ messageId: 'unterminatedQuote', data: { message } });
      return findings;
    }

    // Map analyzeFormat's warnings to this rule's messageIds. Each warning
    // carries a code; the WARNING_CODE_TO_MESSAGE_ID map above is the
    // single point where new codes get wired up.
    for (const warning of analysis.warnings) {
      const messageId = WARNING_CODE_TO_MESSAGE_ID[warning.code];
      if (!messageId) continue; // unknown warning code — skip rather than guess
      // FORMAT_ONLY_TOKEN fires from analyzeFormat whenever a format-only
      // token (do/ww/RRRR) appears, but format() accepts these fine —
      // only parse() rejects them. Filter the warning for format() calls
      // so the rule doesn't false-positive on a legitimate format-only
      // usage. parse() calls keep the warning.
      if (warning.code === 'FORMAT_ONLY_TOKEN' && callKind === 'format') continue;
      findings.push({ messageId, data: {} });
    }
  }

  // Unrecognized unquoted letter runs — the runtime tokenizer turns
  // these into literals rather than throwing, but they almost always
  // indicate a typo (e.g. `Y` for `y`, `D` for `d`, `P` for `MM`).
  // Runs for both date/time and duration calls — uses temporal-fmt's
  // date/time token table as the "known" set, which is the same
  // shared-table gap the original plugin had (duration tokens aren't
  // in the table, so they slip through uncaught here when called via
  // formatDuration). Documented as a pre-existing gap.
  const pieces = tokenizeWithQuoteTracking(formatStr);
  if ('error' in pieces) {
    findings.push({ messageId: 'unterminatedQuote', data: { message: pieces.error } });
    return findings;
  }
  for (const piece of pieces) {
    if (piece.kind !== 'literal') continue;
    const literal = piece.value;
    let i = 0;
    while (i < literal.length) {
      if (!/[A-Za-z]/.test(literal[i]!)) { i += 1; continue; }
      let j = i + 1;
      while (j < literal.length && /[A-Za-z]/.test(literal[j]!)) j += 1;
      const run = literal.slice(i, j);
      if (!findTokenAt(run, 0)) {
        findings.push({ messageId: 'unknownToken', data: { token: run } });
      }
      i = j;
    }
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
      offsetWithoutFullDate:
        'Offset token ("X"/"XX"/"XXX"/"x"/"xx"/"xxx") used without a full date — parse() needs a complete date and time to build a ZonedDateTime and throws at runtime otherwise.',
      zzzWithOffsetToken:
        'Format string has both "zzz" and an offset token ("X"/"XX"/"XXX"/"x"/"xx"/"xxx") — parse() cross-checks them against each other and throws if the parsed offset disagrees with the zone\'s actual offset. Make sure any input you parse keeps them consistent.',
      ambiguousNumericRun:
        'Adjacent unpadded numeric tokens with no separator can be ambiguous to parse — parse() throws in strict mode. Add a separator or use padded forms (e.g. "MM" instead of "M").',
      formatOnlyToken:
        'Format-only token used — parse() rejects it. Use a parse-capable variant (e.g. "d" instead of "do") if you need round-trip.',
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

        const findings = analyze(formatStr, callKind);
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
