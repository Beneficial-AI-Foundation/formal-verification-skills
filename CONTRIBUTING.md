# Contributing

## Running the tests

`npm test` runs every test file one after another through `scripts/run-tests.cjs` and takes about half
an hour.

- **Build the hooks first.** `npm test` does not build them, and a fresh checkout has no `hooks/dist`.
  Run `npm run build:hooks` once before the first run. Without it about a dozen install tests fail, in
  the codex-coexist, install, local-patches and installed-script-paths test files.
- **Keep the machine awake.** A laptop that sleeps in the middle of a run fails long tests with timeouts
  that have nothing to do with the code. Stay on AC power. On macOS, `caffeinate -is npm test` holds the
  machine awake while it is plugged in; `caffeinate -i` alone does not.
- **Run one test file** with `node --test --test-concurrency=1 tests/<name>.test.cjs`. The suite is
  load-sensitive: a test that fails only when the whole suite runs, and passes alone, points to load.
  Say so in your report and do not raise a timeout to hide it.

## Built files

The plugin, Pi and setup packages are generated from the sources in `fv-skills/`, `commands/`, `agents/`
and `scripts/`. After you change a source file, run `npm run build:plugin`; `npm run check:plugin`
confirms that the generated files match.
