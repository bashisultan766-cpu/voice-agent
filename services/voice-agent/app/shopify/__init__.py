from .client import ShopifyClient
from .mock import MockShopifyClient


def get_shopify_client(
    domain: str | None = None,
    access_token: str | None = None,
) -> ShopifyClient:
    """
    Factory: returns a real ShopifyClient when credentials are present,
    otherwise returns the MockShopifyClient.
    Phase 2: swap in the real HTTP client here.
    """
    from ..config import get_settings
    settings = get_settings()

    if settings.SHOPIFY_USE_MOCK or not domain or not access_token:
        return MockShopifyClient()

    # Phase 2: return RealShopifyClient(domain, access_token)
    return MockShopifyClient()
