import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Import modules using absolute imports instead of relative ones
from server.routes import pages, robots, websocket
from server.utils import server

app = FastAPI(title="WebXR Robot Control API", description="API for controlling robot models in WebXR", version="1.0.0")

# Add CORS middleware to allow WebSocket connections
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For development - restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize paths from environment variables or use defaults
static_dir = Path(__file__).parent / "static"

# Get directories from environment variables (set in run.py)
urdf_dir = Path(os.environ.get("URDF_DIR", Path(__file__).parent.parent / "urdf"))
robots_dir = Path(os.environ.get("ROBOTS_DIR", Path(__file__).parent.parent / "robots"))
meshes_dir = Path(os.environ.get("MESHES_DIR", Path(__file__).parent.parent / "data" / "meshes"))

# Initialize modules
pages.initialize(static_dir)
robots.initialize(urdf_dir, robots_dir)  # Pass robots_dir to the initialize function
websocket.initialize()

# Create directories if they don't exist
static_dir.mkdir(exist_ok=True)
urdf_dir.mkdir(exist_ok=True)
robots_dir.mkdir(exist_ok=True)
meshes_dir.mkdir(exist_ok=True)

# Mount static file directories
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
app.mount("/urdf", StaticFiles(directory=str(urdf_dir)), name="urdf")
app.mount("/meshes", StaticFiles(directory=str(meshes_dir)), name="meshes")
# Add a special mount for urdf/meshes paths that points to the meshes directory
# This ensures backward compatibility with older URDF files that use /urdf/meshes/ paths
app.mount("/urdf/meshes", StaticFiles(directory=str(meshes_dir)), name="urdf_meshes")

# Include routers
app.include_router(pages.router)
app.include_router(robots.router)
app.include_router(websocket.router)


# Clean up resources on server shutdown
@app.on_event("shutdown")
async def shutdown_event():
    # Clean up robot connections
    from server.robots.manager import robot_manager

    robot_manager.cleanup()
