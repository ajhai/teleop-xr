/**
 * Logger module for debug messages
 */

// Maximum number of log entries to keep
const MAX_LOG_ENTRIES = 200;
const logHistory = [];

// Debug helper function
function log(message) {
  const debugElement = document.getElementById('debug');
  if (!debugElement) return;

  const timestamp = new Date().toLocaleTimeString();
  const logEntry = `[${timestamp}] ${message}`;

  // Add to history
  logHistory.push(logEntry);
  if (logHistory.length > MAX_LOG_ENTRIES) {
    logHistory.shift(); // Remove oldest entry
  }

  // Update the debug element with formatted log history
  debugElement.innerHTML = logHistory.join('\n');
  console.log(message);

  // Auto-scroll to bottom
  debugElement.scrollTop = debugElement.scrollHeight;
}

// Clear debug log
function clearLog() {
  logHistory.length = 0;
  const debugElement = document.getElementById('debug');
  if (debugElement) {
    debugElement.innerHTML = '';
  }
}

export { log, clearLog }; 