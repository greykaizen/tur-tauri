import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import InstanceView from "./InstanceView";
import ConfirmationView from "./ConfirmationView";
import CompletionView from "./CompletionView";
import "./App.css";

// Detect window role from the Tauri window label.
class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return <div style={{background: 'red', color: 'white', padding: 20}}><h1>React Crashed</h1><pre>{this.state.error.stack}</pre></div>;
    return this.props.children;
  }
}

function Root() {
  const label = getCurrentWindow()?.label || "";
  const params = new URLSearchParams(window.location.search);
  const role = label.startsWith("download-instance:")
    ? "instance"
    : label.startsWith("download-confirmation:")
      ? "confirmation"
      : label.startsWith("download-completion:")
        ? "completion"
        : "main";

  document.documentElement.dataset.windowRole = role;

  let content;
  if (label.startsWith("download-instance:") || params.get("view") === "instance") {
    content = <InstanceView />;
  } else if (label.startsWith("download-confirmation:") || params.get("view") === "confirmation") {
    content = <ConfirmationView />;
  } else if (label.startsWith("download-completion:") || params.get("view") === "completion") {
    content = <CompletionView />;
  } else {
    content = <App />;
  }
  return <ErrorBoundary>{content}</ErrorBoundary>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
