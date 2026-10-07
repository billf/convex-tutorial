import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "react-error-boundary";
import { ConvexProvider, ConvexReactClient } from "convex/react";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <ErrorBoundary
        fallback={<p>Something went wrong — try reloading.</p>}
        onError={(error) => console.error("Uncaught error in App", error)}
      >
        <App />
      </ErrorBoundary>
    </ConvexProvider>
  </StrictMode>,
);
