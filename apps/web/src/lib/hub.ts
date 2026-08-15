import { useQuery } from '@tanstack/react-query';
import type { HubModulesResponse } from '../contract';
import { api } from './api';
import { qk } from './keys';

/** The shell renders whatever this returns -- there is no hard-coded menu. */
export function useHubModules() {
  return useQuery({
    queryKey: qk.hub,
    queryFn: () => api<HubModulesResponse>('/hub/modules'),
    staleTime: 5 * 60 * 1000,
  });
}
