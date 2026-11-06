import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { ScriptEditor } from '../../components/ScriptEditor';
import { ejsonParse, ejsonStringifyReadable } from '../../utils/ejson';
import { themeVars } from '../../theme/themeVars';
import { useCollectionDetails } from './useCollectionDetails';

interface ViewDocumentDialogProps {
  connectionId: string;
  dbName: string;
  /** The view the document came from. */
  collection: string;
  doc: unknown;
  onClose: () => void;
  /** Opens the collection the view reads from, in this dialog's own connection and database. */
  onOpenSource: (target: { connectionId: string; dbName: string; collection: string }) => void;
}

/**
 * A view's document, read-only. A view has no writes, so the Edit paths that
 * reach a document on a view land here instead of on the Document Editor,
 * whose save would fail with a raw server error.
 */
export function ViewDocumentDialog({
  connectionId,
  dbName,
  collection,
  doc,
  onClose,
  onOpenSource,
}: ViewDocumentDialogProps) {
  const close = useDialogFocusReturn(onClose);
  // The source collection is not in the navigator's listing; the same read the
  // Structure view makes supplies it. Until it lands the button is simply absent.
  const { details } = useCollectionDetails(connectionId, dbName, collection);
  const source = details?.options.viewOn;
  // Revived first so a Long or Decimal128 reads as its typed form, like the Document Editor's JSON view.
  const text = ejsonStringifyReadable(ejsonParse<unknown>(JSON.stringify(doc)), 2);

  return (
    <Modal
      opened
      onClose={close}
      centered
      size="md"
      title={
        <>
          View document{' '}
          <Text span ff="monospace" size="xs" c="dimmed">
            {dbName}.{collection}
          </Text>
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm" p="xs" style={{ background: themeVars.surfaceRaised, borderRadius: themeVars.rs }}>
          This is a view, so its documents can&apos;t be edited here. To change them, open the source
          collection.
        </Text>
        <div style={{ height: 280 }}>
          <ScriptEditor value={text} onChange={() => {}} readOnly ariaLabel="Document JSON" testId="view-document-json" />
        </div>
        <Group justify="flex-end" gap="xs">
          {source !== undefined && (
            <Button
              variant="default"
              size="compact-xs"
              onClick={() => {
                onOpenSource({ connectionId, dbName, collection: source });
                close();
              }}
            >
              Open {source}
            </Button>
          )}
          <Button variant="filled" size="compact-xs" onClick={close}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
