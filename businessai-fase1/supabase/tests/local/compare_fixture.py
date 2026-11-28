"""Compare inspect_security_baseline.sql output (run on the local fixture)
with the values recorded from the real inspection. Exit 1 on any mismatch."""
import json
import sys

actual = json.load(open(sys.argv[1]))
expected = json.load(open(sys.argv[2]))
LETTERS = {"select": "S", "insert": "I", "update": "U", "delete": "D", "truncate": "T"}
problems, checks = [], 0

tables = {t["table"]: t for t in actual["tables"]}
policies = {}
for p in actual["rls_policies"] or []:
    policies.setdefault(p["table"], []).append(p["name"])

for name, exp in expected["tables"].items():
    act = tables.get(name)
    if act is None:
        problems.append(f"{name}: missing")
        continue
    cols = [[c["name"], c["type"], c["not_null"]] for c in act["columns"]]
    fks = sorted([f["references"], f["on_delete"]] for f in (act["foreign_keys"] or []))
    idx = sorted(i["name"] for i in (act["indexes"] or []))
    privs = {role: "".join(LETTERS[k] for k in ("select", "insert", "update", "delete", "truncate") if v[k])
             for role, v in act["role_privileges"].items()}
    for label, a, e in [
        ("rls_enabled", act["rls_enabled"], exp["rls_enabled"]),
        ("columns", cols, exp["columns"]),
        ("foreign_keys", fks, sorted(exp["foreign_keys"])),
        ("indexes", idx, sorted(exp["indexes"])),
        ("privileges", privs, exp["privileges"]),
        ("policies", sorted(policies.get(name, [])), sorted(exp["policies"])),
    ]:
        checks += 1
        if a != e:
            problems.append(f"{name}.{label}: fixture={a!r} inspected={e!r}")

checks += 1
n_storage = len(policies.get("storage.objects", []))
if n_storage != expected["storage_objects_policy_count"]:
    problems.append(f"storage.objects policies: {n_storage} != {expected['storage_objects_policy_count']}")

funcs = {f["name"]: f for f in actual["functions"] or []}
for fname, exp in expected["functions"].items():
    checks += 1
    f = funcs.get(fname)
    got = None if f is None else {k: f[k] for k in exp}
    if got != exp:
        problems.append(f"function {fname}: fixture={got!r} inspected={exp!r}")

checks += 1
b = {x["id"]: x for x in actual["storage_buckets"] or []}.get(expected["bucket"]["id"])
if not b or b["public"] != expected["bucket"]["public"] or b["file_size_limit"] != expected["bucket"]["file_size_limit"]:
    problems.append(f"bucket: {b!r}")

for p in problems:
    print("MISMATCH:", p)
print(f"{checks - len(problems)}/{checks} fidelity checks match the inspection")
sys.exit(1 if problems else 0)
