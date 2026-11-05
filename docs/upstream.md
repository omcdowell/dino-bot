# Upstream: pulling Paseo and pi-optchat into this repo

Everything DinoBot ships is a folder of this repo:

| Folder | What | Upstream | Imported from (5 Nov) |
|---|---|---|---|
| `paseo/` | Paseo fork: daemon, app, desktop, CLI | [getpaseo/paseo](https://github.com/getpaseo/paseo) | upstream `a1da1b8f2` (v0.11.1-14) + the fork's tree (`release/candidate` c05590e0b) |
| `optchat/` | OptChat, a pi extension (MIT) | [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat) | upstream `3463a11` + the fork's tree (`live/public-release` 18e876b) |
| `plugins/bots/` | the bots plugin | none (ours) | paseo-bots `live/avatar-merged` e1070d2 |
| `addons/paseo-apns/` | optional push add-on | none (ours) | already here; tests from paseo-apns `release/push-local` |

## How the folders were imported (and why squashed)

Each upstream folder is two commits:

1. `Squashed '<dir>/' content from commit <upstream sha>`: `git subtree add --squash` of the
   upstream commit the fork was based on (its merge base). The message carries
   `git-subtree-dir` and `git-subtree-split`, which `git subtree pull` reads.
2. One commit that replaces the folder with the fork's tree (all DinoBot changes at once).

Squashed, not with full history, on purpose: the old fork repos' histories hold personal and
private material (names, private routes, ids) that the public repo must never carry. Only trees
that passed `build/public-check.mjs`, `build/private-guard.sh` and gitleaks came in.

Because the squash commit is the *upstream* base, `git subtree pull` does a proper three-way
merge: base = the last upstream we took, theirs = new upstream, ours = the fork. Our changes stay;
upstream's changes come in; overlaps are normal merge conflicts.

## Pull a new upstream Paseo

```sh
git switch -c upstream/paseo-vX.Y.Z main
git subtree pull --prefix=paseo --squash https://github.com/getpaseo/paseo.git vX.Y.Z \
  -m "paseo: upstream getpaseo/paseo vX.Y.Z"
# resolve conflicts in paseo/ (git status), then:
(cd paseo && CI=true npm ci && npm run build:server && npm run typecheck && \
  (cd packages/app && npx vitest run --project unit))
build/publish-public.sh --dry-run          # public-check, private-guard, gitleaks
```

Watch for: `paseo/package.json` `prepare` (lefthook runs only in a standalone paseo checkout) and
`allowScripts.lefthook: false`. Keep both: inside this repo lefthook's install would overwrite this
repo's (or a global `core.hooksPath`'s) git hooks.

## Pull a new upstream pi-optchat

```sh
git subtree pull --prefix=optchat --squash https://github.com/jonaslsaa/pi-optchat.git main \
  -m "optchat: upstream jonaslsaa/pi-optchat <sha>"
(cd optchat && CI=true npm ci && npm test)
```

Keep upstream's `LICENSE` (MIT, Jonas Silva's copyright) as it is.

## Rules

- Only ever `subtree pull` from the **upstream** repos above. Pulling from one of our old fork repos
  (or any repo that is not the recorded base's lineage) would move the merge base and silently undo
  our changes in the next upstream pull.
- Work that still lands in an old repo during the move (the Paseo fork, pi-optchat, paseo-bots,
  paseo-apns) comes over as a patch, not a subtree pull:
  `git -C <old repo> diff A B | git apply --directory=paseo` (or `optchat`, `plugins/bots`), then
  run the checks above.
- `git subtree pull --squash` writes the pulled commits' subjects into its squash commit message.
  Read it (`git log -1`) before pushing: this repo is public.
- Before any push: `build/publish-public.sh --dry-run` must be clean (gitleaks included).
