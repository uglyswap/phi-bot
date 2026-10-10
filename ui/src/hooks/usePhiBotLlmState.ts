import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { secretsApi } from "../api/secrets";
import { derivePhiBotLlmState, type PhiBotLlmState } from "../lib/phibot-llm";
import { queryKeys } from "../lib/queryKeys";

export interface PhiBotLlmStateQuery {
  state: PhiBotLlmState;
  loaded: boolean;
  error: Error | null;
}

/** Read-only view of the company AI provider settings (secret metadata only). */
export function usePhiBotLlmState(companyId: string | null, enabled = true): PhiBotLlmStateQuery {
  const secrets = useQuery({
    queryKey: companyId ? queryKeys.secrets.list(companyId) : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(companyId!),
    enabled: enabled && Boolean(companyId),
  });
  const state = useMemo(() => derivePhiBotLlmState(secrets.data ?? []), [secrets.data]);
  return { state, loaded: secrets.isSuccess, error: secrets.error ?? null };
}
