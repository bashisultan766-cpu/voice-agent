"""
Workflow contract enforcement — hard-stop guard against runtime drift.

Enforcement is active only while a canonical workflow domain is entered via
``workflow_execution`` (or ``begin_workflow_domain``). Outside that scope,
calls are not intercepted so unit tests can invoke helpers directly.
"""
from __future__ import annotations

import functools
import inspect
import logging
from contextlib import contextmanager
from contextvars import ContextVar, Token
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)

WORKFLOW_CONTRACTS_VERSION = "v1.0"

ORDER_WORKFLOW = "order_workflow"
PRODUCT_SEARCH_WORKFLOW = "product_search_workflow"
SUPPORT_HANDOFF_WORKFLOW = "support_handoff_workflow"

# Legacy aliases used by workflow_isolation and tests
WORKFLOW_ORDER = ORDER_WORKFLOW
WORKFLOW_PRODUCT = PRODUCT_SEARCH_WORKFLOW
WORKFLOW_SUPPORT = SUPPORT_HANDOFF_WORKFLOW
WORKFLOW_PAYMENT = "payment_checkout"
WORKFLOW_COMMERCE = "commerce_cart"
WORKFLOW_IDLE = "idle"

F = TypeVar("F", bound=Callable[..., Any])

_active_workflow: ContextVar[str | None] = ContextVar(
    "workflow_contract_active_domain",
    default=None,
)
_match_product_depth: ContextVar[int] = ContextVar(
    "workflow_contract_match_product_depth",
    default=0,
)

PRODUCT_SEARCH_ALLOWED: frozenset[str] = frozenset({
    "match_product",
    "similarity_engine",
    "format_exact_match_reply",
    "format_no_exact_reply",
    "support_handoff_preparation",
})

SUPPORT_HANDOFF_ALLOWED: frozenset[str] = frozenset({
    "analyze_conversation_for_support",
    "_finalize_handoff_send",
    "_validate_support_email",
    "_sync_support_handoff_contact",
})

PRODUCT_RESOLUTION_SYMBOLS: frozenset[str] = frozenset({
    "match_product",
    "similarity_engine",
    "format_exact_match_reply",
    "format_no_exact_reply",
    "product_resolution_to_short_circuit",
    "has_good_similarity_match",
})

FORBIDDEN_IN_PRODUCT_SEARCH: frozenset[str] = frozenset({
    "_catalog_search",
    "_search_products",
    "search_products",
    "try_escalate_unresolved_query",
    "handle_search_not_found_results",
    "analyze_conversation_for_support",
})

FORBIDDEN_IN_SUPPORT_HANDOFF: frozenset[str] = frozenset({
    "match_product",
    "similarity_engine",
    "product_resolution_to_short_circuit",
    "_catalog_search",
    "_search_products",
    "search_products",
    "fragment_capture_prompt",
})

DOMAIN_ALLOWLISTS: dict[str, frozenset[str]] = {
    PRODUCT_SEARCH_WORKFLOW: PRODUCT_SEARCH_ALLOWED,
    SUPPORT_HANDOFF_WORKFLOW: SUPPORT_HANDOFF_ALLOWED,
}

CANONICAL_WORKFLOW_DOMAINS: frozenset[str] = frozenset({
    ORDER_WORKFLOW,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
})


class WorkflowViolationError(RuntimeError):
    """Raised when a workflow contract rule is violated — execution must stop."""


def active_workflow_domain() -> str | None:
    return _active_workflow.get()


def _log_violation(
    *,
    active: str | None,
    domain: str,
    function_name: str,
    reason: str,
) -> None:
    logger.error(
        "workflow_contract_violation active=%s domain=%s function=%s reason=%s version=%s",
        active or "-",
        domain,
        function_name,
        reason,
        WORKFLOW_CONTRACTS_VERSION,
    )


def _raise_violation(
    *,
    active: str | None,
    domain: str,
    function_name: str,
    reason: str,
) -> None:
    _log_violation(
        active=active,
        domain=domain,
        function_name=function_name,
        reason=reason,
    )
    from ..observability.workflow_events import (
        STEP_WORKFLOW_VIOLATION_DETECTED,
        emit_event,
    )

    emit_event({
        "event_type": "workflow_transition",
        "domain": _normalize_violation_domain(active),
        "step": STEP_WORKFLOW_VIOLATION_DETECTED,
        "input_type": "unknown",
        "outcome": "fail",
        "metadata": {
            "active_workflow": active or "",
            "function_name": function_name,
            "reason": reason,
        },
    })
    raise WorkflowViolationError(
        f"Workflow contract violation [{function_name}]: {reason}",
    )


def _normalize_violation_domain(active: str | None) -> str:
    if active == PRODUCT_SEARCH_WORKFLOW:
        return "product_search"
    if active == SUPPORT_HANDOFF_WORKFLOW:
        return "support"
    if active == ORDER_WORKFLOW:
        return "order"
    return "unknown"


def validate_workflow_call(domain: str, function_name: str) -> None:
    """
    Hard-stop validation for a guarded function entry.

    Raises WorkflowViolationError when the active workflow domain forbids the call.
    """
    active = _active_workflow.get()
    if not active:
        return

    if active == ORDER_WORKFLOW and function_name in PRODUCT_RESOLUTION_SYMBOLS:
        _raise_violation(
            active=active,
            domain=domain,
            function_name=function_name,
            reason="order_workflow must not call product_resolution directly",
        )

    if active == PRODUCT_SEARCH_WORKFLOW and function_name in FORBIDDEN_IN_PRODUCT_SEARCH:
        _raise_violation(
            active=active,
            domain=domain,
            function_name=function_name,
            reason="forbidden in product_search_workflow",
        )

    if active == SUPPORT_HANDOFF_WORKFLOW and function_name in FORBIDDEN_IN_SUPPORT_HANDOFF:
        _raise_violation(
            active=active,
            domain=domain,
            function_name=function_name,
            reason="forbidden in support_handoff_workflow",
        )

    if domain != active:
        _raise_violation(
            active=active,
            domain=domain,
            function_name=function_name,
            reason=f"function belongs to {domain}, not {active}",
        )

    allowlist = DOMAIN_ALLOWLISTS.get(domain)
    if allowlist is not None and function_name not in allowlist:
        _raise_violation(
            active=active,
            domain=domain,
            function_name=function_name,
            reason=f"not in allowlist for {domain}",
        )


def validate_catalog_query_allowed(function_name: str = "_catalog_search") -> None:
    """Direct catalog queries are only legal inside match_product()."""
    active = _active_workflow.get()
    if not active:
        return

    if active == PRODUCT_SEARCH_WORKFLOW and _match_product_depth.get() <= 0:
        _raise_violation(
            active=active,
            domain=PRODUCT_SEARCH_WORKFLOW,
            function_name=function_name,
            reason="direct catalog query outside match_product()",
        )

    if active == SUPPORT_HANDOFF_WORKFLOW:
        _raise_violation(
            active=active,
            domain=SUPPORT_HANDOFF_WORKFLOW,
            function_name=function_name,
            reason="catalog lookup forbidden in support_handoff_workflow",
        )

    if active == ORDER_WORKFLOW:
        _raise_violation(
            active=active,
            domain=ORDER_WORKFLOW,
            function_name=function_name,
            reason="catalog lookup forbidden in order_workflow",
        )


def validate_external_handler_blocked(function_name: str) -> None:
    """Block legacy / parallel fallback handlers during product_search."""
    active = _active_workflow.get()
    if active == PRODUCT_SEARCH_WORKFLOW:
        _raise_violation(
            active=active,
            domain=PRODUCT_SEARCH_WORKFLOW,
            function_name=function_name,
            reason="external fallback handler forbidden in product_search_workflow",
        )


@contextmanager
def workflow_execution(domain: str):
    """Enter a canonical workflow domain for contract enforcement."""
    token = _active_workflow.set(domain)
    try:
        yield
    finally:
        _active_workflow.reset(token)


def begin_workflow_domain(domain: str) -> Token:
    return _active_workflow.set(domain)


def end_workflow_domain(token: Token) -> None:
    _active_workflow.reset(token)


def clear_turn_workflow_contract(session: Any) -> None:
    token = getattr(session, "_workflow_contract_token", None)
    if token is not None:
        end_workflow_domain(token)
        session._workflow_contract_token = None  # type: ignore[attr-defined]


def apply_turn_workflow_contract(session: Any, active_workflow: str) -> None:
    """Bind turn-level contract domain from workflow isolation resolution."""
    clear_turn_workflow_contract(session)
    if active_workflow not in CANONICAL_WORKFLOW_DOMAINS:
        return
    token = begin_workflow_domain(active_workflow)
    session._workflow_contract_token = token  # type: ignore[attr-defined]


def workflow_guard(domain: str, function_name: str | None = None) -> Callable[[F], F]:
    """Decorator — validate allowlist on function entry."""
    label = function_name or ""

    def decorator(fn: F) -> F:
        name = label or fn.__name__
        is_match_product = name == "match_product"

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                validate_workflow_call(domain, name)
                if is_match_product:
                    depth_token = _match_product_depth.set(_match_product_depth.get() + 1)
                    try:
                        return await fn(*args, **kwargs)
                    finally:
                        _match_product_depth.reset(depth_token)
                return await fn(*args, **kwargs)

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            validate_workflow_call(domain, name)
            return fn(*args, **kwargs)

        return sync_wrapper  # type: ignore[return-value]

    return decorator


def workflow_entry_guard(domain: str, function_name: str | None = None) -> Callable[[F], F]:
    """Decorator for workflow orchestrators — sets domain for the duration of the call."""
    label = function_name or ""

    def decorator(fn: F) -> F:
        name = label or fn.__name__

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                with workflow_execution(domain):
                    return await fn(*args, **kwargs)

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            with workflow_execution(domain):
                return fn(*args, **kwargs)

        return sync_wrapper  # type: ignore[return-value]

    return decorator
