# eslint-plugin-temporal-fmt

Statically analyzes format strings passed to `temporal-fmt`'s `format()`, `parse()`, `formatDuration()`, and `formatDistance()` calls, and flags known-bad patterns at lint time that the library currently only catches at runtime.

temporal-fmt is strict: it throws rather than guessing. That's the right behavior for a date library (silent wrong dates are worse than a thrown Error), but it means bugs surface in production instead of in CI. This plugin moves them to CI.

## Install

```sh
npm install --save-dev eslint-plugin-temporal-fmt eslint
```

Requires ESLint v9+ (flat config). TypeScript 7+ for type-aware features in the rule itself (the rule works on plain JS too — type information isn't required).

## Config

Flat config:

```js
// eslint.config.js
import temporalFmt from 'eslint-plugin-temporal-fmt';

export default [
  temporalFmt.configs.recommended, // turns on temporal-fmt/valid-format-string as 'error'
];
```

Or configure rules individually:

```js
import temporalFmt from 'eslint-plugin-temporal-fmt';

export default [
  {
    plugins: { 'temporal-fmt': temporalFmt },
    rules: {
      'temporal-fmt/valid-format-string': 'error',
    },
  },
];
```

## Rules

### `temporal-fmt/valid-format-string`

Statically analyzes the format-string argument passed to `format()`, `parse()`, `formatDuration()`, and `formatDistance()`. Only string literals are analyzed — variables, template literals, ternaries, and any other expression are skipped silently (the rule never produces a false positive on a dynamic string, since it can't know what the runtime value would be).

What it catches, and the runtime error each rule prevents:

- **12-hour token (`hh`/`h`) without an `a` token** — at runtime, `parse()` throws *"uses a 12-hour token ("hh"/"h") without an "a" token, so parse() can't tell AM from PM"*. Linting catches it earlier.
- **Mixed 12-hour (`hh`/`h`) and 24-hour (`HH`/`H`) in the same format string** — runtime throws *"mixes a 24-hour token ("HH"/"H") with a 12-hour token ("hh"/"h")"*. The rule flags this even when both agree on the same hour, since `parse()` refuses to pick a winner.
- **Unknown tokens** (anything not in temporal-fmt's token table) — runtime throws *"unknown token"* in `format()` and `parse()` alike. Token table mirrors `src/tokens.ts`, including the new `do`/`Q`/`QQQ`/`ww`/`RRRR` tokens.
- **Unterminated quote** in a format string — runtime throws *"unterminated quote in format string"*.

Bad/good pairs:

```js
// BAD — 12-hour without `a`:
format(date, 'yyyy-MM-dd h:mm')
// → lint: 12-hour token ("hh"/"h") used without an "a" (AM/PM) token — parse() can't tell AM from PM and throws at runtime. Add an "a" token, or switch to a 24-hour "HH"/"H" form.

// GOOD — either add `a`, or switch to 24-hour:
format(date, 'yyyy-MM-dd h:mm a')   // 12-hour + AM/PM
format(date, 'yyyy-MM-dd HH:mm')    // 24-hour
```

```js
// BAD — mixed 12-hour and 24-hour:
format(date, 'yyyy-MM-dd HH h:mm a')
// → lint: Mixing 24-hour ("HH"/"H") and 12-hour ("hh"/"h") tokens in the same format string — parse() refuses to guess which is authoritative and throws at runtime. Pick one.

// GOOD — pick one:
format(date, 'yyyy-MM-dd HH:mm')    // 24-hour
format(date, 'yyyy-MM-dd h:mm a')   // 12-hour + AM/PM
```

```js
// BAD — unknown token:
format(date, 'yyyy-MM-dd X')
// → lint: Unknown temporal-fmt token "X" — not in the token table.

// GOOD — only tokens in the table:
format(date, 'yyyy-MM-dd EEEE')  // EEEE is the long weekday
```

```js
// BAD — unterminated quote:
format(date, "yyyy 'at")
// → lint: unterminated quote in format string "yyyy 'at"

// GOOD — close the quote:
format(date, "yyyy 'at' HH:mm")
```

### What the rule doesn't catch (and why)

- **Type mismatches** (e.g. `format(plainDate, 'HH')` — `HH` requires `hour`, which `PlainDate` doesn't have): the rule doesn't have type information available in this pass. Runtime will catch this with the *"requires 'hour', which this Temporal object doesn't have"* error. A type-aware version of this rule could fill the gap; tracked as future work.
- **Anything where the format string isn't a static literal**: variables, template literals with interpolation, ternaries, function calls — all skipped. The rule's contract is "no false positives on dynamic strings", and that's checked by the test suite (`test/validFormatString.test.js` has explicit cases for each dynamic shape).

## Token table (mirrors temporal-fmt's `src/tokens.ts`)

| Token | Meaning |
|-------|---------|
| yyyy | 4-digit year |
| yy | 2-digit year |
| MMMM | full month name |
| MMM | short month name |
| MM | 2-digit month |
| M | month |
| dd | 2-digit day |
| d | day |
| do | ordinal day (1st, 2nd, 3rd...) — format only |
| EEEE | full weekday |
| EEE | short weekday |
| HH | 2-digit hour, 24-hour |
| H | hour, 24-hour |
| hh | 2-digit hour, 12-hour |
| h | hour, 12-hour |
| mm | 2-digit minute |
| m | minute |
| ss | 2-digit second |
| s | second |
| SSS | milliseconds |
| a | AM/PM |
| Q | numeric quarter (1-4) |
| QQQ | "Q" + quarter digit (e.g. "Q3") |
| ww | ISO week number (01-53) — format only |
| RRRR | ISO week-numbering year — format only |
| zzz | IANA time zone id |

`formatDuration()` uses its own token set (single/double/triple letters for each of years/months/weeks/days/hours/minutes/seconds/milliseconds); the rule only flags unknown tokens for that function, since the date/time-specific checks don't apply.

## License

Proprietary — see [LICENSE](./LICENSE). Versions 0.2.1 and earlier remain available under the original MIT License.