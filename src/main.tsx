import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import InstanceView from "./InstanceView";
import "./App.css";

// Detect window role from the Tauri window label.
// - Main window label: "main"  → renders <App />
// - Instance window label: "download-instance:{taskId}"  → renders <InstanceView />
function Root() {
  const label = getCurrentWindow().label;

  if (label.startsWith("download-instance:")) {
    return <InstanceView />;
  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
