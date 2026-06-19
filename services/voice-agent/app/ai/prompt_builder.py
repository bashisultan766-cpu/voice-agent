from ..state.schema import EmailFSMState, SessionState
from ..tenant.schema import AgentConfig


def build_system_prompt(agent_config: AgentConfig, state: SessionState) -> str:
    """
    Assemble the full system prompt for a turn.
    All values come from agent_config and session state — nothing is hardcoded.
    """
    base = agent_config.resolve_system_prompt()

    state_block = (
        f"\n\nCURRENT CALL STATE:\n"
        f"- Conversation state: {state.conversation_state}\n"
        f"- Selected product: "
        f"{state.selected_product.get('title') if state.selected_product else 'none'}\n"
        f"- Customer email: {state.customer_email or 'not collected yet'}\n"
        f"- Email confirmed: {state.email_fsm_state == EmailFSMState.CONFIRMED}\n"
        f"- Caller name: {state.caller_name or 'unknown'}\n"
        f"- Language: {state.language}"
    )

    policy_block = ""
    if agent_config.shipping_policy:
        policy_block += f"\nSHIPPING POLICY: {agent_config.shipping_policy}"
    if agent_config.return_policy:
        policy_block += f"\nRETURN POLICY: {agent_config.return_policy}"
    if agent_config.address_update_policy:
        policy_block += f"\nADDRESS UPDATES: {agent_config.address_update_policy}"

    faq_block = ""
    if agent_config.faqs:
        lines = "\n".join(
            f"Q: {faq.question}\nA: {faq.answer}" for faq in agent_config.faqs[:5]
        )
        faq_block = f"\n\nFREQUENTLY ASKED QUESTIONS:\n{lines}"

    caller_block = ""
    if state.caller_name:
        caller_block = f"\n\nCALLER: {state.caller_name} (use their first name)"

    return base + state_block + policy_block + faq_block + caller_block
