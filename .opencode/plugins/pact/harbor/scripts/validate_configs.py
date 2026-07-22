from pathlib import Path

import yaml

from harbor.models.job.config import JobConfig
from harbor.models.trial.config import TrialConfig


def main() -> None:
    root = Path(__file__).parent.parent / "configs"
    trial_configs = [
        "oracle-smoke.yaml",
        "direct-smoke.yaml",
        "direct-gpt56-default-smoke.yaml",
        "direct-gpt56-xhigh-smoke.yaml",
        "pact-smoke.yaml",
        "pact-install-smoke.yaml",
    ]
    for name in trial_configs:
        TrialConfig.model_validate(yaml.safe_load((root / name).read_text()))
    job_configs = ["direct.yaml", "pact.yaml"]
    for name in job_configs:
        JobConfig.model_validate(yaml.safe_load((root / name).read_text()))
    print(
        f"Validated {len(trial_configs)} trial configs and "
        f"{len(job_configs)} job configs."
    )


if __name__ == "__main__":
    main()
