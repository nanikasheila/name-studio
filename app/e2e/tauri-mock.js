// Stands in for the Tauri side in a plain browser: the app starts, commands
// are recorded (window.__calls) and answered as an app with no file would.
window.__calls = [];
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  async invoke(command, args) {
    window.__calls.push({ command, args });
    switch (command) {
      case "plugin:event|listen":
        return 1;
      case "plugin:app|version":
        return "0.0.0";
      case "pending_recoveries":
        return [];
      case "batch_export_task":
      case "is_release_build":
        return command === "is_release_build" ? false : null;
      case "autosave_project":
        return { savedToFile: false, version: null, problems: [] };
      case "log_error":
        return null;
      default:
        throw new Error(`no app: ${command}`);
    }
  },
  transformCallback(callback) {
    const id = Math.floor(Math.random() * 1e9);
    window[`_${id}`] = callback;
    return id;
  },
  unregisterCallback() {},
  convertFileSrc: (path) => path,
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
