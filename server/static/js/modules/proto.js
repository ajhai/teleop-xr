/**
 * Protocol Buffer utilities for binary serialization
 */

import { log } from './logger.js';

// Message type definitions matching our transport.proto
const ActionType = {
  UNKNOWN: 0,
  ROBOT_STATE_UPDATE: 1,
  ROBOT_COMMAND: 2,
  JOINT_POSITION_UPDATE: 3,
  JOINT_POSITION_COMMAND: 4,
  IMAGE_UPDATE: 5,
  ERROR: 6,
  CONNECTION_STATUS: 7,
  HEARTBEAT: 8
};

const JointMode = {
  POSITION: 0,
  VELOCITY: 1,
  EFFORT: 2,
  DISABLED: 3
};

// Root for protobuf definitions
let protoRoot = null;
let TransportMessage = null;
let initialized = false;
let messageCounter = 0;

/**
 * Initialize protobuf module
 * @returns {Promise<boolean>}
 */
export async function initProtobuf() {
  if (initialized) {
    return true;
  }

  try {
    log('Initializing Protocol Buffers...');

    // Check if protobuf.js is loaded
    if (typeof protobuf === 'undefined') {
      log('ProtobufJS not loaded yet, waiting...');
      // Wait for protobuf to load (up to 3 seconds)
      await new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 30;
        const checkInterval = setInterval(() => {
          attempts++;
          if (typeof protobuf !== 'undefined') {
            clearInterval(checkInterval);
            log('ProtobufJS library loaded');
            resolve(true);
          } else if (attempts >= maxAttempts) {
            clearInterval(checkInterval);
            log('ProtobufJS not available after waiting');
            resolve(false);
          }
        }, 100); // Check every 100ms
      });

      // Check again
      if (typeof protobuf === 'undefined') {
        throw new Error('ProtobufJS library not available');
      }
    }

    // Create a new protobuf namespace
    protoRoot = protobuf.Root.fromJSON({
      "nested": {
        "teleop_xr": {
          "nested": {
            "Transport": {
              "fields": {
                "action_type": {
                  "type": "int32",
                  "id": 1
                },
                "timestamp": {
                  "type": "int64",
                  "id": 2
                },
                "sequence": {
                  "type": "uint32",
                  "id": 3
                },
                "robot_state": {
                  "type": "RobotStatePayload",
                  "id": 10,
                  "oneof": "payload"
                },
                "robot_command": {
                  "type": "RobotCommandPayload",
                  "id": 11,
                  "oneof": "payload"
                },
                "joint_position": {
                  "type": "JointPositionPayload",
                  "id": 12,
                  "oneof": "payload"
                },
                "image": {
                  "type": "ImagePayload",
                  "id": 13,
                  "oneof": "payload"
                },
                "error": {
                  "type": "ErrorPayload",
                  "id": 14,
                  "oneof": "payload"
                },
                "connection_status": {
                  "type": "ConnectionStatusPayload",
                  "id": 15,
                  "oneof": "payload"
                },
                "heartbeat": {
                  "type": "HeartbeatPayload",
                  "id": 16,
                  "oneof": "payload"
                }
              }
            },
            "RobotStatePayload": {
              "fields": {
                "robot_id": {
                  "type": "string",
                  "id": 1
                },
                "joints": {
                  "rule": "repeated",
                  "type": "JointState",
                  "id": 2
                },
                "status": {
                  "type": "int32",
                  "id": 3
                },
                "joint_groups": {
                  "keyType": "string",
                  "type": "JointGroupState",
                  "id": 4
                }
              }
            },
            "RobotCommandPayload": {
              "fields": {
                "robot_id": {
                  "type": "string",
                  "id": 1
                },
                "command": {
                  "type": "string",
                  "id": 2
                }
              }
            },
            "HeartbeatPayload": {
              "fields": {
                "client_time": {
                  "type": "uint64",
                  "id": 1
                },
                "server_time": {
                  "type": "uint64",
                  "id": 2
                }
              }
            },
            "JointPositionPayload": {
              "fields": {
                "robot_id": {
                  "type": "string",
                  "id": 1
                },
                "joint_group_id": {
                  "type": "string",
                  "id": 2
                },
                "joints": {
                  "rule": "repeated",
                  "type": "JointState",
                  "id": 3
                }
              }
            },
            "JointState": {
              "fields": {
                "joint_name": {
                  "type": "string",
                  "id": 1
                },
                "position": {
                  "type": "float",
                  "id": 2
                },
                "velocity": {
                  "type": "float",
                  "id": 3
                },
                "effort": {
                  "type": "float",
                  "id": 4
                },
                "target": {
                  "type": "float",
                  "id": 5
                },
                "mode": {
                  "type": "int32",
                  "id": 6
                }
              }
            },
            "ImagePayload": {
              "fields": {
                "camera_id": {
                  "type": "string",
                  "id": 1
                },
                "image_data": {
                  "type": "bytes",
                  "id": 2
                },
                "format": {
                  "type": "string",
                  "id": 3
                }
              }
            },
            "ErrorPayload": {
              "fields": {
                "error_code": {
                  "type": "string",
                  "id": 1
                },
                "message": {
                  "type": "string",
                  "id": 2
                },
                "severity": {
                  "type": "int32",
                  "id": 4
                }
              }
            },
            "ConnectionStatusPayload": {
              "fields": {
                "robot_id": {
                  "type": "string",
                  "id": 1
                },
                "status": {
                  "type": "int32",
                  "id": 2
                },
                "message": {
                  "type": "string",
                  "id": 3
                },
                "connection_timestamp": {
                  "type": "int64",
                  "id": 4
                }
              }
            },
            "JointGroupState": {
              "fields": {
                "joint_group_id": {
                  "type": "string",
                  "id": 1
                },
                "joints": {
                  "rule": "repeated",
                  "type": "JointState",
                  "id": 2
                },
                "end_effector_pose": {
                  "type": "Pose",
                  "id": 3
                }
              }
            }
          }
        }
      }
    });

    // Lookup the Transport message type
    TransportMessage = protoRoot.lookupType("teleop_xr.Transport");

    if (!TransportMessage) {
      throw new Error("Failed to lookup Transport message type");
    }

    initialized = true;
    log('✅ Protocol Buffers initialized successfully');
    return true;
  } catch (error) {
    log(`❌ Error initializing protobuf: ${error.message}`);
    return false;
  }
}

/**
 * Create a heartbeat message
 * @param {number} clientTime - Client timestamp in milliseconds
 * @returns {Object} Message object
 */
export function createHeartbeatMessage(clientTime = Date.now()) {
  if (!initialized) {
    throw new Error("Protocol buffers not initialized");
  }

  messageCounter++;

  // Ensure clientTime is a valid number
  if (clientTime === undefined || clientTime === null) {
    clientTime = Date.now();
  }

  return {
    action_type: ActionType.HEARTBEAT,
    timestamp: Date.now(),
    sequence: messageCounter,
    heartbeat: {
      client_time: clientTime,
      server_time: 0  // Will be set by server
    }
  };
}

/**
 * Create a joint position command message
 * @param {string} robotId - ID of the robot
 * @param {string} jointGroupId - ID of the joint group
 * @param {Array} joints - Array of joint states
 * @returns {Object} Message object
 */
export function createJointPositionMessage(robotId, jointGroupId, joints) {
  if (!initialized) {
    throw new Error("Protocol buffers not initialized");
  }

  // Convert joints to protobuf format
  const jointPositions = joints.map(joint => ({
    joint_name: joint.joint_name,
    position: joint.position,
    velocity: joint.velocity || 0,
    effort: joint.effort || 0,
    target: joint.position,
    mode: JointMode.POSITION
  }));

  messageCounter++;
  return {
    action_type: ActionType.JOINT_POSITION_COMMAND,
    timestamp: Date.now(),
    sequence: messageCounter,
    joint_position: {
      robot_id: robotId,
      joint_group_id: jointGroupId,
      joints: jointPositions
    }
  };
}

/**
 * Encode a message to binary protobuf format
 * @param {Object} message - Message to encode
 * @returns {Uint8Array} Binary representation
 */
export function encodeMessage(message) {
  if (!initialized) {
    log("Using JSON fallback encoding (protobuf not initialized)");
    return JSON.stringify(message);
  }

  try {
    // Verify the message against the protobuf schema
    const err = TransportMessage.verify(message);
    if (err) {
      log(`Protobuf verification error: ${err}`);
      // Fall back to JSON if verification fails
      log("Using JSON fallback encoding (verification failed)");
      return JSON.stringify(message);
    }

    // Create the message instance
    const pbMessage = TransportMessage.create(message);

    // Encode to binary
    const binaryData = TransportMessage.encode(pbMessage).finish();

    return binaryData;
  } catch (error) {
    log(`Error encoding binary message: ${error.message}`);
    // Fall back to JSON if binary encoding fails
    log("Using JSON fallback encoding (encoding failed)");
    return JSON.stringify(message);
  }
}

/**
 * Decode a binary protocol buffer message
 * @param {ArrayBuffer} data - Binary data to decode
 * @returns {Promise<Object>} Decoded message
 */
export async function decodeMessage(data) {
  if (!initialized) {
    throw new Error("Protocol buffers not initialized");
  }

  // Check if we need to deserialize binary or JSON data
  try {
    if (shouldUseBinary() && data instanceof ArrayBuffer) {
      // Use protobuf.js to decode the binary data
      return await protoRoot.lookupType('teleop_xr.Transport').decode(new Uint8Array(data));
    } else {
      // Fallback to JSON if binary is not supported or data is not an ArrayBuffer
      const textDecoder = new TextDecoder();
      const jsonString = textDecoder.decode(data);
      return JSON.parse(jsonString);
    }
  } catch (error) {
    console.error('Error decoding protocol buffer message:', error);
    log(`Error decoding message: ${error.message}`);
    throw error;
  }
}

/**
 * Determine if a message should use binary encoding
 * @param {Object} message - Message to check
 * @returns {boolean} True if binary encoding should be used
 */
export function shouldUseBinary(message) {
  return initialized;
}

/**
 * Get the action type enum values
 * @returns {Object} ActionType enum
 */
export function getActionType() {
  return ActionType;
}

/**
 * Get the joint mode enum values
 * @returns {Object} JointMode enum
 */
export function getJointMode() {
  return JointMode;
} 