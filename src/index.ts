import validFormatString from './rules/validFormatString.js';

// Flat-config plugin export. ESLint v9+ uses flat config exclusively;
// the legacy "configs/recommended" pattern still works but the
// recommended entry below uses the flat shape.
//
// `as const` on each rule helps the type checker keep the inferred type
// narrow (so a caller importing this plugin gets the actual rule shape,
// not a widened object) without dragging in a full ESLint Rule type
// import — which would force this plugin to depend on eslint's
// typescript types just to ship its declaration file. The runtime
// shape is identical either way.
export default {
  meta: {
    name: 'eslint-plugin-temporal-fmt',
    version: '0.1.0',
  },
  rules: {
    'valid-format-string': validFormatString,
  },
  // A recommended config that turns the rule on as 'error'. Flat-config
  // plugins expose this as `eslintPlugin.configs.recommended` so a user
  // can do `import temporalFmt from 'eslint-plugin-temporal-fmt'; ...
  // temporalFmt.configs.recommended` in their flat config file.
  configs: {
    recommended: {
      plugins: ['temporal-fmt'],
      rules: {
        'temporal-fmt/valid-format-string': 'error',
      },
    },
  },
} as const;

export { validFormatString };
