import argparse
import csv
import json
from pathlib import Path

from pact_harbor.audit import audit_trial


def trial_results(root: Path):
    for path in sorted(root.rglob("result.json")):
        data = json.loads(path.read_text())
        if "task_name" not in data:
            continue
        yield path, data


def row(path: Path, result: dict[str, object]) -> dict[str, object]:
    agent = result.get("agent_info") or {}
    agent_result = result.get("agent_result") or {}
    verifier = result.get("verifier_result") or {}
    exception = result.get("exception_info") or {}
    reward = verifier.get("rewards") if isinstance(verifier, dict) else None
    verifier_reward = reward.get("reward") if isinstance(reward, dict) else None
    pact = path.parent / "agent" / "pact"
    agent_name = agent.get("name") if isinstance(agent, dict) else None
    audit = audit_trial(path.parent, result.get("task_name"), result)
    audit_path = path.parent / "agent" / "contamination.json"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    audit_status = str(audit["status"])
    return {
        "trial": result.get("trial_name"),
        "task": result.get("task_name"),
        "arm": (
            "pact"
            if agent_name == "opencode-pact"
            else "direct"
            if agent_name in {"opencode", "opencode-observed"}
            else "other"
        ),
        "agent": agent_name,
        "reward": json.dumps(reward, sort_keys=True) if reward is not None else "",
        "verifier_reward": verifier_reward,
        "audited_reward": (
            verifier_reward
            if audit_status == "clean"
            else 0.0
            if audit_status == "contaminated"
            else None
        ),
        "audit_status": audit_status,
        "audit_evidence": json.dumps(audit["evidence"], sort_keys=True),
        "agent_status": "failed" if exception else "ok",
        "verifier_status": "scored" if verifier_reward is not None else "missing",
        "input_tokens": (
            agent_result.get("n_input_tokens")
            if isinstance(agent_result, dict)
            else None
        ),
        "output_tokens": (
            agent_result.get("n_output_tokens")
            if isinstance(agent_result, dict)
            else None
        ),
        "cost_usd": (
            agent_result.get("cost_usd") if isinstance(agent_result, dict) else None
        ),
        "exception": (
            exception.get("exception_type") if isinstance(exception, dict) else None
        ),
        "trajectory": (path.parent / "agent" / "trajectory.json").is_file(),
        "pact_artifacts": pact.is_dir() and any(pact.rglob("state.json")),
        "path": str(path.parent),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("roots", nargs="+", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--expect-pairs", type=int)
    parser.add_argument(
        "--allow-audit-failures",
        action="store_true",
        help="write forensic summaries without rejecting contaminated or unauditable runs",
    )
    args = parser.parse_args()
    rows = [
        row(path, result) for root in args.roots for path, result in trial_results(root)
    ]
    output = args.output or args.roots[0] / "comparison-summary.csv"
    output.parent.mkdir(parents=True, exist_ok=True)
    fields = list(rows[0]) if rows else ["trial", "task", "agent", "reward", "path"]
    with output.open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    if args.expect_pairs is not None:
        validate_pairs(rows, args.expect_pairs)
    if not args.allow_audit_failures:
        validate_audits(rows)
    print(f"Wrote {len(rows)} trial rows to {output}")


def validate_pairs(rows: list[dict[str, object]], expected: int) -> None:
    pairs: dict[object, dict[object, dict[str, object]]] = {}
    for item in rows:
        if item["arm"] not in {"direct", "pact"}:
            continue
        pairs.setdefault(item["task"], {})[item["arm"]] = item
    if len(pairs) != expected:
        raise SystemExit(f"Expected {expected} paired tasks, found {len(pairs)}")
    incomplete = [
        task for task, arms in pairs.items() if set(arms) != {"direct", "pact"}
    ]
    if incomplete:
        raise SystemExit(f"Tasks missing a direct or PACT arm: {incomplete}")
    missing_trajectories = [
        f"{task}:{arm}"
        for task, arms in pairs.items()
        for arm, item in arms.items()
        if not item["trajectory"]
    ]
    if missing_trajectories:
        raise SystemExit(f"Missing trajectories: {missing_trajectories}")


def validate_audits(rows: list[dict[str, object]]) -> None:
    ineligible = [
        f"{item.get('task')}:{item.get('arm')}={item.get('audit_status')}"
        for item in rows
        if item.get("arm") in {"direct", "pact"} and item.get("audit_status") != "clean"
    ]
    if ineligible:
        raise SystemExit(
            "Audit-ineligible trials (use --allow-audit-failures only for forensic "
            f"reporting): {ineligible}"
        )


if __name__ == "__main__":
    main()
