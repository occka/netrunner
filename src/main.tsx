import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "@/styles/base.css";
import "@/styles/components.css";
import "@/styles/shell.css";
import "@/styles/dashboard.css";
import "@/styles/modules.css";
import "@/styles/phase2.css";
import "@/styles/developer.css";
import "@/styles/neural.css";
import "@/styles/browser.css";
import "@/styles/appearance.css";
import "@/styles/motion.css";
import { applyTheme, DEFAULT_THEME } from "@/styles/theme";
import { App } from "@/app/App";
import { OverlayApp } from "@/overlay/OverlayApp";

// Paint the default theme before React mounts so there is no unstyled flash.
applyTheme(DEFAULT_THEME);

// The same bundle serves the main window and floating overlay windows
// (overlay windows are opened with ?overlay=<id>).
const overlayId = Number(new URLSearchParams(window.location.search).get("overlay"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{overlayId > 0 ? <OverlayApp id={overlayId} /> : <App />}</React.StrictMode>,
);
