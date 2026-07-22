import json
import os
import subprocess
from pathlib import Path

import pytest

from harbor.models.agent.context import AgentContext
from pact_harbor.agent import OpenCodeObserved, OpenCodePACT


def test_config_uses_environment_secret(tmp_path: Path):
    agent = OpenCodePACT(
        logs_dir=tmp_path,
        model_name="yunwu/claude-opus-4-8",
        opencode_root=tmp_path,
        version="1.17.13",
    )

    config = json.dumps(agent._config())

    assert "{env:YUNWU_API_KEY}" in config
    assert "https://yunwu.ai/v1" in config
    assert "claude-opus-4-8" in config


def test_pact_driver_uses_bun_from_installed_path(tmp_path: Path):
    source = (Path(__file__).parent.parent / "pact_harbor" / "agent.py").read_text()

    assert 'export PATH="$HOME/.bun/bin:$PATH"' in source
    assert '"bun",' in source
    assert '"$HOME/.bun/bin/bun",' not in source


def test_install_check_does_not_invoke_hanging_agent_list():
    source = (Path(__file__).parent.parent / "pact_harbor" / "agent.py").read_text()

    assert "opencode agent list" not in source
    assert "test -s /opt/opencode-pact/config/agent/pact-planner.md" in source


def test_assets_fail_closed(tmp_path: Path):
    agent = OpenCodePACT(
        logs_dir=tmp_path,
        model_name="yunwu/claude-opus-4-8",
        opencode_root=tmp_path,
    )

    with pytest.raises(ValueError, match="Missing PACT assets"):
        agent._validate_assets()


def test_round_count_must_be_positive(tmp_path: Path):
    agent = OpenCodePACT(
        logs_dir=tmp_path,
        model_name="yunwu/claude-opus-4-8",
        opencode_root=tmp_path,
        max_rounds=0,
    )
    for path in [
        ".opencode/plugins/pact.ts",
        ".opencode/plugins/pact/pact-run-driver.ts",
        ".opencode/agent/pact-planner.md",
        ".opencode/agent/pact-reviewer.md",
        ".opencode/agent/pact-worker.md",
        ".opencode/plugins/pact/harbor/assets/opencode-observed.sh",
        ".opencode/plugins/pact/harbor/assets/opencode-observed-text.sh",
        ".opencode/plugins/pact/harbor/assets/isolate-git-history.sh",
    ]:
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()

    with pytest.raises(ValueError, match="max_rounds"):
        agent._validate_assets()


def test_git_isolation_removes_future_history_but_preserves_patch_semantics(
    tmp_path: Path,
):
    repository = tmp_path / "app"
    repository.mkdir()
    subprocess.run(["git", "init", "-q", str(repository)], check=True)
    subprocess.run(
        ["git", "-C", str(repository), "config", "user.name", "Test"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(repository), "config", "user.email", "test@invalid"],
        check=True,
    )
    (repository / "answer.txt").write_text("baseline\n")
    subprocess.run(["git", "-C", str(repository), "add", "answer.txt"], check=True)
    subprocess.run(
        ["git", "-C", str(repository), "commit", "-qm", "baseline"],
        check=True,
    )
    baseline = subprocess.check_output(
        ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True
    ).strip()
    (repository / "answer.txt").write_text("gold answer\n")
    subprocess.run(
        ["git", "-C", str(repository), "commit", "-qam", "solution"], check=True
    )
    target = subprocess.check_output(
        ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True
    ).strip()
    subprocess.run(
        ["git", "-C", str(repository), "remote", "add", "origin", "https://invalid"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(repository), "checkout", "-q", "--detach", baseline],
        check=True,
    )
    (repository / "local.txt").write_text("task fixture\n")

    script = Path(__file__).parent.parent / "assets" / "isolate-git-history.sh"
    first = subprocess.check_output(
        ["bash", str(script), str(repository)],
        text=True,
        env={
            **os.environ,
            "BENCHMARK_QUARANTINE_PARENT": str(tmp_path),
        },
    ).strip()

    assert (
        subprocess.check_output(
            ["git", "-C", str(repository), "rev-list", "--all", "--count"],
            text=True,
        ).strip()
        == "1"
    )
    assert (
        subprocess.check_output(
            ["git", "-C", str(repository), "remote"], text=True
        ).strip()
        == ""
    )
    assert (
        subprocess.run(
            ["git", "-C", str(repository), "cat-file", "-e", target],
            capture_output=True,
        ).returncode
        != 0
    )
    assert (
        subprocess.check_output(
            ["git", "-C", str(repository), "status", "--short"], text=True
        ).strip()
        == ""
    )
    assert not list(tmp_path.glob("benchmark-git.*"))

    (repository / "new-file.txt").write_text("agent change\n")
    subprocess.run(["git", "-C", str(repository), "add", "-N", "--", "."], check=True)
    patch = subprocess.check_output(
        ["git", "-C", str(repository), "diff", "--binary", "--no-ext-diff"],
        text=True,
    )
    second = subprocess.check_output(
        ["bash", str(script), str(repository)],
        text=True,
        env={
            **os.environ,
            "BENCHMARK_QUARANTINE_PARENT": str(tmp_path),
        },
    ).strip()

    assert "new-file.txt" in patch
    assert "+agent change" in patch
    assert second == first


def test_worker_events_aggregate_json_round_streams(tmp_path: Path):
    agent = OpenCodePACT(
        logs_dir=tmp_path,
        model_name="yunwu/claude-opus-4-8",
        opencode_root=tmp_path,
    )
    loop = tmp_path / "pact" / "loops" / "loop-1"
    loop.mkdir(parents=True)
    (loop / "round-01-trajectory.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "type": "driver_invocation",
                        "stdout": "\n".join(
                            [
                                json.dumps({"type": "step_start", "sessionID": "one"}),
                                "not-json",
                                json.dumps(
                                    {
                                        "type": "text",
                                        "sessionID": "one",
                                        "part": {"type": "text", "text": "done"},
                                    }
                                ),
                                json.dumps(
                                    {
                                        "type": "step_finish",
                                        "sessionID": "one",
                                        "part": {"tokens": {"input": 12, "output": 3}},
                                    }
                                ),
                            ]
                        ),
                    }
                ]
            }
        )
    )

    assert agent._worker_events() == [
        {"type": "step_start", "sessionID": "one"},
        {"type": "text", "sessionID": "one", "part": {"type": "text", "text": "done"}},
        {
            "type": "step_finish",
            "sessionID": "one",
            "part": {"tokens": {"input": 12, "output": 3}},
        },
    ]

    context = AgentContext()
    agent.populate_context_post_run(context)

    assert (tmp_path / "trajectory.json").is_file()
    assert (tmp_path / "opencode.txt").is_file()
    assert context.n_input_tokens == 12
    assert context.n_output_tokens == 3


def test_observed_runner_uses_bounded_wrapper(tmp_path: Path):
    agent = OpenCodeObserved(
        logs_dir=tmp_path,
        model_name="yunwu/claude-opus-4-8",
        version="1.17.13",
    )

    command = agent._observed_command("'prompt'", "", "")

    assert "/opt/opencode-pact/opencode-observed" in command
    assert "if [ -s ~/.nvm/nvm.sh ]" in command
    assert "nvm use 22" in command
    assert "OPENCODE_BIN=/opt/opencode-pact/opencode" in command
    assert "${PIPESTATUS[0]}" in command
    assert 'wait "$agent_pid"' not in command


def test_observed_runner_timeout_must_be_positive(tmp_path: Path):
    with pytest.raises(ValueError, match="observed_timeout_sec"):
        OpenCodeObserved(
            logs_dir=tmp_path,
            model_name="yunwu/claude-opus-4-8",
            version="1.17.13",
            observed_timeout_sec=0,
        )


def test_observed_runner_command_closes_stuck_terminal_process(tmp_path: Path):
    fake = tmp_path / "opencode"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        "exec python3 -c 'import signal, time; "
        "signal.signal(signal.SIGINT, signal.SIG_IGN); "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        'print("{\\"type\\":\\"step_finish\\",\\"part\\":{\\"reason\\":\\"stop\\"}}", flush=True); '
        "time.sleep(60)'\n"
    )
    fake.chmod(0o755)
    stdbuf = tmp_path / "stdbuf"
    stdbuf.write_text(
        '#!/usr/bin/env bash\nif [[ "$1" == "-oL" ]]; then shift; fi\nexec "$@"\n'
    )
    stdbuf.chmod(0o755)
    agent = OpenCodeObserved(
        logs_dir=tmp_path,
        model_name="yunwu/claude-opus-4-8",
        version="1.17.13",
    )
    runner = tmp_path / "opencode-observed"
    runner.write_text(
        (Path(__file__).parent.parent / "assets" / "opencode-observed.sh").read_text()
    )
    runner.chmod(0o755)
    agent._OBSERVED_RUNNER = str(runner)
    agent._OPENCODE_BIN = str(fake)
    output = tmp_path / "opencode.txt"
    command = (
        agent._observed_command("'prompt'", "", "")
        .replace(
            "if [ -s ~/.nvm/nvm.sh ]; then "
            ". ~/.nvm/nvm.sh; nvm use 22 >/dev/null; fi; ",
            "",
        )
        .replace("/logs/agent/opencode.txt", str(output))
    )

    result = subprocess.run(
        ["bash", "-c", command],
        text=True,
        capture_output=True,
        timeout=10,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "OPENCODE_OBSERVED_GRACE_SEC": "0",
            "OPENCODE_OBSERVED_INT_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_TERM_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_KILL_GRACE_SEC": "1",
        },
    )

    assert result.returncode == 0
    assert '"reason":"stop"' in output.read_text()


def test_observed_wrapper_closes_stuck_terminal_process(tmp_path: Path):
    fake = tmp_path / "opencode"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        "exec python3 -c 'import signal, time; "
        "signal.signal(signal.SIGINT, signal.SIG_IGN); "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        'print("{\\"type\\":\\"step_finish\\",\\"part\\":{\\"reason\\":\\"stop\\"}}", flush=True); '
        "time.sleep(60)'\n"
    )
    fake.chmod(0o755)
    wrapper = Path(__file__).parent.parent / "assets" / "opencode-observed.sh"

    result = subprocess.run(
        ["bash", str(wrapper), "run", "--format", "json"],
        input="prompt",
        text=True,
        capture_output=True,
        timeout=10,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "OPENCODE_OBSERVED_GRACE_SEC": "0",
            "OPENCODE_OBSERVED_INT_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_TERM_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_KILL_GRACE_SEC": "1",
        },
    )

    assert result.returncode == 0
    assert '"reason":"stop"' in result.stdout


def test_observed_wrapper_uses_explicit_opencode_path(tmp_path: Path):
    fake = tmp_path / "opencode-outside-path"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        "exec python3 -c 'import signal, time; "
        "signal.signal(signal.SIGINT, signal.SIG_IGN); "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        'print("{\\"type\\":\\"step_finish\\",\\"part\\":{\\"reason\\":\\"stop\\"}}", flush=True); '
        "time.sleep(60)'\n"
    )
    fake.chmod(0o755)
    wrapper = Path(__file__).parent.parent / "assets" / "opencode-observed.sh"

    result = subprocess.run(
        ["bash", str(wrapper), "run", "--format", "json"],
        input="prompt",
        text=True,
        capture_output=True,
        timeout=10,
        env={
            **os.environ,
            "OPENCODE_BIN": str(fake),
            "OPENCODE_OBSERVED_GRACE_SEC": "0",
            "OPENCODE_OBSERVED_INT_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_TERM_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_KILL_GRACE_SEC": "1",
        },
    )

    assert result.returncode == 0
    assert '"reason":"stop"' in result.stdout


def test_observed_wrapper_falls_back_to_pid_when_setsid_does_not_create_group(
    tmp_path: Path,
):
    fake = tmp_path / "opencode-outside-path"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        "exec python3 -c 'import signal, time; "
        "signal.signal(signal.SIGINT, signal.SIG_IGN); "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        'print("{\\"type\\":\\"step_finish\\",\\"part\\":{\\"reason\\":\\"stop\\"}}", flush=True); '
        "time.sleep(60)'\n"
    )
    fake.chmod(0o755)
    setsid = tmp_path / "setsid"
    setsid.write_text('#!/usr/bin/env bash\nexec "$@"\n')
    setsid.chmod(0o755)
    wrapper = Path(__file__).parent.parent / "assets" / "opencode-observed.sh"

    result = subprocess.run(
        ["bash", str(wrapper), "run", "--format", "json"],
        input="prompt",
        text=True,
        capture_output=True,
        timeout=10,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "OPENCODE_BIN": str(fake),
            "OPENCODE_OBSERVED_GRACE_SEC": "0",
            "OPENCODE_OBSERVED_INT_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_TERM_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_KILL_GRACE_SEC": "1",
        },
    )

    assert result.returncode == 0
    assert '"reason":"stop"' in result.stdout


def test_observed_wrapper_times_out_without_terminal_event(tmp_path: Path):
    fake = tmp_path / "opencode"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        "exec python3 -c 'import signal, time; "
        "signal.signal(signal.SIGINT, signal.SIG_IGN); "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "time.sleep(60)'\n"
    )
    fake.chmod(0o755)
    wrapper = Path(__file__).parent.parent / "assets" / "opencode-observed.sh"

    result = subprocess.run(
        ["bash", str(wrapper), "run", "--format", "json"],
        input="prompt",
        text=True,
        capture_output=True,
        timeout=10,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "OPENCODE_OBSERVED_TIMEOUT_SEC": "1",
            "OPENCODE_OBSERVED_INT_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_TERM_GRACE_SEC": "1",
            "OPENCODE_OBSERVED_KILL_GRACE_SEC": "1",
        },
    )

    assert result.returncode == 124
    assert "observed-run timeout" in result.stderr


def test_observed_text_wrapper_closes_stuck_process_and_extracts_text(tmp_path: Path):
    fake = tmp_path / "opencode"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        "exec python3 -c 'import signal, sys, time; "
        "signal.signal(signal.SIGINT, lambda *_: sys.exit(130)); "
        'print("{\\"type\\":\\"text\\",\\"part\\":{\\"text\\":\\"# Plan\\"}}", flush=True); '
        'print("{\\"type\\":\\"step_finish\\",\\"part\\":{\\"reason\\":\\"stop\\"}}", flush=True); '
        "time.sleep(60)'\n"
    )
    fake.chmod(0o755)
    wrapper = Path(__file__).parent.parent / "assets" / "opencode-observed-text.sh"

    result = subprocess.run(
        ["bash", str(wrapper), "run"],
        input="prompt",
        text=True,
        capture_output=True,
        timeout=10,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "OPENCODE_OBSERVED_GRACE_SEC": "0",
        },
    )

    assert result.returncode == 0
    assert result.stdout.strip() == "# Plan"
