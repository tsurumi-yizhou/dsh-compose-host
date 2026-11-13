# DSH Compose Host

Unofficial host for DSH Compose, based on DeepSeek Harness. Independently maintained by tsurumi-yizhou; not an official DeepSeek product.

## Development

Use Node.js 26.13.1, npm, Python 3 and tar. From this repository:

```sh
bash build.sh
node test.mjs
npm install --prefix sdk/plugin-kit --ignore-scripts --no-package-lock
npm test --prefix sdk/plugin-kit
```

The build produces `dist/host.tgz` with the engine overrides, dependency lock, bundles, bridge and plugin authoring skill. Tests use the prepared engine in `.work/dependencies`. No Android checkout or SDK is required.

## Deployment and releases

Extract `dist/host.tgz`, then run `node compose.mjs install` and `node compose.mjs run` from the extracted directory. `node compose.mjs enable` installs the user systemd service. The deployment uses Node.js and npm.

Push a `v*` tag to build a GitHub Release draft containing `host.tgz`. Android consumes this archive via `-PhostPackage=/absolute/path/to/host.tgz`; its default is `../dsh-compose-host/dist/host.tgz`. For Android CI, set its `HOST_RELEASE_TAG` repository variable to a published Host release tag.

## Source ownership

- `engine/`: locally modified DeepSeek Harness packages.
- `bundles/`, `bridge/`, `deploy/`: host features, client bridge and installation.
- `sdk/plugin-kit/`: native plugin author tools, schemas and [author documentation](sdk/plugin-kit/README.md). The kit is private and is not published to npm.
- `media/`: media plugin and its tests.
- `tests/`, `tools/`: host tests and development tools.

This repository inherits the project license in [LICENSE.md](LICENSE.md). DeepSeek Harness-derived sources in `engine/packages/` retain their individual MIT LICENSE files and upstream copyright (Copyright 2026 DeepSeek); they originate from the `dsh-v0.2.2-rc.1` sources and contain project modifications. Their upstream module identifiers are retained internally and their manifests are private. Other package-specific licenses remain beside their sources.
