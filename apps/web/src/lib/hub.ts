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

/**
 * Is a module part of this deployment at all?
 *
 * The shell builds its navigation from this response, so a module the API no
 * longer registers simply has no links. Its routes, though, are declared in the
 * router and would still match a bookmark or a typed URL -- rendering a page
 * that then fails against endpoints which are no longer mounted. Asking here
 * lets those routes send the visitor home instead.
 *
 * While the list is loading nothing is known, so callers are told nothing is
 * missing: redirecting on an unanswered question would bounce people off pages
 * they are allowed to see.
 */
export function useModuleEnabled(key: string): { known: boolean; enabled: boolean } {
  const { data, isLoading, isError } = useHubModules();
  if (isLoading || isError || !data) return { known: false, enabled: true };
  const found = data.modules.find((m) => m.key === key);
  return { known: true, enabled: !!found?.enabled };
}