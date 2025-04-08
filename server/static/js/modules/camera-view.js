/**
 * Camera view module for rendering robot camera feeds in the 3D scene
 */

import { log } from './logger.js';
import { addEventListener, getCameraImage, getAllCameraImages } from './websocket.js';

// Track camera views and their THREE.js objects
const cameraViews = {};

// Default settings for camera views
const DEFAULT_SETTINGS = {
  width: 0.3,         // Width of the view in meters
  height: 0.2,        // Height of the view in meters
  position: [0.3, 0.2, -0.3], // Default position relative to robot model [x, y, z]
  rotation: [0, Math.PI * 3 / 4, 0], // Default rotation [x, y, z] in radians - facing user instead of robot
  offset: [0, 0.3, 0]  // Offset from reference point (typically robot base)
};

/**
 * Initialize camera views for a robot
 * @param {Object} scene - THREE.js scene
 * @param {string} robotId - ID of the robot
 * @param {Object} robotModel - THREE.js robot model object
 * @param {Object} options - Configuration options
 */
function initCameraViews(scene, robotId, robotModel, options = {}) {
  log(`Initializing camera views for robot ${robotId}`);

  // Merge default settings with provided options
  const settings = { ...DEFAULT_SETTINGS, ...options };

  // Remove any existing camera views for this robot
  removeCameraViews(scene, robotId);

  // Set up event listener for image updates from WebSocket
  addEventListener('imageUpdate', handleImageUpdate);

  // Create a container object for all camera views
  const container = new THREE.Group();
  container.name = `camera-views-${robotId}`;
  scene.add(container);

  // Store the container and settings for later use
  cameraViews[robotId] = {
    container,
    views: {},
    settings
  };

  // Get current camera images (if any)
  const currentImages = getAllCameraImages();

  // Create views for existing cameras
  for (const cameraId in currentImages) {
    createCameraView(scene, robotId, cameraId, currentImages[cameraId]);
  }

  // Also check for any pending images we might have received before the robot was loaded
  if (window._pendingCameraImages) {
    for (const cameraId in window._pendingCameraImages) {
      // Only create if we don't already have this camera view
      if (!cameraViews[robotId].views[cameraId]) {
        log(`Creating camera view for pending camera ${cameraId}`);
        createCameraView(scene, robotId, cameraId, window._pendingCameraImages[cameraId]);
      }
    }

    // Clear pending images as we've handled them
    window._pendingCameraImages = {};
  }

  // Position the container relative to the robot model
  if (robotModel) {
    container.position.copy(robotModel.position);

    // Add the specified offset
    container.position.x += settings.offset[0];
    container.position.y += settings.offset[1];
    container.position.z += settings.offset[2];
  } else {
    log('Warning: No robot model provided, using default position for camera views');
    // Set a default position if no robot model
    container.position.set(0, 0, 0);
  }

  log(`Camera views initialized for robot ${robotId}`);
  return cameraViews[robotId];
}

/**
 * Create a camera view for a specific camera
 * @param {Object} scene - THREE.js scene
 * @param {string} robotId - ID of the robot
 * @param {string} cameraId - ID of the camera
 * @param {Object} imageData - Image data (optional)
 */
function createCameraView(scene, robotId, cameraId, imageData = null) {
  if (!cameraViews[robotId]) {
    log(`Cannot create camera view: robot ${robotId} not initialized`);
    return null;
  }

  const { container, settings } = cameraViews[robotId];

  // Create a material for the camera view
  let texture = null;
  if (imageData && imageData.url) {
    texture = new THREE.TextureLoader().load(imageData.url);
    // Set texture properties for proper display
    texture.minFilter = THREE.LinearFilter;
    texture.encoding = THREE.sRGBEncoding;
  }

  // Create a placeholder material if no image yet
  const material = texture
    ? new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
    : new THREE.MeshBasicMaterial({
      color: 0x888888,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7
    });

  // Create plane geometry
  const geometry = new THREE.PlaneGeometry(settings.width, settings.height);

  // Create mesh
  const mesh = new THREE.Mesh(geometry, material);

  // Set name for easy identification
  mesh.name = `camera-view-${robotId}-${cameraId}`;

  // Position the view
  const index = Object.keys(cameraViews[robotId].views).length;
  mesh.position.set(
    settings.position[0],
    settings.position[1] - (index * (settings.height + 0.05)), // Stack views vertically
    settings.position[2]
  );

  // Apply rotation
  mesh.rotation.set(
    settings.rotation[0],
    settings.rotation[1],
    settings.rotation[2]
  );

  // Add to container
  container.add(mesh);

  // Store the view data
  cameraViews[robotId].views[cameraId] = {
    mesh,
    material,
    texture,
    lastUpdated: Date.now()
  };

  // Create a label for the camera
  const labelDiv = document.createElement('div');
  labelDiv.className = 'camera-label';
  labelDiv.textContent = `Camera: ${cameraId}`;
  labelDiv.style.cssText = `
    position: absolute;
    background-color: rgba(0, 0, 0, 0.7);
    color: white;
    padding: 2px 5px;
    border-radius: 3px;
    font-size: 10px;
    pointer-events: none;
    white-space: nowrap;
    display: none;
  `;
  document.body.appendChild(labelDiv);

  cameraViews[robotId].views[cameraId].label = labelDiv;

  log(`Created camera view for ${cameraId} on robot ${robotId}`);
  return cameraViews[robotId].views[cameraId];
}

/**
 * Handle image update event from WebSocket
 * @param {Object} imageData - Image update data
 */
function handleImageUpdate(imageData) {
  const { cameraId, imageUrl, width, height } = imageData;

  // Find this camera view and update it
  for (const robotId in cameraViews) {
    const robotViews = cameraViews[robotId];

    // If we already have a view for this camera, update it with rate limiting
    if (robotViews.views[cameraId]) {
      const view = robotViews.views[cameraId];
      const now = Date.now();

      // Only update if enough time has passed since last update (throttle to 20fps max)
      // This prevents excessive updates while maintaining a smooth experience
      if (!view.lastUpdated || now - view.lastUpdated > 50) {
        updateCameraView(robotId, cameraId, imageUrl);
      }
    } else {
      // Otherwise create a new view
      createCameraView(null, robotId, cameraId, { url: imageUrl });
    }
  }

  // If no camera views exist yet but we're getting images,
  // store them for later when a robot model is loaded
  if (Object.keys(cameraViews).length === 0) {
    log(`Received camera image for camera ${cameraId} but no robot is loaded yet. Storing for later use.`);

    // Create a special storage for pending images if it doesn't exist
    if (!window._pendingCameraImages) {
      window._pendingCameraImages = {};
    }

    // Store this image data
    window._pendingCameraImages[cameraId] = {
      url: imageUrl,
      width,
      height,
      timestamp: Date.now()
    };
  }
}

/**
 * Update a camera view with a new image
 * @param {string} robotId - ID of the robot
 * @param {string} cameraId - ID of the camera
 * @param {string} imageUrl - URL of the new image
 */
function updateCameraView(robotId, cameraId, imageUrl) {
  if (!cameraViews[robotId] || !cameraViews[robotId].views[cameraId]) {
    return false;
  }

  const view = cameraViews[robotId].views[cameraId];

  // Keep the old texture until the new one is loaded
  const oldTexture = view.texture;

  // Create new texture but don't assign it yet
  const texture = new THREE.TextureLoader().load(
    imageUrl,
    // Success callback - only update material after the texture is loaded
    (loadedTexture) => {
      // Update material with new texture
      view.material.map = loadedTexture;
      view.material.needsUpdate = true;

      // Now it's safe to dispose of the old texture
      if (oldTexture) {
        oldTexture.dispose();
      }

      // Update the timestamp
      view.lastUpdated = Date.now();
    }
  );

  // Set texture properties
  texture.minFilter = THREE.LinearFilter;
  texture.encoding = THREE.sRGBEncoding;

  // Store new texture reference
  view.texture = texture;

  return true;
}

/**
 * Remove camera views for a robot
 * @param {Object} scene - THREE.js scene
 * @param {string} robotId - ID of the robot
 */
function removeCameraViews(scene, robotId) {
  if (!cameraViews[robotId]) return;

  // Remove container from scene
  if (scene && cameraViews[robotId].container) {
    scene.remove(cameraViews[robotId].container);
  }

  // Clean up views
  for (const cameraId in cameraViews[robotId].views) {
    const view = cameraViews[robotId].views[cameraId];

    // Dispose of geometry, material, and texture
    if (view.mesh && view.mesh.geometry) {
      view.mesh.geometry.dispose();
    }

    if (view.material) {
      view.material.dispose();
    }

    if (view.texture) {
      view.texture.dispose();
    }

    // Remove label if exists
    if (view.label && view.label.parentNode) {
      view.label.parentNode.removeChild(view.label);
    }
  }

  // Remove from tracking
  delete cameraViews[robotId];
}

/**
 * Update camera view positions in 3D space
 * @param {Object} camera - THREE.js camera
 * @param {Object} renderer - THREE.js renderer
 */
function updateCameraViewsPositions(camera, renderer) {
  if (!camera || !renderer) return;

  // Get the renderer size
  const rendererSize = new THREE.Vector2();
  renderer.getSize(rendererSize);

  // Update each camera view label position
  for (const robotId in cameraViews) {
    const robotViews = cameraViews[robotId];

    for (const cameraId in robotViews.views) {
      const view = robotViews.views[cameraId];

      if (view.mesh && view.label) {
        // Project from 3D to 2D screen space
        const position = new THREE.Vector3();
        view.mesh.getWorldPosition(position);

        // Convert 3D position to 2D screen coordinates
        position.project(camera);

        // Convert to pixel coordinates
        const x = (position.x * 0.5 + 0.5) * rendererSize.x;
        const y = (1 - (position.y * 0.5 + 0.5)) * rendererSize.y;

        // Position label above the camera view
        view.label.style.transform = `translate(-50%, -100%) translate(${x}px, ${y - 10}px)`;

        // Only show label if camera view is in front of the camera
        view.label.style.display = position.z < 1 ? 'block' : 'none';
      }
    }
  }
}

export {
  initCameraViews,
  updateCameraViewsPositions,
  removeCameraViews
}; 