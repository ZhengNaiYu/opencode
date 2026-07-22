import json
import re
from pathlib import Path


_TARGET_COMMIT = re.compile(r"-([0-9a-f]{40})(?:-|$)")
_HEX_COMMIT = re.compile(r"(?<![0-9a-f])([0-9a-f]{7,40})(?![0-9a-f])")
_HISTORY_PROBE = re.compile(
    r"\bgit\s+(?:log\b[^\n]*(?:--all|--remotes)|show\s+(?:origin/|upstream/)|"
    r"branch\b[^\n]*\s-a\b|remote\s+-v\b|rev-list\b[^\n]*\.\.|fetch\b)",
    re.IGNORECASE,
)
_ANSWER_ARTIFACT = re.compile(
    r"(?:^|[/\\])(?:gold(?:en)?|solution|oracle|test)[._-]?(?:patch|diff)(?:$|[\s'\"])"
    r"|(?:^|[\s'\"])/solution(?:/|$)",
    re.IGNORECASE,
)


def target_commit(task_name: object) -> str | None:
    if not isinstance(task_name, str):
        return None
    match = _TARGET_COMMIT.search(task_name)
    return match.group(1) if match else None


def audit_trial(
    trial: Path,
    task_name: object,
    result: dict[str, object] | None = None,
) -> dict[str, object]:
    target = target_commit(task_name)
    trajectory = trial / "agent" / "trajectory.json"
    opencode = trial / "agent" / "opencode.txt"
    commands, trajectory_valid = _trajectory_commands(trajectory)
    evidence: list[dict[str, str]] = []

    network_policy = _network_policy(result)
    if network_policy is not None:
        mode, allowed_hosts = network_policy
        if mode != "allowlist":
            evidence.append(
                {
                    "kind": "unrestricted_agent_network",
                    "source": "result_config",
                    "text": mode or "missing network_mode",
                }
            )
        elif set(allowed_hosts) != {"yunwu.ai"}:
            evidence.append(
                {
                    "kind": "unapproved_agent_network_host",
                    "source": "result_config",
                    "text": ", ".join(allowed_hosts) or "empty allowlist",
                }
            )

    if target:
        prefixes = {target[:length] for length in range(7, len(target) + 1)}
        for command in commands:
            commits = set(_HEX_COMMIT.findall(command.lower()))
            if commits & prefixes:
                evidence.append(
                    {
                        "kind": "target_commit_access",
                        "source": "trajectory",
                        "text": command[:500],
                    }
                )

    for command in commands:
        if _ANSWER_ARTIFACT.search(command):
            evidence.append(
                {
                    "kind": "answer_artifact_access",
                    "source": "trajectory",
                    "text": command[:500],
                }
            )
        if _HISTORY_PROBE.search(command):
            evidence.append(
                {
                    "kind": "future_history_probe",
                    "source": "trajectory",
                    "text": command[:500],
                }
            )

    raw_text = ""
    if trajectory.is_file():
        raw_text += trajectory.read_text(errors="replace")
    if opencode.is_file():
        raw_text += "\n" + opencode.read_text(errors="replace")
    if (
        target
        and target[:8] in raw_text.lower()
        and not any(item["kind"] == "target_commit_access" for item in evidence)
    ):
        evidence.append(
            {
                "kind": "target_commit_disclosure",
                "source": "agent_log",
                "text": target,
            }
        )

    critical = {
        "target_commit_access",
        "target_commit_disclosure",
        "answer_artifact_access",
    }
    kinds = {item["kind"] for item in evidence}
    status = (
        "contaminated"
        if kinds & critical
        else "suspicious"
        if evidence
        else "clean"
        if trajectory_valid
        else "unavailable"
    )
    return {
        "schema_version": 1,
        "status": status,
        "target_commit": target,
        "agent_network_mode": network_policy[0] if network_policy else None,
        "agent_allowed_hosts": network_policy[1] if network_policy else None,
        "evidence": evidence,
    }


def _network_policy(
    result: dict[str, object] | None,
) -> tuple[str | None, list[str]] | None:
    if result is None:
        return None
    config = result.get("config")
    if not isinstance(config, dict):
        return None, []
    agent = config.get("agent")
    if not isinstance(agent, dict):
        return None, []
    mode = agent.get("network_mode")
    allowed_hosts = agent.get("allowed_hosts")
    return (
        mode if isinstance(mode, str) else None,
        [host for host in allowed_hosts if isinstance(host, str)]
        if isinstance(allowed_hosts, list)
        else [],
    )


def _trajectory_commands(path: Path) -> tuple[list[str], bool]:
    if not path.is_file():
        return [], False
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return [], False
    if not isinstance(data, dict) or not isinstance(data.get("steps"), list):
        return [], False
    commands: list[str] = []
    for step in data["steps"]:
        if not isinstance(step, dict) or not isinstance(step.get("tool_calls"), list):
            continue
        for call in step["tool_calls"]:
            if not isinstance(call, dict) or not isinstance(
                call.get("arguments"), dict
            ):
                continue
            command = call["arguments"].get("command")
            if isinstance(command, str):
                commands.append(command)
    return commands, True
