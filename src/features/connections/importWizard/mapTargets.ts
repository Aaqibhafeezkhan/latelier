import type { MapTarget } from '@shared/types';

/** The mappable targets, in the order C14 §5.3 lists them. */
export const MAP_TARGETS: ReadonlyArray<{ target: MapTarget; label: string }> = [
  { target: 'name', label: 'Name' },
  { target: 'connectionString', label: 'Connection string' },
  { target: 'host', label: 'Host' },
  { target: 'port', label: 'Port' },
  { target: 'username', label: 'Username' },
  { target: 'password', label: 'Password' },
  { target: 'authDatabase', label: 'Auth database' },
  { target: 'defaultDb', label: 'Default database' },
  { target: 'tls', label: 'TLS' },
];
