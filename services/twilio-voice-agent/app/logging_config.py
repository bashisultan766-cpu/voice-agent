from __future__ import annotations

import logging
import sys


def configure_logging(level: str = "info") -> None:
    numeric = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        level=numeric,
        format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stdout,
        force=True,
    )
    # Suppress noisy third-party loggers
    for name in ("httpx", "httpcore", "openai._base_client", "hpack"):
        logging.getLogger(name).setLevel(logging.WARNING)
