# TeleOp XR

A system for teleoperating robots in augmented reality (AR) using WebXR.

https://github.com/user-attachments/assets/d8a7df72-8b94-4e30-ba3d-987ea13ac2df

## Overview

TeleOp XR enables users to visualize and control robots in AR directly from a browser. The system consists of:

- A **FastAPI server** that serves robot data, configuration, and a real-time control API
- A **Three.js frontend** for AR visualization, loaded from the backend
- **Modular backend** for different robot models (URDF), meshes, and configuration
- **Dynamic AR menu system**: The frontend can render a menu in AR based on the robot config. Each menu item is a button that, when clicked, triggers a callback in the robot backend to perform actions such as recording data, starting/stopping tasks, or custom robot-specific commands. The menu is defined in the robot's config file and can be customized before starting the server.

Users can:
- Discover and select available robots
- Visualize robots in AR using WebXR-compatible browsers and control the robot in AR
- View live camera feeds (if available)
- Record robot teleoperation episodes to collect training data
- Interact with a dynamic menu in AR to trigger robot-specific actions

## Architecture

The backend is modular and supports multiple robot types through a plugin-like architecture. Each robot configuration JSON file specifies a `backend_type` field, which tells the server which backend implementation to use for that robot. This allows you to add support for new robots without modifying the core server code.

- **backend_type**: A string in the robot config (e.g., `"lerobot/so100"`) that points to the backend implementation module.
- At runtime, the server loads the correct backend class based on this field and uses it to communicate with the robot hardware.
- **Fast, low-latency communication**: The system uses Protocol Buffers (protobuf) for efficient binary serialization over a WebSocket channel, enabling real-time robot control and feedback.
- Joints in a robot are grouped into `joint_groups`, which can be controlled together. This is useful to support robots with multiple limbs (e.g., humanoids).
- **Dynamic AR menu**: The `menu` field in the robot config allows you to define custom actions that appear as buttons in the AR interface. When a button is clicked, the backend executes the corresponding command via a callback.

### Example: SO100 Robot

- See [`data/robots/so100.json`](data/robots/so100.json):
  ```json
  {
    "name": "SO100",
    ...
    "backend_type": "lerobot/so100",
    ...
    "menu": [
      {
        "name": "Record Episode",
        "description": "Record an episode",
        "command": "record_episode",
        "config": {
          "task": "test task",
          "repo_id": "lerobot/test",
          "fps": 30,
          "root": "/Users/<your-username>/.cache/huggingface/lerobot/test"
        }
      },
      {
        "name": "Stop Recording",
        "description": "Stop recording an episode",
        "command": "stop_record_episode"
      }
    ],
    ...
  }
  ```
- The backend implementation is in [`server/robots/lerobot/so100.py`](server/robots/lerobot/so100.py), which defines a `So100` class for this robot and supports a single so100 arm.
- All robot backends inherit from [`RobotInterface`](server/robots/robot.py), which defines the required methods for connecting, reading, and commanding robots, as well as handling menu actions.

#### Dynamic AR Menu System

- The `menu` field in the robot config is an array of menu items. Each item defines a button that appears in the AR UI.
- Each menu item can have:
  - `name`: The button label
  - `description`: Tooltip or help text
  - `command`: The action to trigger in the backend
  - `config`: (optional) Additional parameters for the command
- When a button is clicked in AR, the backend receives the command and executes the corresponding callback. You can customize the menu for each robot by editing the config file before starting the server.

### How to Add a New Robot Backend

1. **Implement a subclass of `RobotInterface`**
   - Create a new Python file in `server/robots/<your_backend>/` (e.g., `server/robots/myrobot/myrobot.py`).
   - Implement all required methods: `connect`, `disconnect`, `get_joint_state`, `set_joint_position`, `get_all_joint_states`, `set_all_joint_positions`, etc.
   - **Menu actions:** Implement callbacks for any custom commands you want to expose in the AR menu. The backend should handle commands defined in the `menu` field of the robot config.
2. **Reference your backend in the robot config**
   - In your robot's JSON config (in `data/robots/`), set the `backend_type` field to match your module path (e.g., `"myrobot/myrobot"`).
   - **Define the AR menu:** Add a `menu` field to your config to specify which actions should be available in the AR UI. See the example above.
   - **Modify the menu as needed:** Before starting the server, edit the `menu` field to match the actions you want to expose for your robot.
3. **Restart the server**
   - The server will automatically load your backend for any robot with the matching `backend_type` and render the menu in AR based on the config.

This architecture makes it easy to extend TeleOp XR to new robot platforms—just implement the backend interface, update the config, and define your custom AR menu!

## System Requirements

- **Backend**: Python 3.9+
- **Frontend**: Modern browser with WebXR and WebGL support (e.g., Chrome, Meta Quest Browser)
- **Certificates**: Self-signed or trusted certs for HTTPS (required for WebXR)

## Getting Started

### 1. Backend Setup

1. Create and activate a Python virtual environment:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```

   > **Note:** If you are using the `lerobot/so100` backend, you should use the same virtual environment as your LeRobot installation to use lerobot dependencies.

2. Install dependencies (choose one):

   - Using [uv](https://github.com/astral-sh/uv) (recommended for speed):
     ```bash
     uv pip install -e .
     ```
   - Or using pip:
     ```bash
     pip install -e .
     ```

### 2. Certificates

WebXR requires HTTPS. Generate self-signed certificates (if you don't have them):

```bash
./gen_certs.sh
```

This creates `certs/cert.pem` and `certs/key.pem`.

### 3. Configure Your Robot

Before you can control a robot, you must either modify an existing robot config file or add a new one in `data/robots/` to match your hardware setup.

#### Example: Editing `so100.json`

Open `data/robots/so100.json` and update the following fields as needed:

- `backend_calibration_dir`: Set this to the path where your robot's calibration data is stored.
- `motor_id` (in each joint): Update these to match the IDs assigned to your robot's motors.
- `backend_config.port`: Set this to the serial port or device path your robot is connected to (e.g., `/dev/ttyUSB0` or `/dev/tty.usbmodemXXXX`).
- `menu`: **Edit this array to customize the AR menu for your robot.** Each item defines a button in the AR UI. You can add, remove, or modify menu items to match the actions you want to expose. For example, you might add a button to start/stop data recording, trigger a calibration routine, or run a custom script. The backend must implement the corresponding callbacks for each command.

Example snippet:
```json
{
  "name": "SO100",
  ...
  "backend_calibration_dir": "/path/to/your/calibration/dir/",
  ...
  "menu": [
    {
      "name": "Record Episode",
      "description": "Record an episode",
      "command": "record_episode",
      "config": {
        "task": "test task",
        "repo_id": "lerobot/test",
        "fps": 30,
        "root": "/path/to/your/data/root"
      }
    },
    {
      "name": "Stop Recording",
      "description": "Stop recording an episode",
      "command": "stop_record_episode"
    }
  ],
  ...
  "joint_groups": [
    {
      ...
      "joints": [
        { "name": "Rotation", "motor_id": 7, ... },
        { "name": "Pitch", "motor_id": 8, ... },
        ...
      ],
      "backend_config": {
        "name": "main",
        "port": "/dev/tty.usbmodemXXXX"
      }
    }
  ]
}
```

> **Note:** These fields must match your actual hardware configuration for the system to work correctly. **You should also review and update the `menu` field to ensure the AR menu matches the actions you want to provide.**

You can also add new robot config files in `data/robots/` for additional robots, following the same structure.

### 4. Running the Server

Start the backend (serves both API and frontend):

```bash
python run.py
```

- By default, runs on `https://<your-ip>:8000`
- Data directories default to `./data/` (see below for customization)

#### Custom Data Directories

You can specify custom locations for robot configs, URDFs, and meshes:

```bash
python run.py --data-dir /path/to/data
python run.py --robots-dir /path/to/robots --urdf-dir /path/to/urdf --meshes-dir /path/to/meshes
```

### 5. Accessing the Frontend

Open your browser and navigate to:

```
https://<your-ip>:8000
```

- The main interface is `index.html`.

> **Note:** The first time you open the URL, your browser will warn you about the self-signed certificate. You must accept this warning to proceed. This is required for WebXR to work over HTTPS. (In Chrome, click "Advanced" and then "Proceed to <your-ip> (unsafe)")

## Project Structure

```
teleop-xr/
├── server/               # FastAPI backend and static frontend
│   ├── app.py            # FastAPI app
│   ├── static/           # Frontend (HTML, JS, CSS)
│   │   ├── index.html    # Main UI
│   │   ├── js/           # JS modules (Three.js, app logic, protobuf, etc.)
│   │   └── ...
│   ├── routes/           # API and WebSocket endpoints
│   ├── robots/           # Robot control logic (modular backends)
│   ├── models/           # Data models
│   └── ...
├── data/                 # Robot data
│   ├── urdf/             # URDF robot models
│   ├── meshes/           # 3D mesh files (STL, OBJ, etc.)
│   └── robots/           # Robot configuration JSON files
├── common/               # Shared protocol buffer definitions
│   └── transport.proto
├── run.py                # Backend startup script
├── gen_certs.sh          # Script to generate self-signed certs
└── ...
```

## Data Directory Structure

- **data/urdf/**: URDF files describing robot kinematics
- **data/meshes/**: 3D mesh files referenced by URDFs
- **data/robots/**: JSON configuration files for each robot

## Communication Protocol

- **REST API** (`/api/robots`):
  - Discover available robots
  - Get robot configuration and joint info
  - Set joint positions
- **WebSocket** (`/ws/teleop`):
  - Real-time robot state and control
  - Uses Protocol Buffers (protobuf) for binary serialization, providing fast, low-latency data exchange between frontend and backend (see `common/transport.proto`)

## Development

- **Backend**: Python (FastAPI, protobuf)
- **Frontend**: Static HTML/JS (Three.js, protobuf)
- **Edit frontend** in `server/static/` and backend in `server/`

### Hot Reload (Backend)

The backend runs with `--reload` by default for development. Restart the server if you change protocol buffer definitions or data models.

## Robot Configuration

Each robot is defined by a JSON file in `data/robots/`. Example fields:

```json
{
  "name": "SO100 Arm",
  "menu": [
    {
      "name": "Record Episode",
      "description": "Record an episode",
      "command": "record_episode",
      "config": {
        "episode_name": "episode_1"
      }
    },
    {
      "name": "Stop Recording",
      "description": "Stop recording an episode",
      "command": "stop_record_episode"
    }
  ],
  "joint_groups": [
    {
      "name": "arm",
      "urdf_path": "/urdf/so100.urdf",
      "joints": [
        { "name": "shoulder", "initial_angle": 0.0 },
        { "name": "elbow", "initial_angle": 0.0 }
      ]
    }
  ]
}
```

- **menu**: (optional) Array of menu items to render as buttons in the AR UI. Each item should have a `name`, `description`, `command`, and optional `config` object. The backend must implement the logic for each command.
- **joint_groups**: Array of joint group definitions.

> **Tip:** Edit the `menu` field in your robot config before starting the server to customize the AR menu for your use case.

## Contributing

We welcome contributions! Please open an issue or submit a pull request.
