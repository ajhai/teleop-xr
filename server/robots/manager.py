"""
Robot manager module to manage robot instances
"""

import json
import logging
import threading
import time
from typing import Any, Dict, List, Optional

from server.robots.factory import create_robot
from server.robots.robot import JointState, RobotInterface, RobotState

# Configure logging
logger = logging.getLogger(__name__)


class RobotManager:
    def __init__(self):
        self.robots: Dict[str, RobotInterface] = {}
        self.robot_configs: Dict[str, Dict] = {}
        self._lock = threading.RLock()

    def load_robot_config(self, robot_id: str, config: Dict[str, Any]) -> None:
        """
        Load a robot configuration and store it
        """
        with self._lock:
            self.robot_configs[robot_id] = config
            logger.info(f"Loaded configuration for robot {robot_id}")

    def get_robot(self, robot_id: str) -> Optional[RobotInterface]:
        """
        Get a robot instance, creating it if necessary
        """
        with self._lock:
            # If robot already exists, return it
            if robot_id in self.robots:
                return self.robots[robot_id]

            # Don't automatically create it - just check if config exists
            if robot_id in self.robot_configs:
                logger.debug(f"Robot {robot_id} has config but no instance yet - will be created on connect")
                return None

            logger.warning(f"No configuration found for robot {robot_id}")
            return None

    def connect_robot(self, robot_id: str) -> bool:
        """
        Connect to a robot, creating the instance if necessary
        """
        with self._lock:
            try:
                # Check if we have a config for this robot
                if robot_id not in self.robot_configs:
                    logger.error(f"No configuration found for robot {robot_id}")
                    return False

                # Create robot instance if it doesn't exist
                if robot_id not in self.robots:
                    logger.info(f"Creating new instance for robot {robot_id}")
                    config = self.robot_configs[robot_id]
                    robot = create_robot(robot_id, config)
                    if not robot:
                        logger.error(f"Failed to create robot instance for {robot_id}")
                        return False
                    self.robots[robot_id] = robot

                # Get the robot instance
                robot = self.robots[robot_id]

                # Connect to the robot
                if robot.state != RobotState.CONNECTED:
                    logger.info(f"Connecting to robot {robot_id}")
                    if not robot.connect():
                        logger.error(f"Failed to connect to robot {robot_id}")
                        return False
                    logger.info(f"Successfully connected to robot {robot_id}")

                    # Start monitoring the robot state
                    logger.info(f"Starting monitoring for robot {robot_id}")
                    robot.start_monitoring(update_interval=0.1)  # Update every 100ms

                return True
            except Exception as e:
                logger.error(f"Error connecting to robot {robot_id}: {e}")
                return False

    def disconnect_robot(self, robot_id: str) -> bool:
        """
        Disconnect from a robot
        """
        with self._lock:
            if robot_id not in self.robots:
                logger.warning(f"No robot instance found for {robot_id}")
                return False

            try:
                robot = self.robots[robot_id]

                # Stop monitoring first
                logger.info(f"Stopping monitoring for robot {robot_id}")
                robot.stop_monitoring()

                # Then disconnect
                logger.info(f"Disconnecting robot {robot_id}")
                success = robot.disconnect()

                if success:
                    # Remove the robot instance
                    del self.robots[robot_id]
                    logger.info(f"Successfully disconnected robot {robot_id}")
                else:
                    logger.error(f"Failed to disconnect robot {robot_id}")

                return success
            except Exception as e:
                logger.error(f"Error disconnecting robot {robot_id}: {e}")
                return False

    def _get_joint_correction_params(self, robot_id: str, joint_name: str) -> Dict[str, float]:
        """
        Get orientation correction parameters for a joint
        """
        # Default correction (no adjustment)
        default_correction = {"offset": 0.0, "direction": 1.0}

        # Get robot config
        robot_config = self.robot_configs.get(robot_id, {})
        joint_groups = robot_config.get("joint_groups", [])

        # Search for joint in all joint groups
        for group in joint_groups:
            joints = group.get("joints", [])
            for joint in joints:
                if isinstance(joint, dict) and joint.get("name") == joint_name:
                    # Return correction if it exists, otherwise return default
                    correction = joint.get("orientation_correction", default_correction)
                    logger.debug(f"Found correction for joint {joint_name}: {correction}")
                    return correction

        logger.debug(f"No correction found for joint {joint_name}, using default")
        return default_correction

    def _apply_correction_to_position(
        self, robot_id: str, joint_name: str, position: float, reverse: bool = False
    ) -> float:
        """
        Apply orientation correction to a joint position in degrees
        If reverse=False: physical_position -> frontend_position (getting state from hardware)
        If reverse=True: frontend_position -> physical_position (setting position to hardware)
        """
        correction = self._get_joint_correction_params(robot_id, joint_name)
        offset = correction.get("offset", 0.0)
        direction = correction.get("direction", 1.0)

        if direction == 0:
            logger.warning(f"Invalid direction of 0 for joint {joint_name}, using 1 instead")
            direction = 1.0

        if reverse:
            # Converting from frontend (UI) to physical (hardware)
            corrected_position = (position - offset) * direction
        else:
            # Converting from physical (hardware) to frontend (UI)
            corrected_position = offset + (position * direction)

        logger.debug(
            f"Joint {joint_name}: {'frontend->physical' if reverse else 'physical->frontend'} "
            f"transformation {position:.2f}° -> {corrected_position:.2f}° "
            f"(offset={offset:.2f}°, direction={direction:.2f})"
        )
        return corrected_position

    def get_joint_states(self, robot_id: str) -> Dict[str, Dict[str, JointState]]:
        """
        Get the joint states for all joint groups of a robot

        Returns a dictionary mapping joint group names to dictionaries of joint names to joint states
        """
        with self._lock:
            if robot_id not in self.robots:
                logger.warning(f"No robot instance found for {robot_id}")
                return {}

            robot = self.robots[robot_id]
            if robot.state != RobotState.CONNECTED:
                logger.warning(f"Robot {robot_id} is not connected")
                return {}

            # Get joint states from the robot
            joint_states = robot.get_all_joint_states()

            # Get the robot configuration to find joint groups
            robot_config = self.robot_configs.get(robot_id, {})
            joint_groups = robot_config.get("joint_groups", [])

            # If no joint groups defined, fall back to using a default name
            if not joint_groups:
                logger.warning(f"No joint groups found in config for robot {robot_id}, using default group name")
                return {"Default Joint Group": joint_states}

            # Create a mapping of joints to their joint groups
            joint_to_group_map = {}
            for group in joint_groups:
                group_name = group.get("name", "Unknown Group")
                joints = group.get("joints", [])
                for joint in joints:
                    if isinstance(joint, dict) and "name" in joint:
                        joint_to_group_map[joint["name"]] = group_name

            # Group joint states by joint group
            result = {}
            if joint_to_group_map:
                # If we have a mapping, use it to distribute joints to their groups
                for joint_name, joint_state in joint_states.items():
                    # Apply orientation correction to the joint position
                    corrected_position = self._apply_correction_to_position(
                        robot_id, joint_name, joint_state.position, reverse=False
                    )

                    # Create a new joint state with the corrected position
                    corrected_joint_state = JointState(
                        position=corrected_position,
                        velocity=joint_state.velocity,
                        effort=joint_state.effort,
                        timestamp=joint_state.timestamp,
                    )

                    group_name = joint_to_group_map.get(joint_name)
                    if group_name:
                        if group_name not in result:
                            result[group_name] = {}
                        result[group_name][joint_name] = corrected_joint_state
                    else:
                        # If joint is not mapped to any group, put in "Unmapped Joints" group
                        if "Unmapped Joints" not in result:
                            result["Unmapped Joints"] = {}
                        result["Unmapped Joints"][joint_name] = corrected_joint_state
            else:
                # If no joint mapping found, assume all joints belong to the first joint group
                # Apply corrections to all joints
                corrected_states = {}
                for joint_name, joint_state in joint_states.items():
                    corrected_position = self._apply_correction_to_position(
                        robot_id, joint_name, joint_state.position, reverse=False
                    )

                    corrected_states[joint_name] = JointState(
                        position=corrected_position,
                        velocity=joint_state.velocity,
                        effort=joint_state.effort,
                        timestamp=joint_state.timestamp,
                    )

                if joint_groups:
                    first_group_name = joint_groups[0].get("name", "Default Joint Group")
                    result[first_group_name] = corrected_states
                else:
                    result["Default Joint Group"] = corrected_states

            return result

    def set_joint_positions(self, robot_id: str, group_id: str, positions: Dict[str, float]) -> bool:
        """
        Set joint positions for a specific joint group of a robot
        """
        with self._lock:
            if robot_id not in self.robots:
                logger.warning(f"No robot instance found for {robot_id}")
                return False

            robot = self.robots[robot_id]
            if robot.state != RobotState.CONNECTED:
                logger.warning(f"Robot {robot_id} is not connected")
                return False

            # Apply reverse correction to each joint position
            corrected_positions = {}
            for joint_name, position in positions.items():
                corrected_position = self._apply_correction_to_position(robot_id, joint_name, position, reverse=True)
                corrected_positions[joint_name] = corrected_position

            logger.info(
                f"Setting joint positions for robot {robot_id}, joint group {group_id}: "
                f"original={positions}, corrected={corrected_positions}"
            )
            return robot.set_all_joint_positions(corrected_positions)

    def get_camera_images(self, robot_id: str) -> Dict[str, Any]:
        """
        Get the latest camera images from a robot
        """
        with self._lock:
            if robot_id not in self.robots:
                logger.warning(f"No robot instance found for {robot_id}")
                return {}

            robot = self.robots[robot_id]
            if robot.state != RobotState.CONNECTED:
                logger.warning(f"Robot {robot_id} is not connected")
                return {}

            return robot.get_camera_images()

    def cleanup(self):
        """
        Disconnect all robots
        """
        with self._lock:
            for robot_id, robot in self.robots.items():
                try:
                    if robot.state == RobotState.CONNECTED:
                        logger.info(f"Disconnecting robot {robot_id} during cleanup")
                        robot.disconnect()
                except Exception as e:
                    logger.error(f"Error disconnecting robot {robot_id} during cleanup: {e}")

            self.robots.clear()
            logger.info("All robots disconnected")


# Create a singleton robot manager instance
robot_manager = RobotManager()
