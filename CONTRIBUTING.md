# Contributing to MajaOS

Thanks for helping. Test reports are as valuable as code: if you only have five minutes, [running the demo](README.md#try-it-in-two-minutes) or the installer and [opening an issue](https://github.com/lennertvh1/MajaOS/issues/new/choose) already helps.

## How changes get in

1. **Fork** the repository and clone your fork.
2. Make a branch from **`dev`** (not `main`): `git switch dev && git switch -c fix-pool-names`.
3. Make your change, run the checks below, and push to your fork.
4. Open a **pull request to `dev`**. Say what you changed, why, and how you tested it.
5. The maintainer reviews it. Nothing is merged without that review, and the tests must pass.

`main` only holds released versions. Releases are made from `dev` by the maintainer.

For a bigger change (a new page, a new dependency on a system package, a change to how data is stored), open an issue first so we can agree on the approach before you spend time on it.

## Running it

You need Node.js 18.11 or newer. There is nothing to install: MajaOS has no npm dependencies.

```bash
npm run demo   # the interface with sample data: http://localhost:8080 (password: demo)
npm test       # the tests (node:test)
npm run dev    # on a real Debian 13 server, with settings from .env (see deploy/majaos.env)
```

VS Code has the same options under *Run and Debug*. To build the installation ISO, see [docs/build-iso.md](docs/build-iso.md).

## Before you open a pull request

```bash
node --check server.js lib/*.js public/*.js
for f in install.sh deploy/*.sh iso/*.sh lib/*.sh; do bash -n "$f"; done
npm test
```

Then click through the demo for whatever you touched, in English and in another language, in the light and the dark theme.

## The rules of the codebase

[CLAUDE.md](CLAUDE.md) describes every module and the working agreements in detail. The ones that matter most:

- **No npm dependencies and no build step.** Built-in Node.js modules on the server; plain HTML, CSS and JavaScript in the browser. System packages are installed by `install.sh`.
- **Every endpoint exists twice**: in `server.js` and in the demo adapter `public/demo.js`, with the same response shape. Change one, change the other.
- **External commands** always go through `run()` in `lib/system.js` with an argument list, never through a shell. Validate names and paths that come from the user.
- **Everything from the server is escaped** with `esc()` before it goes into `innerHTML`.
- **No `confirm()` or `alert()`**: use `ask()` in `app.js`. Stopping, shutting down and deleting always ask first.
- **Colours** only through the CSS tokens on `:root`, so both themes keep working.
- **English** for code, comments, tests, docs and commit messages.
- **Interface text** goes through `t('…')`, with values as `t('Removed: {name}', { name })` (never glue text together). Add the translation to `public/lang/nl.js`, and to the other languages if you can.
- **Names on disk** that existing installs use stay as they are.

## Translations

The English text is the key. Each language is one file in `public/lang/`, listed in `public/lang/languages.js`. To add a language, copy `nl.js`, translate the values (keep the `{placeholders}`) and add a line with its name and locale to `languages.js`. Corrections to an existing translation are very welcome; native speakers know best.

## Commit messages

A short summary line in English that says what changes for the user ("Show the disk temperature in standby"), then a blank line and the why if it isn't obvious.

## License

By contributing you agree that your contribution is released under the [MIT License](LICENSE), like the rest of MajaOS.
