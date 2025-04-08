from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

# Create router for page endpoints
router = APIRouter(tags=["pages"])

# Global variables
static_dir = None


def initialize(static_directory: Path):
    """Initialize the page routes module with required directories."""
    global static_dir
    static_dir = static_directory


@router.get("/", response_class=HTMLResponse)
async def root():
    """Serve the WebXR AR application."""
    return open(static_dir / "index.html").read()


@router.get("/settings", response_class=HTMLResponse)
async def settings():
    """Serve the settings page."""
    return open(static_dir / "settings.html").read()
