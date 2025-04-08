/**
 * Debug utilities to help troubleshoot robot model and IK issues
 */

import { log } from './logger.js';

// Print all links and joints from a robot model
function printRobotStructure(robotLoader) {
  if (!robotLoader) {
    log('ERROR: Cannot print robot structure - robotLoader is null');
    return;
  }

  // Print links
  log('Robot Links:');
  if (robotLoader.links) {
    const linkNames = Object.keys(robotLoader.links);
    log(`Found ${linkNames.length} links: ${linkNames.join(', ')}`);

    // Print details for each link
    linkNames.forEach(linkName => {
      const link = robotLoader.links[linkName];
      log(`Link: ${linkName}, position: ${link.position ? vectorToString(link.position) : 'N/A'}`);
    });
  } else {
    log('No links found in robot model');
  }

  // Print joints
  log('Robot Joints:');
  if (robotLoader.joints) {
    const jointNames = Object.keys(robotLoader.joints);
    log(`Found ${jointNames.length} joints: ${jointNames.join(', ')}`);

    // Print details for each joint
    jointNames.forEach(jointName => {
      const joint = robotLoader.joints[jointName];
      log(`Joint: ${jointName}, type: ${joint.type}, parent: ${joint.parent}, child: ${joint.child}`);
    });
  } else {
    log('No joints found in robot model');
  }
}

// Helper to convert vector to string
function vectorToString(vector) {
  if (!vector) return 'null';
  return `[${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}]`;
}

// Print the current transform of a link
function printLinkTransform(robotLoader, linkName) {
  if (!robotLoader || !robotLoader.links) {
    log('Cannot print link transform: robotLoader or links not available');
    return;
  }

  const link = robotLoader.links[linkName];
  if (!link) {
    log(`Link "${linkName}" not found. Available links: ${Object.keys(robotLoader.links).join(', ')}`);
    return;
  }

  // Get world position
  const worldPos = new THREE.Vector3();
  link.getWorldPosition(worldPos);

  // Get world quaternion
  const worldQuat = new THREE.Quaternion();
  link.getWorldQuaternion(worldQuat);

  // Convert quaternion to euler angles
  const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat);

  log(`Link "${linkName}" transform:`);
  log(`  World Position: ${vectorToString(worldPos)}`);
  log(`  World Rotation: [${worldEuler.x.toFixed(2)}, ${worldEuler.y.toFixed(2)}, ${worldEuler.z.toFixed(2)}]`);
}

// Add coordinate frames to visualize the robot structure
function addCoordinateFrames(robotLoader, scene, size = 0.1) {
  if (!robotLoader || !robotLoader.links || !scene) {
    log('Cannot add coordinate frames: robotLoader, links, or scene not available');
    return;
  }

  // Create a helper group to store all axis helpers
  const helpersGroup = new THREE.Group();
  helpersGroup.name = 'CoordinateFrameHelpers';
  scene.add(helpersGroup);

  // Add frame for each link
  Object.keys(robotLoader.links).forEach(linkName => {
    const link = robotLoader.links[linkName];
    const axisHelper = new THREE.AxesHelper(size);
    axisHelper.name = `${linkName}_frame`;

    // Create a wrapper group for the helper
    const wrapperGroup = new THREE.Group();
    wrapperGroup.name = `${linkName}_frame_wrapper`;
    wrapperGroup.add(axisHelper);

    // Add the wrapper to the link
    link.add(wrapperGroup);

    log(`Added coordinate frame for link: ${linkName}`);
  });

  return helpersGroup;
}

// Remove all coordinate frames
function removeCoordinateFrames(scene) {
  if (!scene) return;

  const helpersGroup = scene.getObjectByName('CoordinateFrameHelpers');
  if (helpersGroup) {
    scene.remove(helpersGroup);
    log('Removed all coordinate frame helpers');
  }
}

export {
  printRobotStructure,
  printLinkTransform,
  addCoordinateFrames,
  removeCoordinateFrames
}; 