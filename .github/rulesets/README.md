# Repository rulesets

Exported copies of the rulesets that protect this repository, so the setup is documented and can be recreated.
Import one in GitHub: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**.

| File | Protects | Rules |
|---|---|---|
| `protect-main.json` | the default branch | no deletion, no force-push, changes arrive by pull request, the `test` check must pass, conversations resolved |
| `protect-release-tags.json` | tags `v*` | no deletion, no moving, no force-push |

The repository admin can bypass both (so the owner can still push directly). Everyone else, including bots such as
Dependabot, goes through a pull request that passes CI.

Not included: "push rules" (blocking `.env` or key files by path). GitHub only offers them to organisation-owned
repositories. Secret scanning with push protection and `.gitignore` cover that here.
