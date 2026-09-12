import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { resolveTheme } from "./theme";

document.documentElement.dataset.theme = resolveTheme(
  localStorage.getItem("plex.theme"),
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
