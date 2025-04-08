/**
 * Debug utilities for robot visualization and diagnostics
 */

import { log } from './modules/logger.js';
import { getSelectedRobotId } from './modules/robot.js';

// Variables for diagnostics
let diagnosticsInterval = null;
let isDiagnosticsRunning = false;

/**
 * Start periodic diagnostics
 */
function startDiagnostics(interval = 5000) {
  if (isDiagnosticsRunning) {
    console.log('Diagnostics already running');
    return;
  }

  console.log('Starting periodic diagnostics...');
  isDiagnosticsRunning = true;

  // Run immediately
  performDiagnostics();

  // Then run periodically
  diagnosticsInterval = setInterval(performDiagnostics, interval);
}

/**
 * Stop periodic diagnostics
 */
function stopDiagnostics() {
  if (diagnosticsInterval) {
    clearInterval(diagnosticsInterval);
    diagnosticsInterval = null;
  }
  isDiagnosticsRunning = false;
  console.log('Diagnostics stopped');
}

/**
 * Perform diagnostics on the system
 */
function performDiagnostics() {
  console.log('🤖 ---------- DIAGNOSTICS RUN ----------');

  // Check if a robot is selected
  const robotId = getSelectedRobotId();
  if (robotId) {
    console.log(`🤖 Selected robot: ${robotId}`);
  } else {
    console.log('⚠️ No robot selected');
  }

  // Check for loaded arms
  if (window.loadedArms) {
    const armCount = Object.keys(window.loadedArms).length;
    console.log(`🤖 Loaded arms: ${armCount}`);
  } else {
    console.log('⚠️ No arms loaded');
  }

  // Check for robot loaders
  if (window.robotLoaders) {
    const loaderCount = Object.keys(window.robotLoaders).length;
    console.log(`🤖 Robot loaders: ${loaderCount}`);
  } else {
    console.log('⚠️ No robot loaders available');
  }

  console.log('🤖 ---------- END DIAGNOSTICS ----------');
}

/**
 * Dump current state to console
 */
function dumpCurrentState() {
  const robotId = getSelectedRobotId();

  console.log('🤖 ---------- CURRENT STATE DUMP ----------');
  console.log(`🤖 Selected robot ID: ${robotId || 'none'}`);

  // Get joint positions for all arms
  if (window.robotLoaders && robotId) {
    const armNames = Object.keys(window.robotLoaders);

    console.log('🤖 Joint positions:');
    for (const armName of armNames) {
      const loader = window.robotLoaders[armName];
      if (loader && loader.getJointAngles) {
        console.log(`🤖 Arm: ${armName}`);
        console.log('Joint angles (radians):', loader.getJointAngles());
        console.log('Joint angles (degrees):', loader.getJointAngles(true));
      }
    }
  }

  console.log('🤖 ---------- END STATE DUMP ----------');
}

// Create a diagnostics object for the window
window.robotDiagnostics = {
  startDiagnostics,
  stopDiagnostics,
  performDiagnostics,
  dumpCurrentState
};

console.log('🤖 Robot diagnostics loaded. Access via window.robotDiagnostics');
console.log('🤖 Available functions:');
console.log('🤖 - window.robotDiagnostics.startDiagnostics()');
console.log('🤖 - window.robotDiagnostics.stopDiagnostics()');
console.log('🤖 - window.robotDiagnostics.performDiagnostics()');
console.log('🤖 - window.robotDiagnostics.dumpCurrentState()'); 