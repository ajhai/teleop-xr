/**
 * Robot module for model and joint handling
 */

import { log } from './logger.js';
import { initIK } from './ik.js';
import { addCoordinateFrames, removeCoordinateFrames } from './debug.js';
import { initCameraViews, removeCameraViews } from './camera-view.js';

// Variables
let availableRobots = [];
let selectedRobotId = null;
let loadedJointGroups = {}; // Map of loaded joint group models by robotId_jointGroupName
let robotLoaders = {}; // Store loaders for each joint group to access joint methods
let jointAngles = {}; // Store current joint angles by robotId_jointGroupName 
let debugMode = false; // Enable/disable debug visualization
let controllerBindings = {}; // Map of controller bindings to joint group models

// Check if URDFLoader is properly defined
function ensureURDFLoader() {
  if (typeof window.CustomURDFLoader !== 'undefined') {
    return true;
  }

  log('ERROR: CustomURDFLoader is not available!');
  return false;
}


// Apply placement transformation to the robot joint group model
function applyPlacement(model, placement) {
  if (!model || !placement) return;

  try {
    // Create a transformation matrix for the model
    const matrix = new THREE.Matrix4();

    // Create a quaternion for the rotation
    const quaternion = new THREE.Quaternion();
    if (placement.orientation && placement.orientation.length === 3) {
      // Convert roll-pitch-yaw to quaternion
      // Bug fix: Use the correct Euler angle order to match URDF conventions (ZYX intrinsic, which is XYZ extrinsic)
      const euler = new THREE.Euler(
        placement.orientation[0], // roll (x)
        placement.orientation[1], // pitch (y)
        placement.orientation[2], // yaw (z)
        'ZYX'  // Changed from 'XYZ' to 'ZYX' to match URDF convention
      );
      quaternion.setFromEuler(euler);
    }

    // Set position translation
    const position = new THREE.Vector3();
    if (placement.position && placement.position.length === 3) {
      position.set(
        placement.position[0],
        placement.position[1],
        placement.position[2]
      );
    }

    // Compose the matrix from position and quaternion
    matrix.compose(position, quaternion, new THREE.Vector3(1, 1, 1));

    // Find the base link (usually "Base") and apply the transformation directly to it
    let baseLink = null;
    if (model.children && model.children.length > 0) {
      // Try to find a link named "Base" or similar
      baseLink = model.children.find(child =>
        child.name === "Base" ||
        child.name.toLowerCase() === "base" ||
        child.name.includes("base")
      );

      if (baseLink) {
        // Apply transformation to the whole robot model (this is the key fix)
        model.position.copy(position);

        // Bug fix: Apply quaternion to the model and update matrix world
        model.quaternion.copy(quaternion);
        model.updateMatrix();
        model.updateMatrixWorld(true);
      } else {
        // If we can't find a specific base link, just apply to the whole model
        model.position.copy(position);
        model.quaternion.copy(quaternion);
        model.updateMatrix();
        model.updateMatrixWorld(true);
      }
    } else {
      // Just apply to the model as a whole
      model.position.copy(position);
      model.quaternion.copy(quaternion);
      model.updateMatrix();
      model.updateMatrixWorld(true);
    }
  } catch (error) {
    log(`Error applying placement: ${error.message}`);
  }
}

// Fetch available robot models from API
async function fetchRobotModels() {
  try {
    log('Fetching available robot models...');

    // Ensure URDF loader is ready
    if (!ensureURDFLoader()) {
      log('Cannot fetch models: URDF loader not available');
      return [];
    }

    // Before making the request, log the URL we're fetching from
    const url = '/api/robots';
    log(`Fetching robot data from: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Log the raw response text to help diagnose JSON parsing issues
    const responseText = await response.text();
    log(`Received ${responseText.length} bytes of robot data`);

    // Try to parse the JSON
    try {
      availableRobots = JSON.parse(responseText);
    } catch (parseError) {
      log(`⚠️ Error parsing robot JSON: ${parseError.message}`);
      log(`First 100 chars of response: ${responseText.substring(0, 100)}...`);
      throw parseError;
    }

    log(`Found ${availableRobots.length} robot models`);

    // Debug log each robot found
    availableRobots.forEach((robot, index) => {
      log(`Robot ${index + 1}: ID=${robot.id}, Name=${robot.name}, Joint Groups=${robot.joint_groups?.length || 0}`);
    });

    // Populate the robot selector
    const selector = document.getElementById('robotSelector');
    if (!selector) {
      log('⚠️ Robot selector element not found in DOM');
      return availableRobots;
    }

    selector.innerHTML = '';

    availableRobots.forEach(robot => {
      const option = document.createElement('option');
      option.value = robot.id;
      option.textContent = robot.name;
      selector.appendChild(option);
    });

    if (availableRobots.length > 0) {
      selectedRobotId = availableRobots[0].id;
      selector.value = selectedRobotId;
      log(`Set initial robot selection to: ${selectedRobotId}`);
    } else {
      log('⚠️ No robots available to select');
    }

    document.getElementById('robotSelectorContainer').style.display = 'block';

    // Make robots available globally for debugging
    window.availableRobots = availableRobots;

    return availableRobots;
  } catch (error) {
    log(`❌ Error fetching robot models: ${error.message}`);
    return [];
  }
}

// Toggle debug visualization mode
function toggleDebugMode(scene) {
  debugMode = !debugMode;

  if (debugMode) {
    log('Debug visualization enabled');
    // Add coordinate frames for all loaded joint groups
    for (const loaderKey in robotLoaders) {
      if (scene && robotLoaders[loaderKey]) {
        addCoordinateFrames(robotLoaders[loaderKey], scene, 0.1);
      }
    }
  } else {
    log('Debug visualization disabled');
    if (scene) {
      removeCoordinateFrames(scene);
    }
  }

  return debugMode;
}

// Load a robot model by ID
async function loadRobotModel(robotId, scene) {
  if (!robotId) return;

  try {
    log(`Loading robot model: ${robotId}`);

    // Find the robot details
    const robot = availableRobots.find(r => r.id === robotId);
    if (!robot) {
      throw new Error(`Robot model ${robotId} not found`);
    }

    // If we already have loaded joint groups, remove them
    for (const loaderKey in loadedJointGroups) {
      if (scene && loadedJointGroups[loaderKey]) {
        scene.remove(loadedJointGroups[loaderKey]);
        delete loadedJointGroups[loaderKey];
        delete robotLoaders[loaderKey];
      }
    }

    // Remove any existing camera views
    if (scene) {
      removeCameraViews(scene, robotId);
    }

    // Clear coordinate frames if debug mode is on
    if (scene) {
      removeCoordinateFrames(scene);
    }

    log(`Found robot: ${robot.name}, loading joint groups...`);

    // Show robot description in the UI
    document.getElementById('robotDescription').textContent = robot.description || `${robot.name} - A robot model with ${robot.joint_groups.length} joint groups`;

    // Clear controller bindings
    controllerBindings = {};

    // Load each joint group
    for (const jointGroup of robot.joint_groups) {
      await loadRobotJointGroup(robotId, jointGroup, scene);

      // Check if this joint group has a controller binding
      if (jointGroup.controller_binding) {
        // Store controller binding for this joint group
        controllerBindings[jointGroup.controller_binding] = {
          robotId: robotId,
          jointGroupName: jointGroup.name
        };
        log(`Configured controller binding: ${jointGroup.controller_binding} -> ${jointGroup.name}`);
      }
    }

    // Update controller bindings UI
    updateControllerBindingsUI();

    // Update the joint angle sliders in the UI
    updateJointAngleControls();

    // Update selected robot ID
    selectedRobotId = robotId;

    // Add debug visualization if enabled
    if (debugMode) {
      for (const loaderKey in robotLoaders) {
        if (scene && robotLoaders[loaderKey]) {
          addCoordinateFrames(robotLoaders[loaderKey], scene, 0.1);
        }
      }
    }

    // Get the main joint group model to use as reference for camera views
    let mainJointGroupName = robot.joint_groups[0]?.name;
    let mainJointGroupModel = getJointGroupModel(robotId, mainJointGroupName);

    // Initialize camera views for this robot
    if (scene && mainJointGroupModel) {
      initCameraViews(scene, robotId, mainJointGroupModel, {
        // Custom camera view settings can be provided here
        offset: [0.3, 0.2, 0], // Place cameras to the right of the robot
        rotation: [0, Math.PI * 3 / 4, 0] // Make camera views face the user
      });
      log(`Camera views initialized for robot ${robotId}`);
    } else {
      log(`Could not initialize camera views: main joint group model not found`);
    }

    return true;
  } catch (error) {
    log(`Error in loadRobotModel: ${error.message}`);
    console.error('Full error:', error);
    return false;
  }
}

// Load a single robot joint group from URDF
async function loadRobotJointGroup(robotId, jointGroup, scene) {
  if (!robotId || !jointGroup || !jointGroup.urdf_path) {
    log('Missing required parameters for loadRobotJointGroup');
    return null;
  }

  try {
    log(`Loading joint group: ${jointGroup.name} from ${jointGroup.urdf_path}`);
    console.log("Loading joint group with params:", { robotId, jointGroup });

    // Create a unique key for this joint group
    const jointGroupKey = `${robotId}_${jointGroup.name}`;

    // CRITICAL: This is exactly how the ghost key should be structured
    const ghostJointGroupKey = `ghost_${jointGroupKey}`;

    console.log(`Creating standard model with key: ${jointGroupKey}`);
    console.log(`Will create ghost model with key: ${ghostJointGroupKey}`);

    // Check if this joint group is already loaded
    if (jointGroupKey in loadedJointGroups) {
      log(`Joint group ${jointGroup.name} already loaded, removing first`);
      scene.remove(loadedJointGroups[jointGroupKey]);
      delete loadedJointGroups[jointGroupKey];
      delete robotLoaders[jointGroupKey];
    }

    // Also remove ghost version if it exists
    if (ghostJointGroupKey in loadedJointGroups) {
      log(`Ghost joint group for ${jointGroup.name} already loaded, removing first`);
      scene.remove(loadedJointGroups[ghostJointGroupKey]);
      delete loadedJointGroups[ghostJointGroupKey];
      delete robotLoaders[ghostJointGroupKey];
    }

    // Ensure URDF loader is ready
    if (!ensureURDFLoader()) {
      throw new Error('URDF loader not available');
    }

    // Create a new loader for this joint group
    const loader = new window.CustomURDFLoader();

    // Note: CustomURDFLoader doesn't have a meshLoader property with setMeshesPath
    // Instead, mesh paths in the URDF are used directly
    // We'll construct proper paths in the app.js file

    // Ensure the URDF path is properly formatted
    let urdfPath = jointGroup.urdf_path;

    // If it's a relative path and doesn't start with /, add /urdf/ prefix
    if (!urdfPath.startsWith('/') && !urdfPath.startsWith('http')) {
      urdfPath = `/urdf/${urdfPath}`;
    }
    // If it starts with / but not /urdf/, add urdf
    else if (urdfPath.startsWith('/') && !urdfPath.startsWith('/urdf/') && !urdfPath.startsWith('http')) {
      urdfPath = `/urdf${urdfPath}`;
    }

    log(`Loading URDF from: ${urdfPath}`);

    // Load the URDF file
    const jointGroupModel = await loader.load(urdfPath);

    if (!jointGroupModel) {
      throw new Error(`Failed to load URDF for ${jointGroup.name}`);
    }

    // Apply placement transformation if available
    if (jointGroup.placement) {
      applyPlacement(jointGroupModel, jointGroup.placement);
    }

    // Apply initial joint angles if available
    let initialAngles = {};

    // Check for initial joint angles in the joint definitions first (new format)
    if (jointGroup.joints && Array.isArray(jointGroup.joints) &&
      jointGroup.joints.length > 0 && typeof jointGroup.joints[0] === 'object') {
      initialAngles = jointGroup.joints.reduce((angles, joint) => {
        if ('name' in joint && 'initial_angle' in joint) {
          angles[joint.name] = joint.initial_angle * Math.PI / 180; // Convert to radians
        }
        return angles;
      }, {});
    }
    // Fall back to initial_joint_angles property if available
    else if (jointGroup.initial_joint_angles) {
      initialAngles = Object.entries(jointGroup.initial_joint_angles).reduce((angles, [name, value]) => {
        angles[name] = typeof value === 'number' ? value * Math.PI / 180 : 0; // Convert to radians
        return angles;
      }, {});
    }

    // Apply initial angles to the model
    if (Object.keys(initialAngles).length > 0) {
      log(`Applying initial joint angles to ${jointGroup.name}: ${JSON.stringify(initialAngles)}`);
      loader.setJointAngles(initialAngles);
    }

    // Store joint angles
    jointAngles[jointGroupKey] = initialAngles;

    // Store the loaded model and loader for future reference
    loadedJointGroups[jointGroupKey] = jointGroupModel;
    robotLoaders[jointGroupKey] = loader;

    // Add the model to the scene
    scene.add(jointGroupModel);

    // Create and track the ghost copy more explicitly
    log(`Creating ghost copy for ${jointGroupKey} with key ${ghostJointGroupKey}...`);

    // Create a ghost copy of the model with offset
    const ghostLoader = new window.CustomURDFLoader();

    // Don't need to set mesh path as noted above

    let ghostModel = null;

    try {
      // Load the ghost model and wait for it to complete
      ghostModel = await ghostLoader.load(urdfPath);
      console.log(`Ghost model created:`, ghostModel);

      // Make sure the ghost model's links are initialized
      if (!ghostLoader.links || Object.keys(ghostLoader.links).length === 0) {
        console.log("Waiting for ghost model links to initialize...");
        // Give the loader a moment to initialize links
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Verify links are available
      if (!ghostLoader.links || Object.keys(ghostLoader.links).length === 0) {
        throw new Error("Ghost model links not initialized properly");
      }

      console.log("Ghost model links initialized:", Object.keys(ghostLoader.links));

      // Make the ghost model semi-transparent with a blue tint
      ghostModel.traverse(node => {
        if (node.isMesh) {
          node.material = node.material.clone();
          node.material.transparent = true;
          node.material.opacity = 0.4;
          node.material.color.setRGB(0.6, 0.8, 1.0);
        }
      });

      // Apply same placement but with slight offset
      if (jointGroup.placement) {
        const ghostPlacement = JSON.parse(JSON.stringify(jointGroup.placement));
        // Remove the offset so ghost appears at the same position
        applyPlacement(ghostModel, ghostPlacement);
      } else {
        // No placement specified, use same position as original model
        ghostModel.position.copy(jointGroupModel.position);
        ghostModel.quaternion.copy(jointGroupModel.quaternion);
        ghostModel.updateMatrix();
        ghostModel.updateMatrixWorld(true);
      }

      // Apply initial angles to ghost model
      if (Object.keys(initialAngles).length > 0) {
        for (const [jointName, angle] of Object.entries(initialAngles)) {
          const success = ghostLoader.setJointAngle(jointName, angle);
          log(`Set ghost joint ${jointName} to ${angle}: ${success ? "SUCCESS" : "FAILED"}`);
        }
      }

      // Store ghost model and loader
      loadedJointGroups[ghostJointGroupKey] = ghostModel;
      robotLoaders[ghostJointGroupKey] = ghostLoader;
      jointAngles[ghostJointGroupKey] = { ...initialAngles };

      // Add the ghost model to the scene
      scene.add(ghostModel);

      // Initialize IK for ghost model
      if (jointGroup.end_effector) {
        log(`Initializing IK for ghost ${ghostJointGroupKey} with end effector ${jointGroup.end_effector}`);
        try {
          // Ensure the ghost model is fully set up
          scene.updateMatrixWorld(true);

          // Verify the end effector exists in the ghost model
          const endEffectorName = jointGroup.end_effector;
          if (!ghostLoader.links[endEffectorName]) {
            // Try case-insensitive match
            const matchingLink = Object.keys(ghostLoader.links).find(
              link => link.toLowerCase() === endEffectorName.toLowerCase()
            );
            if (matchingLink) {
              log(`Found case-insensitive match for end effector in ghost model: ${matchingLink}`);
              jointGroup.end_effector = matchingLink;
            } else {
              throw new Error(`End effector ${endEffectorName} not found in ghost model links: ${Object.keys(ghostLoader.links).join(', ')}`);
            }
          }

          const ghostIkController = initIK(
            ghostJointGroupKey,
            jointGroup.name,
            jointGroup.end_effector,
            ghostLoader,
            ghostModel,
            scene
          );

          if (ghostIkController) {
            log(`Successfully created ghost IK controller for ${ghostJointGroupKey}`);
            console.log("Ghost IK controller:", ghostIkController);
          } else {
            throw new Error("Failed to create ghost IK controller");
          }
        } catch (ikError) {
          console.error(`Failed to initialize ghost IK controller: ${ikError.message}`);
          throw ikError; // Re-throw to handle it in the outer catch
        }
      }

      // Apply button mappings from configuration to the ghost model joints
      applyButtonMappingsToGhostJoints(ghostLoader, jointGroup);

      log(`Successfully created and initialized ghost model for ${jointGroup.name}`);
    } catch (error) {
      console.error("Error creating ghost model:", error);
      throw error;
    }

    return jointGroupModel;
  } catch (error) {
    log(`Error loading joint group ${jointGroup.name}: ${error.message}`);
    console.error('Full error:', error);
    return null;
  }
}

// Helper function to apply button mappings from configuration to ghost joints
function applyButtonMappingsToGhostJoints(ghostLoader, jointGroup) {
  if (!ghostLoader || !ghostLoader.joints || !jointGroup.joints || !Array.isArray(jointGroup.joints)) {
    console.warn('Cannot apply button mappings - missing required objects:', {
      hasGhostLoader: !!ghostLoader,
      hasJoints: ghostLoader ? !!ghostLoader.joints : false,
      hasJointGroup: !!jointGroup,
      hasJointGroupJoints: jointGroup ? !!jointGroup.joints : false,
      isJointsArray: jointGroup && jointGroup.joints ? Array.isArray(jointGroup.joints) : false
    });
    return;
  }

  console.log('Applying button mappings to ghost joints...', {
    ghostLoaderJoints: Object.keys(ghostLoader.joints),
    configJoints: jointGroup
  });

  // Deep log the first joint to debug structure
  if (jointGroup.joints.length > 0) {
    console.log("First joint structure:", JSON.stringify(jointGroup.joints[0]));
  }

  // Process each joint in the configuration
  for (const jointName of Object.keys(jointGroup.button_mapping)) {
    const buttonMapping = jointGroup.button_mapping[jointName];

    // Find the matching joint in the ghost loader
    // First try exact match
    let joint = ghostLoader.joints[jointName];

    // If no exact match, try case-insensitive match
    if (!joint) {
      console.log(`No exact match for joint ${jointName}, trying case-insensitive match`);
      const lowerJointName = jointName.toLowerCase();
      const availableJoints = Object.keys(ghostLoader.joints);

      for (const name of availableJoints) {
        if (name.toLowerCase() === lowerJointName) {
          joint = ghostLoader.joints[name];
          console.log(`Found case-insensitive match: ${name}`);
          break;
        }
      }
    }

    if (joint) {
      // Copy the button_mapping from config to the ghost joint
      joint.button_mapping = buttonMapping;
      console.log(`SUCCESS: Applied button mapping to joint ${jointName}:`, buttonMapping);
      log(`Applied button mapping to joint ${jointName}: ${JSON.stringify(buttonMapping)}`);
    } else {
      console.warn(`Warning: No matching ghost joint found for ${jointName} when applying button mapping. Available joints:`, Object.keys(ghostLoader.joints));
      log(`Warning: No matching ghost joint found for ${jointName} when applying button mapping`);
    }
  }
}

// Update controller bindings UI
function updateControllerBindingsUI() {
  if (!document.getElementById('controllerBindingsInfo')) return;

  const bindingsInfo = document.getElementById('controllerBindingsInfo');
  bindingsInfo.innerHTML = '<p><strong>Controller Bindings:</strong></p>';

  // Check if we have any bindings
  if (Object.keys(controllerBindings).length === 0) {
    bindingsInfo.innerHTML += '<p>No controller bindings configured</p>';
    return;
  }

  // Display each binding
  for (const [controllerId, binding] of Object.entries(controllerBindings)) {
    const bindingDiv = document.createElement('div');
    bindingDiv.className = 'controller-binding';

    const keySpan = document.createElement('span');
    keySpan.className = 'key';
    keySpan.textContent = controllerId === 'left_controller' ? 'Left' : 'Right';

    const actionSpan = document.createElement('span');
    actionSpan.className = 'action';
    actionSpan.textContent = ` → ${binding.jointGroupName}`;

    bindingDiv.appendChild(keySpan);
    bindingDiv.appendChild(actionSpan);
    bindingsInfo.appendChild(bindingDiv);
  }
}

// Update joint angle controls in the UI
function updateJointAngleControls() {
  const controlsContainer = document.getElementById('jointControls');
  if (!controlsContainer) return;

  // Clear existing controls
  controlsContainer.innerHTML = '';

  // Check if we have a selected robot
  if (!selectedRobotId) {
    controlsContainer.innerHTML = '<p>No robot selected</p>';
    return;
  }

  // Find the robot
  const robot = availableRobots.find(r => r.id === selectedRobotId);
  if (!robot) {
    controlsContainer.innerHTML = '<p>Selected robot not found</p>';
    return;
  }

  // Create controls for each joint group
  for (const jointGroup of robot.joint_groups) {
    // Create a fieldset for this joint group
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'joint-control';

    // Add a legend with the joint group name
    const legend = document.createElement('legend');
    legend.textContent = jointGroup.name;
    fieldset.appendChild(legend);

    const jointGroupKey = `${selectedRobotId}_${jointGroup.name}`;

    // Check if this joint group is loaded
    if (jointGroupKey in loadedJointGroups) {
      // Get current joint angles
      let currentAngles = jointAngles[jointGroupKey] || {};

      // Create slider for each joint
      if (jointGroup.joints && jointGroup.joints.length > 0) {
        jointGroup.joints.forEach(jointName => {
          // Create control group for this joint
          const controlGroup = document.createElement('div');
          controlGroup.className = 'control-group';

          // Create label with current value
          const label = document.createElement('label');
          label.textContent = `${jointName}: ${((currentAngles[jointName] || 0) * 180 / Math.PI).toFixed(1)}°`;
          label.setAttribute('for', `joint_${selectedRobotId}_${jointGroup.name}_${jointName}`);

          // Create slider
          const slider = document.createElement('input');
          slider.type = 'range';
          slider.min = -180;
          slider.max = 180;
          slider.value = (currentAngles[jointName] || 0) * 180 / Math.PI;
          slider.id = `joint_${selectedRobotId}_${jointGroup.name}_${jointName}`;
          slider.setAttribute('data-robot-id', selectedRobotId);
          slider.setAttribute('data-joint-group', jointGroup.name);
          slider.setAttribute('data-joint', jointName);

          // Add event listener
          slider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            const robotId = e.target.getAttribute('data-robot-id');
            const jointGroupName = e.target.getAttribute('data-joint-group');
            const joint = e.target.getAttribute('data-joint');

            // Update label
            e.target.previousElementSibling.textContent = `${joint}: ${value.toFixed(1)}°`;

            // Convert to radians and update only the ghost joint for preview
            const radians = value * Math.PI / 180;
            updateGhostJointAngle(robotId, jointGroupName, joint, radians);
          });

          // Add to control group
          controlGroup.appendChild(label);
          controlGroup.appendChild(slider);
          fieldset.appendChild(controlGroup);
        });
      } else {
        // No joints defined
        const message = document.createElement('p');
        message.textContent = 'No joints defined for this joint group';
        fieldset.appendChild(message);
      }
    } else {
      // Joint group not loaded
      const message = document.createElement('p');
      message.textContent = 'Joint group not loaded';
      fieldset.appendChild(message);
    }

    // Add the fieldset to the container
    controlsContainer.appendChild(fieldset);
  }

  // Show the controls container
  document.getElementById('jointControlsContainer').style.display = 'block';
}

// Update the IK target based on controller movement - only updates ghost model
function updateIKTarget(controller) {
  try {
    if (!controller || !controller.userData) {
      console.error("updateIKTarget: Invalid controller");
      return false;
    }

    const ghostController = controller.userData.ghostController;
    if (!ghostController) {
      console.error("updateIKTarget: No ghost controller found");
      return false;
    }

    // Get the current controller position 
    const currentPosition = new THREE.Vector3();
    controller.getWorldPosition(currentPosition);

    // Check if the controller has moved significantly
    if (!hasControllerMovedSignificantly(controller, currentPosition)) {
      return true; // Skip update if no significant movement
    }

    // Update previous position for next frame
    if (!controller.userData.previousPosition) {
      controller.userData.previousPosition = new THREE.Vector3();
    }
    controller.userData.previousPosition.copy(currentPosition);

    // Use the IK controller to update ghost model
    try {
      ghostController.setTarget(currentPosition);
      return true;
    } catch (error) {
      console.error("Error updating ghost IK target:", error);
      return false;
    }
  } catch (error) {
    console.error("Error in updateIKTarget:", error);
    return false;
  }
}

// Helper function to check if controller has moved significantly to avoid jitter
function hasControllerMovedSignificantly(controller, currentPosition) {
  // If this is the first frame or no previous position stored, always update
  if (!controller.userData.previousPosition) {
    return true;
  }

  // Calculate distance moved since last frame
  const distance = currentPosition.distanceTo(controller.userData.previousPosition);

  // Threshold for considering movement significant (reduced from 0.002 to 0.0005)
  // Much less filtering to allow finer controller movements through
  const movementThreshold = 0.0005;

  // If the controller hasn't moved much, we can skip the update
  if (distance < movementThreshold) {
    return false;
  }

  // Also check if enough time has passed since the last significant movement
  // This prevents rapid consecutive updates
  if (!controller.userData.lastSignificantMoveTime) {
    controller.userData.lastSignificantMoveTime = performance.now();
  } else {
    const timeSinceLastMove = performance.now() - controller.userData.lastSignificantMoveTime;
    // Reduced from 16ms to 8ms for more responsive updates (120fps vs 60fps)
    const minMoveInterval = 8;

    if (timeSinceLastMove < minMoveInterval) {
      // Too soon after last movement
      return false;
    }

    // Update the time of this significant movement
    controller.userData.lastSignificantMoveTime = performance.now();
  }

  return true;
}

// Updates only the ghost joint angle without affecting the real model
function updateGhostJointAngle(robotId, jointGroupName, jointName, angleRadians, matchedKey = null) {
  // Debug logging (reduced frequency)
  if (Math.random() < 0.05) {
    console.log(`DEBUG: updateGhostJointAngle(${robotId}, ${jointGroupName}, ${jointName}, ${angleRadians.toFixed(5)})`);
  }

  // If we have a matchedKey from a successful IK controller lookup, use that directly
  if (matchedKey) {
    // Extract just the robotId_jointGroupName part from the matched key (remove 'ghost_' prefix if present)
    const baseKey = matchedKey.replace(/^ghost_/, '');

    // Try to get the loader using this exact matched key
    const ghostLoader = robotLoaders[matchedKey];

    if (ghostLoader) {
      return updateGhostLoaderJoint(ghostLoader, jointName, angleRadians, matchedKey);
    }
  }

  // Fall back to constructing keys and trying them
  const jointGroupKey = `${robotId}_${jointGroupName}`;
  const ghostJointGroupKey = `ghost_${jointGroupKey}`;

  let ghostLoader = robotLoaders[ghostJointGroupKey];

  if (!ghostLoader) {
    // Try alternative key formats
    const alternativeKeys = [
      `ghost_${robotId}_${jointGroupName.replace(/\s/g, '')}`,
      `ghost_${robotId.toLowerCase()}_${jointGroupName.toLowerCase()}`,
      `ghost_${robotId.toLowerCase()}_${jointGroupName.replace(/\s/g, '')}`
    ];

    for (const key of alternativeKeys) {
      if (robotLoaders[key]) {
        ghostLoader = robotLoaders[key];
        break;
      }
    }

    if (!ghostLoader) {
      console.error(`Ghost loader not found for ${ghostJointGroupKey} or alternative keys`);
      return false;
    }
  }

  return updateGhostLoaderJoint(ghostLoader, jointName, angleRadians, ghostJointGroupKey);
}

// Updates a joint in the ghost loader model
function updateGhostLoaderJoint(ghostLoader, jointName, angleRadians, loaderKey) {
  if (!ghostLoader) {
    console.error("Ghost loader is null in updateGhostLoaderJoint");
    return false;
  }

  if (!ghostLoader.joints) {
    console.error(`Ghost loader ${loaderKey} has no joints property`);
    return false;
  }

  // First check for exact match
  let joint = ghostLoader.joints[jointName];

  // If no exact match, try case-insensitive match
  if (!joint) {
    const lowerJointName = jointName.toLowerCase();
    const availableJoints = Object.keys(ghostLoader.joints);

    for (const name of availableJoints) {
      if (name.toLowerCase() === lowerJointName) {
        joint = ghostLoader.joints[name];
        jointName = name; // Use the actual case-sensitive name
        break;
      }
    }
  }

  if (!joint) {
    console.warn(`Joint ${jointName} not found in ghost loader ${loaderKey}`);
    return false;
  }

  // Track previous angles for smoothing
  if (!ghostLoader.previousAngles) {
    ghostLoader.previousAngles = {};
  }

  // Initialize previous angle if this is the first update
  if (ghostLoader.previousAngles[jointName] === undefined) {
    ghostLoader.previousAngles[jointName] = angleRadians;
  }

  // Apply smoothing to reduce jitter
  const smoothingFactor = 0.5; // Reduced from 0.7 to make movements more responsive
  const smoothedAngle = ghostLoader.previousAngles[jointName] * smoothingFactor +
    angleRadians * (1 - smoothingFactor);

  // Check for NaN (can happen with IK errors)
  if (isNaN(smoothedAngle)) {
    console.error(`NaN angle detected for joint ${jointName}, using previous value`);
    return false;
  }

  // Check joint limits if provided
  let limitedAngle = smoothedAngle;
  if (joint.minAngle !== undefined && joint.maxAngle !== undefined) {
    limitedAngle = Math.max(joint.minAngle, Math.min(joint.maxAngle, smoothedAngle));

    if (limitedAngle !== smoothedAngle && Math.random() < 0.1) {
      console.warn(`Joint ${jointName} angle ${smoothedAngle.toFixed(5)} limited to ${limitedAngle.toFixed(5)}`);
    }
  }

  // Apply the angle to the ghost model joint
  try {
    ghostLoader.setJointAngle(jointName, limitedAngle);

    // Store current angle as previous for next frame
    ghostLoader.previousAngles[jointName] = limitedAngle;

    return true;
  } catch (error) {
    console.error(`Error setting ghost joint angle: ${error.message}`);
    return false;
  }
}

// Update a single joint angle - now only updates the real model (not the ghost)
function updateJointAngle(robotId, jointGroupName, jointName, angleRadians) {
  const loader = getJointGroupLoader(robotId, jointGroupName);
  if (!loader) {
    log(`Cannot update joint angle: Loader not found for ${robotId} - ${jointGroupName}`);
    return false;
  }

  // Update the angle using the loader (no longer need correction flags)
  const success = loader.setJointAngle(jointName, angleRadians);

  if (success) {
    // Store the updated angle
    const jointGroupKey = `${robotId}_${jointGroupName}`;
    if (!jointAngles[jointGroupKey]) {
      jointAngles[jointGroupKey] = {};
    }
    jointAngles[jointGroupKey][jointName] = angleRadians;

    return true;
  }

  return false;
}

// Get a specific robot joint group model
function getJointGroupModel(robotId, jointGroupName) {
  const key = `${robotId}_${jointGroupName}`;
  return loadedJointGroups[key];
}

// Get the loader for a specific robot joint group
function getJointGroupLoader(robotId, jointGroupName, getGhost = false) {
  let key = `${robotId}_${jointGroupName}`;
  if (getGhost) {
    key = `ghost_${key}`;
  }
  return robotLoaders[key];
}

// For backward compatibility - Maps to the new joint group functions
function getArmModel(robotId, armName) {
  return getJointGroupModel(robotId, armName);
}

// For backward compatibility - Maps to the new joint group functions
function getArmLoader(robotId, armName) {
  return getJointGroupLoader(robotId, armName);
}

// Get the selected robot ID
function getSelectedRobotId() {
  return selectedRobotId;
}

// Set the selected robot ID
function setSelectedRobotId(id) {
  selectedRobotId = id;
}

// Get mapping of controllers to arms
function getControllerBindings() {
  return controllerBindings;
}

// Synchronize the real robot with the ghost robot position
function synchronizeWithGhost(robotId, jointGroupName) {
  try {
    const jointGroupKey = `${robotId}_${jointGroupName}`;
    const ghostJointGroupKey = `ghost_${jointGroupKey}`;

    // Get the ghost loader
    const ghostLoader = robotLoaders[ghostJointGroupKey];
    if (!ghostLoader || !ghostLoader.joints) {
      log(`Cannot synchronize: No ghost loader found for ${ghostJointGroupKey}`);
      return false;
    }

    // Get the real robot loader
    const realLoader = robotLoaders[jointGroupKey];
    if (!realLoader || !realLoader.joints) {
      log(`Cannot synchronize: No real robot loader found for ${jointGroupKey}`);
      return false;
    }

    // Copy joint angles from ghost to real robot
    let success = true;
    const jointAngles = {};

    // Get all joint angles from ghost model
    for (const jointName in ghostLoader.joints) {
      const joint = ghostLoader.joints[jointName];
      if (joint && typeof joint.currentAngle === 'number') {
        jointAngles[jointName] = joint.currentAngle;
      }
    }

    if (Object.keys(jointAngles).length === 0) {
      log('No valid joint angles found in ghost model');
      return false;
    }

    log(`Copying ${Object.keys(jointAngles).length} joint angles from ghost to real robot...`);

    // Apply angles to real robot and send to server
    for (const [jointName, angle] of Object.entries(jointAngles)) {
      // Update the real robot model
      const result = updateJointAngle(robotId, jointGroupName, jointName, angle);
      if (!result) {
        log(`Failed to update joint ${jointName} on real robot`);
        success = false;
      }
    }

    if (success) {
      log(`Successfully synchronized real robot with ghost model position`);
    } else {
      log(`Some joints failed to synchronize with ghost model`);
    }

    return success;
  } catch (error) {
    log(`Error synchronizing with ghost: ${error.message}`);
    return false;
  }
}

export {
  fetchRobotModels,
  loadRobotModel,
  loadRobotJointGroup,
  updateJointAngleControls,
  updateIKTarget,
  getArmModel,
  getArmLoader,
  getSelectedRobotId,
  setSelectedRobotId,
  toggleDebugMode,
  getControllerBindings,
  getJointGroupLoader,
  updateJointAngle,
  updateGhostJointAngle,
  synchronizeWithGhost,
  updateControllerBindingsUI
}; 
