/**
 * Inverse Kinematics module for robot control
 */

import { log } from './logger.js';
import { getJointGroupLoader } from './robot.js';
import { sendJointPositionCommand } from './websocket.js';

class InverseKinematics {
  constructor(robotLoader, endEffectorName, armKey) {
    this.robotLoader = robotLoader;
    this.endEffectorName = endEffectorName;
    this.armKey = armKey;
    this.robotJoints = robotLoader ? robotLoader.joints : null;
    this.isActive = false;
    this.targetPosition = new THREE.Vector3();
    this.maxIterations = 5;
    this.tolerance = 0.001;
    this.learningRate = 1.0;
    this.damping = 0.2;
    this.debugMode = false;
    this.jointWeights = {};

    // For relative motion tracking
    this.initialControllerPosition = new THREE.Vector3();
    this.previousControllerPosition = new THREE.Vector3();
    this.initialEndEffectorPosition = new THREE.Vector3();
    this.useRelativeMotion = true;
    this.lastMovementTime = 0;
    this.minMovementInterval = 8; // ms between movements

    // For movement validation
    this.movementThreshold = 0.0001;
    this.maxMovementPerFrame = 0.05; // Maximum allowed movement per frame to prevent jumps

    // Set up joint weights - prioritize distal joints
    if (this.robotJoints) {
      const jointNames = Object.keys(this.robotJoints);
      jointNames.forEach((name, index) => {
        const position = index / (jointNames.length - 1);
        this.jointWeights[name] = 0.5 + position * 1.5;
      });
    }

    log(`Initialized IK solver for arm ${armKey} with end effector: ${endEffectorName}`);
  }

  setEndEffector(name) {
    this.endEffectorName = name;
    log(`Set end effector to: ${name} for arm ${this.armKey}`);
  }

  activate() {
    this.isActive = true;
    console.log(`DEBUG: IK controller ${this.armKey} activated`);

    // Reset tracking variables for clean start
    this.resetTracking();

    log(`IK control activated for arm ${this.armKey}`);
  }

  deactivateRelativeMode() {
    this.useRelativeMotion = false;
    log(`Switched to absolute positioning mode for arm ${this.armKey}`);
  }

  activateRelativeMode() {
    this.useRelativeMotion = true;
    log(`Switched to relative motion mode for arm ${this.armKey}`);
  }

  deactivate() {
    this.isActive = false;
    log(`IK control deactivated for arm ${this.armKey}`);
  }

  setTarget(controllerPosition) {
    if (!this.isActive) {
      return;
    }

    // Basic validation
    if (!this.endEffectorName || !this.robotLoader || !this.robotLoader.links ||
      !this.robotLoader.links[this.endEffectorName]) {
      return;
    }

    // Throttle updates
    const currentTime = performance.now();
    if (currentTime - this.lastMovementTime < this.minMovementInterval) {
      return;
    }

    // Get current end effector position
    const currentEffectorPos = this.getEndEffectorPosition();
    if (!currentEffectorPos) {
      return;
    }

    // Handle initialization
    if (this.initialControllerPosition.lengthSq() === 0) {
      this.initialControllerPosition.copy(controllerPosition);
      this.previousControllerPosition.copy(controllerPosition);
      this.initialEndEffectorPosition.copy(currentEffectorPos);
      this.targetPosition.copy(currentEffectorPos);
      return;
    }

    // Calculate controller movement
    const movement = new THREE.Vector3().subVectors(controllerPosition, this.previousControllerPosition);

    // Check if movement is significant
    if (movement.lengthSq() < this.movementThreshold * this.movementThreshold) {
      return;
    }

    // Limit maximum movement per frame
    if (movement.length() > this.maxMovementPerFrame) {
      movement.normalize().multiplyScalar(this.maxMovementPerFrame);
    }

    // Calculate new target position
    const newTarget = new THREE.Vector3().copy(currentEffectorPos).add(movement);

    // Update tracking variables
    this.previousControllerPosition.copy(controllerPosition);
    this.targetPosition.copy(newTarget);
    this.lastMovementTime = currentTime;

    // Run IK solver
    for (let i = 0; i < this.maxIterations; i++) {
      const error = this.solveIKStep();
      if (error < this.tolerance) break;
    }

    // If this is a ghost controller, send joint angles via WebSocket
    if (this.armKey.startsWith('ghost_')) {
      const angles = this.getJointAngles(true); // Get angles in degrees for WebSocket
      if (angles) {
        // Extract robot ID and joint group from armKey (format: ghost_robotId_jointGroup)
        const parts = this.armKey.split('_');
        if (parts.length >= 3) {
          const robotId = parts[1];
          const jointGroupId = parts.slice(2).join('_'); // Handle joint groups with underscores
          const joints = Object.entries(angles).map(([name, angle]) => ({
            joint_name: name,
            position: angle,
            velocity: 0,
            effort: 0
          }));

          // Send via WebSocket
          sendJointPositionCommand(robotId, jointGroupId, joints);
        }
      }
    }

    // Current end effector position after solving
    const newPos = this.getEndEffectorPosition();
    if (newPos) {
      console.log(`End effector position AFTER solving: [${newPos.x.toFixed(3)}, ${newPos.y.toFixed(3)}, ${newPos.z.toFixed(3)}]`);
    }
  }

  // Get the current position of the end effector
  getEndEffectorPosition() {
    if (!this.robotLoader || !this.endEffectorName) {
      console.error(`Cannot get end effector position: robotLoader or endEffectorName is null for ${this.armKey}`);
      console.log('Robot loader available:', !!this.robotLoader);
      console.log('End effector name:', this.endEffectorName);
      return null;
    }

    // Log available links for debugging
    console.log(`Available links for ${this.armKey}:`, this.robotLoader.links ? Object.keys(this.robotLoader.links) : "no links");

    // First try exact match
    let endEffectorLink = this.robotLoader.links[this.endEffectorName];
    if (endEffectorLink) {
      console.log(`Found exact match for end effector "${this.endEffectorName}"`);
    }

    // If still not found, give up
    if (!endEffectorLink) {
      console.error(`End effector link "${this.endEffectorName}" not found for arm ${this.armKey} after all attempts.`);
      return null;
    }

    // Create a world position vector for the end effector
    const position = new THREE.Vector3();
    try {
      endEffectorLink.getWorldPosition(position);
      console.log(`End effector "${this.endEffectorName}" position for ${this.armKey}: [${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)}]`);
      return position;
    } catch (error) {
      console.error(`Error getting world position for end effector "${this.endEffectorName}": ${error.message}`);
      return null;
    }
  }

  // Get the current quaternion orientation of the end effector
  getEndEffectorQuaternion() {
    if (!this.robotLoader || !this.endEffectorName) {
      console.error(`Cannot get end effector quaternion: robotLoader or endEffectorName is null for ${this.armKey}`);
      return new THREE.Quaternion();
    }

    const endEffectorLink = this.robotLoader.links[this.endEffectorName];
    if (!endEffectorLink) {
      console.error(`End effector link "${this.endEffectorName}" not found for arm ${this.armKey}.`);
      return new THREE.Quaternion();
    }

    // Create a quaternion for the end effector
    const quaternion = new THREE.Quaternion();
    try {
      endEffectorLink.getWorldQuaternion(quaternion);
      console.log(`End effector orientation for ${this.armKey}: [${quaternion.x.toFixed(3)}, ${quaternion.y.toFixed(3)}, ${quaternion.z.toFixed(3)}, ${quaternion.w.toFixed(3)}]`);
      return quaternion;
    } catch (error) {
      console.error(`Error getting world quaternion for end effector: ${error.message}`);
      return new THREE.Quaternion();
    }
  }

  // Get the Jacobian matrix for the current configuration - optimized version
  getJacobian() {
    if (!this.robotLoader || !this.robotJoints) {
      if (this.debugMode) log(`Robot data not available for Jacobian calculation for arm ${this.armKey}`);
      return null;
    }

    const endEffectorPos = this.getEndEffectorPosition();
    if (!endEffectorPos) return null;

    // Filter for only rotational joints to reduce computation
    const jointNames = Object.keys(this.robotJoints).filter(name => {
      const joint = this.robotJoints[name];
      return joint.type === 'revolute' || joint.type === 'continuous';
    });

    if (jointNames.length === 0) {
      console.error(`No rotational joints found for arm ${this.armKey}`);
      return null;
    }

    // Precalculate the jacobian with fewer operations
    const jacobian = [];
    const tempDelta = new THREE.Vector3();

    // Save original configuration to restore later
    const originalAngles = {};
    for (const jointName of jointNames) {
      originalAngles[jointName] = this.robotJoints[jointName].currentAngle;
    }

    // Cache rotation axes to ensure we have consistent directions across frames
    if (!this.jointRotationAxes) {
      this.jointRotationAxes = {};

      for (const jointName of jointNames) {
        const joint = this.robotJoints[jointName];

        // Default rotation axis (most joints rotate around Z)
        let axis = new THREE.Vector3(0, 0, 1);

        // Use explicit axis if available
        if (joint.axis) {
          axis = new THREE.Vector3(joint.axis.x, joint.axis.y, joint.axis.z).normalize();
        }

        this.jointRotationAxes[jointName] = axis;
      }
    }

    // Process all joints in one pass
    for (const jointName of jointNames) {
      const joint = this.robotJoints[jointName];
      const originalAngle = joint.currentAngle;

      // Get original position
      const originalPos = this.getEndEffectorPosition();
      if (!originalPos) {
        console.error(`Could not get original end effector position for Jacobian calculation`);
        continue;
      }

      // Use a consistent delta for all joints
      const delta = 0.01;

      try {
        // First try positive delta
        this.robotLoader.setJointAngle(jointName, originalAngle + delta);
        const posPosition = this.getEndEffectorPosition();

        if (!posPosition) {
          console.error(`Could not get positive delta position for joint ${jointName}`);
          this.robotLoader.setJointAngle(jointName, originalAngle);
          continue;
        }

        // Now try negative delta for more accurate gradient
        this.robotLoader.setJointAngle(jointName, originalAngle - delta);
        const negPosition = this.getEndEffectorPosition();

        if (!negPosition) {
          console.error(`Could not get negative delta position for joint ${jointName}`);
          this.robotLoader.setJointAngle(jointName, originalAngle);
          continue;
        }

        // Calculate gradient using central difference for better accuracy
        const posDelta = new THREE.Vector3().subVectors(posPosition, originalPos);
        const negDelta = new THREE.Vector3().subVectors(negPosition, originalPos);

        // If movement is more significant in one direction, use that one
        // This helps ensure we don't average out opposing motions
        if (posDelta.lengthSq() > negDelta.lengthSq() * 2) {
          // Positive direction dominates
          tempDelta.copy(posDelta).divideScalar(delta);
        } else if (negDelta.lengthSq() > posDelta.lengthSq() * 2) {
          // Negative direction dominates
          tempDelta.copy(negDelta).divideScalar(-delta); // Note the negative here
        } else {
          // Use central difference as before
          tempDelta.subVectors(posPosition, negPosition).divideScalar(2 * delta);
        }

        // Get the rotation axis for this joint (from cache)
        const rotationAxis = this.jointRotationAxes[jointName];

        // Get the link for this joint if possible
        const jointLink = this.robotLoader.links[joint.linkName];
        if (jointLink) {
          // Transform the axis to world space
          const worldQuat = new THREE.Quaternion();
          jointLink.getWorldQuaternion(worldQuat);
          const worldAxis = rotationAxis.clone().applyQuaternion(worldQuat);

          // The theoretical direction of effect should be perpendicular to the rotation axis
          // and the vector from joint to end effector
          const jointToEndEffector = new THREE.Vector3().subVectors(endEffectorPos, new THREE.Vector3());
          if (jointLink.getWorldPosition) {
            const jointPos = new THREE.Vector3();
            jointLink.getWorldPosition(jointPos);
            jointToEndEffector.subVectors(endEffectorPos, jointPos);
          }

          // The theoretical effect should be in direction of (axis × (endpoint - jointPos))
          const theoreticalEffect = new THREE.Vector3().crossVectors(worldAxis, jointToEndEffector);

          // If our measured effect is significantly opposite to what's expected, fix it
          if (theoreticalEffect.lengthSq() > 0.001) {
            theoreticalEffect.normalize();
            const dotProduct = tempDelta.dot(theoreticalEffect);

            // If dot is strongly negative, measured effect is in wrong direction
            if (dotProduct < -0.3 && tempDelta.lengthSq() > 0.00001) {
              tempDelta.multiplyScalar(-1);
              if (this.debugMode) {
                console.log(`Corrected direction for joint ${jointName} based on theoretical analysis`);
              }
            }
          }
        }

        // Skip joints with minimal effect
        const magnitude = tempDelta.length();
        if (magnitude < 0.00001) {
          if (this.debugMode) {
            console.log(`Joint ${jointName} has minimal influence on end effector (${magnitude.toFixed(6)})`);
          }
          this.robotLoader.setJointAngle(jointName, originalAngle);
          continue;
        }

        jacobian.push({
          name: jointName,
          column: tempDelta.clone(),
          weight: 1.0
        });

        // Reset joint angle
        this.robotLoader.setJointAngle(jointName, originalAngle);
      } catch (error) {
        console.error(`Error calculating Jacobian for joint ${jointName}:`, error);
        this.robotLoader.setJointAngle(jointName, originalAngle);
      }
    }

    // Ensure we reset all joints to their original positions
    for (const [jointName, angle] of Object.entries(originalAngles)) {
      this.robotLoader.setJointAngle(jointName, angle);
    }

    // If we couldn't calculate any useful columns, return null
    if (jacobian.length === 0) {
      console.error(`Could not calculate any usable Jacobian columns for arm ${this.armKey}`);
      return null;
    }

    return jacobian;
  }

  // Single step of IK solution
  solveIKStep() {
    if (!this.isActive || !this.robotLoader) return Infinity;

    const endEffectorPos = this.getEndEffectorPosition();
    if (!endEffectorPos) return Infinity;

    // Calculate error vector
    const error = new THREE.Vector3().subVectors(this.targetPosition, endEffectorPos);
    const errorMagnitude = error.length();

    if (errorMagnitude < this.tolerance) return errorMagnitude;

    // Get the Jacobian
    const jacobian = this.getJacobian();
    if (!jacobian) return errorMagnitude;

    // Cap maximum error to prevent large jumps
    if (errorMagnitude > this.maxMovementPerFrame) {
      error.normalize().multiplyScalar(this.maxMovementPerFrame);
    }

    // Apply damped least squares
    for (const item of jacobian) {
      const jointName = item.name;
      const column = item.column;
      const weight = item.weight;
      const joint = this.robotJoints[jointName];

      const jTe = column.dot(error);
      const jTj = column.lengthSq() + this.damping * this.damping;
      const adjustment = (jTe / jTj) * this.learningRate * weight;

      // Limit maximum angle change
      const maxAdjustment = 0.02;
      const clampedAdjustment = Math.max(-maxAdjustment, Math.min(maxAdjustment, adjustment));

      // Apply joint limits if they exist
      const currentAngle = joint.currentAngle;
      const newAngle = currentAngle + clampedAdjustment;

      if (joint.minAngle !== undefined && joint.maxAngle !== undefined) {
        const limitedAngle = Math.max(joint.minAngle, Math.min(joint.maxAngle, newAngle));
        this.robotLoader.setJointAngle(jointName, limitedAngle);
      } else {
        // Keep joints in reasonable range
        const normalizedAngle = ((newAngle + Math.PI) % (2 * Math.PI)) - Math.PI;
        this.robotLoader.setJointAngle(jointName, normalizedAngle);
      }
    }

    return errorMagnitude;
  }

  getJointAngles(inDegrees = false) {
    if (!this.robotLoader || !this.robotJoints) {
      console.error(`Cannot get joint angles: robotLoader or robotJoints is null for ${this.armKey}`);
      return null;
    }

    // Return current joint angles
    const angles = {};
    let count = 0;

    for (const jointName in this.robotJoints) {
      if (this.robotJoints[jointName].type === 'revolute' || this.robotJoints[jointName].type === 'continuous') {
        const angleRad = this.robotJoints[jointName].currentAngle;

        // Validate the angle is a proper number
        if (angleRad !== undefined && !isNaN(angleRad) && isFinite(angleRad)) {
          // Convert to degrees if requested
          angles[jointName] = inDegrees ? (angleRad * 180 / Math.PI) : angleRad;
          count++;
        } else {
          console.warn(`Invalid angle value for joint ${jointName}: ${angleRad}`);
        }
      }
    }

    console.log(`Retrieved ${count} joint angles from IK controller ${this.armKey}`);
    console.log("Joint angles:", Object.entries(angles).map(([name, angle]) =>
      `${name}: ${angle.toFixed(5)}${inDegrees ? '°' : ' rad'}`).join(', '));

    return angles;
  }

  // Reset tracking for clean state
  resetTracking() {
    this.initialControllerPosition.set(0, 0, 0);
    this.previousControllerPosition.set(0, 0, 0);
    this.initialEndEffectorPosition.set(0, 0, 0);
    this.targetPosition.set(0, 0, 0);
    this.lastMovementTime = 0;

    // Get current end effector position
    const currentPos = this.getEndEffectorPosition();
    if (currentPos) {
      this.initialEndEffectorPosition.copy(currentPos);
      this.targetPosition.copy(currentPos);
    }
  }
}

// Store IK controllers for each arm
let ikControllers = {};

// Expose IK controllers to window for global access
window.ikControllers = ikControllers;

// Initialize the IK controller with required parameters
function initIK(robotId, jointGroupName, endEffectorName, robotLoader, robotModel, scene) {
  const armKey = `${robotId}_${jointGroupName}`;

  log(`Initializing IK for ${armKey} with end effector ${endEffectorName}`);
  console.log("initIK params:", { robotId, jointGroupName, endEffectorName });

  // Check if robotLoader is valid
  if (!robotLoader) {
    log(`ERROR: Cannot initialize IK for ${armKey} - robotLoader is null or undefined`);
    return null;
  }

  // Check if endEffectorName is valid
  if (!endEffectorName) {
    log(`ERROR: Cannot initialize IK for ${armKey} - endEffectorName is null or undefined`);
    return null;
  }

  // Check if the end effector link exists
  if (!robotLoader.links || !robotLoader.links[endEffectorName]) {
    const availableLinks = robotLoader.links ? Object.keys(robotLoader.links).join(', ') : 'none';
    log(`ERROR: End effector link "${endEffectorName}" not found for ${armKey}. Available links: ${availableLinks}`);
    return null;
  }

  // Check for ghost model using a more robust method:
  // 1. Explicit prefix check for "ghost_" at the beginning of the robotId
  // 2. Check if the full armKey itself starts with "ghost_"
  const isGhostModel = robotId.startsWith('ghost_') || armKey.startsWith('ghost_');

  if (isGhostModel) {
    console.log(`Detected ghost model with key ${armKey}`);
    const ikController = new InverseKinematics(robotLoader, endEffectorName, armKey);
    ikControllers[armKey] = ikController;

    // Enable relative motion mode for ghost controller
    ikController.activateRelativeMode();

    log(`IK initialized for ghost model ${armKey} with end effector ${endEffectorName}`);
    return ikController;
  }

  // For non-ghost models, we only want to create a ghost IK controller
  // Skip creating an IK controller for the original model
  console.log(`Skipping IK controller creation for original model: ${robotId}_${jointGroupName}`);

  // Create IK controller for ghost model (retrieve ghost loader separately to ensure it exists)
  const ghostJointGroupKey = `ghost_${armKey}`;
  const ghostLoader = getJointGroupLoader(robotId, jointGroupName, true);
  console.log("Ghost loader for IK:", ghostLoader, "with key:", ghostJointGroupKey);

  if (ghostLoader && ghostLoader.links && ghostLoader.links[endEffectorName]) {
    // Create a new IK controller for the ghost model
    const ghostIkController = new InverseKinematics(ghostLoader, endEffectorName, ghostJointGroupKey);

    // Store reference 
    ikControllers[ghostJointGroupKey] = ghostIkController;

    // Enable relative motion mode for ghost controller
    ghostIkController.activateRelativeMode();

    log(`IK initialized for ghost model ${ghostJointGroupKey} with end effector ${endEffectorName}`);
    console.log("Created ghost IK controller:", ghostIkController);

    // Log very clearly that we've set up the ghost controller
    console.log("====== GHOST IK CONTROLLER SETUP ======");
    console.log(`Ghost IK controller KEY: ${ghostJointGroupKey}`);
    console.log(`Ghost IK controller isActive: ${ghostIkController.isActive}`);
    console.log(`Ghost IK controller useRelativeMotion: ${ghostIkController.useRelativeMotion}`);
    console.log(`Ghost IK controller available in ikControllers: ${ikControllers[ghostJointGroupKey] !== undefined}`);

    // Explicitly set the initial end effector position
    const endEffectorPos = ghostIkController.getEndEffectorPosition();
    if (endEffectorPos) {
      ghostIkController.initialEndEffectorPosition.copy(endEffectorPos);
      console.log(`Set initial end effector position for ghost: [${endEffectorPos.x.toFixed(3)}, ${endEffectorPos.y.toFixed(3)}, ${endEffectorPos.z.toFixed(3)}]`);
    }

    // Expose explicitly to window for debugging
    window.ghostIkController = ghostIkController;
    console.log("Ghost IK controller exposed to window.ghostIkController for debugging");
    console.log("=======================================");

    return ghostIkController;
  } else {
    log(`WARNING: Could not initialize IK for ghost model. Ghost loader or end effector not found.`);
    console.error("Ghost loader issues:", {
      loaderExists: !!ghostLoader,
      linksExist: ghostLoader ? !!ghostLoader.links : false,
      endEffectorExists: ghostLoader && ghostLoader.links ? !!ghostLoader.links[endEffectorName] : false
    });
  }

  // Log all available IK controllers for debugging
  console.log("All IK controllers after initialization:", Object.keys(ikControllers));

  // Return null since we're only creating ghost controllers
  return null;
}

// Get the IK controller
function getIKController(armKey) {
  if (armKey) {
    return ikControllers[armKey];
  }

  // For backward compatibility, return the first IK controller if no arm key is provided
  const keys = Object.keys(ikControllers);
  if (keys.length > 0) {
    return ikControllers[keys[0]];
  }

  return null;
}

// Access all IK controllers
function getAllIKControllers() {
  return ikControllers;
}

export { initIK, getIKController, getAllIKControllers }; 