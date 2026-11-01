import { Fragment, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/catalyst/button';
import { Text } from '@/components/catalyst/text';
import { visibleText, codePointLength, splitAtCodePoints } from '@/lib/pin-text';

/** Collapsed view shows this many code points; the full preview must be opened and read to the end. */
const PREVIEW_COLLAPSED_CODEPOINTS = 300;

/** The server marks redacted values with a bracketed REDACTED token; we make them stand out. */
const REDACTION = /(\[REDACTED[^\]\n]{0,40}\])/gi;

/** Plain text only: invisible characters become ⟨U+XXXX⟩ and nothing is ever parsed as markup. */
function renderPreviewText(text: string) {
  return visibleText(text)
    .split(REDACTION)
    .map((part, i) =>
      i % 2 === 1 ? (
        <mark
          key={i}
          data-testid="redaction-marker"
          className="rounded bg-amber-200 px-0.5 text-amber-950"
        >
          {part}
        </mark>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      )
    );
}

export function ApprovalPreview({
  preview,
  onReadAll,
}: {
  preview: string | null;
  /** Called with true once the full preview is expanded and scrolled to the end. */
  onReadAll: (done: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLPreElement>(null);

  const atEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= 2;

  useEffect(() => {
    if (expanded && ref.current) onReadAll(atEnd(ref.current));
    else onReadAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, preview]);

  if (preview === null) {
    return (
      <Text data-testid="preview-none" className="text-amber-600">
        No preview is available for this request.
      </Text>
    );
  }

  const total = codePointLength(preview);
  const { head } = splitAtCodePoints(preview, PREVIEW_COLLAPSED_CODEPOINTS);
  return (
    <div className="space-y-2">
      {expanded ? (
        <pre
          ref={ref}
          tabIndex={0}
          data-testid="approval-preview"
          onScroll={e => onReadAll(atEnd(e.currentTarget))}
          className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-900 dark:bg-zinc-800 dark:text-white"
        >
          {renderPreviewText(preview)}
        </pre>
      ) : (
        <pre
          data-testid="approval-preview-collapsed"
          className="max-h-32 overflow-hidden whitespace-pre-wrap break-words rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-900 dark:bg-zinc-800 dark:text-white"
        >
          {renderPreviewText(head)}
          {total > PREVIEW_COLLAPSED_CODEPOINTS ? '…' : ''}
        </pre>
      )}
      {!expanded && (
        <Button outline onClick={() => setExpanded(true)} data-testid="expand-preview">
          Show full arguments ({total} characters)
        </Button>
      )}
    </div>
  );
}
