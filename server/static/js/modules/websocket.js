/**
 * WebSocket service for communicating with the backend using binary protocol buffers
 */

import { log } from './logger.js';
import { getArmLoader, updateJointAngle } from './robot.js';
import {
  initProtobuf,
  createHeartbeatMessage,
  createJointPositionMessage,
  encodeMessage,
  decodeMessage,
  getActionType
} from './proto.js';

// WebSocket connection state
let socket = null;
let isConnected = false;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;
let messageCounter = 0;
let heartbeatInterval = null;  // Add heartbeat interval tracker
const HEARTBEAT_INTERVAL_MS = 200;  // Send heartbeat every 200ms

// Event callbacks
const eventListeners = {
  onOpen: [],
  onClose: [],
  onMessage: [],
  onError: [],
  onImageUpdate: []  // Add new image update event listeners
};

// Store the latest camera images
const cameraImages = {};

// Initialize protobuf when module loads
let protoInitialized = false;

/**
 * Initialize the WebSocket connection
 * @returns {Promise<boolean>} Promise that resolves when connection is established
 */
export async function connectWebSocket() {
  // Check if already connected
  if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(true);
  }

  // Initialize protobuf if not already done
  if (!protoInitialized) {
    try {
      log('Initializing Protocol Buffers...');
      protoInitialized = await initProtobuf();
      if (!protoInitialized) {
        log('❌ Failed to initialize Protocol Buffers');
        return Promise.reject(new Error("Failed to initialize Protocol Buffers"));
      }
    } catch (error) {
      log(`❌ Protocol Buffers initialization error: ${error.message}`);
      return Promise.reject(error);
    }
  }

  return new Promise((resolve, reject) => {
    try {
      // Reset connection attempts on manual connect
      connectionAttempts = 0;
      messageCounter = 0;

      // Determine if we're using secure WebSocket based on the current page protocol
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/teleop`;

      log(`Opening WebSocket connection to: ${wsUrl}`);

      // Debug: log WebSocket support
      if (typeof WebSocket === 'undefined') {
        const errorMsg = 'WebSocket not supported in this browser';
        log(`❌ ${errorMsg}`);
        return reject(new Error(errorMsg));
      }

      // Create socket
      socket = new WebSocket(wsUrl);

      // Expose socket for debugging
      window._socket = socket;

      if (!socket) {
        const errorMsg = 'Failed to create WebSocket instance';
        log(`❌ ${errorMsg}`);
        return reject(new Error(errorMsg));
      }

      // Set binary type to arraybuffer for binary protobuf messages
      socket.binaryType = 'arraybuffer';

      socket.onopen = (event) => {
        log('✅ WebSocket connection established');
        isConnected = true;
        connectionAttempts = 0;

        // Start heartbeat interval when connection opens
        startHeartbeat();

        // Notify all open event listeners
        eventListeners.onOpen.forEach(callback => callback(event));

        // Send initial heartbeat to confirm connection
        try {
          sendHeartbeat();
        } catch (err) {
          log(`⚠️ Error sending initial heartbeat: ${err.message}`);
        }

        resolve(true);
      };

      socket.onclose = (event) => {
        log(`WebSocket connection closed: ${event.code} ${event.reason}`);
        isConnected = false;

        // Stop heartbeat on connection close
        stopHeartbeat();

        // Notify all close event listeners
        eventListeners.onClose.forEach(callback => callback(event));

        // Attempt reconnection if not a clean close
        if (!event.wasClean && connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
          connectionAttempts++;
          log(`Attempting reconnection ${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
          setTimeout(() => {
            connectWebSocket().catch(err => {
              log(`Reconnection attempt failed: ${err.message}`);
            });
          }, RECONNECT_DELAY_MS);
        }

        if (connectionAttempts === 0) {
          // This was the first attempt, so reject the promise
          reject(new Error(`WebSocket connection failed: ${event.code} ${event.reason}`));
        }
      };

      socket.onmessage = async (event) => {
        try {
          const msgNum = ++messageCounter;

          // Binary data handling
          if (event.data instanceof ArrayBuffer) {
            try {
              const message = await decodeMessage(event.data);

              // Process message based on action type
              const actionType = getActionType();
              const actionName = Object.keys(actionType).find(key => actionType[key] === message.action_type) || 'UNKNOWN';

              if (message.action_type === actionType.JOINT_POSITION_UPDATE) {
                const jointPos = message.joint_position;
                if (jointPos && jointPos.joints && jointPos.joints.length > 0) {
                  // Apply joint positions to the 3D model
                  applyJointPositions(jointPos.robot_id, jointPos.joint_group_id, jointStateArrayToObject(jointPos.joints));
                }
              } else if (message.action_type === actionType.CONNECTION_STATUS) {
                // Only log connection status messages
                if (message.connection_status) {
                  log(`🔌 Connection status: ${message.connection_status.status}, ${message.connection_status.message}`);
                }
              } else if (message.action_type === actionType.IMAGE_UPDATE) {
                // Handle image update messages
                if (message.image && message.image.image_data) {
                  processImageUpdate(message.image);
                }
              }

              // Notify all message event listeners
              eventListeners.onMessage.forEach(callback => callback(message));
            } catch (decodeError) {
              log(`❌ Failed to decode binary message: ${decodeError.message}`);
              console.error('Decode error details:', decodeError);
            }
          } else {
            // Only log non-binary data as it's unexpected
            log(`⚠️ Received non-binary data, unexpected with binary-only protocol`);
          }
        } catch (error) {
          log(`❌ Error processing WebSocket message: ${error.message}`);
          console.error('WebSocket message processing error:', error);
        }
      };

      socket.onerror = (event) => {
        log(`❌ WebSocket error occurred`);

        // Debug: Add more detailed error diagnostics
        if (event.error) {
          console.error("WebSocket Error Details:", event.error);
        }

        // Notify all error event listeners
        eventListeners.onError.forEach(callback => callback(event));

        reject(new Error('WebSocket connection error'));
      };
    } catch (error) {
      log(`❌ Error creating WebSocket: ${error.message}`);
      reject(error);
    }
  });
}

/**
 * Process an image update from the server
 * @param {Object} imagePayload - The image payload from the server
 */
function processImageUpdate(imagePayload) {
  console.log('Processing image update:');
  try {
    const { camera_id, image_data, format, width, height, encoding, capture_timestamp } = imagePayload;

    // If we already have this camera image, revoke the old URL to prevent memory leaks
    if (cameraImages[camera_id] && cameraImages[camera_id].url) {
      URL.revokeObjectURL(cameraImages[camera_id].url);
    }

    // Create a blob URL from the image data for display
    const blob = new Blob([image_data], { type: `image/${format}` });
    const imageUrl = URL.createObjectURL(blob);

    // Store image information
    cameraImages[camera_id] = {
      url: imageUrl,
      width,
      height,
      format,
      encoding,
      timestamp: capture_timestamp,
      receivedAt: Date.now()
    };

    log(`📷 Received image from camera ${camera_id} (${width}x${height}, ${format})`);

    // Notify image update listeners
    eventListeners.onImageUpdate.forEach(callback =>
      callback({
        cameraId: camera_id,
        imageUrl,
        width,
        height,
        format,
        timestamp: capture_timestamp
      })
    );
  } catch (error) {
    log(`❌ Error processing image update: ${error.message}`);
  }
}

/**
 * Convert joints array to object format
 * @param {Array} joints - Array of joint state objects
 * @returns {Object} - Object mapping joint names to states
 */
function jointStateArrayToObject(joints) {
  const jointStates = {};
  joints.forEach(joint => {
    jointStates[joint.joint_name] = {
      position: joint.position,
      velocity: joint.velocity,
      effort: joint.effort
    };
  });
  return jointStates;
}

/**
 * Apply joint positions received from the server to the 3D model
 * @param {string} robotId - ID of the robot
 * @param {string} jointGroupId - ID of the joint group
 * @param {Object} joints - Joint state data from server
 */
function applyJointPositions(robotId, jointGroupId, joints) {
  try {
    // Get the arm loader for this robot/joint group
    const armLoader = getArmLoader(robotId, jointGroupId);
    if (!armLoader) {
      log(`⚠️ Cannot apply joint positions: Arm loader not found for robot ${robotId}, joint group ${jointGroupId}`);
      return;
    }

    // Convert joint states to angles
    let jointCount = 0;

    for (const jointName in joints) {
      if (joints.hasOwnProperty(jointName)) {
        const jointState = joints[jointName];
        // Convert from degrees to radians (positions from server are in degrees)
        const angleRadians = jointState.position * Math.PI / 180;

        // Update only the real model (not the ghost) using the central updateJointAngle function
        // No need for fromServer flag since we removed frontend correction
        updateJointAngle(robotId, jointGroupId, jointName, angleRadians);
        jointCount++;
      }
    }

    if (jointCount > 0) {
      log(`Applied ${jointCount} joint positions from server to robot ${robotId}, joint group ${jointGroupId}`);
    }
  } catch (error) {
    log(`❌ Error applying joint positions: ${error.message}`);
  }
}

/**
 * Get the latest camera image
 * @param {string} cameraId - ID of the camera
 * @returns {Object|null} The camera image or null if not available
 */
export function getCameraImage(cameraId) {
  return cameraImages[cameraId] || null;
}

/**
 * Get all camera images
 * @returns {Object} Object mapping camera IDs to image data
 */
export function getAllCameraImages() {
  return { ...cameraImages };
}

/**
 * Disconnect the WebSocket connection
 */
export function disconnectWebSocket() {
  stopHeartbeat();  // Make sure to stop heartbeat when disconnecting
  if (socket) {
    log('Closing WebSocket connection');
    socket.close();
    socket = null;
    window._socket = null;
    isConnected = false;
  }
}

/**
 * Add event listener for WebSocket events
 * @param {string} event - Event type: 'open', 'close', 'message', 'error', 'imageUpdate'
 * @param {function} callback - Function to call when event occurs
 */
export function addEventListener(event, callback) {
  if (event === 'open') {
    eventListeners.onOpen.push(callback);
  } else if (event === 'close') {
    eventListeners.onClose.push(callback);
  } else if (event === 'message') {
    eventListeners.onMessage.push(callback);
  } else if (event === 'error') {
    eventListeners.onError.push(callback);
  } else if (event === 'imageUpdate') {
    eventListeners.onImageUpdate.push(callback);
  }
}

/**
 * Remove event listener
 * @param {string} event - Event type
 * @param {function} callback - Function to remove
 */
export function removeEventListener(event, callback) {
  if (event === 'open') {
    eventListeners.onOpen = eventListeners.onOpen.filter(cb => cb !== callback);
  } else if (event === 'close') {
    eventListeners.onClose = eventListeners.onClose.filter(cb => cb !== callback);
  } else if (event === 'message') {
    eventListeners.onMessage = eventListeners.onMessage.filter(cb => cb !== callback);
  } else if (event === 'error') {
    eventListeners.onError = eventListeners.onError.filter(cb => cb !== callback);
  } else if (event === 'imageUpdate') {
    eventListeners.onImageUpdate = eventListeners.onImageUpdate.filter(cb => cb !== callback);
  }
}

/**
 * Send a heartbeat message to keep the connection alive
 */
export function sendHeartbeat() {
  if (!isConnected || !socket || !protoInitialized) {
    return;
  }

  try {
    // Create and encode heartbeat message
    const clientTime = Date.now();
    const heartbeat = createHeartbeatMessage(clientTime);
    const data = encodeMessage(heartbeat);

    // Send binary data
    socket.send(data);
  } catch (error) {
    log(`❌ Error sending heartbeat: ${error.message}`);
  }
}

/**
 * Send a joint position command to the backend
 * @param {string} robotId - ID of the robot
 * @param {string} jointGroupId - ID of the joint group
 * @param {Array} joints - Array of joint states
 */
export function sendJointPositionCommand(robotId, jointGroupId, joints) {
  if (!isConnected || !socket || !protoInitialized) {
    log(`❌ Cannot send joint positions: WebSocket not connected or protobuf not initialized`);
    return;
  }

  try {
    // Create and encode joint position message
    const message = createJointPositionMessage(robotId, jointGroupId, joints);
    const data = encodeMessage(message);

    // Send binary data
    socket.send(data);
  } catch (error) {
    log(`❌ Error sending joint position command: ${error.message}`);
  }
}

/**
 * Check if WebSocket is connected
 * @returns {boolean} True if connected
 */
export function isWebSocketConnected() {
  return isConnected && socket && socket.readyState === WebSocket.OPEN;
}

// Export the socket for debugging
export function getSocket() {
  return socket;
}

/**
 * Start the heartbeat interval
 */
function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  heartbeatInterval = setInterval(() => {
    if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
      sendHeartbeat();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat interval
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}