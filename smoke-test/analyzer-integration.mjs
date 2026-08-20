// Phase 3 analyzer-integration smoke test for the ESLint plugin.
// Exercises the rule against representative format strings, confirms
// the analyzer-backed checks surface correctly. Distinct from
// test/validFormatString.test.js (which uses RuleTester) — this one
// calls ESLint directly to surface actual input/output pairs the plan's
// "smoke test everything" step asks for.
import { Linter } from 'eslint';
import plugin from '../dist/index.js';

const linter = new Linter();

function lint(code) {
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { 'temporal-fmt': plugin },
    rules: { 'temporal-fmt/valid-format-string': 'error' },
  });
}

let passed = 0, failed = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`  ✖ ${label}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('ESLint plugin — Phase 3 analyzer integration smoke test');

// Test cases: a representative sample from each section the plan calls out.
// Each entry is { code, expectedMessageIds } where expectedMessageIds is
// the set of messageIds the rule should fire (empty = no findings).
const cases = [
  // Section B — valid format strings, no findings
  { code: `format(date, 'yyyy-MM-dd')`, expectedMessageIds: [] },
  { code: `format(date, 'MMMM d, yyyy')`, expectedMessageIds: [] },
  { code: `format(date, 'yyyy-MM-dd HH:mm:ss')`, expectedMessageIds: [] },
  { code: `format(date, 'yyyy-MM-dd h:mm a')`, expectedMessageIds: [] },
  { code: `format(date, "yyyy-MM-dd 'at' HH:mm")`, expectedMessageIds: [] },
  // Offset tokens with full date — no findings
  { code: `format(zdt, 'yyyy-MM-dd HH:mm XXX')`, expectedMessageIds: [] },
  { code: `parse('yyyy-MM-dd HH:mm X', input)`, expectedMessageIds: [] },
  // format-only tokens are fine for format() — the rule filters them
  { code: `format(date, 'do Q QQQ ww RRRR')`, expectedMessageIds: [] },
  // format-only tokens ARE flagged for parse()
  { code: `parse('yyyy-MM-do', input)`, expectedMessageIds: ['formatOnlyToken'] },

  // Section C — invalid format strings
  { code: `format(date, 'yyyy-MM-dd h:mm')`, expectedMessageIds: ['12hourWithoutA'] },
  { code: `format(date, 'yyyy-MM-dd hh:mm')`, expectedMessageIds: ['12hourWithoutA'] },
  { code: `format(date, 'yyyy-MM-dd HH h:mm a')`, expectedMessageIds: ['mixed12And24Hour'] },
  { code: `format(date, 'yyyy-MM-dd P')`, expectedMessageIds: ['unknownToken'] },
  { code: `format(date, "yyyy 'at")`, expectedMessageIds: ['unterminatedQuote'] },
  { code: `parse('HH:mm XXX', input)`, expectedMessageIds: ['offsetWithoutFullDate'] },
  { code: `format(date, 'yyyy-MM-dd HH:mm zzz XXX')`, expectedMessageIds: ['zzzWithOffsetToken'] },

  // Section E — analyzer-backed checks
  // Adjacent unpadded numeric tokens with no separator — AMBIGUOUS_NUMERIC_RUN
  { code: `format(date, 'yyyy-Md')`, expectedMessageIds: ['ambiguousNumericRun'] },

  // Dynamic format strings — skipped (no false positives)
  { code: `const fmt = 'yyyy-MM-dd h:mm'; format(date, fmt)`, expectedMessageIds: [] },
  { code: 'format(date, `yyyy-MM-dd`)', expectedMessageIds: [] },

  // formatDistance — no format-string argument, never flags
  { code: `formatDistance(today, yesterday)`, expectedMessageIds: [] },
];

for (const { code, expectedMessageIds } of cases) {
  const messages = lint(code);
  const actualMessageIds = messages.map((m) => m.messageId).sort();
  check(code, actualMessageIds, [...expectedMessageIds].sort());
}

console.log(`\nESLint plugin smoke test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
