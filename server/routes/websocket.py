"""
WebSocket routes for teleop XR communication using binary protobuf
"""

import asyncio
import datetime
import json
import logging
import time
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from server.generated.common.transport_pb2 import (
    ActionType,
    ConnectionStatusPayload,
    ErrorPayload,
    HeartbeatPayload,
    JointPositionPayload,
    JointState,
    RobotStatus,
    Transport,
)
from server.robots.manager import robot_manager
from server.routes.robots import robots_config

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

router = APIRouter()


class WebSocketManager:
    def __init__(self):
        self.active_connections: Dict[int, WebSocket] = {}
        self.connection_counter = 0
        self.message_counters: Dict[int, int] = {}
        self.disconnected_ids: Set[int] = set()  # Track disconnected clients
        self.closing_connections: Set[int] = set()  # Track connections that are in process of closing
        self.active_robots: Dict[int, str] = {}  # Map connection_id to robot_id

    async def connect(self, websocket: WebSocket) -> int:
        """
        Connect a new WebSocket client and return its connection ID
        """
        self.connection_counter += 1
        connection_id = self.connection_counter

        await websocket.accept()
        self.active_connections[connection_id] = websocket
        self.message_counters[connection_id] = 0

        logger.info(f"Client {connection_id} connected. Total active connections: {len(self.active_connections)}")
        return connection_id

    def set_active_robot(self, connection_id: int, robot_id: str):
        """
        Associate a robot with a connection
        """
        self.active_robots[connection_id] = robot_id
        logger.info(f"Client {connection_id} associated with robot {robot_id}")

    def get_active_robot(self, connection_id: int) -> Optional[str]:
        """
        Get the robot associated with a connection
        """
        return self.active_robots.get(connection_id)

    def disconnect(self, connection_id: int):
        """
        Disconnect a WebSocket client
        """
        if connection_id in self.active_connections:
            # Mark as disconnected before removing from active connections
            self.disconnected_ids.add(connection_id)
            self.closing_connections.discard(connection_id)  # No longer in closing state

            # Disconnect associated robot if any
            if connection_id in self.active_robots:
                robot_id = self.active_robots[connection_id]
                try:
                    robot_manager.disconnect_robot(robot_id)
                    logger.info(f"Disconnected robot {robot_id} associated with client {connection_id}")
                except Exception as e:
                    logger.error(f"Error disconnecting robot {robot_id}: {e}")
                del self.active_robots[connection_id]

            del self.active_connections[connection_id]

            msg_count = 0
            if connection_id in self.message_counters:
                msg_count = self.message_counters[connection_id]
                del self.message_counters[connection_id]

            logger.info(
                f"Client {connection_id} disconnected. Processed {msg_count} messages. Total active connections: {len(self.active_connections)}"
            )

    def mark_as_closing(self, connection_id: int):
        """
        Mark a connection as in the process of closing
        """
        self.closing_connections.add(connection_id)
        logger.debug(f"Client {connection_id} marked as closing")

    def is_disconnected(self, connection_id: int) -> bool:
        """
        Check if a client has been disconnected
        """
        return (
            connection_id in self.disconnected_ids
            or connection_id in self.closing_connections
            or connection_id not in self.active_connections
        )

    async def send_binary(self, connection_id: int, data: bytes) -> bool:
        """
        Send binary data to a specific client
        """
        if self.is_disconnected(connection_id):
            logger.debug(f"Skip sending to disconnected client {connection_id}")
            return False

        if connection_id in self.active_connections:
            try:
                await self.active_connections[connection_id].send_bytes(data)
                return True
            except Exception as e:
                logger.error(f"Error sending binary data to client {connection_id}: {e}")
                self.disconnect(connection_id)
                return False
        return False

    async def send_proto_message(self, connection_id: int, message: Transport) -> bool:
        """
        Send a protobuf message to a specific client
        """
        if self.is_disconnected(connection_id):
            logger.debug(f"Skip sending protobuf message to disconnected client {connection_id}")
            return False

        if connection_id in self.active_connections:
            try:
                # Serialize the protobuf message
                binary_data = message.SerializeToString()
                logger.debug(f"Serialized message to {len(binary_data)} bytes, action_type={message.action_type}")

                # Log the first few bytes to debug
                if len(binary_data) > 0:
                    logger.debug(f"First few bytes: {binary_data[:10]}")

                # Send the binary data
                await self.active_connections[connection_id].send_bytes(binary_data)
                logger.debug(f"Successfully sent {len(binary_data)} bytes to client {connection_id}")
                return True
            except Exception as e:
                logger.error(f"Error sending protobuf message to client {connection_id}: {e}")
                logger.exception(e)  # Log full stack trace
                self.disconnect(connection_id)
                return False
        else:
            logger.warning(f"Client {connection_id} not found in active connections")
            return False

    async def send_joint_position_update(
        self, connection_id: int, robot_id: str, joint_group_id: str, joint_states: Dict[str, Any]
    ) -> bool:
        """
        Send joint position update to a client using protobuf
        """
        if self.is_disconnected(connection_id):
            logger.debug(f"Skip sending joint position update to disconnected client {connection_id}")
            return False

        try:
            logger.debug(
                f"Preparing joint position update for robot {robot_id}, joint group {joint_group_id}, client {connection_id}"
            )

            # Create the joint position payload
            joint_payload = JointPositionPayload()
            joint_payload.robot_id = robot_id
            joint_payload.joint_group_id = joint_group_id  # updated field name

            # Convert joint states to protobuf format
            joints_count = 0
            for joint_name, state in joint_states.items():
                try:
                    joint_state = JointState()
                    joint_state.joint_name = joint_name
                    joint_state.position = state.position
                    joint_state.velocity = state.velocity
                    joint_state.effort = state.effort
                    joint_payload.joints.append(joint_state)
                    joints_count += 1
                except Exception as e:
                    logger.error(f"Error adding joint {joint_name}: {e}")
                    continue

            # Create the transport message
            if joints_count > 0:
                message = Transport()
                message.action_type = ActionType.JOINT_POSITION_UPDATE
                message.timestamp = int(time.time() * 1000)

                # Update message counter
                if connection_id in self.message_counters:
                    self.message_counters[connection_id] += 1
                    message.sequence = self.message_counters[connection_id]
                else:
                    message.sequence = 0
                    logger.warning(f"Message counter for connection {connection_id} not found")

                message.joint_position.CopyFrom(joint_payload)

                # Send the protobuf message
                logger.debug(f"Sending joint update with {joints_count} joints to client {connection_id}")
                success = await self.send_proto_message(connection_id, message)

                if not success:
                    logger.error(f"Failed to send joint position update to client {connection_id}")

                return success
            else:
                logger.warning(f"No valid joints to send for robot {robot_id}, joint group {joint_group_id}")
                return False
        except Exception as e:
            logger.error(f"Error creating joint position update message: {e}")
            logger.exception(e)  # Log full stack trace
            return False

    async def send_image_update(self, connection_id: int, robot_id: str, camera_id: str, image_data) -> bool:
        """
        Send a camera image update to a client using protobuf
        """
        if self.is_disconnected(connection_id):
            logger.debug(f"Skip sending image update to disconnected client {connection_id}")
            return False

        try:
            logger.debug(f"Preparing image update for robot {robot_id}, camera {camera_id}, client {connection_id}")

            # Create the image payload
            import cv2
            import numpy as np

            # Convert tensor to numpy array if needed
            if hasattr(image_data, "cpu") and hasattr(image_data, "numpy"):
                # For PyTorch tensors
                image_np = image_data.cpu().numpy()
            elif hasattr(image_data, "numpy"):
                # For other tensor types (e.g., TensorFlow)
                image_np = image_data.numpy()
            else:
                # Assume it's already a numpy array or compatible
                image_np = np.array(image_data)

            # Ensure image is proper format for encoding (uint8)
            if image_np.dtype != np.uint8:
                if image_np.max() <= 1.0:
                    image_np = (image_np * 255).astype(np.uint8)
                else:
                    image_np = image_np.astype(np.uint8)

            # Encode image to JPEG format
            _, encoded_image = cv2.imencode(".jpg", image_np, [cv2.IMWRITE_JPEG_QUALITY, 85])

            # Create the transport message
            message = Transport()
            message.action_type = ActionType.IMAGE_UPDATE
            message.timestamp = int(time.time() * 1000)

            # Update message counter
            if connection_id in self.message_counters:
                self.message_counters[connection_id] += 1
                message.sequence = self.message_counters[connection_id]
            else:
                message.sequence = 0
                logger.warning(f"Message counter for connection {connection_id} not found")

            # Fill in image data
            message.image.camera_id = camera_id
            message.image.image_data = encoded_image.tobytes()
            message.image.format = "jpeg"
            message.image.width = image_np.shape[1]  # Width is the second dimension in numpy arrays
            message.image.height = image_np.shape[0]  # Height is the first dimension
            message.image.encoding = "rgb"  # Assuming RGB format
            message.image.capture_timestamp = int(time.time() * 1000)

            # Send the protobuf message
            logger.debug(f"Sending image update for camera {camera_id} to client {connection_id}")
            success = await self.send_proto_message(connection_id, message)

            if not success:
                logger.error(f"Failed to send image update to client {connection_id}")

            return success
        except Exception as e:
            logger.error(f"Error creating image update message: {e}")
            logger.exception(e)  # Log full stack trace
            return False


# Create a WebSocket manager instance
manager = WebSocketManager()


def initialize():
    """Initialize the WebSocket module"""
    # Load robot configs into the robot manager for later use
    # Do NOT create robot instances here
    for robot_id, config in robots_config.items():
        # Add backend_type if missing
        if "backend_type" not in config:
            config["backend_type"] = "lerobot.so100"  # Default to So100 for now

        # Normalize backend_type to support both slash and dot formats
        if isinstance(config["backend_type"], str):
            # Store both original and normalized version
            # (normalized version is primarily for class name extraction)
            config["original_backend_type"] = config["backend_type"]
            config["backend_type"] = config["backend_type"].replace("/", ".")

        # Just register the config in the robot manager, don't create instances yet
        robot_manager.load_robot_config(robot_id, config)
        logger.info(f"Registered config for robot {robot_id} with backend {config.get('backend_type')}")


@router.websocket("/ws/teleop")
async def websocket_endpoint(websocket: WebSocket):
    # Set logging to debug only when needed
    # logger.setLevel(logging.DEBUG)
    logger.info("New WebSocket connection request received")

    # Accept the connection
    connection_id = await manager.connect(websocket)
    logger.info(f"WebSocket connection {connection_id} accepted")

    try:
        # Send a welcome message using protobuf
        welcome_message = Transport()
        welcome_message.action_type = ActionType.CONNECTION_STATUS
        welcome_message.timestamp = int(time.time() * 1000)
        welcome_message.sequence = 0

        connection_status = ConnectionStatusPayload()
        connection_status.robot_id = ""  # Will be set when robot is connected
        connection_status.status = RobotStatus.CONNECTED
        connection_status.message = "Connected to teleop server"
        connection_status.connection_timestamp = int(time.time() * 1000)
        welcome_message.connection_status.CopyFrom(connection_status)

        await manager.send_proto_message(connection_id, welcome_message)
        logger.debug(f"Welcome message sent to client {connection_id}")

        # Use the first available robot for now
        robot_id = next(iter(robots_config.keys()), None)
        if robot_id:
            logger.debug(f"Found robot {robot_id} to connect to")

            # Initialize the robot and associate it with this connection
            manager.set_active_robot(connection_id, robot_id)
            logger.debug(f"Associated robot {robot_id} with connection {connection_id}")

            # Connect to the robot
            logger.info(f"Connecting to robot {robot_id}")
            if robot_manager.connect_robot(robot_id):
                logger.info(f"Robot {robot_id} connected successfully")

                # Get initial joint states and send to the client
                joint_group_states = robot_manager.get_joint_states(robot_id)
                if joint_group_states:
                    for joint_group_id, joint_states in joint_group_states.items():
                        logger.debug(f"Sending initial joint states for joint group {joint_group_id}")
                        await manager.send_joint_position_update(connection_id, robot_id, joint_group_id, joint_states)
                else:
                    logger.warning("No joint states available from robot")

                # Get camera images and send to the client
                try:
                    camera_images = robot_manager.get_camera_images(robot_id)
                    if camera_images:
                        logger.info(f"Found {len(camera_images)} camera images from robot {robot_id}")
                        for camera_id, image_data in camera_images.items():
                            logger.debug(f"Sending image for camera {camera_id}")
                            await manager.send_image_update(connection_id, robot_id, camera_id, image_data)
                    else:
                        logger.debug(f"No camera images available from robot {robot_id}")
                except Exception as e:
                    logger.error(f"Error getting/sending camera images: {e}")
                    logger.exception(e)
            else:
                logger.error(f"Failed to connect to robot {robot_id}")
        else:
            logger.warning("No robots available to connect to")

        # Process incoming messages
        while True:
            try:
                # Wait for a message
                message = await websocket.receive()
                logger.debug(f"Received message: {type(message)}")

                # Handle binary data
                if "bytes" in message:
                    data = message["bytes"]
                    logger.debug(f"Processing binary message ({len(data)} bytes)")

                    try:
                        # Try to decode as protobuf message
                        transport = Transport()
                        transport.ParseFromString(data)

                        # Handle different message types
                        if transport.action_type == ActionType.HEARTBEAT:
                            # Send heartbeat response
                            response = Transport()
                            response.action_type = ActionType.HEARTBEAT
                            response.timestamp = int(time.time() * 1000)
                            if connection_id in manager.message_counters:
                                manager.message_counters[connection_id] += 1
                                response.sequence = manager.message_counters[connection_id]
                            else:
                                response.sequence = 0
                                logger.warning(f"Message counter for connection {connection_id} not found")

                            # Create and populate heartbeat payload
                            heartbeat = HeartbeatPayload()
                            try:
                                # Check if the incoming message has a heartbeat field
                                if transport.HasField("heartbeat"):
                                    heartbeat.client_time = transport.heartbeat.client_time
                                else:
                                    heartbeat.client_time = 0
                                    logger.warning(f"Incoming heartbeat message has no heartbeat field")

                                heartbeat.server_time = int(time.time() * 1000)
                                response.heartbeat.CopyFrom(heartbeat)
                            except Exception as e:
                                logger.error(f"Error creating heartbeat payload: {e}")
                                logger.exception(e)

                            await manager.send_proto_message(connection_id, response)

                            # Get the active robot for this connection
                            active_robot_id = manager.get_active_robot(connection_id)
                            if active_robot_id:
                                # Send joint states with heartbeat response
                                try:
                                    joint_group_states = robot_manager.get_joint_states(active_robot_id)
                                    if not joint_group_states:
                                        logger.warning(f"No joint states returned for robot {active_robot_id}")

                                    for joint_group_id, joint_states in joint_group_states.items():
                                        if joint_states:
                                            await manager.send_joint_position_update(
                                                connection_id, active_robot_id, joint_group_id, joint_states
                                            )
                                        else:
                                            logger.warning(
                                                f"No joint states available for robot {active_robot_id}, joint group {joint_group_id}"
                                            )

                                    try:
                                        camera_images = robot_manager.get_camera_images(active_robot_id)
                                        if camera_images:
                                            for camera_id, image_data in camera_images.items():
                                                await manager.send_image_update(
                                                    connection_id, active_robot_id, camera_id, image_data
                                                )
                                    except Exception as e:
                                        logger.error(f"Error getting/sending camera images: {e}")
                                except Exception as e:
                                    logger.error(f"Error getting/sending joint states: {e}")
                                    logger.exception(e)
                            else:
                                logger.warning(f"No active robot found for connection {connection_id}")

                        elif transport.action_type == ActionType.JOINT_POSITION_COMMAND:
                            # Get the active robot for this connection and send the joint position command
                            active_robot_id = manager.get_active_robot(connection_id)
                            if active_robot_id:
                                group_id = transport.joint_position.joint_group_id
                                positions = {
                                    joint.joint_name: joint.position for joint in transport.joint_position.joints
                                }
                                robot_manager.set_joint_positions(active_robot_id, group_id, positions)
                            else:
                                logger.warning(f"No active robot found for connection {connection_id}")

                    except Exception as e:
                        logger.error(f"Error processing protobuf message: {str(e)}")
                        logger.exception(e)  # This will log the full stack trace

            except WebSocketDisconnect:
                logger.info(f"Client {connection_id} disconnected")
                break
            except Exception as e:
                logger.error(f"Error processing message: {str(e)}")
                logger.exception(e)  # This will log the full stack trace
                break

    except Exception as e:
        logger.error(f"Unhandled error in WebSocket handler: {str(e)}")
        logger.exception(e)  # This will log the full stack trace
    finally:
        # Make sure to disconnect everything
        if connection_id in manager.active_robots:
            robot_id = manager.active_robots[connection_id]
            logger.info(f"Disconnecting robot {robot_id}")
            robot_manager.disconnect_robot(robot_id)

        manager.disconnect(connection_id)
        logger.info(f"Connection {connection_id} closed")


@router.websocket("/ws/test_echo")
async def websocket_echo_endpoint(websocket: WebSocket):
    """Simple echo WebSocket endpoint for testing"""
    logger.debug("New test echo WebSocket connection request received")

    await websocket.accept()
    logger.debug("Test echo WebSocket connection accepted")

    try:
        while True:
            try:
                # Wait for a message
                message = await websocket.receive()
                logger.debug(f"Test echo received message type: {list(message.keys())}")

                # Echo it back
                if "bytes" in message:
                    await websocket.send_bytes(message["bytes"])
                elif "text" in message:
                    await websocket.send_text(message["text"])
                else:
                    logger.warning(f"Unknown message format: {message}")
            except Exception as e:
                logger.error(f"Error in echo handler: {str(e)}")
                logger.exception(e)
    except Exception as e:
        logger.error(f"Unhandled error in echo handler: {str(e)}")
        logger.exception(e)
    finally:
        logger.debug("Test echo connection closed")
