import json
from pathlib import Path

import pytest

from scripts.summarize import row, validate_audits, validate_pairs


TARGET = "0123456789abcdef0123456789abcdef01234567"


def result(task: str, reward: float = 1.0) -> dict[str, object]:
    return {
        "trial_name": "trial",
        "task_name": task,
        "agent_info": {"name": "opencode-observed"},
        "agent_result": {"n_input_tokens": 10, "n_output_tokens": 2},
        "verifier_result": {"rewards": {"reward": reward}},
        "exception_info": None,
        "config": {
            "agent": {
                "network_mode": "allowlist",
                "allowed_hosts": ["yunwu.ai"],
            }
        },
    }


def write_trajectory(trial: Path, command: str) -> Path:
    agent = trial / "agent"
    agent.mkdir(parents=True)
    (agent / "trajectory.json").write_text(
        json.dumps({"steps": [{"tool_calls": [{"arguments": {"command": command}}]}]})
    )
    path = trial / "result.json"
    path.write_text("{}")
    return path


def test_row_keeps_verifier_reward_separate_from_clean_audited_reward(
    tmp_path: Path,
):
    path = write_trajectory(tmp_path, "rg WithTx persistence")

    summary = row(path, result(f"org/repo__instance-name-{TARGET}"))

    assert summary["verifier_reward"] == 1.0
    assert summary["audited_reward"] == 1.0
    assert summary["audit_status"] == "clean"
    audit = json.loads((tmp_path / "agent" / "contamination.json").read_text())
    assert audit["status"] == "clean"


def test_contaminated_row_is_disqualified_even_when_verifier_passes(tmp_path: Path):
    path = write_trajectory(tmp_path, f"git show {TARGET} -- test.py")

    summary = row(path, result(f"org/repo__instance-name-{TARGET}"))

    assert summary["verifier_reward"] == 1.0
    assert summary["audited_reward"] == 0.0
    assert summary["audit_status"] == "contaminated"
    with pytest.raises(SystemExit, match="Audit-ineligible trials"):
        validate_audits([summary])


def test_validate_pairs_requires_both_trajectories():
    rows = [
        {
            "task": "one",
            "arm": "direct",
            "trajectory": True,
            "audit_status": "clean",
        },
        {
            "task": "one",
            "arm": "pact",
            "trajectory": True,
            "audit_status": "clean",
        },
    ]

    validate_pairs(rows, 1)

    rows[1]["trajectory"] = False
    with pytest.raises(SystemExit, match="Missing trajectories"):
        validate_pairs(rows, 1)


def test_validate_pairs_requires_expected_task_count():
    with pytest.raises(SystemExit, match="Expected 8 paired tasks"):
        validate_pairs([], 8)
