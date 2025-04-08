"""
Robot factory module to instantiate robot implementations based on backend_type
"""

import importlib
import logging
from typing import Any, Dict, Optional

from server.robots.robot import LoggingRobotInterface, RobotInterface

# Configure logging
logger = logging.getLogger(__name__)

# Map of backend_type to robot implementation module path
# Support both slash and dot formats
ROBOT_BACKEND_MAP = {
    "lerobot.so100": "server.robots.lerobot.so100",
    "lerobot/so100": "server.robots.lerobot.so100",
}


def create_robot(robot_id: str, config: Dict[str, Any]) -> Optional[RobotInterface]:
    """
    Create a robot instance based on the backend_type specified in the config

    Args:
        robot_id: The ID of the robot
        config: The robot configuration

    Returns:
        A robot instance or None if creation fails
    """
    backend_type = config.get("backend_type", "")

    # Normalize backend_type (convert slashes to dots if present)
    normalized_backend_type = backend_type.replace("/", ".")

    if not backend_type:
        logger.warning(f"No backend_type specified for robot {robot_id}, using LoggingRobotInterface")
        return LoggingRobotInterface(robot_id)

    # Try both original and normalized backend type
    if backend_type in ROBOT_BACKEND_MAP:
        module_path = ROBOT_BACKEND_MAP[backend_type]
    elif normalized_backend_type in ROBOT_BACKEND_MAP:
        module_path = ROBOT_BACKEND_MAP[normalized_backend_type]
    else:
        logger.warning(f"Unknown backend_type {backend_type} for robot {robot_id}, using LoggingRobotInterface")
        return LoggingRobotInterface(robot_id)

    try:
        # Import the module containing the robot implementation
        module = importlib.import_module(module_path)

        # Extract the class name from the backend type (e.g., "lerobot.so100" -> "So100")
        # Use normalized type for class name extraction to ensure dots are used
        class_name = normalized_backend_type.split(".")[-1].capitalize()

        if not hasattr(module, class_name):
            logger.error(f"Robot class {class_name} not found in module {module_path}")
            return LoggingRobotInterface(robot_id)

        # Get the robot class and instantiate it with the config
        robot_class = getattr(module, class_name)
        logger.info(f"Creating robot instance of type {class_name} for robot {robot_id}")
        return robot_class(config)
    except Exception as e:
        logger.error(f"Error creating robot instance for {robot_id}: {e}")
        return LoggingRobotInterface(robot_id)
