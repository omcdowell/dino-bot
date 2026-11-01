#!/usr/bin/env python3
"""Credit guards for .github/workflows (build/preflight-release.sh runs this before any push).

  build/workflow-check.py policy WORKFLOW_DIR          every workflow obeys the rules below
  build/workflow-check.py step FILE JOB 'STEP NAME' [key=value ...]
                                                       print that step's `run:` script, with
                                                       ${{ matrix.<key> }} etc. replaced by the values
                                                       (preflight runs the workflow's own commands)

Rules (28 Oct, "protections not to continually burn credit"; private repo, Free plan):
  - triggered only by pushing a tag: `on: push: tags:` and nothing else (no branches, PRs,
    schedules, workflow_dispatch, workflow_run)
  - `concurrency` with `cancel-in-progress: true`, keyed on the ref
  - every job has `timeout-minutes`, at most: test 10, release 15, any other job 30
  - no `fail-fast: false`, no `continue-on-error`
  - a job on a macOS runner (10x minutes) `needs` test and every Linux build job
  - build-linux and build-macos run the same steps (one build recipe)
"""
import re
import sys
from pathlib import Path

import yaml

LIMITS = {"test": 10, "release": 15}
DEFAULT_LIMIT = 30


def load(path):
    doc = yaml.safe_load(Path(path).read_text())
    # YAML 1.1 reads the bare key `on` as True.
    if True in doc and "on" not in doc:
        doc["on"] = doc.pop(True)
    return doc


def runners(job):
    r = job.get("runs-on", "")
    if isinstance(r, str) and "matrix." in r:
        inc = (job.get("strategy") or {}).get("matrix", {}).get("include", [])
        return [m.get("runner", "") for m in inc]
    return [r] if isinstance(r, str) else list(r)


def policy(d):
    errs = []
    files = sorted(list(Path(d).glob("*.yml")) + list(Path(d).glob("*.yaml")))
    if not files:
        errs.append(f"{d}: no workflow files")
    for f in files:
        w = load(f)
        name = f.name
        on = w.get("on")
        if not (isinstance(on, dict) and list(on) == ["push"] and isinstance(on["push"], dict)
                and list(on["push"]) == ["tags"] and on["push"]["tags"]):
            errs.append(f"{name}: trigger must be only `on: push: tags: [...]`, got {on!r}")
        c = w.get("concurrency")
        if not (isinstance(c, dict) and c.get("cancel-in-progress") is True and "github.ref" in str(c.get("group", ""))):
            errs.append(f"{name}: needs `concurrency: {{group: ...github.ref..., cancel-in-progress: true}}`")
        jobs = w.get("jobs") or {}
        linux_builds = [j for j, job in jobs.items() if j.startswith("build") and all(r.startswith("ubuntu") for r in runners(job))]
        for j, job in jobs.items():
            lim = LIMITS.get(j, DEFAULT_LIMIT)
            t = job.get("timeout-minutes")
            if not isinstance(t, int) or t <= 0 or t > lim:
                errs.append(f"{name}: job {j}: timeout-minutes must be 1..{lim}, got {t!r}")
            if (job.get("strategy") or {}).get("fail-fast") is False:
                errs.append(f"{name}: job {j}: fail-fast: false")
            if "continue-on-error" in job or any("continue-on-error" in s for s in job.get("steps", [])):
                errs.append(f"{name}: job {j}: continue-on-error")
            if any("macos" in r for r in runners(job)):
                needs = job.get("needs") or []
                needs = [needs] if isinstance(needs, str) else needs
                missing = [n for n in ["test", *linux_builds] if n not in needs]
                if missing or not linux_builds:
                    errs.append(f"{name}: job {j} runs on macOS but does not need {missing or 'a Linux build job'}")
        if "build-linux" in jobs and "build-macos" in jobs and jobs["build-linux"]["steps"] != jobs["build-macos"]["steps"]:
            errs.append(f"{name}: build-linux and build-macos steps differ")
    for e in errs:
        print("workflow-check:", e, file=sys.stderr)
    if errs:
        sys.exit(1)
    print(f"workflow-check: {len(files)} workflow(s) ok: tag-only, concurrency cancels, timeouts, macOS after Linux")


def step(f, job, name, *kv):
    w = load(f)
    steps = [s for s in w["jobs"][job]["steps"] if s.get("name") == name]
    if len(steps) != 1:
        sys.exit(f"workflow-check: {f}: job {job} has {len(steps)} step(s) named {name!r}")
    run = steps[0]["run"]
    vals = dict(a.split("=", 1) for a in kv)

    def sub(m):
        k = m.group(1).strip()
        if k not in vals:
            sys.exit(f"workflow-check: no value for ${{{{ {k} }}}} in step {name!r}")
        return vals[k]

    sys.stdout.write(re.sub(r"\$\{\{\s*([^}]+?)\s*\}\}", sub, run))


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["policy"] and len(a) == 2:
        policy(a[1])
    elif a[:1] == ["step"] and len(a) >= 4:
        step(*a[1:])
    else:
        sys.exit(__doc__)
