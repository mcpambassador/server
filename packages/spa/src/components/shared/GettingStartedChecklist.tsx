import { useState, useCallback } from 'react';
import {
  CheckCircleIcon,
  KeyIcon,
  BuildingStorefrontIcon,
  PuzzlePieceIcon,
  ComputerDesktopIcon,
  ClipboardDocumentIcon,
  ClipboardDocumentCheckIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid';
import { Button } from '@/components/catalyst/button';

const DISMISSED_KEY = 'amb_onboarding_dismissed';

const VS_CODE_SNIPPET = `{
  "mcp.servers": {
    "mcpambassador": {
      "command": "npx",
      "args": ["-y", "@mcpambassador/client", "--config", "/path/to/amb-client-config.json"],
      "env": {
        "MCP_AMBASSADOR_URL": "https://<your-server>:8443",
        "MCP_AMBASSADOR_PRESHARED_KEY": "<your-client-key>"
      }
    }
  }
}`;

const CLAUDE_DESKTOP_SNIPPET = `{
  "mcpServers": {
    "mcpambassador": {
      "command": "npx",
      "args": ["-y", "@mcpambassador/client", "--config", "/path/to/amb-client-config.json"],
      "env": {
        "MCP_AMBASSADOR_URL": "https://<your-server>:8443",
        "MCP_AMBASSADOR_PRESHARED_KEY": "<your-client-key>"
      }
    }
  }
}`;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API not available — silent failure
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
    >
      {copied ? (
        <>
          <ClipboardDocumentCheckIcon className="size-3.5 text-green-500" aria-hidden="true" />
          Copied
        </>
      ) : (
        <>
          <ClipboardDocumentIcon className="size-3.5" aria-hidden="true" />
          Copy
        </>
      )}
    </button>
  );
}

function CodeSnippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className="rounded-md bg-zinc-950 dark:bg-zinc-900 px-4 py-3 text-xs text-zinc-100 overflow-x-auto leading-relaxed ring-1 ring-zinc-800">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface ChecklistStepProps {
  number: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  completed: boolean;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

function ChecklistStep({
  number,
  icon,
  title,
  description,
  completed,
  action,
  children,
}: ChecklistStepProps) {
  return (
    <li className="flex gap-4">
      {/* Step status indicator */}
      <div className="flex-none pt-0.5">
        {completed ? (
          <CheckCircleIcon
            className="size-6 text-green-500 dark:text-green-400"
            aria-label="Completed"
          />
        ) : (
          <span
            className="flex size-6 items-center justify-center rounded-full border-2 border-zinc-300 dark:border-zinc-600 text-xs font-semibold text-zinc-500 dark:text-zinc-400"
            aria-label={`Step ${number}`}
          >
            {number}
          </span>
        )}
      </div>

      {/* Step content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-zinc-400 dark:text-zinc-500" aria-hidden="true">
              {icon}
            </span>
            <p
              className={`text-sm font-semibold ${
                completed
                  ? 'line-through text-zinc-400 dark:text-zinc-500'
                  : 'text-zinc-900 dark:text-white'
              }`}
            >
              {title}
            </p>
          </div>
          {!completed && action && <div className="flex-none">{action}</div>}
        </div>
        {!completed && (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
        )}
        {!completed && children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

interface GettingStartedChecklistProps {
  hasClients: boolean;
  hasSubscriptions: boolean;
}

export function GettingStartedChecklist({
  hasClients,
  hasSubscriptions,
}: GettingStartedChecklistProps) {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === 'true'
  );

  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    setDismissed(true);
  }, []);

  if (dismissed) return null;

  const allComplete = hasClients && hasSubscriptions;

  return (
    <section
      aria-labelledby="onboarding-heading"
      className="rounded-xl bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-zinc-950/5 dark:border-white/10">
        <div>
          <h2
            id="onboarding-heading"
            className="text-base font-semibold text-zinc-900 dark:text-white"
          >
            Getting Started
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {allComplete
              ? 'You are all set. Follow these steps any time to onboard a new AI tool.'
              : 'Complete these steps to connect your first AI tool to MCP Ambassador.'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="flex-none rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
          aria-label="Dismiss onboarding checklist"
        >
          <XMarkIcon className="size-5" aria-hidden="true" />
        </button>
      </div>

      {/* Steps */}
      <ol className="divide-y divide-zinc-950/5 dark:divide-white/5" aria-label="Onboarding steps">
        {/* Step 1 */}
        <li className="px-6 py-4">
          <ChecklistStep
            number={1}
            icon={<KeyIcon className="size-4" />}
            title="Create a client key"
            description="A client key lets your AI tool authenticate with MCP Ambassador. Each tool or device gets its own key."
            completed={hasClients}
            action={
              <Button href="/app/clients" outline className="!py-1 !px-2.5 !text-xs">
                Go to Clients
              </Button>
            }
          />
        </li>

        {/* Step 2 */}
        <li className="px-6 py-4">
          <ChecklistStep
            number={2}
            icon={<BuildingStorefrontIcon className="size-4" />}
            title="Browse the marketplace"
            description="Explore available MCP servers — tools your AI can call to search the web, run code, query databases, and more."
            completed={hasSubscriptions}
            action={
              <Button href="/app/marketplace" outline className="!py-1 !px-2.5 !text-xs">
                Open Marketplace
              </Button>
            }
          />
        </li>

        {/* Step 3 */}
        <li className="px-6 py-4">
          <ChecklistStep
            number={3}
            icon={<PuzzlePieceIcon className="size-4" />}
            title="Subscribe to an MCP"
            description="Pick an MCP from the marketplace and subscribe your client key to it. Your AI will gain access to its tools."
            completed={hasSubscriptions}
            action={
              <Button href="/app/marketplace" outline className="!py-1 !px-2.5 !text-xs">
                Go to Marketplace
              </Button>
            }
          />
        </li>

        {/* Step 4 */}
        <li className="px-6 py-4">
          <ChecklistStep
            number={4}
            icon={<ComputerDesktopIcon className="size-4" />}
            title="Connect your AI tool"
            description="Add MCP Ambassador to your AI tool's configuration. Copy one of the snippets below into your settings file."
            completed={false}
          >
            <CodeSnippet label="VS Code (settings.json)" code={VS_CODE_SNIPPET} />
            <CodeSnippet label="Claude Desktop (claude_desktop_config.json)" code={CLAUDE_DESKTOP_SNIPPET} />
          </ChecklistStep>
        </li>
      </ol>

      {/* Footer */}
      <div className="flex items-center justify-end px-6 py-4 bg-zinc-50 dark:bg-white/2.5 border-t border-zinc-950/5 dark:border-white/10">
        <button
          type="button"
          onClick={handleDismiss}
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-white underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
        >
          Don't show again
        </button>
      </div>
    </section>
  );
}
