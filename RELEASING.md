# Releasing

The four packages (`@stealthmark/core`, `@stealthmark/express`, `@stealthmark/next`, `@stealthmark/cli`) are released together, with the same version number. Nothing has been published to npm yet: the first release follows these same steps.

Pushing a tag that matches `v*` runs [`.github/workflows/release.yml`](./.github/workflows/release.yml). It builds, typechecks and tests, checks that the tag equals every package version, then publishes with `npm publish --provenance --access public` in this order: core, express, next, cli.

## Before the first release (once)

1. Create the `@stealthmark` organization on npmjs.com. The scope must exist and the account that owns the token must be allowed to publish to it.
2. Create an npm access token that can publish `@stealthmark/*` without an interactive one-time password (an automation token, or a granular token with write access to the scope).
3. Add it to the GitHub repository as the Actions secret `NPM_TOKEN` (Settings, Secrets and variables, Actions). The workflow reads only that secret.

Provenance needs the workflow permission `id-token: write` (already set) and a public repository whose URL matches the `repository` field in each `package.json` (it does).

## Every release

1. Check that main is green in CI, then bump the version in all four `packages/*/package.json` files to the same stable `x.y.z` (the workflow rejects prerelease versions).
2. Bump the `@stealthmark/core` range in the `dependencies` of `next`, `express` and `cli` if the new version is outside it. For `0.x` versions `^0.1.0` does not match `0.2.0`.
3. Update the hard-coded `VERSION` constant in `packages/cli/src/bin.ts` so `stealthmark --version` matches.
4. Refresh the lockfile and run the checks locally:

   ```bash
   npm install
   npm run build && npm run typecheck && npm test
   npm pack --dry-run -w @stealthmark/core -w @stealthmark/express -w @stealthmark/next -w @stealthmark/cli
   ```

   The `--dry-run` lists what would be in each tarball and publishes nothing.
5. Commit the bump and push it to main.
6. Tag and push the tag. Pushing the tag is what publishes:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

7. Watch the Release run in the Actions tab. When it is green, check `npm view @stealthmark/core version` and that each package page on npmjs.com shows the provenance statement.

## After the first release

Remove the "not published to npm yet" notes from `README.md` and `packages/*/README.md`, and add the npm version badge to `README.md`.

## If a run fails halfway

Published versions are immutable. If core was published and a later package failed, do not try to overwrite it: fix the cause, bump to the next patch version in all four packages and release again from step 1.
