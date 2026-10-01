import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { ConvexProvider, ConvexReactClient } from "convex/react";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <ErrorBoundary fallback={<p>Something went wrong — try reloading.</p>}>
        <App />
      </ErrorBoundary>
    </ConvexProvider>
  </StrictMode>,
);
