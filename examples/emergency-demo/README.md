# Emergency execution demo pipeline

A small pipeline used to demonstrate and test emergency execution (`docs/EMERGENCY_EXECUTION.md`).

- `.github/workflows/release.yml` calls the reusable workflow `build.yml`, then summarizes with a composite action.
- `build.yml` (`workflow_call`) runs:
  - the local JavaScript action `stamp` (TypeScript source in `src/`, committed build in `dist/`);
  - the external JavaScript action `demo-org/shared-actions/notify@v1` (served from `../emergency-demo-shared-actions` in fixture mode);
  - a shell script (`scripts/build.sh`), a Python script (`scripts/checksum.py`) and `scripts/verify.sh`, in two dependent jobs.
- It needs one secret, `DEMO_SIGNING_KEY`, and one input, `version`.

In fixture mode the app serves this directory as the repository `emergency-demo/release-pipeline` (branch `main`)
and `../emergency-demo-shared-actions` as `demo-org/shared-actions` (tag `v1`).
To use it in live mode, push both to repositories you own and change the `uses:` reference to the notify action.
