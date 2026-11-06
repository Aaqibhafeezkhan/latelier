import { shell } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { zodValidator } from '../validators.ts';
import { ValidationError } from '../../errors.ts';
import { parseAllowedExternalUrl } from '../../security/externalUrl.ts';

// Only MongoDB docs are allowed — this channel is deliberately narrower than
// `app:openExternal` so the X04 doc panel cannot be turned into an arbitrary-
// URL opener.
const DOCS_HOSTS: ReadonlySet<string> = new Set(['www.mongodb.com']);
const DOCS_PATH = '/docs/';

const OpenExternalInput = z.object({ url: z.string() });

export function registerDocsChannels(router: Router): void {
  router.register(
    IPC_CHANNELS.docsOpenExternal,
    zodValidator(OpenExternalInput),
    async ({ url }) => {
      const parsed = parseAllowedExternalUrl(url, DOCS_HOSTS);
      if (!parsed.pathname.startsWith(DOCS_PATH)) {
        throw new ValidationError(`URL path must start with ${DOCS_PATH}`, { url });
      }
      await shell.openExternal(parsed.href);
      return { opened: true as const };
    },
  );
}
