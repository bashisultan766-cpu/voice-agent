from typing import Optional

from .schema import AgentConfig, FAQEntry
from ..config import get_settings


class TenantConfigLoader:
    """
    Phase 1: Load AgentConfig from environment variables.
    Phase 2: Load from PostgreSQL with Redis 5-minute cache.
    """

    def __init__(self) -> None:
        self._cache: dict[str, AgentConfig] = {}

    async def load_by_phone(self, phone_number: str) -> Optional[AgentConfig]:
        """Resolve a Twilio phone number to an agent config."""
        # Phase 1: single-tenant — all numbers map to the default agent
        return await self.load_default()

    async def load_by_agent_id(self, agent_id: str) -> Optional[AgentConfig]:
        if agent_id in self._cache:
            return self._cache[agent_id]
        config = await self._build_from_env(agent_id)
        self._cache[agent_id] = config
        return config

    async def load_default(self) -> AgentConfig:
        settings = get_settings()
        return await self.load_by_agent_id(settings.DEFAULT_AGENT_ID)

    async def _build_from_env(self, agent_id: str) -> AgentConfig:
        settings = get_settings()
        return AgentConfig(
            agent_id=agent_id,
            tenant_id=settings.DEFAULT_TENANT_ID,
            agent_name=settings.DEFAULT_AGENT_NAME,
            business_name=settings.DEFAULT_BUSINESS_NAME,
            voice_id=settings.OPENAI_TTS_VOICE,
            openai_api_key=settings.OPENAI_API_KEY or None,
            shopify_domain=settings.SHOPIFY_DOMAIN,
            shopify_access_token=settings.SHOPIFY_ACCESS_TOKEN,
            resend_api_key=settings.RESEND_API_KEY,
            faqs=[
                FAQEntry(
                    question="What are your store hours?",
                    answer="We are available Monday through Friday, 9am to 6pm.",
                    category="general",
                ),
                FAQEntry(
                    question="How long does shipping take?",
                    answer="Standard shipping takes 3 to 5 business days.",
                    category="shipping",
                ),
                FAQEntry(
                    question="What is your return policy?",
                    answer="We accept returns within 30 days of purchase for unopened items.",
                    category="returns",
                ),
            ],
        )

    def invalidate(self, agent_id: str) -> None:
        self._cache.pop(agent_id, None)


_loader: Optional[TenantConfigLoader] = None


def get_tenant_loader() -> TenantConfigLoader:
    global _loader
    if _loader is None:
        _loader = TenantConfigLoader()
    return _loader
