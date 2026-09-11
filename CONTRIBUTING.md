# Contributing to FortMesa Saferoom

FortMesa, Inc. remains the copyright holder of this project. FortMesa
Saferoom is licensed under the [Apache License, Version 2.0](LICENSE).

## Developer Certificate of Origin (sign-off required)

Every commit must include a `Signed-off-by` trailer, added automatically
with the `-s` flag:

```
git commit -s -m "your message"
```

This is a certification that you wrote the change (or otherwise have the
right to submit it) under the terms of the [Developer Certificate of
Origin](https://developercertificate.org/), and that you license your
contribution under this project's license (Apache-2.0) so it can be
distributed and relicensed as part of the project. Pull requests without
a sign-off will not be merged.

## Running tests

```
yarn install
yarn test
```

`yarn test` is the whole gate: format check, lint, a clean rebuild, then every
suite. Run it before you open a pull request. CI runs `yarn lint`,
`yarn type-check` and `yarn test:unit` as separate steps, so a green `yarn test`
covers all three.

The steps are still available individually when you want a faster loop:
`yarn format:check`, `yarn lint`, `yarn test:unit`.

Tests live in `test/**/*.test.mjs` and run against the built output in `dist/`,
so a suite imports `../../dist/registry/thing.js` rather than the TypeScript
source. `yarn test:unit` rebuilds first. Add a new file anywhere under `test/`
and the glob picks it up; nothing needs registering.

## Code of conduct

Contributors are expected to engage respectfully and in good faith. See
your organization's standard code of conduct if one applies to this
repository's context; absent a separate document, ordinary professional
conduct norms apply.
