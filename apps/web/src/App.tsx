import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { ApiError } from "./lib/api";
import { EventsProvider } from "./lib/events";
import { ProjectProvider } from "./lib/project";
import { Backlog } from "./screens/Backlog";
import { Inbox } from "./screens/Inbox";
import { RunDetail } from "./screens/RunDetail";
import { Runs } from "./screens/Runs";

export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // A missing session or a refused request won't fix itself by asking again.
      queries: { retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2 },
    },
  });
}

/** The app inside a router: BrowserRouter in the page, MemoryRouter in tests. */
export function App({ client }: { client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? newQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <EventsProvider>
        <ProjectProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/inbox" replace />} />
              <Route path="inbox" element={<Inbox />} />
              <Route path="runs" element={<Runs />} />
              <Route path="runs/:project/:id" element={<RunDetail />} />
              <Route path="backlog" element={<Backlog />} />
              <Route path="*" element={<Navigate to="/inbox" replace />} />
            </Route>
          </Routes>
        </ProjectProvider>
      </EventsProvider>
    </QueryClientProvider>
  );
}
