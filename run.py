#!/usr/bin/env python
"""
Entry point script for running the WebXR Robot Control API server
"""
import argparse
from pathlib import Path

import uvicorn

from server.utils.server import check_certificates, get_local_ip


def main():
    """Run the server."""
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Run the WebXR Robot Control API server")
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    parser.add_argument("--data-dir", type=str, default="./data", help="Base data directory")
    parser.add_argument("--robots-dir", type=str, help="Directory for robot config files (overrides data-dir/robots)")
    parser.add_argument("--urdf-dir", type=str, help="Directory for URDF files (overrides data-dir/urdf)")
    parser.add_argument("--meshes-dir", type=str, help="Directory for mesh files (overrides data-dir/meshes)")
    args = parser.parse_args()

    # Get the certificate paths
    project_root = Path(__file__).parent
    cert_path = project_root / "certs" / "cert.pem"
    key_path = project_root / "certs" / "key.pem"

    # Check if the certificate files exist
    if not check_certificates(cert_path, key_path):
        print("Certificate files not found. Run gen_certs.sh to generate them.")
        return

    # Get and display the local IP address
    local_ip = get_local_ip()
    print(f"\nServer starting with HTTPS enabled!")
    print(f"You can connect to the server at: https://{local_ip}:{args.port}")
    print(f"(Note: You may need to accept the self-signed certificate warning in your browser)\n")

    # Create the data directory structure
    data_dir = Path(args.data_dir)

    # Use either provided directories or create defaults under data dir
    robots_dir = Path(args.robots_dir) if args.robots_dir else data_dir / "robots"
    urdf_dir = Path(args.urdf_dir) if args.urdf_dir else data_dir / "urdf"
    meshes_dir = Path(args.meshes_dir) if args.meshes_dir else data_dir / "meshes"

    # Ensure directories exist
    for directory in [data_dir, robots_dir, urdf_dir, meshes_dir]:
        directory.mkdir(parents=True, exist_ok=True)
        print(f"Ensuring directory exists: {directory}")

    # Pass the directories to the application through environment variables
    import os

    os.environ["ROBOTS_DIR"] = str(robots_dir)
    os.environ["URDF_DIR"] = str(urdf_dir)
    os.environ["MESHES_DIR"] = str(meshes_dir)

    # Start the server with HTTPS
    uvicorn.run(
        "server.app:app",
        host="0.0.0.0",
        port=args.port,
        reload=True,
        ssl_keyfile=str(key_path),
        ssl_certfile=str(cert_path),
    )


if __name__ == "__main__":
    main()
