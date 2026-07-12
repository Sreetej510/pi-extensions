# pi-extensions

A monorepo of independently installable [pi coding agent](https://github.com/earendil-works/pi)
extensions, published to npm under the `@omega` scope so each package name is globally unique
(`@omega/pi-<extension-name>`). Structure and tooling are modeled after
[narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions).

## Packages

| Package | Description | Entry point |
|---|---|---|
| [`@omega/pi-hpc-tools`](extensions/pi-hpc-tools) | Remote HPC/SSH exploration (`ls`/`read`/`grep`) via `plink`, gated per-project by `/hpc:on` | `src/hpc-tools.ts` |
| [`@omega/pi-prompt-manager`](extensions/pi-prompt-manager) | Save, browse, and paste reusable prompts via `/prompt` | `src/prompt-manager.ts` |
| [`@omega/pi-usage`](extensions/pi-usage) | Provider usage / rate-limit reporting + statusline via `/usage` | `src/usage.ts` |
| [`@omega/pi-shipd-checks`](extensions/pi-shipd-checks) | Multi-agent fairness review + test-gap analysis via `/checks` | `src/index.ts` |

Each package has its own README with commands, configuration, and usage details.

## Repository layout

```
pi-extensions/
├── extensions/
│   ├── pi-hpc-tools/
│   │   ├── src/hpc-tools.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── README.md
│   │   └── LICENSE
│   ├── pi-prompt-manager/
│   ├── pi-usage/
│   └── pi-shipd-checks/
├── scripts/
│   └── bump-shared-version.mjs
├── .github/workflows/
│   ├── ci.yml              # lint + typecheck on push/PR
│   ├── bump-version.yml    # manual: bump all package versions in lockstep + tag
│   ├── release.yml         # tag push -> GitHub Release
│   └── publish.yml         # tag push -> publish unpublished packages to npm
├── package.json             # npm workspaces root (private)
├── tsconfig.json            # shared, workspace-wide typecheck config
├── biome.json                # shared lint/format config
└── LICENSE
```

This is an **npm workspaces monorepo**: the root `package.json` is `private` and only exists to
drive tooling (install, lint, typecheck, version bumps). Every folder under `extensions/*` is an
independently publishable npm package.

## Getting started

```bash
git clone <this-repo>
cd pi-extensions
npm install
```

### Common scripts (run from the repo root)

| Command | Effect |
|---|---|
| `npm run check` | Biome check + typecheck across all workspaces |
| `npm run lint` | Biome lint |
| `npm run format` | Biome format (writes changes) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run pack:<name>` | `npm pack --dry-run` for one package (sanity-check `files`/tarball contents) |
| `npm run publish:dry` | Dry-run publish of every non-private workspace |

You can also scope any script to a single package:

```bash
npm run --workspace @omega/pi-usage check
npm run --workspace @omega/pi-usage typecheck
```

## Adding a new extension

1. Create `extensions/pi-<name>/` with a `src/` folder containing your extension's entry file
   (and any supporting modules).
2. Add a `package.json` (copy an existing one as a template) with:
   - `"name": "@omega/pi-<name>"`
   - `"private": false`
   - `"pi": { "extensions": ["./src/<entry-file>.ts"] }`
   - `"files": ["src", "README.md", "LICENSE"]`
3. Add a `tsconfig.json` (copy an existing one), a `README.md` documenting commands/config, and
   a `LICENSE` (copy the root `LICENSE`, or symlink/duplicate it).
4. Add a `pack:<name>` script to the root `package.json` for convenience (optional).
5. Run `npm install` at the repo root so the new workspace is linked, then
   `npm run --workspace @omega/pi-<name> check`.
6. For local testing without publishing, point your pi `settings.json` at the file directly:

   ```json
   {
     "extensions": ["/absolute/path/to/pi-extensions/extensions/pi-<name>/src/<entry-file>.ts"]
   }
   ```

## Versioning

All packages share a single version number (lockstep versioning), bumped together via:

```bash
node scripts/bump-shared-version.mjs patch   # or minor / major
```

This updates the root `package.json` and every non-private `extensions/*/package.json`. In CI,
the same logic is available as the manual **"Bump version"** workflow, which commits the bump
and creates a `vX.Y.Z` tag.

## Release & publish pipeline

The full pipeline is push-button once configured:

1. **CI** (`.github/workflows/ci.yml`) — runs on every push/PR to `main`: installs deps, runs
   `npm run check` (biome + typecheck) across all workspaces.
2. **Bump version** (`.github/workflows/bump-version.yml`, manual `workflow_dispatch`) — pick
   `patch`/`minor`/`major`, it bumps every package's version, commits
   `chore(release): vX.Y.Z`, and pushes a matching git tag.
3. **Release** (`.github/workflows/release.yml`) — triggered by the `vX.Y.Z` tag push; creates a
   GitHub Release with auto-generated notes.
4. **Publish** (`.github/workflows/publish.yml`) — also triggered by the `vX.Y.Z` tag push (or
   manually); installs deps, runs `npm run check` again as a safety gate, then publishes every
   non-private workspace package whose `name@version` isn't already on the npm registry
   (`npm --workspace <name> publish --access public`).

### One-time setup

- Create an npm **automation/publish token** for the `@omega` org/scope and add it to the repo
  as the `NPM_TOKEN` secret (used by `publish.yml`).
- If `bump-version.yml` needs to push to a protected `main` branch, add a `PAT_TOKEN` secret
  with a personal access token that has `contents: write` (repo `Settings → Secrets`).
- Make sure the `@omega` scope exists on npm and this repo's publishing account is a member with
  publish rights: `npm org ls omega` / `npm access ls-packages @omega`.

### Cutting a release manually (no CI)

```bash
npm install
npm run check
node scripts/bump-shared-version.mjs patch
git add package.json extensions/*/package.json
git commit -m "chore(release): v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push origin main --tags

# Publish (requires npm login with publish rights on @omega)
npm publish --workspace @omega/pi-hpc-tools --access public
npm publish --workspace @omega/pi-prompt-manager --access public
npm publish --workspace @omega/pi-usage --access public
npm publish --workspace @omega/pi-shipd-checks --access public
```

## Installing published extensions

Once published, add any package to your pi `settings.json` under `packages` (pi resolves the
`pi.extensions` entry points from the installed npm package automatically):

```json
{
  "packages": [
    "npm:@omega/pi-hpc-tools",
    "npm:@omega/pi-prompt-manager",
    "npm:@omega/pi-usage",
    "npm:@omega/pi-shipd-checks"
  ]
}
```

## License

MIT — see [LICENSE](LICENSE). Individual packages carry a copy of the same license.
