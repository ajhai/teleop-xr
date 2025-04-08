"""
Logging utilities for the server
"""

import logging
from typing import Dict

# Configure logging at module level
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
)

# Cache of loggers
_loggers: Dict[str, logging.Logger] = {}


def get_logger(name: str) -> logging.Logger:
    """
    Get a logger with the specified name

    Args:
        name: Name of the logger

    Returns:
        Logger instance
    """
    if name not in _loggers:
        logger = logging.getLogger(name)
        _loggers[name] = logger

    return _loggers[name]
