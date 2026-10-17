import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ConnectionService } from '../../mongo/ConnectionService.ts';
import { buildUri } from '../../mongo/uri.ts';
import type { Router } from '../router.ts';
import { IdInputSchema, NonEmpty, zodValidator } from '../validators.ts';
import {
  ConnectionInputSchema,
  ConnectionTestInputSchema,
  ConnectionUpdateSchema,
  ParseUriInputSchema,
} from '../schemas/connection.ts';
import {
  assertCredentialPathsAllowed,
  credentialPathsOf,
  type PickedCredentialPaths,
} from '../../security/credentialPaths.ts';

const UpdateInput = z.object({
  id: NonEmpty,
  patch: ConnectionUpdateSchema,
});

/**
 * `pickedCredentialPaths` is the set `registerAppChannels` fills from the open
 * dialog. A TLS / SSH-key path is accepted only if it was picked there this
 * session, or (update, test) it is a value a stored connection already holds,
 * so editing an unrelated field never forces a re-pick. Required, not optional.
 */
export function registerConnChannels(
  router: Router,
  svc: ConnectionService,
  pickedCredentialPaths: PickedCredentialPaths,
): void {
  router.register(
    IPC_CHANNELS.connList,
    zodValidator(z.undefined().or(z.null()).optional()),
    () => svc.list(),
  );

  router.register(
    IPC_CHANNELS.connGet,
    zodValidator(IdInputSchema),
    ({ id }) => svc.get(id),
  );

  // No password argument: the copied string never carries the saved secret,
  // so nothing secret crosses IPC in either direction.
  router.register(
    IPC_CHANNELS.connGetUri,
    zodValidator(IdInputSchema),
    ({ id }) => ({ uri: buildUri(svc.get(id)) }),
  );

  // SECRET_INPUT: 'conn:create' payload carries plaintext password / ssh credentials.
  router.register(
    IPC_CHANNELS.connCreate,
    zodValidator(ConnectionInputSchema),
    (input) => {
      assertCredentialPathsAllowed(credentialPathsOf(input), pickedCredentialPaths, []);
      return svc.create(input);
    },
  );

  // SECRET_INPUT: 'conn:update' patch may carry plaintext secrets.
  router.register(
    IPC_CHANNELS.connUpdate,
    zodValidator(UpdateInput),
    ({ id, patch }) => {
      assertCredentialPathsAllowed(credentialPathsOf(patch), pickedCredentialPaths, [
        credentialPathsOf(svc.get(id)),
      ]);
      return svc.update(id, patch);
    },
  );

  router.register(
    IPC_CHANNELS.connDelete,
    zodValidator(IdInputSchema),
    async ({ id }) => {
      await svc.delete(id);
      return { id };
    },
  );

  router.register(
    IPC_CHANNELS.connTouchUsed,
    zodValidator(IdInputSchema),
    ({ id }) => {
      svc.touchUsed(id);
      return { id };
    },
  );

  // SECRET_INPUT: 'conn:parseUri' payload is a full URI that may embed credentials.
  router.register(
    IPC_CHANNELS.connParseUri,
    zodValidator(ParseUriInputSchema),
    ({ uri }) => svc.parseUri(uri),
  );

  // SECRET_INPUT: 'conn:test' payload carries plaintext credentials.
  router.register(
    IPC_CHANNELS.connTest,
    zodValidator(ConnectionTestInputSchema),
    // The probe payload has no connection id, so a path stored on any
    // connection counts as unchanged.
    (input) => {
      assertCredentialPathsAllowed(
        credentialPathsOf(input),
        pickedCredentialPaths,
        svc.storedCredentialPaths(),
      );
      return svc.test(input);
    },
  );
}
