import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

async function start() {
  // Outside the Tauri shell (a plain browser during development) use sample data.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./devMock")).installDevMock();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
