import json
import os
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from server.models.schemas import (
    JointAngles,
    JointGroupModel,
    PlacementInfo,
    RobotJointGroupInfo,
    RobotModel,
)
from server.robots.manager import robot_manager
from server.utils.server import resolve_file_path

# Create router for robot endpoints
router = APIRouter(prefix="/api/robots", tags=["robots"])

# In-memory storage for robot joint angles
robot_joint_angles = {}

# Global variables
urdf_dir = None
robots_dir = None
meshes_dir = None
robots_config = {}


def initialize(urdf_directory: Path, robots_directory: Path = None):
    """Initialize the robot routes module with required directories.

    Args:
        urdf_directory: Path to directory containing URDF files
        robots_directory: Path to directory containing robot configuration files
    """
    global urdf_dir, robots_dir, meshes_dir
    urdf_dir = urdf_directory

    # Set robots directory from parameter or default
    if robots_directory:
        robots_dir = robots_directory
    else:
        # Default to project root/robots if not specified
        robots_dir = urdf_directory.parent / "robots"

    # Set meshes directory from environment or default
    meshes_dir_str = os.environ.get("MESHES_DIR")
    if meshes_dir_str:
        meshes_dir = Path(meshes_dir_str)
    else:
        # Default to urdf_dir parent/data/meshes
        meshes_dir = urdf_directory.parent / "data" / "meshes"

    # Create directories if they don't exist
    if not robots_dir.exists():
        os.makedirs(robots_dir)
        print(f"Created robots directory at {robots_dir}")

    if not meshes_dir.exists():
        os.makedirs(meshes_dir)
        print(f"Created meshes directory at {meshes_dir}")

    print(f"Using robots directory: {robots_dir}")
    print(f"Using URDF directory: {urdf_dir}")
    print(f"Using meshes directory: {meshes_dir}")

    # Load robot configurations from robots directory
    load_robot_configurations()

    # Load initial joint angles for all robot arms
    load_initial_joint_angles_for_all()


def load_robot_configurations():
    """Load robot configurations from JSON files in the robots directory."""
    global robots_config

    if not robots_dir.exists():
        print(f"Robots directory does not exist: {robots_dir}")
        return

    # Find all JSON files in the robots directory
    json_files = list(robots_dir.glob("*.json"))
    print(f"Found {len(json_files)} robot configuration files")

    for json_file in json_files:
        try:
            with open(json_file, "r") as f:
                config = json.load(f)

            robot_id = json_file.stem  # Use filename without extension as ID

            # Validate robot configuration has required fields
            if "name" in config and "joint_groups" in config and isinstance(config["joint_groups"], list):
                robots_config[robot_id] = config
                print(f"Loaded robot configuration for {config['name']} (ID: {robot_id})")

                # Validate URDF paths
                for joint_group_idx, joint_group in enumerate(config["joint_groups"]):
                    if "urdf_path" in joint_group:
                        urdf_path = joint_group["urdf_path"]
                        # Use the resolver utility
                        full_path = resolve_file_path(urdf_path, "urdf")

                        if not full_path.exists():
                            print(
                                f"Warning: URDF file not found at {full_path} for joint group {joint_group.get('name', f'Joint Group {joint_group_idx}')} in robot {config['name']}"
                            )
                    else:
                        print(
                            f"Warning: No URDF path specified for joint group {joint_group.get('name', f'Joint Group {joint_group_idx}')} in robot {config['name']}"
                        )
            else:
                print(f"Invalid robot configuration in {json_file}: Missing required fields")
        except json.JSONDecodeError as e:
            print(f"Error parsing robot configuration file {json_file}: {e}")
        except Exception as e:
            print(f"Error loading robot configuration from {json_file}: {e}")


def load_initial_joint_angles_for_all():
    """Load initial joint angles for all available robot joint groups."""
    global robot_joint_angles

    for robot_id, config in robots_config.items():
        robot_joint_angles[robot_id] = {}

        for joint_group in config["joint_groups"]:
            joint_group_name = joint_group.get("name", "")

            # Check if we have the new joint structure (list of objects with name and initial_angle)
            if joint_group_name and isinstance(joint_group.get("joints", []), list) and len(joint_group["joints"]) > 0:
                if (
                    isinstance(joint_group["joints"][0], dict)
                    and "name" in joint_group["joints"][0]
                    and "initial_angle" in joint_group["joints"][0]
                ):
                    # New format: array of objects with name and initial_angle
                    initial_angles = {joint["name"]: joint["initial_angle"] for joint in joint_group["joints"]}
                    robot_joint_angles[robot_id][joint_group_name] = initial_angles
                    print(
                        f"Loaded initial joint angles for robot {robot_id}, joint group {joint_group_name} (new format): {initial_angles}"
                    )
                    # Also add initial_joint_angles to joint group config for compatibility
                    joint_group["initial_joint_angles"] = initial_angles
                    continue

            # Original format: initial_joint_angles as a separate property
            if joint_group_name and "initial_joint_angles" in joint_group:
                robot_joint_angles[robot_id][joint_group_name] = joint_group["initial_joint_angles"]
                print(
                    f"Loaded initial joint angles for robot {robot_id}, joint group {joint_group_name}: {joint_group['initial_joint_angles']}"
                )


@router.get("", response_model=List[RobotModel])
async def get_robot_models():
    """Get a list of available robot models."""
    models = []

    for robot_id, config in robots_config.items():
        joint_groups = []

        for joint_group_config in config["joint_groups"]:
            # Handle joints - convert from new format to list of strings if needed
            joints = joint_group_config.get("joints", [])
            if joints and isinstance(joints, list) and len(joints) > 0 and isinstance(joints[0], dict):
                # New format: extract just the joint names
                joints = [joint["name"] for joint in joints]

            # Get URDF path and ensure it's properly formatted for web access
            urdf_path = joint_group_config["urdf_path"]

            # If it's a relative path, ensure it starts with / for web access
            if not os.path.isabs(urdf_path) and not urdf_path.startswith("/") and not urdf_path.startswith("http"):
                urdf_path = f"/urdf/{urdf_path.lstrip('/')}"
            elif os.path.isabs(urdf_path):
                # For absolute paths, we need to make them relative to a mounted directory
                # First try to find which directory contains this file
                try:
                    resolved_path = resolve_file_path(urdf_path, "urdf")
                    if resolved_path.exists():
                        # Use the web path to the urdf directory
                        rel_path = (
                            resolved_path.relative_to(urdf_dir)
                            if urdf_dir in resolved_path.parents
                            else resolved_path.name
                        )
                        urdf_path = f"/urdf/{rel_path}"
                except (ValueError, FileNotFoundError):
                    # Keep the original path if we can't resolve it
                    print(f"Warning: Could not resolve absolute path {urdf_path} to a web path")

            # Go through all the joints, get the button mapping and add it to the joint group model
            button_mapping = {}
            for joint in joint_group_config.get("joints", []):
                if "button_mapping" in joint:
                    button_mapping[joint["name"]] = joint["button_mapping"]

            joint_group = JointGroupModel(
                name=joint_group_config["name"],
                urdf_path=urdf_path,
                description=joint_group_config.get("description", ""),
                placement=(
                    PlacementInfo(
                        position=joint_group_config.get("placement", {}).get("position", [0, 0, 0]),
                        orientation=joint_group_config.get("placement", {}).get("orientation", [0, 0, 0]),
                        end_effector=joint_group_config.get("end_effector"),
                    )
                    if "placement" in joint_group_config
                    else None
                ),
                end_effector=joint_group_config.get("end_effector"),
                joints=joints,
                controller_binding=joint_group_config.get("controller_binding"),
                initial_joint_angles=joint_group_config.get("initial_joint_angles", {}),
                button_mapping=button_mapping,
            )
            joint_groups.append(joint_group)

        # Extract menu items if they exist in the config
        menu_items = None
        if "menu" in config and isinstance(config["menu"], list):
            menu_items = [
                {
                    "name": item.get("name", ""),
                    "description": item.get("description", ""),
                    "command": item.get("command", ""),
                }
                for item in config["menu"]
                if "command" in item and "name" in item
            ]

        models.append(
            RobotModel(
                id=robot_id,
                name=config["name"],
                description=config.get("description", ""),
                joint_groups=joint_groups,
                menu=menu_items,
            )
        )

    return models


@router.get("/{robot_id}")
async def get_robot_model(robot_id: str):
    """Get information about a specific robot model."""
    if robot_id in robots_config:
        config = robots_config[robot_id]
        joint_groups = []

        for joint_group_config in config["joint_groups"]:
            # Handle joints - convert from new format to list of strings if needed
            joints = joint_group_config.get("joints", [])
            if joints and isinstance(joints, list) and len(joints) > 0 and isinstance(joints[0], dict):
                # New format: extract just the joint names
                joints = [joint["name"] for joint in joints]

            # Go through all the joints, get the button mapping and add it to the joint group model
            button_mapping = {}
            for joint in joint_group_config.get("joints", []):
                if "button_mapping" in joint:
                    button_mapping[joint["name"]] = joint["button_mapping"]

            joint_group = JointGroupModel(
                name=joint_group_config["name"],
                urdf_path=joint_group_config["urdf_path"],
                description=joint_group_config.get("description", ""),
                placement=(
                    PlacementInfo(
                        position=joint_group_config.get("placement", {}).get("position", [0, 0, 0]),
                        orientation=joint_group_config.get("placement", {}).get("orientation", [0, 0, 0]),
                        end_effector=joint_group_config.get("end_effector"),
                    )
                    if "placement" in joint_group_config
                    else None
                ),
                end_effector=joint_group_config.get("end_effector"),
                joints=joints,
                controller_binding=joint_group_config.get("controller_binding"),
                initial_joint_angles=joint_group_config.get("initial_joint_angles", {}),
                button_mapping=button_mapping,
            )
            joint_groups.append(joint_group)

        # Extract menu items if they exist in the config
        menu_items = None
        if "menu" in config and isinstance(config["menu"], list):
            menu_items = [
                {
                    "name": item.get("name", ""),
                    "description": item.get("description", ""),
                    "command": item.get("command", ""),
                }
                for item in config["menu"]
                if "command" in item and "name" in item
            ]

        return RobotModel(
            id=robot_id,
            name=config["name"],
            description=config.get("description", ""),
            joint_groups=joint_groups,
            menu=menu_items,
        )

    raise HTTPException(status_code=404, detail="Robot model not found")


@router.get("/{robot_id}/joint_groups/{joint_group_name}/joints")
async def get_robot_joint_group_joint_angles(robot_id: str, joint_group_name: str):
    """Get the current joint angles for a robot joint group."""
    if robot_id not in robots_config:
        raise HTTPException(status_code=404, detail="Robot model not found")

    # Check if the joint group exists in this robot
    joint_group_exists = any(group.get("name") == joint_group_name for group in robots_config[robot_id]["joint_groups"])
    if not joint_group_exists:
        raise HTTPException(status_code=404, detail=f"Joint group '{joint_group_name}' not found in robot '{robot_id}'")

    # If we have joint angles for this robot joint group, return them
    if robot_id in robot_joint_angles and joint_group_name in robot_joint_angles[robot_id]:
        return {"angles": robot_joint_angles[robot_id][joint_group_name]}

    # If no joint angles stored yet, try to get initial angles from config
    for joint_group in robots_config[robot_id]["joint_groups"]:
        if joint_group.get("name") == joint_group_name and "initial_joint_angles" in joint_group:
            # Initialize if needed
            if robot_id not in robot_joint_angles:
                robot_joint_angles[robot_id] = {}
            robot_joint_angles[robot_id][joint_group_name] = joint_group["initial_joint_angles"]
            return {"angles": joint_group["initial_joint_angles"]}

    # If no joint angles found at all
    return {"angles": {}}


@router.post("/{robot_id}/joint_groups/{joint_group_name}/joints")
async def set_robot_joint_group_joint_angles(robot_id: str, joint_group_name: str, joint_angles: JointAngles):
    """Set joint angles for a robot joint group."""
    if robot_id not in robots_config:
        raise HTTPException(status_code=404, detail="Robot model not found")

    # Check if the joint group exists in this robot
    joint_group_exists = any(group.get("name") == joint_group_name for group in robots_config[robot_id]["joint_groups"])
    if not joint_group_exists:
        raise HTTPException(status_code=404, detail=f"Joint group '{joint_group_name}' not found in robot '{robot_id}'")

    # Initialize storage if needed
    if robot_id not in robot_joint_angles:
        robot_joint_angles[robot_id] = {}

    # Store joint angles
    robot_joint_angles[robot_id][joint_group_name] = joint_angles.angles
    return {"status": "success", "message": f"Set joint angles for robot {robot_id}, joint group {joint_group_name}"}


@router.post("/{robot_id}/command")
async def execute_robot_command(robot_id: str, command_data: Dict[str, Any]):
    """Execute a robot command specified in the robot's menu configuration."""
    try:
        # Check if the robot exists
        if robot_id not in robots_config:
            raise HTTPException(status_code=404, detail=f"Robot {robot_id} not found")

        # Extract command and optional parameters
        if "command" not in command_data:
            raise HTTPException(status_code=400, detail="Command must be specified")

        command = command_data["command"]
        params = {k: v for k, v in command_data.items() if k != "command"}

        # Validate that the command exists in the robot's menu
        valid_command = False
        if "menu" in robots_config[robot_id]:
            for menu_item in robots_config[robot_id]["menu"]:
                if menu_item.get("command") == command:
                    valid_command = True
                    break

        if not valid_command:
            raise HTTPException(status_code=400, detail=f"Command '{command}' not found in robot's menu")

        # Get the robot instance from the manager
        robot = robot_manager.get_robot(robot_id)
        if not robot:
            # Try to connect to the robot first
            connected = robot_manager.connect_robot(robot_id, robots_config[robot_id])
            if not connected:
                raise HTTPException(status_code=503, detail=f"Could not connect to robot {robot_id}")
            robot = robot_manager.get_robot(robot_id)

        # Execute the command
        result = robot.execute_command(command, **params)

        # Return the result
        return {"status": "success", "result": result}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error executing command: {str(e)}")
