/**
 * Scene module for THREE.js scene setup and controller management
 */

import { log } from './logger.js';

// Variables
let scene, camera, renderer;
let controller1, controller2;
let controllerGrip1, controllerGrip2;

// Initialize the 3D scene
function init() {
  log('Initializing WebXR application');

  const container = document.createElement('div');
  document.body.appendChild(container);

  // Create scene
  scene = new THREE.Scene();
  scene.background = null; // Transparent background for AR passthrough
  log('✓ THREE.js scene created with transparent background');

  // Create camera
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

  // Add some light
  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  light.position.set(0.5, 1, 0.25);
  scene.add(light);

  // Add directional light for better model visualization
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(0, 5, 5);
  scene.add(directionalLight);

  // Setup renderer with transparent background for AR passthrough
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    premultipliedAlpha: true, // Important for correctly blending AR elements
    preserveDrawingBuffer: true // Needed for some AR implementations
  });
  renderer.setClearColor(0x000000, 0); // Set transparent clear color
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  log(`✓ Renderer initialized with transparent background for AR (pixel ratio: ${window.devicePixelRatio})`);

  try {
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.xr.enabled = true;
    log('✓ WebXR enabled for renderer');
  } catch (e) {
    log(`✗ Error setting up WebXR for renderer: ${e.message}`);
  }

  container.appendChild(renderer.domElement);

  // Add transparent background to the canvas for AR passthrough
  renderer.domElement.style.background = 'transparent';

  // Setup controllers
  setupControllers();

  // Handle window resize
  window.addEventListener('resize', onWindowResize);

  log('✓ Scene initialization complete');

  return {
    scene,
    camera,
    renderer
  };
}

// Setup controllers and controller grips
function setupControllers() {
  try {
    // Setup controller models (XRControllerModelFactory from THREE.js)
    const controllerModelFactory = new XRControllerModelFactory();

    // Controller 1
    controller1 = renderer.xr.getController(0);
    controller1.addEventListener('connected', (event) => {
      log(`Controller 1 connected: ${event.data.handedness || 'unknown'} hand`);
    });
    controller1.addEventListener('disconnected', () => {
      log('Controller 1 disconnected');
    });
    scene.add(controller1);

    // Controller 1 Grip
    controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
    scene.add(controllerGrip1);

    // Controller 2
    controller2 = renderer.xr.getController(1);
    controller2.addEventListener('connected', (event) => {
      log(`Controller 2 connected: ${event.data.handedness || 'unknown'} hand`);
    });
    controller2.addEventListener('disconnected', () => {
      log('Controller 2 disconnected');
    });
    scene.add(controller2);

    // Controller 2 Grip
    controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
    scene.add(controllerGrip2);

    log('✓ Native controller models set up');
  } catch (e) {
    log(`✗ Error setting up controllers: ${e.message}`);
  }
}

// Handle window resize
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Configure scene specifically for AR passthrough mode
function configureForAR(isARMode) {
  if (isARMode) {
    // Set transparent background for AR passthrough
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.background = 'transparent';
    log('✓ Scene configured for AR passthrough');
  } else {
    // For VR mode, we can use a dark background
    scene.background = new THREE.Color(0x000000);
    renderer.setClearColor(0x000000, 1);
    log('✓ Scene configured for VR mode with dark background');
  }
}

// Get the scene
function getScene() {
  return scene;
}

// Get the camera
function getCamera() {
  return camera;
}

// Get the renderer
function getRenderer() {
  return renderer;
}

export {
  init,
  getScene,
  getCamera,
  getRenderer,
  configureForAR
}; 