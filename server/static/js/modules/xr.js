/**
 * WebXR module for AR functionality
 */

import { log } from './logger.js';
import {
  loadRobotModel,
  updateJointAngleControls,
  updateIKTarget,
  getSelectedRobotId,
  getControllerBindings,
  getJointGroupLoader,
  synchronizeWithGhost,
  updateGhostJointAngle
} from './robot.js';
import { getCamera, configureForAR } from './scene.js';
import { getAllIKControllers, initIK } from './ik.js';
import {
  connectWebSocket,
  disconnectWebSocket,
  isWebSocketConnected
} from './websocket.js';
import { initProtobuf } from './proto.js';

// Variables to track controller state
let controller1, controller2;
let controller1Handedness = '';
let controller2Handedness = '';
let activeControllers = {};
let isUsingVRMode = false;
let forceARMode = false; // New flag to force AR mode

// Variables for the floating menu
let menuItems = [];
let menuEnabled = true;
let menuRaycaster = new THREE.Raycaster();
let menuGroup = null;

// Controller ray pointers
let controllerRays = {};
const RAY_LENGTH = 5; // 5 meters ray length

// Check if running on Oculus/Meta Quest browser
function isOculusQuestBrowser() {
  const userAgent = navigator.userAgent;
  return /oculus|quest|vr|xr|meta/i.test(userAgent);
}

// Force AR mode (can be called from console: window.forceARMode())
window.forceARMode = function () {
  forceARMode = true;
  isUsingVRMode = false;
  log('🔄 Forcing AR passthrough mode for next session');

  // Update button label
  const startButton = document.getElementById('startButton');
  if (startButton) {
    startButton.textContent = 'Enter AR (Forced)';
  }

  return "AR mode forced. Click the button to start.";
};

// Reset to auto-detection mode
window.resetXRMode = function () {
  forceARMode = false;
  isUsingVRMode = false;
  log('🔄 Reset to auto-detection of XR mode');

  // Recheck XR support
  checkXR();
  return "XR mode reset to auto-detection. Rechecking support...";
};

// Check if WebXR is available
async function checkXR() {
  const infoElement = document.getElementById('info');
  const startButton = document.getElementById('startButton');

  log('Checking WebXR support...');

  if ('xr' in navigator) {
    try {
      // Try immersive-ar first, especially if forced
      const arSupported = await navigator.xr.isSessionSupported('immersive-ar');

      // Check if user has forced AR mode or if AR is actually supported
      if (forceARMode || arSupported) {
        if (arSupported) {
          log('✓ WebXR AR supported!');
        } else {
          log('⚠️ Forcing AR mode despite no direct support. This may not work on all devices.');
        }

        infoElement.textContent = forceARMode ?
          'WebXR AR Mode (Forced) - Click to try passthrough' :
          'WebXR AR Ready';

        startButton.textContent = forceARMode ? 'Enter AR (Forced)' : 'Enter AR';
        startButton.disabled = false;
        isUsingVRMode = false;
        return true;
      }
      // Check if "immersive-vr" is supported (for Oculus Quest)
      else if (await navigator.xr.isSessionSupported('immersive-vr')) {
        log('✓ WebXR VR supported (using VR mode for Oculus Quest)');
        infoElement.textContent = 'WebXR VR Ready. For passthrough AR, click Force AR in console.';
        startButton.textContent = 'Enter VR';
        startButton.disabled = false;
        isUsingVRMode = true;

        // Add a message about forcing AR mode
        log('💡 TIP: You can try forcing AR passthrough mode by running window.forceARMode() in the console');
        return true;
      } else {
        log('✗ WebXR not supported on this device');
        infoElement.textContent = 'WebXR not supported on this device.';
        return false;
      }
    } catch (err) {
      log(`WebXR check error: ${err.message}`);
      infoElement.textContent = `WebXR check error: ${err.message}`;
      return false;
    }
  } else {
    log('✗ WebXR not supported in this browser');
    infoElement.textContent = 'WebXR not supported in this browser.';
    return false;
  }
}

// Check WebXR permissions
async function requestXRPermissions() {
  try {
    // Skip camera permission check for VR mode (Oculus Quest)
    // But still request camera permission if forcing AR mode
    if ((isUsingVRMode && !forceARMode) || (isOculusQuestBrowser() && !forceARMode)) {
      log('Skipping camera permission check for VR mode or Oculus device');
      return true;
    }

    // Check for permissions API 
    if (navigator.permissions) {
      // Query XR permission
      try {
        // Only try for common browsers that support this permission name
        const permissionResult = await navigator.permissions.query({ name: 'camera' });

        if (permissionResult.state === 'granted') {
          log('✓ Camera permissions already granted');
          return true;
        } else if (permissionResult.state === 'prompt') {
          log('Camera permissions will be requested during session start');
          return true;
        } else {
          log('✗ Camera permissions denied');
          return false;
        }
      } catch (error) {
        // Some browsers may not recognize the permissions name
        log(`Camera permissions check error: ${error.message}`);
        return true; // Continue anyway as permissions will be requested during session
      }
    }
    return true;
  } catch (error) {
    log(`Error checking permissions: ${error.message}`);
    return true; // Continue anyway, as permission errors will be handled during session request
  }
}

// Create floating menu for robot commands
function createFloatingMenu(scene, robotConfig) {
  // Clear any existing menu
  if (menuGroup) {
    log('Removing existing menu from scene');
    scene.remove(menuGroup);
    menuGroup = null;
  }

  // Log the robot config to see what we're getting
  log('Robot config for menu: ' + JSON.stringify(robotConfig));

  // If no menu items are configured, don't create a menu
  if (!robotConfig || !robotConfig.menu || !Array.isArray(robotConfig.menu) || robotConfig.menu.length === 0) {
    log('No menu items configured for this robot');
    return;
  }

  menuItems = robotConfig.menu;
  log(`Creating floating menu with ${menuItems.length} items: ${JSON.stringify(menuItems)}`);

  // Create a group to hold all menu items
  menuGroup = new THREE.Group();
  menuGroup.name = 'floatingMenu';

  // Create a panel for the menu with frosted glass effect
  const menuWidth = 0.4;  // Base width (will be scaled down later)
  const menuHeight = 0.15 * menuItems.length;  // Base height (will be scaled down later)

  // Create a high-resolution texture for the background panel
  const panelCanvas = document.createElement('canvas');
  const panelContext = panelCanvas.getContext('2d');
  panelCanvas.width = 4096;
  panelCanvas.height = 2048;

  // Enable high quality rendering
  panelContext.imageSmoothingEnabled = true;
  panelContext.imageSmoothingQuality = 'high';

  // Draw gradient background (space gray with subtle variation)
  const panelGradient = panelContext.createLinearGradient(0, 0, 0, panelCanvas.height);
  panelGradient.addColorStop(0, '#262626'); // Space gray - Apple's dark background color
  panelGradient.addColorStop(1, '#1a1a1a'); // Slightly darker at bottom

  panelContext.fillStyle = panelGradient;
  panelContext.fillRect(0, 0, panelCanvas.width, panelCanvas.height);

  // Add ultra-fine noise texture for a premium look
  const noiseOpacity = 0.02;
  for (let x = 0; x < panelCanvas.width; x += 2) {
    for (let y = 0; y < panelCanvas.height; y += 2) {
      if (Math.random() > 0.5) {
        panelContext.fillStyle = `rgba(255, 255, 255, ${noiseOpacity})`;
        panelContext.fillRect(x, y, 2, 2);
      }
    }
  }

  // Add a subtle vignette effect
  const gradient = panelContext.createRadialGradient(
    panelCanvas.width / 2, panelCanvas.height / 2, panelCanvas.height * 0.25,
    panelCanvas.width / 2, panelCanvas.height / 2, panelCanvas.height * 1.5
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.5)');
  panelContext.fillStyle = gradient;
  panelContext.fillRect(0, 0, panelCanvas.width, panelCanvas.height);

  // Add subtle highlight at the top
  const highlightGradient = panelContext.createLinearGradient(0, 0, 0, panelCanvas.height * 0.05);
  highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
  highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  panelContext.fillStyle = highlightGradient;
  panelContext.fillRect(0, 0, panelCanvas.width, panelCanvas.height * 0.05);

  // Create texture from canvas
  const panelTexture = new THREE.CanvasTexture(panelCanvas);
  panelTexture.anisotropy = 64;
  panelTexture.minFilter = THREE.LinearMipmapLinearFilter;
  panelTexture.magFilter = THREE.LinearFilter;
  panelTexture.needsUpdate = true;

  const menuGeometry = new THREE.PlaneGeometry(menuWidth, menuHeight);
  const menuMaterial = new THREE.MeshBasicMaterial({
    map: panelTexture,
    transparent: true,
    opacity: 0.95,  // Slightly transparent for frosted glass effect
    side: THREE.DoubleSide
  });
  const menuPanel = new THREE.Mesh(menuGeometry, menuMaterial);
  menuGroup.add(menuPanel);

  // Create title text for the menu - Apple design
  const titleCanvas = document.createElement('canvas');
  const titleContext = titleCanvas.getContext('2d');
  titleCanvas.width = 4096; // Ultra-high resolution for crisp text
  titleCanvas.height = 512; // Increased height for better quality

  // Enable high quality text rendering
  titleContext.imageSmoothingEnabled = true;
  titleContext.imageSmoothingQuality = 'high';

  // Create a subtle gradient background for the title (Apple-like)
  const titleGradient = titleContext.createLinearGradient(0, 0, 0, titleCanvas.height);
  titleGradient.addColorStop(0, '#303030'); // Dark gray top
  titleGradient.addColorStop(1, '#252525'); // Slightly darker bottom
  titleContext.fillStyle = titleGradient;
  titleContext.fillRect(0, 0, titleCanvas.width, titleCanvas.height);

  // Add a subtle line at the bottom of the title bar (more refined)
  titleContext.strokeStyle = '#505050';
  titleContext.lineWidth = 4; // Thicker for higher resolution
  titleContext.beginPath();
  titleContext.moveTo(0, titleCanvas.height - 4);
  titleContext.lineTo(titleCanvas.width, titleCanvas.height - 4);
  titleContext.stroke();

  // Crisp white text with SF Pro-like styling
  titleContext.fillStyle = '#FFFFFF';
  titleContext.font = '700 192px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  titleContext.textAlign = 'center';
  titleContext.textBaseline = 'middle';

  // Add subtle text shadow for depth
  titleContext.shadowColor = 'rgba(0, 0, 0, 0.5)';
  titleContext.shadowBlur = 8;
  titleContext.shadowOffsetX = 0;
  titleContext.shadowOffsetY = 2;

  titleContext.fillText('MENU', titleCanvas.width / 2, titleCanvas.height / 2);

  const titleTexture = new THREE.CanvasTexture(titleCanvas);
  // Use anisotropic filtering for sharper text at angles
  titleTexture.anisotropy = 64; // Increased anisotropy
  titleTexture.minFilter = THREE.LinearMipmapLinearFilter; // Trilinear filtering
  titleTexture.magFilter = THREE.LinearFilter;
  titleTexture.needsUpdate = true;
  const titleMaterial = new THREE.MeshBasicMaterial({
    map: titleTexture,
    transparent: true,
    side: THREE.DoubleSide
  });
  const titleGeometry = new THREE.PlaneGeometry(menuWidth, 0.06);
  const titleMesh = new THREE.Mesh(titleGeometry, titleMaterial);
  titleMesh.position.set(0, menuHeight / 2 + 0.04, 0.001);
  menuGroup.add(titleMesh);

  // Add text for each menu item - with higher quality rendering
  const itemHeight = menuHeight / menuItems.length;

  // Use Apple-inspired buttons for better visibility
  menuItems.forEach((item, index) => {
    // Calculate position for this item (centered vertically)
    const yPos = menuHeight / 2 - (index + 0.5) * itemHeight;

    // Create a button with hover effect - Apple-like metallic style
    const buttonWidth = menuWidth * 0.92;
    const buttonHeight = itemHeight * 0.8;
    const buttonGeometry = new THREE.PlaneGeometry(buttonWidth, buttonHeight);

    // Create a high-resolution button canvas
    const buttonCanvas = document.createElement('canvas');
    const buttonContext = buttonCanvas.getContext('2d');
    buttonCanvas.width = 4096; // Doubled again for ultra-high resolution
    buttonCanvas.height = 1024; // Doubled again for ultra-high resolution

    // Enable highest quality rendering
    buttonContext.imageSmoothingEnabled = true;
    buttonContext.imageSmoothingQuality = 'high';

    // Create metallic gradient for button - Apple-like
    const buttonGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height);
    buttonGradient.addColorStop(0, '#E2E2E2'); // Light metallic top
    buttonGradient.addColorStop(0.5, '#D8D8D8'); // Mid tone
    buttonGradient.addColorStop(1, '#CECECE'); // Slightly darker bottom

    // Fill and round corners (more refined rounded rect)
    buttonContext.fillStyle = buttonGradient;
    const cornerRadius = 160; // Scaled up with higher resolution

    // Draw rounded rectangle with more precision
    buttonContext.beginPath();
    buttonContext.moveTo(cornerRadius, 0);
    buttonContext.lineTo(buttonCanvas.width - cornerRadius, 0);
    buttonContext.quadraticCurveTo(buttonCanvas.width, 0, buttonCanvas.width, cornerRadius);
    buttonContext.lineTo(buttonCanvas.width, buttonCanvas.height - cornerRadius);
    buttonContext.quadraticCurveTo(buttonCanvas.width, buttonCanvas.height, buttonCanvas.width - cornerRadius, buttonCanvas.height);
    buttonContext.lineTo(cornerRadius, buttonCanvas.height);
    buttonContext.quadraticCurveTo(0, buttonCanvas.height, 0, buttonCanvas.height - cornerRadius);
    buttonContext.lineTo(0, cornerRadius);
    buttonContext.quadraticCurveTo(0, 0, cornerRadius, 0);
    buttonContext.closePath();
    buttonContext.fill();

    // Add subtle inner shadow for 3D effect
    buttonContext.shadowColor = 'rgba(0, 0, 0, 0.15)';
    buttonContext.shadowBlur = 30; // Increased blur for higher resolution
    buttonContext.shadowOffsetY = 6;  // Increased for higher resolution
    buttonContext.shadowOffsetX = 0;

    // Add a subtle highlight at the top edge
    const highlightGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height * 0.1);
    highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
    highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    buttonContext.fillStyle = highlightGradient;
    buttonContext.beginPath();
    buttonContext.rect(cornerRadius, 2, buttonCanvas.width - cornerRadius * 2, buttonCanvas.height * 0.1);
    buttonContext.fill();

    // Add a subtle border
    buttonContext.strokeStyle = 'rgba(0, 0, 0, 0.15)';
    buttonContext.lineWidth = 4; // Thicker line for higher resolution

    // Re-draw the rounded rectangle for the stroke
    buttonContext.beginPath();
    buttonContext.moveTo(cornerRadius, 0);
    buttonContext.lineTo(buttonCanvas.width - cornerRadius, 0);
    buttonContext.quadraticCurveTo(buttonCanvas.width, 0, buttonCanvas.width, cornerRadius);
    buttonContext.lineTo(buttonCanvas.width, buttonCanvas.height - cornerRadius);
    buttonContext.quadraticCurveTo(buttonCanvas.width, buttonCanvas.height, buttonCanvas.width - cornerRadius, buttonCanvas.height);
    buttonContext.lineTo(cornerRadius, buttonCanvas.height);
    buttonContext.quadraticCurveTo(0, buttonCanvas.height, 0, buttonCanvas.height - cornerRadius);
    buttonContext.lineTo(0, cornerRadius);
    buttonContext.quadraticCurveTo(0, 0, cornerRadius, 0);
    buttonContext.closePath();
    buttonContext.stroke();

    // Create high-quality texture
    const buttonTexture = new THREE.CanvasTexture(buttonCanvas);
    buttonTexture.anisotropy = 64; // Increased anisotropic filtering
    buttonTexture.minFilter = THREE.LinearMipmapLinearFilter; // Use trilinear filtering
    buttonTexture.magFilter = THREE.LinearFilter; // Use linear filtering
    buttonTexture.needsUpdate = true; // Ensure texture updates

    const buttonMaterial = new THREE.MeshBasicMaterial({
      map: buttonTexture,
      transparent: true,
      opacity: 1.0,
      side: THREE.DoubleSide
    });

    const button = new THREE.Mesh(buttonGeometry, buttonMaterial);
    button.position.set(0, yPos, 0.001);
    button.userData = {
      type: 'menuButton',
      command: item.command,
      index: index,
      normalTexture: buttonTexture,
      isHighlighted: false,
      isPressed: false,
      pressTime: 0
    };
    menuGroup.add(button);

    // Add text label with crisp rendering
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = 4096;  // Doubled resolution again
    canvas.height = 1024;  // Doubled resolution again

    // Enable high quality text rendering
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    // Apply subpixel anti-aliasing
    if (context.filter !== undefined) {
      context.filter = 'none';
    }

    // Apple-style dark gray text
    context.fillStyle = '#262626'; // Slightly darker for better contrast
    // Use SF Pro-like font stack with larger size for higher resolution
    context.font = '700 224px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // Create crisp text by first drawing with shadow then the main text
    context.shadowColor = 'rgba(255, 255, 255, 0.3)';
    context.shadowBlur = 8;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 1;

    // Draw the text
    context.fillText(item.name.toUpperCase(), canvas.width / 2, canvas.height / 2);

    // Remove shadow and draw text again for extra crispness
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.fillStyle = '#1E1E1E'; // Even darker for better contrast
    context.fillText(item.name.toUpperCase(), canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 64; // Higher anisotropic filtering
    texture.minFilter = THREE.LinearMipmapLinearFilter; // Use trilinear filtering
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    const labelMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide
    });
    const labelGeometry = new THREE.PlaneGeometry(buttonWidth * 0.85, buttonHeight * 0.7);
    const label = new THREE.Mesh(labelGeometry, labelMaterial);
    label.position.set(0, yPos, 0.002);
    label.userData = {
      buttonParent: button,
      type: 'buttonLabel',
      index: index,
      command: item.command
    };
    menuGroup.add(label);

    // Store reference to this label in the button for easy access
    button.userData.label = label;
  });

  // Apply 50% scale to the entire menu
  menuGroup.scale.set(0.5, 0.5, 0.5);

  // Initial position - will be properly positioned in positionMenuRelativeToRobot
  menuGroup.position.set(0, 0, -1.0);
  menuGroup.rotation.y = 0;

  // Add very small, subtle debug markers
  const centerSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.01),
    new THREE.MeshBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.5 })
  );
  centerSphere.position.set(0, 0, 0);
  menuGroup.add(centerSphere);

  scene.add(menuGroup);

  // Verify menu is in scene
  if (menuGroup.parent === scene) {
    log('✓ Menu successfully added to scene');
  } else {
    log('! Menu not in scene properly, forcing add');
    scene.add(menuGroup);
  }

  // Position the menu in the right corner, relative to the camera
  positionMenuRelativeToRobot(scene, robotConfig.id);

  // Make sure menu is enabled
  menuEnabled = true;

  log('Floating menu created and added to scene');

  // Set a repeated check to ensure menu remains visible
  const ensureInterval = setInterval(() => {
    if (menuGroup && menuGroup.parent) {
      // Verify it's in the right position
      const camera = getCamera();
      if (camera) {
        positionMenuRelativeToRobot(scene, robotConfig.id);
      }
    } else {
      log('Menu disappeared from scene - recreating');
      clearInterval(ensureInterval);
      if (scene) {
        // Get selected robot ID
        const selectedRobotId = getSelectedRobotId();
        if (selectedRobotId) {
          fetch(`/api/robots/${selectedRobotId}`)
            .then(response => response.json())
            .then(robotConfig => {
              createFloatingMenu(scene, robotConfig);
            })
            .catch(error => {
              log(`Error fetching robot config: ${error}`);
            });
        }
      }
    }
  }, 3000);
}

// Ensure the menu is readable from the current camera position
function updateMenuOrientation(camera) {
  if (menuGroup) {
    // Get the camera's position
    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);

    // Calculate angle to camera in the xz plane only
    const menuPosition = menuGroup.position.clone();
    const angle = Math.atan2(
      cameraPosition.x - menuPosition.x,
      cameraPosition.z - menuPosition.z
    );

    // Apply rotation only around y-axis to keep it readable
    menuGroup.rotation.y = angle;

    // Add debug log periodically to confirm menu is being updated
    if (Math.random() < 0.01) {
      log(`Menu is at position: ${menuPosition.x.toFixed(2)}, ${menuPosition.y.toFixed(2)}, ${menuPosition.z.toFixed(2)}`);
    }
  }
}

// Handle ray intersection with menu items
function handleMenuIntersection(controller) {
  if (!menuEnabled || !menuGroup) return { hit: false };

  // Create a raycaster from the controller
  const tempMatrix = new THREE.Matrix4();
  tempMatrix.identity().extractRotation(controller.matrixWorld);

  menuRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  menuRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

  // Check for intersections with menu items
  const intersects = menuRaycaster.intersectObjects(menuGroup.children, true);

  // Reset all button highlights first
  resetAllButtonHighlights();

  // Update the ray tip position if there's an intersection
  if (intersects.length > 0) {
    const controllerId = controller.userData.controllerId;
    const rayGroup = controllerRays[controllerId];

    if (rayGroup) {
      // Get the first ray tip (second child)
      const rayTip = rayGroup.children[1];
      if (rayTip) {
        // Convert intersection point to local space of the controller
        const worldPoint = intersects[0].point.clone();
        const localPoint = controller.worldToLocal(worldPoint);
        // Update tip position
        rayTip.position.copy(localPoint);
      }
    }
  }

  // Handle any intersections
  if (intersects.length > 0) {
    for (let i = 0; i < intersects.length; i++) {
      const intersect = intersects[i].object;
      if (intersect.userData && intersect.userData.type === 'menuButton') {
        // Highlight the button
        highlightButton(intersect, true);

        return {
          hit: true,
          command: intersect.userData.command,
          button: intersect
        };
      }
    }
  }

  return { hit: false };
}

// Reset all button highlights
function resetAllButtonHighlights() {
  if (!menuGroup) return;

  menuGroup.children.forEach(child => {
    if (child.userData && child.userData.type === 'menuButton' && child.userData.isHighlighted) {
      highlightButton(child, false);
    }
  });
}

// Update controller rays in the scene
function updateControllerRays() {
  // Update ray intersections with menu for visual feedback
  if (controller1 && controller1.userData && controller1.userData.controllerId) {
    handleMenuIntersection(controller1);
  }

  if (controller2 && controller2.userData && controller2.userData.controllerId) {
    handleMenuIntersection(controller2);
  }
}

// Execute a menu command by sending HTTP request to server
async function executeMenuCommand(command, button) {
  try {
    const robotId = getSelectedRobotId();
    if (!robotId) {
      log('Cannot execute command: No robot selected');
      return;
    }

    log(`Executing menu command: ${command}`);

    // Show visual feedback that the command is being executed
    if (button) {
      setButtonPressed(button, true);
    }

    // Send HTTP request to the server
    const response = await fetch(`/api/robots/${robotId}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        command: command
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`Error executing command: ${errorText}`);
      return false;
    }

    const result = await response.json();
    log(`Command ${command} executed successfully: ${JSON.stringify(result)}`);
    return true;
  } catch (error) {
    log(`Error executing command: ${error.message}`);
    return false;
  }
}

// Setup controllers with event listeners for IK control
function setupControllers(renderer, session, scene) {
  if (!renderer || !renderer.xr) {
    log('Cannot setup controllers: renderer.xr not available');
    return;
  }

  // Controller 1
  controller1 = renderer.xr.getController(0);
  controller1.userData = { controllerId: 'left_controller' }; // Default, will be updated when connected

  controller1.addEventListener('connected', (event) => {
    // Get handedness information
    controller1Handedness = event.data.handedness || 'unknown';
    log(`Controller 1 connected: ${controller1Handedness} hand`);

    // Set controller ID based on handedness
    controller1.userData.controllerId = controller1Handedness === 'right' ? 'right_controller' : 'left_controller';
    log(`Controller 1 assigned ID: ${controller1.userData.controllerId}`);

    // Add a visible ray to the controller
    addControllerRay(controller1, scene);
  });

  controller1.addEventListener('disconnected', () => {
    log('Controller 1 disconnected');
    // Remove the ray
    removeControllerRay(controller1);
    // Deactivate if it was active
    if (controller1.userData.controllerId in activeControllers) {
      deactivateIK(controller1);
    }
  });

  controller1.addEventListener('selectstart', () => {
    log(`Controller 1 (${controller1.userData.controllerId}) trigger pressed`);

    // Check for menu interaction first
    const menuInteraction = handleMenuIntersection(controller1) || { hit: false };
    if (menuInteraction && menuInteraction.hit) {
      log(`Menu item clicked: ${menuInteraction.command}`);
      executeMenuCommand(menuInteraction.command, menuInteraction.button);
      // Vibrate controller for haptic feedback if available
      if (controller1.gamepad && controller1.gamepad.hapticActuators && controller1.gamepad.hapticActuators.length > 0) {
        controller1.gamepad.hapticActuators[0].pulse(0.8, 100); // Intensity, duration in ms
      }
      return;
    }

    // Get current controller position for initial reference
    const currentPos = new THREE.Vector3();
    controller1.getWorldPosition(currentPos);
    controller1.userData.triggerStartPosition = currentPos.clone();

    activateIK(controller1);
  });

  controller1.addEventListener('selectend', () => {
    log(`Controller 1 (${controller1.userData.controllerId}) trigger released`);

    // Clear trigger position reference
    controller1.userData.triggerStartPosition = null;

    if (controller1.userData.controllerId in activeControllers) {
      deactivateIK(controller1);
    }
  });

  // Add grip button event listeners for synchronizing
  controller1.addEventListener('squeezestart', () => {
    log(`Controller 1 (${controller1.userData.controllerId}) grip pressed - synchronizing with ghost`);
    syncWithGhost(controller1);
  });

  scene.add(controller1);

  // Controller 2
  controller2 = renderer.xr.getController(1);
  controller2.userData = { controllerId: 'right_controller' }; // Default, will be updated when connected

  controller2.addEventListener('connected', (event) => {
    // Get handedness information
    controller2Handedness = event.data.handedness || 'unknown';
    log(`Controller 2 connected: ${controller2Handedness} hand`);

    // Set controller ID based on handedness
    controller2.userData.controllerId = controller2Handedness === 'right' ? 'right_controller' : 'left_controller';
    log(`Controller 2 assigned ID: ${controller2.userData.controllerId}`);

    // Add a visible ray to the controller
    addControllerRay(controller2, scene);
  });

  controller2.addEventListener('disconnected', () => {
    log('Controller 2 disconnected');
    // Remove the ray
    removeControllerRay(controller2);
    // Deactivate if it was active
    if (controller2.userData.controllerId in activeControllers) {
      deactivateIK(controller2);
    }
  });

  controller2.addEventListener('selectstart', () => {
    log(`Controller 2 (${controller2.userData.controllerId}) trigger pressed`);

    // Check for menu interaction first
    const menuInteraction = handleMenuIntersection(controller2) || { hit: false };
    if (menuInteraction && menuInteraction.hit) {
      log(`Menu item clicked: ${menuInteraction.command}`);
      executeMenuCommand(menuInteraction.command, menuInteraction.button);
      // Vibrate controller for haptic feedback if available
      if (controller2.gamepad && controller2.gamepad.hapticActuators && controller2.gamepad.hapticActuators.length > 0) {
        controller2.gamepad.hapticActuators[0].pulse(0.8, 100); // Intensity, duration in ms
      }
      return;
    }

    // Get current controller position for initial reference
    const currentPos = new THREE.Vector3();
    controller2.getWorldPosition(currentPos);
    controller2.userData.triggerStartPosition = currentPos.clone();

    activateIK(controller2);
  });

  controller2.addEventListener('selectend', () => {
    log(`Controller 2 (${controller2.userData.controllerId}) trigger released`);

    // Clear trigger position reference
    controller2.userData.triggerStartPosition = null;

    if (controller2.userData.controllerId in activeControllers) {
      deactivateIK(controller2);
    }
  });

  // Add grip button event listeners for synchronizing
  controller2.addEventListener('squeezestart', () => {
    log(`Controller 2 (${controller2.userData.controllerId}) grip pressed - synchronizing with ghost`);
    syncWithGhost(controller2);
  });

  scene.add(controller2);

  log('✓ Controllers set up with IK event handlers');
}

// Add a visible ray to the controller
function addControllerRay(controller, scene) {
  if (!controller) return;

  const controllerId = controller.userData.controllerId;
  log(`Adding ray to controller ${controllerId}`);

  // Create a ray geometry - a thin, long cylinder
  const rayGeometry = new THREE.CylinderGeometry(0.002, 0.002, RAY_LENGTH, 8);
  // Rotate so it points forward (Z-axis)
  rayGeometry.rotateX(Math.PI / 2);
  // Move the origin to the bottom of the cylinder
  rayGeometry.translate(0, 0, -RAY_LENGTH / 2);

  // Create a bright blue material
  const rayMaterial = new THREE.MeshBasicMaterial({
    color: 0xFFFFFF,
    transparent: true,
    opacity: 0.7
  });

  // Create the ray mesh
  const ray = new THREE.Mesh(rayGeometry, rayMaterial);
  ray.name = `controllerRay_${controllerId}`;

  // Add a small sphere at the tip for better visibility
  const tipGeometry = new THREE.SphereGeometry(0.005, 8, 8);
  const tipMaterial = new THREE.MeshBasicMaterial({ color: 0x44FFFF });
  const tip = new THREE.Mesh(tipGeometry, tipMaterial);
  tip.position.set(0, 0, -RAY_LENGTH);

  // Create a group to hold the ray and tip
  const rayGroup = new THREE.Group();
  rayGroup.add(ray);
  rayGroup.add(tip);

  // Add the ray to the controller
  controller.add(rayGroup);

  // Store reference to ray for updates
  controllerRays[controllerId] = rayGroup;

  log(`Ray added to controller ${controllerId}`);
}

// Remove controller ray
function removeControllerRay(controller) {
  if (!controller) return;

  const controllerId = controller.userData.controllerId;
  if (controllerId && controllerRays[controllerId]) {
    log(`Removing ray from controller ${controllerId}`);
    controller.remove(controllerRays[controllerId]);
    delete controllerRays[controllerId];
  }
}

// Highlight or unhighlight a menu button 
function highlightButton(button, isHighlighted) {
  if (!button || !button.userData) return;

  // If button is already in the correct state, do nothing
  if (button.userData.isHighlighted === isHighlighted && !button.userData.isPressed) return;

  // Update the button's material
  const buttonCanvas = document.createElement('canvas');
  const buttonContext = buttonCanvas.getContext('2d');
  buttonCanvas.width = 1024;
  buttonCanvas.height = 256;

  // Apple-inspired button states
  const cornerRadius = 40;

  if (button.userData.isPressed) {
    // Pressed appearance - darker with inset effect (Apple-like)
    const buttonGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height);
    buttonGradient.addColorStop(0, '#BEBEBE'); // Darker top when pressed
    buttonGradient.addColorStop(1, '#C8C8C8'); // Slightly lighter bottom

    buttonContext.fillStyle = buttonGradient;
    drawRoundedRect(buttonContext, 0, 0, buttonCanvas.width, buttonCanvas.height, cornerRadius);
    buttonContext.fill();

    // Inset shadow for pressed state
    buttonContext.shadowColor = 'rgba(0, 0, 0, 0.25)';
    buttonContext.shadowBlur = 5;
    buttonContext.shadowOffsetY = -1;
    buttonContext.shadowOffsetX = 0;

    // Darker border
    buttonContext.strokeStyle = 'rgba(0, 0, 0, 0.2)';
    buttonContext.lineWidth = 2;
    drawRoundedRect(buttonContext, 0, 0, buttonCanvas.width, buttonCanvas.height, cornerRadius);
    buttonContext.stroke();

  } else if (isHighlighted) {
    // Highlighted appearance - subtle blue tint (Apple-style)
    const buttonGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height);
    buttonGradient.addColorStop(0, '#E5EFFD'); // Very light blue top
    buttonGradient.addColorStop(1, '#D8E6F9'); // Slightly darker light blue bottom

    buttonContext.fillStyle = buttonGradient;
    drawRoundedRect(buttonContext, 0, 0, buttonCanvas.width, buttonCanvas.height, cornerRadius);
    buttonContext.fill();

    // Subtle outer glow for highlighted state
    buttonContext.shadowColor = 'rgba(0, 122, 255, 0.4)';
    buttonContext.shadowBlur = 8;
    buttonContext.shadowOffsetY = 0;
    buttonContext.shadowOffsetX = 0;

    // Blue tinted border
    buttonContext.strokeStyle = 'rgba(0, 122, 255, 0.6)';
    buttonContext.lineWidth = 1;
    drawRoundedRect(buttonContext, 0, 0, buttonCanvas.width, buttonCanvas.height, cornerRadius);
    buttonContext.stroke();

    // Add a subtle highlight at the top edge
    const highlightGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height * 0.1);
    highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
    highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    buttonContext.fillStyle = highlightGradient;
    buttonContext.beginPath();
    buttonContext.rect(cornerRadius, 1, buttonCanvas.width - cornerRadius * 2, buttonCanvas.height * 0.1);
    buttonContext.fill();

  } else {
    // Normal appearance - metallic silver (Apple-like)
    const buttonGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height);
    buttonGradient.addColorStop(0, '#E2E2E2'); // Light metallic top
    buttonGradient.addColorStop(0.5, '#D8D8D8'); // Mid tone
    buttonGradient.addColorStop(1, '#CECECE'); // Slightly darker bottom

    buttonContext.fillStyle = buttonGradient;
    drawRoundedRect(buttonContext, 0, 0, buttonCanvas.width, buttonCanvas.height, cornerRadius);
    buttonContext.fill();

    // Add subtle inner shadow for 3D effect
    buttonContext.shadowColor = 'rgba(0, 0, 0, 0.1)';
    buttonContext.shadowBlur = 10;
    buttonContext.shadowOffsetY = 2;
    buttonContext.shadowOffsetX = 0;

    // Add a subtle highlight at the top edge
    const highlightGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height * 0.1);
    highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
    highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    buttonContext.fillStyle = highlightGradient;
    buttonContext.beginPath();
    buttonContext.rect(cornerRadius, 1, buttonCanvas.width - cornerRadius * 2, buttonCanvas.height * 0.1);
    buttonContext.fill();

    // Add a subtle border
    buttonContext.strokeStyle = 'rgba(0, 0, 0, 0.1)';
    buttonContext.lineWidth = 1;
    drawRoundedRect(buttonContext, 0, 0, buttonCanvas.width, buttonCanvas.height, cornerRadius);
    buttonContext.stroke();
  }

  // Create high-quality texture
  const buttonTexture = new THREE.CanvasTexture(buttonCanvas);
  buttonTexture.anisotropy = 16; // Sharper texture at angles

  // Update the button material
  button.material.map = buttonTexture;
  button.material.needsUpdate = true;
  button.userData.isHighlighted = isHighlighted;
}

// Helper function to draw rounded rectangles consistently
function drawRoundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

// Set button to pressed state with animation
function setButtonPressed(button, isPressed) {
  if (!button || !button.userData) return;

  button.userData.isPressed = isPressed;
  button.userData.pressTime = Date.now();

  // Find the associated label if it exists
  let buttonLabel = null;
  if (menuGroup) {
    menuGroup.children.forEach(child => {
      if (child.userData &&
        child.userData.type === 'buttonLabel' &&
        child.userData.buttonParent === button) {
        buttonLabel = child;
      }
    });
  }

  // Apply immediate visual change
  if (isPressed) {
    // Apply a completely new pressed style
    const buttonCanvas = document.createElement('canvas');
    const buttonContext = buttonCanvas.getContext('2d');
    buttonCanvas.width = 4096; // Match the higher resolution of normal buttons
    buttonCanvas.height = 1024;

    // Enable high quality rendering
    buttonContext.imageSmoothingEnabled = true;
    buttonContext.imageSmoothingQuality = 'high';

    const cornerRadius = 160; // Match normal buttons

    // Create dark blue gradient for pressed state (Apple-like)
    // Using a darker blue to ensure text contrast
    const buttonGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height);
    buttonGradient.addColorStop(0, '#005EA8'); // Darker blue top
    buttonGradient.addColorStop(1, '#0066B3'); // Slightly lighter but still dark blue bottom

    buttonContext.fillStyle = buttonGradient;
    drawRoundedRect(buttonContext, 0, 0, buttonCanvas.width, buttonCanvas.height, cornerRadius);
    buttonContext.fill();

    // Add deep inset shadow for clear pressed effect
    buttonContext.shadowColor = 'rgba(0, 0, 0, 0.4)';
    buttonContext.shadowBlur = 20;
    buttonContext.shadowOffsetY = -3;
    buttonContext.shadowOffsetX = 0;

    // Draw inner shadow effect
    const innerShadowGradient = buttonContext.createLinearGradient(0, 0, 0, buttonCanvas.height * 0.1);
    innerShadowGradient.addColorStop(0, 'rgba(0, 0, 0, 0.4)');
    innerShadowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    buttonContext.fillStyle = innerShadowGradient;
    drawRoundedRect(buttonContext, 4, 4, buttonCanvas.width - 8, buttonCanvas.height * 0.2, cornerRadius);
    buttonContext.fill();

    // Add blue glow effect
    buttonContext.shadowColor = 'rgba(0, 128, 255, 0.6)';
    buttonContext.shadowBlur = 20;
    buttonContext.shadowOffsetY = 0;
    buttonContext.shadowOffsetX = 0;

    // Add stronger border
    buttonContext.strokeStyle = 'rgba(0, 60, 140, 0.9)';
    buttonContext.lineWidth = 6;
    drawRoundedRect(buttonContext, 0, 0, buttonCanvas.width, buttonCanvas.height, cornerRadius);
    buttonContext.stroke();

    // Create high-quality texture
    const buttonTexture = new THREE.CanvasTexture(buttonCanvas);
    buttonTexture.anisotropy = 64;
    buttonTexture.minFilter = THREE.LinearMipmapLinearFilter;
    buttonTexture.magFilter = THREE.LinearFilter;
    buttonTexture.needsUpdate = true;

    // Update the button material
    button.material.map = buttonTexture;
    button.material.needsUpdate = true;

    // Scale and position change for press animation
    button.scale.set(0.98, 0.98, 0.98);
    button.position.z = -0.001; // Move backward slightly

    // If we have a label, make it white
    if (buttonLabel) {
      // Create a new white text label
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = 4096; // Match higher resolution
      canvas.height = 1024;

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';

      // White text for pressed button with slight stroke to ensure visibility
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      // Create text with outer stroke for visibility
      context.font = '700 224px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

      // First draw a dark outline for the text (for better contrast)
      context.lineWidth = 10;
      context.strokeStyle = 'rgba(0, 40, 90, 0.8)';
      const buttonName = button.userData.command ? button.userData.command.toUpperCase() : "BUTTON";
      context.strokeText(buttonName, canvas.width / 2, canvas.height / 2);

      // Then draw the bright text on top
      context.fillStyle = '#FFFFFF';
      context.shadowColor = 'rgba(255, 255, 255, 0.7)';
      context.shadowBlur = 12;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
      context.fillText(buttonName, canvas.width / 2, canvas.height / 2);

      const texture = new THREE.CanvasTexture(canvas);
      texture.anisotropy = 64;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;

      buttonLabel.material.map = texture;
      buttonLabel.material.needsUpdate = true;

      // Match label scale to button
      buttonLabel.scale.set(0.98, 0.98, 0.98);
      buttonLabel.position.z = -0.0005; // Move backward slightly
    }

    // Set a timeout to return to normal
    setTimeout(() => {
      if (button.userData) {
        setButtonPressed(button, false);
      }
    }, 200); // Shorter animation for more responsive feel
  } else {
    // Return to normal scale and position
    button.scale.set(1, 1, 1);
    button.position.z = 0.001;

    // Reset button appearance
    highlightButton(button, false);

    // Reset label position if we have one
    if (buttonLabel) {
      // Create a new text label with original styling
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = 4096;  // Match button resolution
      canvas.height = 1024;

      // Enable high quality text rendering
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';

      // Apply subpixel anti-aliasing
      if (context.filter !== undefined) {
        context.filter = 'none';
      }

      // Apple-style dark gray text
      context.fillStyle = '#262626'; // Slightly darker for better contrast
      // Use SF Pro-like font stack with larger size for higher resolution
      context.font = '700 224px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      // Create crisp text by first drawing with shadow then the main text
      context.shadowColor = 'rgba(255, 255, 255, 0.3)';
      context.shadowBlur = 8;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 1;

      // Draw the text
      const buttonName = button.userData.command ? button.userData.command.toUpperCase() : "BUTTON";
      context.fillText(buttonName, canvas.width / 2, canvas.height / 2);

      // Remove shadow and draw text again for extra crispness
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.fillStyle = '#1E1E1E'; // Even darker for better contrast
      context.fillText(buttonName, canvas.width / 2, canvas.height / 2);

      const texture = new THREE.CanvasTexture(canvas);
      texture.anisotropy = 64; // Higher anisotropic filtering
      texture.minFilter = THREE.LinearMipmapLinearFilter; // Use trilinear filtering
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;

      // Update the label material
      buttonLabel.material.map = texture;
      buttonLabel.material.needsUpdate = true;

      buttonLabel.scale.set(1, 1, 1);
      buttonLabel.position.z = 0.002;
    }
  }
}

// Activate inverse kinematics with the specified controller
function activateIK(controller) {
  try {
    if (!controller) {
      console.error("activateIK: Controller is null or undefined");
      return;
    }

    log(`Activating IK control for controller: ${controller.userData?.controllerId}`);

    const controllerId = controller.userData?.controllerId;
    if (!controllerId) {
      console.error("activateIK: Controller has no controllerId");
      return;
    }

    const bindings = getControllerBindings();
    if (!bindings || !bindings[controllerId]) {
      console.error(`activateIK: No binding found for controller ${controllerId}`);
      return;
    }

    const binding = bindings[controllerId];
    const robotId = binding.robotId;
    const jointGroupName = binding.jointGroupName;

    // Get the robot configuration to find the end effector
    const robotConfig = window.availableRobots?.find(r => r.id === robotId);
    if (!robotConfig) {
      console.error(`No robot configuration found for ${robotId}`);
      return;
    }

    // Find the joint group configuration
    const jointGroup = robotConfig.joint_groups.find(g => g.name === jointGroupName);
    if (!jointGroup) {
      console.error(`No joint group configuration found for ${jointGroupName}`);
      return;
    }

    // Get the end effector from the joint group configuration
    const configuredEndEffector = jointGroup.end_effector;
    if (!configuredEndEffector) {
      console.error(`No end effector configured for joint group ${jointGroupName}`);
      return;
    }

    // Construct the ghost key directly
    const ghostJointGroupKey = `ghost_${robotId}_${jointGroupName}`;

    // Get all IK controllers
    const ikControllers = getAllIKControllers();
    log(`Available IK controllers: ${Object.keys(ikControllers).join(', ')}`);

    // Get the ghost IK controller
    let ghostIkController = ikControllers[ghostJointGroupKey];

    if (!ghostIkController) {
      // If no ghost controller exists, try to create one
      const ghostLoader = getJointGroupLoader(robotId, jointGroupName, true);
      if (ghostLoader) {
        try {
          ghostIkController = initIK(
            robotId,
            jointGroupName,
            configuredEndEffector,
            ghostLoader,
            null,
            null
          );
        } catch (error) {
          console.error("Failed to create ghost IK controller:", error);
          return;
        }
      }
    }

    if (!ghostIkController) {
      log(`Cannot activate IK: No ghost IK controller found for ${ghostJointGroupKey}`);
      return;
    }

    // Store the ghost controller reference directly in the controller's userData
    controller.userData.ghostController = ghostIkController;
    controller.userData.matchedKey = ghostJointGroupKey;

    // Initialize tracking variables
    controller.userData.previousPosition = new THREE.Vector3();
    controller.getWorldPosition(controller.userData.previousPosition);

    // Store the initial trigger position
    if (controller.userData.triggerStartPosition) {
      controller.userData.previousPosition.copy(controller.userData.triggerStartPosition);
    }

    // Reset IK controller tracking variables
    ghostIkController.resetTracking();

    // Get the current controller position and set as initial position
    const currentControllerPos = new THREE.Vector3();
    controller.getWorldPosition(currentControllerPos);
    ghostIkController.initialControllerPosition.copy(currentControllerPos);
    ghostIkController.previousControllerPosition.copy(currentControllerPos);

    // Get and verify the end effector position
    const currentPos = ghostIkController.getEndEffectorPosition();
    if (currentPos) {
      ghostIkController.initialEndEffectorPosition.copy(currentPos);
      log(`Reset end effector position to current: [${currentPos.x.toFixed(3)}, ${currentPos.y.toFixed(3)}, ${currentPos.z.toFixed(3)}]`);
    } else {
      console.error("ERROR: Could not get current end effector position for initialization");
      return;
    }

    // Store in active controllers
    activeControllers[controllerId] = {
      controller: controller,
      jointGroupKey: ghostJointGroupKey,
      initialPosition: currentControllerPos.clone()
    };

    // Activate the IK controller
    ghostIkController.activate();
    ghostIkController.activateRelativeMode();

    log(`Ghost IK control activated for ${ghostJointGroupKey}`);
  } catch (error) {
    console.error("Error activating IK:", error);
  }
}

// Deactivate inverse kinematics for a specific controller
function deactivateIK(controller) {
  console.log("DEBUG: deactivateIK called", controller);

  if (!controller) {
    // Deactivate all controllers
    console.log("Deactivating all controllers:", activeControllers);
    for (const controllerId in activeControllers) {
      const entry = activeControllers[controllerId];
      const ikControllers = getAllIKControllers();
      const ikController = ikControllers[entry.jointGroupKey];

      if (ikController) {
        ikController.deactivate();
        console.log(`Deactivated IK controller: ${ikController.armKey}`);
      }
    }
    activeControllers = {};
    log('All IK controls deactivated');
    return;
  }

  const controllerId = controller.userData.controllerId;
  console.log(`Checking if controller ${controllerId} is active:`, activeControllers);

  if (!controllerId || !(controllerId in activeControllers)) {
    return; // Not active
  }

  const entry = activeControllers[controllerId];
  const ikControllers = getAllIKControllers();
  const ikController = ikControllers[entry.jointGroupKey];

  if (ikController) {
    ikController.deactivate();
    console.log(`Deactivated IK controller: ${ikController.armKey}`);
  }

  // Clear controller tracking data
  controller.userData.previousPosition = null;
  controller.userData.triggerStartPosition = null;
  controller.userData.ghostController = null;
  controller.userData.matchedKey = null;

  delete activeControllers[controllerId];
  log(`IK control deactivated for ${controllerId}`);
}

// Get appropriate session mode based on device capabilities or user preference
function getSessionMode() {
  // If AR mode is forced, use AR regardless of device detection
  if (forceARMode) {
    log('Using forced AR mode');
    return 'immersive-ar';
  }

  // Otherwise use detection results
  if (isUsingVRMode) {
    return 'immersive-vr';
  }
  return 'immersive-ar';
}

// Start XR session (either AR or VR depending on device)
async function startAR(renderer, scene) {
  log('Starting XR session...');

  // Check WebXR support
  const xrSupported = await checkXR();
  if (!xrSupported) {
    log('❌ Cannot start XR: WebXR not supported');
    return false;
  }

  // Check permissions
  const permissionsGranted = await requestXRPermissions();
  if (!permissionsGranted) {
    log('❌ Cannot start XR: Permissions denied');
    return false;
  }

  try {
    // First initialize protobuf for proper binary messaging
    await initProtobuf();

    // Connect WebSocket only if not already connected by the button click handler
    if (!isWebSocketConnected()) {
      log('WebSocket not connected. This should have been done by the button click handler.');
      // We won't connect here as it should have been done in the button click handler
      // If we reach this point, it means something went wrong with the connection attempt
      log('⚠️ Continuing with XR without WebSocket connection');
    } else {
      log('WebSocket already connected, proceeding with XR session');
    }

    // No need to send dummy positions - we'll receive real joint positions from the server
    // through the WebSocket connection's message handler
    log('Receiving joint positions from physical robot through WebSocket');

    // Determine session mode (AR or VR)
    const sessionMode = getSessionMode();
    log(`Using XR session mode: ${sessionMode}`);

    // Configure scene for AR or VR mode
    const isARMode = sessionMode === 'immersive-ar';
    configureForAR(isARMode);

    // Get XR session with appropriate configuration based on mode
    let sessionConfig = {};
    if (sessionMode === 'immersive-ar') {
      log('Requesting AR session with passthrough...');

      // First verify that the canvas background is transparent
      const canvas = renderer.domElement;
      canvas.style.background = 'transparent';
      document.body.style.background = 'transparent';

      // Configure for Oculus passthrough
      sessionConfig = {
        requiredFeatures: ['local'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: document.getElementById('overlay') }
      };

      // For Oculus Quest, we need specific features
      if (isOculusQuestBrowser()) {
        log('Configuring for Oculus Quest passthrough');

        // These are the configurations indicated in Meta's documentation
        sessionConfig.optionalFeatures = [
          'dom-overlay',
          'plane-detection',
          'anchors',
          'hand-tracking'
        ];
      }
    } else {
      // VR mode
      log('Requesting VR session...');
      sessionConfig = {
        requiredFeatures: ['local'],
        optionalFeatures: ['hand-tracking', 'dom-overlay'],
        domOverlay: { root: document.getElementById('overlay') }
      };
    }

    log(`Session config: ${JSON.stringify(sessionConfig)}`);
    const session = await navigator.xr.requestSession(sessionMode, sessionConfig);

    // Double check renderer is configured for passthrough
    if (sessionMode === 'immersive-ar') {
      renderer.setClearColor(0x000000, 0);
      scene.background = null;
      log('Double-checked transparency settings for passthrough');
    }

    // Setup controllers for IK control
    setupControllers(renderer, session, scene);

    session.addEventListener('end', () => {
      log('XR session ended');
      document.getElementById('info').style.display = 'block';
      document.getElementById('startButton').style.display = 'block';
      document.getElementById('debug').style.display = 'block';
      document.getElementById('robotSelectorContainer').style.display = 'block';

      // Reset active controllers
      activeControllers = {};

      // Update joint controls
      updateJointAngleControls();
      document.getElementById('jointControlsContainer').style.display = 'block';

      // Disconnect WebSocket when leaving XR mode
      disconnectWebSocket();
    });

    log('Setting reference space type: local');
    renderer.xr.setReferenceSpaceType('local');

    log('Setting XR session on renderer...');
    await renderer.xr.setSession(session);
    log('✓ Session successfully set on renderer');

    // Update UI visibility
    document.getElementById('info').style.display = 'none';
    document.getElementById('startButton').style.display = 'none';
    document.getElementById('robotSelectorContainer').style.display = 'none';
    // Keep debug and joint controls visible for XR session
    document.getElementById('jointControlsContainer').style.display = 'block';

    // If in AR mode, show the AR mode indicator
    if (sessionMode === 'immersive-ar') {
      document.getElementById('arModeIndicator').style.display = 'block';
    }

    // Get the selected robot ID and fetch its configuration to create the menu
    const selectedRobotId = getSelectedRobotId();
    if (selectedRobotId) {
      try {
        // Check if camera views already exist for this robot before loading the model again
        const cameraViewsExist = scene.children.some(child =>
          child.name === `camera-views-${selectedRobotId}`
        );

        if (!cameraViewsExist) {
          // Load the robot model only if camera views don't exist
          log(`Loading robot model for ${selectedRobotId} in XR`);
          await loadRobotModel(selectedRobotId, scene);
        } else {
          log(`Camera views for robot ${selectedRobotId} already exist, skipping reload`);
        }

        // Fetch the robot config for menu creation
        log(`Fetching robot config for menu from /api/robots/${selectedRobotId}`);
        const response = await fetch(`/api/robots/${selectedRobotId}`);

        if (response.ok) {
          const robotConfig = await response.json();
          log(`Received robot config: ${JSON.stringify(robotConfig)}`);

          if (robotConfig && robotConfig.menu && robotConfig.menu.length > 0) {
            log(`Found ${robotConfig.menu.length} menu items`);
            // Create the floating menu with the robot's menu items
            createFloatingMenu(scene, robotConfig);

            // Position menu relative to the robot model
            positionMenuRelativeToRobot(scene, selectedRobotId);
          } else {
            log('No menu items found in robot configuration');
          }
        } else {
          log(`Error fetching robot config: ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        log(`Error loading robot or fetching menu config: ${error.message}`);
      }
    }

    log('Starting animation loop');
    const renderFunction = (timestamp, frame) => {
      // If we have a frame, log once when session starts
      if (frame && !renderFunction.sessionStarted) {
        log('✓ First frame rendered. XR session is active!');
        log(`Session mode: ${sessionMode}`);
        renderFunction.sessionStarted = true;

        if (frame.session.inputSources) {
          log(`Found ${frame.session.inputSources.length} input sources (controllers)`);
          for (let input of frame.session.inputSources) {
            log(`Input source: ${input.handedness || 'unknown'} hand`);
          }
        }

        // Schedule multiple visibility checks to ensure menu appears
        setTimeout(() => {
          log('Initial menu visibility check (3s)');
          ensureMenuVisibility(scene, selectedRobotId);
        }, 3000);

        setTimeout(() => {
          log('Secondary menu visibility check (6s)');
          ensureMenuVisibility(scene, selectedRobotId);
        }, 6000);

        setTimeout(() => {
          log('Final menu visibility check (10s)');
          ensureMenuVisibility(scene, selectedRobotId);
        }, 10000);
      }

      // Update controller rays for menu interaction
      updateControllerRays();

      // Update the menu to face the camera on every frame
      if (menuGroup) {
        updateMenuOrientation(getCamera());

        // Periodically check if menu is still in the scene
        if (frame && frame.timestamp && frame.timestamp % 1000 < 16) { // Roughly every second
          if (menuGroup.parent !== scene) {
            log('Menu disappeared from scene - re-adding');
            scene.add(menuGroup);
          }
        }
      }

      // Update IK targets for all active controllers
      const activeControllerCount = Object.keys(activeControllers).length;
      if (activeControllerCount > 0 && Math.random() < 0.1) { // Log every ~10 frames when controllers are active
        console.debug(`Animation loop: ${activeControllerCount} active controllers:`,
          Object.entries(activeControllers).map(([id, entry]) => ({
            id,
            position: entry.controller.position.toArray(),
            jointGroupKey: entry.jointGroupKey,
            hasGhostController: !!entry.controller.userData.ghostController,
            ghostControllerActive: entry.controller.userData.ghostController?.isActive
          }))
        );
      }

      // Handle joint button mappings
      if (frame && frame.session) {
        handleJointButtonMappings(frame, frame.session);
      }

      for (const controllerId in activeControllers) {
        const entry = activeControllers[controllerId];
        if (!entry.controller.userData.ghostController) {
          console.error(`No ghost controller found for ${controllerId} in animation loop`);
          continue;
        }
        if (!entry.controller.userData.ghostController.isActive) {
          console.error(`Ghost controller not active for ${controllerId} in animation loop`);
          continue;
        }

        const result = updateIKTarget(entry.controller);
        if (!result && Math.random() < 0.1) { // Log failures occasionally
          console.error(`Failed to update IK target for controller ${controllerId}`);
        }
      }

      // We need to make sure the scene actually renders
      renderer.render(scene, getCamera());
    };
    renderFunction.sessionStarted = false;

    // Set the render function on the renderer for XR session
    renderer.setAnimationLoop(renderFunction);

  } catch (error) {
    log(`❌ Error starting XR session: ${error.message}`);

    return false;
  }
}


// Synchronize the real robot with the ghost position
function syncWithGhost(controller) {
  const controllerId = controller.userData.controllerId;
  const bindings = getControllerBindings();

  if (!controllerId || !bindings[controllerId]) {
    return;
  }

  const binding = bindings[controllerId];
  const robotId = binding.robotId;
  const jointGroupName = binding.jointGroupName;

  // Call the synchronization function
  synchronizeWithGhost(robotId, jointGroupName);
}

// Direct controller movement mapping to joints (fallback when IK not available)
function mapControllerToJoints(controller, robotId, jointGroupName) {
  // Get controller position and rotation
  const position = new THREE.Vector3();
  controller.getWorldPosition(position);

  const quaternion = new THREE.Quaternion();
  controller.getWorldQuaternion(quaternion);

  // Convert quaternion to euler angles
  const euler = new THREE.Euler().setFromQuaternion(quaternion);

  log(`Controller position: [${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)}]`);
  log(`Controller rotation: [${euler.x.toFixed(3)}, ${euler.y.toFixed(3)}, ${euler.z.toFixed(3)}]`);

  // Create a mapping from controller to common joint names
  // We'll map the x,y,z position and rotation to common joint types

  // Try to find a ghost loader
  const loaderKeys = Object.keys(window.robotLoaders || {});
  const ghostLoaderKeys = loaderKeys.filter(key =>
    key.toLowerCase().includes('ghost') &&
    (key.includes(robotId) || key.includes(jointGroupName))
  );

  if (ghostLoaderKeys.length === 0) {
    log("No ghost loader found for direct joint control");
    return false;
  }

  const ghostLoaderKey = ghostLoaderKeys[0];
  const ghostLoader = window.robotLoaders[ghostLoaderKey];

  if (!ghostLoader || !ghostLoader.joints) {
    log("Ghost loader has no joints for direct control");
    return false;
  }

  // Get available joints
  const availableJoints = Object.keys(ghostLoader.joints);
  log(`Available joints for direct control: ${availableJoints.join(', ')}`);

  // Map controller movements to joint angles based on common naming conventions
  const jointUpdates = {};
  let updatedCount = 0;

  for (const jointName of availableJoints) {
    const name = jointName.toLowerCase();
    let angle = null;

    // Map controller positions/rotations to joint angles based on joint name
    if (name.includes('shoulder') && name.includes('pan')) {
      // X rotation for shoulder pan (left/right)
      angle = euler.y * 2.0;
    }
    else if (name.includes('shoulder') && (name.includes('lift') || name.includes('pitch'))) {
      // Y rotation for shoulder lift (up/down)
      angle = -euler.x * 2.0;
    }
    else if (name.includes('elbow')) {
      // Z position for elbow
      angle = (position.z - 0.3) * 2.0;
    }
    else if (name.includes('wrist') && (name.includes('flex') || name.includes('pitch'))) {
      // X rotation for wrist flex
      angle = euler.x * 2.0;
    }
    else if (name.includes('wrist') && (name.includes('roll') || name.includes('yaw'))) {
      // Z rotation for wrist roll
      angle = euler.z * 2.0;
    }
    else if (name.includes('gripper') || name.includes('hand')) {
      // Keep gripper in neutral position
      angle = 0.0;
    }

    // If we mapped this joint, update it
    if (angle !== null) {
      // Apply the angle to the ghost model
      const success = window.updateGhostJointAngle(robotId, jointGroupName, jointName, angle);
      if (success) {
        jointUpdates[jointName] = angle;
        updatedCount++;
      }
    }
  }

  log(`Updated ${updatedCount} joints with direct controller mapping`);
  return updatedCount > 0;
}

// Fallback to direct joint control from controller if IK fails
function useDirectControlFallback(controller) {
  log("Using direct joint control as fallback for ghost movement");

  const controllerId = controller.userData.controllerId;
  if (!controllerId) return false;

  const bindings = getControllerBindings();
  if (!bindings[controllerId]) return false;

  const binding = bindings[controllerId];
  const robotId = binding.robotId;
  const jointGroupName = binding.jointGroupName;

  return mapControllerToJoints(controller, robotId, jointGroupName);
}

// Handle joint button mappings
function handleJointButtonMappings(frame, session) {
  if (!frame || !session) return;

  // Get input sources (controllers)
  const inputSources = session.inputSources;
  if (!inputSources || inputSources.length === 0) return;

  // Get controller bindings
  const bindings = getControllerBindings();
  if (!bindings) return;

  // Process each input source (controller)
  for (const inputSource of inputSources) {
    // Skip if no gamepad
    if (!inputSource.gamepad) continue;

    // Get controller ID based on handedness
    const controllerId = inputSource.handedness === 'left' ? 'left_controller' : 'right_controller';

    // Skip if no binding for this controller
    if (!bindings[controllerId]) continue;

    // Get robot ID and joint group name from binding
    const { robotId, jointGroupName } = bindings[controllerId];
    if (!robotId || !jointGroupName) continue;

    // Get ghost loader using the getJointGroupLoader function (imported from robot.js)
    const ghostLoader = getJointGroupLoader(robotId, jointGroupName, true); // true to get ghost loader
    if (!ghostLoader || !ghostLoader.joints) {
      // Only log occasionally to avoid spamming the console
      if (Math.random() < 0.01) {
        console.warn(`No ghost loader found for ${robotId} - ${jointGroupName}`);
      }
      continue;
    }

    // Get button states
    const buttons = inputSource.gamepad.buttons;
    if (!buttons || buttons.length === 0) continue;

    // Check each joint in the ghost loader for button mappings
    for (const jointName in ghostLoader.joints) {
      const joint = ghostLoader.joints[jointName];

      // Skip if joint has no button mapping
      if (!joint || !joint.button_mapping) continue;

      // Process button mappings for this joint
      for (const [action, buttonIndex] of Object.entries(joint.button_mapping)) {
        // Check if button is within range
        if (buttonIndex >= 0 && buttonIndex < buttons.length) {
          // Check if button is pressed
          if (buttons[buttonIndex].pressed) {
            // Calculate target angle based on action
            let targetAngle = 0;

            // Common action mappings
            switch (action.toLowerCase()) {
              case 'open':
                targetAngle = Math.PI / 2; // 90 degrees open position
                break;
              case 'close':
                targetAngle = 0; // Closed position
                break;
              case 'increase':
                // Gradually increase angle
                targetAngle = (joint.currentAngle || 0) + 0.05;
                break;
              case 'decrease':
                // Gradually decrease angle
                targetAngle = (joint.currentAngle || 0) - 0.05;
                break;
              default:
                // For custom actions, try to parse a numeric value or use as is
                const numValue = parseFloat(action);
                if (!isNaN(numValue)) {
                  targetAngle = numValue;
                } else {
                  log(`Unknown button action: ${action} for joint ${jointName}`);
                  continue;
                }
            }

            // Update ghost joint angle
            const success = updateGhostJointAngle(robotId, jointGroupName, jointName, targetAngle);
            if (success) {
              log(`Button ${buttonIndex} pressed: Set ${jointName} to ${targetAngle.toFixed(2)} rad (${action})`);
            }
          }
        }
      }
    }
  }
}

// Expose fallback function to window object
window.useDirectControlFallback = useDirectControlFallback;

// Expose the existing controller bindings getter to the window object
window.getControllerBindings = getControllerBindings;

// Position menu relative to the robot model
function positionMenuRelativeToRobot(scene, robotId) {
  if (!menuGroup) {
    log('Cannot position menu: menu group does not exist');
    return;
  }

  log('Positioning menu in right corner...');

  // Always position the menu in the right corner relative to the camera
  const camera = getCamera();
  if (camera) {
    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);

    // Get camera orientation
    const cameraDirection = new THREE.Vector3(0, 0, -1);
    cameraDirection.applyQuaternion(camera.quaternion);

    // Get right vector (perpendicular to camera direction)
    const rightVector = new THREE.Vector3(1, 0, 0);
    rightVector.applyQuaternion(camera.quaternion);

    // Position in right corner of view
    // 0.3 units to the right, 0.1 units below center, and 1.0 meters in front
    menuGroup.position.set(
      cameraPosition.x + rightVector.x * 0.3,
      cameraPosition.y - 0.1, // Slightly below eye level
      cameraPosition.z + rightVector.z * 0.3 - 1.0 // 1.0 meter forward, offset to right
    );

    // Make it partially face the camera (angled so it's visible but doesn't block the view)
    menuGroup.lookAt(cameraPosition);
    // Add a slight rotation so it's not directly facing the camera
    menuGroup.rotateY(-Math.PI / 8); // slight angle for better visibility

    log(`Positioned menu at ${menuGroup.position.toArray().join(', ')}`);

    // Immediately verify menu is in scene
    if (menuGroup.parent === scene) {
      log('✓ Menu is correctly added to scene');
    } else {
      log('! Menu is not in scene, adding it now');
      scene.add(menuGroup);
    }

    // Make sure menu is enabled
    menuEnabled = true;
  } else {
    // Fallback to fixed position
    log('Camera not available, using fixed position');
    menuGroup.position.set(0.3, -0.1, -1.0);
  }
}

// Make sure the menu is visible after scene loads
function ensureMenuVisibility(scene, robotId) {
  log('Checking menu visibility...');

  if (!menuGroup) {
    log('Menu group not found, attempting to recreate menu');
    // Try to get robot config and recreate menu
    fetch(`/api/robots/${robotId}`)
      .then(response => response.json())
      .then(robotConfig => {
        log('Got robot config, recreating menu');
        createFloatingMenu(scene, robotConfig);
      })
      .catch(error => {
        log(`Error getting robot config for visibility check: ${error}`);
      });
    return;
  }

  // If menu exists but might be positioned incorrectly, reposition it
  positionMenuRelativeToRobot(scene, robotId);
}

export {
  checkXR,
  startAR
};