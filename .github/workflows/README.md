# GitHub Actions policy

This repository intentionally does not define GitHub Actions workflows right now.
The Sapoto-Health organization has previously incurred unexpected Actions costs
from Playwright-derived repositories, especially from macOS and large runner
usage. Keeping this directory empty prevents accidental CI spend.

If CI becomes necessary, it is fine to add workflows deliberately. Please include
the expected trigger, runner labels, artifact retention, and cost impact in the
pull request so reviewers can decide whether the spend is justified.

Prefer manual or narrow path-scoped triggers for expensive jobs. Avoid broad
`push`, `pull_request`, or scheduled workflows on paid runners unless they are
required for the repository's active development workflow.
