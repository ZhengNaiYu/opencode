import json
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_ISOLATION_SCRIPT = "/opt/opencode-pact/isolate-git-history"


async def _isolate_repository(
    agent: OpenCode,
    environment: BaseEnvironment,
    project_root: str = "/app",
) -> str:
    repo = await environment.exec(
        f"git -C {shlex.quote(project_root)} rev-parse --show-toplevel",
        timeout_sec=30,
    )
    if repo.return_code != 0 or not repo.stdout:
        raise RuntimeError("OpenCode requires the task repository at /app")
    root = repo.stdout.strip()
    await agent.exec_as_root(
        environment,
        command=(
            f"{shlex.quote(_ISOLATION_SCRIPT)} {shlex.quote(root)} "
            "> /logs/agent/baseline-commit.txt"
        ),
        timeout_sec=1800,
    )
    return root


def _capture_patch_command(project_root: str) -> str:
    root = shlex.quote(project_root)
    return (
        "capture_status=0; "
        f"git -C {root} add -N -- . || capture_status=$?; "
        f"git -C {root} diff --binary --no-ext-diff "
        "> /logs/agent/final.patch || capture_status=$?; "
        f"git -C {root} status --short > /logs/agent/git-status.txt "
        "|| capture_status=$?; "
        "printf '%s\\n' \"$capture_status\" "
        "> /logs/agent/patch-capture-exit-code.txt; "
    )


class OpenCodePACT(OpenCode):
    """Run the standalone PACT driver inside a Harbor task container."""

    SUPPORTS_ATIF = True

    def __init__(
        self,
        *args,
        opencode_root: str | Path,
        max_rounds: int = 3,
        observed_timeout_sec: int = 2700,
        worker_timeout_sec: int = 3000,
        opencode_timeout_sec: int = 1200,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._opencode_root = Path(opencode_root).resolve()
        self._max_rounds = max_rounds
        self._observed_timeout_sec = observed_timeout_sec
        self._worker_timeout_sec = worker_timeout_sec
        self._opencode_timeout_sec = opencode_timeout_sec

    @staticmethod
    @override
    def name() -> str:
        return "opencode-pact"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        self._validate_assets()
        await super().install(environment)
        await self.exec_as_root(
            environment,
            command="apt-get install -y ca-certificates git unzip",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "curl -fsSL https://bun.sh/install | bash; "
                'export PATH="$HOME/.bun/bin:$PATH"; '
                "bun --version"
            ),
        )
        await self.exec_as_root(
            environment,
            command=(
                "mkdir -p /opt/opencode-pact/config/plugins/pact "
                "/opt/opencode-pact/config/agent /logs/agent; "
                "chmod -R a+rwX /opt/opencode-pact /logs/agent"
            ),
        )
        await environment.upload_dir(
            self._opencode_root / ".opencode" / "plugins" / "pact",
            "/opt/opencode-pact/config/plugins/pact",
        )
        await environment.upload_file(
            self._opencode_root / ".opencode" / "plugins" / "pact.ts",
            "/opt/opencode-pact/config/plugins/pact.ts",
        )
        await environment.upload_file(
            self._opencode_root
            / ".opencode"
            / "plugins"
            / "pact"
            / "harbor"
            / "assets"
            / "opencode-observed.sh",
            "/opt/opencode-pact/opencode-observed",
        )
        await environment.upload_file(
            self._opencode_root
            / ".opencode"
            / "plugins"
            / "pact"
            / "harbor"
            / "assets"
            / "opencode-observed-text.sh",
            "/opt/opencode-pact/opencode-observed-text",
        )
        await environment.upload_file(
            self._opencode_root
            / ".opencode"
            / "plugins"
            / "pact"
            / "harbor"
            / "assets"
            / "isolate-git-history.sh",
            _ISOLATION_SCRIPT,
        )
        for prompt in sorted(
            (self._opencode_root / ".opencode" / "agent").glob("pact-*.md")
        ):
            await environment.upload_file(
                prompt, f"/opt/opencode-pact/config/agent/{prompt.name}"
            )

        config_path = self.logs_dir / "setup" / "opencode-pact.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(self._config(), indent=2) + "\n")
        await environment.upload_file(
            config_path, "/opt/opencode-pact/config/opencode.json"
        )
        await self.exec_as_root(
            environment,
            command=(
                "chmod -R a+rwX /opt/opencode-pact /logs/agent; "
                "chmod a+x /opt/opencode-pact/opencode-observed "
                "/opt/opencode-pact/opencode-observed-text "
                f"{_ISOLATION_SCRIPT}"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "test -s /opt/opencode-pact/config/agent/pact-planner.md; "
                "test -s /opt/opencode-pact/config/agent/pact-reviewer.md; "
                "test -s /opt/opencode-pact/config/agent/pact-worker.md"
            ),
            env={
                "OPENCODE_CONFIG": "/opt/opencode-pact/config/opencode.json",
                "OPENCODE_CONFIG_DIR": "/opt/opencode-pact/config",
                "OPENCODE_FAKE_VCS": "git",
            },
            timeout_sec=30,
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._instruction = instruction
        problem_path = self.logs_dir / "pact-problem.md"
        problem_path.write_text(instruction)
        await environment.upload_file(problem_path, "/tmp/pact-problem.md")

        project_root = await _isolate_repository(self, environment)
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in provider/model format")

        env = {
            "OPENCODE_CONFIG": "/opt/opencode-pact/config/opencode.json",
            "OPENCODE_CONFIG_DIR": "/opt/opencode-pact/config",
            "OPENCODE_FAKE_VCS": "git",
            "PACT_PLUGIN_PATH": "/opt/opencode-pact/config/plugins/pact.ts",
            "OPENCODE_OBSERVED_TIMEOUT_SEC": str(self._observed_timeout_sec),
            "PACT_WORKER_TIMEOUT_MS": str(self._worker_timeout_sec * 1000),
            "PACT_OPENCODE_TIMEOUT_MS": str(self._opencode_timeout_sec * 1000),
            "XDG_DATA_HOME": "/logs/agent/opencode/xdg-data",
            "XDG_STATE_HOME": "/logs/agent/opencode/xdg-state",
        }
        args = [
            "bun",
            "/opt/opencode-pact/config/plugins/pact/pact-run-driver.ts",
            "--project-root",
            project_root,
            "--plan-file",
            "/tmp/pact-problem.md",
            "--max-rounds",
            str(self._max_rounds),
            "--model",
            self.model_name,
            "--opencode-command",
            "/opt/opencode-pact/opencode-observed-text",
            "--planner-backend",
            "opencode-cli",
            "--planner-model",
            self.model_name,
            "--planner-agent",
            "pact-planner",
            "--reviewer-backend",
            "opencode-cli",
            "--reviewer-model",
            self.model_name,
            "--reviewer-agent",
            "pact-reviewer",
            "--worker-agent",
            "pact-worker",
            "--worker-opencode-command",
            "/opt/opencode-pact/opencode-observed",
            "--worker-output-format",
            "json",
            "--worker-runner",
            "host",
            "--session-strategy",
            "new-per-round",
        ]
        driver = " ".join(shlex.quote(value) for value in args)
        root = shlex.quote(project_root)
        command = (
            "set -o pipefail; "
            "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
            'export PATH="$HOME/.bun/bin:$PATH"; '
            f"{driver} 2>&1 </dev/null | stdbuf -oL tee /logs/agent/pact-driver.txt; "
            "status=${PIPESTATUS[0]}; "
            "printf '%s\\n' \"$status\" > /logs/agent/agent-exit-code.txt; "
            "mkdir -p /logs/agent/pact; "
            f"if [ -d {root}/.pact ]; then cp -R {root}/.pact/. /logs/agent/pact/; fi; "
            f"{_capture_patch_command(project_root)}"
            'if [ "$status" -eq 0 ] && [ "$capture_status" -ne 0 ]; then '
            "status=$capture_status; fi; "
            "exit $status"
        )
        result = await environment.exec(
            command,
            cwd=project_root,
            env=env,
            timeout_sec=None,
        )
        if result.return_code != 0:
            raise self._classify_exec_error(driver, result)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        events = self._worker_events()
        if not events:
            return
        (self.logs_dir / self._OUTPUT_FILENAME).write_text(
            "\n".join(json.dumps(event, separators=(",", ":")) for event in events)
            + "\n"
        )
        super().populate_context_post_run(context)

    def _worker_events(self) -> list[dict[str, object]]:
        events: list[dict[str, object]] = []
        for path in sorted(
            (self.logs_dir / "pact" / "loops").glob("*/round-*-trajectory.json")
        ):
            artifact = json.loads(path.read_text())
            for entry in artifact.get("entries", []):
                if entry.get("type") != "driver_invocation":
                    continue
                for line in str(entry.get("stdout", "")).splitlines():
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(event, dict):
                        events.append(event)
        return events

    def _validate_assets(self) -> None:
        required = [
            self._opencode_root / ".opencode" / "plugins" / "pact.ts",
            self._opencode_root
            / ".opencode"
            / "plugins"
            / "pact"
            / "pact-run-driver.ts",
            self._opencode_root / ".opencode" / "agent" / "pact-planner.md",
            self._opencode_root / ".opencode" / "agent" / "pact-reviewer.md",
            self._opencode_root / ".opencode" / "agent" / "pact-worker.md",
            self._opencode_root
            / ".opencode"
            / "plugins"
            / "pact"
            / "harbor"
            / "assets"
            / "opencode-observed.sh",
            self._opencode_root
            / ".opencode"
            / "plugins"
            / "pact"
            / "harbor"
            / "assets"
            / "opencode-observed-text.sh",
            self._opencode_root
            / ".opencode"
            / "plugins"
            / "pact"
            / "harbor"
            / "assets"
            / "isolate-git-history.sh",
        ]
        missing = [str(path) for path in required if not path.is_file()]
        if missing:
            raise ValueError("Missing PACT assets: " + ", ".join(missing))
        if self._max_rounds < 1:
            raise ValueError("max_rounds must be at least 1")
        for name, value in [
            ("observed_timeout_sec", self._observed_timeout_sec),
            ("worker_timeout_sec", self._worker_timeout_sec),
            ("opencode_timeout_sec", self._opencode_timeout_sec),
        ]:
            if value < 1:
                raise ValueError(f"{name} must be at least 1")

    def _config(self) -> dict[str, object]:
        if not self.model_name:
            raise ValueError("OpenCodePACT requires a model")
        return {
            "$schema": "https://opencode.ai/config.json",
            "model": self.model_name,
            "small_model": self.model_name,
            "provider": {
                "yunwu": {
                    "name": "Yunwu",
                    "api": "openai",
                    "options": {
                        "baseURL": "https://yunwu.ai/v1",
                        "apiKey": "{env:YUNWU_API_KEY}",
                    },
                    "models": {self.model_name.split("/", 1)[-1]: {}},
                }
            },
        }


class OpenCodeObserved(OpenCode):
    """OpenCode runner that safely closes a CLI stuck after a terminal event."""

    _OBSERVED_RUNNER = "/opt/opencode-pact/opencode-observed"
    _OPENCODE_BIN = "/opt/opencode-pact/opencode"

    def __init__(self, *args, observed_timeout_sec: int = 21600, **kwargs):
        super().__init__(*args, **kwargs)
        if observed_timeout_sec < 1:
            raise ValueError("observed_timeout_sec must be at least 1")
        self._observed_timeout_sec = observed_timeout_sec

    @staticmethod
    @override
    def name() -> str:
        return "opencode-observed"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        resolved = await self.exec_as_agent(
            environment,
            command=(
                "if [ -s ~/.nvm/nvm.sh ]; then "
                ". ~/.nvm/nvm.sh; nvm use 22 >/dev/null; fi; "
                "command -v opencode"
            ),
        )
        opencode_bin = resolved.stdout.strip()
        if not opencode_bin.startswith("/") or "\n" in opencode_bin:
            raise RuntimeError(
                f"Unable to resolve the installed OpenCode executable: {opencode_bin!r}"
            )
        await self.exec_as_root(
            environment,
            command=(
                "mkdir -p /opt/opencode-pact; "
                f"ln -sfn -- {shlex.quote(opencode_bin)} {shlex.quote(self._OPENCODE_BIN)}; "
                "chmod a+rwX /opt/opencode-pact"
            ),
        )
        await environment.upload_file(
            Path(__file__).parent.parent / "assets" / "opencode-observed.sh",
            self._OBSERVED_RUNNER,
        )
        await environment.upload_file(
            Path(__file__).parent.parent / "assets" / "isolate-git-history.sh",
            _ISOLATION_SCRIPT,
        )
        await self.exec_as_root(
            environment,
            command=f"chmod a+x {self._OBSERVED_RUNNER} {_ISOLATION_SCRIPT}",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._instruction = instruction
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in provider/model format")
        project_root = await _isolate_repository(self, environment)

        env = {
            "OPENCODE_FAKE_VCS": "git",
            "OPENCODE_OBSERVED_TIMEOUT_SEC": str(self._observed_timeout_sec),
            "XDG_DATA_HOME": "/logs/agent/opencode/xdg-data",
            "XDG_STATE_HOME": "/logs/agent/opencode/xdg-state",
        }
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command, env=env)
        config_command = self._build_register_config_command()
        if config_command:
            await self.exec_as_agent(environment, command=config_command, env=env)

        flags = self.build_cli_flags()
        flags_arg = f"{flags} " if flags else ""
        resume = "--continue " if self._resume else ""
        await self.exec_as_agent(
            environment,
            command=self._observed_command(
                shlex.quote(instruction),
                resume,
                flags_arg,
                _capture_patch_command(project_root),
            ),
            env=env,
        )
        if messages := self._error_messages():
            raise NonZeroAgentExitCodeError(
                "OpenCode emitted error event(s): " + "; ".join(messages[:3])
            )

    def _observed_command(
        self,
        instruction: str,
        resume: str,
        flags: str,
        finalizer: str = "",
    ) -> str:
        return (
            "if [ -s ~/.nvm/nvm.sh ]; then "
            ". ~/.nvm/nvm.sh; nvm use 22 >/dev/null; fi; "
            f"OPENCODE_BIN={shlex.quote(self._OPENCODE_BIN)} "
            f"{self._OBSERVED_RUNNER} --model={shlex.quote(self.model_name or '')} "
            f"run --format=json {resume}{flags}--thinking --dangerously-skip-permissions -- {instruction} "
            "2>&1 </dev/null | stdbuf -oL tee /logs/agent/opencode.txt; "
            "status=${PIPESTATUS[0]}; "
            "printf '%s\\n' \"$status\" > /logs/agent/agent-exit-code.txt; "
            f"{finalizer}"
            'if [ "$status" -eq 0 ] && [ "${capture_status:-0}" -ne 0 ]; then '
            "status=$capture_status; fi; "
            'exit "$status"'
        )
