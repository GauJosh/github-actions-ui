import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GitHubError } from "./github/client";
import { App } from "./ui/App";
import "./ui/styles.css";
import "./ui/explorer.css";
import "./ui/release.css";
import "./ui/focus.css";
import "./ui/theme.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // Failures with an explicit state (permission, not found, rate limit…) are shown, not retried.
      retry: (attempt, error) => !(error instanceof GitHubError && error.failure.kind !== "network") && attempt < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
