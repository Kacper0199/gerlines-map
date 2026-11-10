import { changeLocale, isLocale } from "@gerlines/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./sheet.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("The sheet needs a root element");
}

const requested = new URLSearchParams(window.location.search).get("lang") ?? "en";
await changeLocale(isLocale(requested) ? requested : "en");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
