import type { UIAdapterModule } from "../types";
import { buildPhiLocalConfig, createPhiStdoutParser, parsePhiStdoutLine } from "@paperclipai/adapter-phi-local/ui";
import { PiLocalConfigFields } from "../pi-local/config-fields";

/**
 * Phi Bot engine: same configuration fields as pi (instructions file). The
 * transcript parser is created per transcript, so tool-call and delta state
 * never leaks between two open run transcripts.
 */
export const phiLocalUIAdapter: UIAdapterModule = {
  type: "phi_local",
  label: "Phi",
  parseStdoutLine: parsePhiStdoutLine,
  createStdoutParser: createPhiStdoutParser,
  ConfigFields: PiLocalConfigFields,
  buildAdapterConfig: buildPhiLocalConfig,
};
