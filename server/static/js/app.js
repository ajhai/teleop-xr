/**
 * Main application for WebXR Robot Control
 */

import { log } from './modules/logger.js';
import { init, getScene, getRenderer, getCamera } from './modules/scene.js';
import { checkXR, startAR } from './modules/xr.js';
import {
  fetchRobotModels,
  loadRobotModel,
  toggleDebugMode,
} from './modules/robot.js';
import { initProtobuf } from './modules/proto.js';
import { connectWebSocket, getAllCameraImages } from './modules/websocket.js';
import { initCameraViews, updateCameraViewsPositions } from './modules/camera-view.js';

// Function to create standalone camera views (without robot model)
function createStandaloneCameraViews(scene) {
  // Get any available camera images
  const currentImages = getAllCameraImages();

  // Check if we have any camera images
  if (Object.keys(currentImages).length === 0) {
    log('No camera images available to create standalone views');
    return false;
  }

  log(`Creating standalone camera views for ${Object.keys(currentImages).length} cameras`);

  // Remove any existing standalone camera views to avoid duplication
  scene.children.forEach(child => {
    if (child.name === 'camera-views-standalone') {
      log('Removing existing standalone camera views');
      scene.remove(child);
    }
  });

  // Create camera views with 'standalone' as robot ID
  const cameraViews = initCameraViews(scene, 'standalone', null, {
    position: [0, 0.2, -0.5], // Position in front of user
    rotation: [0, Math.PI, 0],  // Rotate to face the user
    offset: [0, 0, 0],    // No offset since no robot model
    width: 0.4,           // Slightly larger
    height: 0.3
  });

  return cameraViews ? true : false;
}

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
  log('DOM Content Loaded - Starting application');

  // Initialize protobuf for binary serialization
  try {
    await initProtobuf();
    log('Protocol buffer initialized successfully');
  } catch (error) {
    log(`Error initializing protocol buffer: ${error.message}`);
  }

  // Initialize scene
  const { scene, camera, renderer } = init();

  // Setup animation loop
  renderer.setAnimationLoop(() => {
    // Update camera view positions in the scene
    updateCameraViewsPositions(camera, renderer);

    // Render the scene
    renderer.render(scene, camera);
  });

  // Fetch available robots first
  await fetchRobotModels();

  // Get the initially selected robot ID
  const robotSelector = document.getElementById('robotSelector');
  let initialRobotId = null;

  if (robotSelector && robotSelector.value) {
    initialRobotId = robotSelector.value;
    log(`Initial robot selected: ${initialRobotId}`);
  } else {
    log('No robot selected initially - check if robot selector exists and has options');
    if (robotSelector) {
      log(`Robot selector exists but has value: '${robotSelector.value}'`);
      // If the selector exists but has no value, and we have robots, select the first one
      if (availableRobots && availableRobots.length > 0) {
        initialRobotId = availableRobots[0].id;
        robotSelector.value = initialRobotId;
        log(`Selecting first available robot: ${initialRobotId}`);
      }
    }
  }

  // Load the initial robot model if we have a valid ID
  if (initialRobotId) {
    log(`Loading initial robot model: ${initialRobotId}`);
    try {
      await loadRobotModel(initialRobotId, scene);
      updateRobotInfo(initialRobotId);
    } catch (error) {
      log(`Error loading initial robot model: ${error.message}`);
    }
  } else {
    log('No valid robot ID available to load');

    // Add a button to manually create camera views if needed
    const cameraViewButton = document.createElement('button');
    cameraViewButton.id = 'createCameraViewsButton';
    cameraViewButton.textContent = 'Show Camera Views';
    cameraViewButton.style.position = 'absolute';
    cameraViewButton.style.top = '120px';
    cameraViewButton.style.left = '20px';
    cameraViewButton.style.padding = '10px 20px';
    cameraViewButton.style.backgroundColor = '#4CAF50';
    cameraViewButton.style.color = 'white';
    cameraViewButton.style.border = 'none';
    cameraViewButton.style.borderRadius = '5px';
    cameraViewButton.style.cursor = 'pointer';
    cameraViewButton.style.zIndex = '100';

    cameraViewButton.addEventListener('click', () => {
      createStandaloneCameraViews(scene);
    });

    document.body.appendChild(cameraViewButton);
    log('Added button to manually create camera views');
  }

  // Setup robot selector change event
  robotSelector.addEventListener('change', async (event) => {
    const selectedRobotId = event.target.value;
    log(`Robot selection changed to: ${selectedRobotId}`);

    if (!selectedRobotId) {
      log('Invalid robot ID selected');
      return;
    }

    // Load the selected robot model
    try {
      await loadRobotModel(selectedRobotId, scene);
      updateRobotInfo(selectedRobotId);
    } catch (error) {
      log(`Error loading selected robot: ${error.message}`);
    }
  });

  // Setup AR button
  document.getElementById('startButton').addEventListener('click', async () => {
    log('Starting AR session with camera views');

    // Initialize WebSocket connection
    try {
      log('Connecting to WebSocket before starting AR...');
      await connectWebSocket();
      log('WebSocket connected successfully');
    } catch (error) {
      log(`WebSocket connection error: ${error.message}`);
      // Continue anyway - we'll show an AR experience even without WebSocket
    }

    // Get the selected robot ID
    const selectedRobotId = document.getElementById('robotSelector').value;

    if (!selectedRobotId) {
      log('⚠️ No robot selected to enter XR with');

      // If no robot but we have camera images, create standalone camera views
      const hasImages = Object.keys(getAllCameraImages()).length > 0;
      if (hasImages) {
        log('Creating standalone camera views for XR since no robot is selected');
        createStandaloneCameraViews(scene);
      }
    } else {
      log(`Entering XR with robot: ${selectedRobotId}`);
      // When a robot is selected, we don't need to create standalone camera views
      // The robot.js loadRobotModel function already creates camera views
    }

    // Start AR mode
    startAR(renderer, scene);
  });

  // Setup debug button
  document.getElementById('debugButton').addEventListener('click', () => {
    toggleDebugMode(scene);
  });

  // Add AR help button for Oculus users
  if (window.isOculusBrowser && window.isOculusBrowser()) {
    // Create an AR help button
    const arHelpButton = document.createElement('button');
    arHelpButton.id = 'arHelpButton';
    arHelpButton.textContent = 'AR Help';
    arHelpButton.style.position = 'absolute';
    arHelpButton.style.top = '50px';
    arHelpButton.style.left = '20px';
    arHelpButton.style.padding = '10px 20px';
    arHelpButton.style.backgroundColor = '#FF9800';
    arHelpButton.style.color = 'white';
    arHelpButton.style.border = 'none';
    arHelpButton.style.borderRadius = '5px';
    arHelpButton.style.cursor = 'pointer';
    arHelpButton.style.zIndex = '100';

    arHelpButton.addEventListener('click', () => {
      const helpPopup = document.getElementById('arPassthroughHelp');
      if (helpPopup) {
        helpPopup.style.display = 'block';
      }
    });

    document.body.appendChild(arHelpButton);
    log('AR help button added for Oculus users');
  }

  // Setup end session button for XR overlay
  document.getElementById('endSessionButton').addEventListener('click', () => {
    const session = getRenderer().xr.getSession();
    if (session) {
      log('Ending XR session via overlay button');
      session.end().catch(error => {
        log(`Error ending XR session: ${error.message}`);
      });
    }
  });

  // Listen for XR session changes
  getRenderer().xr.addEventListener('sessionstart', (event) => {
    log('XR session started event triggered');
    document.getElementById('endSessionButton').style.display = 'block';

    // Show AR Mode indicator if we're in AR mode
    const session = getRenderer().xr.getSession();
    if (session && session.mode === 'immersive-ar') {
      document.getElementById('arModeIndicator').style.display = 'block';
      log('AR mode activated - passthrough should be visible');
    }
  });

  getRenderer().xr.addEventListener('sessionend', (event) => {
    log('XR session ended event triggered');
    document.getElementById('endSessionButton').style.display = 'none';
    document.getElementById('arModeIndicator').style.display = 'none';
  });

  // Check XR support
  checkXR();

});

// Update the robot information in the UI
function updateRobotInfo(robotId) {
  if (!robotId) {
    log('Cannot update robot info: robotId is null or empty');
    return;
  }

  log(`Fetching robot info for ID: ${robotId}`);

  // Find the robot in the available robots
  fetch(`/api/robots/${robotId}`)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Error fetching robot info: ${response.status}`);
      }
      return response.json();
    })
    .then(robot => {
      log(`Successfully fetched robot info for: ${robot.name}`);

      // Update robot description
      const descriptionElement = document.getElementById('robotDescription');
      if (descriptionElement) {
        descriptionElement.innerHTML = robot.description || '';
      }

      // Update controller bindings info
      const bindingsElement = document.getElementById('controllerBindingsInfo');
      if (bindingsElement) {
        let bindingsHtml = '<strong>Controller Bindings:</strong><br>';

        if (robot.joint_groups && robot.joint_groups.length > 0) {
          robot.joint_groups.forEach(jointGroup => {
            if (jointGroup.controller_binding) {
              bindingsHtml += `• ${jointGroup.name}: ${jointGroup.controller_binding.replace('_', ' ')}<br>`;
            }
          });
        } else {
          bindingsHtml += 'No controller bindings configured';
        }

        bindingsElement.innerHTML = bindingsHtml;
      }
    })
    .catch(error => {
      log(`Error fetching robot info: ${error.message}`);
    });
}