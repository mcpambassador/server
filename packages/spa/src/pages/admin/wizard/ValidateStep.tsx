import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, MagnifyingGlassIcon } from '@heroicons/react/20/solid';
import { Button } from '@/components/catalyst/button';
import type { ValidationResult, DiscoveryResult } from '@/api/types';

interface ValidateStepProps {
  validationResult: ValidationResult | null;
  discoveryResult: DiscoveryResult | null;
  isValidating: boolean;
  isDiscovering: boolean;
  onValidate: () => void;
  onDiscover: () => void;
}

export function ValidateStep({
  validationResult,
  discoveryResult,
  isValidating,
  isDiscovering,
  onValidate,
  onDiscover,
}: ValidateStepProps) {
  return (
    <div className="space-y-4">
      {/* Action Buttons */}
      <div className="flex gap-2">
        <Button color="zinc" onClick={onValidate} disabled={isValidating}>
          <ArrowPathIcon data-slot="icon" />
          {isValidating ? 'Validating...' : 'Validate Configuration'}
        </Button>
        <Button
          color="zinc"
          onClick={onDiscover}
          disabled={isDiscovering || !validationResult?.valid}
          title={!validationResult?.valid ? 'Validate first before discovering tools' : undefined}
        >
          <MagnifyingGlassIcon data-slot="icon" />
          {isDiscovering ? 'Discovering...' : 'Discover Tools'}
        </Button>
      </div>

      {/* Validation Result */}
      {validationResult && (
        <div
          className={`flex items-center gap-2 p-4 rounded-lg ${
            validationResult.valid ? 'bg-green-50 dark:bg-green-950/50' : 'bg-red-50 dark:bg-red-950/50'
          }`}
        >
          {validationResult.valid ? (
            <CheckCircleIcon className="size-6 text-green-600 dark:text-green-400" />
          ) : (
            <ExclamationTriangleIcon className="size-6 text-red-600 dark:text-red-400" />
          )}
          <div>
            <p className="font-semibold text-zinc-900 dark:text-white">
              Validation {validationResult.valid ? 'Passed' : 'Failed'}
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {validationResult.valid
                ? 'Configuration is valid. You can now discover tools.'
                : `${validationResult.errors?.length || 0} error(s) found`}
            </p>
          </div>
        </div>
      )}

      {/* Validation Errors */}
      {(validationResult?.errors?.length ?? 0) > 0 && (
        <div>
          <h4 className="font-medium text-red-600 dark:text-red-400 mb-2">Errors</h4>
          <ul className="list-disc list-inside space-y-1">
            {validationResult!.errors.map((err: string, i: number) => (
              <li key={i} className="text-sm text-red-600 dark:text-red-400">{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Validation Warnings */}
      {(validationResult?.warnings?.length ?? 0) > 0 && (
        <div>
          <h4 className="font-medium text-amber-600 dark:text-amber-400 mb-2">Warnings</h4>
          <ul className="list-disc list-inside space-y-1">
            {validationResult!.warnings.map((warn: string, i: number) => (
              <li key={i} className="text-sm text-amber-600 dark:text-amber-400">{warn}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Discovery Result */}
      {discoveryResult && (
        <div
          className={`flex items-center gap-2 p-4 rounded-lg ${
            discoveryResult.status === 'success'
              ? 'bg-blue-50 dark:bg-blue-950/50'
              : discoveryResult.status === 'skipped'
              ? 'bg-amber-50 dark:bg-amber-950/50'
              : 'bg-red-50 dark:bg-red-950/50'
          }`}
        >
          {(() => {
            const dr = discoveryResult as unknown as Record<string, unknown> | null;
            const status = dr?.['status'] as string | undefined;
            const message = typeof dr?.['message'] === 'string' ? (dr!['message'] as string) : undefined;
            const count = typeof dr?.['tool_count'] === 'number' ? (dr!['tool_count'] as number) : undefined;
            return (
              <>
                {status === 'success' ? (
                  <MagnifyingGlassIcon className="size-6 text-blue-600 dark:text-blue-400" />
                ) : (
                  <ExclamationTriangleIcon className="size-6 text-amber-600 dark:text-amber-400" />
                )}
                <div>
                  <p className="font-semibold text-zinc-900 dark:text-white">
                    {status === 'success'
                      ? `Discovered ${count ?? 0} tools`
                      : status === 'skipped'
                      ? 'Discovery Skipped'
                      : 'Discovery Failed'}
                  </p>
                  {message && (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Discovered Tools List */}
      {(() => {
        const dr = discoveryResult as Record<string, unknown> | null;
        const toolsArr = Array.isArray(dr?.['tools_discovered'])
          ? (dr!['tools_discovered'] as unknown[])
          : [];
        return toolsArr.length > 0 ? (
          <div>
            <h4 className="font-medium text-zinc-900 dark:text-white mb-2">
              Discovered Tools ({toolsArr.length})
            </h4>
            <div className="grid gap-2 max-h-64 overflow-y-auto">
              {toolsArr.map((tool: unknown, i: number) => {
                const t = tool as Record<string, unknown>;
                const name = typeof t['name'] === 'string' ? (t['name'] as string) : `tool-${i}`;
                const desc =
                  typeof t['description'] === 'string' ? (t['description'] as string) : undefined;
                return (
                  <div key={i} className="rounded-lg bg-zinc-50 dark:bg-zinc-800 p-3">
                    <p className="font-mono text-sm font-medium text-zinc-900 dark:text-white">{name}</p>
                    {desc && <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{desc}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null;
      })()}

      {/* Guidance text when nothing done yet */}
      {!validationResult && !discoveryResult && (
        <div className="text-center py-8">
          <p className="text-zinc-500 dark:text-zinc-400">
            Click "Validate Configuration" to check the MCP setup, then "Discover Tools" to connect and find available tools.
          </p>
        </div>
      )}
    </div>
  );
}
