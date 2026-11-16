import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { PwaProvider } from "./components/PwaProvider";
import { ReauthProvider } from "./components/ReauthDialog";
import { AuthProvider } from "./lib/auth";
import { ToastProvider } from "./lib/toast";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PwaProvider>
        <ToastProvider>
          <AuthProvider>
            <ReauthProvider>
              <App />
            </ReauthProvider>
          </AuthProvider>
        </ToastProvider>
      </PwaProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
