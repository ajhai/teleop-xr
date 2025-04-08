from typing import Dict, List, Optional

from pydantic import BaseModel


class PlacementInfo(BaseModel):
    """Schema for robot placement information."""

    position: List[float]  # [x, y, z]
    orientation: List[float]  # [roll, pitch, yaw]
    end_effector: Optional[str] = None  # Name of the end effector link


class MenuItemModel(BaseModel):
    """Schema for robot menu items."""

    name: str
    description: Optional[str] = None
    command: str


class JointGroupModel(BaseModel):
    """Schema for robot joint group information."""

    name: str
    urdf_path: str
    description: Optional[str] = None
    placement: Optional[PlacementInfo] = None
    end_effector: Optional[str] = None
    joints: Optional[List[str]] = None
    controller_binding: Optional[str] = None
    initial_joint_angles: Optional[Dict[str, float]] = None
    button_mapping: Optional[Dict[str, Dict[str, int]]] = None


class RobotModel(BaseModel):
    """Schema for robot model information."""

    id: str
    name: str
    description: Optional[str] = None
    joint_groups: List[JointGroupModel]
    menu: Optional[List[MenuItemModel]] = None


class RobotJointGroupInfo(BaseModel):
    """Schema for robot joint group identification."""

    robot_id: str
    joint_group_name: str


class JointAngles(BaseModel):
    """Schema for joint angle data."""

    angles: Dict[str, float]
