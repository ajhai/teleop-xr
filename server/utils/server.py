import os
import socket
from pathlib import Path


def get_local_ip():
    """Get the local IP address of the machine."""
    try:
        # This creates a socket that doesn't actually connect
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # This connects to a public IP (doesn't actually send packets)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"  # Fallback to localhost


def check_certificates(cert_path: Path, key_path: Path) -> bool:
    """Check if the certificate files exist."""
    return cert_path.exists() and key_path.exists()


def resolve_file_path(file_path: str, file_type: str) -> Path:
    """Resolve file paths for various file types.

    Args:
        file_path: The original file path from config
        file_type: The type of file ('urdf', 'mesh', or 'robot')

    Returns:
        Resolved Path object
    """
    # If it's an absolute path, use it directly
    if os.path.isabs(file_path):
        return Path(file_path)

    # Get directory based on file type
    if file_type == "urdf":
        base_dir = os.environ.get("URDF_DIR")
    elif file_type == "mesh":
        base_dir = os.environ.get("MESHES_DIR")
    elif file_type == "robot":
        base_dir = os.environ.get("ROBOTS_DIR")
    else:
        raise ValueError(f"Unknown file type: {file_type}")

    # If environment variable is set, use it as base
    if base_dir:
        base_path = Path(base_dir)
    else:
        # Default to project root subdirectories
        project_root = Path(__file__).parent.parent.parent
        if file_type == "urdf":
            base_path = project_root / "data" / "urdf"
        elif file_type == "mesh":
            base_path = project_root / "data" / "meshes"
        elif file_type == "robot":
            base_path = project_root / "data" / "robots"

    # Clean the file path (remove leading slash if present)
    clean_path = file_path.lstrip("/")

    # Try to resolve the path
    resolved_path = base_path / clean_path

    # If the path doesn't exist, try fallback locations
    if not resolved_path.exists():
        # Try legacy locations
        project_root = Path(__file__).parent.parent.parent
        if file_type == "urdf":
            alt_path = project_root / "urdf" / clean_path
        elif file_type == "mesh":
            alt_path = project_root / "meshes" / clean_path
        elif file_type == "robot":
            alt_path = project_root / "robots" / clean_path

        if alt_path.exists():
            return alt_path

    return resolved_path
