import json
from pathlib import Path

from pact_harbor.audit import audit_trial, target_commit


TARGET = "0123456789abcdef0123456789abcdef01234567"
TASK = f"org/repo__instance_project-{TARGET}"


def write_trajectory(trial: Path, *commands: str) -> None:
    agent = trial / "agent"
    agent.mkdir(parents=True)
    (agent / "trajectory.json").write_text(
        json.dumps(
            {
                "steps": [
                    {
                        "tool_calls": [
                            {"arguments": {"command": command}} for command in commands
                        ]
                    }
                ]
            }
        )
    )


def test_target_commit_is_parsed_from_swebench_task_name():
    assert target_commit(TASK) == TARGET
    assert target_commit("task-without-a-sha") is None


def test_clean_trajectory_is_eligible(tmp_path: Path):
    write_trajectory(tmp_path, "rg 'WithTx' persistence")

    audit = audit_trial(tmp_path, TASK)

    assert audit["status"] == "clean"
    assert audit["evidence"] == []


def test_target_commit_access_is_contaminated(tmp_path: Path):
    write_trajectory(
        tmp_path, f"git show {TARGET[:10]} -- tests/integration/test_api.py"
    )

    audit = audit_trial(tmp_path, TASK)

    assert audit["status"] == "contaminated"
    assert {item["kind"] for item in audit["evidence"]} == {"target_commit_access"}


def test_future_history_probe_is_suspicious(tmp_path: Path):
    write_trajectory(tmp_path, "git log --all --oneline --decorate -20")

    audit = audit_trial(tmp_path, TASK)

    assert audit["status"] == "suspicious"
    assert audit["evidence"][0]["kind"] == "future_history_probe"


def test_public_agent_network_is_not_score_eligible(tmp_path: Path):
    write_trajectory(tmp_path, "rg WithTx persistence")

    audit = audit_trial(
        tmp_path,
        TASK,
        {"config": {"agent": {"network_mode": "public"}}},
    )

    assert audit["status"] == "suspicious"
    assert audit["evidence"][0]["kind"] == "unrestricted_agent_network"


def test_only_model_api_host_is_accepted(tmp_path: Path):
    write_trajectory(tmp_path, "rg WithTx persistence")

    audit = audit_trial(
        tmp_path,
        TASK,
        {
            "config": {
                "agent": {
                    "network_mode": "allowlist",
                    "allowed_hosts": ["yunwu.ai"],
                }
            }
        },
    )

    assert audit["status"] == "clean"


def test_target_sha_disclosed_outside_structured_command_is_contaminated(
    tmp_path: Path,
):
    agent = tmp_path / "agent"
    agent.mkdir()
    (agent / "opencode.txt").write_text(f"I found the answer at {TARGET}\n")

    audit = audit_trial(tmp_path, TASK)

    assert audit["status"] == "contaminated"
    assert audit["evidence"][0]["kind"] == "target_commit_disclosure"


def test_harbor_reference_solution_access_is_contaminated(tmp_path: Path):
    write_trajectory(tmp_path, "bash /solution/solve.sh")

    audit = audit_trial(tmp_path, TASK)

    assert audit["status"] == "contaminated"
    assert audit["evidence"][0]["kind"] == "answer_artifact_access"


def test_missing_agent_logs_are_not_silently_treated_as_clean(tmp_path: Path):
    assert audit_trial(tmp_path, TASK)["status"] == "unavailable"


def test_plain_log_without_valid_trajectory_is_not_auditable(tmp_path: Path):
    agent = tmp_path / "agent"
    agent.mkdir()
    (agent / "opencode.txt").write_text("finished normally\n")

    assert audit_trial(tmp_path, TASK)["status"] == "unavailable"


def test_malformed_trajectory_is_not_auditable(tmp_path: Path):
    agent = tmp_path / "agent"
    agent.mkdir()
    (agent / "trajectory.json").write_text("not json\n")

    assert audit_trial(tmp_path, TASK)["status"] == "unavailable"
