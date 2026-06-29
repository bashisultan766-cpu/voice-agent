"""
Runtime identity diagnostics (v4.25).

Proves which code tree, git revision, and feature flags the live process is
actually serving. Used at startup and by ``python -m app.scripts.runtime_identity_check``.
"""
from __future__ import annotations

import importlib
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import llm_tools
from .commerce_flow_state import COMMERCE_FLOW_VERSION
from .master_prompt import load_master_prompt, prompt_startup_diagnostic
from .tool_progress import TOOL_PROGRESS_ENABLED, dispatch_with_progress
from ..payment.email_state import (
    CREATE_CHECKOUT_CUSTOMER_FACING,
    EMAIL_CAPTURE_SHORT_CIRCUIT_ENABLED,
    PAYMENT_AUTO_SEND_ENABLED,
    PAYMENT_EMAIL_STATE_VERSION,
    SEND_PAYMENT_LINK_CUSTOMER_FACING,
)
from ..payment.payment_state_machine import process_payment_turn

# Minimum expected master prompt size on current release branch.
MIN_MASTER_PROMPT_CHARS = 12_000
MIN_MASTER_PROMPT_SECTIONS = 9
EXPECTED_MASTER_PROMPT_SECTIONS = 10

V4_FILES = (
    "app/agent_runtime/commerce_flow_state.py",
    "app/agent_runtime/tool_progress.py",
    "app/agent_runtime/runtime_identity.py",
    "app/payment/email_state.py",
    "app/payment/payment_state_machine.py",
    "app/payment/payment_link_service.py",
    "app/scripts/runtime_identity_check.py",
)


def _git(cmd: list[str], cwd: Path) -> str:
    try:
        return subprocess.check_output(
            cmd,
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def _git_status_clean(cwd: Path) -> bool:
    try:
        out = subprocess.check_output(
            ["git", "status", "--porcelain"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return not out.strip()
    except Exception:  # noqa: BLE001
        return False


def _module_file(mod_name: str) -> str:
    try:
        mod = importlib.import_module(mod_name)
        return str(Path(getattr(mod, "__file__", "") or "").resolve())
    except Exception:  # noqa: BLE001
        return "missing"


def _find_git_root(start: Path) -> Path:
    p = start.resolve()
    for _ in range(6):
        if (p / ".git").exists():
            return p
        if p.parent == p:
            break
        p = p.parent
    return start.resolve()


def collect_runtime_identity(service_root: Path | None = None) -> dict[str, Any]:
    """Collect safe runtime identity — no secrets."""
    root = service_root or Path(__file__).resolve().parent.parent.parent
    git_root = _find_git_root(root)
    main_mod = importlib.import_module("app.main")
    main_file = Path(getattr(main_mod, "__file__", "") or "").resolve()
    prompt_diag = prompt_startup_diagnostic()
    mp = load_master_prompt()
    tool_spec_names = {s["function"]["name"] for s in llm_tools.tool_specs()}

    from ..config import get_settings

    settings = get_settings()
    identity: dict[str, Any] = {
        "process_cwd": str(Path.cwd().resolve()),
        "app_main_file": str(main_file),
        "active_release_path": str(root.resolve()),
        "git_root": str(git_root.resolve()),
        "python_executable": sys.executable,
        "pm2_process_name": os.environ.get("name") or os.environ.get("PM2_PROCESS_NAME") or "unknown",
        "git_commit": _git(["git", "rev-parse", "--short", "HEAD"], git_root),
        "git_branch": _git(["git", "rev-parse", "--abbrev-ref", "HEAD"], git_root),
        "git_status_clean": _git_status_clean(git_root),
        "master_prompt_path": str(Path(mp.path).resolve()),
        "master_prompt_chars": len(mp.text),
        "master_prompt_sections": len(mp.sections),
        "master_prompt_version": prompt_diag.get("version"),
        "voice_sales_flow_version": COMMERCE_FLOW_VERSION,
        "tool_progress_prompts_enabled": TOOL_PROGRESS_ENABLED,
        "payment_email_state_version": PAYMENT_EMAIL_STATE_VERSION,
        "payment_state_machine_module": _module_file("app.payment.payment_state_machine"),
        "payment_link_service_module": _module_file("app.payment.payment_link_service"),
        "email_capture_short_circuit_enabled": EMAIL_CAPTURE_SHORT_CIRCUIT_ENABLED,
        "llm_only_final_output": settings.VOICE_LLM_ONLY_FINAL_OUTPUT,
        "openai_model": settings.OPENAI_MODEL,
        "enforce_deterministic_tool_response": settings.VOICE_ENFORCE_DETERMINISTIC_TOOL_RESPONSE,
        "payment_auto_send_enabled": PAYMENT_AUTO_SEND_ENABLED,
        "create_checkout_customer_facing": CREATE_CHECKOUT_CUSTOMER_FACING,
        "send_payment_link_customer_facing": SEND_PAYMENT_LINK_CUSTOMER_FACING,
        "create_checkout_present_in_tool_specs": "create_checkout" in tool_spec_names,
        "customer_facing_tool_count": len(llm_tools.customer_facing_tool_names()),
        "voice_commerce_runtime_module": _module_file("app.runtime.voice_commerce_runtime"),
        "commerce_flow_module": _module_file("app.agent_runtime.commerce_flow_state"),
        "tool_progress_module": _module_file("app.agent_runtime.tool_progress"),
        "email_state_module": _module_file("app.payment.email_state"),
        "process_payment_turn_imported": process_payment_turn is not None,
        "dispatch_with_progress_imported": dispatch_with_progress is not None,
        "v4_files_present": {rel: (root / rel).is_file() for rel in V4_FILES},
    }
    return identity


def validate_runtime_identity(identity: dict[str, Any]) -> list[str]:
    """Return list of failure reasons. Empty list means identity checks passed."""
    failures: list[str] = []

    if identity.get("master_prompt_chars", 0) < MIN_MASTER_PROMPT_CHARS:
        failures.append(
            f"master_prompt_chars_low={identity.get('master_prompt_chars')} "
            f"expected>={MIN_MASTER_PROMPT_CHARS} (VPS may be on old prompt ~6980)"
        )
    if identity.get("create_checkout_present_in_tool_specs"):
        failures.append("create_checkout_exposed_to_llm")
    if not identity.get("email_capture_short_circuit_enabled") and not identity.get("llm_only_final_output"):
        failures.append("email_capture_short_circuit_disabled")
    if not identity.get("tool_progress_prompts_enabled"):
        failures.append("tool_progress_disabled")
    if identity.get("llm_only_final_output") and identity.get("openai_model") != "gpt-4o":
        failures.append(f"openai_model_weak={identity.get('openai_model')}")
    if identity.get("voice_sales_flow_version") != "v4.52":
        failures.append(f"voice_sales_flow_version={identity.get('voice_sales_flow_version')}")
    if not identity.get("process_payment_turn_imported"):
        failures.append("process_payment_turn_missing")
    if not identity.get("dispatch_with_progress_imported"):
        failures.append("tool_progress_module_missing")
    for rel, present in (identity.get("v4_files_present") or {}).items():
        if not present:
            failures.append(f"missing_file:{rel}")
    if identity.get("payment_email_state_version") != "v4.33":
        failures.append(f"payment_email_state_version={identity.get('payment_email_state_version')}")
    if identity.get("payment_state_machine_module", "").endswith("missing"):
        failures.append("payment_state_machine_missing")
    if identity.get("payment_link_service_module", "").endswith("missing"):
        failures.append("payment_link_service_missing")

    return failures
