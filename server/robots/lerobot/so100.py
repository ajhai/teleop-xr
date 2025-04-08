import logging
import os
import queue
import random
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple, TypeVar

import torch
from lerobot.common.datasets.lerobot_dataset import LeRobotDataset
from lerobot.common.robot_devices.cameras.configs import OpenCVCameraConfig
from lerobot.common.robot_devices.control_utils import (
    sanity_check_dataset_robot_compatibility,
)
from lerobot.common.robot_devices.motors.configs import FeetechMotorsBusConfig
from lerobot.common.robot_devices.robots.utils import (
    make_robot_config,
    make_robot_from_config,
)

from server.robots.robot import JointState, RobotInterface, RobotState

logger = logging.getLogger("so100")

# Define a generic return type for the retry decorator
T = TypeVar("T")

# Define command types
COMMAND_CAPTURE = "capture_observation"
COMMAND_SEND = "send_action"
COMMAND_CONNECT = "connect"
COMMAND_DISCONNECT = "disconnect"


def retry_with_backoff(max_retries: int = 3, initial_backoff: float = 0.2):
    """
    Decorator to retry a function with exponential backoff on failure.

    Args:
        max_retries: Maximum number of retries before giving up
        initial_backoff: Initial backoff time in seconds
    """

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        def wrapper(*args, **kwargs) -> T:
            backoff = initial_backoff
            for retry in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if "Port is in use" in str(e) and retry < max_retries:
                        # Add jitter to backoff time (between 75% and 100% of backoff)
                        jitter = backoff * (0.75 + random.random() * 0.25)
                        logger.warning(
                            f"Serial port in use, retrying in {jitter:.2f}s (attempt {retry+1}/{max_retries}): {e}"
                        )
                        time.sleep(jitter)
                        # Exponential backoff (doubles each time)
                        backoff *= 2
                    else:
                        # Either it's not a port-in-use error or we've hit max retries
                        raise

        return wrapper

    return decorator


class SerialCommandProcessor:
    """
    A processor for robot serial commands that ensures they are executed sequentially
    to avoid port-in-use errors.
    """

    def __init__(self, max_queue_size=20):
        self.command_queue = queue.Queue()
        self.results = {}  # Map from command IDs to results
        self.result_ready = {}  # Map from command IDs to events
        self.command_thread = None
        self.running = False
        self.next_command_id = 0
        self.lock = threading.Lock()
        self.max_queue_size = max_queue_size
        self.dropped_commands = 0  # Counter for dropped commands

    def start(self):
        """Start the command processor thread."""
        if self.command_thread is None or not self.command_thread.is_alive():
            self.running = True
            self.command_thread = threading.Thread(target=self._process_commands, daemon=True)
            self.command_thread.start()
            logger.info("Serial command processor thread started")

    def stop(self):
        """Stop the command processor thread."""
        self.running = False
        if self.command_thread and self.command_thread.is_alive():
            self.command_thread.join(timeout=2.0)
            logger.info("Serial command processor thread stopped")

    def _process_commands(self):
        """Process commands from the queue one at a time."""
        while self.running:
            try:
                command_id, command_type, robot, args, kwargs = self.command_queue.get(timeout=0.1)
                try:
                    logger.debug(f"Processing command {command_id}: {command_type}")

                    # Execute the appropriate command based on type
                    if command_type == COMMAND_CAPTURE:
                        result = robot.capture_observation()
                    elif command_type == COMMAND_SEND:
                        result = robot.send_action(*args)
                    elif command_type == COMMAND_CONNECT:
                        result = robot.connect()
                    elif command_type == COMMAND_DISCONNECT:
                        result = robot.disconnect()
                    else:
                        logger.error(f"Unknown command type: {command_type}")
                        result = None

                    # Store the result and notify waiting threads
                    with self.lock:
                        self.results[command_id] = (result, None)  # (result, exception)
                        if command_id in self.result_ready:
                            self.result_ready[command_id].set()

                except Exception as e:
                    logger.error(f"Error executing command {command_id} ({command_type}): {e}")
                    with self.lock:
                        self.results[command_id] = (None, e)
                        if command_id in self.result_ready:
                            self.result_ready[command_id].set()

                finally:
                    self.command_queue.task_done()

            except queue.Empty:
                # No commands in queue, just continue
                pass

    def _clean_old_commands(self):
        """
        Remove old commands from the queue when it exceeds the maximum size.
        This helps prevent backlog when commands are coming in faster than they can be processed.
        """
        # We'll keep removing commands until we're at 75% of max capacity
        target_size = int(self.max_queue_size * 0.75)

        while self.command_queue.qsize() > target_size:
            try:
                # Get and remove the oldest command
                command_id, command_type, _, _, _ = self.command_queue.get(block=False)
                self.command_queue.task_done()

                # Mark the command as failed
                with self.lock:
                    if command_id in self.result_ready:
                        self.results[command_id] = (
                            None,
                            Exception(f"Command {command_id} ({command_type}) dropped due to queue overflow"),
                        )
                        self.result_ready[command_id].set()

                self.dropped_commands += 1
                if self.dropped_commands % 10 == 1:  # Log every 10th drop or the first one
                    logger.warning(
                        f"Dropped command {command_id} ({command_type}) due to queue overflow. "
                        f"Total dropped: {self.dropped_commands}"
                    )
            except queue.Empty:
                # Queue is empty, which shouldn't happen but break just in case
                break

    def execute_command(self, command_type: str, robot, *args, **kwargs) -> Tuple[Any, Optional[Exception]]:
        """
        Queue a command for execution and wait for its result.

        Args:
            command_type: Type of command to execute
            robot: Robot object to execute the command on
            *args, **kwargs: Arguments to pass to the command

        Returns:
            Tuple of (result, exception) where exception is None if the command succeeded
        """
        # Check if queue is too full - if so, clean out old commands
        if self.command_queue.qsize() >= self.max_queue_size:
            logger.warning(
                f"Command queue size ({self.command_queue.qsize()}) has reached maximum ({self.max_queue_size}). "
                f"Dropping older commands."
            )
            self._clean_old_commands()

        # Generate a unique command ID
        with self.lock:
            command_id = self.next_command_id
            self.next_command_id += 1
            event = threading.Event()
            self.result_ready[command_id] = event

        # Add the command to the queue
        self.command_queue.put((command_id, command_type, robot, args, kwargs))

        # Wait for the result
        event.wait()

        # Get and return the result
        with self.lock:
            result = self.results.pop(command_id)
            self.result_ready.pop(command_id)

        return result


class So100(RobotInterface):
    def __init__(self, config: Dict[str, Any] = {}):
        # Use robot_id from config if available, otherwise default to "so100"
        robot_id = config.get("robot_id", "so100")
        super().__init__(robot_id=robot_id, config=config)
        self.robot_config = make_robot_config(robot_type="so100")

        # Store joint configuration for later use
        self.joint_configs = {}
        self.joint_group_map = {}  # Maps joint group name to joint names

        # Store latest camera images
        self.camera_images = {}

        self._prepare_robot_config(config)

        self.robot = make_robot_from_config(self.robot_config)
        self._connected = False

        self._prev_joint_positions = {}

        # Initialize the command processor with a maximum queue size
        # This prevents the system from falling behind if commands are coming in too fast
        max_queue_size = config.get("max_command_queue_size", 20)
        self.command_processor = SerialCommandProcessor(max_queue_size=max_queue_size)
        logger.info(f"Initialized serial command processor with max queue size of {max_queue_size}")

        # Register command handlers
        self._register_default_command_handlers()

    def _register_default_command_handlers(self):
        """Register default command handlers for this robot"""
        # Register record command handler
        self.register_command_handler("record_episode", self._handle_record_episode_command)
        # Register play command handler
        self.register_command_handler("stop_record_episode", self._handle_stop_record_episode_command)

    def _handle_record_episode_command(self, config: Dict[str, Any], **kwargs):
        """Handle the record command"""
        logger.info(f"Robot {self.robot_id} is recording...")

        repo_id = config.get("repo_id", "test")

        # Set leader arms to follower arms to avoid shape mismatch
        self.robot.leader_arms = self.robot.follower_arms

        if os.path.exists(config.get("root", "test_root")):
            dataset = LeRobotDataset(
                repo_id=config.get("repo_id", "test"),
                root=config.get("root", "test_root"),
            )

            dataset.start_image_writer(
                num_processes=config.get("num_image_writer_processes", 1),
                num_threads=config.get("num_image_writer_threads_per_camera", 1) * len(self.robot.cameras),
            )
            sanity_check_dataset_robot_compatibility(
                dataset, self.robot, config.get("fps", 30), config.get("use_videos", False)
            )
        else:
            dataset = LeRobotDataset.create(
                repo_id=repo_id,
                fps=config.get("fps", 30),
                root=config.get("root", "test_root"),
                robot=self.robot,
                use_videos=config.get("use_videos", False),
                image_writer_processes=config.get("num_image_writer_processes", 1),
                image_writer_threads=config.get("num_image_writer_threads_per_camera", 1) * len(self.robot.cameras),
            )

        # Recording state
        self._recording = True
        self._recording_thread = None

        # Define the recording function that will run in a separate thread
        def recording_loop():
            fps = config.get("fps", 30)
            episode_time_s = config.get("episode_time_s", 10)
            task = config.get("task", "unknown")

            # Calculate target frames, but prioritize time limit
            target_frames = int(fps * episode_time_s)
            frames_captured = 0

            start_episode_t = time.perf_counter()
            logger.info(f"Recording for {episode_time_s}s, targeting {target_frames} frames at {fps} fps")

            # Set a hard time limit slightly above episode_time_s to account for last frame
            time_limit = episode_time_s * 1.01

            while frames_captured < target_frames and self._recording:
                # Check if we've exceeded the episode time
                elapsed_time = time.perf_counter() - start_episode_t
                if elapsed_time >= time_limit:
                    logger.info(f"Reached time limit of {episode_time_s}s, stopping recording")
                    break

                # Record start time of this frame
                frame_start_t = time.perf_counter()

                # Capture observation and add frame
                observation = self._process_robot_command(COMMAND_CAPTURE)
                action = {"action": observation["observation.state"]}
                frame = {**observation, **action, "task": task}
                dataset.add_frame(frame)
                frames_captured += 1

                # Calculate how long processing took
                frame_processing_time = time.perf_counter() - frame_start_t

                # Log if processing is too slow to maintain target fps
                if frame_processing_time > (1.0 / fps) and frames_captured % 5 == 0:
                    logger.warning(
                        f"Frame processing taking {frame_processing_time:.3f}s, which exceeds target frame time of {1.0/fps:.3f}s"
                    )

                # Calculate remaining time in this frame slot
                current_time = time.perf_counter()
                elapsed_since_start = current_time - start_episode_t
                next_frame_time = frames_captured / fps
                sleep_time = max(0, next_frame_time - elapsed_since_start)

                if sleep_time > 0:
                    time.sleep(sleep_time)

                # Regularly log progress
                if frames_captured % max(1, target_frames // 5) == 0:
                    current_elapsed = time.perf_counter() - start_episode_t
                    logger.info(
                        f"Recording progress: {frames_captured}/{target_frames} frames, "
                        f"time: {current_elapsed:.2f}s/{episode_time_s}s"
                    )

            # Final stats
            final_duration = time.perf_counter() - start_episode_t
            actual_fps = frames_captured / final_duration if final_duration > 0 else 0
            logger.info(
                f"Recording completed: {frames_captured} frames in {final_duration:.2f}s "
                f"(target was {target_frames} frames in {episode_time_s}s)"
            )
            logger.info(f"Actual fps: {actual_fps:.2f} (target: {fps})")

            dataset.save_episode()
            self.robot.leader_arms = {}
            self._recording = False

        # Start the recording thread
        self._recording_thread = threading.Thread(target=recording_loop, daemon=True)
        self._recording_thread.start()

        return {"status": "success", "message": "Recording started"}

    def _handle_stop_record_episode_command(self, config: Dict[str, Any], **kwargs):
        """Handle the stop record episode command"""
        logger.info(f"Robot {self.robot_id} is stopping recording...")

        # Set flag to stop recording
        self._recording = False

        # Wait for recording thread to finish (with timeout)
        if hasattr(self, "_recording_thread") and self._recording_thread and self._recording_thread.is_alive():
            self._recording_thread.join(timeout=2.0)

        return {"status": "success", "message": "Recording stopped"}

    def _prepare_robot_config(self, config: Dict[str, Any]) -> None:
        # First, set common configuration parameters
        if "backend_calibration_dir" in config:
            self.robot_config.calibration_dir = config["backend_calibration_dir"]
        elif "calibration_dir" in config:
            self.robot_config.calibration_dir = config["calibration_dir"]

        if "mock" in config:
            self.robot_config.mock = config["mock"]

        if "max_relative_target" in config:
            self.robot_config.max_relative_target = config["max_relative_target"]

        # Our leader arms are virtual
        self.robot_config.leader_arms = {}

        # Initialize follower arms config
        self.robot_config.follower_arms = {}

        # Initialize cameras config
        self.robot_config.cameras = {}

        # Extract joint group information from the robot config format
        if "joint_groups" in config and isinstance(config["joint_groups"], list):
            logger.info(f"Found {len(config['joint_groups'])} joint groups in robot config")

            for joint_group in config["joint_groups"]:
                # Store joint configurations for this joint group
                if "joints" in joint_group and isinstance(joint_group["joints"], list):
                    group_name = joint_group.get("name", "unknown_group")
                    self.joint_group_map[group_name] = []

                    for joint in joint_group["joints"]:
                        if "motor_name" in joint and "name" in joint:
                            motor_name = joint["motor_name"]
                            joint_name = joint["name"]
                            self.joint_configs[motor_name] = joint.copy()
                            self.joint_group_map[group_name].append(motor_name)

                # Only process joint groups that have backend_config
                if "backend_config" in joint_group and isinstance(joint_group["backend_config"], dict):
                    backend_group_config = joint_group["backend_config"]
                    group_name = backend_group_config.get("name")

                    if not group_name:
                        logger.warning(
                            f"Joint group is missing 'name' in backend_config, using group name: {joint_group.get('name')}"
                        )
                        group_name = joint_group.get("name")

                    # Skip joint groups without a name
                    if not group_name:
                        logger.warning("Skipping joint group with no name")
                        continue

                    # Extract port from backend_config
                    port = backend_group_config.get("port")
                    if not port:
                        logger.warning(f"No port specified for joint group {group_name}, skipping")
                        continue

                    # Create motor configuration by mapping joints to motor details
                    motors = {}
                    if "joints" in joint_group and isinstance(joint_group["joints"], list):
                        for joint in joint_group["joints"]:
                            if all(k in joint for k in ["motor_name", "motor_id", "motor_type"]):
                                motors[joint["motor_name"]] = [joint["motor_id"], joint["motor_type"]]

                    # Add the joint group to follower_arms config
                    if motors:
                        logger.info(f"Adding follower arm {group_name} with {len(motors)} motors on port {port}")
                        self.robot_config.follower_arms[group_name] = FeetechMotorsBusConfig(port=port, motors=motors)
                    else:
                        logger.warning(f"No valid motors found for joint group {group_name}")

            # Log configured joints
            for group_name, joint_names in self.joint_group_map.items():
                logger.info(f"Joint group {group_name} configured with joints: {', '.join(joint_names)}")

        # Handle camera configuration
        if "cameras" in config:
            self.robot_config.cameras = {
                x["name"]: OpenCVCameraConfig(
                    camera_index=x["camera_index"] if "camera_index" in x else 0,
                    fps=x["fps"] if "fps" in x else 30,
                    width=x["width"] if "width" in x else 640,
                    height=x["height"] if "height" in x else 480,
                )
                for x in config["cameras"]
            }

        # Log the final configuration
        logger.info(f"Configured robot with {len(self.robot_config.follower_arms)} follower arms")
        for arm_name, arm_config in self.robot_config.follower_arms.items():
            logger.info(f"  Arm {arm_name}: {len(arm_config.motors)} motors on port {arm_config.port}")

    def _process_robot_command(self, command_type, *args, **kwargs):
        """
        Process a robot command through the command processor.
        Starts the processor if it's not already running.

        Args:
            command_type: Type of command to execute
            *args, **kwargs: Arguments to pass to the command

        Returns:
            Result of the command, or raises an exception if the command failed
        """
        # Make sure the command processor is running
        if not self.command_processor.running:
            self.command_processor.start()

        # Execute the command and get the result
        result, exception = self.command_processor.execute_command(command_type, self.robot, *args, **kwargs)

        # If there was an exception, raise it
        if exception:
            raise exception

        return result

    def connect(self) -> bool:
        """Connect to the physical robot"""
        try:
            self._process_robot_command(COMMAND_CONNECT)
            self._connected = True
            self.state = RobotState.CONNECTED
            return True
        except Exception as e:
            logger.error(f"Failed to connect to robot: {e}")
            self.state = RobotState.ERROR
            return False

    def disconnect(self) -> bool:
        """Disconnect from the physical robot"""
        try:
            self._process_robot_command(COMMAND_DISCONNECT)
            self._connected = False
            self.state = RobotState.DISCONNECTED

            # Stop the command processor when disconnecting
            self.command_processor.stop()

            return True
        except Exception as e:
            logger.error(f"Failed to disconnect from robot: {e}")
            return False

    def get_joint_state(self, joint_name: str) -> Optional[JointState]:
        """Get the current state of a specific joint"""
        if not self._connected:
            logger.error(f"Cannot get joint state: robot {self.robot_id} not connected")
            return None

        try:
            # Get all joint states and return the specific one requested
            all_states = self.get_all_joint_states()
            if joint_name in all_states:
                return all_states[joint_name]
            else:
                logger.error(f"Joint {joint_name} not found")
                return None
        except Exception as e:
            logger.error(f"Failed to read joint state: {e}")
            return None

    def set_joint_position(self, joint_name: str, position: float) -> bool:
        """Set the position of a specific joint"""
        if not self._connected:
            logger.error(f"Cannot set joint position: robot {self.robot_id} not connected")
            return False

        try:
            # Create a dict with just the one joint position
            positions = {joint_name: position}
            # Use the set_all_joint_positions method to handle the actual command
            return self.set_all_joint_positions(positions)
        except Exception as e:
            logger.error(f"Failed to set joint position: {e}")
            return False

    def get_all_joint_states(self) -> Dict[str, JointState]:
        """Get the current state of all joints from the physical robot"""
        if not self._connected:
            logger.error(f"Cannot get joint states: robot {self.robot_id} not connected")
            return {}

        try:
            # First build a mapping from motor names to joint names using joint configs
            motor_to_joint_map = {}
            for motor_name, joint_config in self.joint_configs.items():
                if "name" in joint_config:
                    motor_to_joint_map[motor_name] = joint_config["name"]
                    logger.debug(f"Mapped motor {motor_name} to joint {joint_config['name']}")

            # Use motor names if no mapping is available
            if not motor_to_joint_map:
                logger.warning("No motor-to-joint name mapping found, using motor names directly")

            # Collect all motor names from all joint groups
            all_motor_names = []
            for joint_names in self.joint_group_map.values():
                all_motor_names.extend(joint_names)

            # If no motor names were configured, fall back to hardcoded defaults
            if not all_motor_names:
                all_motor_names = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
                logger.warning(f"No motor names found in config, using defaults: {', '.join(all_motor_names)}")

            # Get actual robot state from the robot hardware
            motor_states = {}  # Temporary storage for motor states
            try:
                logger.debug(f"Requesting joint states from physical robot")
                # Get observation from the robot using command processor
                observation = self._process_robot_command(COMMAND_CAPTURE)

                observation_keys = observation.keys()

                # Check for camera images in the observation
                if observation:
                    for key in list(filter(lambda x: x.startswith("observation.images"), observation_keys)):
                        # Store the camera images
                        self.camera_images[key.split(".")[2]] = observation[key]
                else:
                    logger.debug("No camera images found in observation")

                # Check if "observation.state" exists (literal key with dot)
                if observation and "observation.state" in observation:
                    # Process joint positions from the state tensor
                    state_tensor = observation["observation.state"]

                    # Convert tensor to list if needed
                    joint_positions = state_tensor.tolist() if hasattr(state_tensor, "tolist") else state_tensor

                    logger.debug(f"Got joint positions: {joint_positions}")

                    # Map the positions to motor names
                    # Assuming the tensor indices match the order of motor names
                    for i, motor_name in enumerate(all_motor_names):
                        if i < len(joint_positions):
                            joint_pos = joint_positions[i]
                            motor_states[motor_name] = JointState(
                                position=joint_pos,
                                velocity=0.0,  # Velocity not available
                                effort=0.0,  # Effort not available
                                timestamp=time.time(),
                            )
                    logger.debug(f"Successfully retrieved {len(motor_states)} motor states from physical robot")
                else:
                    # Fallback to zeros if no state is available
                    logger.warning("No 'observation.state' found in observation, using default values")
                    for motor_name in all_motor_names:
                        motor_states[motor_name] = JointState(
                            position=0.0, velocity=0.0, effort=0.0, timestamp=time.time()
                        )

                # Store the previous joint positions
                self._prev_joint_positions = {motor_name: state.position for motor_name, state in motor_states.items()}
            except Exception as e:
                # If there's an error getting the physical state, use previous joint positions
                logger.error(f"Error getting physical joint states: {e}")
                logger.error(f"Using previous joint positions instead")
                motor_states = {}
                # Convert previous positions to JointState objects
                for motor_name, position in self._prev_joint_positions.items():
                    motor_states[motor_name] = JointState(
                        position=position, velocity=0.0, effort=0.0, timestamp=time.time()
                    )

            # Now map motor states to joint states using the mapping we created
            joint_states = {}
            for motor_name, state in motor_states.items():
                # Use joint name if available, otherwise use motor name
                joint_name = motor_to_joint_map.get(motor_name, motor_name)
                joint_states[joint_name] = state
                logger.debug(f"Mapped motor {motor_name} state to joint {joint_name}")

            logger.debug(f"Retrieved states for {len(joint_states)} joints: {', '.join(joint_states.keys())}")
            return joint_states
        except Exception as e:
            logger.error(f"Failed to read joint states: {e}")
            return {}

    def set_all_joint_positions(self, positions: Dict[str, float]) -> bool:
        """Set the position of all joints"""
        if not self._connected:
            logger.error(f"Cannot set joint positions: robot {self.robot_id} not connected")
            return False

        try:
            # Get current joint positions
            current_positions = self.get_all_joint_states()

            # Now update the positions with the new positions
            for joint_name, position in positions.items():
                if joint_name in current_positions:
                    current_positions[joint_name].position = position
                else:
                    logger.warning(f"Joint {joint_name} not found in current positions, skipping")

            # Convert joint positions to a tensor for the robot action
            joint_positions = [joint.position for joint in current_positions.values()]

            logger.info(f"Setting joint positions: {positions}")

            # Use command processor to send action to robot
            action = torch.tensor(joint_positions)
            self._process_robot_command(COMMAND_SEND, action)
            return True
        except Exception as e:
            logger.error(f"Failed to set joint positions: {e}")
            return False
