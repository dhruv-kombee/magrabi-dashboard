"""Stage the kvsync routing plans into keyvault/ so the Dockerfile can bake them in.

Run this before building the portal image whenever the plans have been regenerated.

    python stage_plans.py

Why a copy rather than a COPY from devops-tools/kvsync/: the Docker build context is this directory,
and widening it to the repository root would send .secrets/ to the registry, because .dockerignore
only applies at the context root.

Before writing anything, this refuses to stage a plan that looks like it carries a credential. The
plans are supposed to hold names only - project, definition, stage, variable, placement, service.
A value appearing in one would be baked into an image and pushed to a registry, so the check is a
hard gate rather than a warning.
"""
import hashlib
import io
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, "..", "devops-tools", "kvsync"))
DST = os.path.join(HERE, "keyvault")
PLANS = ("uat_plan.json", "prod_plan.json")

# Exactly the keys a plan row is allowed to have. Anything else is unexpected and could be a value.
ALLOWED = {"project", "defId", "defName", "stage", "pipelineName", "placement",
           "secretName", "service", "shared", "task", "empty"}


def looks_like_a_credential(s):
    """A heuristic, deliberately strict - a false positive costs a minute, a miss ships a secret."""
    if not isinstance(s, str) or len(s) < 20:
        return False
    low = s.lower()
    if low.startswith(("sk-", "sg.", "ey", "glpat-", "ghp_", "xox")):
        return True
    if "accountkey=" in low or "defaultendpointsprotocol" in low:
        return True
    if "password=" in low or "pwd=" in low:
        return True
    # a long run of base64-ish characters with no separator reads like a key, not a name
    if len(s) >= 32 and all(c.isalnum() or c in "+/=_-" for c in s) and not any(
            sep in s for sep in (" ", ".json", "/")):
        digits = sum(c.isdigit() for c in s)
        if digits >= 4 and any(c.isupper() for c in s) and any(c.islower() for c in s):
            return True
    return False


def check(path):
    rows = json.load(io.open(path, encoding="utf-8"))
    problems, extra_keys = [], set()
    for i, r in enumerate(rows):
        extra_keys |= set(r) - ALLOWED
        for k, v in r.items():
            if looks_like_a_credential(v):
                problems.append(f"row {i} key {k}: value looks like a credential "
                                f"(len {len(v)}, sha256 {hashlib.sha256(v.encode()).hexdigest()[:10]})")
    return rows, problems, extra_keys


def main():
    os.makedirs(DST, exist_ok=True)
    failed = False
    for name in PLANS:
        src = os.path.join(SRC, name)
        if not os.path.exists(src):
            print(f"{name}: MISSING at {src}")
            failed = True
            continue
        rows, problems, extra = check(src)
        print(f"{name}: {len(rows)} rows, "
              f"{len({(r['project'], r['defId']) for r in rows})} definitions, "
              f"{len({r['secretName'] for r in rows})} secrets")
        if extra:
            print(f"   unexpected keys present: {sorted(extra)} - review before staging")
            failed = True
        if problems:
            print(f"   REFUSING - {len(problems)} field(s) look like a credential:")
            for p in problems[:5]:
                print(f"      {p}")
            failed = True
            continue
        print("   no field looks like a credential")
        shutil.copy2(src, os.path.join(DST, name))
        print(f"   staged -> keyvault/{name}")

    if failed:
        sys.exit("\nnothing was staged for at least one plan - fix the above first")
    print(f"\nstaged into {DST}")
    print("Now build:  az acr build --registry crmepucommonuaenorth001 "
          "--image magrabi-deploy-portal:<n> --file Dockerfile .")


if __name__ == "__main__":
    main()
