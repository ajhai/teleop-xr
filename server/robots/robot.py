import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, Optional

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)


class RobotState(Enum):
    """Enum for robot states"""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


@dataclass
class JointState:
    """Data class for joint state"""

    position: float
    velocity: float
    effort: float
    timestamp: float


class RobotInterface(ABC):
    """Abstract base class for robot interfaces"""

    def __init__(self, robot_id: str, config: Dict[str, Any] = {}):
        self.robot_id = robot_id
        self.config = config
        self.state = RobotState.DISCONNECTED
        self.joint_states: Dict[str, JointState] = {}
        self._stop_monitoring = False
        self._monitor_thread = None
        self.menu_config = config.get("menu", [])
        self.camera_images = {}  # Store latest camera images

        # Command handlers dictionary
        self.command_handlers: Dict[str, Callable] = {}

    @abstractmethod
    def connect(self) -> bool:
        """Connect to the physical robot"""
        pass

    @abstractmethod
    def disconnect(self) -> bool:
        """Disconnect from the physical robot"""
        pass

    @abstractmethod
    def get_joint_state(self, joint_name: str) -> Optional[JointState]:
        """Get the current state of a specific joint"""
        pass

    @abstractmethod
    def set_joint_position(self, joint_name: str, position: float) -> bool:
        """Set the position of a specific joint"""
        pass

    @abstractmethod
    def get_all_joint_states(self) -> Dict[str, JointState]:
        """Get the current state of all joints"""
        pass

    @abstractmethod
    def set_all_joint_positions(self, positions: Dict[str, float]) -> bool:
        """Set the position of all joints"""
        pass

    def start_monitoring(self, update_interval: float = 0.1):
        """Start monitoring robot state in a background thread"""
        import threading

        self._stop_monitoring = False
        self._monitor_thread = threading.Thread(target=self._monitor_loop, args=(update_interval,), daemon=True)
        self._monitor_thread.start()

    def stop_monitoring(self):
        """Stop monitoring robot state"""
        self._stop_monitoring = True
        if self._monitor_thread:
            self._monitor_thread.join()

    def _monitor_loop(self, update_interval: float):
        """Background loop to monitor robot state"""
        while not self._stop_monitoring:
            try:
                self.joint_states = self.get_all_joint_states()
                time.sleep(update_interval)
            except Exception as e:
                logger.error(f"Error in monitor loop: {e}")
                self.state = RobotState.ERROR
                break

    def register_command_handler(self, command: str, handler: Callable) -> bool:
        """Register a handler for a specific command"""
        if not callable(handler):
            logger.error(f"Handler for command '{command}' is not callable")
            return False

        self.command_handlers[command] = handler
        logger.info(f"Registered handler for command '{command}'")
        return True

    def execute_command(self, command: str, **kwargs) -> Any:
        """Execute a registered command"""
        if command not in self.command_handlers:
            logger.error(f"No handler registered for command '{command}'")
            return False

        try:
            logger.info(f"Executing command '{command}' with args: {kwargs}")

            menu_item = next((item for item in self.menu_config if item["command"] == command), None)
            command_config = menu_item.get("config", {}) if menu_item else {}

            return self.command_handlers[command](command_config, **kwargs)
        except Exception as e:
            logger.exception(f"Error executing command '{command}': {e}")
            return False

    def get_camera_images(self) -> Dict[str, Any]:
        """Get the current camera images from the robot"""
        # This is a default implementation that returns the stored camera images
        # Subclasses can override this method to provide custom implementations
        return self.camera_images


class LoggingRobotInterface(RobotInterface):
    """Implementation of RobotInterface that logs state changes"""

    def __init__(self, robot_id: str):
        super().__init__(robot_id)
        self._connected = False
        self._last_update = 0.0
        self._joint_names = ["Rotation", "Pitch", "Elbow", "Wrist_Pitch", "Wrist_Roll", "Jaw"]
        self._current_positions = {name: 0.0 for name in self._joint_names}
        self._target_positions = {name: 0.0 for name in self._joint_names}
        self._movement_speed = 0.1  # radians per update

    def connect(self) -> bool:
        """Simulate connecting to the robot"""
        logger.info(f"Connecting to robot {self.robot_id}...")
        self.state = RobotState.CONNECTING
        time.sleep(1)  # Simulate connection delay
        self._connected = True
        self.state = RobotState.CONNECTED
        logger.info(f"Connected to robot {self.robot_id}")
        return True

    def disconnect(self) -> bool:
        """Simulate disconnecting from the robot"""
        logger.info(f"Disconnecting from robot {self.robot_id}...")
        self._connected = False
        self.state = RobotState.DISCONNECTED
        logger.info(f"Disconnected from robot {self.robot_id}")
        return True

    def get_joint_state(self, joint_name: str) -> Optional[JointState]:
        """Get the current state of a specific joint"""
        if not self._connected:
            logger.warning(f"Cannot get joint state: robot {self.robot_id} not connected")
            return None

        if joint_name not in self._current_positions:
            logger.warning(f"Joint {joint_name} not found in robot {self.robot_id}")
            return None

        current_time = time.time()
        return JointState(
            position=self._current_positions[joint_name], velocity=0.0, effort=0.0, timestamp=current_time
        )

    def set_joint_position(self, joint_name: str, position: float) -> bool:
        """Set the position of a specific joint"""
        if not self._connected:
            logger.warning(f"Cannot set joint position: robot {self.robot_id} not connected")
            return False

        if joint_name not in self._target_positions:
            logger.warning(f"Joint {joint_name} not found in robot {self.robot_id}")
            return False

        logger.info(f"Setting joint {joint_name} target position to {position}")
        self._target_positions[joint_name] = position
        return True

    def get_all_joint_states(self) -> Dict[str, JointState]:
        """Get the current state of all joints"""
        if not self._connected:
            logger.warning(f"Cannot get joint states: robot {self.robot_id} not connected")
            return {}

        # Update positions to move towards targets
        current_time = time.time()
        dt = current_time - self._last_update
        if dt > 0:
            for joint_name in self._joint_names:
                current = self._current_positions[joint_name]
                target = self._target_positions[joint_name]
                if abs(target - current) > 0.001:  # Only move if there's a significant difference
                    # Calculate movement direction and amount
                    direction = 1 if target > current else -1
                    movement = min(self._movement_speed * dt, abs(target - current))
                    self._current_positions[joint_name] = current + direction * movement
                    logger.debug(
                        f"Joint {joint_name} moved from {current:.3f} to {self._current_positions[joint_name]:.3f} (target: {target:.3f})"
                    )

        self._last_update = current_time

        # Create joint states
        states = {}
        for joint_name in self._joint_names:
            states[joint_name] = JointState(
                position=self._current_positions[joint_name], velocity=0.0, effort=0.0, timestamp=current_time
            )

        logger.debug(f"Current joint positions: {self._current_positions}")
        return states

    def set_all_joint_positions(self, positions: Dict[str, float]) -> bool:
        """Set the position of all joints"""
        if not self._connected:
            logger.warning(f"Cannot set joint positions: robot {self.robot_id} not connected")
            return False

        logger.info(f"Setting joint positions: {positions}")
        for joint_name, position in positions.items():
            if joint_name in self._target_positions:
                self._target_positions[joint_name] = position
            else:
                logger.warning(f"Unknown joint: {joint_name}")

        return True


# Example usage:
if __name__ == "__main__":
    # Create a logging robot interface
    robot = LoggingRobotInterface("test_robot")

    # Connect to the robot
    if robot.connect():
        # Start monitoring robot state
        robot.start_monitoring(update_interval=0.5)

        # Simulate some operations
        time.sleep(2)  # Let the monitor run for a bit

        # Set some joint positions
        positions = {"joint_0": 1.57, "joint_1": -0.5, "joint_2": 0.0}
        robot.set_all_joint_positions(positions)

        # Get current joint states
        states = robot.get_all_joint_states()
        print("Current joint states:", states)

        # Stop monitoring and disconnect
        robot.stop_monitoring()
        robot.disconnect()
