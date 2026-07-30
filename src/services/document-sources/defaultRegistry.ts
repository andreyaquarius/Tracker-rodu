import { DirectPdfSourceAdapter } from "./directPdfAdapter.ts";
import type { DocumentSourceGatewayClient } from "./gatewayClient.ts";
import { GoogleDrivePdfSourceAdapter } from "./googleDriveAdapter.ts";
import { DocumentSourceAdapterRegistry } from "./registry.ts";
import { WikimediaPdfSourceAdapter } from "./wikimediaAdapter.ts";

export interface DefaultDocumentSourceRegistryOptions {
  fetch?: typeof fetch;
  gateway?: DocumentSourceGatewayClient;
  now?: () => Date;
}

/** Provider-specific adapters must stay ahead of the generic direct-PDF fallback. */
export function createDefaultDocumentSourceRegistry(
  options: DefaultDocumentSourceRegistryOptions = {},
): DocumentSourceAdapterRegistry {
  return new DocumentSourceAdapterRegistry([
    new WikimediaPdfSourceAdapter(options),
    new GoogleDrivePdfSourceAdapter(options),
    new DirectPdfSourceAdapter(options),
  ]);
}
