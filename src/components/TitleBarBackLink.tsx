import { UnstyledButton } from '@mantine/core';
import { themeVars } from '../theme/themeVars';
import { I } from '../icons';

interface TitleBarBackLinkProps {
  label: string;
  onClick: () => void;
}

// The "← <destination>" affordance in a title bar's breadcrumb — a deep-link
// screen's only way back (ConnectionManager's `/connections/:id`, NewConnection's
// `/connections/new` and `/connections/:id/edit`).
export function TitleBarBackLink({ label, onClick }: TitleBarBackLinkProps) {
  const T = themeVars;
  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        color: T.textMuted, fontSize: 13, fontFamily: 'inherit',
      }}
    >
      <span style={{ display: 'flex' }}>{I.chevL}</span>
      <span>{label}</span>
    </UnstyledButton>
  );
}
