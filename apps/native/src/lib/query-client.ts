import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient } from "@tanstack/react-query";

// QueryClient configured for offline-first canvassing. Reads serve cached
// data without waiting on the network; mutations queue automatically when
// offline and replay when reconnected. The cache is persisted to AsyncStorage
// so a fresh app launch starts with the previous session's data.
//
// gcTime is intentionally long (7 days) so unused queries aren't garbage-
// collected before the persistor has a chance to write them. The persistor's
// `maxAge` (also 7 days, set in `_layout.tsx` when wiring the provider) is
// the actual eviction policy.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "offlineFirst",
      gcTime: 1000 * 60 * 60 * 24 * 7, // 7 days
      staleTime: 1000 * 60 * 5, // 5 min
      retry: 2,
    },
    mutations: {
      networkMode: "offlineFirst",
      retry: 5,
    },
  },
});

export const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "field-tools-rq-cache",
  throttleTime: 1000,
});
