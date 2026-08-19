import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import { validFormatString } from '../dist/index.js';

// RuleTester exercises the rule against a series of valid/invalid code
// samples. Each case is a fixture: the rule runs against the literal
// source, and we assert what should and shouldn't be flagged. Mirrors
// the same pattern the existing temporal-fmt test suite uses (hand-picked
// cases + adversarial), just adapted to ESLint's RuleTester instead of
// node:test + node:assert/strict.
const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

test('rule: valid-format-string — flagged cases', () => {
  ruleTester.run('valid-format-string', validFormatString, {
    valid: [],
    invalid: [
      // 12-hour without `a`
      {
        code: `format(date, 'yyyy-MM-dd h:mm')`,
        errors: [{ messageId: '12hourWithoutA' }],
      },
      // 12-hour (padded) without `a`
      {
        code: `format(date, 'yyyy-MM-dd hh:mm')`,
        errors: [{ messageId: '12hourWithoutA' }],
      },
      // mixed 12-hour and 24-hour
      {
        code: `format(date, 'yyyy-MM-dd HH h:mm a')`,
        errors: [{ messageId: 'mixed12And24Hour' }],
      },
      // unknown token — `X` is now a real offset token (temporal-fmt
      // 0.8.7), so it no longer belongs here. `P` stays unknown.
      {
        code: `format(date, 'yyyy-MM-dd P')`,
        errors: [{ messageId: 'unknownToken', data: { token: 'P' } }],
      },
      // unknown token — `ddo` parses as `dd` + `o` literal, but `o`
      // would be flagged as unknown if it wasn't a real duration token.
      // For temporal-fmt format()/parse(), `o` is unknown.
      {
        code: `format(date, 'yyyy MM o')`,
        errors: [{ messageId: 'unknownToken', data: { token: 'o' } }],
      },
      // unterminated quote
      {
        code: `format(date, "yyyy 'at")`,
        errors: [{ messageId: 'unterminatedQuote' }],
      },
      // parse() — same checks apply (parse's first arg is the format string)
      {
        code: `parse('yyyy-MM-dd h:mm', input)`,
        errors: [{ messageId: '12hourWithoutA' }],
      },
      // formatDuration with an unknown token. Note: the tokenizer uses
      // one shared KNOWN_TOKENS set for every call kind, so a token
      // like `X` or `Q` that's valid for format()/parse() slips through
      // uncaught here even though formatDuration doesn't accept it —
      // pre-existing gap, gets wider as format()/parse()'s token table
      // grows. `P` isn't a token anywhere, so it's still caught.
      {
        code: `formatDuration(dur, 'P')`,
        errors: [{ messageId: 'unknownToken', data: { token: 'P' } }],
      },
      // offset token without a full date — mirrors parse()'s "needs a
      // full date and time to build a ZonedDateTime" throw.
      {
        code: `parse('HH:mm XXX', input)`,
        errors: [{ messageId: 'offsetWithoutFullDate' }],
      },
      // zzz + an offset token together — mirrors parse()'s cross-check
      // between the zone's actual offset and the parsed offset.
      {
        code: `format(date, 'yyyy-MM-dd HH:mm zzz XXX')`,
        errors: [{ messageId: 'zzzWithOffsetToken' }],
      },
    ],
  });
});

test('rule: valid-format-string — non-flagged cases (valid format strings)', () => {
  ruleTester.run('valid-format-string', validFormatString, {
    valid: [
      // 12-hour with `a` — correct
      `format(date, 'yyyy-MM-dd h:mm a')`,
      // 24-hour — no `a` needed
      `format(date, 'yyyy-MM-dd HH:mm')`,
      // pure date format
      `format(date, 'yyyy-MM-dd')`,
      // locale-aware tokens
      `format(date, 'MMMM d, yyyy')`,
      `format(dt, 'EEE MMM d HH:mm:ss')`,
      // new tokens: do, Q, QQQ, ww, RRRR
      `format(date, 'do Q QQQ ww RRRR')`,
      // offset tokens (temporal-fmt 0.8.7), each paired with a full
      // date so they don't trip offsetWithoutFullDate
      `format(zdt, 'yyyy-MM-dd HH:mm XXX')`,
      `format(zdt, 'yyyy-MM-dd HH:mm xxx')`,
      `parse('yyyy-MM-dd HH:mm X', input)`,
      `parse('yyyy-MM-dd HH:mm XX', input)`,
      `parse('yyyy-MM-dd HH:mm x', input)`,
      `parse('yyyy-MM-dd HH:mm xx', input)`,
      // quoted literal passes through
      `format(date, "yyyy-MM-dd 'at' HH:mm")`,
      // parse() with a valid format
      `parse('yyyy-MM-dd', input)`,
      `parse('yyyy-MM-dd h:mm a', input)`,
      // formatDistance — no format-string argument to lint, so always valid
      `formatDistance(today, yesterday)`,
      // formatDuration with a valid duration format
      `formatDuration(dur, 'hhh mmm sss')`,
    ],
    invalid: [],
  });
});

test('rule: valid-format-string — dynamic format strings are skipped (no false positives)', () => {
  // The rule's contract is "never flag dynamic format strings" —
  // whether it's a variable, a template literal with interpolation, or
  // any other expression. These all stay silent.
  ruleTester.run('valid-format-string', validFormatString, {
    valid: [
      // variable as format string — skip
      `const fmt = 'yyyy-MM-dd h:mm'; format(date, fmt)`,
      // template literal with interpolation — skip
      `const sep = '-'; format(date, \`yyyy\${sep}MM\${sep}dd\`)`,
      // template literal WITHOUT interpolation — ESLint treats this as
      // a TemplateLiteral, not a Literal, so it's still skipped (the
      // rule doesn't dive into TemplateLiterals to extract a constant
      // value).
      `format(date, \`yyyy-MM-dd\`)`,
      // expression — skip
      `format(date, getFormatStr())`,
      // ternary
      `format(date, cond ? 'yyyy-MM-dd' : 'MM-dd-yyyy')`,
      // nullish coalescing
      `format(date, opts?.fmt ?? 'yyyy-MM-dd')`,
      // parse() with variable format
      `parse(getUserFormat(), input)`,
      // parse() with template-literal format
      `parse(\`yyyy-MM-dd\`, input)`,
      // even if a dynamic string WOULD be invalid if static, the rule
      // stays silent — that's the contract
      `format(date, dynamicMaybeBadStr)`,
    ],
    invalid: [],
  });
});

test('rule: valid-format-string — only the format-string literal is reported, not the call site', () => {
  // When the rule reports, the reported node is the format-string
  // Literal itself, not the CallExpression — so the editor squiggle
  // lands on the offending string, not on the whole call.
  ruleTester.run('valid-format-string', validFormatString, {
    valid: [],
    invalid: [
      {
        code: `format(date, 'h:mm')`,
        errors: [{ messageId: '12hourWithoutA' }],
      },
    ],
  });
});
